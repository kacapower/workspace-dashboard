/**
 * Deletes downloaded media older than `retentionDays`, EXCEPT avatar files
 * (avatar-*) which are kept forever. JSON snapshots are always kept.
 * Returns { deleted, freedBytes, skipped }.
 *
 * Expressed over the store's async media interface rather than `fs`, so the same
 * pruning runs against a local disk and against Supabase Storage. Media is
 * listed per tracked profile: that matches the old per-directory walk (untracked
 * leftovers are never touched) and costs one Storage list per account instead of
 * one for the whole bucket plus one per account.
 */
export async function cleanupOldMedia(store, config, { now = Date.now() } = {}) {
  const cfg = store.getConfig();
  if (cfg.retentionEnabled === false) {
    return { deleted: 0, freedBytes: 0, skipped: true };
  }
  const days = Number(cfg.retentionDays) || config.retentionDays;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let freedBytes = 0;

  for (const entry of cfg.profiles || []) {
    let files;
    try {
      files = await store.listMedia(entry.username);
    } catch {
      continue; // one unreadable account must not abort the sweep
    }
    for (const file of files) {
      if (file.name.startsWith('avatar-')) continue;
      if (!(file.mtimeMs < cutoff)) continue;
      try {
        if (await store.deleteMedia(entry.username, file.name)) {
          deleted += 1;
          freedBytes += file.bytes;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { deleted, freedBytes, skipped: false };
}
