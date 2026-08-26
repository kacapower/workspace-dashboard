import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore, STATE_DOCUMENTS } from '../src/stores/supabase-store.js';
import { CONFIG_FILE, USAGE_FILE, HISTORY_FILE } from '../src/config.js';

/**
 * Fake SupabaseRest. Records every call so a test can assert on the WIRE
 * traffic, which is the whole point: the contract being tested is "one request
 * to hydrate, one to flush, and only mutated documents get written".
 */
function fakeRest(seed = {}) {
  const rows = new Map(Object.entries(seed));
  const calls = { select: [], upsert: [], insert: [] };
  return {
    calls,
    rows,
    async select(table, query) {
      calls.select.push({ table, query });
      return [...rows.entries()].map(([key, value]) => ({ key, value }));
    },
    async upsert(table, payload, opts) {
      calls.upsert.push({ table, rows: payload, opts });
      for (const r of payload) rows.set(r.key, r.value);
      return null;
    },
    async insert(table, row) {
      calls.insert.push({ table, row });
      return null;
    },
    async listObjects() {
      return [];
    },
  };
}

test('readJson before hydrate throws instead of silently returning the fallback', () => {
  const store = new SupabaseStore({ rest: fakeRest() });
  // A silent fallback here would read as "no profiles configured" and the poll
  // would quietly do nothing forever.
  assert.throws(() => store.getConfig(), /before hydrate/);
});

test('hydrate loads every state document in one select', async () => {
  const rest = fakeRest({ [CONFIG_FILE]: { profiles: [{ username: 'someone' }] } });
  const store = new SupabaseStore({ rest });

  const loaded = await store.hydrate();

  assert.equal(loaded, 1);
  assert.equal(rest.calls.select.length, 1, 'hydrate must be a single request');
  for (const doc of STATE_DOCUMENTS) {
    assert.ok(rest.calls.select[0].query.includes(doc), `${doc} must be requested`);
  }
  assert.equal(store.getProfiles()[0].username, 'someone');
});

test('flush writes only mutated documents', async () => {
  const rest = fakeRest({
    [CONFIG_FILE]: { profiles: [] },
    [USAGE_FILE]: { totals: {} },
    [HISTORY_FILE]: { profiles: {} },
  });
  const store = new SupabaseStore({ rest });
  await store.hydrate();

  store.setHistory({ profiles: { someone: [{ at: 'now' }] } });

  assert.deepEqual(store.dirtyDocuments, [HISTORY_FILE]);

  const written = await store.flush();

  assert.equal(written, 1);
  assert.equal(rest.calls.upsert.length, 1, 'flush must be a single request');
  assert.deepEqual(
    rest.calls.upsert[0].rows.map((r) => r.key),
    [HISTORY_FILE],
    'an untouched document must not be rewritten'
  );
  assert.equal(rest.calls.upsert[0].opts.onConflict, 'key');
});

test('flush is a no-op when nothing changed', async () => {
  const rest = fakeRest({ [CONFIG_FILE]: { profiles: [] } });
  const store = new SupabaseStore({ rest });
  await store.hydrate();

  assert.equal(await store.flush(), 0);
  assert.equal(rest.calls.upsert.length, 0, 'a read-only run must not write');
});

test('hydrate/flush round-trips a mutation back out of the store', async () => {
  const rest = fakeRest();
  const store = new SupabaseStore({ rest });
  await store.hydrate();

  store.addProfile('roundtrip');
  await store.flush();

  const reopened = new SupabaseStore({ rest });
  await reopened.hydrate();
  assert.equal(reopened.getProfiles()[0].username, 'roundtrip');
});

test('flush clears the dirty set so a second flush writes nothing', async () => {
  const rest = fakeRest();
  const store = new SupabaseStore({ rest });
  await store.hydrate();
  store.addProfile('once');

  await store.flush();
  await store.flush();

  assert.equal(rest.calls.upsert.length, 1, 'the second flush must be a no-op');
  assert.deepEqual(store.dirtyDocuments, []);
});

test('an unchanged avatar logs the check instead of storing the bytes again', async () => {
  const rest = fakeRest();
  const store = new SupabaseStore({ rest });

  await store.logAvatarCheck('someone', 'abc123', false);

  assert.equal(rest.calls.insert.length, 1);
  assert.equal(rest.calls.insert[0].table, 'avatar_checks');
  assert.deepEqual(rest.calls.insert[0].row, { username: 'someone', hash: 'abc123', changed: false });
});
