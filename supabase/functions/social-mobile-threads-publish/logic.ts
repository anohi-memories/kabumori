// SOURCE CANDIDATE. Not deployed, not routed, hard-disabled by THREADS_MANUAL_PUBLISH_PREREQUISITES_MET.
//
// POSTONA: the signed-in person posts ONE text to their own connected Threads account, explicitly.
//
// This function decides nothing about who may publish. It checks the request shape, confirms the bearer
// token with the Auth server, and hands every decision to the database (SQL candidates in
// supabase/candidates/postona_threads_publish/), always with the CALLER'S OWN JWT: reserving and reading
// as the caller; and immediately before EACH Threads call, one attested release in which the database
// re-decides everything (G5 lifecycle, the caller's session, workspace, membership, account, credential
// expiry, manual permission) and only then hands this server the credential. The provider calls go through
// _shared/social/threads_publish_contract.ts, one request each, never resent. Responses carry fixed codes
// and the attempt's public fields only: no token, no container internals, no provider body.

import {
  publishThreadsTextNow,
  reconcileThreadsAttempt,
  resumeThreadsAttempt,
  THREADS_STORE_REFUSALS,
  type ThreadsAccountPublishState,
  type ThreadsAttempt,
  type ThreadsManualPublishDeps,
  type ThreadsPublishPermissionStore,
  type ThreadsPublishStore,
  type ThreadsStoreRefusal,
  ThreadsStoreError,
  type VerifiedCaller,
} from "../_shared/social/threads_manual_publish.ts";
import type { FetchLike } from "../_shared/social/threads_publish_contract.ts";

// --- Static gate ---------------------------------------------------------------------------------------

/** Every one of these must hold before this function may be deployed or routed (docs/postona/threads-manual-publish-v1.md). */
export const THREADS_MANUAL_PUBLISH_PREREQUISITES = Object.freeze([
  "PHASE_2A2_MIGRATION_APPLIED", // multi-provider social_accounts, applied in production
  "THREADS_CONNECT_RUNTIME_LIVE", // H5: real verified Threads connections, Vault-held tokens, per-account expiry reader
  "COMMON_ACCOUNT_WRITER_FENCE_LIVE", // G5: private.account_lifecycle_assert_active_service_write
  "PUBLISH_LEDGER_APPLIED", // the reviewed SQL candidates (custody -> manual publish -> release), applied
  "PUBLISH_ATTESTATION_KEY_PROVISIONED", // the same random key in Vault and in this function's secrets (user-operated)
  "META_APP_PUBLISH_READY", // Meta app with threads_content_publish for the tester; exact redirect
  "INTEGRATED_SECURITY_REVIEW", // one focused review of connect + publish + T13 together
  "PILOT_APPROVED", // explicit user approval for a named tester account
] as const);

/** Lifted only by a reviewed source change once every prerequisite above holds. Environment never enables it. */
export const THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false;

// --- Errors --------------------------------------------------------------------------------------------

export type ThreadsPublishHttpError =
  | ThreadsStoreRefusal
  | "METHOD_NOT_ALLOWED"
  | "THREADS_PUBLISH_DISABLED";

export class ThreadsPublishHttpFailure extends Error {
  constructor(readonly code: ThreadsPublishHttpError, readonly status: number) {
    super(code);
    this.name = "ThreadsPublishHttpFailure";
  }
}

const HTTP_STATUS: Readonly<Record<ThreadsStoreRefusal, number>> = {
  AUTH_REQUIRED: 401,
  REQUEST_INVALID: 400,
  TEXT_INVALID: 400,
  ACCOUNT_NOT_FOUND: 404,
  PUBLISH_FORBIDDEN: 403,
  WORKSPACE_INACTIVE: 409,
  SERVICE_NOT_ACTIVE: 403,
  ACCOUNT_LIFECYCLE_BLOCKED: 409,
  PLATFORM_NOT_SUPPORTED: 409,
  CONNECTION_NOT_VERIFIED: 409,
  CREDENTIALS_MISSING: 409,
  CREDENTIALS_EXPIRED: 409,
  MANUAL_PUBLISH_NOT_PERMITTED: 409,
  PUBLISH_IN_PROGRESS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ATTEMPT_NOT_FOUND: 404,
  ATTEMPT_EXPIRED: 409,
  STALE_STEP: 409,
  GRANT_INVALID: 503, // never the caller's fault: the server lost its own grant
  ATTESTATION_INVALID: 503, // never the caller's fault: this server's own attestation was refused
  BUSY: 409,
  STORE_UNAVAILABLE: 503,
};

// --- Request ---------------------------------------------------------------------------------------------

export type ThreadsPublishRequest =
  | Readonly<{ action: "publish"; socialAccountId: string; idempotencyKey: string; text: string }>
  | Readonly<{ action: "resume" | "reconcile" | "status"; attemptId: string }>
  | Readonly<{ action: "account_state"; socialAccountId: string }>
  | Readonly<{ action: "set_permission"; socialAccountId: string; desiredEnabled: boolean; expectedCurrentEnabled: boolean }>;

/** Bytes, enforced while reading. 500 characters of 4-byte emoji, escaped, fit with room to spare. */
export const MAX_BODY_BYTES = 8192;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const BODY_KEYS: Readonly<Record<ThreadsPublishRequest["action"], readonly string[]>> = {
  publish: ["action", "social_account_id", "idempotency_key", "text"],
  resume: ["action", "attempt_id"],
  reconcile: ["action", "attempt_id"],
  status: ["action", "attempt_id"],
  account_state: ["action", "social_account_id"],
  set_permission: ["action", "social_account_id", "desired_enabled", "expected_current_enabled"],
};

const invalid = () => new ThreadsPublishHttpFailure("REQUEST_INVALID", 400);

/**
 * A flat JSON object of strings and booleans, parsed strictly: duplicate keys (which JSON.parse would
 * silently resolve to the last one), nesting, numbers and null are refused.
 */
export function parseFlatJsonObject(text: string): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i += 1;
  };
  const string = (): string => {
    if (text[i] !== '"') throw invalid();
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) throw invalid();
    i += 1;
    try {
      return JSON.parse(text.slice(start, i));
    } catch {
      throw invalid();
    }
  };
  ws();
  if (text[i] !== "{") throw invalid();
  i += 1;
  ws();
  if (text[i] === "}") throw invalid();
  for (;;) {
    ws();
    const key = string();
    ws();
    if (text[i] !== ":") throw invalid();
    i += 1;
    ws();
    let value: string | boolean;
    if (text.startsWith("true", i)) {
      value = true;
      i += 4;
    } else if (text.startsWith("false", i)) {
      value = false;
      i += 5;
    } else {
      value = string();
    }
    if (out.has(key)) throw invalid();
    out.set(key, value);
    ws();
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] === "}") {
      i += 1;
      break;
    }
    throw invalid();
  }
  ws();
  if (i !== text.length) throw invalid();
  return out;
}

export function parseThreadsPublishRequest(text: string): ThreadsPublishRequest {
  const body = parseFlatJsonObject(text);
  const action = body.get("action");
  if (typeof action !== "string" || !Object.hasOwn(BODY_KEYS, action)) throw invalid();
  const keys = BODY_KEYS[action as ThreadsPublishRequest["action"]];
  if (body.size !== keys.length || !keys.every((key) => body.has(key))) throw invalid();
  const str = (key: string, pattern?: RegExp) => {
    const value = body.get(key);
    if (typeof value !== "string" || (pattern && !pattern.test(value))) throw invalid();
    return value;
  };
  const bool = (key: string) => {
    const value = body.get(key);
    if (typeof value !== "boolean") throw invalid();
    return value;
  };
  switch (action) {
    case "publish":
      return { action, socialAccountId: str("social_account_id", ACCOUNT_ID), idempotencyKey: str("idempotency_key", UUID), text: str("text") };
    case "resume":
    case "reconcile":
    case "status":
      return { action, attemptId: str("attempt_id", UUID) };
    case "account_state":
      return { action, socialAccountId: str("social_account_id", ACCOUNT_ID) };
    case "set_permission":
      return { action, socialAccountId: str("social_account_id", ACCOUNT_ID), desiredEnabled: bool("desired_enabled"), expectedCurrentEnabled: bool("expected_current_enabled") };
    default:
      throw invalid();
  }
}

// --- Handler -----------------------------------------------------------------------------------------

export type ThreadsPublishHandlerDeps = Readonly<{
  /** Verified Auth user for this bearer token, or null if the token is not valid. */
  getUser(token: string): Promise<{ id: string } | null>;
  store: ThreadsPublishStore & ThreadsPublishPermissionStore;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}>;

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

function respond(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

/** The public view of an attempt. Only what the person needs to see; no container id, no text. */
export function publicAttempt(attempt: ThreadsAttempt): Record<string, unknown> {
  return {
    id: attempt.attemptId,
    social_account_id: attempt.socialAccountId,
    status: attempt.status,
    provider_post_id: attempt.status === "published" || attempt.status === "publish_returned" ? attempt.providerPostId : null,
    permalink: attempt.status === "published" ? attempt.permalink : null,
    error_code: attempt.errorCode,
    replayed: attempt.replayed,
    created_at: attempt.createdAt,
  };
}

function publicState(state: ThreadsAccountPublishState): Record<string, unknown> {
  return {
    id: state.socialAccountId,
    manual_publish_permitted: state.permitted,
    open_attempt: state.openAttempt ? publicAttempt(state.openAttempt) : null,
    last_attempt: state.lastAttempt ? publicAttempt(state.lastAttempt) : null,
  };
}

function bearerToken(request: Request): string {
  const match = /^Bearer\s+(.+)$/iu.exec(request.headers.get("Authorization")?.trim() ?? "");
  const token = match?.[1]?.trim();
  if (!token) throw new ThreadsPublishHttpFailure("AUTH_REQUIRED", 401);
  return token;
}

async function readBodyText(request: Request): Promise<string> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;.*)?$/iu.test(contentType.trim())) throw invalid();
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d{1,9}$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw invalid();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ThreadsPublishHttpFailure) throw error;
    throw invalid();
  }
  if (total === 0) throw invalid();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
}

/** The request handler, independent of the static gate (tests call it directly; the entry checks the gate). */
export async function handleThreadsPublish(request: Request, deps: ThreadsPublishHandlerDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "POST") return respond({ success: false, error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const token = bearerToken(request);
    const user = await deps.getUser(token);
    if (!user || !user.id) throw new ThreadsPublishHttpFailure("AUTH_REQUIRED", 401);
    const caller: VerifiedCaller = { userId: user.id, bearerToken: token };
    const input = parseThreadsPublishRequest(await readBodyText(request));
    const flow: ThreadsManualPublishDeps = { store: deps.store, fetch: deps.fetch, sleep: deps.sleep, now: deps.now };
    switch (input.action) {
      case "publish":
        return respond({ success: true, attempt: publicAttempt(await publishThreadsTextNow(flow, caller, input)) }, 200);
      case "resume":
        return respond({ success: true, attempt: publicAttempt(await resumeThreadsAttempt(flow, caller, input.attemptId)) }, 200);
      case "reconcile":
        return respond({ success: true, attempt: publicAttempt(await reconcileThreadsAttempt(flow, caller, input.attemptId)) }, 200);
      case "status":
        return respond({ success: true, attempt: publicAttempt(await deps.store.read(caller, input.attemptId)) }, 200);
      case "account_state":
        return respond({ success: true, account: publicState(await deps.store.accountState(caller, input.socialAccountId)) }, 200);
      case "set_permission": {
        const result = await deps.store.setPermission(caller, {
          socialAccountId: input.socialAccountId,
          desired: input.desiredEnabled,
          expected: input.expectedCurrentEnabled,
        });
        if (result.status === "stale") return respond({ success: false, error: "STALE_STEP", current_permitted: result.permitted }, 409);
        if (result.permitted !== input.desiredEnabled) throw new ThreadsStoreError("STORE_UNAVAILABLE");
        return respond({ success: true, status: result.status, account: { id: input.socialAccountId, manual_publish_permitted: result.permitted } }, 200);
      }
    }
  } catch (error) {
    if (error instanceof ThreadsPublishHttpFailure) return respond({ success: false, error: error.code }, error.status);
    if (error instanceof ThreadsStoreError && (THREADS_STORE_REFUSALS as readonly string[]).includes(error.code)) {
      return respond({ success: false, error: error.code }, HTTP_STATUS[error.code]);
    }
    return respond({ success: false, error: "STORE_UNAVAILABLE" }, 503);
  }
}

/** The gate, checked before anything else: while it is closed nothing is read, verified or called. */
export function gatedHandler(enabled: boolean, handler: (request: Request) => Promise<Response>) {
  return (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return Promise.resolve(new Response(null, { status: 204, headers: CORS_HEADERS }));
    if (!enabled) return Promise.resolve(respond({ success: false, error: "THREADS_PUBLISH_DISABLED" }, 503));
    return handler(request);
  };
}
