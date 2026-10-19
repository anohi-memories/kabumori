// Threads app: Meta's deauthorize callback and data deletion request callback, and the deletion status lookup the
// data deletion answer points to. SOURCE CANDIDATE (G4, Issue #319): hard-disabled by THREADS_META_CALLBACKS_ENABLED,
// NOT deployed, no durable store exists yet (the store is a port; the SQL behind it is a later, separately approved
// task that needs G5's T10 owner for the deletion itself).
//
// Request format. VERIFIED from Meta's generic "Data Deletion Callback" page (app dashboard docs, read 2026-10-19):
// POST with one `signed_request` = <base64url HMAC-SHA256 of the encoded payload, keyed by the app secret>.<base64url
// JSON payload>, payload { algorithm: "HMAC-SHA256", issued_at, user_id, ... }; the data deletion answer is JSON
// { url, confirmation_code } and the callback must start the deletion. NOT VERIFIED for Threads: the Threads "create an
// app" page only names the two URLs (Deauthorize callback URL, Data Deletion Requests URL) and says Meta "pings" them;
// it gives no format and does not say which user id is sent. ASSUMED: the same signed_request, form-encoded, user_id =
// the Threads user id kept as social_accounts.platform_user_id (unique per platform). A real Meta call against a
// non-production app must confirm this before the gate can be lifted.
//
// What the handler guarantees (supabase/tests/postona_threads_meta_callback_contract_test.ts, M1-M7):
//  - nothing is recorded unless the signature verifies with the app secret (constant-time WebCrypto verify), the
//    algorithm is exactly HMAC-SHA256 and user_id / issued_at are well formed;
//  - deauthorize stops exactly the account bound to that Threads user (the store's job: publishing off, reconnect
//    needed); unknown people get the same answer;
//  - data deletion answers { url, confirmation_code } ONLY after the store durably recorded the request; the store owns
//    the code (one code per request, the same code again on a repeat); a store failure or timeout is 503, never a code;
//  - the status lookup reports only what the store says; it never says "completed" by itself;
//  - no outbound call (Threads has no app-side revoke), nothing logged, no request data or secret in any answer.
// Replays: both effects are idempotent, so a replayed signed request changes nothing new; issued_at far in the future
// is refused as a forgery signal. Nothing else about freshness is documented, so nothing else is assumed.

export const THREADS_META_CALLBACKS_ENABLED = false;

export type ThreadsMetaCallbackKind = "deauthorize" | "data_deletion";
export type ThreadsDeletionStatus = "received" | "in_progress" | "completed";

/** The durable store (a port; no implementation exists yet). Every method may throw: the handler answers 503. */
export type ThreadsMetaCallbackStore = {
  /** The Threads account bound to this Threads user id, or null (UNIQUE (platform, platform_user_id)). */
  accountByProviderUser(providerUserId: string): Promise<string | null>;
  /** Publishing stops for this account and it needs the person to reconnect; idempotent. */
  markDeauthorized(socialAccountId: string): Promise<void>;
  /** Records the deletion request durably (idempotent per account / unknown person) and returns its code. */
  requestDeletion(socialAccountId: string | null, providerUserId: string): Promise<string>;
};
export type ThreadsDeletionStatusStore = {
  /** The recorded state for this code, or null when there is none. */
  deletionStatus(confirmationCode: string): Promise<ThreadsDeletionStatus | null>;
};

export type ThreadsMetaCallbackDeps = {
  appSecret: string;
  store: ThreadsMetaCallbackStore;
  /** https URL of the deletion status page; the code is added as `?code=`. */
  statusBaseUrl: string;
  now?: () => number;
  storeTimeoutMs?: number;
};

const HEADERS = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 8 * 1024;
const MAX_FUTURE_SKEW_SECONDS = 600;
const USER_ID = /^[1-9][0-9]{0,19}$/u;
const CONFIRMATION_CODE = /^[A-Za-z0-9]{8,64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const enc = new TextEncoder();

export type ThreadsMetaCallbackError =
  | "METHOD_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_SIGNED_REQUEST"
  | "INVALID_CODE"
  | "CONFIG_UNAVAILABLE"
  | "STORE_UNAVAILABLE"
  | "THREADS_META_CALLBACKS_DISABLED";
const STATUS: Record<ThreadsMetaCallbackError, number> = {
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_SIGNED_REQUEST: 400,
  INVALID_CODE: 400,
  CONFIG_UNAVAILABLE: 503,
  STORE_UNAVAILABLE: 503,
  THREADS_META_CALLBACKS_DISABLED: 503,
};
/** Only the fixed code; never the request, the user id, the secret or a store error. */
export function failure(error: ThreadsMetaCallbackError): Response {
  return Response.json({ ok: false, error }, { status: STATUS[error], headers: HEADERS });
}

/** Same rule as the Threads connect settings check for THREADS_APP_SECRET. */
export function acceptableAppSecret(secret: string): boolean {
  return secret.length >= 16 && secret.length <= 256 && !/\s/u.test(secret);
}
function acceptableStatusBaseUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text)) return null;
  try {
    const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

export type VerifiedSignedRequest = { userId: string; issuedAt: number };

/** The signed request's Threads user id, or null when anything about it is off. Pure; no store, no network. */
export async function verifySignedRequest(
  signed: string,
  appSecret: string,
  nowSeconds: number,
): Promise<VerifiedSignedRequest | null> {
  const parts = signed.split(".");
  if (parts.length !== 2) return null;
  const [encodedSignature, encodedPayload] = parts;
  const signature = decodeBase64url(encodedSignature);
  const payloadBytes = decodeBase64url(encodedPayload);
  if (!signature || signature.byteLength !== 32 || !payloadBytes) return null;
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  if (!await crypto.subtle.verify("HMAC", key, signature, enc.encode(encodedPayload))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const { algorithm, user_id: userId, issued_at: issuedAt } = payload as Record<string, unknown>;
  if (algorithm !== "HMAC-SHA256") return null;
  if (typeof userId !== "string" || !USER_ID.test(userId)) return null;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  if (issuedAt > nowSeconds + MAX_FUTURE_SKEW_SECONDS) return null;
  return { userId, issuedAt };
}

class StoreTimeout extends Error {}
function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The two Meta callbacks. Matches CallbackHandler in the contract test. */
export function createThreadsMetaCallbackHandler(deps: ThreadsMetaCallbackDeps) {
  const statusBase = acceptableStatusBaseUrl(deps.statusBaseUrl);
  const configured = acceptableAppSecret(deps.appSecret) && statusBase !== null;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = deps.storeTimeoutMs ?? 5_000;
  return async (kind: ThreadsMetaCallbackKind, request: Request): Promise<Response> => {
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED");
    if (!configured) return failure("CONFIG_UNAVAILABLE");
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded") return failure("UNSUPPORTED_MEDIA_TYPE");
    const body = await readBody(request);
    if (body === null) return failure("PAYLOAD_TOO_LARGE");
    const values = new URLSearchParams(body).getAll("signed_request");
    if (values.length !== 1) return failure("INVALID_SIGNED_REQUEST");
    const verified = await verifySignedRequest(values[0], deps.appSecret, now());
    if (!verified) return failure("INVALID_SIGNED_REQUEST");
    try {
      return await withTimeout(async () => {
        const account = await deps.store.accountByProviderUser(verified.userId);
        if (kind === "deauthorize") {
          if (account !== null) await deps.store.markDeauthorized(account);
          return new Response(null, { status: 204, headers: HEADERS });
        }
        const code = await deps.store.requestDeletion(account, verified.userId);
        if (typeof code !== "string" || !CONFIRMATION_CODE.test(code)) return failure("STORE_UNAVAILABLE");
        const url = new URL(statusBase!);
        url.searchParams.set("code", code);
        return Response.json({ url: url.toString(), confirmation_code: code }, { headers: HEADERS });
      }, timeoutMs);
    } catch {
      return failure("STORE_UNAVAILABLE");
    }
  };
}

/** The status page behind the data deletion answer's url: what the store recorded, nothing more. */
export function createThreadsDeletionStatusHandler(
  deps: { store: ThreadsDeletionStatusStore; storeTimeoutMs?: number },
) {
  const timeoutMs = deps.storeTimeoutMs ?? 5_000;
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return failure("METHOD_NOT_ALLOWED");
    const codes = new URL(request.url).searchParams.getAll("code");
    if (codes.length !== 1 || !CONFIRMATION_CODE.test(codes[0])) return failure("INVALID_CODE");
    const code = codes[0];
    let state: ThreadsDeletionStatus | null;
    try {
      state = await withTimeout(() => deps.store.deletionStatus(code), timeoutMs);
    } catch {
      return failure("STORE_UNAVAILABLE");
    }
    if (state !== null && state !== "received" && state !== "in_progress" && state !== "completed") {
      return failure("STORE_UNAVAILABLE");
    }
    return Response.json({ confirmation_code: code, status: state ?? "unknown" }, { headers: HEADERS });
  };
}
