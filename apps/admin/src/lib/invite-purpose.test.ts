import assert from "node:assert/strict";
import test from "node:test";
import {
  CLEARED_INVITE_PURPOSE_COOKIE_OPTIONS,
  confirmEmailLink,
  hasPasswordSetupAuthority,
  INVITE_BINDING_SECRET_ENV,
  INVITE_PURPOSE_COOKIE,
  INVITE_PURPOSE_COOKIE_OPTIONS,
  inviteBindingFor,
  issueInvitePurposeToken,
  readInviteBindingSecret,
  verifyInvitePurposeToken,
  type ConfirmAuthClient,
  type SessionClaims,
} from "./invite-purpose.ts";
import {
  completePasswordReset,
  CONFIRM_FAILURE_DESTINATION,
  CONFIRM_SUCCESS_DESTINATION,
  RECOVERY_CONTEXT_MAX_AGE_SECONDS,
  type RecoveryAuthClient,
} from "./password-recovery.ts";

const NOW = 1_790_000_000;
// Test-only keys; never a real secret.
const SECRET = "test-only-invite-binding-key-0123456789abcdef";
const OTHER_SECRET = "test-only-other-binding-key-0123456789abcdef";
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const OTHER_SESSION = "44444444-4444-4444-8444-444444444444";

function otpClaims(overrides: Partial<SessionClaims> = {}, authenticatedAt = NOW - 5): SessionClaims {
  return { amr: [{ method: "otp", timestamp: authenticatedAt }], sub: USER, session_id: SESSION, ...overrides };
}

function validToken(issuedAt = NOW - 5, binding = { userId: USER, sessionId: SESSION }) {
  const token = issueInvitePurposeToken(SECRET, binding, issuedAt);
  assert.ok(token);
  return token;
}

function authority(claims: SessionClaims, invitePurposeToken: string | null, nowSeconds = NOW, secret: string | null = SECRET) {
  return hasPasswordSetupAuthority({ claims, invitePurposeToken, secret, nowSeconds });
}

// --- the authority check (render time and submit time) ----------------------

test("1. a fresh recovery authentication is allowed without any invite binding", () => {
  const claims = { amr: [{ method: "recovery", timestamp: NOW - 60 }], sub: USER, session_id: SESSION };
  assert.equal(authority(claims, null), true);
  assert.equal(authority(claims, null, NOW, null), true, "recovery does not depend on the binding secret");
});

test("2. a generic OTP session without the binding cookie is denied", () => {
  assert.equal(authority(otpClaims(), null), false);
  for (const method of ["otp", "magiclink"]) {
    assert.equal(authority(otpClaims({ amr: [{ method, timestamp: NOW - 5 }] }), null), false, method);
  }
});

test("3. a generic OTP session with a forged binding cookie is denied", () => {
  const genuine = validToken();
  const [version, userId, sessionId, expiresAt] = genuine.split(".");
  const forgeries = [
    "",
    "true",
    "invite",
    genuine.slice(0, -1),
    `${genuine}x`,
    `${version}.${userId}.${sessionId}.${expiresAt}.`,
    `${version}.${userId}.${sessionId}.${Number(expiresAt) + 600}.${genuine.split(".")[4]}`,
    `v2.${userId}.${sessionId}.${expiresAt}.${genuine.split(".")[4]}`,
    issueInvitePurposeToken(OTHER_SECRET, { userId: USER, sessionId: SESSION }, NOW - 5)!,
    "a".repeat(600),
  ];
  for (const forged of forgeries) {
    assert.equal(authority(otpClaims(), forged), false, forged);
  }
});

test("4. an expired binding cookie is denied", () => {
  const issuedAt = NOW - 5;
  const token = validToken(issuedAt);
  // Keep the otp authentication itself fresh so only the cookie is stale.
  const claimsAt = (now: number) => otpClaims({}, now - 5);
  const expiresAt = issuedAt + RECOVERY_CONTEXT_MAX_AGE_SECONDS;
  assert.equal(authority(claimsAt(expiresAt), token, expiresAt), true, "valid up to its expiry");
  assert.equal(authority(claimsAt(expiresAt + 1), token, expiresAt + 1), false);
  // A token signed with an expiry beyond one window is not accepted either.
  const farFuture = issueInvitePurposeToken(SECRET, { userId: USER, sessionId: SESSION }, NOW + 3_600)!;
  assert.equal(authority(otpClaims(), farFuture), false);
});

test("5. a valid binding cookie for a different user or session is denied", () => {
  assert.equal(authority(otpClaims(), validToken(NOW - 5, { userId: OTHER_USER, sessionId: SESSION })), false);
  assert.equal(authority(otpClaims(), validToken(NOW - 5, { userId: USER, sessionId: OTHER_SESSION })), false);
  assert.equal(authority(otpClaims({ sub: OTHER_USER }), validToken()), false);
  assert.equal(authority(otpClaims({ session_id: OTHER_SESSION }), validToken()), false);
});

test("6. a fresh OTP session with a fresh binding for the same user and session is allowed", () => {
  assert.equal(authority(otpClaims(), validToken()), true);
});

test("7. a stale OTP authentication is denied even with a valid binding cookie", () => {
  const authenticatedAt = NOW - RECOVERY_CONTEXT_MAX_AGE_SECONDS - 1;
  const token = validToken(NOW - 5);
  assert.equal(authority(otpClaims({}, authenticatedAt), token), false);
});

test("the binding is never honoured without the server secret or with a different one", () => {
  const token = validToken();
  assert.equal(authority(otpClaims(), token, NOW, null), false);
  assert.equal(authority(otpClaims(), token, NOW, OTHER_SECRET), false);
});

test("claims without a usable user or session id cannot be bound", () => {
  for (const overrides of [{ sub: undefined }, { session_id: undefined }, { sub: "a.b" }, { session_id: 42 }]) {
    assert.equal(inviteBindingFor(otpClaims(overrides), NOW), null, JSON.stringify(overrides));
    assert.equal(authority(otpClaims(overrides), validToken()), false);
  }
  assert.equal(issueInvitePurposeToken(SECRET, { userId: "a.b", sessionId: SESSION }, NOW), null);
});

test("the binding secret is read only from the server-only variable and must be long enough", () => {
  assert.equal(INVITE_BINDING_SECRET_ENV, "ADMIN_INVITE_BINDING_SECRET");
  assert.equal(readInviteBindingSecret({}), null);
  assert.equal(readInviteBindingSecret({ ADMIN_INVITE_BINDING_SECRET: "" }), null);
  assert.equal(readInviteBindingSecret({ ADMIN_INVITE_BINDING_SECRET: "x".repeat(31) }), null);
  assert.equal(readInviteBindingSecret({ ADMIN_INVITE_BINDING_SECRET: SECRET }), SECRET);
  // A public (client-bundled) variable is never used for it.
  assert.equal(readInviteBindingSecret({ NEXT_PUBLIC_ADMIN_INVITE_BINDING_SECRET: SECRET }), null);
});

test("the token carries only ids, an expiry and a signature", () => {
  const token = validToken();
  const [version, userId, sessionId, expiresAt, signature] = token.split(".");
  assert.equal(version, "v1");
  assert.equal(userId, USER);
  assert.equal(sessionId, SESSION);
  assert.equal(Number(expiresAt), NOW - 5 + RECOVERY_CONTEXT_MAX_AGE_SECONDS);
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(verifyInvitePurposeToken(token, SECRET, { userId: USER, sessionId: SESSION }, NOW), true);
});

test("the cookie is __Host-, httpOnly, Secure, SameSite=Lax and lives no longer than the window", () => {
  assert.match(INVITE_PURPOSE_COOKIE, /^__Host-/u);
  assert.deepEqual(INVITE_PURPOSE_COOKIE_OPTIONS, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: RECOVERY_CONTEXT_MAX_AGE_SECONDS,
  });
  assert.deepEqual(CLEARED_INVITE_PURPOSE_COOKIE_OPTIONS, { ...INVITE_PURPOSE_COOKIE_OPTIONS, maxAge: 0 });
});

// --- /auth/confirm: who gets a binding ----------------------------------------

type ConfirmCall = { method: keyof ConfirmAuthClient; args: unknown[] };

function fakeConfirmAuth(
  script: {
    verifyOtp?: () => Promise<{ data: { session: { access_token: string } | null }; error: unknown }>;
    exchangeCodeForSession?: () => Promise<{ error: unknown }>;
    getClaims?: () => Promise<{ data: { claims: SessionClaims } | null; error: unknown }>;
  } = {},
) {
  const calls: ConfirmCall[] = [];
  const client: ConfirmAuthClient = {
    verifyOtp: async (...args) => {
      calls.push({ method: "verifyOtp", args });
      return (script.verifyOtp ?? (async () => ({ data: { session: { access_token: "new-session" } }, error: null })))();
    },
    exchangeCodeForSession: async (...args) => {
      calls.push({ method: "exchangeCodeForSession", args });
      return (script.exchangeCodeForSession ?? (async () => ({ error: null })))();
    },
    getClaims: async (...args) => {
      calls.push({ method: "getClaims", args });
      return (script.getClaims ?? (async () => ({ data: { claims: otpClaims() }, error: null })))();
    },
  };
  return { client, calls };
}

const clock = () => NOW;
const invite = { kind: "verify_otp", type: "invite", tokenHash: "hash" } as const;

test("8. a binding is issued only after verifyOtp(type=invite) succeeds, for the new session", async () => {
  const { client, calls } = fakeConfirmAuth();
  const outcome = await confirmEmailLink(client, invite, SECRET, clock);
  assert.equal(outcome.destination, CONFIRM_SUCCESS_DESTINATION);
  assert.ok(outcome.invitePurposeToken);
  assert.deepEqual(calls.map((call) => call.method), ["verifyOtp", "getClaims"]);
  assert.deepEqual(calls[0].args, [{ type: "invite", token_hash: "hash" }]);
  // Claims are verified for the session verifyOtp just returned.
  assert.deepEqual(calls[1].args, ["new-session"]);
  assert.equal(authority(otpClaims(), outcome.invitePurposeToken), true);
});

test("9. recovery links and PKCE codes never produce a binding", async () => {
  const recovery = fakeConfirmAuth();
  const recoveryOutcome = await confirmEmailLink(
    recovery.client,
    { kind: "verify_otp", type: "recovery", tokenHash: "hash" },
    SECRET,
    clock,
  );
  assert.deepEqual(recoveryOutcome, { destination: CONFIRM_SUCCESS_DESTINATION, invitePurposeToken: null });
  assert.deepEqual(recovery.calls.map((call) => call.method), ["verifyOtp"]);

  const pkce = fakeConfirmAuth();
  const pkceOutcome = await confirmEmailLink(pkce.client, { kind: "exchange_code", code: "code" }, SECRET, clock);
  assert.deepEqual(pkceOutcome, { destination: CONFIRM_SUCCESS_DESTINATION, invitePurposeToken: null });
  assert.deepEqual(pkce.calls.map((call) => call.method), ["exchangeCodeForSession"]);
});

test("10. a failed or unverifiable invite never produces a binding", async () => {
  const failures = [
    { verifyOtp: async () => ({ data: { session: null }, error: new Error("otp_expired") }) },
    {
      verifyOtp: async () => {
        throw new Error("network");
      },
    },
  ];
  for (const script of failures) {
    const { client, calls } = fakeConfirmAuth(script);
    assert.deepEqual(await confirmEmailLink(client, invite, SECRET, clock), {
      destination: CONFIRM_FAILURE_DESTINATION,
      invitePurposeToken: null,
    });
    assert.deepEqual(calls.map((call) => call.method), ["verifyOtp"]);
  }

  // The invite verified, but the new session cannot be bound: the user lands
  // on the reset page, which then fails closed.
  const unbindable = [
    { verifyOtp: async () => ({ data: { session: null }, error: null }) },
    { getClaims: async () => ({ data: null, error: new Error("invalid jwt") }) },
    {
      getClaims: async () => {
        throw new Error("jwks");
      },
    },
    { getClaims: async () => ({ data: { claims: otpClaims({}, NOW - RECOVERY_CONTEXT_MAX_AGE_SECONDS - 1) }, error: null }) },
    { getClaims: async () => ({ data: { claims: otpClaims({ amr: [{ method: "password", timestamp: NOW }] }) }, error: null }) },
    { getClaims: async () => ({ data: { claims: otpClaims({ session_id: undefined }) }, error: null }) },
  ];
  for (const script of unbindable) {
    const { client } = fakeConfirmAuth(script);
    assert.deepEqual(await confirmEmailLink(client, invite, SECRET, clock), {
      destination: CONFIRM_SUCCESS_DESTINATION,
      invitePurposeToken: null,
    });
  }

  // No secret configured: nothing is issued (fail closed), and claims are not even read.
  const noSecret = fakeConfirmAuth();
  assert.deepEqual(await confirmEmailLink(noSecret.client, invite, null, clock), {
    destination: CONFIRM_SUCCESS_DESTINATION,
    invitePurposeToken: null,
  });
  assert.deepEqual(noSecret.calls.map((call) => call.method), ["verifyOtp"]);
});

// --- clearing after the password is set ---------------------------------------

function fakeRecoveryAuth(signOutError: unknown = null, updateError: unknown = null) {
  const order: string[] = [];
  const client: Pick<RecoveryAuthClient, "updateUser" | "signOut"> = {
    updateUser: async () => {
      order.push("updateUser");
      return { error: updateError };
    },
    signOut: async () => {
      order.push("signOut");
      return { error: signOutError };
    },
  };
  const clear = async () => {
    order.push("clearPurposeBinding");
  };
  return { client, order, clear };
}

test("11. a successful password update clears the invite binding before signing out", async () => {
  const { client, order, clear } = fakeRecoveryAuth();
  assert.deepEqual(await completePasswordReset(client, "longenough1", "longenough1", async () => true, clear), {
    status: "updated",
  });
  assert.deepEqual(order, ["updateUser", "clearPurposeBinding", "signOut"]);
});

test("the binding is left alone when no update happened", async () => {
  const noContext = fakeRecoveryAuth();
  assert.deepEqual(
    await completePasswordReset(noContext.client, "longenough1", "longenough1", async () => false, noContext.clear),
    { status: "no_context" },
  );
  assert.deepEqual(noContext.order, []);

  const rejected = fakeRecoveryAuth(null, new Error("weak password"));
  assert.deepEqual(
    await completePasswordReset(rejected.client, "longenough1", "longenough1", async () => true, rejected.clear),
    { status: "failed" },
  );
  assert.deepEqual(rejected.order, ["updateUser"]);
});

test("12. sign-out failure semantics are unchanged, and a failing clear does not hide them", async () => {
  const signOutFails = fakeRecoveryAuth(new Error("network"));
  assert.deepEqual(
    await completePasswordReset(signOutFails.client, "longenough1", "longenough1", async () => true, signOutFails.clear),
    { status: "updated_signout_unconfirmed" },
  );
  assert.deepEqual(signOutFails.order, ["updateUser", "clearPurposeBinding", "signOut"]);

  const clearFails = fakeRecoveryAuth();
  const throwingClear = async () => {
    clearFails.order.push("clearPurposeBinding");
    throw new Error("server action unavailable");
  };
  assert.deepEqual(
    await completePasswordReset(clearFails.client, "longenough1", "longenough1", async () => true, throwingClear),
    { status: "updated" },
  );
  assert.deepEqual(clearFails.order, ["updateUser", "clearPurposeBinding", "signOut"]);
});
