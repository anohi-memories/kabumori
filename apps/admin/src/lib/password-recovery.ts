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
//   /reset-password   -> only usable while the session carries a fresh email-link
//                        authentication; updateUser({ password }) then signOut()
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

// Authentication methods that prove possession of the account's email inbox
// just now. GoTrue records the method that created a session in the JWT `amr`
// claim; a normal password login records "password" and is therefore never
// accepted here, which keeps /reset-password from turning an already-open
// Admin session into a "change the password without knowing it" page.
const EMAIL_LINK_AMR_METHODS: ReadonlySet<string> = new Set([
  "recovery",
  "invite",
  "otp",
  "magiclink",
]);

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

/**
 * Absolute, same-origin destination for /auth/confirm's redirects. It is built
 * from the request's origin plus a fixed internal path only, so nothing from
 * the incoming query string (a consumed `code` / `token_hash`, or an injected
 * `next`) is carried along. A relative Location header is not enough: on
 * Netlify a relative Location was observed to be resolved with the original
 * query string re-attached.
 */
export function buildSameOriginRedirect(requestUrl: string, internalPath: string): string {
  if (!internalPath.startsWith("/") || internalPath.startsWith("//")) {
    throw new Error("internal redirect path must be an absolute same-origin path");
  }
  return new URL(internalPath, new URL(requestUrl).origin).toString();
}

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
 * True only when the verified session was created by following an email link
 * within the last RECOVERY_CONTEXT_MAX_AGE_SECONDS. Malformed or string-only
 * AMR claims (no timestamps) fail closed.
 */
export function hasRecoveryContext(amr: unknown, nowSeconds: number): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string" || !EMAIL_LINK_AMR_METHODS.has(method)) return false;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return false;
    const age = nowSeconds - timestamp;
    return age >= -CLOCK_SKEW_ALLOWANCE_SECONDS && age <= RECOVERY_CONTEXT_MAX_AGE_SECONDS;
  });
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
  | { status: "updated" }
  | { status: "invalid"; reason: Exclude<PasswordValidation, { ok: true }>["reason"] }
  | { status: "no_context" }
  | { status: "failed" };

export async function completePasswordReset(
  auth: Pick<RecoveryAuthClient, "updateUser" | "signOut">,
  password: string,
  confirmation: string,
  hasContext: boolean,
): Promise<CompleteResetResult> {
  const validation = validateNewPassword(password, confirmation);
  if (!validation.ok) return { status: "invalid", reason: validation.reason };
  if (!hasContext) return { status: "no_context" };
  try {
    const { error } = await auth.updateUser({ password });
    if (error) return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
  // Drop the recovery session so it cannot be reused for anything else; the
  // user logs in with the new password, which re-runs the admin_users check.
  try {
    await auth.signOut();
  } catch {
    // supabase-js clears the local session even when the revoke call fails.
  }
  return { status: "updated" };
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
