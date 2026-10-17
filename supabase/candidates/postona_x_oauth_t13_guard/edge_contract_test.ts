// The live x-oauth-connect-user logic (unchanged) against the T13 guard's refusals. MOCK_ONLY: fetch answers stand in
// for PostgREST and X. What PostgREST really answers for SQLSTATE 42501 / 55P03 is NOT proven here (managed behaviour
// unverified): the test covers 403 / 400 / 500 bodies carrying the guard's code, and checks the Edge never reaches X's
// token endpoint and never reports a connection when any RPC refuses.
import assert from "node:assert/strict";
import { completeConnection, OAuthConnectUserError, startConnection } from "../../functions/x-oauth-connect-user/oauth_logic.ts";

const BASE = { supabaseUrl: "https://project.example.invalid", anonKey: "publishable", userAccessToken: "user-jwt-0123456789abcdef" };
const callback = { code: "fake-code", state: "raw-state-0123456789abcdef", codeVerifier: "fake-verifier-0123456789", redirectUri: "kabumori://oauth/x" };

function fakeFetch(refuse: { rpc: string; status: number; message: string }) {
  const calls: string[] = [];
  const fetchImpl = (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(`/rpc/${refuse.rpc}`)) return Promise.resolve(Response.json({ code: "42501", message: refuse.message }, { status: refuse.status }));
    if (url.includes("/rpc/consume_social_mobile_x_oauth_state")) {
      return Promise.resolve(Response.json([{ oauth_state_id: "11111111-1111-4111-8111-111111111111", redirect_uri: callback.redirectUri, brand_id: "u_x", social_account_id: "sa_x" }]));
    }
    if (url.includes("api.x.com/2/oauth2/token")) return Promise.resolve(Response.json({ access_token: "fake-access", refresh_token: "fake-refresh", token_type: "bearer" }));
    if (url.includes("api.x.com/2/users/me")) return Promise.resolve(Response.json({ data: { id: "123", username: "fake" } }));
    return Promise.resolve(new Response("", { status: 204 }));
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

async function refusedWith<T>(promise: Promise<T>): Promise<OAuthConnectUserError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OAuthConnectUserError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

for (const message of ["SERVICE_NOT_ACTIVE", "ACCOUNT_DELETION_IN_PROGRESS", "ACCOUNT_LOCKED", "ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "SOCIAL_MOBILE_OAUTH_SERVICE_BUSY"]) {
  Deno.test(`callback: consume refused (${message}) -> no X token exchange, no completion, the guard's code is kept`, async () => {
    for (const status of [403, 400, 500]) {
      const { fetchImpl, calls } = fakeFetch({ rpc: "consume_social_mobile_x_oauth_state", status, message });
      const error = await refusedWith(completeConnection({ ...BASE, request: callback, clientId: "cid", clientSecret: "csecret", fetchImpl }));
      assert.equal(error.message, message);
      assert.ok(calls.every((url) => !url.includes("api.x.com")), "X never contacted");
      assert.ok(calls.every((url) => !url.includes("complete_social_mobile_x_oauth_connection")));
    }
  });
}

Deno.test("callback: complete refused after the exchange (service ended meanwhile) -> refused, never a connection result", async () => {
  const { fetchImpl, calls } = fakeFetch({ rpc: "complete_social_mobile_x_oauth_connection", status: 403, message: "SERVICE_NOT_ACTIVE" });
  const error = await refusedWith(completeConnection({ ...BASE, request: callback, clientId: "cid", clientSecret: "csecret", fetchImpl }));
  assert.equal(error.message, "SERVICE_NOT_ACTIVE");
  assert.equal(error.status, 403);
  assert.ok(calls.some((url) => url.includes("complete_social_mobile_x_oauth_connection")));
});

Deno.test("start: begin refused -> no authorization URL is produced", async () => {
  const { fetchImpl, calls } = fakeFetch({ rpc: "begin_social_mobile_x_oauth_connection", status: 403, message: "SERVICE_NOT_ACTIVE" });
  const error = await refusedWith(startConnection({ ...BASE, clientId: "cid", fetchImpl,
    request: { rawState: "raw-state-0123456789abcdef", codeChallenge: "challenge", redirectUri: "kabumori://oauth/x" } }));
  assert.equal(error.message, "SERVICE_NOT_ACTIVE");
  assert.equal(calls.length, 1);
});
