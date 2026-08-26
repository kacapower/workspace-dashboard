import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PollLock } from '../src/poll-lock.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-lock-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('acquire succeeds once and blocks a second holder', () => {
  const { dir, cleanup } = setup();
  const a = new PollLock(dir);
  const b = new PollLock(dir);

  assert.equal(a.acquire().ok, true);
  const second = b.acquire();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'locked');
  assert.ok(second.heldBy, 'reports who holds it');
  cleanup();
});

test('release lets the next holder in', () => {
  const { dir, cleanup } = setup();
  const a = new PollLock(dir);
  const b = new PollLock(dir);
  a.acquire();
  a.release();
  assert.equal(b.acquire().ok, true);
  cleanup();
});

test('a stale lock is broken so a killed host cannot deadlock polling', () => {
  const { dir, cleanup } = setup();
  const staleMs = 10 * 60 * 1000;
  const a = new PollLock(dir, { staleMs });
  const t0 = Date.now();
  a.acquire({ now: t0 });

  // Simulates the free host being shut down mid-poll: lock file left behind.
  const b = new PollLock(dir, { staleMs });
  assert.equal(b.acquire({ now: t0 + 5 * 60 * 1000 }).ok, false, 'still fresh');

  const broken = b.acquire({ now: t0 + 11 * 60 * 1000 });
  assert.equal(broken.ok, true);
  assert.equal(broken.brokeStale, true);
  cleanup();
});

test('a corrupt lock file is treated as stale rather than deadlocking', () => {
  const { dir, cleanup } = setup();
  fs.writeFileSync(path.join(dir, 'poll.lock'), 'not json at all');
  const lock = new PollLock(dir);
  const got = lock.acquire();
  assert.equal(got.ok, true);
  assert.equal(got.brokeStale, true);
  cleanup();
});

test('withLock releases even when the body throws', async () => {
  const { dir, cleanup } = setup();
  const lock = new PollLock(dir);
  await assert.rejects(
    lock.withLock(async () => {
      throw new Error('poll blew up');
    }),
    /poll blew up/
  );
  // Lock must be free afterwards, else one crash stops all future polls.
  assert.equal(new PollLock(dir).acquire().ok, true);
  cleanup();
});

test('withLock reports non-acquisition instead of running the body twice', async () => {
  const { dir, cleanup } = setup();
  const holder = new PollLock(dir);
  holder.acquire();

  let ran = false;
  const res = await new PollLock(dir).withLock(async () => {
    ran = true;
  });
  assert.equal(res.acquired, false);
  assert.equal(ran, false, 'the body must not run — this is the double-spend guard');
  cleanup();
});

test('concurrent acquire attempts yield exactly one winner', async () => {
  const { dir, cleanup } = setup();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => Promise.resolve().then(() => new PollLock(dir).acquire()))
  );
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one holder');
  cleanup();
});
