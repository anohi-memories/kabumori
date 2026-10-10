// POSTONA Phase 2b — the provider side of connecting a Threads account, as a pure contract.
//
// What this is: the exact Threads OAuth contract (official Meta documentation, re-read 2026-10-10) as
// request builders and fail-closed response validators, with the network injected. It covers the
// authorization URL, the callback, the short-lived token exchange, the long-lived token exchange and
// the identity read, and checks that the identity the token was issued to is the identity it reads.
//
// What this is not: wired anywhere. Nothing imports it; there is no Edge Function, RPC, Vault write,
// Auth check or database access here, and no real Meta call is made by its tests. Connecting stays
// disabled by a static gate (THREADS_CONNECT_PREREQUISITES_MET) that only a reviewed source change can
// lift, once every prerequisite in THREADS_CONNECT_PREREQUISITES holds; environment configuration
// alone never enables it.
//
// Security notes carried by the contract:
//   * Only the server holds the app secret and the tokens. Nothing returned here carries the
//     short-lived token; the long-lived token is returned once, for an immediate Vault write by a
//     future reviewed owner-only RPC, and is never part of an error.
//   * Errors carry a fixed code only: never a token, code, secret, response body or URL.
//   * The short-lived exchange returns `user_id` as a JSON number larger than 2^53. Parsed as a
//     number it can round to a different account's id, so it is read from the JSON source text.
//   * The authorization code is single use: an exchange whose outcome is unknown (network failure,
//     5xx) is never retried with the same code; the user restarts the flow.
//   * Token-bearing GET requests put the token in the query string, as the official contract does:
//     their URLs must never be logged.

import type { ConnectedAccountIdentity } from "./provider_domain.ts";

// --- Official contract (developers.facebook.com/documentation/threads, read 2026-10-10) ------------

/**
 * The documented hosts differ between endpoints (threads.com / graph.threads.com for authorization
 * and the code exchange, graph.threads.net for everything else). Kept exactly as documented.
 */
export const THREADS_CONNECT_ENDPOINTS = Object.freeze({
  authorize: "https://threads.com/oauth/authorize",
  codeExchange: "https://graph.threads.com/oauth/access_token",
  longLivedExchange: "https://graph.threads.net/access_token",
  profile: "https://graph.threads.net/v1.0/me",
});

/** threads_basic is required by every Threads endpoint; threads_content_publish is for later posting. */
export const THREADS_CONNECT_SCOPES = Object.freeze(["threads_basic", "threads_content_publish"] as const);

/** Long-lived tokens last 60 days (expires_in ~5,184,000 s); anything beyond a day more is refused. */
export const THREADS_LONG_LIVED_MAX_SECONDS = 61 * 24 * 60 * 60;

// --- Static gate -------------------------------------------------------------------------------------

/** Every one of these must hold before connecting can be enabled (see docs/postona/threads-connection-phase2b.md). */
export const THREADS_CONNECT_PREREQUISITES = Object.freeze([
  "PHASE_2A2_MIGRATION_APPLIED", // the multi-provider social_accounts schema, applied in production
  "COMMON_ACCOUNT_WRITER_FENCE", // the common-account (G5) contract for writers that add a workspace footprint
  "CONNECT_RPC_REVIEWED", // owner-only begin/complete RPCs: state binding, single use, Vault references only
  "PROVIDER_AWARE_DELETION", // account deletion handles Threads rows (today: operator review)
  "META_APP_CONFIGURED", // Meta app, exact redirect URI, deauthorize / data deletion callbacks, review
] as const);
export type ThreadsConnectPrerequisite = (typeof THREADS_CONNECT_PREREQUISITES)[number];

/** Lifted only by a reviewed source change once every prerequisite above holds. */
export const THREADS_CONNECT_PREREQUISITES_MET = false;

// --- Errors ------------------------------------------------------------------------------------------

export const THREADS_CONNECT_ERROR_CODES = [
  "THREADS_CONNECT_DISABLED",
  "THREADS_STATE_MALFORMED",
  "THREADS_REDIRECT_URI_INVALID",
  "THREADS_CODE_EXCHANGE_REJECTED", // the provider refused the code (used, expired, mismatched redirect)
  "THREADS_CODE_EXCHANGE_UNAVAILABLE", // outcome unknown: the single-use code may be spent; restart
  "THREADS_CODE_EXCHANGE_MALFORMED",
  "THREADS_LONG_LIVED_EXCHANGE_REJECTED",
  "THREADS_LONG_LIVED_EXCHANGE_UNAVAILABLE",
  "THREADS_LONG_LIVED_EXCHANGE_MALFORMED",
  "THREADS_PROFILE_REJECTED",
  "THREADS_PROFILE_UNAVAILABLE",
  "THREADS_PROFILE_MALFORMED",
  "THREADS_IDENTITY_MISMATCH",
] as const;
export type ThreadsConnectErrorCode = (typeof THREADS_CONNECT_ERROR_CODES)[number];

/** Carries a fixed code only. */
export class ThreadsConnectError extends Error {
  constructor(readonly code: ThreadsConnectErrorCode) {
    super(code);
    this.name = "ThreadsConnectError";
  }
}

// --- Configuration -----------------------------------------------------------------------------------

export type ThreadsConnectSettings = Readonly<{ appId: string; appSecret: string; redirectUri: string }>;
export type ThreadsConnectConfig =
  | Readonly<{ status: "disabled"; reasons: readonly string[] }>
  | Readonly<{ status: "enabled"; settings: ThreadsConnectSettings }>;

/**
 * The redirect URI must be the exact https URI registered in the Meta app. A custom scheme is not
 * documented for Threads and is refused until it is verified; no fragment, credentials or wildcards.
 */
export function isAcceptableThreadsRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === ""
    && url.hash === "" && !value.includes("#") && !value.includes("*") && url.href === value;
}

/** Validates the environment; secrets are never echoed in the reasons. */
export function validateThreadsConnectEnv(env: (name: string) => string | undefined):
  Readonly<{ ok: true; settings: ThreadsConnectSettings } | { ok: false; reasons: readonly string[] }> {
  const reasons: string[] = [];
  const enabled = env("THREADS_CONNECT_ENABLED");
  const appId = env("THREADS_APP_ID") ?? "";
  const appSecret = env("THREADS_APP_SECRET") ?? "";
  const redirectUri = env("THREADS_REDIRECT_URI") ?? "";
  if (enabled !== "true") reasons.push("THREADS_CONNECT_ENABLED_NOT_TRUE");
  if (!/^[0-9]{1,32}$/.test(appId)) reasons.push("THREADS_APP_ID_INVALID");
  if (appSecret.length < 16 || appSecret.length > 256 || /\s/.test(appSecret)) reasons.push("THREADS_APP_SECRET_INVALID");
  if (!isAcceptableThreadsRedirectUri(redirectUri)) reasons.push("THREADS_REDIRECT_URI_INVALID");
  return reasons.length === 0 ? { ok: true, settings: { appId, appSecret, redirectUri } } : { ok: false, reasons };
}

/** Disabled while the static gate is closed, whatever the environment says. */
export function readThreadsConnectConfig(env: (name: string) => string | undefined): ThreadsConnectConfig {
  if (!THREADS_CONNECT_PREREQUISITES_MET) return { status: "disabled", reasons: ["THREADS_CONNECT_PREREQUISITES_NOT_MET"] };
  const checked = validateThreadsConnectEnv(env);
  return checked.ok ? { status: "enabled", settings: checked.settings } : { status: "disabled", reasons: checked.reasons };
}

// --- State and authorization URL ---------------------------------------------------------------------

/** 32+ random bytes, base64url: the raw state the authorization URL carries and the callback returns. */
export function isWellFormedThreadsState(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

/** Only this hash is ever stored (same as the X flow): sha256 hex of the raw state. */
export async function hashThreadsState(state: string): Promise<string> {
  if (!isWellFormedThreadsState(state)) throw new ThreadsConnectError("THREADS_STATE_MALFORMED");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildThreadsAuthorizeUrl(config: ThreadsConnectConfig, state: string): string {
  const settings = enabledSettings(config);
  if (!isWellFormedThreadsState(state)) throw new ThreadsConnectError("THREADS_STATE_MALFORMED");
  const url = new URL(THREADS_CONNECT_ENDPOINTS.authorize);
  url.searchParams.set("client_id", settings.appId);
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("scope", THREADS_CONNECT_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.href;
}

// --- Callback ------------------------------------------------------------------------------------------

export type ThreadsCallback =
  | Readonly<{ kind: "code"; code: string; state: string }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{
    kind: "invalid";
    reason: "AUTHORIZATION_ERROR" | "STATE_MISSING" | "STATE_MALFORMED" | "CODE_MISSING" | "CODE_MALFORMED" | "PARAMETER_REPEATED";
  }>;

/**
 * Reads the redirect's query parameters. The state is only checked for shape here: binding it to the
 * signed-in owner and using it once is the job of the reviewed RPC that looks it up by its hash.
 * Threads appends `#_` to the redirect; it is not part of the code.
 */
export function parseThreadsCallback(params: URLSearchParams): ThreadsCallback {
  for (const name of ["code", "state", "error"]) {
    if (params.getAll(name).length > 1) return { kind: "invalid", reason: "PARAMETER_REPEATED" };
  }
  const error = params.get("error");
  if (error !== null) {
    return error === "access_denied" && params.get("code") === null ? { kind: "denied" } : { kind: "invalid", reason: "AUTHORIZATION_ERROR" };
  }
  const state = params.get("state");
  if (state === null || state === "") return { kind: "invalid", reason: "STATE_MISSING" };
  if (!isWellFormedThreadsState(state)) return { kind: "invalid", reason: "STATE_MALFORMED" };
  const raw = params.get("code");
  if (raw === null || raw === "") return { kind: "invalid", reason: "CODE_MISSING" };
  const code = raw.endsWith("#_") ? raw.slice(0, -2) : raw;
  if (!/^[A-Za-z0-9._-]{1,2048}$/.test(code)) return { kind: "invalid", reason: "CODE_MALFORMED" };
  return { kind: "code", code, state };
}

// --- Exchanges and identity ------------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Exactly what the reviewed RPC will need: who connected, and the one credential to store. */
export type ThreadsConnectResult = Readonly<{
  identity: ConnectedAccountIdentity;
  longLivedToken: string;
  expiresInSeconds: number;
}>;

export async function exchangeThreadsCode(fetchImpl: FetchLike, config: ThreadsConnectConfig, code: string):
  Promise<Readonly<{ shortLivedToken: string; userId: string }>> {
  const settings = enabledSettings(config);
  const body = new URLSearchParams({
    client_id: settings.appId,
    client_secret: settings.appSecret,
    grant_type: "authorization_code",
    redirect_uri: settings.redirectUri,
    code,
  });
  const json = await requestJson(fetchImpl, THREADS_CONNECT_ENDPOINTS.codeExchange, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, "CODE_EXCHANGE");
  const shortLivedToken = bearerToken(json, "THREADS_CODE_EXCHANGE_MALFORMED");
  const userId = numericId(json.user_id, "THREADS_CODE_EXCHANGE_MALFORMED");
  return { shortLivedToken, userId };
}

export async function exchangeThreadsLongLived(fetchImpl: FetchLike, config: ThreadsConnectConfig, shortLivedToken: string):
  Promise<Readonly<{ longLivedToken: string; expiresInSeconds: number }>> {
  const settings = enabledSettings(config);
  const url = new URL(THREADS_CONNECT_ENDPOINTS.longLivedExchange);
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", settings.appSecret);
  url.searchParams.set("access_token", shortLivedToken);
  const json = await requestJson(fetchImpl, url.href, { method: "GET" }, "LONG_LIVED_EXCHANGE");
  const longLivedToken = bearerToken(json, "THREADS_LONG_LIVED_EXCHANGE_MALFORMED");
  const expiresInSeconds = lifetimeSeconds(json.expires_in, "THREADS_LONG_LIVED_EXCHANGE_MALFORMED");
  return { longLivedToken, expiresInSeconds };
}

export async function fetchThreadsProfile(fetchImpl: FetchLike, longLivedToken: string):
  Promise<Readonly<{ id: string; username: string | null }>> {
  const url = new URL(THREADS_CONNECT_ENDPOINTS.profile);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", longLivedToken);
  const json = await requestJson(fetchImpl, url.href, { method: "GET" }, "PROFILE");
  const id = numericId(json.id, "THREADS_PROFILE_MALFORMED");
  const username = json.username;
  if (username === undefined || username === null) return { id, username: null };
  if (typeof username !== "string" || !/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new ThreadsConnectError("THREADS_PROFILE_MALFORMED");
  return { id, username };
}

/**
 * Code -> short-lived token -> long-lived token -> identity, and the identity the code was issued to
 * must be the identity the long-lived token reads. The short-lived token never leaves this function.
 */
export async function completeThreadsConnectExchange(fetchImpl: FetchLike, config: ThreadsConnectConfig, code: string):
  Promise<ThreadsConnectResult> {
  const { shortLivedToken, userId } = await exchangeThreadsCode(fetchImpl, config, code);
  const { longLivedToken, expiresInSeconds } = await exchangeThreadsLongLived(fetchImpl, config, shortLivedToken);
  const profile = await fetchThreadsProfile(fetchImpl, longLivedToken);
  if (profile.id !== userId) throw new ThreadsConnectError("THREADS_IDENTITY_MISMATCH");
  return {
    identity: { provider: "threads", providerAccountId: profile.id, ...(profile.username ? { handle: profile.username } : {}) },
    longLivedToken,
    expiresInSeconds,
  };
}

// --- Internals ---------------------------------------------------------------------------------------------

function enabledSettings(config: ThreadsConnectConfig): ThreadsConnectSettings {
  if (config.status !== "enabled") throw new ThreadsConnectError("THREADS_CONNECT_DISABLED");
  return config.settings;
}

type Step = "CODE_EXCHANGE" | "LONG_LIVED_EXCHANGE" | "PROFILE";
const STEP_CODES: Record<Step, Readonly<{ rejected: ThreadsConnectErrorCode; unavailable: ThreadsConnectErrorCode; malformed: ThreadsConnectErrorCode }>> = {
  CODE_EXCHANGE: {
    rejected: "THREADS_CODE_EXCHANGE_REJECTED",
    unavailable: "THREADS_CODE_EXCHANGE_UNAVAILABLE",
    malformed: "THREADS_CODE_EXCHANGE_MALFORMED",
  },
  LONG_LIVED_EXCHANGE: {
    rejected: "THREADS_LONG_LIVED_EXCHANGE_REJECTED",
    unavailable: "THREADS_LONG_LIVED_EXCHANGE_UNAVAILABLE",
    malformed: "THREADS_LONG_LIVED_EXCHANGE_MALFORMED",
  },
  PROFILE: { rejected: "THREADS_PROFILE_REJECTED", unavailable: "THREADS_PROFILE_UNAVAILABLE", malformed: "THREADS_PROFILE_MALFORMED" },
};

/** A JSON number, kept as its exact source text (never converted to a JavaScript number). */
class JsonNumber {
  constructor(readonly source: string) {}
}

/**
 * One request, no retry, no redirect following, 10 s at most. 4xx = rejected, anything else that is
 * not 2xx (or no response at all) = unavailable, a 2xx that is not a JSON object = malformed. Every
 * JSON number is kept as its source text, so a large id is never rounded.
 */
async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit, step: Step): Promise<Record<string, unknown>> {
  const codes = STEP_CODES[step];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let text: string;
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    } catch {
      throw new ThreadsConnectError(codes.unavailable);
    }
    if (response.status >= 400 && response.status < 500) throw new ThreadsConnectError(codes.rejected);
    if (response.status < 200 || response.status > 299) throw new ThreadsConnectError(codes.unavailable);
    try {
      text = await response.text();
    } catch {
      throw new ThreadsConnectError(codes.unavailable);
    }
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" ? new JsonNumber(context?.source ?? "") : value);
  } catch {
    throw new ThreadsConnectError(codes.malformed);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed instanceof JsonNumber) {
    throw new ThreadsConnectError(codes.malformed);
  }
  return parsed as Record<string, unknown>;
}

function bearerToken(json: Record<string, unknown>, malformed: ThreadsConnectErrorCode): string {
  const token = json.access_token;
  const type = json.token_type;
  if (typeof token !== "string" || !/^[A-Za-z0-9._|-]{16,4096}$/.test(token)) throw new ThreadsConnectError(malformed);
  if (typeof type !== "string" || type.toLowerCase() !== "bearer") throw new ThreadsConnectError(malformed);
  return token;
}

/** A Threads user id as digits: a JSON number (its exact source text) or a string. */
function numericId(value: unknown, malformed: ThreadsConnectErrorCode): string {
  const digits = value instanceof JsonNumber ? value.source : value;
  if (typeof digits !== "string" || !/^[1-9][0-9]{0,31}$/.test(digits)) throw new ThreadsConnectError(malformed);
  return digits;
}

/** A positive whole number of seconds, sent as a JSON number. */
function lifetimeSeconds(value: unknown, malformed: ThreadsConnectErrorCode): number {
  if (!(value instanceof JsonNumber) || !/^[1-9][0-9]{0,9}$/.test(value.source)) throw new ThreadsConnectError(malformed);
  const seconds = Number(value.source);
  if (seconds > THREADS_LONG_LIVED_MAX_SECONDS) throw new ThreadsConnectError(malformed);
  return seconds;
}
