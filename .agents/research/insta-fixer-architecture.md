# Insta Fixer Architecture
## What was researched
The current repository structure.
## Source
Local source code analysis (package.json, src/, public/).
## Date accessed
August 27, 2026
## Relevant observations
- **Framework:** Vanilla JS frontend (`public/app.js`), NodeJS/Express backend (`src/server.js`).
- **Database:** Supabase/PostgreSQL (inferred from `.env.example` and `src/config.js` / `src/auth.js`).
- **Frontend:** `public/index.html` and `public/styles.css`. No React, just vanilla DOM manipulation.
- **Backend:** Express API, polling mechanism (`src/poller.js`, `src/cli-poll.js`), Apify integration (`src/apify.js`).
- **Alerts:** Telegram integration (`src/telegram.js`).
- **Security:** Password locked dashboard.
## UI pattern
- Current UI is likely a basic HTML/CSS dashboard.
## UX reasoning
- Built as a functional tool first.
## How the pattern could apply to Insta Fixer
- The redesign will happen purely in standard HTML/CSS/JS or we will introduce a new approach if permitted, but since we are modifying standard frontend, we must apply the new design system to `styles.css` and `app.js`.
## What should NOT be copied
- N/A.
## Implementation implications
- Need to write vanilla JS/CSS for the UI update, keeping the API endpoints intact.
