import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { poll } from '../src/poller.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-poll-'));
  const store = new Store(dir);
  const config = {
    apifyToken: 'test-token',
    apifyActor: 'apify/instagram-scraper',
    pollIntervalHours: 1,
    batchIntervalHours: 8,
    storiesActor: '',
    apifyStoriesActor: '',
  };
  return { store, config, dir };
}

function profileItem(username, { isPrivate = false } = {}) {
  return {
    username,
    fullName: username,
    biography: 'bio',
    followersCount: 10,
    followsCount: 5,
    postsCount: 2,
    private: isPrivate,
    isPrivate,
    verified: false,
    latestPosts: [],
  };
}

test('poll pings a private account that is not due and reports stillPrivate', async () => {
  const { store, config, dir } = setup();
  store.addProfile('privacct', { isPrivate: undefined });
  store.updateProfile('privacct', { isPrivate: true, lastPolledAt: new Date().toISOString() });

  const runner = async (actor, input) => [profileItem('privacct', { isPrivate: true })];
  const r = await poll(store, config, { runner });

  const entry = r.results.find((x) => x.username === 'privacct');
  assert.equal(entry.ok, true);
  assert.equal(entry.due, false);
  assert.equal(entry.ping, true);
  assert.equal(entry.stillPrivate, true);
  assert.equal(r.pingCount, 1);
  assert.equal(r.polledCount, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('poll immediately fully-polls a private account that went public', async () => {
  const { store, config, dir } = setup();
  store.addProfile('privacct', { isPrivate: undefined });
  store.updateProfile('privacct', { isPrivate: true, lastPolledAt: new Date().toISOString() });

  store.saveSnapshot('privacct', {
    at: '2026-01-01T00:00:00Z',
    profile: { ...profileItem('privacct', { isPrivate: true }) },
    posts: [],
    changes: [],
    changeCount: 0,
  });

  const runner = async (actor, input) => {
    if (input.resultsLimit === 30) return [profileItem('privacct', { isPrivate: false })];
    return [profileItem('privacct', { isPrivate: false })];
  };

  const r = await poll(store, config, { runner });
  const entry = r.results.find((x) => x.username === 'privacct');
  assert.equal(entry.ok, true);
  assert.equal(entry.wentPublic, true);
  assert.equal(entry.due, true);
  assert.equal(r.polledCount, 1);
  assert.ok(entry.changeCount >= 1, 'privacy change should be recorded');

  const prof = store.getProfiles().find((p) => p.username === 'privacct');
  assert.equal(prof.isPrivate, false, 'profile isPrivate should flip to false');
  const history = store.getHistory().profiles['privacct'];
  assert.ok(history.length >= 2, 'a new snapshot should be saved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('public accounts are not privacy-pinged', async () => {
  const { store, config, dir } = setup();
  store.addProfile('pubacct', { isPrivate: undefined });
  store.updateProfile('pubacct', { isPrivate: false, lastPolledAt: new Date().toISOString() });

  const runner = async () => {
    throw new Error('public account should never be pinged');
  };
  const r = await poll(store, config, { runner });
  const entry = r.results.find((x) => x.username === 'pubacct');
  assert.equal(entry.ok, true);
  assert.equal(entry.due, false);
  assert.ok(!entry.ping);
  fs.rmSync(dir, { recursive: true, force: true });
});
