import { BaseStore, mediaContentType } from './base-store.js';
import { SupabaseRest } from './supabase-client.js';
import { CONFIG_FILE, PASSWORD_FILE, HISTORY_FILE, HF_MANIFEST_FILE, USAGE_FILE } from '../config.js';

/** Every JSON document the monitor persists. One `app_state` row each. */
export const STATE_DOCUMENTS = [CONFIG_FILE, PASSWORD_FILE, HISTORY_FILE, HF_MANIFEST_FILE, USAGE_FILE];

/**
 * Postgres + Storage backing, for the Edge Function and the Vercel API.
 *
 * THE HYDRATE / RUN / FLUSH CONTRACT
 *
 * `readJson` and `writeJson` must stay synchronous, because they are reached
 * from inside `CostManager.canSpend()` and `CircuitBreaker` — which are called
 * from the middle of `ProviderRouter.call()`. So an invocation is:
 *
 *   await store.hydrate()   // one request, all documents
 *   ...existing sync logic, unchanged...
 *   await store.flush()     // one request, only mutated documents
 *
 * Reads return live references rather than clones. That is deliberate: cloning
 * `history.json` on every read would burn the Edge Function's 2s CPU budget for
 * no benefit, and every mutation site in this codebase already pairs its
 * read-modify with an explicit setter (`setHistory`, `setConfig`, ...), which is
 * what marks the document dirty.
 *
 * ACCEPTED LIMITATION: a dashboard write landing mid-poll can be overwritten by
 * the flush, since flushing is per-document, not per-field. The poll lock
 * serialises polls against each other; a concurrent dashboard edit of the same
 * document is the remaining window.
 */
export class SupabaseStore extends BaseStore {
  constructor({ url, serviceKey, bucket = 'media', fetcher, rest, table = 'app_state' } = {}) {
    super();
    this.rest = rest || new SupabaseRest({ url, serviceKey, bucket, fetcher });
    this.table = table;
    /** There is no local media tree; fs-native callers must check for this. */
    this.mediaDir = null;
    this._docs = new Map();
    this._dirty = new Set();
    this._hydrated = false;
    /** username -> Set<fileName>, so `hasMedia` costs one list per account. */
    this._mediaIndex = new Map();
  }

  /* ---- lifecycle ---- */

  async hydrate(names = STATE_DOCUMENTS) {
    const list = names.map((n) => `"${n}"`).join(',');
    const rows = (await this.rest.select(this.table, `key=in.(${list})&select=key,value`)) || [];
    this._docs = new Map(rows.map((r) => [r.key, r.value]));
    this._dirty.clear();
    this._hydrated = true;
    return this._docs.size;
  }

  async flush() {
    if (!this._dirty.size) return 0;
    const now = new Date().toISOString();
    const rows = [...this._dirty].map((key) => ({ key, value: this._docs.get(key) ?? null, updated_at: now }));
    await this.rest.upsert(this.table, rows, { onConflict: 'key' });
    const written = this._dirty.size;
    this._dirty.clear();
    return written;
  }

  get dirtyDocuments() {
    return [...this._dirty];
  }

  /* ---- sync primitives ---- */

  readJson(name, fallback) {
    if (!this._hydrated) {
      // Fail loudly: a silent fallback here would look like "no profiles
      // configured" and the poll would quietly do nothing forever.
      throw new Error(`SupabaseStore.readJson(${name}) before hydrate()`);
    }
    const v = this._docs.get(name);
    return v === undefined || v === null ? fallback : v;
  }

  writeJson(name, value) {
    this._docs.set(name, value);
    this._dirty.add(name);
  }

  /* ---- media (Supabase Storage) ---- */

  _key(username, name) {
    return `${username}/${name}`;
  }

  async _index(username) {
    if (this._mediaIndex.has(username)) return this._mediaIndex.get(username);
    const objects = await this.rest.listObjects(`${username}/`);
    const set = new Set(objects.map((o) => o.name).filter(Boolean));
    this._mediaIndex.set(username, set);
    return set;
  }

  async hasMedia(username, name) {
    return (await this._index(username)).has(name);
  }

  async putMedia(username, name, bytes, { contentType } = {}) {
    await this.rest.putObject(this._key(username, name), bytes, { contentType: contentType || mediaContentType(name) });
    (await this._index(username)).add(name);
    return name;
  }

  async getMedia(username, name) {
    return this.rest.getObject(this._key(username, name));
  }

  async listMedia(username = null) {
    const out = [];
    const users = username ? [username] : await this._mediaUsers();
    for (const user of users) {
      for (const o of await this.rest.listObjects(`${user}/`)) {
        if (!o?.name) continue;
        out.push({
          username: user,
          name: o.name,
          bytes: Number(o.metadata?.size) || 0,
          mtimeMs: Date.parse(o.updated_at || o.created_at || '') || 0,
        });
      }
    }
    return out;
  }

  /** Listing the bucket root yields one pseudo-folder entry per account. */
  async _mediaUsers() {
    const roots = await this.rest.listObjects('');
    return roots.map((o) => o?.name).filter((n) => n && !n.includes('.'));
  }

  async deleteMedia(username, name) {
    await this.rest.removeObjects([this._key(username, name)]);
    this._mediaIndex.get(username)?.delete(name);
    return true;
  }

  /**
   * Storage has no directory rename, so every object is moved individually.
   * Called fire-and-forget by `renameProfile`; a partial move leaves orphans
   * under the old prefix but never fails the rename.
   */
  async renameMedia(oldUsername, newUsername) {
    const objects = await this.rest.listObjects(`${oldUsername}/`);
    let moved = 0;
    for (const o of objects) {
      if (!o?.name) continue;
      try {
        await this.rest.moveObject(this._key(oldUsername, o.name), this._key(newUsername, o.name));
        moved += 1;
      } catch {
        /* keep going; one failure must not abort the rest */
      }
    }
    this._mediaIndex.delete(oldUsername);
    this._mediaIndex.delete(newUsername);
    return moved > 0;
  }

  /**
   * The "log the check, don't duplicate the bytes" decision: an unchanged
   * avatar records that it was verified, so the 2-hourly private-account check
   * leaves an audit trail without consuming Storage on identical images.
   */
  async logAvatarCheck(username, hash, changed = false) {
    await this.rest.insert('avatar_checks', { username, hash, changed: !!changed });
    return true;
  }

  /** Signed URL for direct browser fetches; the bucket itself stays private. */
  getMediaUrl(username, name, expiresIn = 3600) {
    return this.rest.signObject(this._key(username, name), expiresIn);
  }
}
