import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-store-'));
  return { store: new Store(dir), dir };
}

test('getConfig returns defaults for empty store', () => {
  const { store, dir } = tempStore();
  const cfg = store.getConfig();
  assert.deepEqual(cfg.profiles, []);
  assert.equal(cfg.lastPollStatus, 'idle');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addProfile adds, dedupes, and removeProfile deletes', () => {
  const { store, dir } = tempStore();
  assert.equal(store.addProfile('natgeo'), true);
  assert.equal(store.addProfile('natgeo'), false);
  assert.equal(store.addProfile('spacex'), true);
  assert.deepEqual(store.getProfiles().map((p) => p.username), ['natgeo', 'spacex']);
  store.removeProfile('natgeo');
  assert.deepEqual(store.getProfiles().map((p) => p.username), ['spacex']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getConfig migrates legacy single-profile config', () => {
  const { store, dir } = tempStore();
  store.writeJson('config.json', { username: 'legacy', lastPollStatus: 'ok', totalSnapshots: 5 });
  const cfg = store.getConfig();
  assert.deepEqual(cfg.profiles.map((p) => p.username), ['legacy']);
  assert.equal(cfg.lastPollStatus, 'ok');
  assert.equal(cfg.totalSnapshots, 5);
  assert.ok(!('username' in cfg));
  const again = store.getConfig();
  assert.deepEqual(again.profiles.map((p) => p.username), ['legacy']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveSnapshot appends per-profile history', () => {
  const { store, dir } = tempStore();
  store.saveSnapshot('natgeo', { at: '2026-01-01T00:00:00Z', changeCount: 0 });
  store.saveSnapshot('natgeo', { at: '2026-01-02T00:00:00Z', changeCount: 2 });
  store.saveSnapshot('spacex', { at: '2026-01-03T00:00:00Z', changeCount: 1 });
  const h = store.getHistory();
  assert.equal(h.profiles.natgeo.length, 2);
  assert.equal(h.profiles.spacex.length, 1);
  assert.equal(h.profiles.natgeo[1].changeCount, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renameProfile moves config, history and media folder', () => {
  const { store, dir } = tempStore();
  store.addProfile('oldname');
  store.saveSnapshot('oldname', { at: '2026-01-01T00:00:00Z', changeCount: 1 });
  fs.mkdirSync(path.join(store.mediaDir, 'oldname'), { recursive: true });
  fs.writeFileSync(path.join(store.mediaDir, 'oldname', 'avatar-x.png'), 'x');

  assert.equal(store.renameProfile('oldname', 'newname').username, 'newname');
  assert.deepEqual(store.getProfiles().map((p) => p.username), ['newname']);
  const h = store.getHistory();
  assert.ok(h.profiles.newname);
  assert.ok(!h.profiles.oldname);
  assert.equal(fs.existsSync(path.join(store.mediaDir, 'newname', 'avatar-x.png')), true);
  assert.equal(fs.existsSync(path.join(store.mediaDir, 'oldname')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renameProfile rejects a name that is already tracked', () => {
  const { store, dir } = tempStore();
  store.addProfile('a');
  store.addProfile('b');
  assert.equal(store.renameProfile('a', 'b'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new config defaults include retention and alert flags', () => {
  const { store, dir } = tempStore();
  const cfg = store.getConfig();
  assert.equal(cfg.retentionEnabled, true);
  assert.equal(cfg.retentionDays, 7);
  assert.equal(cfg.alertsEnabled, null);
  assert.equal(cfg.summaryEnabled, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
