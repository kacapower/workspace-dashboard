import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { CostManager } from '../src/cost/cost-manager.js';
import { CircuitBreaker, STATE } from '../src/cost/circuit-breaker.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-cb-'));
  const store = new Store(dir);
  const cm = new CostManager(store, {});
  const cb = new CircuitBreaker(store, { failureThreshold: 3, cooldownMs: 60000 });
  return { dir, store, cm, cb, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Failures are counted by CostManager.record; the breaker reads that streak. */
function fail(cm, cb, n, now = new Date()) {
  for (let i = 0; i < n; i += 1) {
    cm.record('apify', 'profile', { units: 0, ok: false, now });
    cb.onFailure('apify', { now });
  }
}

test('circuit stays closed below the failure threshold', () => {
  const { cm, cb, cleanup } = setup();
  fail(cm, cb, 2);
  assert.equal(cb.status('apify').state, STATE.CLOSED);
  assert.equal(cb.allows('apify'), true);
  cleanup();
});

test('circuit opens at the threshold and blocks calls', () => {
  const { cm, cb, cleanup } = setup();
  fail(cm, cb, 3);
  const s = cb.status('apify');
  assert.equal(s.state, STATE.OPEN);
  assert.equal(s.allowed, false);
  assert.ok(s.retryAt, 'reports when it will retry');
  cleanup();
});

test('open circuit becomes half-open after the cooldown and allows one trial', () => {
  const { cm, cb, cleanup } = setup();
  const t0 = new Date('2026-08-24T10:00:00Z');
  fail(cm, cb, 3, t0);
  assert.equal(cb.status('apify', { now: t0 }).allowed, false);

  const during = new Date('2026-08-24T10:00:30Z'); // 30s < 60s cooldown
  assert.equal(cb.status('apify', { now: during }).allowed, false);

  const after = new Date('2026-08-24T10:01:30Z'); // cooldown elapsed
  const s = cb.status('apify', { now: after });
  assert.equal(s.state, STATE.HALF_OPEN);
  assert.equal(s.allowed, true);
  assert.equal(s.trial, true, 'the allowed call is a trial request');
  cleanup();
});

test('a success closes the circuit', () => {
  const { cm, cb, cleanup } = setup();
  fail(cm, cb, 3);
  assert.equal(cb.allows('apify'), false);
  cm.record('apify', 'profile', { units: 1, ok: true });
  cb.onSuccess('apify');
  assert.equal(cb.status('apify').state, STATE.CLOSED);
  assert.equal(cb.allows('apify'), true);
  cleanup();
});

test('a failed trial re-opens the circuit immediately', () => {
  const { cm, cb, cleanup } = setup();
  const t0 = new Date('2026-08-24T10:00:00Z');
  fail(cm, cb, 3, t0);
  const after = new Date('2026-08-24T10:01:30Z');
  assert.equal(cb.status('apify', { now: after }).state, STATE.HALF_OPEN);

  // The trial fails — must re-open rather than needing 3 more failures.
  cm.record('apify', 'profile', { units: 0, ok: false, now: after });
  cb.onFailure('apify', { now: after });
  const reopened = cb.status('apify', { now: new Date('2026-08-24T10:01:35Z') });
  assert.equal(reopened.state, STATE.OPEN);
  assert.equal(reopened.allowed, false);
  cleanup();
});

test('a non-provider fault (account not found) never trips the circuit', () => {
  const { cb, cleanup } = setup();
  for (let i = 0; i < 10; i += 1) cb.onFailure('apify', { providerFault: false });
  assert.equal(cb.status('apify').state, STATE.CLOSED, 'a missing account is not the provider\'s fault');
  cleanup();
});

test('circuit state survives a new process (cron-hit simulation)', () => {
  const { store, cm, cb, cleanup } = setup();
  fail(cm, cb, 3);
  assert.equal(cb.allows('apify'), false);

  // Fresh objects = what the next cron invocation sees.
  const reloaded = new CircuitBreaker(store, { failureThreshold: 3, cooldownMs: 60000 });
  assert.equal(reloaded.status('apify').state, STATE.OPEN);
  assert.equal(reloaded.allows('apify'), false, 'must not forget it tripped');
  cleanup();
});
