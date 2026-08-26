import { runActorSync, normalizeProfile } from '../apify.js';
import { fetchStories } from '../stories.js';
import { InstagramProvider, FEATURE, TIER, providerResult, toProviderError } from './provider-interface.js';

/**
 * Apify adapter.
 *
 * Wraps the existing runActorSync/normalizeProfile/fetchStories logic so the
 * router can treat Apify as one interchangeable source. Behaviour is unchanged
 * from the pre-refactor poller; what is new is that every call reports the
 * number of dataset items consumed as `units`, because Apify bills
 * pay-per-result (~300 free/month, then ~$2.70/1000).
 */
export class ApifyProvider extends InstagramProvider {
  constructor(config, { runner = runActorSync, storiesFetcher = fetchStories } = {}) {
    super({
      name: 'apify',
      tier: TIER.LOW_COST,
      unitCostUsd: 0.0027,
      features: [FEATURE.PROFILE, ...(config?.storiesActor ? [FEATURE.STORIES] : [])],
      enabled: !!config?.apifyToken,
    });
    this.config = config;
    this.runner = runner;
    this.storiesFetcher = storiesFetcher;
  }

  /**
   * Pre-flight estimate. A `details` scrape returns 1 profile item plus one
   * item per post, so a 12-post profile costs ~13 units.
   */
  estimateUnits(feature, opts = {}) {
    if (feature === FEATURE.PROFILE) return 1 + (opts.resultsLimit ?? 20);
    if (feature === FEATURE.STORIES) return opts.maxItems ?? 10;
    if (feature === FEATURE.AVATAR) return 1;
    return 1;
  }

  /** Counts dataset items actually returned — the real billable amount. */
  static countUnits(raw) {
    if (Array.isArray(raw)) return Math.max(1, raw.length);
    return 1;
  }

  async getProfile(username, { resultsLimit = 20, usernames = null } = {}) {
    const targets = usernames || [username];
    const input = {
      directUrls: targets.map((u) => `https://www.instagram.com/${u}/`),
      resultsType: 'details',
      resultsLimit,
    };
    try {
      const raw = await this.runner(this.config.apifyActor, input, this.config.apifyToken);
      const units = ApifyProvider.countUnits(raw);
      // Batch mode (privacy ping): hand back raw items, no normalization.
      if (usernames) return providerResult(Array.isArray(raw) ? raw : [raw], { units, provider: this.name, feature: FEATURE.PROFILE, raw });
      return providerResult(normalizeProfile(raw), { units, provider: this.name, feature: FEATURE.PROFILE, raw });
    } catch (err) {
      throw toProviderError(err, this.name);
    }
  }

  async getStories(username, opts = {}) {
    if (!this.config.storiesActor) {
      return providerResult([], { units: 0, provider: this.name, feature: FEATURE.STORIES });
    }
    try {
      const stories = await this.storiesFetcher(username, this.config);
      return providerResult(stories, {
        units: Math.max(1, stories.length),
        provider: this.name,
        feature: FEATURE.STORIES,
      });
    } catch (err) {
      throw toProviderError(err, this.name);
    }
  }

  /** Apify returns the avatar URL inside the profile payload. */
  async getAvatar(username, opts = {}) {
    const res = await this.getProfile(username, { resultsLimit: 0, ...opts });
    return providerResult(
      { url: res.data?.profilePicUrl || null, profile: res.data },
      { units: res.units, provider: this.name, feature: FEATURE.AVATAR }
    );
  }
}
