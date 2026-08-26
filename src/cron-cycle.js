import { LOCK_FILE } from './config.js';
import { PollLock } from './poll-lock.js';
import { pollAndNotify } from './notify.js';
import { cleanupOldMedia } from './retention.js';
import { restoreFromHF, hfEnabled } from './hf.js';

/**
 * The single cron entry point.
 *
 * Free hosts sleep when idle, so an in-process timer cannot be trusted to fire.
 * One external cron hit must therefore do the WHOLE cycle in-request:
 *
 *   restore (only if the disk was wiped) → fetch → diff → persist → alert
 *   → back up to HF → prune old media
 *
 * It all runs under a filesystem lock, so two triggers (overlapping cron runs,
 * or cron plus a manual dashboard poll) can never spend quota twice on the same
 * work.
 */
export function createPollLock(config) {
  return new PollLock(config.dataDir, {
    file: LOCK_FILE,
    staleMs: (config.pollLockStaleMinutes ?? 20) * 60 * 1000,
  });
}

export async function runCronCycle(store, config, { force = false, restore = false, cleanup = null, owner = 'cron', poller = pollAndNotify, lock = null } = {}) {
  // Injectable so the Edge Function can hand in a SupabasePollLock; both classes
  // expose the same withLock contract.
  const theLock = lock || createPollLock(config);
  // When nothing stays awake, the 30-minute retention timer never fires, so the
  // cron hit has to prune too.
  const doCleanup = cleanup === null ? !!config.cronMode : cleanup;

  const got = await theLock.withLock(
    async () => {
      // Only pull from HF when local state is actually gone — an ephemeral disk
      // (Render redeploy) or a fresh CI runner. A warm disk must not pay for it.
      if (restore && hfEnabled(config) && (store.getConfig().profiles || []).length === 0) {
        try {
          const r = await restoreFromHF(config, store);
          if (!r.skipped) console.log(`[restore] ${r.restored} file(s) restored from HF`);
        } catch (err) {
          console.warn(`[restore] failed: ${err.message}`);
        }
      }

      const result = await poller(store, config, { force });

      if (doCleanup) {
        try {
          const pruned = await cleanupOldMedia(store, config);
          if (!pruned.skipped && pruned.deleted > 0) {
            console.log(`[retention] removed ${pruned.deleted} file(s), freed ${(pruned.freedBytes / 1024 / 1024).toFixed(2)} MB`);
          }
          return { ...result, retention: pruned };
        } catch (err) {
          return { ...result, retention: { ok: false, error: err.message } };
        }
      }
      return result;
    },
    { owner }
  );

  if (!got.acquired) {
    return {
      ok: false,
      skipped: true,
      busy: true,
      message: 'A poll is already running — skipped to avoid duplicate spend.',
      heldBy: got.heldBy || null,
      ageMs: got.ageMs ?? null,
    };
  }
  return got.result;
}
