import { CONFIG_FILE, PASSWORD_FILE, HISTORY_FILE, HF_MANIFEST_FILE } from '../config.js';

/**
 * Backend-agnostic state logic.
 *
 * Everything here is expressed in terms of four primitives that a subclass
 * provides: `readJson`, `writeJson`, and the media methods. `FsStore` backs them
 * with the local filesystem; `SupabaseStore` backs them with Postgres + Storage.
 *
 * WHY readJson/writeJson STAY SYNCHRONOUS: they are called from inside
 * `CostManager.canSpend()` / `record()` and `CircuitBreaker`, which are in turn
 * called from the middle of `ProviderRouter.call()`. Making them async would
 * force every one of those call sites to become async and would invalidate the
 * whole existing test suite. `SupabaseStore` therefore hydrates every document
 * once at the start of an invocation, serves reads from memory, and flushes the
 * mutated ones at the end — see that class for the trade-off this accepts.
 */
export class BaseStore {
  constructor() {
    this._changeListeners = new Set();
    this._silent = 0;
  }

  /* ---- primitives a subclass must provide ---- */

  readJson(_name, _fallback) {
    throw new Error(`${this.constructor.name} must implement readJson()`);
  }

  writeJson(_name, _value) {
    throw new Error(`${this.constructor.name} must implement writeJson()`);
  }

  /** @returns {Promise<boolean>} whether this exact file already exists. */
  async hasMedia(_username, _name) {
    return false;
  }

  async putMedia(_username, _name, _bytes) {
    throw new Error(`${this.constructor.name} must implement putMedia()`);
  }

  /** @returns {Promise<Uint8Array|null>} */
  async getMedia(_username, _name) {
    return null;
  }

  /** @returns {Promise<Array<{username:string,name:string,bytes:number,mtimeMs:number}>>} */
  async listMedia(_username = null) {
    return [];
  }

  async deleteMedia(_username, _name) {
    return false;
  }

  /** Hook for renameProfile; a no-op backend just keeps media under the old key. */
  async renameMedia(_oldUsername, _newUsername) {
    return false;
  }

  /* ---- lifecycle (Supabase-only, no-ops here) ---- */

  /**
   * These three exist so a caller can invoke them unconditionally on either
   * backend. `SupabaseStore` overrides all of them; a filesystem store needs no
   * hydrate/flush because its reads already hit durable storage, and it has
   * nowhere to record an avatar check.
   */
  async hydrate() {
    return 0;
  }

  async flush() {
    return 0;
  }

  async logAvatarCheck(_username, _hash, _changed) {
    return false;
  }

  /* ---- change notification ---- */

  /** Subscribes to state mutations. Returns an unsubscribe function. */
  onChange(cb) {
    this._changeListeners.add(cb);
    return () => this._changeListeners.delete(cb);
  }

  /** Runs a callback suppressing change notifications (used by sync internals). */
  mute(cb) {
    this._silent += 1;
    try {
      return cb();
    } finally {
      this._silent -= 1;
    }
  }

  _emitChange() {
    if (this._silent) return;
    for (const cb of this._changeListeners) {
      try {
        cb();
      } catch {
        /* listener errors are non-fatal */
      }
    }
  }

  /* ---- config / profiles ---- */

  getConfig() {
    const cfg = this.readJson(CONFIG_FILE, null);
    const defaults = {
      profiles: [],
      intervalHours: null,
      lastPollAt: null,
      lastPollStatus: 'idle',
      lastPollError: null,
      nextPollAt: null,
      totalSnapshots: 0,
      totalChanges: 0,
      retentionEnabled: true,
      retentionDays: 7,
      alertsEnabled: null,
      summaryEnabled: null,
      summaryHour: null,
      lastSummaryDate: null,
      hfLastUploadAt: null,
      hfLastError: null,
    };
    if (!cfg) return defaults;
    if (Array.isArray(cfg.profiles)) return { ...defaults, ...cfg };
    const migrated = { ...defaults, ...cfg };
    if (cfg.username) {
      migrated.profiles = [this._normalizeProfileEntry({ username: cfg.username, addedAt: cfg.addedAt || null })];
    }
    delete migrated.username;
    delete migrated.addedAt;
    this.writeJson(CONFIG_FILE, migrated);
    return migrated;
  }

  _normalizeProfileEntry(entry) {
    return {
      username: entry.username,
      addedAt: entry.addedAt || new Date().toISOString(),
      backfill: entry.backfill !== undefined ? !!entry.backfill : true,
      trackStories: entry.trackStories !== undefined ? !!entry.trackStories : true,
      isPrivate: entry.isPrivate ?? null,
      batchIntervalHours: entry.batchIntervalHours ?? null,
      intervalHours: entry.intervalHours ?? null,
      lastPolledAt: entry.lastPolledAt || null,
      seenStories: Array.isArray(entry.seenStories) ? entry.seenStories : [],
    };
  }

  addProfile(username, opts = {}) {
    const cfg = this.getConfig();
    const profiles = cfg.profiles || [];
    if (profiles.some((p) => p.username === username)) return false;
    const entry = this._normalizeProfileEntry({
      username,
      addedAt: new Date().toISOString(),
      backfill: opts.backfill,
      trackStories: opts.trackStories,
      intervalHours: opts.intervalHours,
    });
    profiles.push(entry);
    this.setConfig({ profiles });
    return true;
  }

  updateProfile(username, patch) {
    const cfg = this.getConfig();
    const profiles = (cfg.profiles || []).map((p) => (p.username === username ? this._normalizeProfileEntry({ ...p, ...patch }) : p));
    this.setConfig({ profiles });
    return profiles.find((p) => p.username === username) || null;
  }

  removeProfile(username) {
    const cfg = this.getConfig();
    const profiles = (cfg.profiles || []).filter((p) => p.username !== username);
    this.setConfig({ profiles });
  }

  /**
   * Renames in config and history. Media is moved by the backend's
   * `renameMedia` hook, which is fire-and-forget: a failed move leaves orphaned
   * files but must not fail the rename, since config and history are already
   * consistent.
   */
  renameProfile(oldUsername, newUsername) {
    const cfg = this.getConfig();
    const target = (cfg.profiles || []).find((p) => p.username === oldUsername);
    if (!target) return null;
    if ((cfg.profiles || []).some((p) => p.username === newUsername)) return false;
    const profiles = (cfg.profiles || []).map((p) => (p.username === oldUsername ? { ...p, username: newUsername } : p));
    this.setConfig({ profiles });

    this.renameMedia(oldUsername, newUsername)?.catch?.(() => {});

    const h = this.getHistory();
    if (h.profiles[oldUsername]) {
      h.profiles[newUsername] = h.profiles[oldUsername];
      delete h.profiles[oldUsername];
      this.setHistory(h);
    }

    return profiles.find((p) => p.username === newUsername) || null;
  }

  getProfiles() {
    return this.getConfig().profiles || [];
  }

  setConfig(patch) {
    const cfg = { ...this.getConfig(), ...patch };
    this.writeJson(CONFIG_FILE, cfg);
    this._emitChange();
    return cfg;
  }

  /* ---- other documents ---- */

  getHfManifest() {
    return this.readJson(HF_MANIFEST_FILE, {});
  }

  setHfManifest(manifest) {
    this.writeJson(HF_MANIFEST_FILE, manifest);
    this._emitChange();
  }

  getPasswordHash() {
    const v = this.readJson(PASSWORD_FILE, null);
    return v ? v.hash : null;
  }

  setPasswordHash(hash) {
    this.writeJson(PASSWORD_FILE, { hash, setAt: new Date().toISOString() });
    this._emitChange();
  }

  getHistory() {
    return this.readJson(HISTORY_FILE, { profiles: {} });
  }

  setHistory(h) {
    this.writeJson(HISTORY_FILE, h);
    this._emitChange();
  }

  saveSnapshot(username, snapshot) {
    const h = this.getHistory();
    const list = h.profiles[username] || [];
    list.push(snapshot);
    h.profiles[username] = list;
    this.setHistory(h);
  }
}

/** File names carry their own extension, so the type is derivable everywhere. */
const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * Shared by `SupabaseStore.putMedia` (which must label the Storage object) and
 * by the Express media route (which no longer has `res.sendFile` to infer it).
 */
export function mediaContentType(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}
