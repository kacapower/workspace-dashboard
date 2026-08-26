# Gap Analysis — PRD v2 vs. Current Implementation

Maps every section of **`instagram_monitor_sustainable_architecture_prd_v2.md`** to the code that
exists today in this repo, with a status and a rough effort estimate for closing the gap.

- **PRD:** *Instagram Monitor — Sustainable Zero/Low-Cost Architecture PRD v2* (line numbers below refer to that file).
- **Current app:** Node 20 + Express, local-JSON storage, Apify-only provider, Hugging Face backup. See [README.md](README.md).
- **Generated:** 2026-08-24.

> ⚠️ **How this was assessed:** by *reading* the source, not running it. This machine has no
> Node/Python/Docker runtime installed, so the test suite could not be executed — "✅ Done" rows
> mean *implemented and correct on inspection*, not *test-verified here*.

---

## Legend

| Status | Meaning |
|---|---|
| ✅ Done | Implemented and broadly matches the PRD intent |
| 🟡 Partial | Something exists but misses key PRD requirements |
| ❌ Missing | No implementation |
| ➖ Decision | Blocked on a human decision (e.g. language/stack), not just coding |

| Effort | Rough size (1 dev, evolving the **Node** app) |
|---|---|
| S | < 1 day |
| M | 1–3 days |
| L | 3–7 days |
| XL | > 1 week |

---

## Scorecard

Across ~77 PRD requirements:

| Status | Count | Share |
|---|---:|---:|
| ✅ Done | ~10 | ~13% |
| 🟡 Partial | ~25 | ~32% |
| ❌ Missing | ~40 | ~52% |
| ➖ Decision | ~2 | ~3% |

**Read:** the *data / diff / notify / backup / auth* layers are ~½ built. The *cost-management,
provider-routing, and scheduling-intelligence* layers — the actual point of "v2 sustainable
architecture" — are ~0–10% built.

---

## Two decisions before any coding

1. **Language/stack** (PRD lines 58–72 say FastAPI/Python; this repo is Node/Express).
   - *Evolve Node* — keep the ~½ that works, add the new layers in JS. Lowest waste. **Recommended.**
   - *Rewrite in Python/FastAPI* — matches the PRD literally (Pydantic, the `InstagramProvider`
     interface as written) but discards working code (adds ~2–4 weeks of re-doing what exists).
   - Effort/status below assume **Evolve Node**. A Python rewrite reclassifies most 🟡 rows to ❌.

2. **Free-tier ceiling** — the *architecture* is fully buildable; some *monitoring targets* are not
   free (see next section). Decide the real intensity before building the scheduler around it.

---

## Free-tier reality caveats (context for the effort numbers)

| PRD ambition (line) | Reality |
|---|---|
| Critical "15–30 min" polling (129) | Apify free ≈ 300 results/mo; ~13 results per post-fetching poll → ~1 poll/day for one profile. Sub-hour polling is paid. |
| Follower/**unfollower** lists + diff (171–194, 597–615) | Follower *count* is cheap; the *list of who unfollowed* needs a heavy, rate-limited, **paid** scraper. Effectively not free for large accounts. |
| Stories monitoring (198–206) | Needs Apify RESIDENTIAL proxy = **pay-per-GB**, not free. |
| RapidAPI as a "free" provider (209–261) | Free RapidAPI IG tiers are tiny (~50–500 req/mo) and vary in reliability/TOS. |
| Supabase persistent state (549–571) | Free 500 MB is fine for metadata, but the project auto-pauses after ~1 week idle (separate from Render spin-down). |

---

## Foundation / Infrastructure

| PRD Section (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| Core Principle — observe cheaply → diff → escalate (21–31) | [src/poller.js](src/poller.js) | 🟡 | — | Per-profile intervals, private-account batching, save-or-reject media exist. No cost decision or provider routing — the "cost/priority decision" step in the pipeline is absent. |
| Target Architecture diagram (35–54) | — | ➖ | XL | Requires FastAPI-vs-Node call, plus Supabase + Provider Router layers that don't exist. |
| Backend: FastAPI + Python (58–72) | [src/server.js](src/server.js) | ➖ | XL* | Currently Node/Express. *XL only if rewriting; ~0 if reinterpreted as "any REST backend". |
| Render = compute; tolerate restarts (74–88) | [src/hf.js](src/hf.js), [src/server.js:388](src/server.js) | 🟡 | M | `restoreFromHF` on boot rehydrates media/history from HF (120 s timeout race). But primary state is local JSON under `data/` — **lost on every Render restart until HF restore runs**; no transactional DB. |
| Keep-Alive external cron ~14 min (90–93) | [.github/workflows/poll.yml](.github/workflows/poll.yml) | ✅ | S | Hourly GitHub Actions cron hits `/api/poll` with `x-poll-token`, waking the service. (Cadence is hourly, not 14 min — trivially configurable.) |

---

## Phase A — Cost Infrastructure

| PRD Section (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| CostManager (366–387, 922) | — | ❌ | L | The PRD's centerpiece. No per-provider/endpoint request counting, no `requests_today/month`, no `estimated_cost`, no `remaining_quota`. |
| Provider architecture + interface (209–233, 923) | [src/apify.js](src/apify.js), [src/poller.js:114](src/poller.js) | ❌ | L | Apify is hard-coded into the poller. No `providers/` dir, no `InstagramProvider` adapter interface, no RapidAPI adapter. |
| Provider Router + health score (237–261, 924–925) | — | ❌ | L | No success/latency/failure/quota tracking, no FREE→LOW→PREMIUM selection, no health score. |
| Quota limits daily/monthly (381–387, 926) | — | ❌ | M | No configurable per-provider `daily_limit`/`monthly_limit` enforcement. |
| Circuit breaker (265–284, 927) | — | ❌ | M | Repeated failures do not open a circuit; every poll retries the same provider. |
| Request cache + SWR (487–499, 929) | — | ❌ | M | No profile/story/follower TTL cache, no stale-while-revalidate. |
| Request coalescing (471–484, 930) | — | ❌ | S–M | No in-flight dedup; the private-account **ping** batches multiple usernames into one actor run ([poller.js:331](src/poller.js)) but that's not general coalescing. |
| Adaptive scheduler (430–451, 503–517, 931) | [src/poller.js:100](src/poller.js) | ❌ | L | `isDue` uses fixed per-profile intervals only. No quota-% back-off (70→2h, 85→4h…), no activity-based cadence. |
| Poll locks / concurrency (932) | [src/poller.js:200](src/poller.js) | 🟡 | S–M | A `lastPollStatus:'running'` flag exists and the loop is sequential, but there is **no real lock** — the internal `setInterval` scheduler and the GitHub cron can run `/api/poll` concurrently and double-spend quota. |
| Usage / budget dashboard (406–427, 933) | — | ❌ | M | No RapidAPI/Apify/LLM usage bars, no "quota exhausted in ~9 days" forecast. |
| Monitoring tiers Critical/Normal/Low/Archive (126–143) | — | ❌ | M | No `priority` field on profiles; only interval. |
| Priority-based quota allocation (455–468) | — | ❌ | M | Quota is not distributed by tier (no quota to distribute yet). |
| Smart provider fallback (533–546) | — | ❌ | M | No fallback exists at all today; needs router + cost gate first. |
| Emergency kill switch (390–403) | — | ❌ | S | No global "STOP ALL EXTERNAL API CALLS" flag. |
| Budget modes: Maximum Free / Balanced / Coverage (776–795) | — | ❌ | S | No mode concept; providers are simply on if a token is set. |
| Emergency low-quota mode (798–807) | — | ❌ | M | No "critical-only when quota near exhaustion" behavior. |

---

## Phase B — Data

| PRD Section (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| Supabase schema (549–571, 937) | [src/store.js](src/store.js) | ❌ | L | State is flat JSON files (`config.json`, `history.json`, `password.json`, `hf-manifest.json`). No Postgres, no `profiles/snapshots/events/poll_runs/...` tables. |
| Poll Run model (742–757, 938) | [src/poller.js:185](src/poller.js), [src/store.js:203](src/store.js) | 🟡 | M | Snapshots store `at/username/profile/posts/stories/changes/changeCount`. Missing the PRD `poll_id/started_at/completed_at/provider/requests_used/status/events_created/error` run record. |
| Event model (939) | [src/diff.js](src/diff.js) | 🟡 | M | `changes[]` embedded in each snapshot act as events, but there's no separate event entity, severity, or dedup. |
| Differential follower storage (597–615, 940) | [src/diff.js](src/diff.js) | ❌ | L | Only follower **count** is diffed. No base snapshot + daily deltas of follower **identities** (and provider-gated / costly — see caveats). |
| Media hashing / dedup (631–642, 941) | [src/poller.js:50](src/poller.js) | ✅ | S | Media named by SHA-256 (`sha8`, 8-char slice); re-download with same hash is skipped ("save or reject"). Minor: uses 8-char slice, and hash isn't persisted as metadata. |
| HF upload queue (645–664, 942) | [src/hf.js](src/hf.js), [src/notify.js:26](src/notify.js) | 🟡 | M | Debounced `syncToHF` on state change + post-poll, with retry-on-next-poll. Not a durable per-item queue: an in-flight batch interrupted by a restart is retried wholesale, and polling can still block on sync. |
| DB + media retention (575–594, 667–683, 943) | [src/retention.js](src/retention.js) | 🟡 | S–M | Media age-out by `RETENTION_DAYS` (avatars + JSON always kept). Missing A/B/C media tiers and any DB-side retention (raw responses/debug/short-term vs permanent). |
| Backup (944) | [src/backup.js](src/backup.js) | ✅ | S | Full + per-profile ZIP via `archiver`. |
| Restore (945) | [src/hf.js](src/hf.js), [src/server.js:388](src/server.js) | 🟡 | M | Boot-time `restoreFromHF` only. No user-triggered restore endpoint/UI, no Supabase restore path. |
| Data integrity tests (946) | [test/](test) | 🟡 | M | `store`/`diff` unit tests exist; no corruption/partial-write/round-trip integrity tests. |

---

## Phase C — Monitoring

| PRD Section (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| Story polling (198–206, 947) | [src/stories.js](src/stories.js), [src/poller.js:156](src/poller.js) | 🟡 | M | Fetch + stable-id dedup + download works well. Missing adaptive behavior: "story detected → temporarily poll faster until it expires" and "inactive account → reduce story polling". |
| Follower polling (171–194, 948) | [src/diff.js](src/diff.js) | 🟡 | L | Count only. No follower-list snapshot/diff, no per-tier snapshot cadence (1–2/day high-priority, daily normal). |
| HD avatar strategy (287–316, 949) | [src/poller.js:38](src/poller.js), [src/apify.js:73](src/apify.js) | 🟡 | S–M | Prefers `profilePicUrlHD`, best-effort URL upscale, hash + save-or-reject + change event. **Missing:** iterate `hd_profile_pic_versions` and pick max width (302), and store the metadata row (`image_hash/width/height/source_url/captured_at/storage_path`, 306–316). |
| Activity scoring (503–517, 950) | — | ❌ | M | No `activityScore`; cadence never adapts to activity. |
| Anomaly / burst detection (520–530, 951) | — | ❌ | M | No "+50/day → +10,000/day = anomaly" detection or priority bump. |
| Priority escalation (516, 952) | — | ❌ | M | No temporary priority increase for unusually active profiles. |
| Event engine (953) | [src/diff.js](src/diff.js) | 🟡 | M | Diff emits typed changes; no severity, aggregation, or event dedup layer. |
| Notification optimization (686–704, 954) | [src/telegram.js:24](src/telegram.js), [src/notify.js](src/notify.js) | 🟡 | M | Alerts fire only when something changed, and counts are aggregated into one message per profile ✅. Missing cross-poll **cooldowns** and time-windowed aggregation (still one message per poll per changed profile). |
| Daily digest (703, 955) | [src/telegram.js:44](src/telegram.js) | ✅ | S | `buildDigest` + `shouldSendDigest` at `SUMMARY_HOUR`, once/day. |
| Failure alerts w/ thresholds (707–721, 956) | [src/poller.js:249](src/poller.js) | ❌ | M | Failures are captured per-result and set `lastPollStatus`, but there's no per-profile `failure_count` and no escalating 1→3→5 notification ladder. |

---

## Phase D — Intelligence (LLM)

| PRD Section (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| LLM router — off for routine (320–347, 957) | — | ❌ | M | No LLM integration. PRD correctly wants it OFF for routine work; still needs the gated hook. |
| LLM budget: monthly/daily/per-profile (351–362, 958) | — | ❌ | M | No LLM budget accounting or auto-disable. |
| LLM anomaly analysis (334–339, 959) | — | ❌ | M | — |
| Context compression (960) | — | ❌ | M | — |
| Confidence scoring (961) | — | ❌ | S | — |
| Provider analysis (962) | — | ❌ | S | — |
| Natural-language reports (963) | — | ❌ | S–M | — |

> The whole Phase D is optional by design (PRD 362: "must never depend on the LLM for basic correctness").

---

## Phase E — UI

| PRD Section (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| Cost dashboard (406–427, 969) | — | ❌ | M | Needs CostManager first. |
| Profile dashboard (970) | [public/](public) | ✅ | — | Dashboard with stats + timeline + account tabs (per README). |
| Activity timeline (971) | [public/](public) | 🟡 | S | Timeline exists; no activity-score visualization. |
| Analytics (972) | [public/](public) | 🟡 | S–M | F1-style leaderboard/standings exist; no cost/quota analytics. |
| Provider health UI (973) | — | ❌ | S | Needs router first. |
| Storage dashboard (974) | [public/](public), [src/server.js:250](src/server.js) | ✅ | — | Data page: usage per profile, ZIP backups, retention, HF sync. |
| Notification rules (975) | [src/server.js:125](src/server.js) | 🟡 | M | Global alerts/summary toggles + hour only; no per-profile rules. |
| Settings (976) | [public/](public) | 🟡 | S | Config page exists; no modes/quota settings. |
| Mobile / Dark mode / Accessibility (977–979) | [public/](public) | 🟡 | S–M | Dark/light auto-follows system (README). Mobile + a11y not verified. |

---

## Cross-cutting: Freshness, Attribution, Offline

| PRD Section (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| Data freshness Fresh/Stale/Unavailable (724–739, 1081) | [src/server.js:44](src/server.js) | ❌ | M | `/api/status` exposes `lastPollAt`, but no per-metric freshness badge ("Followers: 125,421 — 4h ago — Stale"). |
| Cost attribution per profile (760–773) | — | ❌ | M | No per-profile call/cost counters or "Optimize this profile". |
| Offline mode banner (809–823) | [public/](public), [src/server.js](src/server.js) | 🟡 | S | Dashboard reads local/HF-restored JSON, so history/gallery/analytics degrade gracefully. No explicit provider-down detection or "Monitoring temporarily unavailable" banner. |

---

## Cross-cutting: Security (826–848)

| Requirement (line) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| Auth: Basic or session (830) | [src/auth.js](src/auth.js) | ✅ | — | scrypt password hash + HMAC-signed HttpOnly `SameSite=Lax` cookie, 30-day expiry, `timingSafeEqual`. |
| Secure secret handling (832) | [src/config.js](src/config.js) | 🟡 | S | Secrets read from env. Dev fallbacks exist for `SECRET`/`POLL_TOKEN` — fine, but should warn/refuse in production. |
| Secret masking + "never log tokens" (833, 840–847) | — | 🟡 | S | `/api/status` doesn't leak tokens ✅. No explicit masking layer or log-scrubber; `console.warn` on HF/stories errors surfaces messages (not tokens today, but unguarded). |
| Rate limiting (834) | — | ❌ | S | No rate-limit middleware on login or API. |
| Input validation (835) | [src/server.js:116](src/server.js) | ✅ | — | Username regex `^[a-zA-Z0-9._]{1,30}$`, numeric range checks on intervals/retention/hour. |
| Path traversal protection (836) | [src/server.js:367](src/server.js) | ✅ | — | Media route validates name regex + `startsWith(mediaDir/username + sep)`. |
| Provider token protection (837) | [src/config.js](src/config.js) | 🟡 | S | Env-only, not persisted to disk — adequate; no per-provider scoping yet. |
| Secret scanning (838) | — | ❌ | S | No CI secret-scan (`.gitignore` covers `.env`, but no gitleaks/CI check). |
| CSRF protection (839) | [src/auth.js:69](src/auth.js) | 🟡 | S–M | `SameSite=Lax` mitigates cross-site POSTs, but no CSRF token on state-changing endpoints. |

---

## Cross-cutting: Validation & Testing (851–917)

| Requirement (lines) | Current file(s) | Status | Effort | Notes |
|---|---|---|---|---|
| Provider response validation / Pydantic (851–864) | [src/apify.js:39](src/apify.js) | 🟡 | M | `normalizeProfile` is defensive (many field fallbacks) but not schema-validated. No "invalid response recorded rather than silently corrupting history" and no provider schema/version capture. |
| Unit tests (869–882) | [test/](test) | 🟡 | M | Present: `auth`, `diff`, `hf`, `poller`, `store`, `stories`. Missing: retention, config, budget manager, provider selection, date handling. |
| Integration tests (884–892) | — | ❌ | M | No end-to-end create→poll→notify→store→backup→restore tests. |
| Failure-simulation tests (894–906) | — | ❌ | M | No 403/429/500/timeout/invalid-JSON/missing-field/partial/outage/disk-error simulations. |
| Scheduler tests (908–917) | — | ❌ | M | No quota/priority/activity/prior-failure/story-state/concurrency tests. |
| Default free-tier config YAML (987–1032) | [src/config.js](src/config.js) | ❌ | S–M | Config is env-var based. No `mode/monitoring/providers/llm/storage/safety` YAML with per-provider enable + tier defaults. |

---

## Production Success Criteria (1066–1084) — current pass/fail

| Criterion | Met today? |
|---|---|
| Routine monitoring requires minimal API calls | 🟡 Intervals + private batching help; no quota-aware minimization |
| Duplicate requests eliminated | ❌ No cache/coalescing (only the private-ping batch) |
| Duplicate media uploads eliminated | ✅ SHA-256 save-or-reject |
| Duplicate notifications eliminated | 🟡 Per-poll aggregation; no cross-poll cooldown |
| Failed providers don't create false "changes" | 🟡 Errors are captured, but a partial/empty response could still diff oddly (no schema validation) |
| Quota exhaustion auto-reduces monitoring | ❌ No quota tracking |
| Premium providers can't activate accidentally | ❌ No provider/mode gating |
| Historical data survives provider failures | 🟡 Local JSON + HF backup survive; not a durable DB |
| Render restarts don't lose state | 🟡 Only via HF restore on boot; local `data/` is ephemeral |
| Large media doesn't overload Supabase | ➖ N/A (no Supabase); media already offloaded to HF |
| LLM usage is budget-controlled | ❌ No LLM |
| Dashboard shows data freshness | ❌ No freshness badges |
| All external calls observable + attributable | ❌ No per-profile call/cost attribution |

---

## Suggested sequencing (if you proceed, Node path)

The PRD's Phase A is correctly first — everything else leans on it. Concretely:

1. **Provider interface + Apify adapter** — refactor [apify.js](src/apify.js)/[poller.js](src/poller.js)
   behind an `InstagramProvider` so a router can choose. *(unblocks router, fallback, RapidAPI)*
2. **CostManager + quota counters + kill switch** — the smallest slice that makes "maximum free" real.
3. **Poll lock** — close the internal-scheduler-vs-cron double-spend before adding more callers.
4. **Adaptive + priority scheduler** — replace fixed `isDue` with tier + quota-% back-off.
5. **Persistence** — move state to Supabase (or at minimum make local JSON restart-safe); add the
   poll-run + event models.
6. Then Phase C monitoring depth, Phase E dashboards, and Phase D LLM last (optional).

**Rough order-of-magnitude for full v2 (solo, evolving Node):** ~10–16 weeks. A Python/FastAPI
rewrite adds ~2–4 weeks to re-create what already works.

---

## Environment note

No Node/Python/Docker runtime is installed on this machine (only git + curl), so this app can't be
run or its tests executed here yet. Installing **Node ≥ 20** is the minimum to run/verify the
existing code before extending it.
