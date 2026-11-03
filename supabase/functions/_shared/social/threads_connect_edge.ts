// POSTONA Threads connect — the HTTP contract between the app and H5's connect runtime (Draft PR #139,
// createThreadsRuntime().start / .callback), as a G4-owned handler. SOURCE ONLY: not deployed and not
// mounted. H5 owns the Edge entry (supabase/functions/threads-oauth-connect-user, hard-disabled 503) and the
// runtime; this module only fixes what crosses the wire and refuses everything else, so the app
// (apps/social-mobile/src/features/threads-connect) and the runtime can be wired to each other later
// without either trusting the other's shapes.
//
//   POST {"action":"start"}                        -> 200 {ok, provider, authorization_url, expires_at}
//   POST {"action":"callback","callback_url":"…"}  -> 200 {ok, status:"connected", provider, social_account_id,
//                                                         publish_enabled:false, token_expires_at}
//   anything else                                  -> a fixed error code (below), nothing echoed
//
// Authority stays where it is: the caller's own bearer token is passed through unchanged to the runtime,
// which verifies the signed claims + Auth state (H5 verifier) and binds the OAuth state to that person and
// session in the database (PR #124 + H5 claim). This handler never decodes a JWT, never takes a user id,
// never sees a Meta secret, and never treats the browser's arrival at the callback as a connection: only the
// runtime's verified completion receipt is "connected" (and the app still re-reads the account).
//
// Duplicated on purpose (the PR #118 contract module stays unimported, enforced by its isolation test): the
// authorize endpoint and scope list below are PR #118's THREADS_CONNECT_ENDPOINTS.authorize / SCOPES.

import { parseFlatJsonObject } from "../../social-mobile-threads-publish/logic.ts";

/** Not mounted anywhere. Lifted only by a reviewed change once H5's entry delegates here (see the design doc). */
export const THREADS_CONNECT_EDGE_WIRED = false;

export const THREADS_AUTHORIZE_ENDPOINT = "https://threads.com/oauth/authorize";
export const THREADS_REQUIRED_SCOPE = "threads_basic,threads_content_publish";

export const THREADS_CONNECT_EDGE_ERRORS = [
  "METHOD_NOT_ALLOWED",
  "AUTH_REQUIRED",
  "REQUEST_INVALID",
  "CALLBACK_INVALID", // not the registered HTTPS callback, or not a plain code/state (or error) return
  "START_REFUSED", // the runtime refused to begin (signed out, no active service, workspace…): start again later
  "CALLBACK_REFUSED", // refused before any exchange: nothing happened, start again
  "EXCHANGE_OUTCOME_UNCERTAIN", // the code may have been spent: never resent, start a NEW connection
  "COMPLETE_OUTCOME_UNKNOWN", // the connection may have been stored: re-read the account, never resend
  "THREADS_CONNECT_RUNTIME_UNAVAILABLE", // no runtime wired, or it answered something off-contract
  "THREADS_CONNECT_DISABLED",
] as const;
export type ThreadsConnectEdgeError = (typeof THREADS_CONNECT_EDGE_ERRORS)[number];

/** H5's runtime, structurally (createThreadsRuntime(deps) satisfies it). */
export type ThreadsConnectRuntimePort = Readonly<{
  start(authorization: string | null): Promise<unknown>;
  callback(authorization: string | null, callbackUrl: string): Promise<unknown>;
}>;

export type ThreadsConnectEdgeConfig = Readonly<{ registeredCallback: string }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");

/** The registered callback itself must be a plain HTTPS URL (no query, no fragment, no credentials). */
export function isRegisteredCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.search === "" && url.hash === "" && url.username === "" && url.password === ""
      && url.href === value;
  } catch {
    return false;
  }
}

/**
 * The authorization URL the runtime built must be exactly the official endpoint with exactly the five
 * documented parameters, our registered callback, both scopes and a well-formed state. Anything else is not
 * opened by the app.
 */
export function isThreadsAuthorizationUrl(value: unknown, registeredCallback: string): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin + url.pathname !== THREADS_AUTHORIZE_ENDPOINT || url.hash !== "" || url.username !== "" || url.password !== "") return false;
  const names = [...url.searchParams.keys()];
  if (names.length !== 5 || new Set(names).size !== 5) return false;
  const p = url.searchParams;
  return /^[0-9]{1,32}$/.test(p.get("client_id") ?? "") && p.get("redirect_uri") === registeredCallback
    && p.get("scope") === THREADS_REQUIRED_SCOPE && p.get("response_type") === "code"
    && /^[A-Za-z0-9_-]{43,128}$/.test(p.get("state") ?? "");
}

/** The exact registered callback with only code/state (or Meta's error fields) and at most Meta's `#_`. */
export function isThreadsCallbackUrl(value: unknown, registeredCallback: string): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin + url.pathname !== registeredCallback || url.username !== "" || url.password !== "") return false;
  if (url.hash !== "" && url.hash !== "#_") return false;
  const names = [...url.searchParams.keys()];
  const allowed = new Set(["code", "state", "error", "error_reason", "error_description"]);
  return names.length > 0 && names.length <= 4 && new Set(names).size === names.length && names.every((n) => allowed.has(n));
}

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const respond = (body: Record<string, unknown>, status: number) => Response.json(body, { status, headers: HEADERS });
const failure = (error: ThreadsConnectEdgeError, status: number, extra: Record<string, unknown> = {}) =>
  respond({ ok: false, error, ...extra }, status);

const MAX_BODY_BYTES = 9000;

async function readBody(request: Request): Promise<Map<string, string | boolean> | null> {
  if (!/^application\/json(?:\s*;.*)?$/i.test((request.headers.get("Content-Type") ?? "").trim())) return null;
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) return null;
  try {
    return parseFlatJsonObject(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * The handler. `runtime` is null until H5's runtime is wired with its real owner transport, Meta settings and
 * keys; then every request still goes through it with the caller's own Authorization header.
 */
export function createThreadsConnectHandler(runtime: ThreadsConnectRuntimePort | null, config: ThreadsConnectEdgeConfig) {
  const registered = isRegisteredCallback(config.registeredCallback) ? config.registeredCallback : null;
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED", 405);
    const authorization = request.headers.get("Authorization");
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization.trim()) || authorization.length > 16384) return failure("AUTH_REQUIRED", 401);
    const body = await readBody(request);
    const action = body?.get("action");
    if (!body || (action !== "start" && action !== "callback")) return failure("REQUEST_INVALID", 400);
    if (action === "start" && body.size !== 1) return failure("REQUEST_INVALID", 400);
    if (action === "callback" && (body.size !== 2 || typeof body.get("callback_url") !== "string")) return failure("REQUEST_INVALID", 400);
    if (runtime === null || registered === null) return failure("THREADS_CONNECT_RUNTIME_UNAVAILABLE", 503);
    try {
      if (action === "start") return startAnswer(await runtime.start(authorization), registered);
      const callbackUrl = body.get("callback_url") as string;
      if (!isThreadsCallbackUrl(callbackUrl, registered)) return failure("CALLBACK_INVALID", 400);
      return callbackAnswer(await runtime.callback(authorization, callbackUrl));
    } catch {
      return failure("THREADS_CONNECT_RUNTIME_UNAVAILABLE", 503);
    }
  };
}

function startAnswer(r: unknown, registered: string): Response {
  if (isRecord(r) && r.ok === false && keysAre(r, ["ok", "error", "restartRequired"]) && r.error === "START_REFUSED") {
    return failure("START_REFUSED", 409, { restart_required: true });
  }
  if (!isRecord(r) || r.ok !== true || !keysAre(r, ["ok", "provider", "authorizationUrl", "expiresAt"]) || r.provider !== "threads"
    || !isThreadsAuthorizationUrl(r.authorizationUrl, registered) || typeof r.expiresAt !== "string") {
    return failure("THREADS_CONNECT_RUNTIME_UNAVAILABLE", 503);
  }
  const expires = Date.parse(r.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 11 * 60 * 1000) return failure("THREADS_CONNECT_RUNTIME_UNAVAILABLE", 503);
  return respond({ ok: true, provider: "threads", authorization_url: r.authorizationUrl, expires_at: new Date(expires).toISOString() }, 200);
}

function callbackAnswer(r: unknown): Response {
  if (isRecord(r) && r.ok === false && keysAre(r, ["ok", "error", "reconciliationRequired", "restartRequired"])) {
    const reconcile = r.reconciliationRequired === true;
    if (r.error === "CALLBACK_REFUSED" && !reconcile) return failure("CALLBACK_REFUSED", 409, { restart_required: true, reconciliation_required: false });
    if (r.error === "EXCHANGE_OUTCOME_UNCERTAIN" && reconcile) return failure("EXCHANGE_OUTCOME_UNCERTAIN", 409, { restart_required: true, reconciliation_required: true });
    if (r.error === "COMPLETE_OUTCOME_UNKNOWN" && reconcile) return failure("COMPLETE_OUTCOME_UNKNOWN", 409, { restart_required: true, reconciliation_required: true });
    return failure("THREADS_CONNECT_RUNTIME_UNAVAILABLE", 503);
  }
  if (!isRecord(r) || r.ok !== true || !keysAre(r, ["ok", "status", "provider", "socialAccountId", "publishEnabled", "tokenExpiresAt"])
    || r.status !== "connected" || r.provider !== "threads" || r.publishEnabled !== false
    || typeof r.socialAccountId !== "string" || !/^sa_[0-9a-f]{24}$/.test(r.socialAccountId) || typeof r.tokenExpiresAt !== "string") {
    return failure("THREADS_CONNECT_RUNTIME_UNAVAILABLE", 503);
  }
  const expires = Date.parse(r.tokenExpiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 61 * 24 * 3600 * 1000) return failure("THREADS_CONNECT_RUNTIME_UNAVAILABLE", 503);
  return respond({
    ok: true, status: "connected", provider: "threads", social_account_id: r.socialAccountId,
    publish_enabled: false, token_expires_at: new Date(expires).toISOString(),
  }, 200);
}
