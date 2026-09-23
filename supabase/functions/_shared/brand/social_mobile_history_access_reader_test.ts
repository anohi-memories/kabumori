import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createHistoryAccessTokenRpcReader,
  HistoryAccessTokenReadError,
  readVerifiedHistoryAccessToken,
  type TrustedHistoryAccountBinding,
} from "./social_mobile_history_access_reader.ts";

const binding: TrustedHistoryAccountBinding = {
  authUserId: "11111111-1111-4111-8111-111111111111",
  accountId: "account-owned",
  workspaceId: "workspace-owned",
  platform: "x",
  connectionStatus: "identity_verified",
  platformUserId: "trusted-platform-id",
};

test("reads only the trusted account binding after verification", async () => {
  const bindings: TrustedHistoryAccountBinding[] = [];
  const token = await readVerifiedHistoryAccessToken(binding, {
    readAccessToken: async (received) => {
      bindings.push(received);
      return "opaque-access-token";
    },
  });
  assert.equal(token, "opaque-access-token");
  assert.deepEqual(bindings, [binding]);
  assert.equal("accessTokenSecretRef" in binding, false);
});

test("unverified or incomplete bindings fail before the reader", async () => {
  let reads = 0;
  await assert.rejects(
    () => readVerifiedHistoryAccessToken({ ...binding, connectionStatus: "authorization_pending" } as never, {
      readAccessToken: async () => { reads += 1; return "should-not-read"; },
    }),
    (error: unknown) => error instanceof HistoryAccessTokenReadError && error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED",
  );
  await assert.rejects(
    () => readVerifiedHistoryAccessToken({ ...binding, authUserId: "" }, {
      readAccessToken: async () => { reads += 1; return "should-not-read"; },
    }),
    (error: unknown) => error instanceof HistoryAccessTokenReadError && error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED",
  );
  await assert.rejects(
    () => readVerifiedHistoryAccessToken({ ...binding, platformUserId: "" }, {
      readAccessToken: async () => { reads += 1; return "should-not-read"; },
    }),
    (error: unknown) => error instanceof HistoryAccessTokenReadError && error.code === "HISTORY_ACCOUNT_NOT_CONFIGURED",
  );
  assert.equal(reads, 0);
});

test("missing access secret fails closed without exposing a value", async () => {
  await assert.rejects(
    () => readVerifiedHistoryAccessToken(binding, { readAccessToken: async () => null }),
    (error: unknown) => error instanceof HistoryAccessTokenReadError &&
      error.code === "HISTORY_ACCESS_TOKEN_UNAVAILABLE" &&
      !String(error).includes("opaque"),
  );
});

test("RPC adapter sends account identity only and sanitizes failures", async () => {
  const seen: Array<{ url: string; body: unknown; headers: Headers }> = [];
  const reader = createHistoryAccessTokenRpcReader({
    supabaseUrl: "https://project.example/",
    serviceRoleKey: "server-only-test-key",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return Response.json("opaque-access-token");
    },
  });
  assert.equal(await reader.readAccessToken(binding), "opaque-access-token");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://project.example/rest/v1/rpc/read_social_mobile_history_access_token");
  assert.deepEqual(seen[0].body, {
    p_user_id: binding.authUserId,
    p_social_account_id: binding.accountId,
  });
  assert.equal(JSON.stringify(seen[0].body).includes("secret"), false);
  assert.equal(seen[0].headers.get("Authorization"), "Bearer server-only-test-key");

  const failed = createHistoryAccessTokenRpcReader({
    supabaseUrl: "https://project.example",
    serviceRoleKey: "server-only-test-key",
    fetchImpl: async () => new Response("provider secret detail", { status: 403 }),
  });
  assert.equal(await failed.readAccessToken(binding), null);
});

test("contract has no refresh selector, generic secret id input, or log/response capability", () => {
  const source = String(readVerifiedHistoryAccessToken);
  assert.equal(source.includes("refresh"), false);
  assert.equal(source.includes("Response"), false);
  assert.equal(source.includes("console"), false);
  assert.equal(source.includes("SecretRef"), false);
  assert.equal(String(createHistoryAccessTokenRpcReader).includes("vault_refresh"), false);
  assert.equal(String(createHistoryAccessTokenRpcReader).includes("console"), false);
});

test("history-learning entrypoint keeps disabled default behind server-only exact gate", async () => {
  const entrypoint = await readFile(new URL("../../social-mobile-history-learning/index.ts", import.meta.url), "utf8");
  assert.match(entrypoint, /Deno\.env\.get\("SOCIAL_MOBILE_HISTORY_LIVE_ENABLED"\)/u);
  assert.match(entrypoint, /if \(!historyLiveEnabled/u);
  assert.match(entrypoint, /disabledHistoryLearningDependencies\(\)/u);
  assert.match(entrypoint, /createLiveHistoryDependencies/u);
  assert.doesNotMatch(entrypoint, /createHistoryLearningCandidateDependencies|createHistoryAccessTokenRpcReader/u);
});
