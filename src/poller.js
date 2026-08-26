import crypto from 'node:crypto';
import { runActorSync } from './apify.js';
import { diffProfiles, summarize } from './diff.js';
import { filterNewStories, rememberStories } from './stories.js';
import { createStack } from './providers/stack.js';
import { FEATURE } from './providers/provider-interface.js';
import { PRIORITY, NoProviderAvailableError } from './providers/router.js';

const MAX_POST_MEDIA = 20;
const BACKFILL_LIMIT = 30;

/**
 * The units of work the job scheduler dispatches, each on its own cadence
 * (avatar 2h, stories 3h, posts 12h). `pollProfile` does all of them when no
 * subset is requested, which is what the whole-account `poll()` path wants.
 */
export const TASK = {
  PROFILE: 'profile',
  AVATAR: 'avatar',
  POSTS: 'posts',
  STORIES: 'stories',
};

/**
 * Whether any *enabled* provider offers a feature.
 *
 * Gating on a specific vendor's credential instead of on the capability is what
 * broke stories: they were behind `config.storiesActor` (an Apify actor id), so
 * a RapidAPI-only deployment silently never fetched them.
 */
export function providerOffers(stack, feature) {
  const list = stack?.providers || stack?.router?.providers || [];
  return list.some((p) => p.enabled && p.supports(feature));
}

function sha8(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 8);
}

function extensionFor(url) {
  const clean = (url || '').split('?')[0];
  const m = /\.(jpe?g|png|webp|gif|mp4|webm)$/i.exec(clean);
  return m ? m[1].toLowerCase() : 'jpg';
}

function extensionForContentType(ct) {
  if (!ct) return null;
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mp4',
  };
  return map[ct.split(';')[0].trim().toLowerCase()] || null;
}

/**
 * Best-effort upgrade of an Instagram CDN URL to a larger resolution. Only
 * works when the URL is NOT covered by a signature (oh/oe HMAC); signed URLs
 * return 403 and downloadTo falls back to the original.
 */
function upgradeMediaUrl(url) {
  if (!url) return url;
  return url
    .replace(/\b([sp])\d{2,4}x\d{2,4}\b/g, (m, letter) => (letter === 'p' ? 'p1080x1920' : 's1080x1080'))
    .replace(/stp=dst-jpg[^&]*s\d+x\d+/g, 'stp=dst-jpg_e35_s1080x1080');
}

/**
 * Downloads media once. Files are named after the SHA-256 of their bytes, so a
 * repeat image (same hash) is never saved again — "save or reject". Returns the
 * stored file name (or null on failure).
 *
 * An unchanged avatar records the check rather than the bytes: the 2-hourly
 * avatar cadence would otherwise rewrite an identical image twelve times a day.
 * `logAvatarCheck` is a no-op on the filesystem backend.
 */
async function downloadTo(store, username, url, kind) {
  if (!url) return null;
  const candidates = [];
  const upgraded = upgradeMediaUrl(url);
  if (upgraded !== url) candidates.push(upgraded);
  candidates.push(url);

  let buf = null;
  let ext = null;
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { redirect: 'follow' });
      if (!res.ok) continue;
      const data = Buffer.from(await res.arrayBuffer());
      if (!data.length) continue;
      buf = data;
      ext = extensionForContentType(res.headers.get('content-type')) || extensionFor(candidate);
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (!buf) return null;

  const hash = sha8(buf);
  const name = `${kind}-${hash}.${ext}`;
  const existed = await store.hasMedia(username, name);
  if (!existed) await store.putMedia(username, name, buf);
  if (kind === 'avatar') {
    try {
      await store.logAvatarCheck(username, hash, !existed);
    } catch {
      /* the audit row is not worth failing a poll over */
    }
  }
  return name;
}

/**
 * In-process scheduler. Disabled entirely in cron mode: on a free host that
 * sleeps when idle this timer silently stops firing, so an external cron
 * hitting POST /api/poll must be the single source of truth rather than a
 * second one racing it.
 */
export function schedule(config, store, options = {}) {
  if (config.cronMode) {
    console.log('[poller] CRON_MODE=1 — internal scheduler disabled; waiting for external cron hits.');
    return null;
  }
  const minutes = Math.min(config.pollIntervalHours * 60, 60);
  const ms = minutes * 60 * 1000;
  const onPoll = options.onPoll || poll;
  const timer = setInterval(() => {
    onPoll(store, config).catch((err) => {
      console.error('[poller] scheduled poll failed:', err.message);
    });
  }, ms);
  if (timer.unref && !options.keepAlive) timer.unref();
  return timer;
}

export function profileInterval(profile, config, throttleFactor = 1) {
  const base = Number.isFinite(profile.intervalHours)
    ? profile.intervalHours
    : profile.isPrivate
      ? profile.batchIntervalHours || config.batchIntervalHours
      : config.pollIntervalHours;
  if (!Number.isFinite(throttleFactor) || throttleFactor <= 1) return base;
  return base * throttleFactor;
}

export function isDue(profile, config, now = Date.now(), throttleFactor = 1) {
  if (!profile.lastPolledAt) return true;
  const hours = profileInterval(profile, config, throttleFactor);
  if (!Number.isFinite(hours)) return false; // quota exhausted — throttle is Infinity
  return now - Date.parse(profile.lastPolledAt) >= hours * 60 * 60 * 1000;
}

function filterPostsByBackfill(posts, entry) {
  if (entry.backfill) return posts;
  if (!entry.addedAt) return posts;
  const from = Date.parse(entry.addedAt);
  if (!Number.isFinite(from)) return posts;
  return posts.filter((p) => !p.timestamp || Date.parse(p.timestamp) >= from);
}

export async function pollProfile(store, config, entry, stack, { tasks = null } = {}) {
  const { username } = entry;
  const { router } = stack;
  // No subset requested = do everything (the whole-account poll path).
  const want = (t) => !tasks || tasks.has(t);

  const res = await router.call(FEATURE.PROFILE, {
    username,
    args: { resultsLimit: MAX_POST_MEDIA },
    priority: PRIORITY.NORMAL,
  });
  let profile = res.data;

  const isPrivate = profile.isPrivate;

  const history = store.getHistory();
  const prevList = history.profiles[username] || [];
  const prev = prevList.length ? prevList[prevList.length - 1] : null;

  const justWentPublic = !!prev && prev.profile?.isPrivate === true && isPrivate === false;
  if (justWentPublic) {
    // A newly-public account is a one-off opportunity to capture what was
    // hidden, so this deeper scrape is worth escalating for.
    const backfill = await router.call(FEATURE.PROFILE, {
      username,
      args: { resultsLimit: BACKFILL_LIMIT },
      priority: PRIORITY.CRITICAL,
    });
    profile = backfill.data;
  }

  if (isPrivate !== entry.isPrivate) {
    store.updateProfile(username, { isPrivate });
  }

  // A skipped task carries the previous snapshot's value forward, so the diff
  // reports "unchanged" rather than "avatar/all posts removed".
  const profilePicFile = want(TASK.AVATAR)
    ? await downloadTo(store, username, profile.profilePicUrl, 'avatar')
    : (prev?.profile?.profilePicFile ?? null);

  const knownIds = new Set((prev ? prev.posts : []).map((p) => p.id));
  const posts = [];
  if (!isPrivate && want(TASK.POSTS)) {
    const tracked = justWentPublic ? profile.posts : filterPostsByBackfill(profile.posts, entry);
    const cap = justWentPublic ? BACKFILL_LIMIT : MAX_POST_MEDIA;
    for (const post of tracked.slice(0, cap)) {
      const mediaFile = knownIds.has(post.id)
        ? null
        : await downloadTo(store, username, post.displayUrl || post.thumbnailUrl, 'post');
      posts.push({ ...post, mediaFile });
    }
  } else if (!isPrivate && prev) {
    posts.push(...prev.posts);
  }

  const stories = [];
  const storyChanged = [];
  if (!isPrivate && entry.trackStories && want(TASK.STORIES) && providerOffers(stack, FEATURE.STORIES)) {
    try {
      const storyRes = await router.call(FEATURE.STORIES, {
        username,
        args: { maxItems: 20 },
        priority: PRIORITY.LOW,
      });
      const fresh = filterNewStories(storyRes.data || [], entry.seenStories);
      const newOnes = [];
      for (const s of fresh.slice(0, 20)) {
        const mediaFile = await downloadTo(store, username, s.mediaUrl, 'story');
        if (mediaFile) {
          stories.push({ ...s, mediaFile });
          newOnes.push(s);
        }
      }
      if (newOnes.length) {
        store.updateProfile(username, { seenStories: rememberStories(entry.seenStories, newOnes) });
        storyChanged.push(...stories);
      }
    } catch (err) {
      console.warn(`[poller] stories for ${username} skipped: ${err.message}`);
    }
  }

  const normalized = { ...profile, profilePicFile, posts };
  const summary = summarize(normalized);
  const changes = diffProfiles(prev, { profile: summary, posts });
  for (const s of stories) {
    changes.push({ type: 'story', field: 'story', to: { timestamp: s.timestamp, highlightTitle: s.highlightTitle, mediaFile: s.mediaFile } });
  }
  const snapshot = {
    at: new Date().toISOString(),
    username,
    profile: summary,
    posts,
    stories,
    changes,
    changeCount: changes.length,
  };

  store.saveSnapshot(username, snapshot);
  store.updateProfile(username, { lastPolledAt: snapshot.at });
  return { snapshot, storyChanged };
}

/**
 * Turns any failure into a result row, distinguishing "the provider broke" from
 * "we refused to spend". A budget refusal is not an error the operator needs to
 * fix, so the dashboard must be able to tell them apart.
 */
function failureRow(username, err, extra = {}) {
  const blocked = err instanceof NoProviderAvailableError;
  return {
    username,
    ok: false,
    due: true,
    error: err.message,
    ...(blocked ? { blocked: true, reason: (err.attempts || []).map((a) => a.reason).join(',') } : {}),
    ...(err.kind ? { kind: err.kind } : {}),
    ...extra,
  };
}

export async function poll(store, config, { force = false, runner = runActorSync, stack = null } = {}) {
  const cfg = store.getConfig();
  const profiles = cfg.profiles || [];
  if (!profiles.length) {
    return { ok: false, skipped: true, message: 'No profiles configured yet.' };
  }
  const ctx = stack || createStack(store, config, { runner, logger: console });
  const { costManager } = ctx;

  // Gate on capability, not on one vendor's credential: RapidAPI alone can serve
  // every request, so aborting because APIFY_TOKEN is unset would defeat the
  // whole failover chain.
  if (!providerOffers(ctx, FEATURE.PROFILE)) {
    throw new Error(
      'No data provider is configured. Set at least one of RAPIDAPI_KEY, APIFY_TOKEN, BRIGHTDATA_API_KEY or LOBSTR_API_KEY.'
    );
  }

  if (costManager.killSwitch()) {
    return { ok: false, skipped: true, killSwitch: true, message: 'Kill switch is on — no external API calls made.' };
  }

  const startedAt = new Date().toISOString();
  store.setConfig({ lastPollAt: startedAt, lastPollStatus: 'running', lastPollError: null });

  const now = Date.now();
  // Adaptive polling (PRD 430–451): as the monthly budget is consumed, every
  // profile's interval stretches, so quota lasts to the end of the month
  // instead of running dry mid-cycle.
  const throttle = costManager.throttleFactor('apify', { now: new Date(now) });
  const results = [];
  let totalChanges = 0;
  let polledCount = 0;
  let pingCount = 0;

  const pendingPings = [];

  for (const entry of profiles) {
    const due = force || isDue(entry, config, now, throttle);
    if (!due) {
      if (entry.isPrivate) {
        pendingPings.push(entry);
      } else {
        results.push({
          username: entry.username,
          ok: true,
          due: false,
          throttleFactor: throttle,
          nextPollAt: nextPollFor(entry, config, throttle),
        });
      }
      continue;
    }
    try {
      const { snapshot, storyChanged } = await pollProfile(store, config, entry, ctx);
      polledCount += 1;
      totalChanges += snapshot.changeCount;
      results.push({
        username: entry.username,
        ok: true,
        due: true,
        at: snapshot.at,
        changeCount: snapshot.changeCount,
        changes: snapshot.changes,
        newStories: storyChanged.length,
      });
    } catch (err) {
      results.push(failureRow(entry.username, err));
    }
  }

  if (pendingPings.length) {
    pingCount = pendingPings.length;
    try {
      const statuses = await pingPrivateAccounts(store, config, pendingPings, ctx);
      for (const entry of pendingPings) {
        const status = statuses.get(entry.username);
        if (!status) {
          results.push({ username: entry.username, ok: true, due: false, ping: true, error: 'no result from ping' });
          continue;
        }
        if (!status.isPrivate) {
          try {
            const { snapshot, storyChanged } = await pollProfile(store, config, entry, ctx);
            polledCount += 1;
            totalChanges += snapshot.changeCount;
            results.push({
              username: entry.username,
              ok: true,
              due: true,
              ping: true,
              wentPublic: true,
              at: snapshot.at,
              changeCount: snapshot.changeCount,
              changes: snapshot.changes,
              newStories: storyChanged.length,
            });
          } catch (err) {
            results.push(failureRow(entry.username, err, { ping: true, wentPublic: true }));
          }
        } else {
          results.push({
            username: entry.username,
            ok: true,
            due: false,
            ping: true,
            stillPrivate: true,
            nextPollAt: nextPollFor(entry, config, throttle, startedAt),
          });
        }
      }
    } catch (err) {
      for (const entry of pendingPings) {
        results.push({ username: entry.username, ok: true, due: false, ping: true, error: err.message });
      }
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  const blocked = results.filter((r) => r.blocked).length;
  const okCount = results.length - failed;
  const status = failed === 0 ? 'ok' : okCount === 0 ? 'error' : 'partial';
  const nextIntervalHours = config.pollIntervalHours * (Number.isFinite(throttle) ? throttle : 1);

  store.setConfig({
    lastPollStatus: status,
    lastPollError: failed > 0 ? `${failed} profile(s) failed${blocked ? ` (${blocked} blocked by budget)` : ''}` : null,
    nextPollAt: new Date(now + nextIntervalHours * 60 * 60 * 1000).toISOString(),
    totalSnapshots: (cfg.totalSnapshots || 0) + polledCount,
    totalChanges: (cfg.totalChanges || 0) + totalChanges,
  });

  return {
    ok: failed === 0,
    partial: status === 'partial',
    skipped: false,
    results,
    polledCount,
    pingCount,
    blocked,
    totalChanges,
    throttleFactor: throttle,
    usage: costManager.snapshot({ now: new Date(now) }),
    nextPollAt: store.getConfig().nextPollAt,
  };
}

function nextPollFor(entry, config, throttle, fallbackAt = null) {
  const from = Date.parse(entry.lastPolledAt || fallbackAt || new Date().toISOString());
  const hours = profileInterval(entry, config, throttle);
  if (!Number.isFinite(from) || !Number.isFinite(hours)) return null;
  return new Date(from + hours * 60 * 60 * 1000).toISOString();
}

/**
 * Hourly privacy ping for known-private accounts. All private accounts are
 * checked in ONE batched provider call (a lightweight `details` scrape) so we
 * learn within ~1h whether any went public, without paying for a full poll per
 * account. Priority is LOW: this is a cost-saving probe and must never escalate
 * to a costlier provider. Returns Map<username, { isPrivate }>.
 */
async function pingPrivateAccounts(store, config, entries, stack) {
  const res = await stack.router.call(FEATURE.PROFILE, {
    username: entries[0]?.username,
    args: { usernames: entries.map((e) => e.username), resultsLimit: Math.max(entries.length, 1) },
    priority: PRIORITY.LOW,
    units: Math.max(entries.length, 1), // one dataset item per account, not a full scrape
  });
  const items = Array.isArray(res.data) ? res.data : [res.data];
  const map = new Map();
  for (const item of items) {
    if (!item || item.noResults || !item.username) continue;
    map.set(item.username, { isPrivate: !!(item.private || item.isPrivate) });
  }
  return map;
}
