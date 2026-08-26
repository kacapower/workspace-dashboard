import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { CostManager, MODE } from '../src/cost/cost-manager.js';
import { CircuitBreaker } from '../src/cost/circuit-breaker.js';
import { ProviderRouter, PRIORITY, NoProviderAvailableError, healthScore } from '../src/providers/router.js';
import { InstagramProvider, FEATURE, TIER, ProviderError, ERROR_KIND, providerResult } from '../src/providers/provider-interface.js';

/** Minimal fake provider so router behaviour is tested without network calls. */
class FakeProvider extends InstagramProvider {
  constructor(name, tier, behaviour, { units = 1 } = {}) {
    super({ name, tier, unitCostUsd: tier === TIER.FREE ? 0 : 0.01, features: [FEATURE.PROFILE] });
    this.behaviour = behaviour;
    this.unitsToReport = units;
    this.calls = 0;
  }
  estimateUnits() {
    return this.unitsToReport;
  }
  async getProfile(username) {
    this.calls += 1;
    if (typeof this.behaviour === 'function') return this.behaviour(username);
    return providerResult({ username }, { units: this.unitsToReport, provider: this.name });
  }
}

function limitsFixture() {
  return {
    free1: { tier: TIER.FREE, unitCostUsd: 0, freeUnitsPerMonth: 1000, dailyUnits: 100, monthlyUnits: 1000 },
    free2: { tier: TIER.FREE, unitCostUsd: 0, freeUnitsPerMonth: 1000, dailyUnits: 100, monthlyUnits: 1000 },
    paid1: { tier: TIER.LOW_COST, unitCostUsd: 0.01, freeUnitsPerMonth: 1000, dailyUnits: 100, monthlyUnits: 1000 },
  };
}

function setup(providers, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-router-'));
  const store = new Store(dir);
  const costManager = new CostManager(store, { budgetMode: MODE.BALANCED, ...config }, { limits: limitsFixture() });
  const breaker = new CircuitBreaker(store, { failureThreshold: 3, cooldownMs: 60000 });
  const router = new ProviderRouter({ providers, costManager, breaker, logger: { warn() {} } });
  return { dir, store, costManager, breaker, router, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('router prefers the cheaper tier', async () => {
  const free = new FakeProvider('free1', TIER.FREE);
  const paid = new FakeProvider('paid1', TIER.LOW_COST);
  const { router, cleanup } = setup([paid, free]); // registered paid-first on purpose

  const res = await router.call(FEATURE.PROFILE, { username: 'x' });
  assert.equal(res.provider, 'free1');
  assert.equal(free.calls, 1);
  assert.equal(paid.calls, 0, 'paid provider must not be touched');
  cleanup();
});

test('router books actual units returned, not the estimate', async () => {
  const free = new FakeProvider('free1', TIER.FREE, null, { units: 1 });
  free.getProfile = async () => providerResult({ ok: true }, { units: 17, provider: 'free1' });
  const { router, costManager, cleanup } = setup([free]);

  await router.call(FEATURE.PROFILE, { username: 'x' });
  assert.equal(costManager.snapshot().providers.free1.month.units, 17);
  cleanup();
});

test('a retryable failure falls back to the next provider for a normal profile', async () => {
  const flaky = new FakeProvider('free1', TIER.FREE, () => {
    throw new ProviderError('rate limited', { kind: ERROR_KIND.RATE_LIMIT });
  });
  const backup = new FakeProvider('free2', TIER.FREE);
  const { router, cleanup } = setup([flaky, backup]);

  const res = await router.call(FEATURE.PROFILE, { username: 'x', priority: PRIORITY.NORMAL });
  assert.equal(res.provider, 'free2');
  assert.equal(res.attempts.length, 2);
  cleanup();
});

test('a low-priority profile does NOT escalate to a paid provider', async () => {
  const freeFlaky = new FakeProvider('free1', TIER.FREE, () => {
    throw new ProviderError('timeout', { kind: ERROR_KIND.TIMEOUT });
  });
  const paid = new FakeProvider('paid1', TIER.LOW_COST);
  const { router, cleanup } = setup([freeFlaky, paid]);

  await assert.rejects(
    router.call(FEATURE.PROFILE, { username: 'x', priority: PRIORITY.LOW }),
    (err) => err.kind === ERROR_KIND.TIMEOUT
  );
  assert.equal(paid.calls, 0, 'a cheap timeout must not buy an expensive call');
  cleanup();
});

test('a critical profile may escalate to a paid provider', async () => {
  const freeFlaky = new FakeProvider('free1', TIER.FREE, () => {
    throw new ProviderError('timeout', { kind: ERROR_KIND.TIMEOUT });
  });
  const paid = new FakeProvider('paid1', TIER.LOW_COST);
  const { router, cleanup } = setup([freeFlaky, paid]);

  const res = await router.call(FEATURE.PROFILE, { username: 'x', priority: PRIORITY.CRITICAL });
  assert.equal(res.provider, 'paid1');
  cleanup();
});

test('a not_found failure never triggers fallback', async () => {
  const missing = new FakeProvider('free1', TIER.FREE, () => {
    throw new ProviderError('no profile data', { kind: ERROR_KIND.NOT_FOUND });
  });
  const backup = new FakeProvider('free2', TIER.FREE);
  const { router, cleanup } = setup([missing, backup]);

  await assert.rejects(router.call(FEATURE.PROFILE, { username: 'ghost', priority: PRIORITY.CRITICAL }));
  assert.equal(backup.calls, 0, 'another vendor cannot conjure a missing account');
  cleanup();
});

test('a failing provider is deprioritised within its tier before the circuit trips', async () => {
  const broken = new FakeProvider('free1', TIER.FREE, () => {
    throw new ProviderError('boom', { kind: ERROR_KIND.NETWORK });
  });
  const backup = new FakeProvider('free2', TIER.FREE);
  const { router, cleanup } = setup([broken, backup]);

  await router.call(FEATURE.PROFILE, { username: 'x', priority: PRIORITY.NORMAL });
  assert.equal(broken.calls, 1);
  assert.equal(backup.calls, 1, 'fell back within the same tier');

  // One failure is enough to drop free1 below free2 on health score, so the
  // router stops paying the failure tax on every subsequent call.
  await router.call(FEATURE.PROFILE, { username: 'y', priority: PRIORITY.NORMAL });
  assert.equal(broken.calls, 1, 'the flaky provider is no longer tried first');
  assert.equal(backup.calls, 2);
  cleanup();
});

test('an open circuit removes a provider from selection', async () => {
  const broken = new FakeProvider('free1', TIER.FREE, () => {
    throw new ProviderError('boom', { kind: ERROR_KIND.NETWORK });
  });
  const { store, router, breaker, cleanup } = setup([broken]);

  // Only free1 is registered, so all three failures land on it and trip the
  // breaker at the threshold.
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(router.call(FEATURE.PROFILE, { username: 'x', priority: PRIORITY.NORMAL }));
  }
  assert.equal(broken.calls, 3);
  assert.equal(breaker.allows('free1'), false, 'circuit tripped');

  // A later cron hit over the same persisted state: free1 must be skipped
  // without being called, and the healthy provider serves the request.
  const backup = new FakeProvider('free2', TIER.FREE);
  const next = new ProviderRouter({
    providers: [broken, backup],
    costManager: new CostManager(store, { budgetMode: MODE.BALANCED }, { limits: limitsFixture() }),
    breaker: new CircuitBreaker(store, { failureThreshold: 3, cooldownMs: 60000 }),
    logger: { warn() {} },
  });

  const ranked = next.candidates(FEATURE.PROFILE);
  const free1 = ranked.find((c) => c.name === 'free1');
  assert.equal(free1.usable, false);
  assert.equal(free1.reason, 'circuit_open');

  const res = await next.call(FEATURE.PROFILE, { username: 'x' });
  assert.equal(res.provider, 'free2');
  assert.equal(broken.calls, 3, 'circuit is open — provider is skipped entirely');
  assert.equal(backup.calls, 1);
  cleanup();
});

test('kill switch blocks every provider', async () => {
  const free = new FakeProvider('free1', TIER.FREE);
  const { router, costManager, cleanup } = setup([free]);
  costManager.setKillSwitch(true);

  await assert.rejects(router.call(FEATURE.PROFILE, { username: 'x' }), NoProviderAvailableError);
  assert.equal(free.calls, 0);
  cleanup();
});

test('exhausted quota removes a provider and surfaces the reason', async () => {
  const free = new FakeProvider('free1', TIER.FREE, null, { units: 1 });
  const { router, costManager, cleanup } = setup([free], {
    providerLimits: { free1: { tier: TIER.FREE, dailyUnits: 2, monthlyUnits: 2, freeUnitsPerMonth: 2, unitCostUsd: 0 } },
  });
  // Rebuild with the tight limit applied.
  costManager.limits.free1 = { tier: TIER.FREE, dailyUnits: 2, monthlyUnits: 2, freeUnitsPerMonth: 2, unitCostUsd: 0 };

  await router.call(FEATURE.PROFILE, { username: 'a' });
  await router.call(FEATURE.PROFILE, { username: 'b' });

  const candidates = router.candidates(FEATURE.PROFILE);
  assert.equal(candidates[0].usable, false);
  assert.match(candidates[0].reason, /limit|allowance/);
  await assert.rejects(router.call(FEATURE.PROFILE, { username: 'c' }), NoProviderAvailableError);
  cleanup();
});

test('healthScore ranks a reliable provider above a flaky one', () => {
  const good = healthScore({ success: 20, failure: 0, consecutiveFailures: 0, latencyMsAvg: 800 });
  const flaky = healthScore({ success: 10, failure: 10, consecutiveFailures: 2, latencyMsAvg: 30000 });
  assert.ok(good > flaky, `${good} should beat ${flaky}`);
  assert.ok(good <= 1 && flaky >= 0);
});
