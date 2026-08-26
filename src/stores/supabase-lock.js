/**
 * Postgres-backed poll lock — the Supabase counterpart to the O_EXCL lock file
 * in `poll-lock.js`.
 *
 * Same public surface (`acquire` / `release` / `withLock`) and same stale-break
 * semantics, so `cron-cycle.js` takes either one without knowing which. The
 * atomicity lives in the `try_acquire_poll_lock` SQL function: `select ... for
 * update` on the single lock row serialises concurrent cron hits, so two
 * overlapping runs can never both start a poll and spend provider quota twice.
 */
export class SupabasePollLock {
  constructor(rest, { staleMs = 20 * 60 * 1000, owner = 'poll' } = {}) {
    this.rest = rest;
    this.staleMs = staleMs;
    this.defaultOwner = owner;
    this.held = false;
    this.owner = null;
  }

  async acquire({ owner = this.defaultOwner } = {}) {
    // Owner must be unique per attempt, or a stale-broken predecessor sharing
    // the same name could release the new holder's lock on its way out.
    const stamped = `${owner}:${Math.random().toString(36).slice(2, 10)}`;
    const r = await this.rest.rpc('try_acquire_poll_lock', {
      p_owner: stamped,
      p_stale_seconds: Math.max(1, Math.round(this.staleMs / 1000)),
    });
    if (r?.ok) {
      this.held = true;
      this.owner = stamped;
      return { ok: true, info: { owner: stamped, startedAt: r.startedAt }, brokeStale: !!r.brokeStale, previous: r.previous || null, ageMs: r.ageMs ?? null };
    }
    return { ok: false, reason: r?.reason || 'locked', heldBy: r?.heldBy || null, ageMs: r?.ageMs ?? null };
  }

  async release() {
    if (!this.held) return false;
    try {
      await this.rest.rpc('release_poll_lock', { p_owner: this.owner });
    } catch {
      // Leaving the row behind is safe: it goes stale and is broken by the next
      // run. Throwing here would mask the poll's own result.
    }
    this.held = false;
    this.owner = null;
    return true;
  }

  async withLock(fn, opts = {}) {
    const got = await this.acquire(opts);
    if (!got.ok) return { acquired: false, ...got };
    try {
      const result = await fn();
      return { acquired: true, brokeStale: !!got.brokeStale, result };
    } finally {
      await this.release();
    }
  }
}
