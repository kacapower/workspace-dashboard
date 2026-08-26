/**
 * Provider contract.
 *
 * Every Instagram data source (an Apify actor, a RapidAPI endpoint, ...) is
 * wrapped in a class implementing this interface so the router can pick the
 * cheapest healthy provider per feature, instead of the poller hard-coding one
 * vendor. Adding a provider must never require touching the poller.
 */

/** Monitoring features a provider may support. */
export const FEATURE = {
  PROFILE: 'profile',
  STORIES: 'stories',
  AVATAR: 'avatar',
  FOLLOWERS: 'followers',
};

/** Cost tiers, cheapest first. The router walks candidates in this order. */
export const TIER = { FREE: 'free', LOW_COST: 'low_cost', PREMIUM: 'premium' };
export const TIER_ORDER = [TIER.FREE, TIER.LOW_COST, TIER.PREMIUM];

/**
 * Failure taxonomy. Drives retry, circuit-breaker and fallback decisions — the
 * PRD requires that a provider failure never be mistaken for an Instagram
 * change, and that we not escalate to an expensive provider on every error.
 */
export const ERROR_KIND = {
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth',
  NOT_FOUND: 'not_found',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  SCHEMA: 'schema',
  QUOTA: 'quota',
  UNKNOWN: 'unknown',
};

/** Kinds worth retrying / falling back on. The rest are permanent for this call. */
const RETRYABLE = new Set([ERROR_KIND.RATE_LIMIT, ERROR_KIND.TIMEOUT, ERROR_KIND.NETWORK]);

export class ProviderError extends Error {
  constructor(message, { kind = ERROR_KIND.UNKNOWN, provider = null, status = null, cause = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.status = status;
    this.retryable = RETRYABLE.has(kind);
    /**
     * Whether this counts against provider health. A missing account is the
     * request's fault, not the provider's — it must not open a circuit.
     */
    this.providerFault = kind !== ERROR_KIND.NOT_FOUND;
    if (cause) this.cause = cause;
  }
}

/** Maps an HTTP status onto an ERROR_KIND. */
export function kindFromStatus(status) {
  if (status === 429) return ERROR_KIND.RATE_LIMIT;
  if (status === 401 || status === 403) return ERROR_KIND.AUTH;
  if (status === 404) return ERROR_KIND.NOT_FOUND;
  if (status === 408 || status === 504) return ERROR_KIND.TIMEOUT;
  if (status >= 500) return ERROR_KIND.NETWORK;
  return ERROR_KIND.UNKNOWN;
}

/**
 * Wraps an arbitrary thrown value as a ProviderError, preserving a `status`
 * property if the thrower attached one (see apify.js).
 */
export function toProviderError(err, provider) {
  if (err instanceof ProviderError) {
    if (!err.provider) err.provider = provider;
    return err;
  }
  const status = err && typeof err.status === 'number' ? err.status : null;
  const message = String(err?.message || err || 'unknown provider failure');
  let kind = status ? kindFromStatus(status) : ERROR_KIND.UNKNOWN;
  if (!status) {
    if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(message)) kind = ERROR_KIND.TIMEOUT;
    else if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|fetch failed|socket/i.test(message)) kind = ERROR_KIND.NETWORK;
    else if (/token is not set|unauthor/i.test(message)) kind = ERROR_KIND.AUTH;
    else if (/no profile data|no results/i.test(message)) kind = ERROR_KIND.NOT_FOUND;
    else if (/unexpected response|invalid json|schema/i.test(message)) kind = ERROR_KIND.SCHEMA;
  }
  return new ProviderError(message, { kind, provider, status, cause: err });
}

/**
 * Result envelope every provider method returns. `units` is what the cost
 * manager charges: for pay-per-result vendors (Apify) it is the number of
 * dataset items actually returned, so cost tracking reflects reality rather
 * than an estimate.
 */
export function providerResult(data, { units = 1, provider = null, feature = null, raw = null } = {}) {
  return { data, units, provider, feature, raw };
}

/* eslint-disable no-unused-vars */
/**
 * Base class. Subclasses override the features they support and declare their
 * tier + per-unit cost so the router can order them.
 */
export class InstagramProvider {
  /** @param {{name:string, tier?:string, unitCostUsd?:number, features?:string[], enabled?:boolean}} meta */
  constructor(meta = {}) {
    this.name = meta.name || 'unnamed';
    this.tier = meta.tier || TIER.LOW_COST;
    this.unitCostUsd = meta.unitCostUsd ?? 0;
    this.features = new Set(meta.features || []);
    this.enabled = meta.enabled !== false;
  }

  supports(feature) {
    return this.features.has(feature);
  }

  /** Conservative pre-flight unit estimate, used for quota gating before the call. */
  estimateUnits(feature, opts = {}) {
    return 1;
  }

  async getProfile(username, opts = {}) {
    throw new ProviderError(`${this.name} does not implement getProfile`, { kind: ERROR_KIND.UNKNOWN, provider: this.name });
  }

  async getStories(username, opts = {}) {
    throw new ProviderError(`${this.name} does not implement getStories`, { kind: ERROR_KIND.UNKNOWN, provider: this.name });
  }

  async getAvatar(username, opts = {}) {
    throw new ProviderError(`${this.name} does not implement getAvatar`, { kind: ERROR_KIND.UNKNOWN, provider: this.name });
  }

  async getFollowers(username, opts = {}) {
    throw new ProviderError(`${this.name} does not implement getFollowers`, { kind: ERROR_KIND.UNKNOWN, provider: this.name });
  }
}
