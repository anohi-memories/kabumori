import assert from "node:assert/strict";
import test from "node:test";
import { runKabumoriRefreshOnlyProof } from "./kabumori_recovery.ts";
import {
  probeLegacyXTokenStore,
  saveLegacyXTokens,
} from "./legacy_token_store.ts";

const SUPABASE_URL = "https://example.invalid";
const SERVICE_ROLE_KEY = "test-service-role-key";
const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";

test("legacy token probe distinguishes current-key decryption without exposing token material", async () => {
  let storedRow: Record<string, string> | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (
      url.includes("oauth_token_store?on_conflict=provider") &&
      init?.method === "POST"
    ) {
      storedRow = JSON.parse(String(init.body)) as Record<string, string>;
      return new Response(null, { status: 201 });
    }
    if (url.includes("oauth_token_store?")) {
      return Response.json(storedRow ? [storedRow] : []);
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  await saveLegacyXTokens({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    clientSecret: CLIENT_SECRET,
    tokens: { accessToken: "access-private", refreshToken: "refresh-private" },
    expiresIn: 7200,
    fetchImpl,
  });
  assert.ok(storedRow);
  assert.doesNotMatch(
    JSON.stringify(storedRow),
    /access-private|refresh-private/u,
  );
  assert.equal(
    await probeLegacyXTokenStore({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    }),
    "decryptable",
  );
  assert.equal(
    await probeLegacyXTokenStore({
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SERVICE_ROLE_KEY,
      clientSecret: "different-client-secret",
      fetchImpl,
    }),
    "not_decryptable_with_current_client_secret",
  );
});

test("refresh-only proof rotates, stores, reloads, and identifies Kabumori without posting", async () => {
  let storedRow: Record<string, string> | null = null;
  let tokenEndpointCalls = 0;
  let identityCalls = 0;
  let xPostCalls = 0;
  const trace: string[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.x.com/2/oauth2/token") {
      trace.push("refresh");
      tokenEndpointCalls += 1;
      assert.equal(init?.method, "POST");
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "fresh-auth-refresh");
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 7200,
      });
    }
    if (url === "https://api.x.com/2/users/me") {
      trace.push("identity");
      identityCalls += 1;
      return Response.json({
        data: { id: "kabumori-platform-id", username: "yume_daka" },
      });
    }
    if (
      url.includes("oauth_token_store?on_conflict=provider") &&
      init?.method === "POST"
    ) {
      trace.push("save");
      storedRow = JSON.parse(String(init.body)) as Record<string, string>;
      assert.doesNotMatch(
        JSON.stringify(storedRow),
        /rotated-access|rotated-refresh/u,
      );
      return new Response(null, { status: 201 });
    }
    if (url.includes("oauth_token_store?")) {
      trace.push("reload");
      return Response.json(storedRow ? [storedRow] : []);
    }
    if (url.includes("/2/tweets") || url.includes("/2/media")) {
      xPostCalls += 1;
      throw new Error("posting endpoint must never be called");
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await runKabumoriRefreshOnlyProof({
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SERVICE_ROLE_KEY,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    initialTokens: {
      accessToken: "fresh-auth-access",
      refreshToken: "fresh-auth-refresh",
    },
    expectedPlatformUserId: "kabumori-platform-id",
    expectedHandle: "yume_daka",
    fetchImpl,
  });

  assert.deepEqual(trace, [
    "refresh",
    "identity",
    "save",
    "reload",
    "identity",
  ]);
  assert.equal(tokenEndpointCalls, 1);
  assert.equal(identityCalls, 2);
  assert.equal(xPostCalls, 0);
  assert.deepEqual(result, {
    platformUserId: "kabumori-platform-id",
    tokenEndpoint2xx: true,
    savedAndReloaded: true,
    identityVerified: true,
  });
});
