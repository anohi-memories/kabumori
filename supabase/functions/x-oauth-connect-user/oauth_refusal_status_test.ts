// G4-41: the HTTP status the Edge answers for each RPC refusal of the X begin / complete (incl. the G4 candidate's codes).
import assert from "node:assert/strict";
import test from "node:test";
import { OAuthConnectUserError, rpcRefusalStatus, startConnection } from "./oauth_logic.ts";

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
