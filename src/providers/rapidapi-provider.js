import { InstagramProvider, FEATURE, TIER, providerResult, toProviderError, ProviderError, ERROR_KIND } from './provider-interface.js';
import { fetchJson, qs } from './http.js';
import { normalizeProfileShape } from './normalize.js';
import { pickStoryMedia, stableStoryId } from '../stories.js';

/**
 * RapidAPI adapter — stories + highlights (its main job) and profile as backup.
 *
 * There is no single "RapidAPI Instagram API": the marketplace hosts dozens of
 * competing scrapers, each on its own host with its own paths, and the one you
 * subscribe to can be deprecated at any time. Hard-coding a host would mean a
 * code change every time that happens, so host and paths are env-driven with
 * working defaults. Only RAPIDAPI_KEY is mandatory.
 *
 *   RAPIDAPI_KEY            your marketplace key (x-rapidapi-key)
 *   RAPIDAPI_HOST           e.g. instagram-scraper-api2.p.rapidapi.com
 *   RAPIDAPI_PROFILE_PATH   default /v1/info
 *   RAPIDAPI_STORIES_PATH   default /v1/stories
 *   RAPIDAPI_HIGHLIGHTS_PATH default /v1/highlights
 *   RAPIDAPI_USERNAME_PARAM default username_or_id_or_url
 *
 * Billing is per request, so `units` is the request count — not the number of
 * items returned. Free marketplace plans are typically a few hundred calls a
 * month, which is why this sits in TIER.FREE and is tried before Apify.
 */
export class RapidApiProvider extends InstagramProvider {
  constructor(config, { fetcher = fetchJson } = {}) {
    const rapid = config?.rapidapi || {};
    const canStories = !!rapid.key && !!rapid.host && (!!rapid.storiesPath || !!rapid.highlightsPath);
    super({
      name: 'rapidapi',
      tier: TIER.FREE,
      unitCostUsd: 0,
      features: [
        ...(rapid.key && rapid.host && rapid.profilePath ? [FEATURE.PROFILE, FEATURE.AVATAR] : []),
        ...(canStories ? [FEATURE.STORIES] : []),
      ],
      enabled: !!rapid.key && !!rapid.host,
    });
    this.config = config;
    this.rapid = rapid;
    this.fetcher = fetcher;
  }

  /** Per-request billing: one call is one unit regardless of payload size. */
  estimateUnits(feature) {
    // Stories and highlights are two separate endpoints on every host we know of.
    if (feature === FEATURE.STORIES) return this.rapid.storiesPath && this.rapid.highlightsPath ? 2 : 1;
    return 1;
  }

  get headers() {
    return {
      'x-rapidapi-key': this.rapid.key,
      'x-rapidapi-host': this.rapid.host,
      Accept: 'application/json',
    };
  }

  url(path, params = {}) {
    const clean = String(path).startsWith('/') ? path : `/${path}`;
    return `https://${this.rapid.host}${clean}${qs(params)}`;
  }

  async get(path, username, extra = {}) {
    const param = this.rapid.usernameParam || 'username_or_id_or_url';
    return this.fetcher(this.url(path, { [param]: username, ...extra }), {
      headers: this.headers,
      timeoutMs: this.rapid.timeoutMs || 45000,
    });
  }

  async getProfile(username, opts = {}) {
    if (!this.rapid.profilePath) {
      throw new ProviderError('rapidapi profile path not configured (RAPIDAPI_PROFILE_PATH)', {
        kind: ERROR_KIND.AUTH,
        provider: this.name,
      });
    }
    try {
      const raw = await this.get(this.rapid.profilePath, username);
      return providerResult(normalizeProfileShape(raw, { username }), {
        units: 1,
        provider: this.name,
        feature: FEATURE.PROFILE,
        raw,
      });
    } catch (err) {
      throw toProviderError(err, this.name);
    }
  }

  async getAvatar(username, opts = {}) {
    const res = await this.getProfile(username, opts);
    return providerResult(
      { url: res.data?.profilePicUrl || null, profile: res.data },
      { units: res.units, provider: this.name, feature: FEATURE.AVATAR }
    );
  }

  /**
   * Stories and highlights come from two endpoints. One failing must not lose
   * the other, so failures are only fatal when BOTH sides fail — a partial
   * result is still better than falling through to a paid provider.
   */
  async getStories(username, opts = {}) {
    const out = [];
    const errors = [];
    let units = 0;

    for (const [path, isHighlight] of [
      [this.rapid.storiesPath, false],
      [this.rapid.highlightsPath, true],
    ]) {
      if (!path) continue;
      units += 1;
      try {
        const raw = await this.get(path, username);
        out.push(...extractStoryItems(raw, isHighlight));
      } catch (err) {
        errors.push(toProviderError(err, this.name));
      }
    }

    if (errors.length && out.length === 0) throw errors[0];

    // Dedup: highlights and the story tray can return the same media.
    const seen = new Set();
    const deduped = out.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
    return providerResult(deduped, { units: Math.max(1, units), provider: this.name, feature: FEATURE.STORIES });
  }
}

/**
 * Pulls story/highlight items out of any of the envelope shapes these hosts use
 * and maps them to the shape `stories.js` already produces, so downstream diff,
 * dedup and download code is untouched.
 */
export function extractStoryItems(raw, isHighlight) {
  const buckets = [];
  const push = (v) => {
    if (Array.isArray(v)) buckets.push(...v);
  };

  push(raw?.data?.items);
  push(raw?.data?.stories);
  push(raw?.data?.highlights);
  push(raw?.data);
  push(raw?.items);
  push(raw?.stories);
  push(raw?.highlights);
  push(raw?.reels);
  push(raw);

  const out = [];
  for (const item of buckets) {
    if (!item || typeof item !== 'object') continue;

    // A highlight "tray" entry holds its media in a nested items array.
    const nested = Array.isArray(item.items) ? item.items : null;
    if (nested) {
      const title = item.title || item.highlightTitle || null;
      for (const media of nested) {
        const mapped = mapStoryItem(media, isHighlight, title);
        if (mapped) out.push(mapped);
      }
      continue;
    }
    const mapped = mapStoryItem(item, isHighlight, item.title || null);
    if (mapped) out.push(mapped);
  }
  return out;
}

function mapStoryItem(item, isHighlight, highlightTitle) {
  const mediaUrl = pickStoryMedia(item);
  if (!mediaUrl) return null;
  const rawTs = item.timestamp ?? item.taken_at ?? item.taken_at_timestamp ?? null;
  let timestamp = null;
  if (typeof rawTs === 'number') timestamp = new Date(rawTs < 1e12 ? rawTs * 1000 : rawTs).toISOString();
  else if (typeof rawTs === 'string') timestamp = rawTs;

  return {
    id: stableStoryId(item, mediaUrl),
    timestamp,
    mediaUrl,
    thumbnailUrl: item.thumbnailUrl || item.display_url || item.image_versions2?.candidates?.[0]?.url || null,
    isHighlight: item.isHighlight !== undefined ? !!item.isHighlight : isHighlight,
    highlightTitle: item.highlightTitle || item.highlight_title || highlightTitle || null,
    caption: typeof item.caption === 'string' ? item.caption : item.caption?.text || null,
    type: item.mediaType || item.type || (Number(item.media_type) === 2 ? 'video' : 'image'),
  };
}
