import fs from 'node:fs';
import path from 'node:path';

/**
 * Cross-process poll lock.
 *
 * Without this, the in-process scheduler and the external cron can enter
 * `poll()` simultaneously and spend quota twice for the same work — the exact
 * "duplicate requests" failure the PRD calls out. Overlapping GitHub Actions
 * runs (a slow poll still running when the next hour fires) hit the same race.
 *
 * Implemented with an atomic O_EXCL create, so acquisition is a single
 * filesystem operation rather than a check-then-write. A lock older than
 * `staleMs` is treated as abandoned (the host was killed mid-poll — routine on
 * a free tier that shuts instances down) and is broken.
 */

export const DEFAULT_STALE_MS = 20 * 60 * 1000;

export class PollLock {
  constructor(dataDir, { file = 'poll.lock', staleMs = DEFAULT_STALE_MS } = {}) {
    this.path = path.join(dataDir, file);
    this.staleMs = staleMs;
    this.held = false;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Attempts to take the lock.
   * @returns {{ok:true, info:object}|{ok:false, reason:string, heldBy:object|null, ageMs:number|null}}
   */
  acquire({ now = Date.now(), owner = 'poll' } = {}) {
    const info = {
      owner,
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
      host: process.env.HOSTNAME || process.env.COMPUTERNAME || null,
    };
    const payload = JSON.stringify(info);

    try {
      // 'wx' fails if the file exists — atomic acquire.
      fs.writeFileSync(this.path, payload, { flag: 'wx' });
      this.held = true;
      return { ok: true, info };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const existing = this.read();
    const startedAt = existing?.startedAt ? Date.parse(existing.startedAt) : null;
    const ageMs = startedAt ? now - startedAt : null;

    // Unparseable or undated lock file: treat as stale rather than deadlocking.
    if (ageMs == null || ageMs >= this.staleMs) {
      try {
        fs.writeFileSync(this.path, payload);
        this.held = true;
        return { ok: true, info, brokeStale: true, previous: existing, ageMs };
      } catch {
        return { ok: false, reason: 'stale_break_failed', heldBy: existing, ageMs };
      }
    }
    return { ok: false, reason: 'locked', heldBy: existing, ageMs };
  }

  release() {
    if (!this.held) return false;
    try {
      fs.unlinkSync(this.path);
    } catch {
      /* already gone */
    }
    this.held = false;
    return true;
  }

  /** Runs `fn` under the lock, always releasing. Returns null when not acquired. */
  async withLock(fn, opts = {}) {
    const got = this.acquire(opts);
    if (!got.ok) return { acquired: false, ...got };
    try {
      const result = await fn();
      return { acquired: true, brokeStale: !!got.brokeStale, result };
    } finally {
      this.release();
    }
  }
}
