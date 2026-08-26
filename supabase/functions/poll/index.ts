// Supabase Edge Function — the poll trigger.
//
// A thin wrapper only: every decision lives in the shared `src/` modules, which
// run unchanged here because they import nothing beyond `node:` builtins (Deno
// supports those) and the dependency-free SupabaseRest client.
//
// GitHub Actions cron hits this every ~30 minutes with the POLL_TOKEN bearer.
//
// Default mode is the job queue: Edge Functions get 150s of wall clock, so a
// full sweep of many accounts cannot be one invocation. Each ping claims due
// jobs, works to a ~100s budget, and returns the rest to the next ping.
// POST {"mode":"full"} to run the legacy whole-account cycle instead.
//
// deno-lint-ignore-file no-explicit-any
import { loadConfig } from '../../../src/config.js';
import { SupabaseRest } from '../../../src/stores/supabase-client.js';
import { SupabaseStore } from '../../../src/stores/supabase-store.js';
import { SupabasePollLock } from '../../../src/stores/supabase-lock.js';
import { JobScheduler } from '../../../src/scheduler.js';
import { createStack } from '../../../src/providers/stack.js';
import { runCronCycle } from '../../../src/cron-cycle.js';

const env = (k: string) => (globalThis as any).Deno?.env?.get(k) ?? '';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Constant-time-ish comparison. The token is a shared secret, so a plain `!==`
 * would leak its length and prefix to a patient caller.
 */
function tokenMatches(given: string, expected: string) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

(globalThis as any).Deno?.serve?.(async (req: Request) => {
  const expected = env('POLL_TOKEN');
  if (!expected) return json({ ok: false, error: 'POLL_TOKEN is not configured on the function.' }, 500);

  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tokenMatches(bearer, expected)) return json({ ok: false, error: 'Unauthorized.' }, 401);

  let mode = 'jobs';
  try {
    const body = await req.json();
    if (body?.mode) mode = String(body.mode);
  } catch {
    /* no body is the normal cron case */
  }

  const startedAt = Date.now();
  const rest = new SupabaseRest({
    url: env('SUPABASE_URL'),
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    bucket: env('SUPABASE_BUCKET') || 'media',
  });
  const store = new SupabaseStore({ rest });
  const config = loadConfig();
  const lock = new SupabasePollLock(rest, {
    staleMs: (config.pollLockStaleMinutes ?? 20) * 60 * 1000,
  });

  try {
    await rest.ensureBucket();
    await store.hydrate();

    // Everything runs under the lock so two overlapping cron runs can never
    // spend provider quota on the same work.
    const got = await lock.withLock(
      async () => {
        if (mode === 'full') {
          // `restore: false` — Postgres is durable, so there is no wiped disk to
          // rebuild from HF on every ping.
          return { mode, ...(await runCronCycle(store, config, { lock, restore: false, owner: 'edge' })) };
        }
        const stack = createStack(store, config, { logger: console });
        const scheduler = new JobScheduler(rest, { store, config, stack });
        const synced = await scheduler.syncJobs();
        const worked = await scheduler.runDueJobs();
        return { mode, synced, ...worked };
      },
      { owner: 'edge' }
    );

    if (!got.acquired) {
      // Flush anyway: hydrate/flush is per-document, and nothing was mutated.
      return json({ ok: false, skipped: true, busy: true, heldBy: got.heldBy ?? null, ageMs: got.ageMs ?? null });
    }

    const flushed = await store.flush();
    return json({ ok: true, flushed, elapsedMs: Date.now() - startedAt, ...got.result });
  } catch (err: any) {
    // Persist whatever the partial run did learn — usage counters and circuit
    // state are worth keeping even when the poll itself blew up.
    let flushed = 0;
    try {
      flushed = await store.flush();
    } catch {
      /* nothing more we can do */
    }
    return json({ ok: false, error: String(err?.message || err), flushed, elapsedMs: Date.now() - startedAt }, 500);
  }
});
