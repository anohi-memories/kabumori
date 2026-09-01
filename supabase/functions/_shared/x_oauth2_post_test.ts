import assert from "node:assert/strict";
import test from "node:test";
import { postToXWithRefresh, type XAuthContext } from "./x_oauth2_post.ts";

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
