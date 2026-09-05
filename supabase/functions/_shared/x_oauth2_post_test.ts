import assert from "node:assert/strict";
import test from "node:test";
import { postToXWithRefresh, requestXWithAuthRefresh, type XAuthContext } from "./x_oauth2_post.ts";

function freshAuth(): XAuthContext {
  return {
    tokens: { accessToken: "expired", refreshToken: "refresh-old" },
    clientId: "client-id",
    clientSecret: "client-secret",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    refreshExecuted: false,
  };
}

test("401 refreshes tokens and retries the X post exactly once", async () => {
  const auth: XAuthContext = {
    tokens: { accessToken: "expired", refreshToken: "refresh-old" },
    clientId: "client-id",
    clientSecret: "client-secret",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    refreshExecuted: false,
  };
  let xCalls = 0;
  let refreshCalls = 0;
  let tokenStoreWrites = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.x.com/2/tweets") {
      xCalls += 1;
      return xCalls === 1
        ? new Response(JSON.stringify({ error: "expired" }), { status: 401 })
        : new Response(JSON.stringify({ data: { id: "x-after-refresh" } }), { status: 201 });
    }
    if (url === "https://api.x.com/2/oauth2/token") {
      refreshCalls += 1;
      assert.match(String((init?.body as URLSearchParams).get("refresh_token")), /refresh-old/);
      return new Response(JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 7200,
      }), { status: 200 });
    }
    if (url.startsWith("https://example.supabase.co/rest/v1/oauth_token_store")) {
      tokenStoreWrites += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await postToXWithRefresh(auth, "test post", fetchImpl);
  assert.equal(result.id, "x-after-refresh");
  assert.equal(result.httpStatus, 201);
  assert.equal(result.refreshExecuted, true);
  assert.equal(xCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(tokenStoreWrites, 1);
  assert.equal(auth.tokens.refreshToken, "refresh-new");
});

test("requestXWithAuthRefresh: a generic 401 refreshes once and retries the same request once", async () => {
  const auth = freshAuth();
  let attempt = 0;
  let refreshCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.x.com/2/oauth2/token") {
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: "access-new", refresh_token: "refresh-new", expires_in: 7200,
      }), { status: 200 });
    }
    if (url.startsWith("https://example.supabase.co/rest/v1/oauth_token_store")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await requestXWithAuthRefresh(auth, async (accessToken) => {
    attempt += 1;
    if (attempt === 1) {
      assert.equal(accessToken, "expired");
      return { status: 401, body: { error: "expired" } };
    }
    assert.equal(accessToken, "access-new");
    return { status: 201, body: { data: { id: "media-123" } } };
  }, fetchImpl);
  assert.equal(result.status, 201);
  assert.equal(attempt, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(auth.refreshExecuted, true);
});

test("requestXWithAuthRefresh: a non-401 status is returned as-is, with no refresh attempted", async () => {
  const auth = freshAuth();
  let attempt = 0;
  let refreshCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === "https://api.x.com/2/oauth2/token") {
      refreshCalls += 1;
      throw new Error("refresh must not be called for a non-401 status");
    }
    throw new Error("unexpected call");
  };
  const result = await requestXWithAuthRefresh(auth, async () => {
    attempt += 1;
    return { status: 403, body: { error: "forbidden" } };
  }, fetchImpl);
  assert.equal(result.status, 403);
  assert.equal(attempt, 1);
  assert.equal(refreshCalls, 0);
  assert.equal(auth.refreshExecuted, false);
});

test("requestXWithAuthRefresh: a second 401 after refresh already ran this execution is returned as-is, never retried again", async () => {
  const auth = freshAuth();
  auth.refreshExecuted = true; // simulates: a refresh already happened earlier in this same execution
  let attempt = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === "https://api.x.com/2/oauth2/token") throw new Error("must not refresh twice");
    throw new Error("unexpected call");
  };
  const result = await requestXWithAuthRefresh(auth, async () => {
    attempt += 1;
    return { status: 401, body: { error: "still expired" } };
  }, fetchImpl);
  assert.equal(result.status, 401);
  assert.equal(attempt, 1);
});

test("requestXWithAuthRefresh: a refresh call that itself fails propagates and never retries the original request", async () => {
  const auth = freshAuth();
  let attempt = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === "https://api.x.com/2/oauth2/token") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    throw new Error("unexpected call");
  };
  await assert.rejects(
    () => requestXWithAuthRefresh(auth, async () => {
      attempt += 1;
      return { status: 401, body: { error: "expired" } };
    }, fetchImpl),
    /X_TOKEN_REFRESH_FAILED:400/,
  );
  assert.equal(attempt, 1);
});
