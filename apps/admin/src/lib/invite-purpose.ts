// Server-only invite-purpose binding for the Admin password setup flow.
//
// Supabase records a session created by verifyOtp({ token_hash, type: "invite" })
// with amr method "otp" -- the same value any email/phone OTP sign-in gets --
// so the signed claims alone cannot tell an invite apart from a generic OTP
// login. Accepting "otp" outright was rejected in review. Instead, only
// /auth/confirm, right after it has itself verified an invite link, issues a
// short-lived HMAC-signed httpOnly cookie naming that exact user and session.
// /reset-password then accepts an "otp" session only together with a valid
// binding for the same user and session, within the same window as recovery.
//
// The cookie holds no token_hash, auth code, JWT or password: only the user
// id, the session id, an expiry, and a signature. It cannot be minted by the
// caller without ADMIN_INVITE_BINDING_SECRET, a server-only variable. When
// that variable is missing or too short nothing is issued or accepted, so
// invites fail closed (recovery is unaffected).
//
// Must not be imported by client components (node:crypto, server secret).

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CONFIRM_FAILURE_DESTINATION,
  CONFIRM_SUCCESS_DESTINATION,
  hasFreshAuthentication,
  hasRecoveryContext,
  isWithinRecoveryWindow,
  RECOVERY_CONTEXT_MAX_AGE_SECONDS,
  type ConfirmAction,
} from "./password-recovery.ts";

export const INVITE_BINDING_SECRET_ENV = "ADMIN_INVITE_BINDING_SECRET";
const MIN_SECRET_BYTES = 32;

// __Host-: Secure, Path=/, no Domain, so no other host can plant or read it.
export const INVITE_PURPOSE_COOKIE = "__Host-kabumori-admin-invite";

// SameSite=Lax, not Strict: the email link is a cross-site navigation and
// its redirect to /reset-password must carry the cookie for the render-time
// check (the Supabase session cookies are Lax for the same reason). Lax
// still keeps it off cross-site subrequests and cross-site POSTs.
export const INVITE_PURPOSE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: RECOVERY_CONTEXT_MAX_AGE_SECONDS,
} as const;

// Clearing must repeat the attributes: a __Host- cookie is only replaced by a
// Set-Cookie that is itself Secure with Path=/.
export const CLEARED_INVITE_PURPOSE_COOKIE_OPTIONS = { ...INVITE_PURPOSE_COOKIE_OPTIONS, maxAge: 0 } as const;

const TOKEN_VERSION = "v1";
const SIGNATURE_CONTEXT = "kabumori-admin/invite-password-setup";
const TOKEN_MAX_LENGTH = 512;
// Supabase user and session ids are UUIDs; no "." so the token splits cleanly.
const ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/u;
const OTP_METHOD: ReadonlySet<string> = new Set(["otp"]);

export type InviteBinding = { userId: string; sessionId: string };

// The verified claims this module reads. getClaims() returns a superset.
export type SessionClaims = { amr?: unknown; sub?: unknown; session_id?: unknown };

export function readInviteBindingSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const secret = env[INVITE_BINDING_SECRET_ENV];
  if (typeof secret !== "string") return null;
  return Buffer.byteLength(secret, "utf8") >= MIN_SECRET_BYTES ? secret : null;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`${SIGNATURE_CONTEXT}\n${payload}`).digest("base64url");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * The binding a freshly verified invite session qualifies for: its signed
 * claims show a fresh "otp" authentication and name a user and a session.
 */
export function inviteBindingFor(claims: SessionClaims, nowSeconds: number): InviteBinding | null {
  if (!hasFreshAuthentication(claims.amr, OTP_METHOD, nowSeconds)) return null;
  if (!isId(claims.sub) || !isId(claims.session_id)) return null;
  return { userId: claims.sub, sessionId: claims.session_id };
}

export function issueInvitePurposeToken(
  secret: string,
  binding: InviteBinding,
  nowSeconds: number,
): string | null {
  if (!isId(binding.userId) || !isId(binding.sessionId)) return null;
  const expiresAt = Math.floor(nowSeconds) + RECOVERY_CONTEXT_MAX_AGE_SECONDS;
  const payload = `${TOKEN_VERSION}.${binding.userId}.${binding.sessionId}.${expiresAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * True only for an unexpired token this server signed for exactly this user
 * and session. Anything else -- missing, malformed, forged, expired, too far
 * in the future, or issued for another user or session -- is false.
 */
export function verifyInvitePurposeToken(
  token: unknown,
  secret: string,
  binding: InviteBinding,
  nowSeconds: number,
): boolean {
  if (typeof token !== "string" || token.length > TOKEN_MAX_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 5) return false;
  const [version, userId, sessionId, expiresAtText, signature] = parts;
  if (version !== TOKEN_VERSION || !/^\d{1,12}$/u.test(expiresAtText)) return false;

  const expected = Buffer.from(sign(secret, parts.slice(0, 4).join(".")));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;

  // Issued at most one window ago and expiring no later than one window from
  // now (so a signed token cannot outlive the window it was issued for).
  const expiresAt = Number(expiresAtText);
  if (expiresAt < nowSeconds) return false;
  if (!isWithinRecoveryWindow(expiresAt - RECOVERY_CONTEXT_MAX_AGE_SECONDS, nowSeconds)) return false;

  return userId === binding.userId && sessionId === binding.sessionId;
}

/**
 * The single authority check behind /reset-password, on verified claims and
 * the server clock:
 *  - a fresh recovery/invite authentication, as before; or
 *  - a fresh "otp" authentication *and* a valid invite-purpose binding for the
 *    same user and session. A generic OTP session without that binding (or
 *    with a forged, expired or foreign one) is denied.
 */
export function hasPasswordSetupAuthority(input: {
  claims: SessionClaims;
  invitePurposeToken: string | null;
  secret: string | null;
  nowSeconds: number;
}): boolean {
  const { claims, invitePurposeToken, secret, nowSeconds } = input;
  if (hasRecoveryContext(claims.amr, nowSeconds)) return true;
  if (secret === null || invitePurposeToken === null) return false;
  const binding = inviteBindingFor(claims, nowSeconds);
  if (binding === null) return false;
  return verifyInvitePurposeToken(invitePurposeToken, secret, binding, nowSeconds);
}

// ---------------------------------------------------------------------------
// /auth/confirm orchestration against a minimal auth surface (the real
// argument is `supabase.auth` from the Admin server client).
// ---------------------------------------------------------------------------

export type ConfirmAuthClient = {
  verifyOtp(params: { type: "recovery" | "invite"; token_hash: string }): Promise<{
    data: { session: { access_token: string } | null };
    error: unknown;
  }>;
  exchangeCodeForSession(code: string): Promise<{ error: unknown }>;
  getClaims(jwt: string): Promise<{ data: { claims: SessionClaims } | null; error: unknown }>;
};

export type ConfirmOutcome = {
  destination: typeof CONFIRM_SUCCESS_DESTINATION | typeof CONFIRM_FAILURE_DESTINATION;
  // Set only after this request itself verified an invite link.
  invitePurposeToken: string | null;
};

/**
 * Establishes the session for a recovery/invite link and, for a successfully
 * verified invite only, issues the invite-purpose token for the new session.
 * A failed invite, any other link type, a PKCE code, a missing secret, or
 * unverifiable claims never produce a token.
 */
export async function confirmEmailLink(
  auth: ConfirmAuthClient,
  action: Extract<ConfirmAction, { kind: "verify_otp" | "exchange_code" }>,
  secret: string | null,
  nowSeconds: () => number,
): Promise<ConfirmOutcome> {
  const failure: ConfirmOutcome = { destination: CONFIRM_FAILURE_DESTINATION, invitePurposeToken: null };
  const success: ConfirmOutcome = { destination: CONFIRM_SUCCESS_DESTINATION, invitePurposeToken: null };

  if (action.kind === "exchange_code") {
    try {
      const { error } = await auth.exchangeCodeForSession(action.code);
      return error ? failure : success;
    } catch {
      return failure;
    }
  }

  let accessToken: string | undefined;
  try {
    const { data, error } = await auth.verifyOtp({ type: action.type, token_hash: action.tokenHash });
    if (error) return failure;
    accessToken = data.session?.access_token;
  } catch {
    return failure;
  }
  if (action.type !== "invite" || secret === null || !accessToken) return success;

  // The session exists; without a binding the reset page simply fails closed.
  try {
    const { data, error } = await auth.getClaims(accessToken);
    if (error || data === null) return success;
    const now = nowSeconds();
    const binding = inviteBindingFor(data.claims, now);
    if (binding === null) return success;
    return { ...success, invitePurposeToken: issueInvitePurposeToken(secret, binding, now) };
  } catch {
    return success;
  }
}
