import { TIER_ORDER, ERROR_KIND, ProviderError, toProviderError } from './provider-interface.js';

/**
 * Provider router (PRD 237–261, 533–546).
 *
 * Picks the cheapest healthy provider that supports a feature, enforces the
 * cost manager's verdict before every external call, and books actual usage
 * afterwards. Fallback to a costlier provider is deliberately conservative: a
 * low-priority profile must not trigger paid usage just because a free provider
 * timed out.
 */

export const PRIORITY = { CRITICAL: 'critical', NORMAL: 'normal', LOW: 'low', ARCHIVE: 'archive' };

const PRIORITY_RANK = { [PRIORITY.CRITICAL]: 3, [PRIORITY.NORMAL]: 2, [PRIORITY.LOW]: 1, [PRIORITY.ARCHIVE]: 0 };

/** Only these priorities may escalate to a costlier provider after a failure. */
const FALLBACK_MIN_RANK = PRIORITY_RANK[PRIORITY.NORMAL];

export class NoProviderAvailableError extends Error {
  constructor(feature, attempts) {
    const detail = attempts.map((a) => `${a.provider}: ${a.reason}`).join('; ') || 'none configured';
    super(`No provider available for "${feature}" (${detail})`);
    this.name = 'NoProviderAvailableError';
    this.feature = feature;
    this.attempts = attempts;
  }
}

/**
 * Health score in [0,1]. Success rate dominates; a recent failure and slow
 * latency both drag it down so a flaky-but-open provider loses to a solid one.
 */
export function healthScore(health = {}) {
  const success = health.success || 0;
  const failure = health.failure || 0;
  const total = success + failure;
  const rate = total === 0 ? 0.75 : success / total; // unproven providers sit mid-pack
  const consecutivePenalty = Math.min(0.5, (health.consecutiveFailures || 0) * 0.2);
  const latency = health.latencyMsAvg;
  const latencyPenalty = latency == null ? 0 : Math.min(0.2, latency / 120000);
  return Math.max(0, Math.min(1, rate - consecutivePenalty - latencyPenalty));
}

export class ProviderRouter {
  constructor({ providers = [], costManager, breaker, logger = console }) {
    this.providers = providers;
    this.costManager = costManager;
    this.breaker = breaker;
    this.logger = logger;
  }

  register(provider) {
    this.providers.push(provider);
    return this;
  }

  /**
   * Providers that support `feature`, ordered cheapest-tier-first then by
   * health, each annotated with whether it may actually be used right now.
   */
  candidates(feature, { units = null, now = new Date() } = {}) {
    const snapshot = this.costManager.repo.read();
    const list = this.providers
      .filter((p) => p.supports(feature))
      .map((p) => {
        const state = this.costManager.repo.providerState(snapshot, p.name, now);
        const estimate = units ?? p.estimateUnits(feature);
        const circuit = this.breaker.status(p.name, { now });
        const spend = this.costManager.canSpend(p.name, feature, estimate, { now });
        let usable = true;
        let reason = null;
        if (!p.enabled) {
          usable = false;
          reason = 'provider_disabled';
        } else if (!circuit.allowed) {
          usable = false;
          reason = `circuit_${circuit.state}`;
        } else if (!spend.ok) {
          usable = false;
          reason = spend.reason;
        }
        return {
          provider: p,
          name: p.name,
          tier: p.tier,
          estimate,
          usable,
          reason,
          circuit,
          spend,
          score: healthScore(state.health),
        };
      });

    list.sort((a, b) => {
      const t = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      if (t !== 0) return t;
      return b.score - a.score;
    });
    return list;
  }

  /**
   * Whether to try the next (costlier) provider after a failure (PRD 533–546).
   */
  shouldFallback(err, { priority = PRIORITY.NORMAL, next }) {
    if (!next || !next.usable) return false;
    if (err instanceof ProviderError) {
      // Permanent, request-specific failures won't be fixed by another vendor.
      if (err.kind === ERROR_KIND.NOT_FOUND) return false;
      if (!err.retryable && err.kind !== ERROR_KIND.AUTH) return false;
    }
    const rank = PRIORITY_RANK[priority] ?? PRIORITY_RANK[PRIORITY.NORMAL];
    const escalatesCost = TIER_ORDER.indexOf(next.tier) > 0;
    if (escalatesCost && rank < FALLBACK_MIN_RANK) return false;
    return true;
  }

  /**
   * Invokes `feature` on the best available provider.
   *
   * @returns {Promise<{data:any, units:number, provider:string, attempts:Array}>}
   */
  async call(feature, { username, args = {}, priority = PRIORITY.NORMAL, units = null, now = new Date(), allowFallback = true } = {}) {
    const ranked = this.candidates(feature, { units, now });
    const attempts = [];

    for (let i = 0; i < ranked.length; i += 1) {
      const cand = ranked[i];
      if (!cand.usable) {
        attempts.push({ provider: cand.name, reason: cand.reason, ok: false });
        continue;
      }

      const method = methodFor(feature);
      const startedAt = Date.now();
      try {
        const res = await cand.provider[method](username, args);
        const spent = res?.units ?? cand.estimate;
        this.costManager.record(cand.name, feature, {
          units: spent,
          ok: true,
          latencyMs: Date.now() - startedAt,
          now,
        });
        this.breaker.onSuccess(cand.name, { now });
        attempts.push({ provider: cand.name, ok: true, units: spent });
        return { ...res, provider: cand.name, units: spent, attempts };
      } catch (rawErr) {
        const err = toProviderError(rawErr, cand.name);
        this.costManager.record(cand.name, feature, {
          // A failed call may still have burned quota (rate limit, partial run).
          units: err.kind === ERROR_KIND.RATE_LIMIT || err.kind === ERROR_KIND.QUOTA ? 0 : 1,
          ok: false,
          latencyMs: Date.now() - startedAt,
          now,
        });
        this.breaker.onFailure(cand.name, { now, providerFault: err.providerFault });
        attempts.push({ provider: cand.name, ok: false, reason: err.kind, message: err.message });

        const next = ranked[i + 1];
        if (!allowFallback || !this.shouldFallback(err, { priority, next })) {
          err.attempts = attempts;
          throw err;
        }
        this.logger.warn?.(`[router] ${cand.name} failed (${err.kind}); falling back to ${next.name}`);
      }
    }

    throw new NoProviderAvailableError(feature, attempts);
  }
}

function methodFor(feature) {
  return { profile: 'getProfile', stories: 'getStories', avatar: 'getAvatar', followers: 'getFollowers' }[feature] || 'getProfile';
}
