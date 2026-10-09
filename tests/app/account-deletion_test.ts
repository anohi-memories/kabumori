import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_LIFECYCLE_FUNCTION,
  APPLE_UNSUPPORTED_MESSAGE,
  DELETE_CONFIRMATION,
  DELETE_TYPED_PHRASE,
  deleteCommonAccount,
  deleteOutcome,
  deletionAvailability,
  parsePreview,
  previewCommonAccountDeletion,
  REAUTH_MESSAGES,
  WITHDRAW_CONFIRMATION,
  withdrawKabumori,
  withdrawOutcome,
  type DeletionPreview,
  type LifecycleAction,
  type LifecycleClient,
  type Reauthentication,
} from "../../src/lib/account-deletion.ts";
import * as server from "../../supabase/functions/account-delete/lifecycle_logic.ts";

const PERSON = { email: "person@example.invalid", userId: "11111111-1111-4111-8111-111111111111" };
const PREVIEW_BODY = {
  ok: true, account_status: "active", lifecycle_version: 7,
  services: [{ service: "kabumori", status: "active" }, { service: "x_autopost", status: "active" }],
  blockers: [], deletion_in_progress: false,
  apple: { required: false, supported: true, code_required: false }, x_cleanup: "supported",
};
const preview = (overrides: Partial<DeletionPreview> = {}): DeletionPreview => ({
  accountStatus: "active", lifecycleVersion: 7, services: ["kabumori", "x_autopost"], blockers: [],
  deletionInProgress: false, apple: { required: false, supported: true, codeRequired: false }, xCleanup: "supported",
  ...overrides,
});

type Call = { action: LifecycleAction; payload: Record<string, unknown>; token: string };
function fakeClient(options: { reauth?: Reauthentication | "throw"; answer?: { status: number; body: unknown } | "throw" } = {}) {
  const calls: Call[] = [];
  const signIns: string[] = [];
  let released = 0;
  const client: LifecycleClient = {
    invoke: async (action, payload, token) => {
      calls.push({ action, payload, token });
      if (options.answer === "throw") throw new Error("network down person@example.invalid");
      return options.answer ?? { status: 200, body: { ok: true, outcome: action === "withdraw_kabumori" ? "ended" : "deleted" } };
    },
    reauthenticate: async (email) => {
      signIns.push(email);
      if (options.reauth === "throw") throw new Error("network down");
      const reauth = options.reauth ?? { ok: true, accessToken: "fresh-token", userId: PERSON.userId, release: async () => {} };
      return reauth.ok ? { ...reauth, release: async () => { released += 1; } } : reauth;
    },
  };
  return { client, calls, signIns, released: () => released };
}

test("the client constants are the server's", () => {
  assert.equal(WITHDRAW_CONFIRMATION, server.WITHDRAW_CONFIRMATION);
  assert.equal(DELETE_CONFIRMATION, server.DELETE_CONFIRMATION);
  assert.equal(ACCOUNT_LIFECYCLE_FUNCTION, "account-delete");
});

test("withdrawal re-authenticates the signed-in person and sends only the confirmation with the fresh token", async () => {
  const fake = fakeClient();
  assert.deepEqual(await withdrawKabumori(fake.client, PERSON, "pw"), { ok: true });
  assert.deepEqual(fake.signIns, [PERSON.email], "the signed-in address, never a typed one");
  assert.deepEqual(fake.calls, [{ action: "withdraw_kabumori", payload: { confirmation: WITHDRAW_CONFIRMATION }, token: "fresh-token" }]);
  assert.equal(fake.released(), 1, "the extra session is ended");
  for (const call of fake.calls) assert.ok(!JSON.stringify(call.payload).includes(PERSON.userId), "no user id is ever sent");
});

test("withdrawal fails closed before any request without a password, an address, or the same person", async () => {
  for (const [signed, password, reauth, message] of [
    [PERSON, "", undefined, REAUTH_MESSAGES.password_required],
    [{ ...PERSON, email: null }, "pw", undefined, REAUTH_MESSAGES.email_missing],
    [PERSON, "pw", { ok: false, reason: "invalid_credentials" }, REAUTH_MESSAGES.invalid_credentials],
    [PERSON, "pw", { ok: false, reason: "rate_limited" }, REAUTH_MESSAGES.rate_limited],
    [PERSON, "pw", "throw", REAUTH_MESSAGES.failed],
    [PERSON, "pw", { ok: true, accessToken: "t", userId: "22222222-2222-4222-8222-222222222222", release: async () => {} }, REAUTH_MESSAGES.other_person],
  ] as const) {
    const fake = fakeClient({ reauth: reauth as Reauthentication | "throw" | undefined });
    assert.deepEqual(await withdrawKabumori(fake.client, signed, password), { ok: false, message });
    assert.deepEqual(fake.calls, []);
  }
});

test("withdrawal: only an explicit server success counts; every refusal has its own message", () => {
  for (const outcome of ["ended", "already_ended", "not_registered"]) {
    assert.deepEqual(withdrawOutcome({ status: 200, body: { ok: true, outcome } }), { ok: true });
  }
  for (const [status, body] of [[200, { ok: true }], [200, { ok: true, outcome: "deleted" }], [500, null], [0, null], [200, "ok"]] as const) {
    assert.equal(withdrawOutcome({ status, body }).ok, false);
  }
  const during = withdrawOutcome({ status: 409, body: { ok: false, error: "WITHDRAW_BLOCKED", reasons: ["ACCOUNT_DELETION_IN_PROGRESS"] } });
  assert.ok(!during.ok && during.message.includes("共通アカウントの削除手続き中"));
  const reauth = withdrawOutcome({ status: 403, body: { ok: false, error: "REAUTH_REQUIRED" } });
  assert.ok(!reauth.ok && reauth.message.includes("パスワード"));
});

test("a network error never becomes a success and never shows its own text", async () => {
  const fake = fakeClient({ answer: "throw" });
  const outcome = await withdrawKabumori(fake.client, PERSON, "pw");
  assert.ok(!outcome.ok && !outcome.message.includes("network") && !outcome.message.includes("@"));
  const deletion = await deleteCommonAccount(fakeClient({ answer: "throw" }).client, PERSON, { password: "pw", typed: DELETE_TYPED_PHRASE, preview: preview() });
  assert.ok(!deletion.ok && !deletion.message.includes("network"));
});

test("the preview is parsed strictly; anything malformed is an error", () => {
  const parsed = parsePreview({ status: 200, body: PREVIEW_BODY });
  assert.deepEqual(parsed, { ok: true, preview: preview() });
  const ended = parsePreview({ status: 200, body: { ...PREVIEW_BODY, services: [{ service: "kabumori", status: "ended" }] } });
  assert.ok(ended.ok && ended.preview.services.length === 0, "ended services are not listed as remaining");
  for (const broken of [
    { ...PREVIEW_BODY, lifecycle_version: "7" }, { ...PREVIEW_BODY, lifecycle_version: -1 }, { ...PREVIEW_BODY, services: [{ service: "other", status: "active" }] },
    { ...PREVIEW_BODY, apple: {} }, { ...PREVIEW_BODY, x_cleanup: "maybe" }, { ...PREVIEW_BODY, blockers: [1] }, { ...PREVIEW_BODY, ok: false },
  ]) {
    assert.equal(parsePreview({ status: 200, body: broken }).ok, false, JSON.stringify(broken));
  }
  assert.equal(parsePreview({ status: 401, body: { ok: false, error: "AUTH_REQUIRED" } }).ok, false);
});

test("the preview is read with the app's own session and needs one", async () => {
  const fake = fakeClient({ answer: { status: 200, body: PREVIEW_BODY } });
  const result = await previewCommonAccountDeletion(fake.client, "app-token");
  assert.ok(result.ok);
  assert.deepEqual(fake.calls, [{ action: "preview", payload: {}, token: "app-token" }]);
  const none = fakeClient();
  assert.equal((await previewCommonAccountDeletion(none.client, null)).ok, false);
  assert.deepEqual(none.calls, []);
});

test("deletion availability fails closed: blockers, Apple (no code in this app), X that cannot keep the login", () => {
  assert.deepEqual(deletionAvailability(preview()), { available: true });
  assert.deepEqual(deletionAvailability(preview({ accountStatus: "deleting", deletionInProgress: true })), { available: true }, "resume");
  assert.equal(deletionAvailability(preview({ blockers: ["ADMIN_ACCOUNT"] })).available, false);
  assert.equal(deletionAvailability(preview({ blockers: ["SOMETHING_NEW"] })).available, false);
  assert.deepEqual(deletionAvailability(preview({ apple: { required: true, supported: true, codeRequired: true } })), { available: false, message: APPLE_UNSUPPORTED_MESSAGE });
  assert.deepEqual(deletionAvailability(preview({ apple: { required: true, supported: true, codeRequired: false } })), { available: true }, "already revoked");
  assert.equal(deletionAvailability(preview({ xCleanup: "unsupported" })).available, false);
  assert.equal(deletionAvailability(preview({ accountStatus: "locked" })).available, false);
});

test("deletion: typed phrase, availability and re-authentication come first; the version shown is sent; no id", async () => {
  const fake = fakeClient();
  assert.deepEqual(await deleteCommonAccount(fake.client, PERSON, { password: "pw", typed: ` ${DELETE_TYPED_PHRASE} `, preview: preview() }), { ok: true });
  assert.deepEqual(fake.calls, [{ action: "delete_common_account", payload: { confirmation: DELETE_CONFIRMATION, expected_lifecycle_version: 7 }, token: "fresh-token" }]);
  assert.equal(fake.released(), 1);
  for (const [input, message] of [
    [{ password: "pw", typed: "", preview: preview() }, "「削除」"],
    [{ password: "pw", typed: "さくじょ", preview: preview() }, "「削除」"],
    [{ password: "pw", typed: DELETE_TYPED_PHRASE, preview: preview({ xCleanup: "unsupported" }) }, "X自動投稿"],
    [{ password: "", typed: DELETE_TYPED_PHRASE, preview: preview() }, REAUTH_MESSAGES.password_required],
  ] as const) {
    const blocked = fakeClient();
    const outcome = await deleteCommonAccount(blocked.client, PERSON, input);
    assert.ok(!outcome.ok && outcome.message.includes(message), message);
    assert.deepEqual(blocked.calls, []);
    assert.deepEqual(blocked.signIns, [], "no sign-in before the local checks pass");
  }
});

test("deletion outcomes: only a verified deletion is success; sessions revoked, pending and changed state are surfaced", () => {
  assert.deepEqual(deleteOutcome({ status: 200, body: { ok: true, outcome: "deleted" } }), { ok: true });
  for (const body of [{ ok: true }, { ok: true, outcome: "ended" }, null, "deleted"]) {
    assert.equal(deleteOutcome({ status: 200, body }).ok, false);
  }
  const pending = deleteOutcome({ status: 500, body: { ok: false, error: "DELETION_VERIFICATION_PENDING", sessions_revoked: true } });
  assert.ok(!pending.ok && pending.pending && pending.signedOut && !pending.message.includes("削除しました"));
  const unconfirmed = deleteOutcome({ status: 500, body: { ok: false, error: "AUTH_DELETE_UNCONFIRMED", sessions_revoked: true } });
  assert.ok(!unconfirmed.ok && unconfirmed.pending);
  const storage = deleteOutcome({ status: 503, body: { ok: false, error: "STORAGE_NOT_EMPTY", sessions_revoked: true } });
  assert.ok(!storage.ok && storage.signedOut && !storage.pending && storage.message.includes("もう一度ログイン"));
  const changed = deleteOutcome({ status: 409, body: { ok: false, error: "LIFECYCLE_CHANGED" } });
  assert.ok(!changed.ok && changed.refreshPreview && !changed.signedOut);
  const admin = deleteOutcome({ status: 409, body: { ok: false, error: "DELETION_BLOCKED", reasons: ["ADMIN_ACCOUNT"] } });
  assert.ok(!admin.ok && admin.message.includes("運営用"));
  const unknown = deleteOutcome({ status: 500, body: { ok: false, error: "toString" } });
  assert.ok(!unknown.ok && unknown.message.includes("削除できませんでした"), "prototype keys are not messages");
  // Every server error code gets a Japanese message (its own or the generic one), never the code itself.
  const source = Deno.readTextFileSync(new URL("../../supabase/functions/account-delete/lifecycle_logic.ts", import.meta.url));
  const block = source.slice(source.indexOf("export type LifecycleErrorCode"), source.indexOf("type FailureBody"));
  const codes = [...block.matchAll(/'([A-Z][A-Z_]+)'/gu)].map((m) => m[1]);
  assert.ok(codes.length > 20);
  for (const code of codes) {
    const outcome = deleteOutcome({ status: 500, body: { ok: false, error: code } });
    assert.ok(!outcome.ok && !outcome.message.includes(code) && /[ぁ-んァ-ン一-龥]/u.test(outcome.message), code);
  }
});
