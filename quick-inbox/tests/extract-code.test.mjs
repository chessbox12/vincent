// Verification-code extraction and pure-helper tests.
// Run with:  node --test quick-inbox/tests
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  extractVerificationCode,
  computeLatestCode,
  sortNewestFirst,
  relativeTime,
  randomLocalPart,
  randomPassword,
  pickActiveDomain,
} = require("../app.js");

test("contextual patterns win", () => {
  assert.equal(
    extractVerificationCode("Your verification code is: 175335"),
    "175335"
  );
  assert.equal(extractVerificationCode("Verification code: 482913"), "482913");
  assert.equal(extractVerificationCode("Your security code is 55531."), "55531");
  assert.equal(extractVerificationCode("code is 9384"), "9384");
  assert.equal(extractVerificationCode("OTP: 90210"), "90210");
  assert.equal(extractVerificationCode("Use PIN 7742 to unlock"), "7742");
  assert.equal(
    extractVerificationCode("483920 is your Acme sign-in code"),
    "483920"
  );
  assert.equal(
    extractVerificationCode("Hello!\nYour one-time password: 664422\nThanks"),
    "664422"
  );
  assert.equal(
    extractVerificationCode("Verify email address\nYour verification code is 175335. It expires in 10 minutes."),
    "175335"
  );
});

test("contextual match beats earlier plain numbers", () => {
  assert.equal(
    extractVerificationCode("Ref 88110042 — your login code is 4821"),
    "4821"
  );
  // A year in the signature must not shadow a contextual code.
  assert.equal(
    extractVerificationCode("© 2026 Acme. Your code is 4821"),
    "4821"
  );
});

test("standalone number fallback", () => {
  assert.equal(extractVerificationCode("Use 123456 to sign in."), "123456");
  assert.equal(extractVerificationCode("Enter 4021 at the door"), "4021");
});

test("years, dates, phones, decimals and long IDs are not codes", () => {
  assert.equal(extractVerificationCode("© 2026 Acme Inc."), null);
  assert.equal(extractVerificationCode("Meeting on 2026-09-17"), null);
  assert.equal(extractVerificationCode("Sent 17/09/2026 at 10:15"), null);
  assert.equal(extractVerificationCode("Call 555-123-4567"), null);
  assert.equal(extractVerificationCode("Call +14155550123"), null);
  assert.equal(extractVerificationCode("Order #48219 confirmed"), null);
  assert.equal(extractVerificationCode("Total $12.3456"), null);
  assert.equal(extractVerificationCode("Tracking 1234567890123"), null);
});

test("empty and missing input", () => {
  assert.equal(extractVerificationCode(""), null);
  assert.equal(extractVerificationCode(null), null);
  assert.equal(extractVerificationCode(undefined), null);
  assert.equal(extractVerificationCode("No numbers here at all"), null);
  assert.equal(extractVerificationCode("code is 12 34"), null);
});

test("non-breaking spaces are tolerated", () => {
  assert.equal(extractVerificationCode("code is 993311"), "993311");
});

const msg = (id, createdAt, subject, intro) => ({ id, createdAt, subject, intro });

test("computeLatestCode prefers the newest message", () => {
  const messages = [
    msg("old", "2026-09-17T00:00:00Z", "Welcome", "Thanks for joining!"),
    msg("mid", "2026-09-17T00:05:00Z", "Verify email", "Your code is 111222"),
    msg("new", "2026-09-17T00:10:00Z", "Verify again", "Your code is 333444"),
  ];
  const latest = computeLatestCode(messages);
  assert.equal(latest.code, "333444");
  assert.equal(latest.message.id, "new");
  assert.equal(latest.isNewestMessage, true);
});

test("computeLatestCode flags an older code when the newest email has none", () => {
  const messages = [
    msg("codeless", "2026-09-17T00:10:00Z", "Newsletter", "Weekly news!"),
    msg("coded", "2026-09-17T00:05:00Z", "Verify email", "Your code is 111222"),
  ];
  const latest = computeLatestCode(messages);
  assert.equal(latest.code, "111222");
  assert.equal(latest.isNewestMessage, false);
});

test("computeLatestCode returns null with no codes", () => {
  assert.equal(
    computeLatestCode([msg("a", "2026-09-17T00:00:00Z", "Hi", "Hello")]),
    null
  );
  assert.equal(computeLatestCode([]), null);
});

test("sortNewestFirst orders by createdAt descending", () => {
  const shuffled = [
    msg("b", "2026-09-17T00:05:00Z"),
    msg("c", "2026-09-17T00:10:00Z"),
    msg("a", "2026-09-17T00:00:00Z"),
  ];
  assert.deepEqual(
    sortNewestFirst(shuffled).map((m) => m.id),
    ["c", "b", "a"]
  );
});

test("relativeTime buckets", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  assert.equal(relativeTime("2026-09-17T11:59:50Z", now), "just now");
  assert.equal(relativeTime("2026-09-17T11:55:00Z", now), "5 min ago");
  assert.equal(relativeTime("2026-09-17T09:00:00Z", now), "3 h ago");
  assert.equal(relativeTime("not-a-date", now), "");
});

test("random credentials have the expected shape and vary", () => {
  const a = randomLocalPart();
  const b = randomLocalPart();
  assert.match(a, /^[a-z]{3}[a-z0-9]{9}$/);
  assert.notEqual(a, b);
  const p1 = randomPassword();
  const p2 = randomPassword();
  assert.equal(p1.length, 24);
  assert.notEqual(p1, p2);
});

test("pickActiveDomain skips inactive entries and handles empties", () => {
  assert.equal(
    pickActiveDomain([
      { domain: "off.example", isActive: false },
      { domain: "on.example", isActive: true },
    ]),
    "on.example"
  );
  assert.equal(pickActiveDomain([]), null);
  assert.equal(pickActiveDomain(null), null);
});
