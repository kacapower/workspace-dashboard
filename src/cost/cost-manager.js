import { UsageRepo } from './usage-repo.js';
import { TIER, TIER_ORDER } from '../providers/provider-interface.js';

/**
 * Budget modes (PRD 776–795). Default is maximum_free.
 *
 * maximum_free    — never exceed a provider's FREE monthly allowance. Paid
 *                   overage is refused even if a paid limit is configured.
 * balanced        — free + low-cost providers, up to their configured limits.
 * maximum_coverage— all enabled providers, premium included.
 */
export const MODE = {
  MAX_FREE: 'maximum_free',
  BALANCED: 'balanced',
  MAX_COVERAGE: 'maximum_coverage',
};

/** Which tiers each mode may spend on. */
const MODE_TIERS = {
  [MODE.MAX_FREE]: [TIER.FREE, TIER.LOW_COST],
  [MODE.BALANCED]: [TIER.FREE, TIER.LOW_COST],
  [MODE.MAX_COVERAGE]: TIER_ORDER,
};

/**
 * Adaptive polling back-off by quota consumption (PRD 430–451). Interval is
 * multiplied by `factor` once `atPct` of the monthly budget is used.
 */
export const DEFAULT_THROTTLE_STEPS = [
  { atPct: 0, factor: 1 },
  { atPct: 70, factor: 2 },
  { atPct: 85, factor: 4 },
  { atPct: 95, factor: 12 },
  { atPct: 100, factor: Infinity }, // disabled
];

/**
 * Per-provider budgets. `freeUnitsPerMonth` is the vendor's free allowance and
 * is the hard ceiling in maximum_free mode.
 *
 * Apify is pay-per-result: ~300 results/month free, then ~$2.70/1000. A
 * `details` scrape returns 1 profile item plus one item per post, so the
 * pre-flight estimate for a 20-post poll is 21 units and a 30-post backfill
 * (used when a private account goes public) is 31.
 *
 * NOTE on the free-tier math: 21 units/day × 31 days = 651 > 300, so the free
 * allowance genuinely cannot sustain a daily full poll of even one profile.
 * `monthlyUnits` is therefore the real budget that the adaptive throttle
 * stretches, while `dailyUnits` is only a BURST guard against a runaway loop.
 * It must stay above the largest legitimate single day of work — one poll (21)
 * plus a went-public backfill (31) — because a daily cap below the pre-flight
 * estimate of an operation blocks that operation forever, not just today.
 */
export const DEFAULT_LIMITS = {
  apify: {
    tier: TIER.LOW_COST,
    unitCostUsd: 0.0027,
    freeUnitsPerMonth: 1851, // $5.00 free tier / $0.0027 per unit = ~1851 units
    dailyUnits: Math.floor(1851 / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()), // Dynamically divided by days in current month
    monthlyUnits: 1851,
  },
  rapidapi: {
    tier: TIER.FREE,
    unitCostUsd: 0,
    freeUnitsPerMonth: 500,
    dailyUnits: 16,
    monthlyUnits: 500,
  },
  /**
   * Bright Data bills per record returned. There is no free monthly allowance,
   * so in maximum_free mode `monthlyCeiling` resolves to 0 and the router skips
   * it — set BRIGHTDATA_FREE_UNITS if your plan includes trial credit, or run in
   * `balanced` mode to spend the configured paid limit.
   *
   * dailyUnits is a burst guard only and must stay above the largest legitimate
   * single day: one status record per tracked account per hourly tick.
   */
  brightdata: {
    tier: TIER.LOW_COST,
    unitCostUsd: 0.001,
    freeUnitsPerMonth: 0,
    dailyUnits: 240,
    monthlyUnits: 5000,
  },
  /** Lobstr bills per result credit; same free-allowance caveat as Bright Data. */
  lobstr: {
    tier: TIER.LOW_COST,
    unitCostUsd: 0.002,
    freeUnitsPerMonth: 0,
    dailyUnits: 60,
    monthlyUnits: 1000,
  },
  llm: {
    tier: TIER.FREE,
    unitCostUsd: 0,
    freeUnitsPerMonth: 500,
    dailyUnits: 20,
    monthlyUnits: 500,
  },
};

export const DENY = {
  KILL_SWITCH: 'kill_switch',
  DISABLED: 'provider_disabled',
  MODE_TIER: 'tier_not_allowed_in_mode',
  DAILY: 'daily_limit_reached',
  MONTHLY: 'monthly_limit_reached',
  FREE_ALLOWANCE: 'free_allowance_exhausted',
};

/**
 * Tracks and enforces external-API spend. Nothing may call a provider without
 * an `ok` verdict from `canSpend()`; every call reports back via `record()`.
 */
export class CostManager {
  constructor(store, config = {}, { repo = null, limits = null, throttleSteps = null } = {}) {
    this.store = store;
    this.config = config;
    this.repo = repo || new UsageRepo(store);
    this.limits = limits || buildLimits(config);
    this.throttleSteps = throttleSteps || DEFAULT_THROTTLE_STEPS;
    this.defaultMode = config.budgetMode || MODE.MAX_FREE;
  }

  limitsFor(provider) {
    return this.limits[provider] || { tier: TIER.PREMIUM, unitCostUsd: 0, freeUnitsPerMonth: 0, dailyUnits: 0, monthlyUnits: 0 };
  }

  mode() {
    const doc = this.repo.read();
    return doc.mode || this.defaultMode;
  }

  setMode(mode) {
    if (!MODE_TIERS[mode]) throw new Error(`Unknown budget mode: ${mode}`);
    this.repo.update((doc) => {
      doc.mode = mode;
      return doc;
    });
    return mode;
  }

  killSwitch() {
    return !!this.repo.read().killSwitch;
  }

  /** PRD 390–403: hard stop on ALL external API calls. Dashboard stays up. */
  setKillSwitch(on) {
    this.repo.update((doc) => {
      doc.killSwitch = !!on;
      return doc;
    });
    return !!on;
  }

  /**
   * Effective monthly ceiling: in maximum_free mode the vendor's free allowance
   * wins, so we can never silently roll into paid usage.
   */
  monthlyCeiling(provider, mode = this.mode()) {
    const lim = this.limitsFor(provider);
    if (mode === MODE.MAX_FREE) return Math.min(lim.monthlyUnits, lim.freeUnitsPerMonth);
    return lim.monthlyUnits;
  }

  /**
   * Gate a prospective call. Returns
   * `{ ok, reason, remainingDay, remainingMonth, ceiling }`.
   */
  canSpend(provider, feature, units = 1, { now = new Date(), mode = null } = {}) {
    const doc = this.repo.read();
    const effMode = mode || doc.mode || this.defaultMode;
    const lim = this.limitsFor(provider);
    const state = this.repo.providerState(doc, provider, now);

    const ceilingMonth = this.monthlyCeiling(provider, effMode);
    const remainingDay = Math.max(0, lim.dailyUnits - state.day.units);
    const remainingMonth = Math.max(0, ceilingMonth - state.month.units);
    const base = { remainingDay, remainingMonth, ceiling: ceilingMonth, mode: effMode };

    if (doc.killSwitch) return { ok: false, reason: DENY.KILL_SWITCH, ...base };
    if (this.config.providerEnabled && this.config.providerEnabled[provider] === false) {
      return { ok: false, reason: DENY.DISABLED, ...base };
    }
    const allowedTiers = MODE_TIERS[effMode] || MODE_TIERS[MODE.MAX_FREE];
    if (!allowedTiers.includes(lim.tier)) return { ok: false, reason: DENY.MODE_TIER, ...base };

    if (units > remainingMonth) {
      const reason = effMode === MODE.MAX_FREE && ceilingMonth === lim.freeUnitsPerMonth ? DENY.FREE_ALLOWANCE : DENY.MONTHLY;
      return { ok: false, reason, ...base };
    }
    if (units > remainingDay) return { ok: false, reason: DENY.DAILY, ...base };
    return { ok: true, reason: null, ...base };
  }

  /**
   * Books actual spend and updates provider health. `units` should be the real
   * cost (e.g. dataset items returned), not the pre-flight estimate.
   */
  record(provider, feature, { units = 1, ok = true, latencyMs = null, now = new Date() } = {}) {
    return this.repo.update((doc) => {
      const state = this.repo.providerState(doc, provider, now);
      const lim = this.limitsFor(provider);
      const spend = Math.max(0, units);
      const cost = spend * (lim.unitCostUsd || 0);
      const iso = new Date(now).toISOString();

      for (const w of [state.day, state.month]) {
        w.requests += 1;
        w.units += spend;
        w.costUsd = round4(w.costUsd + cost);
        if (!ok) w.errors += 1;
      }

      const f = state.features[feature] || { requests: 0, units: 0, errors: 0 };
      f.requests += 1;
      f.units += spend;
      if (!ok) f.errors += 1;
      state.features[feature] = f;

      const h = state.health;
      if (ok) {
        h.success += 1;
        h.consecutiveFailures = 0;
        h.lastSuccessAt = iso;
      } else {
        h.failure += 1;
        h.consecutiveFailures += 1;
        h.lastFailureAt = iso;
      }
      if (Number.isFinite(latencyMs)) {
        h.latencyMsAvg = h.latencyMsAvg == null ? latencyMs : Math.round(h.latencyMsAvg * 0.7 + latencyMs * 0.3);
      }
      return doc;
    });
  }

  /** Fraction (0–1+) of the monthly ceiling consumed. */
  usedFraction(provider, { now = new Date() } = {}) {
    const doc = this.repo.read();
    const state = this.repo.providerState(doc, provider, now);
    const ceiling = this.monthlyCeiling(provider);
    if (!ceiling) return 1;
    return state.month.units / ceiling;
  }

  /**
   * Interval multiplier for adaptive polling. Infinity means "do not poll".
   * The scheduler multiplies a profile's interval by this.
   */
  throttleFactor(provider, { now = new Date() } = {}) {
    const pct = this.usedFraction(provider, { now }) * 100;
    let factor = 1;
    for (const step of this.throttleSteps) {
      if (pct >= step.atPct) factor = step.factor;
    }
    return factor;
  }

  /**
   * Dashboard payload: per-provider usage bars + burn-rate forecast
   * (PRD 406–427).
   */
  snapshot({ now = new Date() } = {}) {
    const doc = this.repo.read();
    const mode = doc.mode || this.defaultMode;
    const providers = {};
    for (const name of Object.keys(this.limits)) {
      const state = this.repo.providerState(doc, name, now);
      const lim = this.limitsFor(name);
      const ceiling = this.monthlyCeiling(name, mode);
      const usedPct = ceiling ? Math.min(100, Math.round((state.month.units / ceiling) * 100)) : 100;
      providers[name] = {
        tier: lim.tier,
        mode,
        day: state.day,
        month: state.month,
        features: state.features,
        health: state.health,
        circuit: state.circuit,
        dailyLimit: lim.dailyUnits,
        monthlyCeiling: ceiling,
        usedPct,
        remainingMonth: Math.max(0, ceiling - state.month.units),
        throttleFactor: this.throttleFactor(name, { now }),
        forecast: forecastExhaustion(state.month, ceiling, now),
      };
    }
    return { mode, killSwitch: !!doc.killSwitch, providers };
  }
}

/** Merges env/config overrides over DEFAULT_LIMITS. */
export function buildLimits(config = {}) {
  const out = {};
  for (const [name, base] of Object.entries(DEFAULT_LIMITS)) {
    out[name] = { ...base, ...((config.providerLimits || {})[name] || {}) };
  }
  for (const [name, extra] of Object.entries(config.providerLimits || {})) {
    if (!out[name]) out[name] = { tier: TIER.PREMIUM, unitCostUsd: 0, freeUnitsPerMonth: 0, dailyUnits: 0, monthlyUnits: 0, ...extra };
  }
  return out;
}

/**
 * "At the current rate, quota runs out in ~N days" (PRD 424–426). Uses units
 * per elapsed day this month.
 */
export function forecastExhaustion(monthWindow, ceiling, now = new Date()) {
  const d = new Date(now);
  const dayOfMonth = d.getUTCDate();
  const used = monthWindow.units || 0;
  if (!ceiling) return { daysLeft: 0, perDay: 0, exhausted: true };
  if (used <= 0) return { daysLeft: null, perDay: 0, exhausted: false };
  const perDay = used / Math.max(1, dayOfMonth);
  const remaining = Math.max(0, ceiling - used);
  return {
    perDay: Math.round(perDay * 100) / 100,
    daysLeft: perDay > 0 ? Math.floor(remaining / perDay) : null,
    exhausted: remaining <= 0,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
