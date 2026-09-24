import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteConfirmationIssue,
  deleteMyAccount,
  deletionOutcome,
  type DeletionClient,
} from "../../src/lib/account-deletion.ts";

test("only an explicit server success becomes a deleted state", () => {
  assert.deepEqual(deletionOutcome(200, { success: true }), { ok: true });
  for (const [status, body] of [
    [200, { success: false }],
    [200, {}],
    [200, null],
    [401, { error: "ACCOUNT_DELETE_AUTH_REQUIRED" }],
    [500, { error: "ACCOUNT_DELETE_FAILED" }],
    [502, null],
  ] as const) {
    const outcome = deletionOutcome(status, body);
    assert.equal(outcome.ok, false, `${status} ${JSON.stringify(body)}`);
  }
});

test("a known error code gets its own message and an unknown one falls back", () => {
  const authRequired = deletionOutcome(401, { error: "ACCOUNT_DELETE_AUTH_REQUIRED" });
  assert.ok(!authRequired.ok && authRequired.message.includes("ログイン"));
  const unknown = deletionOutcome(500, { error: "SOMETHING_ELSE" });
  assert.ok(!unknown.ok && unknown.message.includes("削除できませんでした"));
});

test("the request carries the access token and no user id at all", async () => {
  const seen: string[] = [];
  const client: DeletionClient = {
    invokeAccountDelete: async (accessToken) => {
      seen.push(accessToken);
      return { status: 200, body: { success: true } };
    },
  };
  assert.deepEqual(await deleteMyAccount(client, "token-1"), { ok: true });
  assert.deepEqual(seen, ["token-1"]);
  // deleteMyAccount has no parameter for a user id, so the client cannot name an account.
  assert.equal(deleteMyAccount.length, 2);
});

test("a missing session fails before any request is made", async () => {
  let called = false;
  const client: DeletionClient = {
    invokeAccountDelete: async () => {
      called = true;
      return { status: 200, body: { success: true } };
    },
  };
  const outcome = await deleteMyAccount(client, null);
  assert.equal(outcome.ok, false);
  assert.equal(called, false);
});

test("a thrown network error never becomes a success", async () => {
  const client: DeletionClient = {
    invokeAccountDelete: async () => {
      throw new Error("network down");
    },
  };
  const outcome = await deleteMyAccount(client, "token-1");
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && !outcome.message.includes("network down"));
});

test("deletion is confirmed by retyping the registered address, case and space tolerant", () => {
  assert.equal(deleteConfirmationIssue(" Mail@Example.com ", "mail@example.com"), null);
  assert.ok(deleteConfirmationIssue("", "mail@example.com"));
  assert.ok(deleteConfirmationIssue("other@example.com", "mail@example.com"));
});
