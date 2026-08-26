import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

export function loadConfig() {
  return {
    port: Number(process.env.PORT) || 3000,
    secret: process.env.SECRET || 'dev-secret-change-me',
    pollToken: process.env.POLL_TOKEN || 'dev-poll-token',
    apifyToken: process.env.APIFY_TOKEN || '',
    apifyActor: process.env.APIFY_ACTOR || 'apify/instagram-scraper',
    storiesActor: process.env.APIFY_STORIES_ACTOR || '',
    storiesProxy: process.env.APIFY_STORIES_PROXY || '',
    instagramSession: process.env.INSTAGRAM_SESSION || '',
    pollIntervalHours: Number(process.env.POLL_INTERVAL_HOURS) || 1,
    batchIntervalHours: Number(process.env.POLL_BATCH_HOURS) || 8,
    retentionDays: Number(process.env.RETENTION_DAYS) || 7,
    hfToken: process.env.HF_TOKEN || '',
    hfDataset: process.env.HF_DATASET || '',
    renderApiKey: process.env.RENDER_API_KEY || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramUserIds: (process.env.TELEGRAM_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    summaryHour: Number(process.env.SUMMARY_HOUR) || 9,
    dataDir: process.env.DATA_DIR || path.join(rootDir, 'data'),
    publicDir: path.join(rootDir, 'public'),

    /**
     * RapidAPI — stories + highlights, and profile as a free-tier backup.
     * The marketplace hosts dozens of competing Instagram scrapers, each with
     * its own host and paths, and any of them can be deprecated without notice.
     * Everything is therefore env-driven; only the key has no sensible default.
     */
    rapidapi: {
      key: process.env.RAPIDAPI_KEY || '',
      host: process.env.RAPIDAPI_HOST || 'instagram-scraper-api2.p.rapidapi.com',
      profilePath: process.env.RAPIDAPI_PROFILE_PATH || '/v1/info',
      storiesPath: process.env.RAPIDAPI_STORIES_PATH || '/v1/stories',
      highlightsPath: process.env.RAPIDAPI_HIGHLIGHTS_PATH || '/v1/highlights',
      usernameParam: process.env.RAPIDAPI_USERNAME_PARAM || 'username_or_id_or_url',
      timeoutMs: Number(process.env.RAPIDAPI_TIMEOUT_MS) || 45000,
    },

    /**
     * Bright Data Web Scraper API — the public/private status source. Dataset
     * IDs are per-account and per-scraper, so there is no usable default.
     */
    brightdata: {
      apiKey: process.env.BRIGHTDATA_API_KEY || '',
      datasetId: process.env.BRIGHTDATA_DATASET_ID || '',
      baseUrl: process.env.BRIGHTDATA_BASE_URL || '',
      timeoutMs: Number(process.env.BRIGHTDATA_TIMEOUT_MS) || 70000,
      snapshotPollMs: Number(process.env.BRIGHTDATA_SNAPSHOT_POLL_MS) || 5000,
      snapshotTimeoutMs: Number(process.env.BRIGHTDATA_SNAPSHOT_TIMEOUT_MS) || 240000,
      unitCostUsd: numberOrUndefined(process.env.BRIGHTDATA_UNIT_COST_USD) ?? 0.001,
    },

    /**
     * Lobstr.io — last-resort profile backup. The squid must already exist in
     * the dashboard, configured with the Instagram Profile crawler.
     */
    lobstr: {
      apiKey: process.env.LOBSTR_API_KEY || '',
      squidId: process.env.LOBSTR_SQUID_ID || '',
      baseUrl: process.env.LOBSTR_BASE_URL || '',
      timeoutMs: Number(process.env.LOBSTR_TIMEOUT_MS) || 45000,
      runPollMs: Number(process.env.LOBSTR_RUN_POLL_MS) || 6000,
      runTimeoutMs: Number(process.env.LOBSTR_RUN_TIMEOUT_MS) || 300000,
      unitCostUsd: numberOrUndefined(process.env.LOBSTR_UNIT_COST_USD) ?? 0.002,
    },

    /**
     * Cron-driven mode. Free hosts (Render free et al.) sleep when idle, so the
     * in-process setInterval scheduler cannot be trusted to fire. With
     * CRON_MODE=1 the internal timer is disabled and an external cron hitting
     * POST /api/poll is the only trigger — each hit does the full fetch → diff →
     * persist → notify → sync cycle in-request.
     */
    cronMode: truthy(process.env.CRON_MODE),
    /** Break an abandoned poll lock after this many minutes. */
    pollLockStaleMinutes: Number(process.env.POLL_LOCK_STALE_MINUTES) || 20,

    /** Budget mode: maximum_free | balanced | maximum_coverage. */
    budgetMode: process.env.BUDGET_MODE || 'maximum_free',
    /** Per-provider quota overrides, e.g. APIFY_MONTHLY_UNITS=300. */
    providerLimits: {
      apify: stripUndefined({
        dailyUnits: numberOrUndefined(process.env.APIFY_DAILY_UNITS),
        monthlyUnits: numberOrUndefined(process.env.APIFY_MONTHLY_UNITS),
        freeUnitsPerMonth: numberOrUndefined(process.env.APIFY_FREE_UNITS),
      }),
      rapidapi: stripUndefined({
        dailyUnits: numberOrUndefined(process.env.RAPIDAPI_DAILY_UNITS),
        monthlyUnits: numberOrUndefined(process.env.RAPIDAPI_MONTHLY_UNITS),
        freeUnitsPerMonth: numberOrUndefined(process.env.RAPIDAPI_FREE_UNITS),
      }),
      brightdata: stripUndefined({
        dailyUnits: numberOrUndefined(process.env.BRIGHTDATA_DAILY_UNITS),
        monthlyUnits: numberOrUndefined(process.env.BRIGHTDATA_MONTHLY_UNITS),
        freeUnitsPerMonth: numberOrUndefined(process.env.BRIGHTDATA_FREE_UNITS),
      }),
      lobstr: stripUndefined({
        dailyUnits: numberOrUndefined(process.env.LOBSTR_DAILY_UNITS),
        monthlyUnits: numberOrUndefined(process.env.LOBSTR_MONTHLY_UNITS),
        freeUnitsPerMonth: numberOrUndefined(process.env.LOBSTR_FREE_UNITS),
      }),
    },
    /** Explicit per-provider off switch, e.g. PROVIDER_APIFY_ENABLED=0. */
    providerEnabled: {
      apify: process.env.PROVIDER_APIFY_ENABLED === undefined ? true : truthy(process.env.PROVIDER_APIFY_ENABLED),
      rapidapi: process.env.PROVIDER_RAPIDAPI_ENABLED === undefined ? true : truthy(process.env.PROVIDER_RAPIDAPI_ENABLED),
      brightdata: process.env.PROVIDER_BRIGHTDATA_ENABLED === undefined ? true : truthy(process.env.PROVIDER_BRIGHTDATA_ENABLED),
      lobstr: process.env.PROVIDER_LOBSTR_ENABLED === undefined ? true : truthy(process.env.PROVIDER_LOBSTR_ENABLED),
    },
    /** Consecutive provider faults before the circuit opens. */
    circuitFailureThreshold: Number(process.env.CIRCUIT_FAILURE_THRESHOLD) || 3,
    circuitCooldownMinutes: Number(process.env.CIRCUIT_COOLDOWN_MINUTES) || 15,
  };
}

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function numberOrUndefined(v) {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export const CONFIG_FILE = 'config.json';
export const PASSWORD_FILE = 'password.json';
export const HISTORY_FILE = 'history.json';
export const MEDIA_DIR = 'media';
export const HF_MANIFEST_FILE = 'hf-manifest.json';
export const USAGE_FILE = 'usage.json';
export const LOCK_FILE = 'poll.lock';
