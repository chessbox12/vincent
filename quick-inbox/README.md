# Quick Inbox

A tiny, mobile-first web app that creates a **temporary email address** in one
tap and surfaces the verification code a website sends you — no accounts, no
tokens to manage, no terminal. It is a thin, static front end for the public
[Mail.tm](https://mail.tm) API and runs entirely in your browser.

> ⚠️ Temporary inboxes are **not** suitable for banking, healthcare, password
> recovery or any important account. Some websites also reject disposable email
> domains even after sending a code.

## What it does

1. **Create temporary inbox** — fetches a live Mail.tm domain, generates a random
   address and password in your browser, and signs in.
2. Shows the address with a one-tap **Copy** button.
3. Auto-checks for new mail every ~9 seconds while the tab is open (and backs off
   when the tab is hidden or when Mail.tm rate-limits).
4. Extracts the most likely **verification code** from the newest email and shows
   it prominently with **Copy code**. Older codes are clearly labelled as older.
5. Opens any message in a **safe plain-text view** (raw email HTML is never
   injected into the page).
6. Remembers the inbox across page reloads and **renews an expired login
   automatically**. A **Forget this inbox** action clears everything from the
   device.

No cookies, no analytics, no backend, no secrets in the repository. Fresh
credentials are created in the browser every time — nothing is hardcoded.

## Files

```
quick-inbox/
├── index.html            # markup and states
├── styles.css            # dark-navy, indigo-accented, mobile-first styling
├── app.js                # API layer + verification-code logic + UI (no dependencies)
├── config.js             # sets the Mail.tm relay URL (see "Reaching Mail.tm")
├── cloudflare-worker.js  # the relay: a tiny Cloudflare Worker
├── favicon.svg
├── README.md
└── tests/                # Node unit tests (see below)
```

## Reaching Mail.tm (the relay)

A page served from GitHub Pages **cannot call `https://api.mail.tm` directly**:
Mail.tm doesn't send the cross-origin (CORS) headers a browser requires when the
page is on another domain, so the request is blocked and the app shows
"Could not reach Mail.tm". (Opened from `localhost` or `file://` it often works,
which is why local testing can pass while the deployed site can't connect.)

The fix is a tiny **relay** that the page calls instead, which forwards to Mail.tm
server-side and adds the missing CORS headers. `cloudflare-worker.js` is that relay
— a free [Cloudflare Worker](https://workers.cloudflare.com/):

1. Sign in at <https://dash.cloudflare.com> (a free account is enough).
2. **Workers & Pages → Create application → Create Worker**. Name it
   (e.g. `quick-inbox-relay`) and click **Deploy**.
3. Click **Edit code**, replace the sample with the contents of
   `cloudflare-worker.js`, and click **Deploy**.
4. Copy the Worker URL (e.g. `https://quick-inbox-relay.YOURNAME.workers.dev`).
5. Put it in `config.js`:

   ```js
   window.QUICK_INBOX_API_BASE = "https://quick-inbox-relay.YOURNAME.workers.dev";
   ```

The Worker only ever forwards to `api.mail.tm`, so it can't be used as a general
open proxy, and your inbox traffic stays on infrastructure you control.

## Run locally

It is a static site — any static server works. From the repository root:

```bash
# Python (built in on macOS/Linux)
python3 -m http.server 4173
# then open http://127.0.0.1:4173/quick-inbox/

# …or Node
npx serve .
```

Opening `quick-inbox/index.html` directly via `file://` mostly works, but a
local server matches how it behaves when deployed.

## Tests

**Logic (no dependencies, no network)** — verification-code extraction and the
Mail.tm workflow (domain selection, address-collision retry, token renewal on
401, rate-limit and network handling) run against a stubbed `fetch`:

```bash
node --test quick-inbox/tests/*.test.mjs
```

**Browser end-to-end (optional)** — the full journey was also exercised in a real
browser with Playwright against a mocked Mail.tm API (create → code → detail →
reload persistence → auto re-auth → rate limit → offline → forget inbox), at both
phone and desktop widths.

## Deploy to GitHub Pages

This repository serves GitHub Pages directly from the `main` branch, so once these
files are on `main` the app is published automatically — no extra configuration and
no build step. Because Quick Inbox lives in the `quick-inbox/` subfolder and uses
only **relative** asset paths, it works from a subpath:

```
https://<your-username>.github.io/<repository>/quick-inbox/
```

If Pages is not enabled yet (for example on a fresh fork): open **Settings → Pages**,
and under **Build and deployment → Source** choose **Deploy from a branch**, then
select `main` and `/ (root)`.

## Attribution

Temporary email service powered by [Mail.tm](https://mail.tm). Mail.tm is free and
requires no API key; please respect its rate limits and terms of use.
