// Mail.tm workflow tests with a stubbed fetch — no network required.
// Covers: live-domain selection, account creation with collision retry,
// token exchange, inbox fetch, automatic 401 re-authentication, rate
// limiting and network failure.
// Run with:  node --test quick-inbox/tests
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  API_BASE,
  ApiError,
  createInboxSession,
  fetchMessagesWithReauth,
  fetchMessageWithReauth,
  getMessages,
  getMessage,
} = require("../app.js");

/** Install a scripted fetch; returns the recorded calls. */
function stubFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    const result = handler(call, calls.length);
    if (result instanceof Error) throw result;
    const { status = 200, body = {} } = result;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const DOMAINS_RESPONSE = {
  body: {
    "hydra:member": [
      { id: "d0", domain: "inactive.example", isActive: false },
      { id: "d1", domain: "tmpmail.example", isActive: true },
    ],
  },
};

test("createInboxSession: live domain → account → token", async (t) => {
  const calls = stubFetch(t, (call) => {
    if (call.url === API_BASE + "/domains") return DOMAINS_RESPONSE;
    if (call.url === API_BASE + "/accounts")
      return { status: 201, body: { id: "acc-1", address: call.body.address } };
    if (call.url === API_BASE + "/token")
      return { body: { token: "tok-1", id: "acc-1" } };
    throw new Error("unexpected URL " + call.url);
  });

  const session = await createInboxSession();

  // The address comes from the live active domain, never the inactive one.
  assert.match(session.address, /^[a-z]{3}[a-z0-9]{9}@tmpmail\.example$/);
  assert.equal(session.token, "tok-1");
  assert.equal(session.accountId, "acc-1");
  assert.equal(session.password.length, 24);

  // Same generated credentials for /accounts and /token.
  const accountCall = calls.find((c) => c.url.endsWith("/accounts"));
  const tokenCall = calls.find((c) => c.url.endsWith("/token"));
  assert.equal(accountCall.body.address, tokenCall.body.address);
  assert.equal(accountCall.body.password, tokenCall.body.password);
  assert.equal(accountCall.headers["Content-Type"], "application/json");
});

test("createInboxSession retries with a fresh name on address collision", async (t) => {
  let accountAttempts = 0;
  const calls = stubFetch(t, (call) => {
    if (call.url === API_BASE + "/domains") return DOMAINS_RESPONSE;
    if (call.url === API_BASE + "/accounts") {
      accountAttempts++;
      if (accountAttempts === 1)
        return { status: 422, body: { message: "Address already used" } };
      return { status: 201, body: { id: "acc-2", address: call.body.address } };
    }
    if (call.url === API_BASE + "/token")
      return { body: { token: "tok-2", id: "acc-2" } };
    throw new Error("unexpected URL " + call.url);
  });

  const session = await createInboxSession();
  assert.equal(session.token, "tok-2");

  const attempted = calls
    .filter((c) => c.url.endsWith("/accounts"))
    .map((c) => c.body.address);
  assert.equal(attempted.length, 2);
  assert.notEqual(attempted[0], attempted[1], "retried with a new random name");
});

test("createInboxSession gives up after the attempt limit", async (t) => {
  stubFetch(t, (call) => {
    if (call.url === API_BASE + "/domains") return DOMAINS_RESPONSE;
    if (call.url === API_BASE + "/accounts")
      return { status: 422, body: { message: "Address already used" } };
    throw new Error("unexpected URL " + call.url);
  });

  await assert.rejects(createInboxSession({ attempts: 2 }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 422);
    return true;
  });
});

test("createInboxSession fails cleanly when no domain is active", async (t) => {
  stubFetch(t, () => ({
    body: { "hydra:member": [{ id: "d0", domain: "off.example", isActive: false }] },
  }));
  await assert.rejects(createInboxSession(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /domain/i);
    return true;
  });
});

test("fetchMessagesWithReauth renews an expired token once and retries", async (t) => {
  const session = {
    address: "someone@tmpmail.example",
    password: "pw",
    token: "expired",
  };
  let renewals = 0;
  const calls = stubFetch(t, (call) => {
    if (call.url === API_BASE + "/messages") {
      if (call.headers.Authorization === "Bearer expired")
        return { status: 401, body: { message: "Invalid JWT Token" } };
      return {
        body: {
          "hydra:member": [
            { id: "m1", subject: "Verify", intro: "code is 123456" },
          ],
        },
      };
    }
    if (call.url === API_BASE + "/token") {
      assert.equal(call.body.address, session.address);
      assert.equal(call.body.password, session.password);
      return { body: { token: "fresh", id: "acc-1" } };
    }
    throw new Error("unexpected URL " + call.url);
  });

  const messages = await fetchMessagesWithReauth(session, {
    onTokenRenewed: () => renewals++,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "m1");
  assert.equal(session.token, "fresh");
  assert.equal(renewals, 1);
  assert.deepEqual(
    calls.map((c) => c.url.replace(API_BASE, "")),
    ["/messages", "/token", "/messages"]
  );
  assert.equal(calls[2].headers.Authorization, "Bearer fresh");
});

test("fetchMessagesWithReauth surfaces a dead session (re-auth also 401)", async (t) => {
  const session = { address: "a@b.example", password: "pw", token: "expired" };
  stubFetch(t, (call) => {
    if (call.url === API_BASE + "/messages")
      return { status: 401, body: { message: "Invalid JWT Token" } };
    if (call.url === API_BASE + "/token")
      return { status: 401, body: { message: "Invalid credentials." } };
    throw new Error("unexpected URL " + call.url);
  });

  await assert.rejects(fetchMessagesWithReauth(session), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    return true;
  });
});

test("rate limiting (429) is reported without a token request", async (t) => {
  const calls = stubFetch(t, () => ({
    status: 429,
    body: { message: "Too Many Requests" },
  }));
  const session = { address: "a@b.example", password: "pw", token: "tok" };

  await assert.rejects(fetchMessagesWithReauth(session), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 429);
    return true;
  });
  assert.equal(calls.length, 1, "no re-auth attempt on 429");
});

test("network failure becomes ApiError with status 0", async (t) => {
  stubFetch(t, () => new TypeError("fetch failed"));
  await assert.rejects(getMessages("tok"), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 0);
    return true;
  });
});

test("getMessage fetches one message by id with the bearer token", async (t) => {
  const calls = stubFetch(t, () => ({
    body: { id: "m9", subject: "Hi", text: "Your code is 445566" },
  }));
  const full = await getMessage("tok-9", "m9");
  assert.equal(full.text, "Your code is 445566");
  assert.equal(calls[0].url, API_BASE + "/messages/m9");
  assert.equal(calls[0].headers.Authorization, "Bearer tok-9");
});

test("fetchMessageWithReauth renews the token for a message fetch too", async (t) => {
  const session = { address: "a@b.example", password: "pw", token: "expired" };
  stubFetch(t, (call) => {
    if (call.url.startsWith(API_BASE + "/messages/")) {
      if (call.headers.Authorization === "Bearer expired")
        return { status: 401, body: { message: "Invalid JWT Token" } };
      return { body: { id: "m1", text: "code is 777888" } };
    }
    if (call.url === API_BASE + "/token") return { body: { token: "fresh2" } };
    throw new Error("unexpected URL " + call.url);
  });

  const full = await fetchMessageWithReauth(session, "m1");
  assert.equal(full.text, "code is 777888");
  assert.equal(session.token, "fresh2");
});
