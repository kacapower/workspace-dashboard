import { USAGE_FILE } from '../config.js';

/**
 * Single persisted document holding all cost / health / circuit state.
 *
 * WHY PERSISTED: the monitor is designed to be driven by an external cron
 * (GitHub Actions, pg_cron, ...) because free hosts sleep. Every cron hit is a
 * FRESH PROCESS, so in-memory counters, health scores and circuit breakers
 * would reset on every invocation and enforce nothing. All of it lives here.
 *
 * Shape:
 *   {
 *     version, killSwitch, mode,
 *     providers: {
 *       apify: {
 *         day:   { date: '2026-08-24', requests, units, costUsd, errors },
 *         month: { month: '2026-08',   requests, units, costUsd, errors },
 *         features: { profile: { requests, units }, ... },
 *         health: { success, failure, consecutiveFailures, lastSuccessAt, lastFailureAt, latencyMsAvg },
 *         circuit: { state, openedAt, halfOpenAt, trippedCount }
 *       }
 *     }
 *   }
 *
 * Writes go through Store so this swaps to Supabase later without callers
 * changing.
 */

export function dayKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function monthKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 7);
}

export function emptyWindow(key, keyName) {
  return { [keyName]: key, requests: 0, units: 0, costUsd: 0, errors: 0 };
}

export function emptyProviderState(now = new Date()) {
  return {
    day: emptyWindow(dayKey(now), 'date'),
    month: emptyWindow(monthKey(now), 'month'),
    features: {},
    health: {
      success: 0,
      failure: 0,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      latencyMsAvg: null,
    },
    circuit: { state: 'closed', openedAt: null, halfOpenAt: null, trippedCount: 0 },
  };
}

export class UsageRepo {
  constructor(store, { file = USAGE_FILE } = {}) {
    this.store = store;
    this.file = file;
  }

  read() {
    const doc = this.store.readJson(this.file, null) || {};
    return {
      version: 1,
      killSwitch: false,
      mode: null,
      ...doc,
      providers: { ...(doc.providers || {}) },
    };
  }

  write(doc) {
    this.store.writeJson(this.file, doc);
    return doc;
  }

  /** Read-modify-write. The mutator may return a doc or mutate in place. */
  update(mutator) {
    const doc = this.read();
    const next = mutator(doc) || doc;
    return this.write(next);
  }

  /**
   * Returns the provider's state, rolling the day/month windows over when the
   * calendar has moved on. Mutates `doc` so callers can persist once.
   */
  providerState(doc, name, now = new Date()) {
    if (!doc.providers[name]) doc.providers[name] = emptyProviderState(now);
    const p = doc.providers[name];

    // Backfill any shape added after this document was first written.
    const blank = emptyProviderState(now);
    p.day = { ...blank.day, ...(p.day || {}) };
    p.month = { ...blank.month, ...(p.month || {}) };
    p.features = p.features || {};
    p.health = { ...blank.health, ...(p.health || {}) };
    p.circuit = { ...blank.circuit, ...(p.circuit || {}) };

    const today = dayKey(now);
    const thisMonth = monthKey(now);
    if (p.day.date !== today) p.day = emptyWindow(today, 'date');
    if (p.month.month !== thisMonth) p.month = emptyWindow(thisMonth, 'month');
    return p;
  }
}
