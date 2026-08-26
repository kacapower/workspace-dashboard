import { UsageRepo } from './usage-repo.js';

/**
 * Persisted circuit breaker (PRD 265–284).
 *
 * closed → (N consecutive provider-fault failures) → open
 * open   → (cooldown elapsed) → half_open
 * half_open → one trial request → success closes, failure re-opens
 *
 * State lives in the usage document, NOT in memory: with an external cron each
 * poll is a new process, so an in-memory breaker would forget it had tripped
 * and hammer a dead provider on every invocation.
 */

export const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

export const DEFAULTS = {
  failureThreshold: 3,
  cooldownMs: 15 * 60 * 1000,
};

export class CircuitBreaker {
  constructor(store, { repo = null, failureThreshold = DEFAULTS.failureThreshold, cooldownMs = DEFAULTS.cooldownMs } = {}) {
    this.repo = repo || new UsageRepo(store);
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
  }

  /**
   * Current status, applying the cooldown lazily so no background timer is
   * needed (there is no long-lived process to host one).
   * Returns `{ state, allowed, trial, retryAt }`.
   */
  status(provider, { now = new Date() } = {}) {
    const doc = this.repo.read();
    const state = this.repo.providerState(doc, provider, now);
    const c = state.circuit;
    const t = new Date(now).getTime();

    if (c.state === STATE.OPEN) {
      const openedAt = c.openedAt ? Date.parse(c.openedAt) : 0;
      const retryAt = openedAt + this.cooldownMs;
      if (t >= retryAt) {
        return { state: STATE.HALF_OPEN, allowed: true, trial: true, retryAt: null };
      }
      return { state: STATE.OPEN, allowed: false, trial: false, retryAt: new Date(retryAt).toISOString() };
    }
    if (c.state === STATE.HALF_OPEN) {
      return { state: STATE.HALF_OPEN, allowed: true, trial: true, retryAt: null };
    }
    return { state: STATE.CLOSED, allowed: true, trial: false, retryAt: null };
  }

  allows(provider, opts = {}) {
    return this.status(provider, opts).allowed;
  }

  onSuccess(provider, { now = new Date() } = {}) {
    this.repo.update((doc) => {
      const state = this.repo.providerState(doc, provider, now);
      state.circuit.state = STATE.CLOSED;
      state.circuit.openedAt = null;
      state.circuit.halfOpenAt = null;
      return doc;
    });
  }

  /**
   * Records a failure. `providerFault: false` (e.g. account not found) must not
   * count toward tripping — see ProviderError.providerFault.
   */
  onFailure(provider, { now = new Date(), providerFault = true } = {}) {
    if (!providerFault) return this.status(provider, { now });
    const iso = new Date(now).toISOString();
    this.repo.update((doc) => {
      const state = this.repo.providerState(doc, provider, now);
      const consecutive = state.health.consecutiveFailures || 0;
      const wasTrial = state.circuit.state === STATE.HALF_OPEN;
      if (wasTrial || consecutive >= this.failureThreshold) {
        state.circuit.state = STATE.OPEN;
        state.circuit.openedAt = iso;
        state.circuit.halfOpenAt = null;
        state.circuit.trippedCount = (state.circuit.trippedCount || 0) + 1;
      }
      return doc;
    });
    return this.status(provider, { now });
  }

  /** Manual reset, for the dashboard. */
  reset(provider, { now = new Date() } = {}) {
    this.onSuccess(provider, { now });
  }
}
