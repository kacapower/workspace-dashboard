import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HF_API = 'https://huggingface.co';
const LFS_HEADERS = {
  Accept: 'application/vnd.git-lfs+json',
  'Content-Type': 'application/vnd.git-lfs+json',
};
const SAMPLE_SIZE = 512;

export function hfEnabled(config) {
  return !!config.hfToken && !!config.hfDataset;
}

function authHeaders(config) {
  return { Authorization: `Bearer ${config.hfToken}` };
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* keep null */
    }
    throw new Error(`${res.status}: ${body?.error || res.statusText}`);
  }
  return res.json();
}

export async function ensureRepo(config) {
  const info = await fetch(`${HF_API}/api/datasets/${config.hfDataset}`, {
    headers: authHeaders(config),
  });
  if (info.status === 200) return { created: false };
  if (info.status !== 404) throw new Error(`HF repo check failed (${info.status})`);
  const res = await fetch(`${HF_API}/api/repos`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: config.hfDataset, type: 'dataset', private: true }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`HF repo create failed (${res.status}): ${body?.error || ''}`);
  }
  return { created: true };
}

function fileInfo(buf) {
  return {
    size: buf.length,
    sample: buf.subarray(0, SAMPLE_SIZE).toString('base64'),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/** Asks the hub whether each path must be uploaded as LFS or regular content. */
async function preupload(config, files) {
  return fetchJson(`${HF_API}/api/datasets/${config.hfDataset}/preupload/main`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: files.map((f) => ({ path: f.path, sample: f.sample, size: f.size })),
    }),
  });
}

/** Uploads an LFS-tracked blob (git-lfs basic transfer). No-op if content already exists. */
async function lfsUpload(config, sha256Hex, buf) {
  const batch = await fetchJson(`${HF_API}/datasets/${config.hfDataset}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { ...authHeaders(config), ...LFS_HEADERS },
    body: JSON.stringify({
      operation: 'upload',
      transfers: ['basic'],
      hash_algo: 'sha256',
      ref: { name: 'main' },
      objects: [{ oid: sha256Hex, size: buf.length }],
    }),
  });
  const obj = batch.objects?.[0];
  if (!obj) throw new Error('LFS batch returned no object');
  if (obj.error) throw new Error(`LFS: ${obj.error.message || JSON.stringify(obj.error)}`);
  const action = obj.actions?.upload;
  if (!action) return; // blob already present upstream
  const put = await fetch(action.href, { method: 'PUT', body: buf });
  if (!put.ok) throw new Error(`LFS PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
  if (obj.actions?.verify) {
    const ver = await fetch(obj.actions.verify.href, {
      method: 'POST',
      headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({ oid: sha256Hex, size: buf.length }),
    });
    if (!ver.ok) throw new Error(`LFS verify ${ver.status}`);
  }
}

/** POSTs newline-delimited JSON operations to the commit endpoint. */
async function commitNDJSON(config, entries, title) {
  const lines = [
    JSON.stringify({
      key: 'header',
      value: { summary: title || 'instagram-monitor sync', description: 'Automatic sync from Instagram Monitor' },
    }),
  ];
  for (const e of entries) lines.push(JSON.stringify(e));
  const res = await fetch(`${HF_API}/api/datasets/${config.hfDataset}/commit/main`, {
    method: 'POST',
    headers: { ...authHeaders(config), 'Content-Type': 'application/x-ndjson' },
    body: lines.join('\n') + '\n',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`commit ${res.status}: ${body?.error || ''}`);
  }
  return res.json();
}

const BATCH_MAX_BYTES = 4 * 1024 * 1024;
const BATCH_MAX_OPS = 20;

function chunkOperations(ops) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const o of ops) {
    if (cur.length && (size + o.buf.length > BATCH_MAX_BYTES || cur.length >= BATCH_MAX_OPS)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(o);
    size += o.buf.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function commitBatch(config, batch, title) {
  const info = batch.map((o) => ({ path: o.path, ...fileInfo(o.buf) }));
  const meta = await preupload(config, info);
  const entries = [];
  for (const item of meta.files) {
    const op = batch.find((o) => o.path === item.path);
    if (item.shouldIgnore) continue; // identical content already at this path
    if (item.uploadMode === 'lfs') {
      const fi = fileInfo(op.buf);
      await lfsUpload(config, fi.sha256, op.buf);
      entries.push({ key: 'lfsFile', value: { path: op.path, algo: 'sha256', oid: fi.sha256, size: fi.size } });
    } else {
      entries.push({ key: 'file', value: { path: op.path, encoding: 'base64', content: op.buf.toString('base64') } });
    }
  }
  if (entries.length) await commitNDJSON(config, entries, title);
}

/**
 * Uploads the full local state as a `_meta` folder plus per-profile media:
 *   _meta/config.json  _meta/history.json  _meta/password.json
 *   _meta/hf-manifest.json  _meta/usage.json
 *   <user>/media/<files>
 * Media files already recorded in the manifest are skipped, so re-running is
 * cheap and acts as a retry for anything that failed earlier.
 *
 * usage.json carries the quota counters and circuit state. It MUST be backed up:
 * on an ephemeral disk a redeploy would otherwise reset the month's spend to
 * zero and the budget ceiling would stop meaning anything.
 */
export async function syncToHF(store, config) {
  if (!hfEnabled(config)) return { ok: false, skipped: true, reason: 'HF not configured (HF_TOKEN + HF_DATASET)' };
  await ensureRepo(config);

  const manifest = store.getHfManifest();
  const cfg = store.getConfig();
  const history = store.getHistory();
  const password = store.readJson('password.json', null);
  const usage = store.readJson('usage.json', null);
  const now = new Date().toISOString();
  const ops = [];
  let toUpload = 0;

  const metaFiles = {
    '_meta/config.json': cfg,
    '_meta/history.json': history,
    '_meta/password.json': password,
    '_meta/hf-manifest.json': manifest,
    ...(usage ? { '_meta/usage.json': usage } : {}),
  };
  for (const [rel, data] of Object.entries(metaFiles)) {
    ops.push({ path: rel, user: '_meta', rel, buf: Buffer.from(JSON.stringify(data, null, 2)) });
    toUpload += 1;
  }

  for (const p of cfg.profiles || []) {
    const user = p.username;
    if (!store.mediaDir) continue; // Skip local media sync if using abstract store
    const dir = path.join(store.mediaDir, user);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const rel = `media/${name}`;
      if (manifest[user] && manifest[user][rel]) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      ops.push({ path: `${user}/${rel}`, user, rel, buf: fs.readFileSync(full), mtime: stat.mtimeMs });
      toUpload += 1;
    }
  }

  const errors = [];
  let uploaded = 0;
  for (const batch of chunkOperations(ops)) {
    try {
      await commitBatch(config, batch, `instagram-monitor sync (${uploaded + 1}-${uploaded + batch.length})`);
      for (const o of batch) {
        (manifest[o.user] = manifest[o.user] || {})[o.rel] = { uploadedAt: now, mtime: o.mtime ?? null };
      }
      uploaded += batch.length;
    } catch (err) {
      errors.push(err.message);
    }
  }

  store.mute(() => store.setHfManifest(manifest));
  return { ok: errors.length === 0, uploaded, toUpload, errors };
}

/** Removes all files of a person's folder from the dataset (used on rename). */
export async function deleteFromHF(config, store, username) {
  if (!hfEnabled(config)) return { ok: false, skipped: true };
  const manifest = store.getHfManifest();
  const paths = Object.keys(manifest[username] || {}).map((rel) => `${username}/${rel}`);
  if (!paths.length) return { ok: true, deleted: 0 };
  const entries = paths.map((p) => ({ key: 'deletedFile', value: { path: p } }));
  const half = Math.ceil(entries.length / 2);
  for (let i = 0; i < entries.length; i += half) {
    await commitNDJSON(config, entries.slice(i, i + half), `remove folder for ${username}`);
  }
  delete manifest[username];
  store.setHfManifest(manifest);
  return { ok: true, deleted: paths.length };
}

function safeSegments(rel) {
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs.some((s) => s === '..' || s === '.' || s.includes('\\'))) return null;
  return segs;
}

async function downloadResolve(config, rel) {
  const res = await fetch(`${HF_API}/datasets/${config.hfDataset}/resolve/main/${rel}`, {
    headers: authHeaders(config),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`resolve ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty file');
  return buf;
}

/**
 * Pulls all backed-up state back into the local data dir. Intended for a
 * freshly-deployed (ephemeral-disk) instance so the gallery, profiles and
 * history survive redeploys. Layout mapping:
 *   _meta/config.json       -> config.json          (only when local has no activity)
 *   _meta/history.json      -> history.json         (only when local has no activity)
 *   _meta/password.json     -> password.json        (only when local has no password)
 *   _meta/hf-manifest.json  -> hf-manifest.json     (only when missing)
 *   <user>/media/<file>     -> media/<user>/<file>  (never overwrites existing)
 * Legacy per-user <user>/profile.json + <user>/history.json are honored only
 * when _meta files are absent (migration from older pushes).
 */
export async function restoreFromHF(config, store) {
  if (!hfEnabled(config)) return { ok: false, skipped: true, reason: 'HF not configured (HF_TOKEN + HF_DATASET)' };
  const res = await fetch(`${HF_API}/api/datasets/${config.hfDataset}/tree/main?recursive=1`, {
    headers: authHeaders(config),
  });
  if (res.status === 404) return { ok: true, skipped: true, reason: 'dataset empty' };
  if (!res.ok) throw new Error(`HF tree ${res.status}`);
  const items = await res.json();
  const files = (items || []).filter((i) => i.type === 'file' && !i.path.startsWith('.'));

  const errors = [];
  let restored = 0;

  const localCfg = store.getConfig();
  const localHistory = store.getHistory();
  const localHasActivity =
    (localCfg.profiles || []).length > 0 || !!localCfg.lastPollAt || (localCfg.totalSnapshots || 0) > 0;

  const stateFiles = {}; // localName -> hfPath
  const mediaFiles = []; // { path, user, name }
  const legacy = []; // { path, segs }

  for (const f of files) {
    const segs = safeSegments(f.path);
    if (!segs) continue;
    if (segs[0] === '_meta' && segs.length === 2 && segs[1].endsWith('.json')) {
      stateFiles[segs[1]] = f.path;
    } else if (segs.length >= 3 && segs[1] === 'media') {
      mediaFiles.push({ path: f.path, user: segs[0], name: segs.slice(2).join('/') });
    } else if (!stateFiles['config.json'] && segs.length >= 2 && (segs[1] === 'profile.json' || segs[1] === 'history.json')) {
      legacy.push({ path: f.path, segs });
    }
  }

  const write = (name, value) => store.writeJson(name, value);

  let manifest = null;
  if (stateFiles['hf-manifest.json']) {
    try {
      const raw = await downloadResolve(config, stateFiles['hf-manifest.json']);
      manifest = JSON.parse(raw.toString('utf8'));
      if (!fs.existsSync(store._file('hf-manifest.json'))) {
        write('hf-manifest.json', manifest);
        restored += 1;
      }
    } catch (err) {
      errors.push(`hf-manifest.json: ${err.message}`);
    }
  }

  // Quota counters and circuit state. Restored whenever the local file is
  // absent — independent of `localHasActivity`, because a fresh disk with no
  // usage.json means "this month's spend is unknown", and defaulting that to
  // zero would silently hand back a full budget on every redeploy.
  if (stateFiles['usage.json'] && !fs.existsSync(store._file('usage.json'))) {
    try {
      const raw = await downloadResolve(config, stateFiles['usage.json']);
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed && typeof parsed === 'object') {
        write('usage.json', parsed);
        restored += 1;
      }
    } catch (err) {
      errors.push(`usage.json: ${err.message}`);
    }
  }

  if (!localHasActivity) {
    for (const name of ['config.json', 'history.json', 'password.json']) {
      if (!stateFiles[name]) continue;
      if (name === 'password.json' && store.getPasswordHash()) continue;
      try {
        const raw = await downloadResolve(config, stateFiles[name]);
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed == null) continue;
        write(name, parsed);
        restored += 1;
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }

    if (!stateFiles['config.json'] && legacy.length) {
      const cfg = store.getConfig();
      const history = store.getHistory();
      let changed = false;
      for (const l of legacy) {
        try {
          const user = l.segs[0];
          if (l.segs[1] === 'profile.json' && !(cfg.profiles || []).some((p) => p.username === user)) {
            const entry = { username: user, ...JSON.parse((await downloadResolve(config, l.path)).toString('utf8')) };
            cfg.profiles.push(entry);
            changed = true;
            restored += 1;
          } else if (l.segs[1] === 'history.json' && !history.profiles[user]?.length) {
            history.profiles[user] = JSON.parse((await downloadResolve(config, l.path)).toString('utf8'));
            changed = true;
            restored += 1;
          }
        } catch (err) {
          errors.push(`${l.path}: ${err.message}`);
        }
      }
      if (changed) write('config.json', cfg);
      if (changed) write('history.json', history);
    }
  }

  for (const m of mediaFiles) {
    if (!store.mediaDir) continue; // Skip local media restore if using abstract store
    const dest = path.join(store.mediaDir, m.user, m.name);
    if (fs.existsSync(dest)) continue;
    try {
      const buf = await downloadResolve(config, m.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      const mt = manifest?.[m.user]?.[`media/${m.name}`]?.mtime;
      if (mt) {
        const d = new Date(mt);
        fs.utimesSync(dest, d, d);
      }
      restored += 1;
    } catch (err) {
      errors.push(`${m.path}: ${err.message}`);
    }
  }

  return { ok: errors.length === 0, restored, errors };
}

/**
 * Debounced sync scheduler. Listening to Store mutations is cheap; actual
 * uploads only run after activity quiets down (default 5 min) or on demand
 * via flush(). Concurrent flushes are serialized and any change that lands
 * during a flush triggers a follow-up run.
 */
export function createSyncDebouncer(config, store, { delayMs = 5 * 60 * 1000, sync = syncToHF } = {}) {
  let timer = null;
  let running = false;
  let pending = false;

  async function flush() {
    timer = null;
    running = true;
    try {
      const r = await sync(store, config);
      store.mute(() => {
        const cfg = store.getConfig();
        store.setConfig({
          hfLastUploadAt: r.ok ? new Date().toISOString() : cfg.hfLastUploadAt || null,
          hfLastError: r.ok ? null : (r.errors || []).join('; ') || null,
        });
      });
      if (!r.ok && (r.errors || []).length) {
        console.warn(`[sync] ${r.errors.length} file(s) failed to upload: ${r.errors.slice(0, 3).join(' | ')}`);
      }
    } catch (err) {
      store.mute(() => store.setConfig({ hfLastError: err.message }));
      console.warn(`[sync] failed: ${err.message}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (!hfEnabled(config)) return;
    if (running) {
      pending = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  }

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = false;
  }

  return { schedule, cancel, flush };
}