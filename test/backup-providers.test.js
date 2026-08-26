import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { CostManager, MODE } from '../src/cost/cost-manager.js';
import { CircuitBreaker } from '../src/cost/circuit-breaker.js';
import { ProviderRouter } from '../src/providers/router.js';
import { FEATURE, TIER } from '../src/providers/provider-interface.js';
import { normalizeProfileShape, normalizePosts, toCount, toIso } from '../src/providers/normalize.js';
import { RapidApiProvider, extractStoryItems } from '../src/providers/rapidapi-provider.js';
import { BrightDataProvider } from '../src/providers/brightdata-provider.js';
import { LobstrProvider } from '../src/providers/lobstr-provider.js';

/* ------------------------------------------------------------------ */
/* normalize.js — every provider depends on this producing one shape.  */
/* ------------------------------------------------------------------ */

test('normalize maps snake_case vendor fields onto the canonical shape', () => {
  const p = normalizeProfileShape({
    username: 'alice',
    full_name: 'Alice A',
    biography: 'hi',
    follower_count: 1234,
    following_count: 56,
    media_count: 7,
    is_private: true,
    is_verified: false,
    profile_pic_url_hd: 'https://cdn/hd.jpg',
    external_url: 'https://a.com',
  });
  assert.equal(p.username, 'alice');
  assert.equal(p.fullName, 'Alice A');
  assert.equal(p.followersCount, 1234);
  assert.equal(p.followingCount, 56);
  assert.equal(p.postsCount, 7);
  assert.equal(p.isPrivate, true);
  assert.equal(p.verified, false);
  assert.equal(p.profilePicUrl, 'https://cdn/hd.jpg');
});

test('normalize maps Bright Data field names', () => {
  const p = normalizeProfileShape([{
    account: 'bob',
    followers: '12.3K',
    posts_count: 4,
    is_private: false,
    profile_image_link: 'https://cdn/bob.jpg',
  }]);
  assert.equal(p.username, 'bob');
  assert.equal(p.followersCount, 12300);
  assert.equal(p.profilePicUrl, 'https://cdn/bob.jpg');
});

test('normalize unwraps a { data: { user } } envelope', () => {
  const p = normalizeProfileShape({ data: { user: { username: 'carol', followers_count: 9 } } });
  assert.equal(p.username, 'carol');
  assert.equal(p.followersCount, 9);
});

test('normalize reads GraphQL edge counts', () => {
  const p = normalizeProfileShape({
    username: 'dave',
    edge_followed_by: { count: 500 },
    edge_follow: { count: 100 },
  });
  assert.equal(p.followersCount, 500);
  assert.equal(p.followingCount, 100);
});

/**
 * The important safety property: an unrecognized payload must throw, not return
 * zeros. A fabricated "0 followers, public" snapshot would be diffed against the
 * real one and alert as a genuine Instagram change.
 */
test('normalize throws on a payload with no profile fields', () => {
  assert.throws(() => normalizeProfileShape({ message: 'quota exceeded' }, { username: 'x' }), /no recognizable profile fields/);
  assert.throws(() => normalizeProfileShape(null), /no recognizable profile fields/);
});

test('normalize falls back to the requested username when absent', () => {
  const p = normalizeProfileShape({ followers_count: 1, is_private: true }, { username: 'erin' });
  assert.equal(p.username, 'erin');
});

test('toCount parses suffixes and separators; toIso handles s/ms/ISO', () => {
  assert.equal(toCount('1,234'), 1234);
  assert.equal(toCount('2.5M'), 2500000);
  assert.equal(toCount(0), 0);
  assert.equal(toCount('nope'), null);
  assert.equal(toIso(1700000000), '2023-11-14T22:13:20.000Z');
  assert.equal(toIso(1700000000000), '2023-11-14T22:13:20.000Z');
  assert.equal(toIso(''), null);
});

test('normalizePosts handles GraphQL node wrappers and video flags', () => {
  const posts = normalizePosts([
    { node: { id: '1', shortcode: 'abc', taken_at_timestamp: 1700000000, is_video: true, display_url: 'u1' } },
    { pk: '2', caption: { text: 'hey' }, like_count: 5, media_type: 1, image_url: 'u2' },
  ]);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].isVideo, true);
  assert.equal(posts[0].shortcode, 'abc');
  assert.equal(posts[1].caption, 'hey');
  assert.equal(posts[1].likesCount, 5);
  assert.equal(posts[1].isVideo, false);
});

/* ------------------------------------------------------------------ */
/* RapidAPI                                                            */
/* ------------------------------------------------------------------ */

const rapidConfig = {
  rapidapi: {
    key: 'test-key',
    host: 'example-host.p.rapidapi.com',
    profilePath: '/v1/info',
    storiesPath: '/v1/stories',
    highlightsPath: '/v1/highlights',
    usernameParam: 'username_or_id_or_url',
  },
};

test('rapidapi sends marketplace headers and the configured path', async () => {
  const seen = [];
  const p = new RapidApiProvider(rapidConfig, {
    fetcher: async (url, opts) => {
      seen.push({ url, opts });
      return { data: { username: 'alice', follower_count: 10, is_private: false } };
    },
  });

  const res = await p.getProfile('alice');
  assert.equal(res.data.username, 'alice');
  assert.equal(res.units, 1);
  assert.match(seen[0].url, /^https:\/\/example-host\.p\.rapidapi\.com\/v1\/info\?/);
  assert.match(seen[0].url, /username_or_id_or_url=alice/);
  assert.equal(seen[0].opts.headers['x-rapidapi-key'], 'test-key');
  assert.equal(seen[0].opts.headers['x-rapidapi-host'], 'example-host.p.rapidapi.com');
});

test('rapidapi is disabled without a key', () => {
  const p = new RapidApiProvider({ rapidapi: { host: 'h' } });
  assert.equal(p.enabled, false);
});

test('rapidapi merges stories and highlights and dedupes', async () => {
  const p = new RapidApiProvider(rapidConfig, {
    fetcher: async (url) => {
      if (url.includes('/v1/stories')) {
        return { data: { items: [{ pk: '1', media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/111111111_a.jpg' }] } }] } };
      }
      return {
        data: [{
          title: 'Trips',
          items: [{ pk: '2', media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/222222222_b.jpg' }] } }],
        }],
      };
    },
  });

  const res = await p.getStories('alice');
  assert.equal(res.data.length, 2);
  assert.equal(res.units, 2);
  assert.equal(res.data.some((s) => s.isHighlight && s.highlightTitle === 'Trips'), true);
});

/** A dead highlights endpoint must not throw away the stories we did get. */
test('rapidapi returns partial stories when only one endpoint fails', async () => {
  const p = new RapidApiProvider(rapidConfig, {
    fetcher: async (url) => {
      if (url.includes('/v1/highlights')) throw Object.assign(new Error('boom'), { status: 500 });
      return { data: { items: [{ pk: '1', media_type: 1, image_versions2: { candidates: [{ url: 'https://cdn/111111111_a.jpg' }] } }] } };
    },
  });
  const res = await p.getStories('alice');
  assert.equal(res.data.length, 1);
});

test('rapidapi throws when both story endpoints fail', async () => {
  const p = new RapidApiProvider(rapidConfig, {
    fetcher: async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    },
  });
  await assert.rejects(() => p.getStories('alice'), /boom/);
});

test('extractStoryItems skips items with no resolvable media', () => {
  assert.equal(extractStoryItems({ data: { items: [{ pk: '1' }] } }, false).length, 0);
});

/* ------------------------------------------------------------------ */
/* Bright Data                                                         */
/* ------------------------------------------------------------------ */

const bdConfig = { brightdata: { apiKey: 'bd-key', datasetId: 'gd_test', snapshotPollMs: 1, snapshotTimeoutMs: 500 } };

test('brightdata posts inputs to the sync scrape endpoint with bearer auth', async () => {
  const seen = [];
  const p = new BrightDataProvider(bdConfig, {
    fetcher: async (url, opts) => {
      seen.push({ url, opts });
      return { status: 200, ok: true, text: JSON.stringify([{ account: 'alice', followers: 10, is_private: true }]) };
    },
  });

  const res = await p.getProfile('alice');
  assert.equal(res.data.username, 'alice');
  assert.equal(res.data.isPrivate, true);
  assert.match(seen[0].url, /\/datasets\/v3\/scrape\?/);
  assert.match(seen[0].url, /dataset_id=gd_test/);
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer bd-key');
  assert.deepEqual(seen[0].opts.body.input, [{ url: 'https://www.instagram.com/alice/' }]);
});

test('brightdata batches every username into one request', async () => {
  let body = null;
  const p = new BrightDataProvider(bdConfig, {
    fetcher: async (url, opts) => {
      body = opts.body;
      return { status: 200, ok: true, text: JSON.stringify([{ account: 'a' }, { account: 'b' }]) };
    },
  });
  const res = await p.getProfile('a', { usernames: ['a', 'b'] });
  assert.equal(body.input.length, 2);
  assert.equal(res.units, 2);
  assert.equal(Array.isArray(res.data), true); // batch mode returns raw records
});

/** 202 is control flow, not an error: switch to polling the snapshot. */
test('brightdata falls back to snapshot polling on 202', async () => {
  const calls = [];
  const p = new BrightDataProvider(bdConfig, {
    fetcher: async (url) => {
      calls.push(url);
      if (url.includes('/scrape')) return { status: 202, ok: false, text: JSON.stringify({ snapshot_id: 's_1' }) };
      if (calls.filter((c) => c.includes('/snapshot/')).length === 1) return { status: 202, ok: false, text: '' };
      return { status: 200, ok: true, text: JSON.stringify([{ account: 'alice', followers: 3 }]) };
    },
  });

  const res = await p.getProfile('alice');
  assert.equal(res.data.username, 'alice');
  assert.equal(calls.filter((c) => c.includes('/snapshot/s_1')).length, 2);
});

test('brightdata maps an error record to not_found', async () => {
  const p = new BrightDataProvider(bdConfig, {
    fetcher: async () => ({ status: 200, ok: true, text: JSON.stringify([{ error: 'dead page' }]) }),
  });
  await assert.rejects(() => p.getProfile('ghost'), (err) => err.kind === 'not_found');
});

test('brightdata is disabled without a dataset id', () => {
  assert.equal(new BrightDataProvider({ brightdata: { apiKey: 'k' } }).enabled, false);
});

/* ------------------------------------------------------------------ */
/* Lobstr                                                              */
/* ------------------------------------------------------------------ */

const lobConfig = { lobstr: { apiKey: 'lob-key', squidId: 'sq_1', runPollMs: 1, runTimeoutMs: 500 } };

/** Skip the mandated 5s poll floor rather than idling on it in every test. */
const noSleep = async () => {};

test('lobstr queues tasks, starts a run, polls, then reads results by run', async () => {
  const calls = [];
  const p = new LobstrProvider(lobConfig, {
    sleeper: noSleep,
    fetcher: async (url, opts) => {
      calls.push(`${opts.method || 'GET'} ${url}`);
      if (url.endsWith('/tasks')) return { tasks: [{ id: 't1' }], duplicated_count: 0 };
      if (url.endsWith('/runs')) return { id: 'run_1' };
      if (url.includes('/runs/run_1')) return { status: 'done' };
      if (url.includes('/results')) {
        return { total_results: 1, next: null, data: [{ username: 'alice', followers_count: 42, is_private: false }] };
      }
      throw new Error(`unexpected ${url}`);
    },
  });

  const res = await p.getProfile('alice');
  assert.equal(res.data.username, 'alice');
  assert.equal(res.data.followersCount, 42);
  assert.equal(calls[0], 'POST https://api.lobstr.io/v1/tasks');
  assert.equal(calls[1], 'POST https://api.lobstr.io/v1/runs');
  // Results must be scoped to the run, never the squid (which returns history).
  assert.equal(calls.some((c) => c.includes('/results?run=run_1')), true);
  assert.equal(calls.some((c) => c.includes('squid=')), false);
});

/** An already-finished run must not pay the poll interval. */
test('lobstr polls before sleeping', async () => {
  let slept = 0;
  const p = new LobstrProvider(lobConfig, {
    sleeper: async () => { slept += 1; },
    fetcher: async (url) => {
      if (url.endsWith('/tasks')) return { tasks: [] };
      if (url.endsWith('/runs')) return { id: 'r' };
      if (url.includes('/runs/r')) return { status: 'done' };
      return { next: null, data: [{ username: 'alice', followers_count: 1 }] };
    },
  });
  await p.getProfile('alice');
  assert.equal(slept, 0);
});

test('lobstr keeps polling while the run is still going', async () => {
  let polls = 0;
  const p = new LobstrProvider({ lobstr: { ...lobConfig.lobstr, runTimeoutMs: 60000 } }, {
    sleeper: noSleep,
    fetcher: async (url) => {
      if (url.endsWith('/tasks')) return { tasks: [] };
      if (url.endsWith('/runs')) return { id: 'r' };
      if (url.includes('/runs/r')) {
        polls += 1;
        return { status: polls < 3 ? 'running' : 'done' };
      }
      return { next: null, data: [{ username: 'alice', followers_count: 1 }] };
    },
  });
  await p.getProfile('alice');
  assert.equal(polls, 3);
});

test('lobstr times out a run that never finishes', async () => {
  const p = new LobstrProvider(lobConfig, {
    sleeper: noSleep,
    fetcher: async (url) => {
      if (url.endsWith('/tasks')) return { tasks: [] };
      if (url.endsWith('/runs')) return { id: 'r' };
      if (url.includes('/runs/r')) return { status: 'running' };
      return { next: null, data: [] };
    },
  });
  await assert.rejects(() => p.getProfile('alice'), /did not finish in time/);
});

test('lobstr treats a non-done terminal run as a provider fault', async () => {
  const p = new LobstrProvider(lobConfig, {
    sleeper: noSleep,
    fetcher: async (url) => {
      if (url.endsWith('/tasks')) return { tasks: [] };
      if (url.endsWith('/runs')) return { id: 'run_2' };
      if (url.includes('/runs/run_2')) return { status: 'error' };
      return {};
    },
  });
  await assert.rejects(() => p.getProfile('alice'), /finished as "error"/);
});

test('lobstr picks the record matching the requested username', async () => {
  const p = new LobstrProvider(lobConfig, {
    sleeper: noSleep,
    fetcher: async (url) => {
      if (url.endsWith('/tasks')) return { tasks: [] };
      if (url.endsWith('/runs')) return { id: 'run_3' };
      if (url.includes('/runs/run_3')) return { status: 'done' };
      return { next: null, data: [{ username: 'other', followers_count: 1 }, { username: 'alice', followers_count: 2 }] };
    },
  });
  const res = await p.getProfile('alice');
  assert.equal(res.data.followersCount, 2);
});

test('lobstr is disabled without a squid id', () => {
  assert.equal(new LobstrProvider({ lobstr: { apiKey: 'k' } }).enabled, false);
});

/* ------------------------------------------------------------------ */
/* The headline requirement: credit exhaustion hands off to the next.  */
/* ------------------------------------------------------------------ */

function realStack(providers, limits, budgetMode = MODE.BALANCED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igmon-backup-'));
  const store = new Store(dir);
  const costManager = new CostManager(store, { budgetMode }, { limits });
  const breaker = new CircuitBreaker(store, { failureThreshold: 3, cooldownMs: 60000 });
  const router = new ProviderRouter({ providers, costManager, breaker, logger: { warn() {} } });
  return { router, costManager, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a spent RapidAPI quota transparently hands profile work to Bright Data', async () => {
  const rapid = new RapidApiProvider(rapidConfig, {
    fetcher: async () => ({ data: { username: 'alice', follower_count: 1 } }),
  });
  const bright = new BrightDataProvider(bdConfig, {
    fetcher: async () => ({ status: 200, ok: true, text: JSON.stringify([{ account: 'alice', followers: 2 }]) }),
  });

  const limits = {
    // RapidAPI has one unit of monthly quota, so the second call must move on.
    rapidapi: { tier: TIER.FREE, unitCostUsd: 0, freeUnitsPerMonth: 1, dailyUnits: 10, monthlyUnits: 1 },
    brightdata: { tier: TIER.LOW_COST, unitCostUsd: 0.001, freeUnitsPerMonth: 100, dailyUnits: 100, monthlyUnits: 100 },
  };
  const { router, cleanup } = realStack([rapid, bright], limits);

  try {
    const first = await router.call(FEATURE.PROFILE, { username: 'alice' });
    assert.equal(first.provider, 'rapidapi', 'free tier goes first while it has quota');

    const second = await router.call(FEATURE.PROFILE, { username: 'alice' });
    assert.equal(second.provider, 'brightdata', 'quota exhausted -> next provider takes over');
    assert.equal(second.data.followersCount, 2);

    // The skip is recorded as a quota denial, not a provider failure.
    const skipped = second.attempts.find((a) => a.provider === 'rapidapi');
    assert.equal(skipped.ok, false);
    assert.match(skipped.reason, /limit_reached|allowance_exhausted/);
  } finally {
    cleanup();
  }
});

test('failover continues down the chain to lobstr when both others are spent', async () => {
  const rapid = new RapidApiProvider(rapidConfig, { fetcher: async () => ({ data: { username: 'a', follower_count: 1 } }) });
  const bright = new BrightDataProvider(bdConfig, { fetcher: async () => ({ status: 200, ok: true, text: '[{"account":"a"}]' }) });
  const lobstr = new LobstrProvider(lobConfig, {
    sleeper: noSleep,
    fetcher: async (url) => {
      if (url.endsWith('/tasks')) return { tasks: [] };
      if (url.endsWith('/runs')) return { id: 'r' };
      if (url.includes('/runs/r')) return { status: 'done' };
      return { next: null, data: [{ username: 'a', followers_count: 99 }] };
    },
  });

  const zero = (tier) => ({ tier, unitCostUsd: 0, freeUnitsPerMonth: 0, dailyUnits: 0, monthlyUnits: 0 });
  const limits = {
    rapidapi: zero(TIER.FREE),
    brightdata: zero(TIER.LOW_COST),
    lobstr: { tier: TIER.LOW_COST, unitCostUsd: 0.002, freeUnitsPerMonth: 50, dailyUnits: 50, monthlyUnits: 50 },
  };
  const { router, cleanup } = realStack([rapid, bright, lobstr], limits);

  try {
    const res = await router.call(FEATURE.PROFILE, { username: 'a' });
    assert.equal(res.provider, 'lobstr');
    assert.equal(res.data.followersCount, 99);
  } finally {
    cleanup();
  }
});

test('providers with no credentials are skipped rather than attempted', async () => {
  const bare = new RapidApiProvider({ rapidapi: {} });
  const bright = new BrightDataProvider(bdConfig, {
    fetcher: async () => ({ status: 200, ok: true, text: '[{"account":"a","followers":7}]' }),
  });
  const limits = {
    rapidapi: { tier: TIER.FREE, unitCostUsd: 0, freeUnitsPerMonth: 100, dailyUnits: 100, monthlyUnits: 100 },
    brightdata: { tier: TIER.LOW_COST, unitCostUsd: 0.001, freeUnitsPerMonth: 100, dailyUnits: 100, monthlyUnits: 100 },
  };
  const { router, cleanup } = realStack([bare, bright], limits);
  try {
    const res = await router.call(FEATURE.PROFILE, { username: 'a' });
    assert.equal(res.provider, 'brightdata');
  } finally {
    cleanup();
  }
});

/**
 * Pins the default-mode gotcha. Bright Data and Lobstr have no free monthly
 * allowance, so in maximum_free mode their ceiling resolves to 0 and they are
 * never chosen — the chain is effectively rapidapi -> apify. Reaching the paid
 * backups requires BUDGET_MODE=balanced or a non-zero *_FREE_UNITS.
 */
test('maximum_free mode refuses the paid backups even when they are configured', async () => {
  const bright = new BrightDataProvider(bdConfig, {
    fetcher: async () => ({ status: 200, ok: true, text: '[{"account":"a","followers":7}]' }),
  });
  const limits = {
    brightdata: { tier: TIER.LOW_COST, unitCostUsd: 0.001, freeUnitsPerMonth: 0, dailyUnits: 240, monthlyUnits: 5000 },
  };

  const spent = realStack([bright], limits, MODE.MAX_FREE);
  try {
    await assert.rejects(() => spent.router.call(FEATURE.PROFILE, { username: 'a' }));
    assert.equal(spent.costManager.monthlyCeiling('brightdata'), 0);
  } finally {
    spent.cleanup();
  }

  const allowed = realStack([bright], limits, MODE.BALANCED);
  try {
    const res = await allowed.router.call(FEATURE.PROFILE, { username: 'a' });
    assert.equal(res.provider, 'brightdata');
  } finally {
    allowed.cleanup();
  }
});
