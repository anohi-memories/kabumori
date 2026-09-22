import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoryLearningError,
  MAX_HISTORY_PAGES,
  MAX_HISTORY_POSTS,
  createXHistoryPageFetcher,
  createHistoryLearningCandidateDependencies,
  disabledHistoryLearningDependencies,
  handleHistoryLearningRequest,
  normalizeXHistoryError,
  runHistoryLearning,
  type HistoryLearningDependencies,
} from "./logic.ts";

const userId = "auth-user";
const workspaceId = "workspace-owned";
const trustedPlatformUserId = "x-trusted-123";
const calls: string[] = [];

function deps(overrides: Partial<HistoryLearningDependencies> = {}): HistoryLearningDependencies {
  return {
    readAuthUser: async (bearer) => { calls.push(`auth:${bearer}`); return { id: userId }; },
    readOwnerMemberships: async (id) => { calls.push(`memberships:${id}`); return [{ workspaceId, role: "owner" }]; },
    readWorkspace: async (id) => { calls.push(`workspace:${id}`); return { id, ownerUserId: userId }; },
    readXAccounts: async (id) => { calls.push(`accounts:${id}`); return [{ id: "account-1", workspaceId: id, platform: "x", connectionStatus: "identity_verified", platformUserId: trustedPlatformUserId, handle: "qa" }]; },
    readAccessToken: async (binding) => { calls.push(`vault:${binding.accountId}:${binding.authUserId}`); return "opaque-token"; },
    fetchXPage: async ({ platformUserId, accessToken, paginationToken }) => { calls.push(`x:${platformUserId}:${accessToken}:${paginationToken ?? "first"}`); return { data: [{ id: "1", text: "朝の相場を確認します #株", in_reply_to_user_id: undefined }, { id: "2", text: "RT @someone", referenced_tweets: [{ type: "retweeted" }] }], meta: {} }; },
    now: () => "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function request(body: unknown, authorization = "Bearer client-token") {
  return new Request("https://edge.example/social-mobile-history-learning", { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("missing auth denies before ownership, Vault, and X", async () => {
  calls.length = 0;
  await assert.rejects(() => runHistoryLearning({ explicitConsent: true }, deps()), (error: unknown) => error instanceof HistoryLearningError && error.code === "AUTH_REQUIRED");
  assert.deepEqual(calls, []);
});

test("fresh final consent is required and no fetch occurs without it", async () => {
  calls.length = 0;
  const response = await handleHistoryLearningRequest(request({ explicit_consent: false }), deps());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "HISTORY_CONSENT_REQUIRED");
  assert.deepEqual(calls, []);
});

test("non-owner workspace fails closed", async () => {
  await assert.rejects(() => runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true, requestedWorkspaceId: "other" }, deps()), (error: unknown) => error instanceof HistoryLearningError && error.code === "HISTORY_WORKSPACE_FORBIDDEN");
});

test("multiple X accounts, non-verified account, and missing platform id are denied before reader; missing token fails closed", async () => {
  await assert.rejects(() => runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true }, deps({ readXAccounts: async () => [
    { id: "a", workspaceId, platform: "x", connectionStatus: "identity_verified", platformUserId: "1", handle: "a" },
    { id: "b", workspaceId, platform: "x", connectionStatus: "identity_verified", platformUserId: "2", handle: "b" },
  ] })), (error: unknown) => error instanceof HistoryLearningError && error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED");
  let tokenReads = 0;
  await assert.rejects(() => runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true }, deps({ readXAccounts: async () => [{ id: "a", workspaceId, platform: "x", connectionStatus: "authorization_pending", platformUserId: "1", handle: "a" }], readAccessToken: async () => { tokenReads += 1; return "should-not-read"; } })), (error: unknown) => error instanceof HistoryLearningError && error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED");
  await assert.rejects(() => runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true }, deps({ readXAccounts: async () => [{ id: "a", workspaceId, platform: "x", connectionStatus: "identity_verified", platformUserId: null, handle: "a" }], readAccessToken: async () => { tokenReads += 1; return "should-not-read"; } })), (error: unknown) => error instanceof HistoryLearningError && error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED");
  await assert.rejects(() => runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true }, deps({ readAccessToken: async () => null })), (error: unknown) => error instanceof HistoryLearningError && error.code === "HISTORY_ACCESS_TOKEN_UNAVAILABLE");
  await assert.rejects(() => runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true }, deps({ readXAccounts: async () => [
    { id: "a", workspaceId, platform: "x", connectionStatus: "identity_verified", platformUserId: "1", handle: "a" },
    { id: "b", workspaceId, platform: "x", connectionStatus: "authorization_pending", platformUserId: "2", handle: "b" },
  ] })), (error: unknown) => error instanceof HistoryLearningError && error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED");
  assert.equal(tokenReads, 0);
});

test("client identity fields are ignored; trusted account binding and call order are fixed", async () => {
  calls.length = 0;
  const result = await runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true, requestedWorkspaceId: workspaceId, clientPlatformUserId: "attacker-id" } as never, deps());
  assert.equal(result.targetHandle, "qa");
  assert.deepEqual(calls, ["auth:client-token", "memberships:auth-user", `workspace:${workspaceId}`, `accounts:${workspaceId}`, "vault:account-1:auth-user", `x:${trustedPlatformUserId}:opaque-token:first`]);
});

test("history reader receives only the verified account binding", async () => {
  const bindings: Array<{ accountId: string; authUserId: string }> = [];
  const result = await runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true }, deps({
    readAccessToken: async (binding) => { bindings.push(binding); return "opaque-token"; },
  }));
  assert.equal(result.success, true);
  assert.deepEqual(bindings, [{ authUserId: userId, accountId: "account-1", workspaceId, platform: "x", connectionStatus: "identity_verified", platformUserId: trustedPlatformUserId }]);
});

test("disabled production default cannot read Vault or call X", async () => {
  const disabled = disabledHistoryLearningDependencies();
  let tokenReads = 0;
  let xCalls = 0;
  const response = await handleHistoryLearningRequest(request({ explicit_consent: true }), {
    ...disabled,
    readAccessToken: async () => { tokenReads += 1; return null; },
    fetchXPage: async () => { xCalls += 1; return {}; },
  });
  assert.equal(response.status, 401);
  assert.equal(tokenReads, 0);
  assert.equal(xCalls, 0);
});

test("candidate dependency factory composes the dedicated RPC reader without enabling default entrypoint", async () => {
  const base = deps();
  const { readAccessToken: _disabledReader, ...baseWithoutReader } = base;
  void _disabledReader;
  let rpcCalls = 0;
  const candidate = createHistoryLearningCandidateDependencies(baseWithoutReader, {
    supabaseUrl: "https://project.example",
    serviceRoleKey: "server-only-test-key",
    fetchImpl: async (_input, init) => {
      rpcCalls += 1;
      assert.deepEqual(JSON.parse(String(init?.body)), {
        p_user_id: userId,
        p_social_account_id: "account-1",
      });
      return Response.json("opaque-token");
    },
  });
  const token = await candidate.readAccessToken({
    authUserId: userId,
    accountId: "account-1",
    workspaceId,
    platform: "x",
    connectionStatus: "identity_verified",
    platformUserId: trustedPlatformUserId,
  });
  assert.equal(token, "opaque-token");
  assert.equal(rpcCalls, 1);
});

test("history is bounded to 50 posts and 2 pages, filters replies/retweets, and stays unconfirmed", async () => {
  let pageCount = 0;
  const result = await runHistoryLearning({ authorization: "Bearer client-token", explicitConsent: true }, deps({
    fetchXPage: async ({ paginationToken }) => {
      pageCount += 1;
      return {
        data: Array.from({ length: 40 }, (_, index) => ({ id: `${pageCount}-${index}`, text: `post ${index}` })),
        meta: { next_token: paginationToken ? undefined : "next" },
      };
    },
  }));
  assert.equal(pageCount, MAX_HISTORY_PAGES);
  assert.equal(result.analyzedPostCount, MAX_HISTORY_POSTS);
  assert.equal(result.maxPosts, 50);
  assert.equal(result.maxPages, 2);
  assert.equal(result.persona.confirmed, false);
  assert.equal(result.persona.provenance, "past_post_analysis");
});

test("provider errors are normalized without exposing raw provider body", () => {
  assert.equal(normalizeXHistoryError({ status: 401, body: "secret provider body" }).code, "X_HISTORY_UNAUTHORIZED");
  assert.equal(normalizeXHistoryError({ status: 429 }).code, "X_HISTORY_RATE_LIMITED");
  assert.equal(normalizeXHistoryError({ status: 500, body: "raw" }).code, "X_HISTORY_UNAVAILABLE");
});

test("X adapter uses only the bounded read endpoint and never a write/media path", async () => {
  let seen: { url: URL; method: string; authorization: string | null } | null = null;
  const fetcher = createXHistoryPageFetcher(async (input, init) => {
    seen = { url: new URL(String(input)), method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("Authorization") };
    return Response.json({ data: [] });
  });
  await fetcher({ platformUserId: "trusted/123", accessToken: "opaque-token", paginationToken: "next" });
  assert.ok(seen);
  assert.equal(seen.method, "GET");
  assert.equal(seen.url.pathname, "/2/users/trusted%2F123/tweets");
  assert.equal(seen.url.searchParams.get("max_results"), "50");
  assert.equal(seen.url.searchParams.get("exclude"), "replies,retweets");
  assert.equal(seen.url.searchParams.get("pagination_token"), "next");
  assert.match(seen.url.searchParams.get("tweet.fields") ?? "", /referenced_tweets/u);
  assert.equal(seen.authorization, "Bearer opaque-token");
  assert.equal(seen.url.pathname.includes("media") || seen.url.pathname.includes("publish"), false);
});

test("response contains no token, Vault ref, raw post, or publish authority", async () => {
  const response = await handleHistoryLearningRequest(request({ explicit_consent: true }), deps());
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(body.includes("opaque-token"), false);
  assert.equal(body.includes("vault-access-ref"), false);
  assert.equal(body.includes("朝の相場を確認します"), false);
  assert.equal(body.includes("publish"), false);
  assert.equal(body.includes("media"), false);
});

test("handler method gate and disabled default are safe", async () => {
  const get = await handleHistoryLearningRequest(new Request("https://edge.example", { method: "GET" }), deps());
  assert.equal(get.status, 405);
  const options = await handleHistoryLearningRequest(new Request("https://edge.example", { method: "OPTIONS" }), deps());
  assert.equal(options.status, 200);
});
