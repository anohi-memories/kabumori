// G4-41: the HTTP status the Edge answers for each RPC refusal of the X begin / complete (incl. the G4 candidate's codes).
import assert from "node:assert/strict";
import test from "node:test";
import { OAuthConnectUserError, rpcRefusalCode, rpcRefusalStatus, startConnection } from "./oauth_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "anon-key-fixture";
const CLIENT_ID = "x-client-id-fixture";

test("rpcRefusalStatus: session refusals are 401, workspace refusals 409, the rest 400", () => {
  for (const code of ["SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED", "SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE"]) {
    assert.equal(rpcRefusalStatus(code, 400), 401, code);
  }
  for (const code of [
    "OWN_WORKSPACE_CONFLICT", "WORKSPACE_OWNER_UNKNOWN", "WORKSPACE_VERDICT_UNKNOWN", "OWNER_EPOCH_UNAVAILABLE",
    "SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED",
  ]) {
    assert.equal(rpcRefusalStatus(code, 400), 409, code);
  }
  for (const code of [
    "OAUTH_STATE_NOT_CONSUMABLE", "OAUTH_STATE_SUPERSEDED", "OAUTH_STATE_NOT_BOUND", "OWNER_EPOCH_CHANGED",
    "X_CONNECTION_CHANGED", "X_ACCOUNT_ALREADY_CONNECTED", "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED", "",
  ]) {
    assert.equal(rpcRefusalStatus(code, 400), 400, code);
  }
  // PostgREST's own 401 / 403 are kept whatever the code says
  assert.equal(rpcRefusalStatus("OWN_WORKSPACE_CONFLICT", 403), 403);
  assert.equal(rpcRefusalStatus("anything", 401), 401);
});

async function startWithRefusal(message: string, status = 400) {
  return await startConnection({
    request: {
      rawState: "client-generated-raw-state-value-1234567890",
      codeChallenge: "challenge-value",
      redirectUri: "kabumori-social://oauth-callback",
    },
    userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
    fetchImpl: () => Promise.resolve(Response.json({ message }, { status })),
  });
}

test("startConnection: a begin refused for the workspace answers 409 with the RPC's code", async () => {
  await assert.rejects(
    () => startWithRefusal("OWN_WORKSPACE_CONFLICT"),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "OWN_WORKSPACE_CONFLICT" && error.status === 409,
  );
});

test("startConnection: a begin refused for a dead / anonymous session answers 401", async () => {
  await assert.rejects(
    () => startWithRefusal("SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE"),
    (error: unknown) =>
      error instanceof OAuthConnectUserError && error.message === "SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE" && error.status === 401,
  );
});

test("startConnection: an unreadable refusal body keeps the generic code and 400", async () => {
  await assert.rejects(
    () => startConnection({
      request: {
        rawState: "client-generated-raw-state-value-1234567890",
        codeChallenge: "challenge-value",
        redirectUri: "kabumori-social://oauth-callback",
      },
      userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
      fetchImpl: () => Promise.resolve(new Response("not json", { status: 400 })),
    }),
    (error: unknown) =>
      error instanceof OAuthConnectUserError && error.message === "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED" && error.status === 400,
  );
});

// G4-43: fixed codes only, and the registered redirect URI only (both carried over from PR #353)
test("rpcRefusalCode: a known code passes, anything else becomes the generic code", () => {
  for (const code of ["OWN_WORKSPACE_CONFLICT", "OAUTH_STATE_SUPERSEDED", "X_ACCOUNT_ALREADY_CONNECTED", "OAUTH_STATE_NOT_BOUND"]) {
    assert.equal(rpcRefusalCode(code), code);
  }
  for (const message of [
    'duplicate key value violates unique constraint "social_accounts_platform_user_id_key"',
    "permission denied for function begin_social_mobile_x_oauth_connection",
    "JWT expired", "", null, 42, undefined,
  ]) {
    assert.equal(rpcRefusalCode(message), "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED", String(message));
  }
});

test("startConnection: a database's own error text is never echoed; PostgREST's 401 is kept", async () => {
  await assert.rejects(
    () => startWithRefusal('duplicate key value violates unique constraint "x"'),
    (error: unknown) =>
      error instanceof OAuthConnectUserError && error.message === "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED" && error.status === 400,
  );
  await assert.rejects(
    () => startWithRefusal("JWT expired", 401),
    (error: unknown) =>
      error instanceof OAuthConnectUserError && error.message === "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED" && error.status === 401,
  );
});

test("startConnection: only the registered redirect URI begins (no RPC call otherwise)", async () => {
  for (const redirectUri of ["kabumori-social://oauth-callback/", "https://evil.example/cb", "KABUMORI-SOCIAL://oauth-callback"]) {
    let calls = 0;
    await assert.rejects(
      () => startConnection({
        request: { rawState: "client-generated-raw-state-value-1234567890", codeChallenge: "challenge-value", redirectUri },
        userAccessToken: "user-token", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
        fetchImpl: () => { calls += 1; return Promise.resolve(Response.json([{ brand_id: "u_x", social_account_id: "sa_x" }])); },
      }),
      (error: unknown) => error instanceof OAuthConnectUserError && error.message === "OAUTH_STATE_INPUT_INVALID",
      redirectUri,
    );
    assert.equal(calls, 0, redirectUri);
  }
});

// G4-46: G5's T13 codes (005 calls T13 first in begin / consume / complete) reach the app with statuses it can act on
test("T13 refusals: sign in again (401), cannot connect yet (409), transient (503), anything else 400", () => {
  assert.equal(rpcRefusalStatus("ACCOUNT_LIFECYCLE_AUTH_REQUIRED", 400), 401);
  for (const code of ["ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND", "SERVICE_NOT_REGISTERED", "SERVICE_NOT_ACTIVE",
    "SERVICE_DELETION_IN_PROGRESS", "ACCOUNT_DELETION_IN_PROGRESS", "ACCOUNT_LOCKED"]) {
    assert.equal(rpcRefusalStatus(code, 400), 409, code);
  }
  assert.equal(rpcRefusalStatus("ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE", 400), 503);
  assert.equal(rpcRefusalStatus("ACCOUNT_LIFECYCLE_SERVICE_INVALID", 400), 400);
});

test("T13 refusals are fixed codes (passed through), every one of the guard's run-time codes", () => {
  // the run-time codes of T13 (main supabase/migrations/20261010051938_common_account_service_write_guard.sql, read at 21a5cad4;
  // that migration is not in this branch's base). supabase/tests/postona_g4_x_oauth_t13_run.sh shows the real ones come back.
  for (const code of ["ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND", "ACCOUNT_LIFECYCLE_SERVICE_INVALID",
    "ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE", "ACCOUNT_DELETION_IN_PROGRESS", "ACCOUNT_LOCKED", "SERVICE_NOT_REGISTERED",
    "SERVICE_NOT_ACTIVE", "SERVICE_DELETION_IN_PROGRESS"]) {
    assert.equal(rpcRefusalCode(code), code, code);
  }
});

test("startConnection: a person without POSTONA (T13) answers 409, a writer fence outage 503", async () => {
  await assert.rejects(
    () => startWithRefusal("ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND"),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND" && error.status === 409,
  );
  await assert.rejects(
    () => startWithRefusal("ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE"),
    (error: unknown) =>
      error instanceof OAuthConnectUserError && error.message === "ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE" && error.status === 503,
  );
});
