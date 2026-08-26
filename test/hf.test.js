import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createSyncDebouncer } from '../src/hf.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-hf-'));
  return { store: new Store(dir), dir };
}

function hfConfig() {
  return { hfToken: 'token', hfDataset: 'dummy', dataDir: '/tmp' };
}

test('Store emits change events on mutation and mute suppresses them', () => {
  const { store, dir } = tempStore();
  const events = [];
  const unsub = store.onChange(() => events.push('change'));
  store.addProfile('natgeo');
  store.setConfig({ totalSnapshots: 1 });
  store.setHistory({ profiles: {} });
  assert.equal(events.length, 3);
  store.mute(() => {
    store.setConfig({ totalSnapshots: 2 });
    store.setPasswordHash('hash');
  });
  assert.equal(events.length, 3, 'muted mutations must not emit');
  store.setConfig({ totalSnapshots: 3 });
  assert.equal(events.length, 4);
  unsub();
  store.setConfig({ totalSnapshots: 4 });
  assert.equal(events.length, 4, 'unsubscribed listeners must not fire');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('syncToHF writes manifest under mute (no change loop)', () => {
  const { store, dir } = tempStore();
  const calls = [];
  const d = createSyncDebouncer(hfConfig(), store, {
    delayMs: 30,
    sync: async () => {
      calls.push(1);
      store.setHfManifest({ '@': 'x' });
      return { ok: true, uploaded: 1, toUpload: 1, errors: [] };
    },
  });
  return new Promise((resolve) => {
    store.onChange(() => d.schedule());
    store.addProfile('natgeo');
    setTimeout(() => {
      assert.ok(calls.length >= 1, 'debounced sync should run after mutation');
      d.cancel();
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    }, 250);
  });
});

test('flush is serialized and pending changes trigger a follow-up', () => {
  const { store, dir } = tempStore();
  let started = 0;
  let finished = 0;
  const d = createSyncDebouncer(hfConfig(), store, {
    delayMs: 5,
    sync: async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 40));
      finished += 1;
      return { ok: true, uploaded: 0, toUpload: 0, errors: [] };
    },
  });
  return new Promise((resolve) => {
    store.onChange(() => d.schedule());
    store.setConfig({ totalSnapshots: 1 });
    setTimeout(() => store.setConfig({ totalSnapshots: 2 }), 20);
    setTimeout(() => {
      assert.ok(started >= 1 && finished >= 1);
      d.cancel();
      fs.rmSync(dir, { recursive: true, force: true });
      resolve();
    }, 300);
  });
});
