// G4-47 (H1 #306 25th review, P2 F1): G5's T13 raises its refusals with SQLSTATE 42501, and PostgREST answers 42501 with HTTP 403
// for an authenticated caller (its documented SQLSTATE -> HTTP table). The body is PostgREST's error JSON with T13's code as the
// message. Through the one RPC path (rpcAsUser) of begin, consume and complete, those must still reach the app as 401 / 409 / 503,
// and the app's own classifier must turn them into "sign in again" / "cannot connect yet" / "retry".
import assert from "node:assert/strict";
import test from "node:test";
import { completeConnection, OAuthConnectUserError, rpcRefusalStatus, startConnection } from "./oauth_logic.ts";
import { classifyXConnectFailure } from "../../../apps/social-mobile/src/lib/x-oauth-onboarding.ts";

const SUPABASE_URL = "https://example.supabase.co";
const ANON_KEY = "anon-key-fixture";
const CLIENT_ID = "x-client-id-fixture";
const CLIENT_SECRET = "x-client-secret-fixture";
const t13 = (message: string) => Response.json({ code: "42501", details: null, hint: null, message }, { status: 403 });

// [T13 code, Edge status, the app's classification]
const CASES: Array<[string, number, string]> = [
  ["ACCOUNT_LIFECYCLE_AUTH_REQUIRED", 401, "session_required"],
  ["ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND", 409, "workspace_blocked"],
  ["ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE", 503, "retryable"],
  ["SERVICE_NOT_REGISTERED", 409, "workspace_blocked"],
  ["SERVICE_NOT_ACTIVE", 409, "workspace_blocked"],
  ["SERVICE_DELETION_IN_PROGRESS", 409, "workspace_blocked"],
  ["ACCOUNT_DELETION_IN_PROGRESS", 409, "workspace_blocked"],
  ["ACCOUNT_LOCKED", 409, "workspace_blocked"],
];

const appSees = (error: OAuthConnectUserError) => classifyXConnectFailure({ name: "FunctionsHttpError", context: { status: error.status } });

test("rpcRefusalStatus: T13 codes arriving as HTTP 403 (SQLSTATE 42501) keep their own status", () => {
  for (const [code, status] of CASES) assert.equal(rpcRefusalStatus(code, 403), status, code);
  // PostgREST's own authentication / ACL answers (no known code) stay as they are
  assert.equal(rpcRefusalStatus("SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED", 403), 403);
  assert.equal(rpcRefusalStatus("SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED", 401), 401);
  // a T13 code without its own class (an internal T13 error) keeps PostgREST's status
  assert.equal(rpcRefusalStatus("ACCOUNT_LIFECYCLE_SERVICE_INVALID", 403), 403);
});

test("begin (startConnection): a T13 refusal as 403 reaches the app with its own status and class", async () => {
  for (const [code, status, kind] of CASES) {
    await assert.rejects(
      () => startConnection({
        request: { rawState: "client-generated-raw-state-value-1234567890", codeChallenge: "c", redirectUri: "kabumori-social://oauth-callback" },
        userAccessToken: "user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
        fetchImpl: () => Promise.resolve(t13(code)),
      }),
      (error: unknown) => error instanceof OAuthConnectUserError && error.message === code && error.status === status && appSees(error) === kind,
      code,
    );
  }
});

// the callback: consume answers first; or consume passes, X is reached and complete answers
function callback(refuseAt: "consume" | "complete", code: string) {
  return completeConnection({
    request: { code: "auth-code", state: "client-generated-raw-state-value-1234567890", codeVerifier: "verifier",
      redirectUri: "kabumori-social://oauth-callback" },
    userAccessToken: "user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    fetchImpl: (input) => {
      const url = String(input);
      if (url.includes("consume_social_mobile_x_oauth_state")) {
        return Promise.resolve(refuseAt === "consume" ? t13(code) : Response.json([{ oauth_state_id: "state-1",
          redirect_uri: "kabumori-social://oauth-callback", brand_id: "u_x", social_account_id: "sa_x" }]));
      }
      if (url === "https://api.x.com/2/oauth2/token") return Promise.resolve(Response.json({ access_token: "a", refresh_token: "r" }));
      if (url === "https://api.x.com/2/users/me") return Promise.resolve(Response.json({ data: { id: "1", username: "user1" } }));
      if (url.includes("complete_social_mobile_x_oauth_connection")) return Promise.resolve(t13(code));
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
  });
}

test("consume and complete (completeConnection): a T13 refusal as 403 reaches the app with its own status and class", async () => {
  for (const at of ["consume", "complete"] as const) {
    for (const [code, status, kind] of CASES) {
      await assert.rejects(
        () => callback(at, code),
        (error: unknown) => error instanceof OAuthConnectUserError && error.message === code && error.status === status && appSees(error) === kind,
        `${at} ${code}`,
      );
    }
  }
});

test("control: an unknown 403 (PostgREST's own ACL text) stays 403, no database text is echoed", async () => {
  await assert.rejects(
    () => startConnection({
      request: { rawState: "client-generated-raw-state-value-1234567890", codeChallenge: "c", redirectUri: "kabumori-social://oauth-callback" },
      userAccessToken: "user-jwt", supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, clientId: CLIENT_ID,
      fetchImpl: () => Promise.resolve(Response.json({ code: "42501", message: "permission denied for function begin_social_mobile_x_oauth_connection" },
        { status: 403 })),
    }),
    (error: unknown) => error instanceof OAuthConnectUserError && error.message === "SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED" && error.status === 403,
  );
});
