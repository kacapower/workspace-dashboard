import { InstagramProvider, FEATURE, TIER, providerResult, toProviderError, ProviderError, ERROR_KIND } from './provider-interface.js';
import { fetchRaw, fetchJson, parseJson, qs, sleep } from './http.js';
import { normalizeProfileShape } from './normalize.js';

/**
 * Bright Data Web Scraper API adapter — the public/private status source.
 *
 * Two call styles, both documented:
 *   POST /datasets/v3/scrape?dataset_id=…   synchronous, JSON back in one call,
 *                                           but capped at ~60s. Past that it
 *                                           returns 202 + a snapshot_id.
 *   POST /datasets/v3/trigger?dataset_id=…  async, always returns a snapshot_id.
 *
 * We try sync first because a status check is small and latency matters on a
 * cron tick, then transparently fall back to polling the snapshot. Dataset IDs
 * differ per account and per scraper, so BRIGHTDATA_DATASET_ID is required
 * rather than baked in.
 *
 * Bright Data bills per record returned, so `units` is the record count.
 */
const DEFAULT_BASE = 'https://api.brightdata.com';

export class BrightDataProvider extends InstagramProvider {
  constructor(config, { fetcher = fetchRaw, jsonFetcher = fetchJson } = {}) {
    const bd = config?.brightdata || {};
    super({
      name: 'brightdata',
      tier: TIER.LOW_COST,
      unitCostUsd: bd.unitCostUsd ?? 0.001,
      features: [FEATURE.PROFILE, FEATURE.AVATAR],
      enabled: !!bd.apiKey && !!bd.datasetId,
    });
    this.config = config;
    this.bd = bd;
    this.base = (bd.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.jsonFetcher = jsonFetcher;
  }

  /** One record per requested profile. */
  estimateUnits(feature, opts = {}) {
    return Array.isArray(opts.usernames) ? Math.max(1, opts.usernames.length) : 1;
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.bd.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Runs a collection and returns the raw record array.
   *
   * Batching matters here: one call covering every private account is what keeps
   * the hourly status check affordable, so `usernames` is passed straight through
   * as a multi-input request rather than looped.
   */
  async collect(usernames) {
    if (!this.bd.apiKey) {
      throw new ProviderError('BRIGHTDATA_API_KEY is not set', { kind: ERROR_KIND.AUTH, provider: this.name });
    }
    if (!this.bd.datasetId) {
      throw new ProviderError('BRIGHTDATA_DATASET_ID is not set', { kind: ERROR_KIND.AUTH, provider: this.name });
    }

    const input = usernames.map((u) => ({ url: `https://www.instagram.com/${u}/` }));
    const query = qs({ dataset_id: this.bd.datasetId, format: 'json', include_errors: 'true' });

    const res = await this.fetcher(`${this.base}/datasets/v3/scrape${query}`, {
      method: 'POST',
      headers: this.headers,
      body: { input },
      timeoutMs: this.bd.timeoutMs || 70000,
    });

    // 202 means the run outlived the synchronous window; switch to polling.
    if (res.status === 202) {
      const snapshotId = parseJson(res.text, res.status)?.snapshot_id;
      if (!snapshotId) {
        const err = new Error(`brightdata returned 202 without a snapshot_id: ${res.text.slice(0, 200)}`);
        err.status = 202;
        throw err;
      }
      return this.waitForSnapshot(snapshotId);
    }

    if (!res.ok) {
      const err = new Error(`brightdata scrape failed (${res.status}): ${res.text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    return asRecords(parseJson(res.text, res.status));
  }

  /**
   * Polls a snapshot until it holds data. The download endpoint answers 202
   * while the run is still going, so 202 is "keep waiting", not an error.
   */
  async waitForSnapshot(snapshotId) {
    const deadline = Date.now() + (this.bd.snapshotTimeoutMs || 240000);
    const interval = this.bd.snapshotPollMs || 5000;
    let last = null;

    while (Date.now() < deadline) {
      await sleep(interval);
      const res = await this.fetcher(
        `${this.base}/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}${qs({ format: 'json' })}`,
        { headers: this.headers, timeoutMs: this.bd.timeoutMs || 70000 }
      );

      if (res.status === 202) continue;
      if (!res.ok) {
        const err = new Error(`brightdata snapshot ${snapshotId} failed (${res.status}): ${res.text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      last = asRecords(parseJson(res.text, res.status));
      if (last.length) return last;
    }

    const err = new Error(`brightdata snapshot ${snapshotId} did not complete in time`);
    err.status = 408;
    throw err;
  }

  async getProfile(username, { usernames = null } = {}) {
    const targets = usernames || [username];
    try {
      const records = await this.collect(targets);
      const units = Math.max(1, records.length);

      // Batch mode mirrors ApifyProvider: hand back raw records untouched so the
      // privacy ping can map them itself.
      if (usernames) {
        return providerResult(records, { units, provider: this.name, feature: FEATURE.PROFILE, raw: records });
      }

      // Bright Data echoes an error record instead of 404 for a dead account.
      const first = records[0];
      if (first && (first.error || first.warning) && !first.account && !first.username) {
        throw new ProviderError(`brightdata: ${first.error || first.warning}`, {
          kind: ERROR_KIND.NOT_FOUND,
          provider: this.name,
        });
      }

      return providerResult(normalizeProfileShape(records, { username }), {
        units,
        provider: this.name,
        feature: FEATURE.PROFILE,
        raw: records,
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
}

/** Normalizes the response envelope to a flat record array. */
function asRecords(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.results)) return body.results;
  return [body];
}
