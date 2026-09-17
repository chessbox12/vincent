/*
 * Quick Inbox configuration.
 *
 * QUICK_INBOX_API_BASE is the address the app uses to reach Mail.tm.
 *
 * A page hosted on GitHub Pages can't call https://api.mail.tm directly
 * (Mail.tm doesn't allow cross-origin browser requests), so set this to your
 * own Mail.tm relay — the Cloudflare Worker in cloudflare-worker.js. Example:
 *
 *   window.QUICK_INBOX_API_BASE = "https://quick-inbox-relay.yourname.workers.dev";
 *
 * Leave it empty to call Mail.tm directly (works when opened locally or from an
 * allowed origin, but not from GitHub Pages). The `||` keeps any value set
 * earlier — for example by an automated test — so this file stays test-safe.
 */
window.QUICK_INBOX_API_BASE = window.QUICK_INBOX_API_BASE || "";
