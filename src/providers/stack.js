import { CostManager } from '../cost/cost-manager.js';
import { CircuitBreaker } from '../cost/circuit-breaker.js';
import { UsageRepo } from '../cost/usage-repo.js';
import { ApifyProvider } from './apify-provider.js';
import { RapidApiProvider } from './rapidapi-provider.js';
import { BrightDataProvider } from './brightdata-provider.js';
import { LobstrProvider } from './lobstr-provider.js';
import { ProviderRouter } from './router.js';

/**
 * Assembles the cost/provider stack.
 *
 * One factory so the poller, the server and the CLI all build an identical
 * stack, and so a test can swap the Apify transport with a single `runner`
 * override.
 *
 * Registration order does not decide precedence — the router sorts candidates by
 * tier (free before low_cost before premium) and then by health score, and skips
 * any provider whose quota is spent. Adding a provider here is all that is
 * needed for it to join the fallback chain.
 *
 * A provider with no credentials reports `enabled: false` and is simply never
 * chosen, so all four can be registered unconditionally.
 */
export function createStack(store, config, { runner = null, storiesFetcher = null, providers = null, logger = console } = {}) {
  const repo = new UsageRepo(store);
  const costManager = new CostManager(store, config, { repo });
  const breaker = new CircuitBreaker(store, {
    repo,
    failureThreshold: config.circuitFailureThreshold ?? 3,
    cooldownMs: (config.circuitCooldownMinutes ?? 15) * 60 * 1000,
  });

  const apifyOpts = {};
  if (runner) apifyOpts.runner = runner;
  if (storiesFetcher) apifyOpts.storiesFetcher = storiesFetcher;

  const list = providers || [
    new RapidApiProvider(config),
    new ApifyProvider(config, apifyOpts),
    new BrightDataProvider(config),
    new LobstrProvider(config),
  ];
  const router = new ProviderRouter({ providers: list, costManager, breaker, logger });

  return { repo, costManager, breaker, router, providers: list };
}
