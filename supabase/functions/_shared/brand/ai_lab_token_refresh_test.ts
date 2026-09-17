import assert from "node:assert/strict";
import test from "node:test";
import {
  type AiLabRefreshContext,
  type AiLabTokenPair,
  type AiLabVaultTokenReference,
  publishAiLabWithRefresh,
  refreshAiLabTokens,
} from "./ai_lab_token_refresh.ts";

const context: AiLabRefreshContext = {
  brandId: "ai_salaryman_lab",
  socialAccountId: "ai_salaryman_lab_x",
  handle: "kaishain_ai_lab",
};
const reference: AiLabVaultTokenReference = {
  socialAccountId: "ai_salaryman_lab_x",
  accessTokenSecretRef: "11111111-1111-4111-8111-111111111111",
  refreshTokenSecretRef: "22222222-2222-4222-8222-222222222222",
};
const currentTokens: AiLabTokenPair = {
  accessToken: "old-access-token",
  refreshToken: "old-refresh-token",
};

function persistSpy(calls: unknown[]) {
  return async (args: unknown) => calls.push(args);
}

test("valid access token publishes once without refresh", async () => {
  let publishes = 0;
  let refreshRequests = 0;
  const result = await publishAiLabWithRefresh({
    context,
    tokenReference: reference,
    currentTokens,
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenEndpoint: "https://x.test/token",
    persist: persistSpy([]),
    publish: async (token) => {
      publishes += 1;
      assert.equal(token, "old-access-token");
      return { status: 201, body: { data: { id: "post-1" } } };
    },
    fetchImpl: async () => {
      refreshRequests += 1;
      return Response.json({ access_token: "unexpected" });
    },
  });
  assert.equal(publishes, 1);
  assert.equal(refreshRequests, 0);
  assert.equal(result.refreshExecuted, false);
});

test("first 401 refreshes once, persists, then retries once", async () => {
  const publishes: string[] = [];
  const persisted: unknown[] = [];
  let refreshRequests = 0;
  const result = await publishAiLabWithRefresh({
    context,
    tokenReference: reference,
    currentTokens,
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenEndpoint: "https://x.test/token",
    persist: persistSpy(persisted),
    publish: async (token) => {
      publishes.push(token);
      return publishes.length === 1
        ? { status: 401, body: { title: "unauthorized" } }
        : { status: 201, body: { data: { id: "post-2" } } };
    },
    fetchImpl: async (input, init) => {
      refreshRequests += 1;
      assert.equal(String(input), "https://x.test/token");
      assert.equal(init?.method, "POST");
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 7200,
      });
    },
  });
  assert.deepEqual(publishes, ["old-access-token", "new-access-token"]);
  assert.equal(refreshRequests, 1);
  assert.equal(result.refreshExecuted, true);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], {
    tokenReference: reference,
    tokens: {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
    },
    refreshTokenRotated: true,
  });
});

test("refresh without rotation preserves the existing refresh token", async () => {
  const persisted: unknown[] = [];
  const tokens = await refreshAiLabTokens({
    context,
    tokenReference: reference,
    currentTokens,
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenEndpoint: "https://x.test/token",
    persist: persistSpy(persisted),
    fetchImpl: async () => Response.json({ access_token: "new-access-token" }),
  });
  assert.deepEqual(tokens, {
    accessToken: "new-access-token",
    refreshToken: "old-refresh-token",
  });
  assert.equal(
    (persisted[0] as { refreshTokenRotated: boolean }).refreshTokenRotated,
    false,
  );
});

test("refresh failure fails closed without a publish retry", async () => {
  let publishes = 0;
  let persisted = 0;
  await assert.rejects(
    () =>
      publishAiLabWithRefresh({
        context,
        tokenReference: reference,
        currentTokens,
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://x.test/token",
        persist: async () => {
          persisted += 1;
        },
        publish: async () => {
          publishes += 1;
          return { status: 401, body: null };
        },
        fetchImpl: async () => new Response(null, { status: 400 }),
      }),
    { message: "AI_LAB_TOKEN_REFRESH_FAILED:400" },
  );
  assert.equal(publishes, 1);
  assert.equal(persisted, 0);
});

test("Vault persistence failure prevents the refreshed publish retry", async () => {
  let publishes = 0;
  await assert.rejects(
    () =>
      publishAiLabWithRefresh({
        context,
        tokenReference: reference,
        currentTokens,
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://x.test/token",
        persist: async () => {
          throw new Error("persistence detail must not escape");
        },
        publish: async () => {
          publishes += 1;
          return publishes === 1
            ? { status: 401, body: null }
            : { status: 201, body: { data: { id: "unsafe" } } };
        },
        fetchImpl: async () =>
          Response.json({ access_token: "new-access-token" }),
      }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal(
        (error as Error).message.includes("persistence detail"),
        false,
      );
      return true;
    },
  );
  assert.equal(publishes, 1);
});

test("second 401 stops after exactly one refresh and two publishes", async () => {
  let publishes = 0;
  let refreshRequests = 0;
  await assert.rejects(
    () =>
      publishAiLabWithRefresh({
        context,
        tokenReference: reference,
        currentTokens,
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://x.test/token",
        persist: persistSpy([]),
        publish: async () => {
          publishes += 1;
          return { status: 401, body: null };
        },
        fetchImpl: async () => {
          refreshRequests += 1;
          return Response.json({ access_token: "new-access-token" });
        },
      }),
    { message: "AI_LAB_PUBLISH_FAILED:401" },
  );
  assert.equal(publishes, 2);
  assert.equal(refreshRequests, 1);
});

test("unknown publish completion fails closed and never refreshes", async () => {
  let refreshRequests = 0;
  await assert.rejects(
    () =>
      publishAiLabWithRefresh({
        context,
        tokenReference: reference,
        currentTokens,
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://x.test/token",
        persist: persistSpy([]),
        publish: async () => {
          throw new Error("network detail must not escape");
        },
        fetchImpl: async () => {
          refreshRequests += 1;
          return Response.json({ access_token: "unexpected" });
        },
      }),
    { message: "AI_LAB_PUBLISH_UNCERTAIN" },
  );
  assert.equal(refreshRequests, 0);
});

test("wrong brand/account is rejected before refresh or publish", async () => {
  let refreshRequests = 0;
  let publishes = 0;
  await assert.rejects(
    () =>
      publishAiLabWithRefresh({
        context: { ...context, brandId: "kabumori" },
        tokenReference: reference,
        currentTokens,
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://x.test/token",
        persist: persistSpy([]),
        publish: async () => {
          publishes += 1;
          return { status: 401, body: null };
        },
        fetchImpl: async () => {
          refreshRequests += 1;
          return Response.json({ access_token: "unexpected" });
        },
      }),
    { message: "AI_LAB_REFRESH_SCOPE_MISMATCH" },
  );
  assert.equal(publishes, 0);
  assert.equal(refreshRequests, 0);
});

test("secret values are not copied into refresh errors", async () => {
  const secret = "super-secret-access-token";
  await assert.rejects(
    () =>
      refreshAiLabTokens({
        context,
        tokenReference: reference,
        currentTokens: { accessToken: secret, refreshToken: "refresh-secret" },
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://x.test/token",
        persist: persistSpy([]),
        fetchImpl: async () =>
          new Response("provider failure", { status: 401 }),
      }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message.includes(secret), false);
      assert.equal((error as Error).message.includes("refresh-secret"), false);
      return true;
    },
  );
});
