import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { JobScheduler, CADENCE_HOURS, SCHEDULED_KINDS } from '../src/scheduler.js';
import { TASK } from '../src/poller.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-sched-'));
  return { store: new Store(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Fake SupabaseRest that serves `claim_due_jobs` from a scripted queue. */
function fakeRest({ jobs = [], batches = [] } = {}) {
  const calls = { select: [], insert: [], remove: [], patch: [], rpc: [] };
  const queue = [...batches];
  return {
    calls,
    async select(table, query) {
      calls.select.push({ table, query });
      return jobs;
    },
    async insert(table, rows) {
      calls.insert.push({ table, rows });
      return null;
    },
    async remove(table, query) {
      calls.remove.push({ table, query });
      return null;
    },
    async patch(table, query, values) {
      calls.patch.push({ table, query, values });
      return null;
    },
    async rpc(fn, args) {
      calls.rpc.push({ fn, args });
      return queue.length ? queue.shift() : [];
    },
  };
}

test('the documented cadences are avatar 2h, stories 3h, posts 12h', () => {
  assert.equal(CADENCE_HOURS[TASK.AVATAR], 2);
  assert.equal(CADENCE_HOURS[TASK.STORIES], 3);
  assert.equal(CADENCE_HOURS[TASK.POSTS], 12);
});

test('syncJobs backfills one job per kind for a newly added account', async () => {
  const { store, cleanup } = setup();
  store.addProfile('fresh');
  const rest = fakeRest();
  const scheduler = new JobScheduler(rest, { store, config: {} });

  const r = await scheduler.syncJobs();

  assert.equal(r.added, SCHEDULED_KINDS.length);
  const inserted = rest.calls.insert[0].rows;
  assert.deepEqual(
    inserted.map((j) => j.kind).sort(),
    [...SCHEDULED_KINDS].sort()
  );
  // due_at is left to the column default (now()), which is what makes a new
  // account get picked up by this very run rather than after a full cadence.
  assert.ok(inserted.every((j) => j.due_at === undefined));
  cleanup();
});

test('syncJobs does not reset due_at for jobs that already exist', async () => {
  const { store, cleanup } = setup();
  store.addProfile('known');
  const existing = SCHEDULED_KINDS.map((kind, i) => ({ id: i + 1, username: 'known', kind }));
  const rest = fakeRest({ jobs: existing });

  const r = await new JobScheduler(rest, { store, config: {} }).syncJobs();

  assert.equal(r.added, 0);
  assert.equal(rest.calls.insert.length, 0, 'an existing job must never be rewritten');
  cleanup();
});

test('syncJobs drops jobs for an account that is no longer tracked', async () => {
  const { store, cleanup } = setup();
  store.addProfile('kept');
  const rest = fakeRest({
    jobs: [
      { id: 1, username: 'kept', kind: TASK.AVATAR },
      { id: 7, username: 'removed', kind: TASK.AVATAR },
      { id: 8, username: 'removed', kind: TASK.POSTS },
    ],
  });

  const r = await new JobScheduler(rest, { store, config: {} }).syncJobs();

  assert.equal(r.removed, 2);
  assert.match(rest.calls.remove[0].query, /id=in\.\(7,8\)/);
  cleanup();
});

test('a completed job is rescheduled one cadence out and its attempts reset', async () => {
  const { store, cleanup } = setup();
  const rest = fakeRest();
  const now = Date.parse('2026-08-25T12:00:00Z');
  const scheduler = new JobScheduler(rest, { store, config: {}, clock: () => now });

  await scheduler.complete({ id: 42, username: 'someone', kind: TASK.STORIES, attempts: 1 });

  const { query, values } = rest.calls.patch[0];
  assert.equal(query, 'id=eq.42');
  assert.equal(values.due_at, new Date(now + 3 * 60 * 60 * 1000).toISOString());
  assert.equal(values.started_at, null, 'the in-flight marker must be cleared');
  assert.equal(values.attempts, 0);
  assert.equal(values.last_error, null);
  cleanup();
});

test('a failed job backs off exponentially and records the reason', async () => {
  const { store, cleanup } = setup();
  const rest = fakeRest();
  const now = Date.parse('2026-08-25T12:00:00Z');
  const scheduler = new JobScheduler(rest, { store, config: {}, clock: () => now });

  await scheduler.fail({ id: 9, username: 'someone', kind: TASK.POSTS, attempts: 3 }, new Error('provider exploded'));

  const { values } = rest.calls.patch[0];
  assert.equal(values.due_at, new Date(now + 8 * 60 * 1000).toISOString(), '2^3 = 8 minutes');
  assert.equal(values.started_at, null);
  assert.match(values.last_error, /provider exploded/);
  cleanup();
});

test('backoff is capped so a broken job never parks for hours', async () => {
  const { store, cleanup } = setup();
  const rest = fakeRest();
  const now = Date.parse('2026-08-25T12:00:00Z');
  const scheduler = new JobScheduler(rest, { store, config: {}, clock: () => now });

  await scheduler.fail({ id: 9, username: 'x', kind: TASK.POSTS, attempts: 40 }, new Error('still broken'));

  assert.equal(rest.calls.patch[0].values.due_at, new Date(now + 60 * 60 * 1000).toISOString());
  cleanup();
});

test('runDueJobs works the queue until it is empty and reports exhausted', async () => {
  const { store, cleanup } = setup();
  const rest = fakeRest({
    batches: [
      [{ id: 1, username: 'a', kind: TASK.AVATAR, attempts: 1 }],
      [{ id: 2, username: 'b', kind: TASK.POSTS, attempts: 1 }],
    ],
  });
  const seen = [];
  const handlers = {
    [TASK.AVATAR]: async (job) => { seen.push(job.id); return { changeCount: 0 }; },
    [TASK.POSTS]: async (job) => { seen.push(job.id); return { changeCount: 2 }; },
  };

  const r = await new JobScheduler(rest, { store, config: {}, handlers }).runDueJobs();

  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.ran, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.exhausted, true, 'an empty claim means the queue is drained');
  assert.equal(r.timedOut, false);
  cleanup();
});

test('the time budget stops the loop and leaves the rest for the next ping', async () => {
  const { store, cleanup } = setup();
  // Endlessly claimable work: only the budget can end this run.
  const rest = {
    calls: { patch: [] },
    async patch(table, query, values) { this.calls.patch.push({ query, values }); },
    async rpc() { return [{ id: 1, username: 'a', kind: TASK.AVATAR, attempts: 1 }]; },
  };

  let clock = 0;
  const scheduler = new JobScheduler(rest, {
    store,
    config: {},
    budgetMs: 100,
    clock: () => clock,
    handlers: { [TASK.AVATAR]: async () => { clock += 60; return {}; } },
  });

  const r = await scheduler.runDueJobs();

  assert.equal(r.ran, 2, 'two 60ms jobs must exhaust a 100ms budget');
  assert.equal(r.timedOut, true);
  assert.equal(r.exhausted, false, 'work was left on the queue');
  cleanup();
});

test('a job whose kind has no handler fails instead of hanging the queue', async () => {
  const { store, cleanup } = setup();
  const rest = fakeRest({ batches: [[{ id: 5, username: 'a', kind: 'profile', attempts: 1 }]] });

  const r = await new JobScheduler(rest, { store, config: {}, handlers: {} }).runDueJobs();

  assert.equal(r.failed, 1);
  assert.equal(r.results[0].error, 'no handler');
  assert.match(rest.calls.patch[0].values.last_error, /no handler/);
  cleanup();
});

test('one failing job does not stop the others in its batch', async () => {
  const { store, cleanup } = setup();
  const rest = fakeRest({
    batches: [[
      { id: 1, username: 'a', kind: TASK.AVATAR, attempts: 1 },
      { id: 2, username: 'b', kind: TASK.AVATAR, attempts: 1 },
    ]],
  });
  const handlers = {
    [TASK.AVATAR]: async (job) => {
      if (job.id === 1) throw new Error('nope');
      return { changeCount: 1 };
    },
  };

  const r = await new JobScheduler(rest, { store, config: {}, handlers, logger: { warn() {} } }).runDueJobs();

  assert.equal(r.ran, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.results.find((x) => x.id === 2).ok, true);
  cleanup();
});
