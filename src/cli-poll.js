import { loadConfig } from './config.js';
import { Store } from './store.js';
import { runCronCycle } from './cron-cycle.js';

/**
 * Cron entry point for a compute host that is not the web server — a GitHub
 * Actions runner, a VM crontab, anything that can run `npm run poll`.
 *
 * The runner starts with an empty disk, so the cycle restores state from the
 * Hugging Face dataset first, then polls, alerts, backs up and prunes. This is
 * what makes a sleeping free web host irrelevant: the dashboard can be asleep
 * while the data keeps being collected.
 *
 * Flags: --force (poll every profile regardless of interval)
 *        --no-restore (skip the HF pull; for local runs with real state on disk)
 */
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const restore = !argv.includes('--no-restore');

const config = loadConfig();
const store = new Store(config.dataDir);

try {
  const result = await runCronCycle(store, config, { force, restore, cleanup: true, owner: 'cli' });
  console.log(JSON.stringify(result, null, 2));
  // A busy lock is not a failure: another run is already doing the work.
  if (!result.ok && !result.busy && !result.skipped) process.exit(1);
} catch (err) {
  console.error('Poll failed:', err.message);
  process.exit(1);
}
