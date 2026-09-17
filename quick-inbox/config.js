/*
 * Quick Inbox configuration — how the page reaches Mail.tm.
 *
 * A page served from GitHub Pages can't call https://api.mail.tm directly
 * (Mail.tm sends no cross-origin/CORS headers), so requests are routed
 * through a relay. Two knobs:
 *
 *   QUICK_INBOX_API_BASE — the Mail.tm base URL (or your own Worker relay)
 *   QUICK_INBOX_PROXY    — a CORS-proxy template containing "{url}", which
 *                          wraps the full request URL
 *
 * Shipped default: a shared public CORS relay, so the site works with no
 * setup. Your throwaway-inbox traffic passes through that third-party service;
 * for disposable verification codes that is an acceptable trade-off.
 *
 * To keep everything on infrastructure you control instead, deploy the
 * Cloudflare Worker in cloudflare-worker.js, then set API_BASE to its URL and
 * clear the proxy:
 *
 *   window.QUICK_INBOX_API_BASE = "https://quick-inbox-relay.you.workers.dev";
 *   window.QUICK_INBOX_PROXY = "";
 *
 * The `||` / `??` keep any value set earlier (e.g. by an automated test), so
 * this file stays test-safe.
 */
window.QUICK_INBOX_API_BASE = window.QUICK_INBOX_API_BASE || "https://api.mail.tm";
window.QUICK_INBOX_PROXY =
  window.QUICK_INBOX_PROXY ?? "https://corsproxy.io/?url={url}";
