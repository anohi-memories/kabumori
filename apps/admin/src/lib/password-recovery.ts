// Pure logic for the Admin password recovery / invite flow.
//
// Everything that decides *whether* something is allowed lives here, free of
// React and of a real Supabase client, so the security-relevant decisions can
// be tested with plain fakes. The pages and the /auth/confirm route handler
// only wire these decisions to Supabase and the DOM.
//
// Flow overview:
//   /forgot-password  -> resetPasswordForEmail(email, { redirectTo: <origin>/auth/confirm })
//   email link        -> Supabase /auth/v1/verify -> <origin>/auth/confirm?code=... (PKCE)
//                        or ?token_hash=...&type=recovery|invite (recommended email template)
//                        or #access_token=...&type=invite (default invite template, implicit)
//   /auth/confirm     -> establishes the session server-side, then redirects to /reset-password
//                        (a URL fragment survives that redirect and is consumed client-side)
//   /reset-password   -> only usable while the session carries a fresh recovery/invite
//                        authentication, re-verified server-side immediately before
//                        updateUser({ password }); then a verified signOut()
//
// A token_hash invite verified by /auth/confirm yields amr "otp", not "invite"
// (observed on the real project). Generic otp is still not accepted; instead
// /auth/confirm issues a short-lived signed invite-purpose binding for that
// exact session (see invite-purpose.ts).
//
// Setting a password never grants Admin access: the (admin) layout still
// requires an admin_users row after the user logs in normally.

export const RECOVERY_CONFIRM_PATH = "/auth/confirm";
export const RESET_PASSWORD_PATH = "/reset-password";
export const FORGOT_PASSWORD_PATH = "/forgot-password";

// How long after following an email link the reset form stays usable. The
// link itself is validated by Supabase; this only bounds how long the
// resulting session may be used for this single purpose.
export const RECOVERY_CONTEXT_MAX_AGE_SECONDS = 15 * 60;
const CLOCK_SKEW_ALLOWANCE_SECONDS = 60;

// Client-side floor. The Supabase project's own password policy is enforced
// server-side by updateUser regardless; this is never weaker than Supabase's
// default minimum of 6.
export const PASSWORD_MIN_LENGTH = 8;
// bcrypt, which Supabase Auth uses, only considers the first 72 bytes.
export const PASSWORD_MAX_BYTES = 72;

const EMAIL_MAX_LENGTH = 254;
const RECOVERY_LINK_TYPES = ["recovery", "invite"] as const;
export type RecoveryLinkType = (typeof RECOVERY_LINK_TYPES)[number];

// The only authentication methods that authorize setting a password here.
// GoTrue records the method that created a session in the JWT `amr` claim, and
// Supabase documents "recovery" and "invite" as distinct values. Generic "otp"
// (which can come from phone verification) and "magiclink" prove a sign-in,
// not that a password-recovery or invite link was followed, so they are NOT
// accepted; neither is an ordinary "password" login, which keeps an open Admin
// session from becoming a "change the password without knowing it" page. If a
// real recovery/invite flow turns out to emit something else, this fails
// closed until that is verified end to end -- it must not be widened to all
// OTP / magic-link sessions.
const RECOVERY_AMR_METHODS: ReadonlySet<string> = new Set(["recovery", "invite"]);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The redirect origin comes only from the origin actually serving this app
 * (window.location.origin in the browser). It is never taken from a query
 * parameter, header, or cookie. HTTPS is required everywhere except loopback
 * development. Supabase additionally enforces its own Redirect URL allowlist.
 */
export function isTrustedAdminOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Reject anything that is not a bare origin: credentials, paths, queries,
  // fragments, or a trailing-dot/case variant that would not round-trip.
  if (url.origin !== origin) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function buildRecoveryRedirectUrl(origin: string): string | null {
  if (!isTrustedAdminOrigin(origin)) return null;
  return new URL(RECOVERY_CONFIRM_PATH, origin).toString();
}

// Destinations for /auth/confirm's redirects. Both are fixed, relative,
// same-origin paths that carry their own query string, for two reasons
// observed on the Netlify runtime (PR #33 preview):
//  - A relative Location is resolved against the host the browser used. An
//    absolute URL built from request.url pointed at the per-deploy permalink
//    host instead, where the session cookie just set does not exist.
//  - When a redirect's Location has no query string, the incoming query is
//    re-attached to it, which would copy a consumed `code` / `token_hash` (or
//    an injected `next`) into the next page's URL and history. A Location
//    with its own query string is left as is.
export const CONFIRM_SUCCESS_DESTINATION = `${RESET_PASSWORD_PATH}?from=email-link`;
export const CONFIRM_FAILURE_DESTINATION = `${FORGOT_PASSWORD_PATH}?reason=link_invalid`;

export function normalizeEmail(input: string): string | null {
  const email = input.trim();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  return email;
}

export type PasswordValidation =
  | { ok: true }
  | { ok: false; reason: "empty" | "too_short" | "too_long" | "mismatch" };

export function validateNewPassword(password: string, confirmation: string): PasswordValidation {
  if (password.length === 0 || confirmation.length === 0) return { ok: false, reason: "empty" };
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    return { ok: false, reason: "too_long" };
  }
  if (password !== confirmation) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

function isRecoveryLinkType(value: string | null): value is RecoveryLinkType {
  return value !== null && (RECOVERY_LINK_TYPES as readonly string[]).includes(value);
}

export type ConfirmAction =
  | { kind: "verify_otp"; type: RecoveryLinkType; tokenHash: string }
  | { kind: "exchange_code"; code: string }
  // Implicit-flow tokens arrive in the URL fragment, which the server never
  // sees. The route redirects to /reset-password and the browser carries the
  // fragment across the redirect to the client-side handler.
  | { kind: "forward_fragment" }
  | { kind: "invalid" };

/**
 * Decides what /auth/confirm does with its query string. Only recovery and
 * invite link types are accepted; there is deliberately no `next` /
 * `redirect_to` handling, so this route can never be used as an open redirect.
 */
export function resolveConfirmAction(params: URLSearchParams): ConfirmAction {
  if (params.has("error") || params.has("error_code") || params.has("error_description")) {
    return { kind: "invalid" };
  }
  const tokenHash = params.get("token_hash");
  if (tokenHash !== null) {
    const type = params.get("type");
    if (!isRecoveryLinkType(type)) return { kind: "invalid" };
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(tokenHash)) return { kind: "invalid" };
    return { kind: "verify_otp", type, tokenHash };
  }
  const code = params.get("code");
  if (code !== null) {
    if (!/^[A-Za-z0-9-]{1,256}$/u.test(code)) return { kind: "invalid" };
    return { kind: "exchange_code", code };
  }
  return { kind: "forward_fragment" };
}

export type RecoveryFragment =
  | { kind: "session"; type: RecoveryLinkType; accessToken: string; refreshToken: string }
  | { kind: "error" }
  | { kind: "none" };

export function parseRecoveryFragment(hash: string): RecoveryFragment {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return { kind: "none" };
  const params = new URLSearchParams(raw);
  if (params.has("error") || params.has("error_code") || params.has("error_description")) {
    return { kind: "error" };
  }
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken === null && refreshToken === null) return { kind: "none" };
  const type = params.get("type");
  if (!accessToken || !refreshToken || !isRecoveryLinkType(type)) return { kind: "error" };
  return { kind: "session", type, accessToken, refreshToken };
}

/**
 * True only when the verified session was created by following a recovery or
 * invite link within the last RECOVERY_CONTEXT_MAX_AGE_SECONDS. Any other AMR
 * method (password, otp, magiclink, ...) and malformed or string-only AMR
 * claims (no timestamps) fail closed.
 */
export function hasRecoveryContext(amr: unknown, nowSeconds: number): boolean {
  return hasFreshAuthentication(amr, RECOVERY_AMR_METHODS, nowSeconds);
}

/**
 * True when the signed `amr` claim contains one of `methods` with a timestamp
 * inside the recovery window. On its own this proves nothing about purpose;
 * hasRecoveryContext and the invite-purpose binding decide what it authorizes.
 */
export function hasFreshAuthentication(
  amr: unknown,
  methods: ReadonlySet<string>,
  nowSeconds: number,
): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string" || !methods.has(method)) return false;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
    return isWithinRecoveryWindow(timestamp, nowSeconds);
  });
}

/** `atSeconds` lies within the recovery window ending now (with clock skew). */
export function isWithinRecoveryWindow(atSeconds: number, nowSeconds: number): boolean {
  const age = nowSeconds - atSeconds;
  return age >= -CLOCK_SKEW_ALLOWANCE_SECONDS && age <= RECOVERY_CONTEXT_MAX_AGE_SECONDS;
}

// ---------------------------------------------------------------------------
// Orchestration against a minimal auth-client surface, so tests can pass a
// fake. The real argument is `supabase.auth` from the Admin browser client.
// ---------------------------------------------------------------------------

type AuthResult = { error: unknown };

export type RecoveryAuthClient = {
  resetPasswordForEmail(email: string, options: { redirectTo: string }): Promise<AuthResult>;
  updateUser(attributes: { password: string }): Promise<AuthResult>;
  signOut(): Promise<AuthResult>;
  setSession(tokens: { access_token: string; refresh_token: string }): Promise<AuthResult>;
};

export type ResetRequestStatus = "sent" | "invalid_email" | "config_error" | "unavailable";

/**
 * Any response from Supabase -- success, unknown account, rate limit -- maps to
 * the same "sent" status, so the UI cannot reveal whether an account exists.
 * Only a request that could not be made at all (invalid input, untrusted
 * origin, network failure) is reported differently, and none of those depend
 * on the account.
 */
export async function requestPasswordReset(
  auth: Pick<RecoveryAuthClient, "resetPasswordForEmail">,
  rawEmail: string,
  origin: string,
): Promise<ResetRequestStatus> {
  const email = normalizeEmail(rawEmail);
  if (!email) return "invalid_email";
  const redirectTo = buildRecoveryRedirectUrl(origin);
  if (!redirectTo) return "config_error";
  try {
    await auth.resetPasswordForEmail(email, { redirectTo });
  } catch {
    return "unavailable";
  }
  return "sent";
}

export type CompleteResetResult =
  // Password changed and the recovery session was signed out.
  | { status: "updated" }
  // Password changed, but sign-out could not be confirmed. The session may
  // still be active; the UI must not say it was cleared and must offer a retry.
  | { status: "updated_signout_unconfirmed" }
  | { status: "invalid"; reason: Exclude<PasswordValidation, { ok: true }>["reason"] }
  // No fresh recovery/invite context at submit time (e.g. the form was left
  // open past the window). updateUser was not called.
  | { status: "no_context" }
  | { status: "failed" };

/**
 * `verifyContext` must re-verify, at call time, the session's signed claims,
 * their recovery/invite purpose and their freshness against a trusted clock
 * (in the app: the verifyRecoveryContext Server Action). Deciding this only
 * when the page rendered would let a form left open past the window still
 * change the password. It runs immediately before updateUser and any failure
 * (false or thrown) stops the update.
 *
 * `clearPurposeBinding` drops the invite-purpose binding (in the app: the
 * clearInvitePurpose Server Action) once the password has been set, so it
 * cannot authorize a second change even if sign-out then fails.
 */
export async function completePasswordReset(
  auth: Pick<RecoveryAuthClient, "updateUser" | "signOut">,
  password: string,
  confirmation: string,
  verifyContext: () => Promise<boolean>,
  clearPurposeBinding: () => Promise<void> = async () => {},
): Promise<CompleteResetResult> {
  const validation = validateNewPassword(password, confirmation);
  if (!validation.ok) return { status: "invalid", reason: validation.reason };
  let fresh = false;
  try {
    fresh = await verifyContext();
  } catch {
    fresh = false;
  }
  if (!fresh) return { status: "no_context" };
  try {
    const { error } = await auth.updateUser({ password });
    if (error) return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
  try {
    await clearPurposeBinding();
  } catch {
    // Not fatal: the binding expires with the recovery window and is tied to
    // this session, which the sign-out below ends.
  }
  // Drop the recovery session so it cannot be reused for anything else; the
  // user logs in with the new password, which re-runs the admin_users check.
  return (await signOutConfirmed(auth))
    ? { status: "updated" }
    : { status: "updated_signout_unconfirmed" };
}

/**
 * True only when signOut() reported success. A returned error or a thrown
 * failure is treated as "not signed out": the session may still be present.
 */
export async function signOutConfirmed(auth: Pick<RecoveryAuthClient, "signOut">): Promise<boolean> {
  try {
    const { error } = await auth.signOut();
    return !error;
  } catch {
    return false;
  }
}

export type FragmentSessionStatus = "established" | "invalid" | "none";

export async function establishSessionFromFragment(
  auth: Pick<RecoveryAuthClient, "setSession">,
  fragment: RecoveryFragment,
): Promise<FragmentSessionStatus> {
  if (fragment.kind === "none") return "none";
  if (fragment.kind === "error") return "invalid";
  try {
    const { error } = await auth.setSession({
      access_token: fragment.accessToken,
      refresh_token: fragment.refreshToken,
    });
    return error ? "invalid" : "established";
  } catch {
    return "invalid";
  }
}
