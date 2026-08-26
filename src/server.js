import { pathToFileURL } from 'node:url';
import express from 'express';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { mediaContentType } from './stores/base-store.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, sessionCookie, clearSessionCookie, parseCookies } from './auth.js';
import { schedule, isDue, profileInterval, providerOffers } from './poller.js';
import { runCronCycle } from './cron-cycle.js';
import { SupabasePollLock } from './stores/supabase-lock.js';
import { createStack } from './providers/stack.js';
import { FEATURE } from './providers/provider-interface.js';
import { MODE } from './cost/cost-manager.js';
import { cleanupOldMedia } from './retention.js';
import { buildBackupArchive } from './backup.js';
import { syncToHF, deleteFromHF, restoreFromHF, hfEnabled, createSyncDebouncer } from './hf.js';
import { sendTelegram, telegramConfigured } from './telegram.js';

const MEDIA_USER_RE = /^[a-zA-Z0-9._-]+$/;
const MEDIA_FILE_RE = /^[a-zA-Z0-9._-]+\.(jpe?g|png|webp|gif|mp4|webm)$/i;

/**
 * Media params come straight off the URL and `FsStore` path.joins them onto the
 * media root, so a `..` username would escape the tree. The character classes
 * already exclude `/` and `\`, which leaves `.` and `..` as the only remaining
 * traversal segments — reject those explicitly.
 */
function isSafeMediaPath(username, file) {
  if (!MEDIA_USER_RE.test(username) || !MEDIA_FILE_RE.test(file)) return false;
  return username !== '.' && username !== '..';
}

export function createApp({ config = loadConfig(), store = new Store(config.dataDir) } = {}) {
  const app = express();
  app.use(express.json());

  const syncDebouncer = createSyncDebouncer(config, store);
  store.onChange(() => syncDebouncer.schedule());
  app.syncDebouncer = syncDebouncer;

  // Read-only view of the persisted cost state for the dashboard. Poll runs
  // build their own stack so a long-lived server never caches quota state.
  const stack = createStack(store, config, { logger: console });
  const pollLock = store.rest ? new SupabasePollLock(store.rest, {
  staleMs: (config.pollLockStaleMinutes ?? 20) * 60 * 1000,
}) : null;

  app.use(express.static(config.publicDir, { extensions: ['html'] }));

  function isAuthed(req) {
    const cookies = parseCookies(req);
    return verifyToken(cookies.igmon, config.secret);
  }

  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    return res.status(401).json({ error: 'Authentication required.' });
  }

  function isPollAllowed(req) {
    if (isAuthed(req)) return true;
    const header = req.get('x-poll-token');
    return !!header && header === config.pollToken;
  }

  function requirePollAccess(req, res, next) {
    if (isPollAllowed(req)) return next();
    return res.status(401).json({ error: 'Not authorized to trigger a poll.' });
  }

  app.get('/api/status', (req, res) => {
    const cfg = store.getConfig();
    const passwordSet = !!store.getPasswordHash();
    const authed = isAuthed(req);
    const now = Date.now();
    const throttle = stack.costManager.throttleFactor('apify');
    const profiles = (cfg.profiles || []).map((p) => {
      const intervalHours = profileInterval(p, config, throttle);
      const nextPollAt = p.lastPolledAt && Number.isFinite(intervalHours)
        ? new Date(Date.parse(p.lastPolledAt) + intervalHours * 60 * 60 * 1000).toISOString()
        : null;
      return { ...p, intervalHours, nextPollAt, due: isDue(p, config, now, throttle) };
    });
    res.json({
      passwordSet,
      locked: passwordSet && !authed,
      profiles: authed ? profiles : [],
      intervalHours: cfg.intervalHours || config.pollIntervalHours,
      batchIntervalHours: config.batchIntervalHours,
      privacyPing: true,
      storiesEnabled: providerOffers(stack, FEATURE.STORIES),
      cronMode: !!config.cronMode,
      budgetMode: stack.costManager.mode(),
      killSwitch: stack.costManager.killSwitch(),
      throttleFactor: Number.isFinite(throttle) ? throttle : null,
      lastPollAt: cfg.lastPollAt,
      lastPollStatus: cfg.lastPollStatus,
      lastPollError: cfg.lastPollError,
      nextPollAt: cfg.nextPollAt,
      totalSnapshots: cfg.totalSnapshots || 0,
      totalChanges: cfg.totalChanges || 0,
      retentionEnabled: cfg.retentionEnabled !== false,
      retentionDays: cfg.retentionDays || config.retentionDays,
      alertsEnabled: cfg.alertsEnabled !== false,
      summaryEnabled: cfg.summaryEnabled !== false,
      summaryHour: cfg.summaryHour || config.summaryHour,
      telegramEnabled: telegramConfigured(config),
      hfEnabled: hfEnabled(config),
      hfDataset: config.hfDataset || null,
      hfLastUploadAt: cfg.hfLastUploadAt || null,
      hfLastError: cfg.hfLastError || null,
    });
  });

  app.post('/api/setup', async (req, res) => {
    if (store.getPasswordHash()) {
      return res.status(400).json({ error: 'Password already set. Log in instead.' });
    }
    const { password } = req.body || {};
    if (!password || String(password).length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }
    const hash = await hashPassword(String(password));
    store.setPasswordHash(hash);
    res.setHeader('Set-Cookie', sessionCookie(issueToken(config.secret), config.secret));
    res.json({ ok: true });
  });

  app.post('/api/login', async (req, res) => {
    const { password } = req.body || {};
    const hash = store.getPasswordHash();
    if (!hash) {
      return res.status(400).json({ error: 'No password configured yet. Complete setup first.' });
    }
    const ok = await verifyPassword(String(password || ''), hash);
    if (!ok) {
      return res.status(401).json({ error: 'Wrong password.' });
    }
    res.setHeader('Set-Cookie', sessionCookie(issueToken(config.secret), config.secret));
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  });

  function normalizeUsername(input) {
    const username = String(input || '')
      .trim()
      .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
      .replace(/\/+$/, '')
      .replace(/^@/, '');
    return /^[a-zA-Z0-9._]{1,30}$/.test(username) ? username : null;
  }

  app.post('/api/config', requireAuth, (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.intervalHours === 'number') {
      const h = body.intervalHours;
      if (!(h >= 1 && h <= 168)) {
        return res.status(400).json({ error: 'intervalHours must be between 1 and 168.' });
      }
      patch.intervalHours = h;
    }
    if (typeof body.retentionEnabled === 'boolean') patch.retentionEnabled = body.retentionEnabled;
    if (typeof body.retentionDays === 'number') {
      const d = body.retentionDays;
      if (!(d >= 1 && d <= 365)) {
        return res.status(400).json({ error: 'retentionDays must be between 1 and 365.' });
      }
      patch.retentionDays = d;
    }
    if (typeof body.alertsEnabled === 'boolean') patch.alertsEnabled = body.alertsEnabled;
    if (typeof body.summaryEnabled === 'boolean') patch.summaryEnabled = body.summaryEnabled;
    if (typeof body.summaryHour === 'number') {
      const h = body.summaryHour;
      if (!(h >= 0 && h <= 23)) {
        return res.status(400).json({ error: 'summaryHour must be between 0 and 23.' });
      }
      patch.summaryHour = h;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    store.setConfig(patch);
    const cfg = store.getConfig();
    res.json({ ok: true, ...patch, intervalHours: patch.intervalHours ?? cfg.intervalHours });
  });

  app.post('/api/config/profiles', requireAuth, (req, res) => {
    const body = req.body || {};
    const username = normalizeUsername(body.username);
    if (!username) {
      return res.status(400).json({ error: 'Invalid Instagram username.' });
    }
    const added = store.addProfile(username, {
      backfill: typeof body.backfill === 'boolean' ? body.backfill : undefined,
      trackStories: typeof body.trackStories === 'boolean' ? body.trackStories : undefined,
    });
    if (!added) {
      return res.status(400).json({ error: `"${username}" is already tracked.` });
    }
    res.json({ ok: true, username, profiles: store.getProfiles() });
  });

  app.patch('/api/config/profiles/:username', requireAuth, (req, res) => {
    const username = normalizeUsername(req.params.username);
    if (!username) {
      return res.status(400).json({ error: 'Invalid Instagram username.' });
    }
    const body = req.body || {};
    const patch = {};
    if (typeof body.backfill === 'boolean') patch.backfill = body.backfill;
    if (typeof body.trackStories === 'boolean') patch.trackStories = body.trackStories;
    if (typeof body.intervalHours === 'number') {
      const h = body.intervalHours;
      if (!(h >= 1 && h <= 168)) {
        return res.status(400).json({ error: 'intervalHours must be between 1 and 168.' });
      }
      patch.intervalHours = h;
    } else if (body.intervalHours === null) {
      patch.intervalHours = null;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    const updated = store.updateProfile(username, patch);
    if (!updated) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    res.json({ ok: true, profile: updated });
  });

  app.post('/api/config/profiles/:username/rename', requireAuth, async (req, res) => {
    const oldUsername = normalizeUsername(req.params.username);
    const newUsername = normalizeUsername((req.body || {}).to);
    if (!oldUsername || !newUsername) {
      return res.status(400).json({ error: 'Invalid Instagram username.' });
    }
    const updated = store.renameProfile(oldUsername, newUsername);
    if (updated === null) return res.status(404).json({ error: 'Profile not found.' });
    if (updated === false) return res.status(400).json({ error: `"${newUsername}" is already tracked.` });
    if (hfEnabled(config)) {
      try {
        await deleteFromHF(config, store, oldUsername);
        await syncToHF(store, config);
      } catch (err) {
        console.warn(`[hf] rename sync failed: ${err.message}`);
      }
    }
    res.json({ ok: true, username: newUsername, profile: updated });
  });

  app.delete('/api/config/profiles/:username', requireAuth, async (req, res) => {
    const username = normalizeUsername(req.params.username);
    if (!username) {
      return res.status(400).json({ error: 'Invalid Instagram username.' });
    }
    store.removeProfile(username);
    if (hfEnabled(config)) {
      try {
        await deleteFromHF(config, store, username);
      } catch (err) {
        console.warn(`[hf] delete sync failed: ${err.message}`);
      }
    }
    res.json({ ok: true, username, profiles: store.getProfiles() });
  });

  /**
   * The cron endpoint. One hit performs the entire cycle in-request —
   * fetch → diff → persist → alert → back up — because on a free host that
   * sleeps there is no reliable background timer to defer the work to. Returns
   * 409 while another run holds the lock rather than starting a second one.
   */
  let pollHistory = [];

  app.post('/api/poll', requirePollAccess, async (req, res) => {
    try {
      const now = Date.now();
      pollHistory = pollHistory.filter(t => now - t < 60000);
      if (pollHistory.length >= 2) {
        return res.status(429).json({ ok: false, error: 'Rate limit exceeded: max 2 polls per minute. Please wait.' });
      }
      pollHistory.push(now);

      const force = req.query.force === '1' || req.query.force === 'true';
      const restore = req.query.restore === '1' || req.query.restore === 'true';
      const result = await runCronCycle(store, config, { force, restore, owner: 'http', lock: pollLock });
      if (result.busy) return res.status(409).json(result);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/config/providers', requireAuth, (req, res) => {
    const limits = stack.costManager.limits;
    const doc = store.readJson('usage.json', { providers: {} });
    const out = {};
    for (const [name, lim] of Object.entries(limits)) {
      if (name === 'apify' && !config.apifyToken) continue;
      if (name === 'rapidapi' && !config.rapidapi.key) continue;
      if (name === 'brightdata' && !config.brightdata.apiKey) continue;
      if (name === 'lobstr' && !config.lobstr.apiKey) continue;
      if (name === 'llm' && !process.env.ANTHROPIC_AUTH_TOKEN) continue;
      
      const usageUnits = doc.providers[name]?.month?.units || 0;
      out[name] = {
        monthlyUnits: lim.monthlyUnits,
        resetDay: lim.resetDay || 1,
        startDate: lim.startDate || "",
        endDate: lim.endDate || "",
        currentUsage: usageUnits
      };
    }
    res.json(out);
  });

  app.post('/api/config/providers/:provider', requireAuth, async (req, res) => {
    try {
      const provider = req.params.provider;
      const { monthlyUnits, resetDay, startDate, endDate, currentUsage } = req.body;
      
      store.updateConfig((cfg) => {
        cfg.providerLimits = cfg.providerLimits || {};
        cfg.providerLimits[provider] = cfg.providerLimits[provider] || {};
        if (monthlyUnits !== undefined) cfg.providerLimits[provider].monthlyUnits = Number(monthlyUnits);
        if (resetDay !== undefined) cfg.providerLimits[provider].resetDay = Number(resetDay);
        if (startDate !== undefined) cfg.providerLimits[provider].startDate = startDate;
        if (endDate !== undefined) cfg.providerLimits[provider].endDate = endDate;
        return cfg;
      });

      if (currentUsage !== undefined) {
        stack.costManager.repo.update((doc) => {
          const now = new Date();
          const state = stack.costManager.repo.providerState(doc, provider, now);
          state.month.units = Number(currentUsage);
          return doc;
        });
      }

      const { buildLimits } = await import('./cost/cost-manager.js');
      stack.costManager.limits = buildLimits({
        ...config, 
        providerLimits: { ...config.providerLimits, ...store.getConfig().providerLimits }
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Cost/quota dashboard payload (PRD 406–427). */
  app.get('/api/usage', requireAuth, (req, res) => {
    res.json(stack.costManager.snapshot());
  });

  /**
   * Budget controls: switch mode, or hit the kill switch to stop every external
   * API call while leaving the dashboard fully usable (PRD 390–403).
   */
  app.post('/api/budget', requireAuth, (req, res) => {
    const body = req.body || {};
    const applied = {};
    if (body.mode !== undefined) {
      if (!Object.values(MODE).includes(body.mode)) {
        return res.status(400).json({ error: `mode must be one of ${Object.values(MODE).join(', ')}` });
      }
      stack.costManager.setMode(body.mode);
      applied.mode = body.mode;
    }
    if (typeof body.killSwitch === 'boolean') {
      stack.costManager.setKillSwitch(body.killSwitch);
      applied.killSwitch = body.killSwitch;
    }
    if (Object.keys(applied).length === 0) {
      return res.status(400).json({ error: 'Nothing to update. Send { mode } and/or { killSwitch }.' });
    }
    res.json({ ok: true, ...applied, usage: stack.costManager.snapshot() });
  });

  /** Manual circuit reset, for when a provider is known to be back. */
  app.post('/api/providers/:name/reset', requireAuth, (req, res) => {
    const name = String(req.params.name || '');
    if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return res.status(400).json({ error: 'Invalid provider name.' });
    stack.breaker.reset(name);
    res.json({ ok: true, provider: name, usage: stack.costManager.snapshot() });
  });

  app.get('/api/data/usage', requireAuth, async (req, res) => {
    const cfg = store.getConfig();
    const profiles = [];
    for (const p of cfg.profiles || []) {
      let bytes = 0;
      let files = 0;
      try {
        for (const f of await store.listMedia(p.username)) {
          bytes += f.bytes;
          files += 1;
        }
      } catch {
        /* ignore */
      }
      profiles.push({ username: p.username, files, bytes });
    }
    const totalBytes = profiles.reduce((sum, p) => sum + p.bytes, 0);
    const totalFiles = profiles.reduce((sum, p) => sum + p.files, 0);
    res.json({ profiles, totalBytes, totalFiles });
  });

  app.post('/api/data/cleanup', requireAuth, async (req, res) => {
    try {
      const result = await cleanupOldMedia(store, config);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/backup', requireAuth, (req, res) => {
    const archive = buildBackupArchive(store);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="instagram-monitor-${new Date().toISOString().slice(0, 10)}.zip"`);
    archive.pipe(res);
    archive.on('error', () => res.destroy());
  });

  app.get('/api/backup/:username', requireAuth, (req, res) => {
    const username = normalizeUsername(req.params.username);
    if (!username) return res.status(400).json({ error: 'Invalid Instagram username.' });
    const archive = buildBackupArchive(store, { username });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${username}-backup.zip"`);
    archive.pipe(res);
    archive.on('error', () => res.destroy());
  });

  app.post('/api/hf/sync', requireAuth, async (req, res) => {
    if (!hfEnabled(config)) {
      return res.status(400).json({ error: 'HF not configured. Set HF_TOKEN and HF_DATASET.' });
    }
    try {
      const r = await syncToHF(store, config);
      store.mute(() => {
        const cfg = store.getConfig();
        store.setConfig({
          hfLastUploadAt: r.ok ? new Date().toISOString() : cfg.hfLastUploadAt || null,
          hfLastError: r.ok ? null : (r.errors || []).join('; ') || null,
        });
      });
      res.json({ ok: true, uploaded: r.uploaded, errors: r.errors });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/alerts/test', requireAuth, async (req, res) => {
    if (!telegramConfigured(config)) {
      return res.status(400).json({ error: 'Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_IDS.' });
    }
    const r = await sendTelegram(config, '[Instagram Monitor] Test message — Telegram alerts are working.');
    res.json({ ok: r.ok, results: r.results });
  });

  app.get('/api/media/all', requireAuth, async (req, res) => {
    const items = [];
    try {
      for (const f of await store.listMedia()) {
        if (!isSafeMediaPath(f.username, f.name)) continue;
        items.push({
          username: f.username,
          file: f.name,
          kind: f.name.startsWith('avatar-') ? 'avatar' : f.name.startsWith('story-') ? 'story' : 'post',
          size: f.bytes,
          mtime: f.mtimeMs,
          url: `/api/media/${encodeURIComponent(f.username)}/${encodeURIComponent(f.name)}`,
        });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    items.sort((a, b) => b.mtime - a.mtime);
    res.json({ items });
  });

  app.get('/api/history', requireAuth, (req, res) => {
    const h = store.getHistory();
    res.json(h);
  });

  app.get('/api/history/:username', requireAuth, (req, res) => {
    const h = store.getHistory();
    const list = h.profiles[req.params.username] || [];
    res.json({ username: req.params.username, snapshots: list });
  });

  app.get('/api/media/:username/:file', requireAuth, async (req, res) => {
    const { username, file } = req.params;
    if (!isSafeMediaPath(username, file)) {
      return res.status(400).json({ error: 'Invalid path.' });
    }
    try {
      const bytes = await store.getMedia(username, file);
      if (!bytes) return res.status(404).json({ error: 'File not found.' });
      res.setHeader('Content-Type', mediaContentType(file));
      // Content is immutable: the file name is a hash of the bytes.
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      res.end(Buffer.from(bytes));
    } catch {
      res.status(404).json({ error: 'File not found.' });
    }
  });

  return app;
}

export async function main() {
  const config = loadConfig();
  const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  let store;
  if (useSupabase) {
    // Dynamic import to avoid loading Supabase in fs-only mode
    const { SupabaseStore } = await import('./stores/supabase-store.js');
    store = new SupabaseStore({
      url: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_BUCKET || 'media',
    });
  } else {
    store = new Store(config.dataDir);
  }

  try {
    const restored = await Promise.race([
      restoreFromHF(config, store),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, skipped: true, reason: 'timeout' }), 120000)),
    ]);
    if (!restored.skipped) {
      console.log(`[restore] ${restored.restored} file(s) restored from HF${restored.errors?.length ? ` (${restored.errors.length} failed)` : ''}`);
    }
  } catch (err) {
    console.warn(`[restore] failed: ${err.message}`);
  }

  const baseApp = createApp({ config, store });
  let app = baseApp;

  // For Supabase, we must wrap every request in a serialized hydrate/flush cycle
  if (useSupabase) {
    let chain = Promise.resolve();
    const serialise = (fn) => {
      const next = chain.then(fn, fn);
      chain = next.then(() => {}, () => {});
      return next;
    };

    app = express();
    app.use((req, res, next) => {
      serialise(async () => {
        await store.hydrate();
        const done = new Promise((resolve) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; resolve(); } };
          res.on('finish', finish);
          res.on('close', finish);
        });
        baseApp(req, res, next);
        await done;
        try { await store.flush(); } catch (e) { console.error(`[db] flush failed: ${e.message}`); }
      });
    });
  }

  const pollLock = useSupabase 
    ? new (await import('./stores/supabase-lock.js')).SupabasePollLock(store.rest, { staleMs: (config.pollLockStaleMinutes ?? 20) * 60 * 1000 })
    : null;

  schedule(config, store, {
    keepAlive: true,
    onPoll: async (s, c) => {
      if (useSupabase) await store.hydrate();
      const result = await runCronCycle(s, c, { owner: 'internal-scheduler', lock: pollLock });
      if (useSupabase) await store.flush();
      return result;
    },
  });

  if (!useSupabase) {
    await cleanupOldMedia(store, config);
    setInterval(() => {
      cleanupOldMedia(store, config)
        .then((r) => {
          if (!r.skipped && r.deleted > 0) {
            console.log(`[retention] removed ${r.deleted} file(s), freed ${(r.freedBytes / 1024 / 1024).toFixed(2)} MB`);
          }
        })
        .catch((err) => console.warn(`[retention] failed: ${err.message}`));
    }, 30 * 60 * 1000);
  }

  const server = app.listen(config.port, () => {
    console.log(`Instagram Monitor listening on http://localhost:${config.port}`);
    if (useSupabase) console.log(`Connected to Supabase DB (${process.env.SUPABASE_URL})`);
    if (config.cronMode) {
      console.log('Cron mode: polling only happens when POST /api/poll is triggered externally.');
    } else {
      console.log(`Poll interval: every ${config.pollIntervalHours} hour(s)`);
    }
  });

  async function shutdown(signal) {
    console.log(`\n[system] Received ${signal}, starting graceful shutdown...`);
    if (baseApp.syncDebouncer) {
      console.log('[hf] Flushing pending data to dataset before exit...');
      await baseApp.syncDebouncer.flush();
      console.log('[hf] Sync complete.');
    }
    server.close(() => {
      console.log('[system] Server stopped.');
      process.exit(0);
    });
    // Force exit if hanging
    setTimeout(() => {
      console.error('[system] Force exiting after 15s timeout.');
      process.exit(1);
    }, 15000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// pathToFileURL, not `file://${argv[1]}`: on Windows argv[1] is a backslashed
// drive path, so the naive template never matches import.meta.url and the
// server would exit silently without ever calling main().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
