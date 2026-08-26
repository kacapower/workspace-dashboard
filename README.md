---
title: Insta Fixer
emoji: 📸
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---
# Instagram Monitor

A password-locked app that watches **multiple Instagram profiles** and records **everything that changes** — profile picture, bio, display name, follower counts, website, new posts, and stories/highlights — polling periodically via the [Apify](https://apify.com) Instagram scraper actors.

- **Public profiles:** full details + posts are tracked. New posts are only kept if they were made *after* the profile was added (tick **Download previous posts** when adding to also backfill older ones).
- **Private profiles:** only the profile picture is fetchable, so the monitor tracks avatar changes only — and **batches** them to a slower cadence (`POLL_BATCH_HOURS`, default 6h) to save credits. The avatar is downloaded and stored by its content hash — each poll re-downloads it, and if the hash matches the saved image it is *rejected* (no duplicate saved); if the hash differs it is *saved* as a new image and logged as a change.
- **Stories & highlights:** each poll fetches current stories + highlights and immediately saves anything new (by story id, so the same story is never re-downloaded).
- **Custom intervals:** pick from 1, 2, 3, 4, 6, 8, 12 or 24 hours globally, or set a custom "every Xh" per profile (Auto falls back to the global interval, or the 6h batch for private accounts).
- **F1-style leaderboard:** standings table ranking profiles by activity (total changes, new posts, stories, avatar changes, follower growth) with a time-window picker (All-time / 7 / 30 days) and sortable columns.
- **Account navigation:** tabs at the top of the dashboard switch between "All" and each individual `@username`.
- **5 pages (sidebar):** Dashboard (stats + timeline), Leaderboard, Config (profiles, intervals, polling status, Telegram alerts), Data (storage usage, ZIP backups, 7-day retention, Hugging Face sync), and a media Gallery.
- **Profile rename:** rename a profile and the local media folder, history, and Hugging Face folder all follow the new name.
- **Data retention:** posts/stories media older than `RETENTION_DAYS` (default 7) are auto-deleted to save storage — avatars are never deleted and JSON history is always kept. You can download a full or per-profile ZIP backup before they age out.
- **Hugging Face backup:** after every poll, each person's data is pushed to your dataset as a folder per person (`<user>/profile.json`, `<user>/history.json`, `<user>/media/*`). Failed uploads retry on the next poll. Runs entirely via your `HF_TOKEN`.
- **Telegram alerts:** get a message when a tracked profile changes, plus a configurable daily summary — sent to one or more chat/user IDs via your bot token.
- **Dark / light mode:** follows your system theme automatically.
- All data is stored locally on the host under `data/` (JSON snapshots + downloaded images).
- The dashboard is locked behind a password you set on first run.
- Runs anywhere: locally, or free on Render/Railway/Fly with the included hourly GitHub Actions cron.

## How it works

```
External cron (GitHub Actions / cron-job.org / pg_cron)
   │  POST /api/poll  (x-poll-token)      ── or ──  npm run poll on a CI runner
   ▼
Poll lock (atomic; one cycle at a time, 409 otherwise)
   ▼
Cost manager ──► budget mode + daily/monthly quota + kill switch  (persisted: usage.json)
   ▼
Provider router ──► cheapest healthy provider that supports the feature
   │                 circuit breaker skips a provider that keeps failing
   ▼
Apify actor(s)
   │   apify/instagram-scraper         → profile + latest posts
   │   oneary/instagram-stories-…      → stories + highlights (if enabled)
   ▼
Private? ──► batched (6h) ──► avatar only ──► download → hash → same as saved? reject : save as change
   │
   ▼
Change detection (diff vs. last snapshot) ──► save snapshot + download new media
   ▼
Telegram alert ──► Hugging Face backup ──► retention prune
   ▼
Password-locked web dashboard (account tabs, before/after avatars, new posts, saved stories)
```

## 1. Run locally

```bash
cd instagram-monitor
npm install
cp .env.example .env        # add your APIFY_TOKEN
npm start                   # http://localhost:3000
```

Open the site, set a password, then add Instagram usernames or profile links (e.g. `@natgeo`, `https://instagram.com/natgeo`). Untick **Download previous** to only track posts made after today. Pick a poll interval and hit **Save interval**, then **Run poll now**. You can add and remove profiles at any time; private profiles are tracked for avatar changes only and are checked on a slower 6-hour batch.

> **Apify token:** free at https://console.apify.com → Account → Integrations → API token.
> The default actor is the official `apify/instagram-scraper`. It works without login for public profiles and returns the profile card (avatar, bio, counts) for private accounts. It is **pay-per-result**: the free plan includes ~300 results/month, then ~$2.70 per 1,000 results. One poll of a profile with 12 recent posts costs ~13 results, so hourly polling of a few profiles adds up — set `POLL_INTERVAL_HOURS` higher (and leave private accounts on the 6h batch) to stay within the free allowance.
> **Stories** use a separate actor (`oneary/instagram-stories-and-highlights-scraper`) which requires Apify's **RESIDENTIAL proxy** (pay-per-GB, ~$0.45/GB) — Instagram blocks its default proxy. Leave `APIFY_STORIES_ACTOR` empty to disable story tracking entirely.

## 2. Deploy free + always polling

Free hosts sleep when idle, so **an external cron must be the trigger** — never the in-process timer. Set `CRON_MODE=1` to disable that timer entirely; then one cron hit does the whole cycle in-request:

```
restore (only if the disk was wiped) → fetch → diff → persist → alert → back up to HF → prune
```

The whole cycle runs under a filesystem lock, so an overlapping cron run or a manual **Run poll now** can never spend Apify quota twice for the same work (the second one gets HTTP 409).

Two topologies. The workflow at **`.github/workflows/poll.yml` in the repo root** does both — pick one with the repo variable `POLL_MODE` (GitHub only runs workflows from the repo root, never from a subfolder):

**A. `POLL_MODE=compute` — GitHub Actions is the compute (recommended, nothing needs to stay awake).**
The runner checks out the repo, restores state from the Hugging Face dataset, polls, alerts, syncs back, and exits. Requires `HF_TOKEN` + `HF_DATASET` — the runner has no persistent disk, so that dataset *is* your database (the workflow fails fast if it's missing). The web dashboard becomes optional and may sleep forever.

**B. `POLL_MODE` unset (`ping`) — cron wakes the web host.**
Deploy with the included `render.yaml`, set `CRON_MODE=1` and a strong `POLL_TOKEN`, then set the repo variable `MONITOR_URL` and secret `POLL_TOKEN`. The workflow POSTs to `/api/poll`, retrying with backoff because a spun-down free instance needs ~30–60 s to cold start, and treats a 409 (poll already running) as success. Any scheduler works:

```bash
curl -X POST -H "x-poll-token: $POLL_TOKEN" https://your-app.onrender.com/api/poll
```

Render's own cron jobs are a paid feature, so use GitHub Actions / cron-job.org / UptimeRobot to send the request.

### Free hosting reality check

| Platform | Verdict |
|---|---|
| **GitHub Actions** | Best free option. 2,000 min/month on private repos, unlimited on public. Scheduled workflows are disabled after 60 days of repo inactivity, and cron times are best-effort. |
| **Render free** | Fine for the *dashboard*. Sleeps after ~15 min idle and the disk is **ephemeral** — state survives only via the HF backup/restore. Cron is paid. |
| **Oracle Cloud always-free** | ARM VM that never sleeps, with a real persistent disk. Most capable, but needs manual setup and a card on file. |
| **Supabase** | `pg_cron` + `pg_net` can trigger the endpoint on a schedule; free Postgres doubles as durable storage. |
| **Cloudflare Workers** | Cron Triggers are free and reliable, but there is no `fs` — the store would need rewriting onto D1/R2. |
| **Fly / Railway / Vercel** | Not meaningfully free for this. Vercel Hobby cron fires **once a day**. |

## Cost control

Every external call is gated by a persisted cost manager, because with an external cron each hit is a fresh process — in-memory counters would reset and enforce nothing. All quota, health and circuit state lives in `data/usage.json`, which is included in the HF backup.

- **Budget modes** (`BUDGET_MODE`): `maximum_free` (default — never exceeds the vendor's free allowance), `balanced` (up to configured paid limits), `maximum_coverage` (premium providers allowed).
- **Adaptive throttling.** As the monthly budget fills, every profile's interval stretches (×2 at 70%, ×4 at 85%, ×12 at 95%, stop at 100%), so quota lasts to month end instead of running dry mid-cycle.
- **Circuit breaker.** Three consecutive provider faults open the circuit for 15 minutes; it then allows one trial request. A missing account is never counted as the provider's fault.
- **Kill switch.** `POST /api/budget {"killSwitch":true}` halts every external API call while leaving the dashboard fully usable.
- **Daily vs monthly.** `APIFY_MONTHLY_UNITS` is the real budget; `APIFY_DAILY_UNITS` is only a burst guard. It must stay above the largest single day of legitimate work (one 20-post poll ≈ 21 units plus a 30-post went-public backfill ≈ 31), because a daily cap below an operation's estimate blocks that operation permanently, not just for today.


## Environment variables

| Variable | Default | Description |
|---|---|---|
| `APIFY_TOKEN` | *(required)* | Apify API token |
| `APIFY_ACTOR` | `apify/instagram-scraper` | Apify actor used to scrape the profile |
| `APIFY_STORIES_ACTOR` | *(empty = off)* | Actor for stories/highlights (`oneary/instagram-stories-and-highlights-scraper`) |
| `APIFY_STORIES_PROXY` | *(empty)* | Proxy group for the stories actor (`RESIDENTIAL` works) |
| `INSTAGRAM_SESSION` | *(optional)* | Login cookie for actors that need it |
| `HF_TOKEN` | *(empty = off)* | Hugging Face token for dataset backups |
| `HF_DATASET` | *(empty)* | Dataset repo id, e.g. `yourname/instagram-monitor` |
| `TELEGRAM_BOT_TOKEN` | *(empty = off)* | Bot token for change alerts + daily summary |
| `TELEGRAM_USER_IDS` | *(empty)* | Comma-separated chat/user IDs to send alerts to |
| `RETENTION_DAYS` | `7` | Delete media older than this (avatars + JSON always kept) |
| `SUMMARY_HOUR` | `9` | Hour (0–23) for the daily Telegram summary |
| `SECRET` | dev value | Signs login cookies; set a long random string |
| `POLL_TOKEN` | dev value | Allows the external cron to trigger polls |
| `POLL_INTERVAL_HOURS` | `1` | Default poll interval for public profiles |
| `POLL_BATCH_HOURS` | `6` | Slower interval private accounts are checked on |
| `PORT` | `3000` | Web port (hosts set this) |
| `DATA_DIR` | `./data` | Where snapshots + media are stored (must be persistent on the host) |
| `CRON_MODE` | `0` | `1` disables the in-process timer so an external cron is the only trigger |
| `POLL_LOCK_STALE_MINUTES` | `20` | Break an abandoned poll lock after this long (host killed mid-poll) |
| `BUDGET_MODE` | `maximum_free` | `maximum_free` \| `balanced` \| `maximum_coverage` |
| `APIFY_MONTHLY_UNITS` | `300` | Monthly result budget — the real limit |
| `APIFY_DAILY_UNITS` | `60` | Daily burst guard (must exceed one poll + one backfill) |
| `APIFY_FREE_UNITS` | `300` | Vendor free allowance; the hard ceiling in `maximum_free` |
| `PROVIDER_APIFY_ENABLED` | `1` | Set `0` to disable the provider entirely |
| `CIRCUIT_FAILURE_THRESHOLD` | `3` | Consecutive provider faults before the circuit opens |
| `CIRCUIT_COOLDOWN_MINUTES` | `15` | How long the circuit stays open before a trial request |

## Security notes

- Passwords are stored as salted scrypt hashes; sessions use HMAC-signed HttpOnly cookies.
- `/api/status` hides the tracked username until you log in; all data and media endpoints require the password.
- On Render free, the instance shuts down when idle **and the disk is ephemeral** — set `CRON_MODE=1` and configure the Hugging Face backup, or state is lost on every redeploy.
- Keep `POLL_TOKEN` and `SECRET` out of the repo (use host env vars / GitHub secrets).

## API

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /api/status` | public (profile list hidden) | Locked state, tracked profiles, poll status |
| `POST /api/setup` | first run only | Set the password |
| `POST /api/login` / `logout` | public | Login / logout |
| `POST /api/config` | password | Set the poll interval |
| `POST /api/config/profiles` | password | Add a profile (`username`, `backfill`, `trackStories`) |
| `PATCH /api/config/profiles/:username` | password | Toggle `backfill` / `trackStories` / set `intervalHours` (null = auto) |
| `POST /api/config/profiles/:username/rename` | password | Rename a profile (media, history, HF folder follow) |
| `DELETE /api/config/profiles/:username` | password | Stop tracking a profile |
| `POST /api/poll?force=1` | password **or** `x-poll-token` | Run the full cron cycle (409 if one is already running; `restore=1` to pull from HF first) |
| `GET /api/usage` | password | Quota, spend, health, circuit state + burn-rate forecast |
| `POST /api/budget` | password | `{ mode }` and/or `{ killSwitch }` |
| `POST /api/providers/:name/reset` | password | Manually close an open circuit |
| `GET /api/backup` / `/api/backup/:username` | password | Download full or per-profile ZIP backup |
| `GET /api/data/usage` | password | Storage usage per profile |
| `POST /api/data/cleanup` | password | Delete old media now (respects retention) |
| `POST /api/hf/sync` | password | Push data to Hugging Face now |
| `POST /api/alerts/test` | password | Send a test Telegram message |
| `GET /api/media/all` | password | List all media for the gallery |
| `GET /api/history` | password | All snapshots & changes |
| `GET /api/media/:username/:file` | password | Saved images (avatars, posts, stories) |

## Tests

```bash
npm test
```

Coverage: password hashing/verification, session tokens/cookies, the profile change-diff logic (avatar, fields, new/removed posts), and the multi-profile store (add/remove/dedupe + legacy config migration).