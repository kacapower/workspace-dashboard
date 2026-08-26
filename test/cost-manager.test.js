import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { CostManager, MODE, DENY, forecastExhaustion } from '../src/cost/cost-manager.js';

function setup(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-cost-'));
  const store = new Store(dir);
  const cm = new CostManager(store, { budgetMode: MODE.MAX_FREE, ...config });
  return { dir, store, cm, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('canSpend allows a call within budget and records actual units', () => {
  const { cm, cleanup } = setup();
  const verdict = cm.canSpend('apify', 'profile', 13);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.remainingMonth, 300);

  cm.record('apify', 'profile', { units: 13, ok: true, latencyMs: 1200 });
  const snap = cm.snapshot();
  assert.equal(snap.providers.apify.month.units, 13);
  assert.equal(snap.providers.apify.month.requests, 1);
  assert.equal(snap.providers.apify.features.profile.units, 13);
  assert.ok(snap.providers.apify.month.costUsd > 0, 'cost should accrue');
  cleanup();
});

test('daily limit blocks further spend before the monthly ceiling is reached', () => {
  const { cm, cleanup } = setup();
  cm.record('apify', 'profile', { units: 60, ok: true }); // dailyUnits default = 60
  const verdict = cm.canSpend('apify', 'profile', 1);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, DENY.DAILY);
  assert.equal(verdict.remainingDay, 0);
  assert.ok(verdict.remainingMonth > 0, 'month still has room');
  cleanup();
});

test('the default daily cap fits a full poll plus a went-public backfill', () => {
  // Regression guard: a daily cap below an operation's pre-flight estimate
  // blocks that operation forever, not just for today. A 20-post poll
  // estimates at 21 units and a 30-post backfill at 31.
  const { cm, cleanup } = setup();
  assert.ok(cm.limitsFor('apify').dailyUnits >= 21 + 31, 'daily cap must fit poll + backfill');
  assert.equal(cm.canSpend('apify', 'profile', 21).ok, true);
  cm.record('apify', 'profile', { units: 21, ok: true });
  assert.equal(cm.canSpend('apify', 'profile', 31).ok, true, 'backfill must still fit');
  cleanup();
});

test('maximum_free mode refuses to spend past the free allowance', () => {
  // A paid monthly limit is configured, but free allowance is smaller.
  const { cm, cleanup } = setup({
    providerLimits: { apify: { monthlyUnits: 5000, freeUnitsPerMonth: 20, dailyUnits: 1000 } },
  });
  assert.equal(cm.monthlyCeiling('apify'), 20, 'free allowance caps the ceiling');
  cm.record('apify', 'profile', { units: 20, ok: true });
  const verdict = cm.canSpend('apify', 'profile', 1);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, DENY.FREE_ALLOWANCE);

  // Switching to balanced unlocks the configured paid limit.
  cm.setMode(MODE.BALANCED);
  assert.equal(cm.monthlyCeiling('apify'), 5000);
  assert.equal(cm.canSpend('apify', 'profile', 1).ok, true);
  cleanup();
});

test('premium providers are refused unless mode is maximum_coverage', () => {
  const { cm, cleanup } = setup({
    providerLimits: { fancy: { tier: 'premium', unitCostUsd: 1, freeUnitsPerMonth: 0, dailyUnits: 100, monthlyUnits: 100 } },
  });
  assert.equal(cm.canSpend('fancy', 'profile', 1).reason, DENY.MODE_TIER);
  cm.setMode(MODE.BALANCED);
  assert.equal(cm.canSpend('fancy', 'profile', 1).reason, DENY.MODE_TIER, 'balanced still excludes premium');
  cm.setMode(MODE.MAX_COVERAGE);
  assert.equal(cm.canSpend('fancy', 'profile', 1).ok, true);
  cleanup();
});

test('kill switch blocks every provider and survives a fresh CostManager', () => {
  const { store, cm, cleanup } = setup();
  cm.setKillSwitch(true);
  assert.equal(cm.canSpend('apify', 'profile', 1).reason, DENY.KILL_SWITCH);

  // A new process (cron hit) must still see the switch — it is persisted.
  const reloaded = new CostManager(store, { budgetMode: MODE.MAX_FREE });
  assert.equal(reloaded.killSwitch(), true);
  assert.equal(reloaded.canSpend('apify', 'profile', 1).reason, DENY.KILL_SWITCH);

  reloaded.setKillSwitch(false);
  assert.equal(new CostManager(store, {}).canSpend('apify', 'profile', 1).ok, true);
  cleanup();
});

test('explicitly disabled provider is refused', () => {
  const { cm, cleanup } = setup({ providerEnabled: { apify: false } });
  assert.equal(cm.canSpend('apify', 'profile', 1).reason, DENY.DISABLED);
  cleanup();
});

test('day window rolls over but the month keeps accumulating', () => {
  const { cm, cleanup } = setup();
  const d1 = new Date('2026-08-10T12:00:00Z');
  const d2 = new Date('2026-08-11T12:00:00Z');
  cm.record('apify', 'profile', { units: 9, ok: true, now: d1 });
  cm.record('apify', 'profile', { units: 4, ok: true, now: d2 });
  const snap = cm.snapshot({ now: d2 });
  assert.equal(snap.providers.apify.day.units, 4, 'day resets');
  assert.equal(snap.providers.apify.month.units, 13, 'month accumulates');
  cleanup();
});

test('month window resets on a new month', () => {
  const { cm, cleanup } = setup();
  cm.record('apify', 'profile', { units: 50, ok: true, now: new Date('2026-08-31T00:00:00Z') });
  const snap = cm.snapshot({ now: new Date('2026-09-01T00:00:00Z') });
  assert.equal(snap.providers.apify.month.units, 0);
  cleanup();
});

test('throttleFactor escalates with quota consumption and disables at 100%', () => {
  const { cm, cleanup } = setup({
    providerLimits: { apify: { dailyUnits: 1000, monthlyUnits: 100, freeUnitsPerMonth: 100 } },
  });
  assert.equal(cm.throttleFactor('apify'), 1);
  cm.record('apify', 'profile', { units: 70, ok: true });
  assert.equal(cm.throttleFactor('apify'), 2);
  cm.record('apify', 'profile', { units: 15, ok: true }); // 85%
  assert.equal(cm.throttleFactor('apify'), 4);
  cm.record('apify', 'profile', { units: 10, ok: true }); // 95%
  assert.equal(cm.throttleFactor('apify'), 12);
  cm.record('apify', 'profile', { units: 5, ok: true }); // 100%
  assert.equal(cm.throttleFactor('apify'), Infinity, 'exhausted quota disables polling');
  cleanup();
});

test('failed calls increment error counters and consecutive failures', () => {
  const { cm, cleanup } = setup();
  cm.record('apify', 'profile', { units: 0, ok: false });
  cm.record('apify', 'profile', { units: 0, ok: false });
  const h = cm.snapshot().providers.apify.health;
  assert.equal(h.failure, 2);
  assert.equal(h.consecutiveFailures, 2);
  cm.record('apify', 'profile', { units: 1, ok: true });
  assert.equal(cm.snapshot().providers.apify.health.consecutiveFailures, 0, 'success resets the streak');
  cleanup();
});

test('forecastExhaustion projects days remaining from burn rate', () => {
  // 100 units used by the 10th → 10/day → 200 remaining → ~20 days.
  const f = forecastExhaustion({ units: 100 }, 300, new Date('2026-08-10T00:00:00Z'));
  assert.equal(f.perDay, 10);
  assert.equal(f.daysLeft, 20);
  assert.equal(f.exhausted, false);

  const done = forecastExhaustion({ units: 300 }, 300, new Date('2026-08-10T00:00:00Z'));
  assert.equal(done.exhausted, true);
});
