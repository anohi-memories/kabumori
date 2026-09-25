import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecoveryRedirectUrl,
  completePasswordReset,
  CONFIRM_FAILURE_DESTINATION,
  CONFIRM_SUCCESS_DESTINATION,
  establishSessionFromFragment,
  hasRecoveryContext,
  isTrustedAdminOrigin,
  normalizeEmail,
  parseRecoveryFragment,
  PASSWORD_MIN_LENGTH,
  RECOVERY_CONFIRM_PATH,
  RECOVERY_CONTEXT_MAX_AGE_SECONDS,
  requestPasswordReset,
  resolveConfirmAction,
  validateNewPassword,
  type RecoveryAuthClient,
} from "./password-recovery.ts";

const PREVIEW_ORIGIN = "https://deploy-preview-40--shiny-kheer-77a154.netlify.app";
const NOW = 1_790_000_000;

// A fake auth client that records every call and returns scripted results.
function fakeAuth(script: Partial<Record<keyof RecoveryAuthClient, () => Promise<{ error: unknown }>>> = {}) {
  const calls: Array<{ method: keyof RecoveryAuthClient; args: unknown[] }> = [];
  const ok = async () => ({ error: null });
  const client: RecoveryAuthClient = {
    resetPasswordForEmail: async (...args) => {
      calls.push({ method: "resetPasswordForEmail", args });
      return (script.resetPasswordForEmail ?? ok)();
    },
    updateUser: async (...args) => {
      calls.push({ method: "updateUser", args });
      return (script.updateUser ?? ok)();
    },
    signOut: async (...args) => {
      calls.push({ method: "signOut", args });
      return (script.signOut ?? ok)();
    },
    setSession: async (...args) => {
      calls.push({ method: "setSession", args });
      return (script.setSession ?? ok)();
    },
  };
  return { client, calls };
}

// --- trusted redirect origin ------------------------------------------------

test("trusted origins: https anywhere, http only on loopback", () => {
  for (const origin of [
    PREVIEW_ORIGIN,
    "https://admin.kabumori.example",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ]) {
    assert.equal(isTrustedAdminOrigin(origin), true, origin);
  }
});

test("untrusted or malformed origins are rejected", () => {
  for (const origin of [
    "",
    "null",
    "http://example.com",
    "http://localhost.evil.com",
    "https://evil.com/path",
    "https://evil.com?x=1",
    "https://evil.com#frag",
    "https://user:pass@evil.com",
    "//evil.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "HTTPS://Admin.Example",
  ]) {
    assert.equal(isTrustedAdminOrigin(origin), false, origin);
  }
});

test("redirect URL is the fixed confirm path on the trusted origin, with nothing appended", () => {
  assert.equal(buildRecoveryRedirectUrl(PREVIEW_ORIGIN), `${PREVIEW_ORIGIN}${RECOVERY_CONFIRM_PATH}`);
  assert.equal(buildRecoveryRedirectUrl("http://localhost:3000"), "http://localhost:3000/auth/confirm");
  assert.equal(buildRecoveryRedirectUrl("http://example.com"), null);
  assert.equal(buildRecoveryRedirectUrl("https://evil.com/steal"), null);
});

test("email normalization trims and rejects obviously invalid input", () => {
  assert.equal(normalizeEmail("  admin@example.com  "), "admin@example.com");
  for (const bad of ["", "   ", "admin", "admin@", "@example.com", "a b@example.com", `${"a".repeat(250)}@x.io`]) {
    assert.equal(normalizeEmail(bad), null, bad);
  }
});

// --- forgot-password: no account enumeration --------------------------------

test("reset request calls Supabase with the trusted redirect and reports sent", async () => {
  const { client, calls } = fakeAuth();
  assert.equal(await requestPasswordReset(client, " admin@example.com ", PREVIEW_ORIGIN), "sent");
  assert.deepEqual(calls, [
    {
      method: "resetPasswordForEmail",
      args: ["admin@example.com", { redirectTo: `${PREVIEW_ORIGIN}/auth/confirm` }],
    },
  ]);
});

test("every Supabase response maps to the same generic 'sent' status", async () => {
  const responses = [
    { error: null },
    { error: { status: 400, code: "user_not_found", message: "User not found" } },
    { error: { status: 429, code: "over_email_send_rate_limit", message: "rate limited" } },
    { error: { status: 500, message: "unexpected" } },
  ];
  for (const response of responses) {
    const { client } = fakeAuth({ resetPasswordForEmail: async () => response });
    assert.equal(await requestPasswordReset(client, "admin@example.com", PREVIEW_ORIGIN), "sent");
  }
});

test("invalid email or untrusted origin never reaches Supabase", async () => {
  const invalid = fakeAuth();
  assert.equal(await requestPasswordReset(invalid.client, "not-an-email", PREVIEW_ORIGIN), "invalid_email");
  assert.equal(invalid.calls.length, 0);

  const untrusted = fakeAuth();
  assert.equal(
    await requestPasswordReset(untrusted.client, "admin@example.com", "http://evil.example"),
    "config_error",
  );
  assert.equal(untrusted.calls.length, 0);
});

test("a request that cannot be sent at all is reported without account detail", async () => {
  const { client } = fakeAuth({
    resetPasswordForEmail: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(await requestPasswordReset(client, "admin@example.com", PREVIEW_ORIGIN), "unavailable");
});

// --- /auth/confirm decisions --------------------------------------------------

test("recovery and invite token_hash links are verified server-side", () => {
  assert.deepEqual(resolveConfirmAction(new URLSearchParams("token_hash=pkce_abc123&type=recovery")), {
    kind: "verify_otp",
    type: "recovery",
    tokenHash: "pkce_abc123",
  });
  assert.deepEqual(resolveConfirmAction(new URLSearchParams("token_hash=abc123&type=invite")), {
    kind: "verify_otp",
    type: "invite",
    tokenHash: "abc123",
  });
});

test("other link types and malformed token hashes are rejected", () => {
  for (const query of [
    "token_hash=abc&type=signup",
    "token_hash=abc&type=magiclink",
    "token_hash=abc&type=email_change",
    "token_hash=abc",
    "token_hash=&type=recovery",
    "token_hash=abc%3Cscript%3E&type=recovery",
    `token_hash=${"a".repeat(513)}&type=recovery`,
  ]) {
    assert.deepEqual(resolveConfirmAction(new URLSearchParams(query)), { kind: "invalid" }, query);
  }
});

test("PKCE codes are exchanged; malformed codes are rejected", () => {
  assert.deepEqual(resolveConfirmAction(new URLSearchParams("code=34e770dd-9ff9-416c-87fa-43b31d7ef225")), {
    kind: "exchange_code",
    code: "34e770dd-9ff9-416c-87fa-43b31d7ef225",
  });
  assert.deepEqual(resolveConfirmAction(new URLSearchParams("code=")), { kind: "invalid" });
  assert.deepEqual(resolveConfirmAction(new URLSearchParams("code=a/b")), { kind: "invalid" });
});

test("error parameters from Supabase fail closed", () => {
  for (const query of [
    "error=access_denied&error_code=otp_expired",
    "error_description=Email+link+is+invalid",
    "code=34e770dd&error=server_error",
  ]) {
    assert.deepEqual(resolveConfirmAction(new URLSearchParams(query)), { kind: "invalid" }, query);
  }
});

test("redirect targets cannot be supplied by the request (no open redirect)", () => {
  const withNext = resolveConfirmAction(
    new URLSearchParams("code=34e770dd&next=https://evil.com&redirect_to=https://evil.com"),
  );
  assert.deepEqual(withNext, { kind: "exchange_code", code: "34e770dd" });
  // Nothing but a next/redirect parameter is treated like an empty callback.
  assert.deepEqual(resolveConfirmAction(new URLSearchParams("next=https://evil.com")), {
    kind: "forward_fragment",
  });
});

test("confirm destinations are fixed relative same-origin paths with their own query", () => {
  for (const destination of [CONFIRM_SUCCESS_DESTINATION, CONFIRM_FAILURE_DESTINATION]) {
    assert.ok(destination.startsWith("/") && !destination.startsWith("//"), destination);
    // Resolves against any origin without leaving it.
    assert.equal(new URL(destination, PREVIEW_ORIGIN).origin, PREVIEW_ORIGIN);
    // A query of its own keeps the platform from re-attaching the incoming one.
    assert.ok(new URL(destination, PREVIEW_ORIGIN).search.length > 1, destination);
  }
  assert.equal(new URL(CONFIRM_SUCCESS_DESTINATION, PREVIEW_ORIGIN).pathname, "/reset-password");
  assert.equal(new URL(CONFIRM_FAILURE_DESTINATION, PREVIEW_ORIGIN).pathname, "/forgot-password");
});

test("a bare callback forwards to the fragment handler", () => {
  assert.deepEqual(resolveConfirmAction(new URLSearchParams("")), { kind: "forward_fragment" });
});

// --- implicit-flow fragment ---------------------------------------------------

test("recovery and invite fragments yield a session; other types do not", () => {
  assert.deepEqual(parseRecoveryFragment("#access_token=at&refresh_token=rt&type=recovery&expires_in=3600"), {
    kind: "session",
    type: "recovery",
    accessToken: "at",
    refreshToken: "rt",
  });
  assert.deepEqual(parseRecoveryFragment("access_token=at&refresh_token=rt&type=invite"), {
    kind: "session",
    type: "invite",
    accessToken: "at",
    refreshToken: "rt",
  });
  for (const hash of [
    "#access_token=at&refresh_token=rt&type=signup",
    "#access_token=at&refresh_token=rt&type=magiclink",
    "#access_token=at&refresh_token=rt",
    "#access_token=at&type=recovery",
    "#refresh_token=rt&type=recovery",
  ]) {
    assert.deepEqual(parseRecoveryFragment(hash), { kind: "error" }, hash);
  }
});

test("error fragments and unrelated fragments are distinguished", () => {
  assert.deepEqual(parseRecoveryFragment("#error=access_denied&error_code=otp_expired"), { kind: "error" });
  assert.deepEqual(parseRecoveryFragment(""), { kind: "none" });
  assert.deepEqual(parseRecoveryFragment("#"), { kind: "none" });
  assert.deepEqual(parseRecoveryFragment("#section-2"), { kind: "none" });
});

test("fragment sessions are established only for recovery/invite fragments", async () => {
  const none = fakeAuth();
  assert.equal(await establishSessionFromFragment(none.client, parseRecoveryFragment("")), "none");
  assert.equal(none.calls.length, 0);

  const bad = fakeAuth();
  assert.equal(
    await establishSessionFromFragment(bad.client, parseRecoveryFragment("#access_token=a&refresh_token=b&type=signup")),
    "invalid",
  );
  assert.equal(bad.calls.length, 0);

  const good = fakeAuth();
  assert.equal(
    await establishSessionFromFragment(good.client, parseRecoveryFragment("#access_token=a&refresh_token=b&type=invite")),
    "established",
  );
  assert.deepEqual(good.calls, [{ method: "setSession", args: [{ access_token: "a", refresh_token: "b" }] }]);

  const rejected = fakeAuth({ setSession: async () => ({ error: { status: 401 } }) });
  assert.equal(
    await establishSessionFromFragment(rejected.client, parseRecoveryFragment("#access_token=a&refresh_token=b&type=recovery")),
    "invalid",
  );

  const thrown = fakeAuth({
    setSession: async () => {
      throw new Error("network");
    },
  });
  assert.equal(
    await establishSessionFromFragment(thrown.client, parseRecoveryFragment("#access_token=a&refresh_token=b&type=recovery")),
    "invalid",
  );
});

// --- recovery context (what /reset-password requires) ------------------------

test("a normal password-login session is never a recovery context", () => {
  assert.equal(hasRecoveryContext([{ method: "password", timestamp: NOW }], NOW), false);
  assert.equal(hasRecoveryContext([{ method: "oauth", timestamp: NOW }], NOW), false);
  assert.equal(hasRecoveryContext([{ method: "anonymous", timestamp: NOW }], NOW), false);
});

test("a fresh email-link authentication is a recovery context", () => {
  for (const method of ["recovery", "invite", "otp", "magiclink"]) {
    assert.equal(hasRecoveryContext([{ method, timestamp: NOW - 60 }], NOW), true, method);
  }
  assert.equal(
    hasRecoveryContext(
      [
        { method: "password", timestamp: NOW - 86_400 },
        { method: "recovery", timestamp: NOW - 10 },
      ],
      NOW,
    ),
    true,
  );
});

test("the recovery context expires and malformed claims fail closed", () => {
  assert.equal(
    hasRecoveryContext([{ method: "recovery", timestamp: NOW - RECOVERY_CONTEXT_MAX_AGE_SECONDS }], NOW),
    true,
  );
  assert.equal(
    hasRecoveryContext([{ method: "recovery", timestamp: NOW - RECOVERY_CONTEXT_MAX_AGE_SECONDS - 1 }], NOW),
    false,
  );
  assert.equal(hasRecoveryContext([{ method: "recovery", timestamp: NOW + 30 }], NOW), true);
  assert.equal(hasRecoveryContext([{ method: "recovery", timestamp: NOW + 3_600 }], NOW), false);
  for (const amr of [
    undefined,
    null,
    "recovery",
    ["recovery"],
    [{ method: "recovery" }],
    [{ method: "recovery", timestamp: "now" }],
    [{ method: "recovery", timestamp: Number.NaN }],
    [null],
    [],
  ]) {
    assert.equal(hasRecoveryContext(amr, NOW), false, JSON.stringify(amr));
  }
});

// --- password validation and the update itself --------------------------------

test("passwords are validated locally before anything is sent", () => {
  const ok = "a".repeat(PASSWORD_MIN_LENGTH);
  assert.deepEqual(validateNewPassword(ok, ok), { ok: true });
  assert.deepEqual(validateNewPassword("", ""), { ok: false, reason: "empty" });
  assert.deepEqual(validateNewPassword(ok, ""), { ok: false, reason: "empty" });
  const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
  assert.deepEqual(validateNewPassword(short, short), { ok: false, reason: "too_short" });
  assert.deepEqual(validateNewPassword(ok, `${ok}x`), { ok: false, reason: "mismatch" });
  const long = "a".repeat(73);
  assert.deepEqual(validateNewPassword(long, long), { ok: false, reason: "too_long" });
  // 25 Japanese characters are 75 UTF-8 bytes: over the bcrypt limit.
  const multibyte = "あ".repeat(25);
  assert.deepEqual(validateNewPassword(multibyte, multibyte), { ok: false, reason: "too_long" });
});

test("invalid input never calls updateUser", async () => {
  const { client, calls } = fakeAuth();
  assert.deepEqual(await completePasswordReset(client, "short", "short", true), {
    status: "invalid",
    reason: "too_short",
  });
  assert.deepEqual(await completePasswordReset(client, "longenough1", "longenough2", true), {
    status: "invalid",
    reason: "mismatch",
  });
  assert.equal(calls.length, 0);
});

test("updateUser is never called without a recovery context", async () => {
  const { client, calls } = fakeAuth();
  assert.deepEqual(await completePasswordReset(client, "longenough1", "longenough1", false), {
    status: "no_context",
  });
  assert.equal(calls.length, 0);
});

test("a successful update is followed by sign-out, in that order", async () => {
  const { client, calls } = fakeAuth();
  assert.deepEqual(await completePasswordReset(client, "longenough1", "longenough1", true), {
    status: "updated",
  });
  assert.deepEqual(calls, [
    { method: "updateUser", args: [{ password: "longenough1" }] },
    { method: "signOut", args: [] },
  ]);
});

test("a rejected update reports failure and keeps nothing half-done", async () => {
  const rejected = fakeAuth({ updateUser: async () => ({ error: { code: "weak_password" } }) });
  assert.deepEqual(await completePasswordReset(rejected.client, "longenough1", "longenough1", true), {
    status: "failed",
  });
  assert.deepEqual(rejected.calls.map((call) => call.method), ["updateUser"]);

  const thrown = fakeAuth({
    updateUser: async () => {
      throw new Error("network");
    },
  });
  assert.deepEqual(await completePasswordReset(thrown.client, "longenough1", "longenough1", true), {
    status: "failed",
  });
});

test("a sign-out failure after a successful update still completes", async () => {
  const { client } = fakeAuth({
    signOut: async () => {
      throw new Error("network");
    },
  });
  assert.deepEqual(await completePasswordReset(client, "longenough1", "longenough1", true), {
    status: "updated",
  });
});
