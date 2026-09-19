import assert from "node:assert/strict";
import test from "node:test";
import {
  OAuthConnectUserError,
  completeConnection,
  hashState,
  resolveConnectingUser,
  startConnection,
} from "./oauth_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "anon-key-fixture";
const CLIENT_ID = "x-client-id-fixture";
const CLIENT_SECRET = "x-client-secret-fixture";

function authUserResponse(id: string): Response {
  return Response.json({ id, email: "qa@example.test" });
}

test("resolveConnectingUser: no Authorization header is rejected before any network call", async () => {
  let calls = 0;
  await assert.rejects(
    () => resolveConnectingUser({
      authorizationHeader: null, supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY,
      fetchImpl: async () => { calls += 1; return authUserResponse("u1"); },
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED" && error.status === 401,
  );
  assert.equal(calls, 0);
});

test("resolveConnectingUser: a token Supabase Auth rejects is rejected (never proceeds as anonymous)", async () => {
  await assert.rejects(
    () => resolveConnectingUser({
      authorizationHeader: "Bearer bad-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY,
      fetchImpl: async () => new Response("invalid", { status: 401 }),
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.status === 401,
  );
});

test("resolveConnectingUser: a valid token resolves the real user id, using apikey=anon (never service_role)", async () => {
  let capturedHeaders: Record<string, string> = {};
  const result = await resolveConnectingUser({
    authorizationHeader: "Bearer real-user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY,
    fetchImpl: async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return authUserResponse("user-123");
    },
  });
  assert.equal(result.userId, "user-123");
  assert.equal(capturedHeaders.apikey, ANON_KEY);
  assert.equal(capturedHeaders.Authorization, "Bearer real-user-token");
});

test("startConnection: rejects a too-short/empty raw state before ever calling the RPC", async () => {
  let rpcCalls = 0;
  await assert.rejects(
    () => startConnection({
      request: { rawState: "short", codeChallenge: "c", redirectUri: "app://cb" },
      userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
      fetchImpl: async () => { rpcCalls += 1; return Response.json([{ brand_id: "u_x", social_account_id: "sa_x" }]); },
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "OAUTH_STATE_INPUT_INVALID",
  );
  assert.equal(rpcCalls, 0);
});

test("startConnection: hashes the raw state exactly once for DB storage, but sends X the RAW state unchanged (K2 double-hash fix)", async () => {
  const rawState = "client-generated-raw-state-value-1234567890";
  const expectedHash = await hashState(rawState);
  let capturedAuth = "";
  let capturedBody: Record<string, unknown> = {};
  const result = await startConnection({
    request: { rawState, codeChallenge: "challenge-value", redirectUri: "kabumori-social://oauth-callback" },
    userAccessToken: "real-user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
    fetchImpl: async (input, init) => {
      assert.equal(String(input), `${SUPABASE_URL}/rest/v1/rpc/begin_social_mobile_x_oauth_connection`);
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      capturedBody = JSON.parse(String(init?.body));
      return Response.json([{ brand_id: "u_abcdef", social_account_id: "sa_abcdef" }]);
    },
  });
  assert.equal(capturedAuth, "Bearer real-user-jwt");
  // The DB only ever sees the hash -- never the raw state.
  assert.equal(capturedBody.p_state_hash, expectedHash);
  assert.equal(capturedBody.p_redirect_uri, "kabumori-social://oauth-callback");
  assert.equal(result.brandId, "u_abcdef");
  assert.equal(result.socialAccountId, "sa_abcdef");
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  // X gets the RAW state, not the hash -- this is the exact bug K2 found: sending the hash here made the
  // value X returns unusable, because completeConnection() correctly hashes whatever X returns exactly
  // once, expecting that to be the raw value.
  assert.equal(url.searchParams.get("state"), rawState);
  assert.notEqual(url.searchParams.get("state"), expectedHash);
  assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.doesNotMatch(result.authorizationUrl, /client_secret/u);
});

test("startConnection: requests only the minimum read, posting, media-upload, and refresh scopes", async () => {
  const result = await startConnection({
    request: {
      rawState: "minimum-scope-test-raw-state-value",
      codeChallenge: "challenge-value",
      redirectUri: "kabumori-social://oauth-callback",
    },
    userAccessToken: "user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
    fetchImpl: async () => Response.json([{ brand_id: "u_scope", social_account_id: "sa_scope" }]),
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get("scope"), "tweet.read users.read tweet.write media.write offline.access");
});

test("startConnection: a cross-user or no-membership rejection from the RPC (e.g. ownership DB error) propagates as a real failure, not a fabricated success", async () => {
  await assert.rejects(
    () => startConnection({
      request: { rawState: "a-sufficiently-long-raw-state-value", codeChallenge: "c", redirectUri: "app://cb" },
      userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
      fetchImpl: async () => Response.json({ message: "SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED" }, { status: 400 }),
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED",
  );
});

// K2-required: prove that exactly one hash computation flows through the whole chain --
// raw state -> start() -> the authorization URL's `state` -> callback -> consume()'s lookup hash --
// and that they match exactly once. This is the direct regression test for the double-hash bug: before
// the fix, `consumeQueriedHash` here would have been hashState(hashState(rawState)), which never equals
// what begin() stored.
test("end-to-end: a raw state generated once flows through start -> authorization URL -> callback -> consume with exactly one matching hash", async () => {
  const rawState = "one-raw-state-used-across-the-whole-flow";
  let storedHash = "";
  const startResult = await startConnection({
    request: { rawState, codeChallenge: "c", redirectUri: "kabumori-social://oauth-callback" },
    userAccessToken: "user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
    fetchImpl: async (_input, init) => {
      storedHash = JSON.parse(String(init?.body)).p_state_hash;
      return Response.json([{ brand_id: "u_x", social_account_id: "sa_x" }]);
    },
  });

  // Simulates X returning the exact `state` value unchanged in the deep-link callback.
  const stateReturnedByX = new URL(startResult.authorizationUrl).searchParams.get("state")!;
  assert.equal(stateReturnedByX, rawState);

  let consumeQueriedHash = "";
  const result = await completeConnection({
    request: { code: "auth-code", state: stateReturnedByX, codeVerifier: "verifier", redirectUri: "kabumori-social://oauth-callback" },
    userAccessToken: "user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("consume_social_mobile_x_oauth_state")) {
        consumeQueriedHash = JSON.parse(String(init?.body)).p_state_hash;
        if (consumeQueriedHash !== storedHash) return Response.json({ message: "OAUTH_STATE_NOT_CONSUMABLE" }, { status: 400 });
        return Response.json([{ oauth_state_id: "state-1", redirect_uri: "kabumori-social://oauth-callback", brand_id: "u_x", social_account_id: "sa_x" }]);
      }
      if (url === "https://api.x.com/2/oauth2/token") return Response.json({ access_token: "a", refresh_token: "r" });
      if (url === "https://api.x.com/2/users/me") return Response.json({ data: { id: "1", username: "user1" } });
      if (url.includes("complete_social_mobile_x_oauth_connection")) return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  assert.equal(consumeQueriedHash, storedHash);
  assert.equal(result.connectionStatus, "identity_verified");
});

test("completeConnection: a redirect_uri mismatch between the consumed state and the callback request is rejected before any token exchange", async () => {
  let tokenExchangeCalls = 0;
  await assert.rejects(
    () => completeConnection({
      request: { code: "auth-code", state: "raw-state", codeVerifier: "verifier-value", redirectUri: "app://cb-different" },
      userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("consume_social_mobile_x_oauth_state")) {
          return Response.json([{ oauth_state_id: "state-1", redirect_uri: "app://cb-original", brand_id: "u_x", social_account_id: "sa_x" }]);
        }
        tokenExchangeCalls += 1;
        return new Response("should not be called", { status: 200 });
      },
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "OAUTH_STATE_REDIRECT_MISMATCH",
  );
  assert.equal(tokenExchangeCalls, 0);
});

test("completeConnection: an unknown/foreign/expired state (consume() rejects) is rejected before any token exchange", async () => {
  let tokenExchangeCalls = 0;
  await assert.rejects(
    () => completeConnection({
      request: { code: "auth-code", state: "raw-state", codeVerifier: "verifier-value", redirectUri: "app://cb" },
      userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("consume_social_mobile_x_oauth_state")) {
          return Response.json({ message: "OAUTH_STATE_NOT_CONSUMABLE" }, { status: 400 });
        }
        tokenExchangeCalls += 1;
        return new Response("should not be called", { status: 200 });
      },
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "OAUTH_STATE_NOT_CONSUMABLE",
  );
  assert.equal(tokenExchangeCalls, 0);
});

test("completeConnection: happy path exchanges the code, reads identity, completes via the RPC (passing oauth_state_id, forwarding the user JWT), and never returns a token in its result", async () => {
  const calls: string[] = [];
  const result = await completeConnection({
    request: { code: "auth-code", state: "raw-state", codeVerifier: "verifier-value", redirectUri: "kabumori-social://oauth-callback" },
    userAccessToken: "real-user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("consume_social_mobile_x_oauth_state")) {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer real-user-jwt");
        return Response.json([{ oauth_state_id: "state-abcdef", redirect_uri: "kabumori-social://oauth-callback", brand_id: "u_abcdef", social_account_id: "sa_abcdef" }]);
      }
      if (url === "https://api.x.com/2/oauth2/token") {
        const params = new URLSearchParams(String(init?.body));
        assert.equal(params.get("code"), "auth-code");
        assert.equal(params.get("code_verifier"), "verifier-value");
        return Response.json({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token" });
      }
      if (url === "https://api.x.com/2/users/me") {
        return Response.json({ data: { id: "999", username: "some_new_user" } });
      }
      if (url.includes("complete_social_mobile_x_oauth_connection")) {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer real-user-jwt");
        const body = JSON.parse(String(init?.body));
        assert.equal(body.p_oauth_state_id, "state-abcdef");
        assert.equal(Object.hasOwn(body, "p_social_account_id"), false);
        assert.equal(body.p_platform_user_id, "999");
        assert.equal(body.p_handle, "some_new_user");
        assert.equal(body.p_access_token, "fixture-access-token");
        assert.equal(body.p_refresh_token, "fixture-refresh-token");
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  assert.equal(result.brandId, "u_abcdef");
  assert.equal(result.socialAccountId, "sa_abcdef");
  assert.equal(result.handle, "some_new_user");
  assert.equal(result.connectionStatus, "identity_verified");
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.equal(Object.hasOwn(result, "refreshToken"), false);
  assert.equal(JSON.stringify(result).includes("fixture-access-token"), false);
  assert.equal(JSON.stringify(result).includes("fixture-refresh-token"), false);
  assert.equal(calls.filter((url) => url === "https://api.x.com/2/oauth2/token").length, 1);
});

test("completeConnection: a duplicate/already-connected X account error from the RPC (unique_violation mapped server-side) propagates as a real failure", async () => {
  await assert.rejects(
    () => completeConnection({
      request: { code: "auth-code", state: "raw-state", codeVerifier: "v", redirectUri: "app://cb" },
      userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("consume_social_mobile_x_oauth_state")) {
          return Response.json([{ oauth_state_id: "state-1", redirect_uri: "app://cb", brand_id: "u_x", social_account_id: "sa_x" }]);
        }
        if (url === "https://api.x.com/2/oauth2/token") return Response.json({ access_token: "a", refresh_token: "r" });
        if (url === "https://api.x.com/2/users/me") return Response.json({ data: { id: "already-connected-elsewhere", username: "dup" } });
        if (url.includes("complete_social_mobile_x_oauth_connection")) return Response.json({ message: "X_ACCOUNT_ALREADY_CONNECTED" }, { status: 400 });
        throw new Error(`unexpected fetch: ${url}`);
      },
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "X_ACCOUNT_ALREADY_CONNECTED",
  );
});

test("completeConnection: a non-2xx token exchange fails closed and never calls the identity or complete steps", async () => {
  let laterCalls = 0;
  await assert.rejects(
    () => completeConnection({
      request: { code: "auth-code", state: "raw-state", codeVerifier: "v", redirectUri: "app://cb" },
      userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("consume_social_mobile_x_oauth_state")) {
          return Response.json([{ oauth_state_id: "state-1", redirect_uri: "app://cb", brand_id: "u_x", social_account_id: "sa_x" }]);
        }
        if (url === "https://api.x.com/2/oauth2/token") return new Response("rate limited", { status: 429 });
        laterCalls += 1;
        return new Response("should not be called", { status: 200 });
      },
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "X_TOKEN_EXCHANGE_FAILED:429",
  );
  assert.equal(laterCalls, 0);
});

// --- K2-required retry / idempotency / concurrency tests -------------------------------------------
//
// These use a small in-memory fake that mirrors exactly the DB-level contract the migration establishes:
// consume() is read-only and repeatable; complete() is the one place that atomically flips
// consumed_at from null to a timestamp, and only succeeds while it is still null. This is what makes each
// of the following real properties of the actual RPC design, not just properties of this fake.

type FakeOAuthState = { id: string; redirectUri: string; brandId: string; socialAccountId: string; consumedAt: string | null };

function makeFakeBackend(state: FakeOAuthState) {
  let boundPlatformUserId: string | null = null;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("consume_social_mobile_x_oauth_state")) {
      // Read-only: never mutates state.consumedAt, so calling this any number of times is safe.
      return Response.json([{ oauth_state_id: state.id, redirect_uri: state.redirectUri, brand_id: state.brandId, social_account_id: state.socialAccountId }]);
    }
    if (url.includes("complete_social_mobile_x_oauth_connection")) {
      const body = JSON.parse(String(init?.body));
      // Mirrors the migration's single atomic UPDATE ... WHERE consumed_at IS NULL.
      if (state.consumedAt !== null) {
        return Response.json({ message: "OAUTH_STATE_NOT_CONSUMABLE" }, { status: 400 });
      }
      if (boundPlatformUserId !== null && boundPlatformUserId !== body.p_platform_user_id) {
        return Response.json({ message: "X_IDENTITY_ACCOUNT_MISMATCH" }, { status: 400 });
      }
      state.consumedAt = new Date().toISOString();
      boundPlatformUserId = body.p_platform_user_id;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch in fake backend: ${url}`);
  };
  return { state, fetchImpl };
}

function baseArgs(overrides: Partial<Parameters<typeof completeConnection>[0]["request"]> = {}) {
  return {
    request: { code: "auth-code", state: "raw-state", codeVerifier: "verifier-value", redirectUri: "app://cb", ...overrides },
    userAccessToken: "user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  };
}

test("retry: a token-exchange failure leaves the state consumable, and a retried callback succeeds", async () => {
  const backend = makeFakeBackend({ id: "state-1", redirectUri: "app://cb", brandId: "u_x", socialAccountId: "sa_x", consumedAt: null });
  let tokenAttempt = 0;
  const flaky: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.x.com/2/oauth2/token") {
      tokenAttempt += 1;
      if (tokenAttempt === 1) return new Response("timeout", { status: 504 });
      return Response.json({ access_token: "a", refresh_token: "r" });
    }
    if (url === "https://api.x.com/2/users/me") return Response.json({ data: { id: "1", username: "user1" } });
    return backend.fetchImpl(input, init);
  };
  await assert.rejects(() => completeConnection({ ...baseArgs(), fetchImpl: flaky }), (error: unknown) => error instanceof OAuthConnectUserError && error.message === "X_TOKEN_EXCHANGE_FAILED:504");
  assert.equal(backend.state.consumedAt, null, "a failed token exchange must not have consumed the state");

  const retryResult = await completeConnection({ ...baseArgs(), fetchImpl: flaky });
  assert.equal(retryResult.connectionStatus, "identity_verified");
  assert.notEqual(backend.state.consumedAt, null);
});

test("retry: an identity-read failure leaves the state consumable, and a retried callback succeeds", async () => {
  const backend = makeFakeBackend({ id: "state-1", redirectUri: "app://cb", brandId: "u_x", socialAccountId: "sa_x", consumedAt: null });
  let identityAttempt = 0;
  const flaky: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.x.com/2/oauth2/token") return Response.json({ access_token: "a", refresh_token: "r" });
    if (url === "https://api.x.com/2/users/me") {
      identityAttempt += 1;
      if (identityAttempt === 1) return new Response("server error", { status: 503 });
      return Response.json({ data: { id: "1", username: "user1" } });
    }
    return backend.fetchImpl(input, init);
  };
  await assert.rejects(() => completeConnection({ ...baseArgs(), fetchImpl: flaky }), (error: unknown) => error instanceof OAuthConnectUserError && error.message === "X_IDENTITY_READ_FAILED:503");
  assert.equal(backend.state.consumedAt, null, "a failed identity read must not have consumed the state");

  const retryResult = await completeConnection({ ...baseArgs(), fetchImpl: flaky });
  assert.equal(retryResult.connectionStatus, "identity_verified");
});

test("retry: a completion/Vault-side RPC failure leaves the state consumable (per the fake's own contract: an error response never flips consumedAt), and a retried callback succeeds", async () => {
  const state: FakeOAuthState = { id: "state-1", redirectUri: "app://cb", brandId: "u_x", socialAccountId: "sa_x", consumedAt: null };
  let completeAttempt = 0;
  const flaky: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("consume_social_mobile_x_oauth_state")) {
      return Response.json([{ oauth_state_id: state.id, redirect_uri: state.redirectUri, brand_id: state.brandId, social_account_id: state.socialAccountId }]);
    }
    if (url === "https://api.x.com/2/oauth2/token") return Response.json({ access_token: "a", refresh_token: "r" });
    if (url === "https://api.x.com/2/users/me") return Response.json({ data: { id: "1", username: "user1" } });
    if (url.includes("complete_social_mobile_x_oauth_connection")) {
      completeAttempt += 1;
      if (completeAttempt === 1) return Response.json({ message: "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED" }, { status: 500 });
      state.consumedAt = new Date().toISOString();
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  await assert.rejects(() => completeConnection({ ...baseArgs(), fetchImpl: flaky }));
  assert.equal(state.consumedAt, null, "a failed completion RPC call must not have consumed the state (it never reached the atomic UPDATE)");

  const retryResult = await completeConnection({ ...baseArgs(), fetchImpl: flaky });
  assert.equal(retryResult.connectionStatus, "identity_verified");
});

test("replay: a successfully completed callback, replayed again with the same code/state, is denied -- not silently re-succeeded", async () => {
  const backend = makeFakeBackend({ id: "state-1", redirectUri: "app://cb", brandId: "u_x", socialAccountId: "sa_x", consumedAt: null });
  const identity = { id: "1", username: "user1" };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.x.com/2/oauth2/token") return Response.json({ access_token: "a", refresh_token: "r" });
    if (url === "https://api.x.com/2/users/me") return Response.json({ data: identity });
    return backend.fetchImpl(input, init);
  };
  const first = await completeConnection({ ...baseArgs(), fetchImpl });
  assert.equal(first.connectionStatus, "identity_verified");

  await assert.rejects(
    () => completeConnection({ ...baseArgs(), fetchImpl }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "OAUTH_STATE_NOT_CONSUMABLE",
  );
});

test("concurrency: two callbacks racing on the same state can never both succeed -- exactly one binding is created", async () => {
  const backend = makeFakeBackend({ id: "state-1", redirectUri: "app://cb", brandId: "u_x", socialAccountId: "sa_x", consumedAt: null });
  const identity = { id: "1", username: "user1" };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.x.com/2/oauth2/token") return Response.json({ access_token: "a", refresh_token: "r" });
    if (url === "https://api.x.com/2/users/me") return Response.json({ data: identity });
    return backend.fetchImpl(input, init);
  };
  const results = await Promise.allSettled([
    completeConnection({ ...baseArgs(), fetchImpl }),
    completeConnection({ ...baseArgs(), fetchImpl }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one of the two racing callbacks must succeed");
  assert.equal(rejected.length, 1, "the other must fail, not silently succeed a second time");
});

test("this module never imports the legacy/admin x-oauth-connect implementation or the shared token loader", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["oauth_logic.ts", "index.ts"]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(x-oauth-connect\/|token_loader|x_oauth2_post)[^"']*["']/u);
  }
});
