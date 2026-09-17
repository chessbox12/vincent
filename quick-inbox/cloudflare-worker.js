/*
 * Quick Inbox — Mail.tm relay (Cloudflare Worker)
 * =================================================
 *
 * A static GitHub Pages site can't call https://api.mail.tm directly from the
 * browser, because Mail.tm doesn't send the cross-origin (CORS) headers a page
 * on another domain needs. This tiny Worker sits in the middle: the page calls
 * the Worker, the Worker calls Mail.tm server-side (no CORS involved there),
 * and the Worker adds the CORS headers the browser requires.
 *
 * It only ever forwards to api.mail.tm, so it can't be used as an open proxy.
 *
 * Deploy (no command line needed):
 *   1. Sign in at https://dash.cloudflare.com  (a free account is enough).
 *   2. Left sidebar → "Workers & Pages" → "Create application" → "Create Worker".
 *   3. Name it (e.g. quick-inbox-relay) and click "Deploy".
 *   4. Click "Edit code", delete the sample, paste THIS file, click "Deploy".
 *   5. Copy the Worker URL it shows (like
 *      https://quick-inbox-relay.YOUR-NAME.workers.dev) and set it as
 *      QUICK_INBOX_API_BASE in quick-inbox/config.js.
 */

const UPSTREAM = "https://api.mail.tm";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,Accept",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    // Preflight — the browser asks permission before the real request.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const target = UPSTREAM + url.pathname + url.search;

    // Forward only the headers Mail.tm actually needs; drop everything else
    // (Cloudflare/browser origin headers) so nothing leaks upstream.
    const headers = new Headers();
    for (const name of ["Accept", "Content-Type", "Authorization"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const method = request.method.toUpperCase();
    const init = {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await request.text(),
      redirect: "follow",
    };

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (err) {
      return json(502, { message: "Relay could not reach Mail.tm" });
    }

    // Re-emit the JSON body with CORS headers added. Reading as text keeps
    // content-length/encoding correct for the browser.
    const body = await upstream.text();
    const outHeaders = { ...CORS };
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) outHeaders["Content-Type"] = contentType;
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  },
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
