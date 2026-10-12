// POSTONA Threads — the person's own Threads disconnect: the HTTP contract between the app and the database
// function public.disconnect_threads_account (supabase/candidates/postona_threads_disconnect/). F4, SOURCE
// ONLY, hard-disabled: THREADS_DISCONNECT_SERVER_ENABLED is false and the database candidate ships with its
// own gate closed. Removes ONLY the Threads connection; X, the POSTONA registration, the common account and
// Kabumori are not touched. Not the account deletion (G5) and not its Threads cleanup.
//
//   POST {"action":"disconnect","social_account_id":"sa_…","expected_handle":"…"}   (the account the person
//   confirmed on screen) -> 200 {ok:true, status, code, publish_permission, local_credentials, remote_access}
//     status disconnected / LOCAL_REMOVED      the local credential and connection are removed and read back
//            stopped / PUBLISH_IN_FLIGHT        publishing is stopped; a post may exist, so the credential is
//                                               KEPT until it is reconciled (try again afterwards)
//            stopped / SECRET_SHARED | DISCONNECT_FAILED   publishing is stopped, the credential is kept
//            not_connected / ALREADY_REMOVED    nothing was connected (a repeated tap, another device)
//     remote_access is always `not_revoked_by_app`: the Threads API documents no endpoint for an app to
//     revoke a person's grant (only Meta's deauthorize / data-deletion callbacks, which Meta calls when the
//     person removes the app in Threads). The local result and the remote result are reported separately
//     and POSTONA never says the Threads-side permission was removed.
//   Failures: {ok:false, error} with fixed codes only.
//
// Who: the caller's own token is verified with Auth (GET /auth/v1/user) and then sent unchanged to the
// database, which takes the user and the session from the same verified claims (auth.uid(), session_id),
// re-checks the session row, the G5 lifecycle and owner/admin of the caller's own workspace. This module
// never decodes a JWT, never takes a user id from the body, holds no service-role key and logs nothing.

import { parseFlatJsonObject } from "../../social-mobile-threads-publish/logic.ts";

/** The server gate. A reviewed source change, together with the database gate and the app gate. */
export const THREADS_DISCONNECT_SERVER_ENABLED = false;
export const THREADS_DISCONNECT_RPC = "disconnect_threads_account";

export const THREADS_DISCONNECT_REFUSALS = [
  "DISCONNECT_DISABLED", "AUTH_REQUIRED", "REQUEST_INVALID", "SERVICE_NOT_ACTIVE", "ACCOUNT_LIFECYCLE_BLOCKED", "BUSY",
  "ACCOUNT_NOT_FOUND", "ACCOUNT_CHANGED", "DISCONNECT_FORBIDDEN",
] as const;
export type ThreadsDisconnectRefusal = (typeof THREADS_DISCONNECT_REFUSALS)[number];
export type ThreadsDisconnectError = ThreadsDisconnectRefusal | "METHOD_NOT_ALLOWED" | "STORE_UNAVAILABLE" | "THREADS_DISCONNECT_DISABLED";

const HTTP_STATUS: Readonly<Record<ThreadsDisconnectError, number>> = {
  DISCONNECT_DISABLED: 503, THREADS_DISCONNECT_DISABLED: 503, STORE_UNAVAILABLE: 503, METHOD_NOT_ALLOWED: 405,
  AUTH_REQUIRED: 401, REQUEST_INVALID: 400, DISCONNECT_FORBIDDEN: 403, ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_CHANGED: 409, ACCOUNT_LIFECYCLE_BLOCKED: 409, SERVICE_NOT_ACTIVE: 409, BUSY: 409,
};

/** Each answer the database may give, exactly: status -> its codes and its local credential state. */
const ANSWERS: Readonly<Record<string, { codes: readonly string[]; local: string }>> = {
  disconnected: { codes: ["LOCAL_REMOVED"], local: "removed" },
  stopped: { codes: ["PUBLISH_IN_FLIGHT", "SECRET_SHARED", "DISCONNECT_FAILED"], local: "kept" },
  not_connected: { codes: ["ALREADY_REMOVED"], local: "none" },
};

export type ThreadsDisconnectAnswer = Readonly<{
  status: "disconnected" | "stopped" | "not_connected";
  code: string;
  publishPermission: "withdrawn" | "already_off";
  localCredentials: "removed" | "kept" | "none";
  remoteAccess: "not_revoked_by_app";
}>;

export class ThreadsDisconnectFailure extends Error {
  constructor(readonly code: ThreadsDisconnectError) {
    super(code);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

export const SOCIAL_ACCOUNT_ID = /^[a-z][a-z0-9_]{1,80}$/;
/** A handle as shown on screen, with or without its leading @; no spaces or control characters. */
export const EXPECTED_HANDLE = /^@?[^\s\p{Cc}@]{1,63}$/u;

/** The database's answer -> the typed answer. Anything off-contract is "unavailable" (never a success). */
export function parseThreadsDisconnectAnswer(value: unknown): ThreadsDisconnectAnswer {
  if (!isRecord(value)) throw new ThreadsDisconnectFailure("STORE_UNAVAILABLE");
  if (value.status === "refused" && keysAre(value, ["status", "code"])) {
    const code = value.code;
    throw new ThreadsDisconnectFailure(
      typeof code === "string" && (THREADS_DISCONNECT_REFUSALS as readonly string[]).includes(code) ? code as ThreadsDisconnectRefusal : "STORE_UNAVAILABLE",
    );
  }
  const shape = typeof value.status === "string" && Object.hasOwn(ANSWERS, value.status) ? ANSWERS[value.status] : null;
  if (!shape || !keysAre(value, ["status", "code", "publish_permission", "local_credentials", "remote_access"])
    || typeof value.code !== "string" || !shape.codes.includes(value.code)
    || (value.publish_permission !== "withdrawn" && value.publish_permission !== "already_off")
    || value.local_credentials !== shape.local || value.remote_access !== "not_revoked_by_app"
    || (value.status === "not_connected" && value.publish_permission !== "already_off")) {
    throw new ThreadsDisconnectFailure("STORE_UNAVAILABLE");
  }
  return {
    status: value.status as ThreadsDisconnectAnswer["status"],
    code: value.code,
    publishPermission: value.publish_permission,
    localCredentials: value.local_credentials as ThreadsDisconnectAnswer["localCredentials"],
    remoteAccess: "not_revoked_by_app",
  };
}

export type ThreadsDisconnectDeps = Readonly<{
  /** The Auth user of this bearer token (GET /auth/v1/user), or null when the token is not valid. */
  getUser(token: string): Promise<{ id: string } | null>;
  /** The database call, with the caller's own token. Resolves the JSON body; throws when it has none. */
  disconnect(token: string, socialAccountId: string, expectedHandle: string): Promise<unknown>;
}>;

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
const respond = (body: Record<string, unknown>, status: number) => Response.json(body, { status, headers: HEADERS });
const failure = (error: ThreadsDisconnectError) => respond({ ok: false, error }, HTTP_STATUS[error]);

const MAX_BODY_BYTES = 2048;

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

/** The request handler, independent of the static gate (tests call it directly; the entry checks the gate). */
export async function handleThreadsDisconnect(request: Request, deps: ThreadsDisconnectDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED");
  const match = /^Bearer\s+(\S+)$/i.exec((request.headers.get("Authorization") ?? "").trim());
  const token = match?.[1];
  if (!token || token.length > 16384) return failure("AUTH_REQUIRED");
  const body = await readBody(request);
  const accountId = body?.get("social_account_id");
  const handle = body?.get("expected_handle");
  if (!body || body.size !== 3 || body.get("action") !== "disconnect" || typeof accountId !== "string" || !SOCIAL_ACCOUNT_ID.test(accountId)
    || typeof handle !== "string" || !EXPECTED_HANDLE.test(handle)) {
    return failure("REQUEST_INVALID");
  }
  try {
    // The person, verified by Auth now (not only by the platform's JWT check): a signed-out token stops here.
    const user = await deps.getUser(token);
    if (!user || typeof user.id !== "string" || !user.id) return failure("AUTH_REQUIRED");
    const answer = parseThreadsDisconnectAnswer(await deps.disconnect(token, accountId, handle));
    return respond({
      ok: true, status: answer.status, code: answer.code, publish_permission: answer.publishPermission,
      local_credentials: answer.localCredentials, remote_access: answer.remoteAccess,
    }, 200);
  } catch (error) {
    // A lost or unknown answer: the app must read the account list again; nothing claims success.
    return failure(error instanceof ThreadsDisconnectFailure ? error.code : "STORE_UNAVAILABLE");
  }
}

/** The gate, checked before anything else: while it is closed nothing is read, verified or called. */
export function gatedThreadsDisconnectHandler(enabled: boolean, handler: (request: Request) => Promise<Response>) {
  return (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return Promise.resolve(new Response(null, { status: 204, headers: HEADERS }));
    if (!enabled) return Promise.resolve(failure("THREADS_DISCONNECT_DISABLED"));
    return handler(request);
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The database call over the Data API with the caller's own token (role authenticated); no other key. */
export function createThreadsDisconnectRpc(config: Readonly<{ supabaseUrl: string; anonKey: string }>, fetchImpl: FetchLike = fetch) {
  return async (token: string, socialAccountId: string, expectedHandle: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${THREADS_DISCONNECT_RPC}`, {
        method: "POST",
        redirect: "manual",
        headers: { apikey: config.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ p_social_account_id: socialAccountId, p_expected_handle: expectedHandle }),
      });
    } catch {
      throw new ThreadsDisconnectFailure("STORE_UNAVAILABLE");
    }
    if (response.status === 401) throw new ThreadsDisconnectFailure("AUTH_REQUIRED");
    if (!response.ok) throw new ThreadsDisconnectFailure("STORE_UNAVAILABLE");
    try {
      return await response.json();
    } catch {
      throw new ThreadsDisconnectFailure("STORE_UNAVAILABLE");
    }
  };
}
