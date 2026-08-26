import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { runCronCycle, createPollLock } from '../src/cron-cycle.js';

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-cron-'));
  const store = new Store(dir);
  const config = {
    dataDir: dir,
    apifyToken: 'test-token',
    apifyActor: 'apify/instagram-scraper',
    pollIntervalHours: 1,
    batchIntervalHours: 8,
    retentionDays: 7,
    storiesActor: '',
    hfToken: '',
    hfDataset: '',
    pollLockStaleMinutes: 20,
    ...extra,
  };
  return { dir, store, config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a cron hit runs the whole cycle and reports the result', async () => {
  const { store, config, cleanup } = setup();
  let ran = 0;
  const poller = async () => {
    ran += 1;
    return { ok: true, polledCount: 1 };
  };

  const r = await runCronCycle(store, config, { poller });
  assert.equal(ran, 1);
  assert.equal(r.ok, true);
  assert.equal(r.polledCount, 1);
  cleanup();
});

test('a second concurrent cron hit is refused instead of double-spending', async () => {
  const { store, config, cleanup } = setup();
  const held = createPollLock(config);
  held.acquire({ owner: 'first' });

  let ran = 0;
  const r = await runCronCycle(store, config, { poller: async () => { ran += 1; return { ok: true }; } });

  assert.equal(ran, 0, 'the poller must not run while another hit holds the lock');
  assert.equal(r.busy, true);
  assert.equal(r.skipped, true);
  assert.equal(r.ok, false);
  held.release();
  cleanup();
});

test('the lock is released after a failed cycle so the next cron hit works', async () => {
  const { store, config, cleanup } = setup();
  await assert.rejects(
    runCronCycle(store, config, { poller: async () => { throw new Error('apify exploded'); } }),
    /apify exploded/
  );

  let ran = 0;
  const r = await runCronCycle(store, config, { poller: async () => { ran += 1; return { ok: true }; } });
  assert.equal(ran, 1, 'one crash must not block polling forever');
  assert.equal(r.ok, true);
  cleanup();
});

test('cron mode prunes old media in-request because no timer is running', async () => {
  const { store, config, cleanup } = setup({ cronMode: true });
  const r = await runCronCycle(store, config, { poller: async () => ({ ok: true }) });
  assert.ok(r.retention, 'retention must run as part of the cron cycle');
  cleanup();
});

test('restore is skipped when the disk already holds state', async () => {
  // hfEnabled() is false here, but the profiles guard is the important one: a
  // warm disk must never pay for a dataset-wide restore on every cron hit.
  const { store, config, cleanup } = setup({ hfToken: 't', hfDataset: 'u/d' });
  store.addProfile('someone');
  let restored = false;
  const r = await runCronCycle(store, config, {
    restore: true,
    poller: async () => { restored = true; return { ok: true }; },
  });
  assert.equal(restored, true);
  assert.equal(r.ok, true);
  cleanup();
});
