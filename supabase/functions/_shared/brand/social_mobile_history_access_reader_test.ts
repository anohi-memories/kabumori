import assert from "node:assert/strict";
import test from "node:test";
import {
  HistoryAccessTokenReadError,
  readVerifiedHistoryAccessToken,
  type TrustedHistoryAccountBinding,
} from "./social_mobile_history_access_reader.ts";

const binding: TrustedHistoryAccountBinding = {
  accountId: "account-owned",
  workspaceId: "workspace-owned",
  platform: "x",
  connectionStatus: "identity_verified",
  platformUserId: "trusted-platform-id",
  accessTokenSecretRef: "access-ref-only",
};

test("reads only the trusted access reference after verified binding", async () => {
  const refs: string[] = [];
  const token = await readVerifiedHistoryAccessToken(binding, {
    readAccessToken: async (ref) => {
      refs.push(ref);
      return "opaque-access-token";
    },
  });
  assert.equal(token, "opaque-access-token");
  assert.deepEqual(refs, ["access-ref-only"]);
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

test("contract has no refresh selector or public response capability", () => {
  const source = String(readVerifiedHistoryAccessToken);
  assert.equal(source.includes("refresh"), false);
  assert.equal(source.includes("Response"), false);
  assert.equal(source.includes("console"), false);
});
