import { InstagramProvider, FEATURE, TIER, providerResult, toProviderError, ProviderError, ERROR_KIND } from './provider-interface.js';
import { fetchJson, qs, sleep } from './http.js';
import { normalizeProfileShape } from './normalize.js';

/**
 * Lobstr.io adapter — last-resort backup for profile data.
 *
 * Lobstr is task-queue shaped rather than request/response, so one profile fetch
 * is four calls:
 *   POST /v1/tasks   { squid, tasks:[{url}] }   queue the usernames
 *   POST /v1/runs    { squid }                  execute all pending tasks
 *   GET  /v1/runs/:id                           poll until done|aborted|error
 *   GET  /v1/results?run=:id                    paginated records
 *
 * Results are read by `run`, never by `squid`: the squid form returns every
 * result across all historical runs, which would grow without bound and mix in
 * stale profile data from previous polls.
 *
 * The squid must already exist in the Lobstr dashboard, configured with the
 * Instagram Profile crawler — LOBSTR_SQUID_ID points at it. That polling cost is
 * why this sits below RapidAPI and Bright Data in the fallback order.
 */
const DEFAULT_BASE = 'https://api.lobstr.io/v1';
const TERMINAL = new Set(['done', 'aborted', 'error', 'cancelled', 'canceled']);
const MAX_LIMIT = 100;
/** Vendor guidance: do not poll a run more often than this. */
const MIN_POLL_MS = 5000;

export class LobstrProvider extends InstagramProvider {
  /**
   * `sleeper` is injectable for the same reason `fetcher` is: the 5s poll floor
   * below is a vendor requirement that must not be configurable away in
   * production, but tests would otherwise sit idle for it on every run.
   */
  constructor(config, { fetcher = fetchJson, sleeper = sleep } = {}) {
    const lob = config?.lobstr || {};
    super({
      name: 'lobstr',
      tier: TIER.LOW_COST,
      unitCostUsd: lob.unitCostUsd ?? 0.002,
      features: [FEATURE.PROFILE, FEATURE.AVATAR],
      enabled: !!lob.apiKey && !!lob.squidId,
    });
    this.config = config;
    this.lob = lob;
    this.base = (lob.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.sleeper = sleeper;
  }

  estimateUnits(feature, opts = {}) {
    return Array.isArray(opts.usernames) ? Math.max(1, opts.usernames.length) : 1;
  }

  get headers() {
    return {
      Authorization: `Token ${this.lob.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  call(path, { method = 'GET', body = null } = {}) {
    return this.fetcher(`${this.base}${path}`, {
      method,
      headers: this.headers,
      body,
      timeoutMs: this.lob.timeoutMs || 45000,
    });
  }

  async collect(usernames) {
    if (!this.lob.apiKey) {
      throw new ProviderError('LOBSTR_API_KEY is not set', { kind: ERROR_KIND.AUTH, provider: this.name });
    }
    if (!this.lob.squidId) {
      throw new ProviderError('LOBSTR_SQUID_ID is not set', { kind: ERROR_KIND.AUTH, provider: this.name });
    }

    const squid = this.lob.squidId;

    // Identical params are de-duplicated server-side, so re-adding a username
    // that is already queued is safe and does not create a second task.
    await this.call('/tasks', {
      method: 'POST',
      body: { squid, tasks: usernames.map((u) => ({ url: `https://www.instagram.com/${u}/` })) },
    });

    const run = await this.call('/runs', { method: 'POST', body: { squid } });
    const runId = run?.id || run?.run?.id;
    if (!runId) throw new Error(`lobstr: run did not return an id: ${JSON.stringify(run).slice(0, 200)}`);

    const status = await this.waitForRun(runId);
    if (status !== 'done') {
      const err = new Error(`lobstr run ${runId} finished as "${status}"`);
      // aborted/error are provider-side faults, so let the breaker see a 502.
      err.status = 502;
      throw err;
    }

    return this.results(runId);
  }

  /**
   * Polls the run until a terminal state. Docs ask for >=5s between polls, hence
   * the floor — a configured value below it is raised, not honoured.
   *
   * Polls before the first sleep: a run that is already finished then returns
   * immediately instead of paying the interval. That costs one extra status call
   * in the common case, which is not billed as a result credit, and keeps a poll
   * inside the host's request wall-clock rather than idling against it.
   */
  async waitForRun(runId) {
    const deadline = Date.now() + (this.lob.runTimeoutMs || 300000);
    const interval = Math.max(MIN_POLL_MS, this.lob.runPollMs || 6000);

    for (;;) {
      const res = await this.call(`/runs/${encodeURIComponent(runId)}`);
      const status = String(res?.status || res?.run?.status || '').toLowerCase();
      if (TERMINAL.has(status)) return status;
      if (Date.now() + interval >= deadline) break;
      await this.sleeper(interval);
    }

    const err = new Error(`lobstr run ${runId} did not finish in time`);
    err.status = 408;
    throw err;
  }

  /** Reads every page of a run's results, following `next` until null. */
  async results(runId) {
    const out = [];
    let page = 1;
    const limit = Math.min(MAX_LIMIT, this.lob.pageLimit || MAX_LIMIT);

    for (;;) {
      const res = await this.call(`/results${qs({ run: runId, page, limit })}`);
      const data = Array.isArray(res?.data) ? res.data : [];
      out.push(...data);

      // Trust `next` when present; otherwise stop on a short page.
      const more = res?.next ? true : data.length === limit;
      if (!more || data.length === 0) break;
      page += 1;
      if (page > (this.lob.maxPages || 20)) break;
    }
    return out;
  }

  async getProfile(username, { usernames = null } = {}) {
    const targets = usernames || [username];
    try {
      const records = await this.collect(targets);
      const units = Math.max(1, records.length);

      if (usernames) {
        return providerResult(records, { units, provider: this.name, feature: FEATURE.PROFILE, raw: records });
      }

      if (records.length === 0) {
        throw new ProviderError(`lobstr returned no results for "${username}"`, {
          kind: ERROR_KIND.NOT_FOUND,
          provider: this.name,
        });
      }

      // A run may cover several queued usernames; pick the matching record.
      const wanted = String(username).toLowerCase();
      const match = records.find((r) => {
        const u = String(r?.username || r?.account || r?.handle || '').toLowerCase().replace(/^@/, '');
        return u === wanted;
      });

      return providerResult(normalizeProfileShape(match || records[0], { username }), {
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
