> **STATUS (updated): all code work in §4 is COMPLETE. `node --test` passes 116/116.**
> Only deployment remains — it is blocked on credentials, see §9 and the
> "Completion report" at the end of this file. Sections 2 and 4 below describe the
> state *before* that work and are kept for reference.

# HANDOFF — Instagram Monitor → Supabase + Vercel port

**Project root:** `C:\Users\unive\OneDrive\Desktop\claude\testapikey2\instagram-monitor\`

**Status as of this handoff:** the storage abstraction is complete and verified
(`node --test` → **98 pass / 0 fail**, 4.98s). The Supabase backend classes and
schema exist but are **not yet wired into the app** — nothing imports them yet.

Node lives at `C:\Program Files\nodejs` but is **not on the Git Bash PATH**.
Prefix shell commands with:

```bash
export PATH="/c/Program Files/nodejs:$PATH"
```

Python is genuinely not installed. Docker, Supabase CLI and Vercel CLI are not
installed either — the intent is to deploy via `npx supabase` against the hosted
project rather than run a local stack.

---

## What this app does

A password-locked Instagram profile monitor. It polls tracked accounts through a
multi-provider failover stack, diffs each snapshot against the last, downloads
media, alerts via Telegram, and archives to a Hugging Face dataset.

Four providers with automatic failover when one runs out of credit:
`rapidapi` (free) → `apify` → `brightdata` → `lobstr`. Provider selection is
cheapest-tier-first with health scoring, quota gating and a circuit breaker.

### Target architecture for the port

- **Supabase** — Postgres for state, Storage for media, one Edge Function for the poll
- **Vercel** — static dashboard + `/api/*` functions, free custom domain
- **GitHub Actions** — cron ping every ~30 min (public repo → unlimited minutes)
- **Hugging Face** — unchanged; permanent append-only archive

Decisions already locked with the user:

- Media goes to Supabase Storage (working set, pruned by retention) **and** HF (permanent archive)
- An **unchanged avatar is logged as a row**, not stored as duplicate bytes
- Dashboard API on **Vercel**, not Supabase — keeps login same-origin, avoids third-party-cookie issues, keeps provider secrets server-side
- Cron cadence every ~30 min on a **public** repo
- User supplies all credentials later; **placeholders only, never hardcode a key**
- **HF dataset writes are irreversible** — "If onething pushed to Dataset can't be deleted"

---

## Files created this session (all new, all complete)

| Path | Purpose |
|---|---|
| `src/stores/base-store.js` | `BaseStore` — all backend-agnostic domain logic (config, profiles, history, snapshots, password, HF manifest, change events). Declares the primitives a backend must implement. |
| `src/stores/fs-store.js` | `FsStore extends BaseStore` — local filesystem. Byte-for-byte the old behaviour. Keeps `mediaDir` + `mediaPathFor()` for fs-native callers. |
| `src/stores/supabase-client.js` | `SupabaseRest` — dependency-free `fetch` wrapper for PostgREST + RPC + Storage. Runs unchanged in Node, Deno and the test runner. |
| `src/stores/supabase-store.js` | `SupabaseStore extends BaseStore` — hydrate/run/flush with dirty-tracking; media over Supabase Storage; `logAvatarCheck()`. |
| `src/stores/supabase-lock.js` | `SupabasePollLock` — Postgres poll lock, same surface as the file lock. |
| `supabase/migrations/0001_init.sql` | Tables `app_state`, `jobs`, `avatar_checks`, `poll_lock`; RPCs `try_acquire_poll_lock`, `release_poll_lock`, `claim_due_jobs`; RLS on everything with nothing granted to `anon`. |

## Files modified this session

| Path | Change |
|---|---|
| `src/store.js` | Gutted to a re-export: `export { FsStore, FsStore as Store }`. All 8 test files, `server.js` and `cli-poll.js` import it unchanged. |
| `src/providers/lobstr-provider.js` | Injectable `sleeper`; `waitForRun` restructured to poll-before-sleep. Fixed a 5s-per-test stall and a production latency bug. |
| `test/backup-providers.test.js` | 30 tests covering the three backup providers, `normalize.js`, and the credit-exhaustion failover path. |

---

## The one design constraint that governs everything

`readJson` / `writeJson` on `Store` are **synchronous**, and they are called from
inside `CostManager.canSpend()` / `record()` and `CircuitBreaker` — which are in
turn called from the middle of `ProviderRouter.call()`.

Making them async would ripple through the entire router and invalidate all 98
tests. So `SupabaseStore` instead does:

```js
await store.hydrate();   // one request, all documents → memory
// ...existing synchronous logic runs completely unchanged...
await store.flush();     // one request, only mutated documents
```

**Do not make the Store interface async.** If you need a new backend, implement
`readJson` / `writeJson` / `putMedia` and follow the same pattern.

`SupabaseStore.readJson` deliberately **throws** if called before `hydrate()`.
A silent fallback there would look like "no profiles configured" and the poll
would quietly do nothing forever.

### Accepted limitation

Flushing is per-document, not per-field. A dashboard write landing mid-poll can
be clobbered by the flush. The poll lock serialises polls against each other; a
concurrent dashboard edit of the same document is the remaining window. If it
becomes a real problem, split `profiles` into its own table with row-level writes.

### Supabase Edge Function limits (doc-verified)

- **2s CPU** per request — excludes async I/O. Avatar hashing is ~1ms, a non-issue.
- **150s wall clock** free tier — this bounds the **worker**, not one request.
- 256MB memory, 150s idle timeout → 504, 100 functions on Free.
- Free plan: 500MB DB, 1GB Storage, 5GB egress, 500k invocations.
- Free projects pause after ~7 days idle — the regular cron ping prevents this.

Because 150s bounds the worker, a full poll of many accounts cannot be one
invocation. Hence the `jobs` table: each ping claims due jobs, works to a ~100s
budget, and returns the rest to the next ping.

---

## What still needs doing

Ordered by dependency. Steps 1–4 are the critical path to "Supabase build complete".

### 1. Port `poller.js` media writes to the async store API — REQUIRED

`src/poller.js:54` `downloadTo()` currently does:

```js
const full = store.mediaPathFor(username, name);
if (!fs.existsSync(full)) { fs.writeFileSync(full, buf); }
```

Replace with the backend-agnostic calls, which both stores implement:

```js
if (!(await store.hasMedia(username, name))) {
  await store.putMedia(username, name, buf);
} else if (kind === 'avatar') {
  await store.logAvatarCheck?.(username, sha8(buf), false);
}
```

Note the content-hash naming (`${kind}-${sha8(buf)}.${ext}`) **already**
implements the user's "hash, compare, save only if different" requirement — the
only addition is the `avatar_checks` row on an unchanged hash. Do not add new
hashing logic. `sha8` is at `src/poller.js:13`.

`src/poller.js:79` is the only `mediaPathFor` caller.

### 2. Fix two bugs that contradict the multi-provider failover — REQUIRED

Both still assume Apify is mandatory:

- **`src/poller.js:254`** — `if (!config.apifyToken) throw new Error('APIFY_TOKEN is not set...')` aborts the whole poll even when RapidAPI alone could serve every request. Gate on "no provider is enabled" instead.
- **`src/poller.js:184`** — stories are gated on `config.storiesActor`, which is an *Apify actor id*. So RapidAPI stories never run unless an unrelated Apify actor is also configured. Gate on `FEATURE.STORIES` being offered by any enabled provider.

### 3. Make `retention.js` and the two media routes backend-agnostic — REQUIRED

These are the only remaining fs-only paths the Edge Function and Vercel API need:

- `src/retention.js:21` — walks `store.mediaDir` with `fs`. Rewrite over `store.listMedia()` + `store.deleteMedia()`. Keep the rule: `avatar-*` files are never pruned.
- `src/server.js:384` `GET /api/media/all` — rewrite over `store.listMedia()`.
- `src/server.js:424` `GET /api/media/:username/:file` — rewrite over `store.getMedia()`, streaming bytes. Keep the existing filename regex validation; it is the path-traversal guard.

Leave `src/hf.js` and `src/backup.js` on `fs` for now — they only run on a Node
host with a real disk. `SupabaseStore.mediaDir` is `null` specifically so these
callers can detect the unsupported backend.

### 4. Edge Function — `supabase/functions/poll/index.ts`

Thin Deno wrapper, all domain logic stays in `src/` so it remains testable under
`node --test`:

1. Verify `POLL_TOKEN` from the request header against the function secret
2. Construct `SupabaseStore` + `SupabasePollLock`
3. `await store.hydrate()`
4. `await runCronCycle(store, config, { lock, owner: 'edge' })`
5. `await store.flush()`

`src/cron-cycle.js:20` currently hardcodes `createPollLock(config)` → the fs
lock. Add an injectable `lock` option; the signature is already
`runCronCycle(store, config, { force, restore, cleanup, owner, poller })`.

Deno node-compat covers `node:crypto`, `Buffer` and `AbortSignal.timeout`, all
of which this code uses.

Also: `restoreFromHF` (`src/hf.js:281`) exists to rebuild state after an
ephemeral disk wipe. Postgres is durable, so that path is dead weight for state —
keep it only for media re-hydration.

### 5. Vercel entry — `api/index.js` + `vercel.json`

**`src/server.js:17` already exports `createApp({ config, store })`.** Do not port
the 24 Express routes individually — mount the existing app in one catch-all
function. Vercel Hobby caps you at 12 functions anyway.

```js
// api/index.js
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { SupabaseStore } from '../src/stores/supabase-store.js';

const config = loadConfig();
const store = new SupabaseStore({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
const app = createApp({ config, store });

export default async function handler(req, res) {
  await store.hydrate();
  res.on('finish', () => { store.flush().catch(() => {}); });
  return app(req, res);
}
```

`vercel.json` serves `public/` statically and routes `/api/*` to the function.
`src/auth.js` ports unchanged — same-origin cookies, no CORS. `public/app.js`
needs no changes as long as API paths stay identical.

Vercel Hobby: free custom domain, auto HTTPS, ~10s function timeout,
non-commercial use only per ToS.

### 6. Scheduler — `src/scheduler.js`

`claimDueJobs(limit)` via the `claim_due_jobs` RPC → run each through the
existing `pollProfile` path → reschedule `due_at`. Cadences from the user's
original spec: **avatar 2h, stories 3h, posts 12h**, plus backfill-on-add.
Time-budget the loop at ~100s and return the remainder to the next ping.

### 7. GitHub Actions — `.github/workflows/poll.yml`

`cron: '*/27 * * * *'` — off-zero to dodge the scheduler's peak-load lateness.
`POLL_TOKEN` in Actions secrets.

**Gotcha to document:** scheduled workflows are auto-disabled after 60 days of
repo inactivity. This will silently kill the pipeline.

### 8. Tests to add

- `test/supabase-store.test.js` — hydrate/flush round-trip; dirty-tracking flushes only mutated documents; `readJson` before `hydrate` throws. Inject a fake `fetcher` into `SupabaseRest`, exactly as `test/backup-providers.test.js` does for providers.
- `test/scheduler.test.js` — due-job selection honours 2h/3h/12h; the time budget stops the loop; failed jobs reschedule with backoff.

---

## Deployment checklist (needs the user's Supabase token, not yet provided)

1. `npx supabase link --project-ref <ref>`
2. `npx supabase db push` — applies `0001_init.sql`
3. Create a **private** Storage bucket named `media` (or call `rest.ensureBucket()` once)
4. `npx supabase functions deploy poll`
5. Set function secrets: `POLL_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, plus whichever provider keys the user supplies
6. `curl` the function with the poll token; confirm rows land in `app_state` / `jobs` / `avatar_checks`
7. Deploy to Vercel, set the same env vars, log in end-to-end
8. Confirm dev tools show **no** provider credentials — this was the user's stated reason for the whole architecture

## Before making the repo public

The 30-min cron cadence assumes a public repo for unlimited Actions minutes.
`.gitignore` already covers `.env`, `data/`, `*.log` — verified. Before flipping
visibility, confirm no credential was ever committed, and keep every secret in
Actions secrets / Vercel env vars / Supabase function secrets.

## Known unverified items

- Bright Data's snapshot-monitor path (`GET /datasets/v3/snapshot/{id}?format=json`, 202 = still running) is the standard v3 path but was **not** doc-verified. Trigger and sync-scrape **are** verified. `BRIGHTDATA_BASE_URL` is env-overridable if it turns out wrong.
- RapidAPI has no canonical Instagram API, so host and all paths are env-driven with a plausible default.
- **Under the default `BUDGET_MODE=maximum_free`, `brightdata` and `lobstr` are skipped entirely** — `monthlyCeiling()` resolves to 0 because their `freeUnitsPerMonth` is 0. `BUDGET_MODE=balanced` or a non-zero `*_FREE_UNITS` is required to actually use them. This surprises people; `test/backup-providers.test.js` pins it.

## Reference

Full approved plan: `C:\Users\unive\.claude\plans\iterative-swinging-marble.md`

---

# Completion report

`node --test` → **116/116 pass** (98 pre-existing + 18 new). Every item in §4 is done.

| # | Item | Notes |
|---|---|---|
| 1 | `base-store.js` no-op `hydrate`/`flush`/`logAvatarCheck` | Plus a shared `mediaContentType()` helper, since `res.sendFile` no longer infers the type. |
| 2 | `poller.js` `downloadTo()` over the async media interface | Logs an unchanged avatar instead of re-storing identical bytes. `import fs` removed. |
| 3 | APIFY_TOKEN abort — **fixed** | Gates on `providerOffers(ctx, FEATURE.PROFILE)`, so RapidAPI alone is enough. |
| 4 | Stories gated on an Apify actor id — **fixed** | Gates on `providerOffers(stack, FEATURE.STORIES)`. Same bug fixed in `/api/status`'s `storiesEnabled`. |
| 5 | `retention.js` over `listMedia`/`deleteMedia` | Now async; lists per tracked profile, preserving "untracked leftovers are never touched". |
| 6 | `server.js` media routes backend-agnostic | Guards kept and tightened into `isSafeMediaPath()`. |
| 7 | `cron-cycle.js` injectable lock | `{ lock }` option, defaulting to `createPollLock(config)`. |
| 8 | `supabase/functions/poll/index.ts` | Constant-time token check; job-queue mode by default, `{"mode":"full"}` for the legacy cycle. Flushes even on error. |
| 9 | `src/scheduler.js` | `JobScheduler` + `CADENCE_HOURS` (avatar 2h / stories 3h / posts 12h), backfill-on-add, ~100s budget, backoff capped at 60 min. |
| 10 | `api/index.js` + `vercel.json` | Mounts `createApp()` as one catch-all function. |
| 11 | `.github/workflows/poll.yml` | Plus `keepalive.yml` for the 60-day auto-disable. |
| 12 | `test/supabase-store.test.js` | 7 tests. |
| 13 | `test/scheduler.test.js` | 11 tests. |

## Deviations from the plan, and why

- **`cleanupOldMedia` had a third caller** the plan missed: `POST /api/data/cleanup`
  in `server.js`. Now awaited. `GET /api/data/usage` also walked `store.mediaDir`
  with `fs` and was ported to `listMedia()` for the same reason.
- **Cron is `13,43 * * * *`, not `*/27 * * * *`.** `*/27` fires at minute 0 —
  exactly the peak-load minute the plan wanted to dodge — and spaces runs
  27/27/6 minutes apart. Two off-peak minutes give an even 30-minute gap.
- **`isSafeMediaPath()` also rejects a `.`/`..` username.** The old regex allowed
  it, and `FsStore.getMedia` path.joins the username onto the media root, so
  `..` would have escaped the tree. `/` and `\` were already excluded.
- **`pollProfile` is now exported and takes `{ tasks }`.** The scheduler must run
  one task without the others; omitting the option does all of them, so the
  whole-account `poll()` path is byte-identical. A skipped task carries the
  previous snapshot's value forward, so the diff does not report a phantom
  avatar change or mass post removal.
- **`supabase/functions/poll/deno.json` was needed.** `src/config.js` does
  `import 'dotenv/config'`, a bare npm specifier Deno cannot resolve unaided.
- **`api/index.js` serialises requests** through a promise chain: `readJson`/
  `writeJson` are sync over one in-memory map, so two concurrent invocations on a
  warm instance could otherwise flush half-applied state.

## What is NOT done

**Deployment only.** No Supabase token was provided, and no Docker / Supabase CLI
/ Vercel CLI is installed locally, so nothing was pushed to a hosted project.
Follow §9. Two things to verify on first deploy:

1. The **private `media` bucket** — `ensureBucket()` creates it on the Edge
   Function's first run; confirm it came out private, not public.
2. **`BUDGET_MODE`** — the §8 gotcha still applies: the `maximum_free` default
   resolves Bright Data's and Lobstr's ceilings to 0, so those two are skipped
   entirely until you set `BUDGET_MODE=balanced` or non-zero free-unit counts.

Not attempted, and still worth a look (both flagged in §10): the `src/auth.js:33`
`sign()` oddity, and porting `hf.js`/`backup.js` off `store.mediaDir` if HF
archiving ever needs to run from the Edge Function.
