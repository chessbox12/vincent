"use strict";

/*
 * Quick Inbox — a small front end for the public Mail.tm API.
 *
 * The file is organised in three layers so the API workflow stays separate
 * from the interface:
 *   1. Pure helpers (random credentials, verification-code extraction, time)
 *   2. Mail.tm API functions (fetch only, no DOM)
 *   3. Browser UI (only runs when a document exists)
 *
 * The pure helpers and API functions are exported for Node's test runner at
 * the bottom of the file. Nothing here may contain a real address, password,
 * token or domain — credentials are always created fresh in the browser.
 */

// How the app reaches Mail.tm.
//
// A static page (GitHub Pages) can't call https://api.mail.tm directly —
// Mail.tm sends no cross-origin (CORS) headers — so config.js can route
// requests through a relay. Two optional knobs, both set in config.js:
//   QUICK_INBOX_API_BASE — the Mail.tm base URL, or your own Worker relay
//   QUICK_INBOX_PROXY    — a CORS-proxy template containing "{url}", which
//                          wraps the full request URL (for shared public relays)
// In Node (tests) window is undefined, so both fall back to the direct API.
const cfg = typeof window !== "undefined" ? window : {};
const API_BASE = (cfg.QUICK_INBOX_API_BASE || "https://api.mail.tm").replace(/\/+$/, "");
const API_PROXY = cfg.QUICK_INBOX_PROXY || "";

/** Full URL to fetch for a Mail.tm path, wrapped through the proxy if set. */
function buildRequestUrl(path) {
  const target = API_BASE + path;
  return API_PROXY ? API_PROXY.replace("{url}", encodeURIComponent(target)) : target;
}
const STORAGE_KEY = "quickInbox.session.v1";
const POLL_VISIBLE_MS = 9000; // ~8–10 s while the tab is visible
const POLL_HIDDEN_MS = 60000; // greatly reduced while the tab is hidden
const POLL_RATE_LIMITED_MS = 30000; // back off after a 429
const CREATE_ATTEMPTS = 4; // retries when a generated address is taken

/* ------------------------------------------------------------------ */
/* 1. Pure helpers                                                     */
/* ------------------------------------------------------------------ */

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const LETTERS_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";
const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!-_.";

/** Unbiased random string from an alphabet, using crypto.getRandomValues. */
function randomString(alphabet, length) {
  const out = [];
  const limit = 256 - (256 % alphabet.length); // rejection sampling, no modulo bias
  while (out.length < length) {
    const bytes = new Uint8Array(length * 2);
    (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && out.length < length) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join("");
}

function randomLocalPart() {
  // Starts with letters so it never looks like a phone number or ID.
  return randomString(LETTERS, 3) + randomString(LETTERS_DIGITS, 9);
}

function randomPassword() {
  return randomString(PASSWORD_ALPHABET, 24);
}

/**
 * Find the most likely verification code in a piece of email text.
 * Contextual phrases win over bare numbers; bare numbers are accepted only
 * when they do not look like a year, a date fragment, a phone number or a
 * long identifier. Returns the code as a string, or null.
 */
function extractVerificationCode(text) {
  if (!text) return null;
  const t = String(text).replace(/ /g, " ");

  // Contextual patterns, most specific first.
  const contextual = [
    // "verification code is: 123456", "security code – 123456", "login PIN 1234"
    /(?:verification|confirmation|security|login|sign[ -]?in|one[ -]?time|access|auth(?:entication)?|2fa)[ \t]+(?:code|pin|passcode|password)\b[^0-9\n]{0,24}?(?<!\d)(?<!\d[.-])(\d{4,8})(?!\d)(?![.-]\d)/i,
    // "OTP: 483920", "passcode 7712", "PIN is 9944"
    /\b(?:otp|passcode|pin)\b[^0-9\n]{0,24}?(?<!\d)(?<!\d[.-])(\d{4,8})(?!\d)(?![.-]\d)/i,
    // "code is 123456", "code: 123456"
    /\bcode\b[^0-9\n]{0,24}?(?<!\d)(?<!\d[.-])(\d{4,8})(?!\d)(?![.-]\d)/i,
    // "123456 is your Acme verification code"
    /(?<!\d)(?<!\d[.-])(\d{4,8})(?!\d)(?![.-]\d)[ \t]+is[ \t]+your\b/i,
  ];
  for (const re of contextual) {
    const m = t.match(re);
    if (m) return m[1];
  }

  // Fallback: first standalone 4–8 digit run that doesn't look like
  // a year, part of a date/phone/decimal, or a longer identifier.
  const SEPARATORS = "-./:";
  for (const m of t.matchAll(/\d+/g)) {
    const s = m[0];
    if (s.length < 4 || s.length > 8) continue;
    const before = t[m.index - 1] || "";
    const before2 = t[m.index - 2] || "";
    const after = t[m.index + s.length] || "";
    const after2 = t[m.index + s.length + 1] || "";
    // Attached to more digits through -, ., /, : (dates, phones, decimals, IDs).
    if (SEPARATORS.includes(before) && /\d/.test(before2)) continue;
    if (SEPARATORS.includes(after) && /\d/.test(after2)) continue;
    // Likely a phone number or reference, not a code.
    if (before === "+" || before === "#") continue;
    // A lone 4-digit 19xx/20xx is almost always a year.
    if (/^(?:19|20)\d{2}$/.test(s)) continue;
    return s;
  }
  return null;
}

/** Human-friendly relative time for a message timestamp. */
function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60000);
  if (diff < 45000) return "just now";
  if (min < 60) return min + " min ago";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " h ago";
  return new Date(then).toLocaleString();
}

/** Messages sorted newest first (defensive — the API already sorts). */
function sortNewestFirst(messages) {
  return [...messages].sort(
    (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)
  );
}

/**
 * Pick the code to feature: the newest message that contains one.
 * `isNewestMessage` is false when a newer, code-less email has since arrived,
 * so the UI can mark the code as older instead of implying it is current.
 */
function computeLatestCode(messages) {
  const sorted = sortNewestFirst(messages);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const code = extractVerificationCode(
      (m.subject || "") + "\n" + (m.intro || "")
    );
    if (code) return { code, message: m, isNewestMessage: i === 0 };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 2. Mail.tm API layer                                                */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, message, data) {
    super(message || "Request failed (" + status + ")");
    this.name = "ApiError";
    this.status = status; // 0 = network failure
    this.data = data || null;
  }
}

async function apiRequest(path, { method = "GET", token, body, signal } = {}) {
  const headers = { Accept: "application/json, application/ld+json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = "Bearer " + token;

  let res;
  try {
    res = await globalThis.fetch(buildRequestUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, "Network request failed", null);
  }

  let data = null;
  try {
    const text = await res.text();
    if (text) data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message =
      (data && (data.message || data["hydra:description"] || data.detail)) ||
      "HTTP " + res.status;
    throw new ApiError(res.status, message, data);
  }
  return data;
}

async function getDomains(signal) {
  const data = await apiRequest("/domains", { signal });
  if (Array.isArray(data)) return data;
  return (data && data["hydra:member"]) || [];
}

/** Always choose an active domain from the live response — never hardcode. */
function pickActiveDomain(domains) {
  const active = (domains || []).find((d) => d && d.domain && d.isActive !== false);
  return active ? active.domain : null;
}

function createAccount(address, password, signal) {
  return apiRequest("/accounts", {
    method: "POST",
    body: { address, password },
    signal,
  });
}

function getToken(address, password, signal) {
  return apiRequest("/token", {
    method: "POST",
    body: { address, password },
    signal,
  });
}

function getMessages(token, signal) {
  return apiRequest("/messages", { token, signal }).then((data) => {
    if (Array.isArray(data)) return data;
    return (data && data["hydra:member"]) || [];
  });
}

function getMessage(token, id, signal) {
  return apiRequest("/messages/" + encodeURIComponent(id), { token, signal });
}

/**
 * Full inbox creation flow: live domain → new random account → token.
 * Retries with a fresh random name a few times if the address is taken.
 */
async function createInboxSession({ signal, attempts = CREATE_ATTEMPTS } = {}) {
  const domain = pickActiveDomain(await getDomains(signal));
  if (!domain) {
    throw new ApiError(0, "Mail.tm reported no available domains", null);
  }
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const address = (randomLocalPart() + "@" + domain).toLowerCase();
    const password = randomPassword();
    try {
      const account = await createAccount(address, password, signal);
      const auth = await getToken(address, password, signal);
      return {
        address,
        password,
        token: auth.token,
        accountId: (account && account.id) || auth.id || null,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      // 422/409: address collision or rejected — try a different random name.
      if (err instanceof ApiError && (err.status === 422 || err.status === 409)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new ApiError(0, "Could not create an account", null);
}

/**
 * Fetch the inbox; on 401 transparently request a new token with the stored
 * address and password, then retry once. Mutates session.token on renewal and
 * reports it via onTokenRenewed so it can be persisted.
 * If re-authentication itself fails, the ApiError from /token is thrown —
 * the session can no longer be accessed.
 */
async function fetchMessagesWithReauth(session, { signal, onTokenRenewed } = {}) {
  try {
    return await getMessages(session.token, signal);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
  }
  const auth = await getToken(session.address, session.password, signal);
  session.token = auth.token;
  if (onTokenRenewed) onTokenRenewed(session);
  return getMessages(session.token, signal);
}

/** Same renew-once behaviour for a single message fetch. */
async function fetchMessageWithReauth(session, id, { signal, onTokenRenewed } = {}) {
  try {
    return await getMessage(session.token, id, signal);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
  }
  const auth = await getToken(session.address, session.password, signal);
  session.token = auth.token;
  if (onTokenRenewed) onTokenRenewed(session);
  return getMessage(session.token, id, signal);
}

/* ------------------------------------------------------------------ */
/* 3. Browser UI                                                       */
/* ------------------------------------------------------------------ */

if (typeof document !== "undefined") {
  initQuickInbox();
}

function initQuickInbox() {
  const $ = (id) => document.getElementById(id);

  const el = {
    status: $("status"),
    notice: $("notice"),
    startView: $("start-view"),
    inboxView: $("inbox-view"),
    detailView: $("detail-view"),
    createBtn: $("create-btn"),
    createHint: $("create-hint"),
    address: $("address"),
    copyAddressBtn: $("copy-address-btn"),
    codeCard: $("code-card"),
    codeLabel: $("code-label"),
    codeValue: $("code-value"),
    codeMeta: $("code-meta"),
    copyCodeBtn: $("copy-code-btn"),
    refreshBtn: $("refresh-btn"),
    messageList: $("message-list"),
    inboxEmpty: $("inbox-empty"),
    newInboxBtn: $("new-inbox-btn"),
    forgetBtn: $("forget-btn"),
    confirmBar: $("confirm-bar"),
    confirmText: $("confirm-text"),
    confirmYes: $("confirm-yes"),
    confirmNo: $("confirm-no"),
    detailBack: $("detail-back"),
    detailSubject: $("detail-subject"),
    detailFrom: $("detail-from"),
    detailTime: $("detail-time"),
    detailCodeRow: $("detail-code-row"),
    detailCode: $("detail-code"),
    detailCopyCode: $("detail-copy-code"),
    detailBody: $("detail-body"),
    announcer: $("announcer"),
  };

  const state = {
    session: loadSession(),
    messages: [],
    epoch: 0, // bumped when the inbox changes so stale responses are ignored
    inFlight: false,
    pollTimer: null,
    abort: null,
    rateLimited: false,
    dead: false, // token expired and re-authentication failed
    pendingConfirm: null,
  };

  /* ---------- persistence ---------- */

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s && s.address && s.password && s.token) return s;
    } catch {
      /* storage unavailable (private mode etc.) — run in memory only */
    }
    return null;
  }

  function saveSession(session) {
    try {
      if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore — the inbox still works until the page closes */
    }
  }

  /* ---------- small UI helpers ---------- */

  function setStatus(kind, label) {
    el.status.dataset.kind = kind;
    el.status.textContent = label;
  }

  function setNotice(text, { tone = "info", actionLabel, onAction } = {}) {
    el.notice.textContent = "";
    el.notice.hidden = !text;
    el.notice.dataset.tone = tone;
    if (!text) return;
    const span = document.createElement("span");
    span.textContent = text;
    el.notice.append(span);
    if (actionLabel && onAction) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "notice-action";
      btn.textContent = actionLabel;
      btn.addEventListener("click", onAction);
      el.notice.append(btn);
    }
  }

  function announce(text) {
    el.announcer.textContent = "";
    // Two writes so repeated identical announcements are still read out.
    requestAnimationFrame(() => {
      el.announcer.textContent = text;
    });
  }

  async function copyToClipboard(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function flashCopied(button, label) {
    const original = button.textContent;
    button.textContent = "Copied ✓";
    button.classList.add("copied");
    announce(label + " copied to clipboard");
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1600);
  }

  function showView(name) {
    el.startView.hidden = name !== "start";
    el.inboxView.hidden = name !== "inbox";
    el.detailView.hidden = name !== "detail";
  }

  /* ---------- rendering ---------- */

  function renderInbox() {
    if (!state.session) return;
    el.address.textContent = state.session.address;

    const latest = computeLatestCode(state.messages);
    if (latest) {
      el.codeCard.hidden = false;
      el.codeCard.classList.toggle("older", !latest.isNewestMessage);
      el.codeLabel.textContent = latest.isNewestMessage
        ? "Latest code"
        : "Older code — a newer email has arrived";
      el.codeValue.textContent = latest.code;
      const from =
        (latest.message.from && latest.message.from.address) || "unknown sender";
      el.codeMeta.textContent =
        "From: " + from + " · " + relativeTime(latest.message.createdAt);
    } else {
      el.codeCard.hidden = true;
    }

    el.messageList.textContent = "";
    const sorted = sortNewestFirst(state.messages);
    el.inboxEmpty.hidden = sorted.length !== 0;
    for (let i = 0; i < sorted.length; i++) {
      const m = sorted[i];
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "message" + (m.seen ? "" : " unseen");
      btn.addEventListener("click", () => openMessage(m));

      const top = document.createElement("div");
      top.className = "message-top";
      const subject = document.createElement("span");
      subject.className = "message-subject";
      subject.textContent = m.subject || "(no subject)";
      const time = document.createElement("span");
      time.className = "message-time";
      time.textContent = relativeTime(m.createdAt);
      top.append(subject, time);

      const bottom = document.createElement("div");
      bottom.className = "message-bottom";
      const from = document.createElement("span");
      from.className = "message-from";
      from.textContent = (m.from && m.from.address) || "";
      bottom.append(from);

      const code = extractVerificationCode(
        (m.subject || "") + "\n" + (m.intro || "")
      );
      if (code) {
        const chip = document.createElement("span");
        chip.className = "code-chip" + (i === 0 ? "" : " older");
        chip.textContent = i === 0 ? "Code " + code : "Older code " + code;
        bottom.append(chip);
      }

      btn.append(top, bottom);
      li.append(btn);
      el.messageList.append(li);
    }
  }

  /** Safe plain-text body: prefer `text`; otherwise strip the HTML down to
   * text via DOMParser. Raw email HTML is never injected into the page. */
  function messageBodyText(msg) {
    if (msg.text) return String(msg.text);
    let html = msg.html;
    if (Array.isArray(html)) html = html.join("\n");
    if (!html) return "";
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    for (const node of doc.querySelectorAll("script,style")) node.remove();
    return (doc.body && doc.body.textContent) || "";
  }

  async function openMessage(summary) {
    const epoch = state.epoch;
    showView("detail");
    el.detailSubject.textContent = summary.subject || "(no subject)";
    el.detailFrom.textContent =
      "From: " + ((summary.from && summary.from.address) || "unknown sender");
    el.detailTime.textContent = relativeTime(summary.createdAt);
    el.detailBody.textContent = "Loading message…";
    el.detailCodeRow.hidden = true;
    try {
      const full = await fetchMessageWithReauth(state.session, summary.id, {
        onTokenRenewed: () => saveSession(state.session),
      });
      if (epoch !== state.epoch) return; // inbox was replaced meanwhile
      const body = messageBodyText(full).trim();
      el.detailBody.textContent = body || "(this email has no text content)";
      const code = extractVerificationCode(
        (full.subject || "") + "\n" + body
      );
      if (code) {
        el.detailCodeRow.hidden = false;
        el.detailCode.textContent = code;
      }
      summary.seen = true;
      renderInbox();
    } catch (err) {
      if (epoch !== state.epoch) return;
      if (err instanceof ApiError && err.status === 401) {
        handleDeadSession();
        return;
      }
      el.detailBody.textContent =
        "Could not load this message (" + describeError(err) + "). " +
        "Go back and try again.";
    }
  }

  function describeError(err) {
    if (err instanceof ApiError) {
      if (err.status === 0) return "network problem";
      if (err.status === 429) return "Mail.tm rate limit";
      return "error " + err.status;
    }
    return "unexpected error";
  }

  /* ---------- inbox lifecycle ---------- */

  async function createInbox() {
    el.createBtn.disabled = true;
    el.createBtn.textContent = "Creating inbox…";
    el.createHint.textContent =
      "Talking to Mail.tm — picking a domain and creating your address.";
    setStatus("busy", "Working…");
    setNotice("");
    try {
      const session = await createInboxSession();
      state.session = session;
      state.messages = [];
      state.dead = false;
      state.epoch++;
      saveSession(session);
      showView("inbox");
      renderInbox();
      setStatus("live", "Live");
      announce("Inbox created: " + session.address);
      pollNow();
    } catch (err) {
      setStatus("error", "Error");
      const why =
        err instanceof ApiError && err.status === 429
          ? "Mail.tm is rate limiting right now. Wait a few seconds and try again."
          : err instanceof ApiError && err.status === 0
            ? "Could not reach Mail.tm. Check your connection and try again."
            : "Mail.tm seems unavailable right now (" + describeError(err) + "). Try again in a minute.";
      el.createHint.textContent = why;
    } finally {
      el.createBtn.disabled = false;
      el.createBtn.textContent = "Create temporary inbox";
    }
  }

  function handleDeadSession() {
    state.dead = true;
    stopPolling();
    setStatus("error", "Signed out");
    setNotice(
      "This inbox session can no longer be accessed (its login expired and could not be renewed).",
      {
        tone: "error",
        actionLabel: "Create new inbox",
        onAction: () => {
          forgetInbox();
          createInbox();
        },
      }
    );
  }

  function forgetInbox() {
    state.epoch++;
    if (state.abort) state.abort.abort();
    stopPolling();
    state.session = null;
    state.messages = [];
    state.dead = false;
    saveSession(null);
    setNotice("");
    setStatus("idle", "Ready");
    el.createHint.textContent = "";
    el.address.textContent = ""; // don't leave a stale address in the DOM
    el.codeCard.hidden = true;
    el.messageList.textContent = "";
    showView("start");
  }

  /* ---------- confirmation bar (New inbox / Forget) ---------- */

  function askConfirm(text, onYes) {
    state.pendingConfirm = onYes;
    el.confirmText.textContent = text;
    el.confirmBar.hidden = false;
    el.confirmYes.focus();
  }

  function closeConfirm() {
    state.pendingConfirm = null;
    el.confirmBar.hidden = true;
  }

  /* ---------- polling ---------- */

  function stopPolling() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePoll() {
    stopPolling();
    if (!state.session || state.dead) return;
    let delay = document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
    if (state.rateLimited) delay = Math.max(delay, POLL_RATE_LIMITED_MS);
    state.pollTimer = setTimeout(pollNow, delay);
  }

  async function pollNow() {
    if (!state.session || state.dead) return;
    if (state.inFlight) return; // never overlap refreshes
    state.inFlight = true;
    const epoch = state.epoch;
    state.abort = new AbortController();
    el.refreshBtn.disabled = true;
    el.refreshBtn.textContent = "Checking…";
    setStatus("busy", "Checking…");
    try {
      const messages = await fetchMessagesWithReauth(state.session, {
        signal: state.abort.signal,
        onTokenRenewed: () => saveSession(state.session),
      });
      if (epoch !== state.epoch) return; // a newer inbox owns the UI now
      const hadNew =
        messages.length > state.messages.length ||
        (messages[0] && state.messages[0] && messages[0].id !== state.messages[0].id);
      state.messages = messages;
      state.rateLimited = false;
      setNotice("");
      setStatus("live", "Live");
      renderInbox();
      if (hadNew && messages.length) {
        const latest = computeLatestCode(messages);
        announce(
          latest && latest.isNewestMessage
            ? "New email with code " + latest.code
            : "New email received"
        );
      }
    } catch (err) {
      if (epoch !== state.epoch) return;
      if (err && err.name === "AbortError") return;
      if (err instanceof ApiError && err.status === 401) {
        handleDeadSession();
        return;
      }
      if (err instanceof ApiError && err.status === 429) {
        state.rateLimited = true;
        setStatus("warn", "Rate limited");
        setNotice(
          "Mail.tm asked us to slow down. Checking will continue automatically in about 30 seconds.",
          { tone: "warn" }
        );
      } else if (err instanceof ApiError && err.status === 0) {
        setStatus("warn", "Offline");
        setNotice(
          "You appear to be offline. Your inbox will refresh when the connection returns.",
          { tone: "warn" }
        );
      } else {
        setStatus("error", "Error");
        setNotice(
          "Mail.tm could not be reached (" + describeError(err) + "). Will keep trying.",
          { tone: "error" }
        );
      }
    } finally {
      if (epoch === state.epoch) {
        state.inFlight = false;
        el.refreshBtn.disabled = false;
        el.refreshBtn.textContent = "Refresh inbox";
        schedulePoll();
      } else {
        state.inFlight = false;
      }
    }
  }

  /* ---------- events ---------- */

  el.createBtn.addEventListener("click", createInbox);

  el.copyAddressBtn.addEventListener("click", async () => {
    if (!state.session) return;
    if (await copyToClipboard(state.session.address)) {
      flashCopied(el.copyAddressBtn, "Address");
    }
  });

  el.copyCodeBtn.addEventListener("click", async () => {
    const code = el.codeValue.textContent;
    if (code && (await copyToClipboard(code))) {
      flashCopied(el.copyCodeBtn, "Code");
    }
  });

  el.detailCopyCode.addEventListener("click", async () => {
    const code = el.detailCode.textContent;
    if (code && (await copyToClipboard(code))) {
      flashCopied(el.detailCopyCode, "Code");
    }
  });

  el.refreshBtn.addEventListener("click", pollNow);

  el.newInboxBtn.addEventListener("click", () => {
    askConfirm(
      "Replace this inbox? Your current address stops being checked here and its messages disappear from this device.",
      () => {
        forgetInbox();
        createInbox();
      }
    );
  });

  el.forgetBtn.addEventListener("click", () => {
    askConfirm(
      "Forget this inbox? The saved address, login and messages are removed from this device.",
      forgetInbox
    );
  });

  el.confirmYes.addEventListener("click", () => {
    const fn = state.pendingConfirm;
    closeConfirm();
    if (fn) fn();
  });
  el.confirmNo.addEventListener("click", closeConfirm);

  el.detailBack.addEventListener("click", () => {
    showView("inbox");
    el.refreshBtn.focus();
  });

  document.addEventListener("visibilitychange", () => {
    if (!state.session || state.dead) return;
    if (document.hidden) {
      schedulePoll(); // pushes the next check far out
    } else {
      pollNow(); // catch up immediately when the user returns
    }
  });

  window.addEventListener("online", () => {
    if (state.session && !state.dead) pollNow();
  });
  window.addEventListener("offline", () => {
    setStatus("warn", "Offline");
  });

  /* ---------- start ---------- */

  if (state.session) {
    showView("inbox");
    renderInbox();
    setStatus("busy", "Checking…");
    pollNow();
  } else {
    showView("start");
    setStatus("idle", "Ready");
  }
}

/* ------------------------------------------------------------------ */
/* Test exports (ignored by browsers)                                  */
/* ------------------------------------------------------------------ */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    API_BASE,
    buildRequestUrl,
    ApiError,
    randomString,
    randomLocalPart,
    randomPassword,
    extractVerificationCode,
    relativeTime,
    sortNewestFirst,
    computeLatestCode,
    apiRequest,
    getDomains,
    pickActiveDomain,
    createAccount,
    getToken,
    getMessages,
    getMessage,
    createInboxSession,
    fetchMessagesWithReauth,
    fetchMessageWithReauth,
  };
}
