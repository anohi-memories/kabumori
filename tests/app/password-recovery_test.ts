import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNewPassword,
  newPasswordIssue,
  parseRecoveryLink,
  resetEmailIssue,
  startRecoverySession,
  type RecoveryClient,
} from "../../src/lib/password-recovery.ts";

function client(overrides: Partial<RecoveryClient["auth"]> = {}) {
  const calls: string[] = [];
  const ok = async () => ({ error: null });
  const auth = {
    setSession: async (tokens: { access_token: string; refresh_token: string }) => {
      calls.push(`setSession:${tokens.access_token}/${tokens.refresh_token}`);
      return { error: null };
    },
    exchangeCodeForSession: async (code: string) => {
      calls.push(`exchange:${code}`);
      return { error: null };
    },
    verifyOtp: async (params: { token_hash: string; type: "recovery" }) => {
      calls.push(`verifyOtp:${params.token_hash}:${params.type}`);
      return { error: null };
    },
    updateUser: ok,
    ...overrides,
  } as RecoveryClient["auth"];
  return { client: { auth } as RecoveryClient, calls };
}

test("an implicit-flow link carries both tokens", () => {
  const link = parseRecoveryLink(
    "kabumori://reset-password#access_token=at-1&refresh_token=rt-1&type=recovery&expires_in=3600",
  );
  assert.deepEqual(link, { kind: "tokens", accessToken: "at-1", refreshToken: "rt-1" });
});

test("a PKCE link carries a code", () => {
  assert.deepEqual(parseRecoveryLink("kabumori://reset-password?code=abc-123"), {
    kind: "code",
    code: "abc-123",
  });
});

test("a token-hash link is recognised by type even off the recovery path", () => {
  assert.deepEqual(parseRecoveryLink("kabumori://callback?token_hash=th-9&type=recovery"), {
    kind: "token-hash",
    tokenHash: "th-9",
  });
});

test("an expired link becomes a plain Japanese explanation, not a token dump", () => {
  const link = parseRecoveryLink(
    "kabumori://reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
  );
  assert.equal(link.kind, "error");
  assert.ok(link.kind === "error" && link.message.includes("有効期限"));
  // The raw provider description is never shown.
  assert.ok(link.kind === "error" && !link.message.includes("Email link"));
});

test("an unknown error code falls back to the generic message", () => {
  const link = parseRecoveryLink("kabumori://reset-password?error_code=something_new");
  assert.equal(link.kind, "error");
  assert.ok(link.kind === "error" && link.message.includes("もう一度メールを送信"));
});

test("links that are not recovery links are ignored", () => {
  for (const url of [
    "kabumori://news/abc",
    "kabumori://",
    "kabumori-social://oauth-callback?code=xyz&state=s",
    "not a url",
    "",
  ]) {
    assert.deepEqual(parseRecoveryLink(url), { kind: "none" }, url);
  }
});

test("a recovery-path link with no usable parameter is an error, never a silent no-op", () => {
  const link = parseRecoveryLink("kabumori://reset-password");
  assert.equal(link.kind, "error");
});

test("each link shape starts the session through its own auth call", async () => {
  const tokens = client();
  assert.equal(
    await startRecoverySession(tokens.client, {
      kind: "tokens",
      accessToken: "at",
      refreshToken: "rt",
    }),
    null,
  );
  assert.deepEqual(tokens.calls, ["setSession:at/rt"]);

  const code = client();
  assert.equal(await startRecoverySession(code.client, { kind: "code", code: "c1" }), null);
  assert.deepEqual(code.calls, ["exchange:c1"]);

  const hash = client();
  assert.equal(
    await startRecoverySession(hash.client, { kind: "token-hash", tokenHash: "th" }),
    null,
  );
  assert.deepEqual(hash.calls, ["verifyOtp:th:recovery"]);
});

test("a rejected link reports a safe message and keeps the provider error out of the UI", async () => {
  const { client: failing } = client({
    setSession: async () => ({ error: { message: "AuthApiError: token rt-secret is invalid" } }),
  });
  const message = await startRecoverySession(failing, {
    kind: "tokens",
    accessToken: "at",
    refreshToken: "rt-secret",
  });
  assert.ok(message);
  assert.ok(!message!.includes("rt-secret"));
});

test("an already-classified error link is surfaced without touching the network", async () => {
  const { client: unused, calls } = client();
  const message = await startRecoverySession(unused, { kind: "error", message: "期限切れです。" });
  assert.equal(message, "期限切れです。");
  assert.deepEqual(calls, []);
});

test("password validation rejects short and mismatched pairs before any request", async () => {
  assert.ok(newPasswordIssue("12345", "12345"));
  assert.ok(newPasswordIssue("123456", "1234567"));
  assert.equal(newPasswordIssue("123456", "123456"), null);

  let called = false;
  const { client: watched } = client({
    updateUser: async () => {
      called = true;
      return { error: null };
    },
  });
  assert.ok(await applyNewPassword(watched, "123", "123"));
  assert.equal(called, false);
});

test("a weak-password rejection from the server is translated", async () => {
  const { client: weak } = client({
    updateUser: async () => ({ error: { message: "Password should be at least 8 characters" } }),
  });
  assert.equal(
    await applyNewPassword(weak, "123456", "123456"),
    "パスワードが短すぎるか、安全性の条件を満たしていません。",
  );
});

test("a successful update reports no issue", async () => {
  const { client: fine } = client();
  assert.equal(await applyNewPassword(fine, "abcdef", "abcdef"), null);
});

test("the reset request validates the address the same way the login screen does", () => {
  assert.ok(resetEmailIssue("nope"));
  assert.equal(resetEmailIssue(" Mail@Example.com "), null);
});
