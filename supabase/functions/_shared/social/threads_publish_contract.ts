// POSTONA Threads — publishing ONE text post through the official Threads API, as a pure transport.
//
// What this is: request builders and fail-closed response validators for the documented two-step text
// publish (official Meta documentation, re-read 2026-10-11):
//   1. POST https://graph.threads.net/v1.0/{threads-user-id}/threads          media_type=TEXT, text
//      -> {"id": "<container id>"}
//   2. GET  https://graph.threads.net/v1.0/{container-id}?fields=id,status,error_message
//      -> FINISHED / IN_PROGRESS / ERROR / EXPIRED / PUBLISHED
//   3. POST https://graph.threads.net/v1.0/{threads-user-id}/threads_publish  creation_id
//      -> {"id": "<media id>"}
//   4. GET  https://graph.threads.net/v1.0/{media-id}?fields=id,permalink,owner,username,timestamp
//      read-back: the post exists, belongs to this Threads user, and has a permalink
// plus a read-only listing (GET /{threads-user-id}/threads) used only to reconcile an uncertain publish.
// The network is injected; tests never reach Meta.
//
// What this is not: wired anywhere. No Edge Function deploys it, no token is read here, nothing decides
// WHO may publish (that is the server orchestration and the database: threads_manual_publish.ts).
//
// Duplicate safety, by construction:
//   * `auto_publish_text` is never sent. With it the container call itself publishes, so a lost
//     response would leave a post that may exist with no container id to check it by. With the two
//     steps, an unknown container outcome can never be a post (we never hold its id, so we never
//     publish it, and an unpublished container expires after 24 hours), and an unknown publish outcome
//     can be resolved read-only through the container status.
//   * Nothing here retries. Every write is one request with no redirect following and a 10 s bound; an
//     outcome that is not provably "nothing was written" is reported as `unknown`, never as a failure
//     that may be resent.
//   * Ids are read from the JSON source text (never via a JavaScript number) and kept as strings.
//
// Token handling: the documented contract passes `access_token` as a parameter. Writes send it in the
// form body (never in the URL); the documented GET reads carry it in the query string, so those URLs
// must never be logged. Errors carry a fixed code only: never a token, text, response body or URL.

// --- Official contract ---------------------------------------------------------------------------------

export const THREADS_PUBLISH_API = Object.freeze({ origin: "https://graph.threads.net", version: "v1.0" });

/** `threads_basic` for every endpoint, `threads_content_publish` for the two writes. */
export const THREADS_PUBLISH_SCOPES = Object.freeze(["threads_basic", "threads_content_publish"] as const);

/** Documented: text posts are limited to 500 characters; emojis count as their UTF-8 byte length. */
export const THREADS_TEXT_MAX_LENGTH = 500;
/** Documented: at most 5 links per post (more fails at container creation, THREADS_API__LINK_LIMIT_EXCEEDED). */
export const THREADS_TEXT_MAX_LINKS = 5;
/** Documented: a container not published within 24 hours expires. */
export const THREADS_CONTAINER_TTL_SECONDS = 24 * 60 * 60;
/** Documented: poll the container status at most once a minute for no more than 5 minutes (media). */
export const THREADS_CONTAINER_POLL_MAX_SECONDS = 5 * 60;

export const THREADS_PERMALINK_HOSTS = Object.freeze(["www.threads.net", "threads.net", "www.threads.com", "threads.com"]);

// --- Text --------------------------------------------------------------------------------------------------

export const THREADS_TEXT_REFUSALS = ["EMPTY", "TOO_LONG", "TOO_MANY_LINKS", "INVALID_CHARACTERS"] as const;
export type ThreadsTextRefusal = (typeof THREADS_TEXT_REFUSALS)[number];

export type ThreadsTextCheck = Readonly<{ ok: boolean; refusal: ThreadsTextRefusal | null; length: number; links: number }>;

// Emoji code points (pictographs, modifiers, regional indicators) and the joiners / selectors / keycap
// mark that build emoji sequences. Each counts as its UTF-8 byte length, as documented; every other code
// point counts as one character. How Meta counts other scripts is not documented (see the design doc,
// "要検証"); counting each code point as one is the documented reading for non-emoji text.
const EMOJI_PART = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[\u{E0020}-\u{E007F}])$/u;
const encoder = new TextEncoder();

/** The documented length: one per code point, except emoji parts, which count their UTF-8 bytes. */
export function threadsTextLength(text: string): number {
  let length = 0;
  for (const codePoint of text) length += EMOJI_PART.test(codePoint) ? encoder.encode(codePoint).length : 1;
  return length;
}

/** Distinct http(s) URLs in the text. Conservative: anything that starts like a URL counts. */
export function threadsTextLinks(text: string): number {
  return new Set(text.match(/https?:\/\/[^\s]+/giu) ?? []).size;
}

/**
 * Text the server will send, checked BEFORE any provider call. Line feeds and tabs are allowed; carriage
 * returns, other control characters and unpaired surrogates are refused (the app normalizes CRLF to LF
 * before sending, so the text that is stored, sent and compared is one exact string).
 */
export function checkThreadsText(text: unknown): ThreadsTextCheck {
  if (typeof text !== "string") return { ok: false, refusal: "EMPTY", length: 0, links: 0 };
  const length = threadsTextLength(text);
  const links = threadsTextLinks(text);
  const refuse = (refusal: ThreadsTextRefusal): ThreadsTextCheck => ({ ok: false, refusal, length, links });
  // deno-lint-ignore no-control-regex
  if (!text.isWellFormed() || /[\u0000-\u0008\u000B-\u001F\u007F]/u.test(text)) return refuse("INVALID_CHARACTERS");
  if (text.trim() === "") return refuse("EMPTY");
  if (length > THREADS_TEXT_MAX_LENGTH) return refuse("TOO_LONG");
  if (links > THREADS_TEXT_MAX_LINKS) return refuse("TOO_MANY_LINKS");
  return { ok: true, refusal: null, length, links };
}

// --- Errors ------------------------------------------------------------------------------------------------

export const THREADS_PUBLISH_ERROR_CODES = [
  "THREADS_REQUEST_INVALID", // our own input was refused before any request (text, ids, token shape)
  "THREADS_TOKEN_INVALID", // Graph error 190: the token is expired or revoked; reconnect
  "THREADS_PERMISSION_MISSING", // Graph errors 10, 200-299: threads_content_publish not granted
  "THREADS_RATE_LIMITED", // HTTP 429, Graph errors 4, 17, 32, 613
  "THREADS_REQUEST_REJECTED", // any other 4xx with a definite refusal
  "THREADS_UNAVAILABLE", // no response, timeout, 5xx, transient Graph errors 1 / 2
  "THREADS_RESPONSE_MALFORMED", // a 2xx we cannot read
  "THREADS_IDENTITY_MISMATCH", // read-back shows another id or another owner
] as const;
export type ThreadsPublishErrorCode = (typeof THREADS_PUBLISH_ERROR_CODES)[number];

/**
 * `not_written`: the provider provably did not perform this write (or it was a read).
 * `unknown`: it may have; the caller records the step as uncertain and never repeats it.
 */
export type ThreadsWriteOutcome = "not_written" | "unknown";

/** Carries a fixed code and the write outcome only. */
export class ThreadsPublishError extends Error {
  constructor(readonly code: ThreadsPublishErrorCode, readonly outcome: ThreadsWriteOutcome) {
    super(code);
    this.name = "ThreadsPublishError";
  }
}

// --- Input shapes --------------------------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A Threads user, container or media id: digits only, kept as text. */
export function isThreadsNumericId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,31}$/.test(value);
}

function isAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 4096 && /^[A-Za-z0-9._|-]+$/.test(value);
}

export type ThreadsCredential = Readonly<{ threadsUserId: string; accessToken: string }>;

function checkCredential(credential: ThreadsCredential): void {
  if (!isThreadsNumericId(credential.threadsUserId) || !isAccessToken(credential.accessToken)) {
    throw new ThreadsPublishError("THREADS_REQUEST_INVALID", "not_written");
  }
}

function apiUrl(path: string): URL {
  return new URL(`${THREADS_PUBLISH_API.origin}/${THREADS_PUBLISH_API.version}/${path}`);
}

// --- Step 1: create the text container -------------------------------------------------------------------

/** The exact request the container step sends. Exposed so tests can pin it; the token is in the body. */
export function buildThreadsTextContainerRequest(credential: ThreadsCredential, text: string):
  Readonly<{ url: string; init: RequestInit }> {
  checkCredential(credential);
  if (!checkThreadsText(text).ok) throw new ThreadsPublishError("THREADS_REQUEST_INVALID", "not_written");
  const body = new URLSearchParams({ media_type: "TEXT", text, access_token: credential.accessToken });
  return {
    url: apiUrl(`${credential.threadsUserId}/threads`).href,
    init: { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
  };
}

/** Creates the container. A container is never a post; `unknown` here means "maybe a container". */
export async function createThreadsTextContainer(fetchImpl: FetchLike, credential: ThreadsCredential, text: string):
  Promise<Readonly<{ containerId: string }>> {
  const { url, init } = buildThreadsTextContainerRequest(credential, text);
  const json = await requestJson(fetchImpl, url, init, "write");
  return { containerId: readId(json.id, "unknown") };
}

// --- Step 2: container status --------------------------------------------------------------------------

export const THREADS_CONTAINER_STATUSES = ["in_progress", "finished", "error", "expired", "published"] as const;
export type ThreadsContainerStatus = (typeof THREADS_CONTAINER_STATUSES)[number];

const PROVIDER_STATUS: Readonly<Record<string, ThreadsContainerStatus>> = Object.freeze({
  IN_PROGRESS: "in_progress",
  FINISHED: "finished",
  ERROR: "error",
  EXPIRED: "expired",
  PUBLISHED: "published",
});

/** Read-only. `errorMessage` is the documented enum value (e.g. UNKNOWN), never free text. */
export async function readThreadsContainerStatus(fetchImpl: FetchLike, credential: ThreadsCredential, containerId: string):
  Promise<Readonly<{ status: ThreadsContainerStatus; errorMessage: string | null }>> {
  checkCredential(credential);
  if (!isThreadsNumericId(containerId)) throw new ThreadsPublishError("THREADS_REQUEST_INVALID", "not_written");
  const url = apiUrl(containerId);
  url.searchParams.set("fields", "id,status,error_message");
  url.searchParams.set("access_token", credential.accessToken);
  const json = await requestJson(fetchImpl, url.href, { method: "GET" }, "read");
  if (readId(json.id, "not_written") !== containerId) throw new ThreadsPublishError("THREADS_IDENTITY_MISMATCH", "not_written");
  const status = typeof json.status === "string" && Object.hasOwn(PROVIDER_STATUS, json.status) ? PROVIDER_STATUS[json.status] : null;
  if (status === null) throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", "not_written");
  const message = json.error_message;
  const errorMessage = typeof message === "string" && /^[A-Z_]{1,64}$/.test(message) ? message : message == null ? null : "UNKNOWN";
  return { status, errorMessage };
}

// --- Step 3: publish the container ---------------------------------------------------------------------

export function buildThreadsPublishRequest(credential: ThreadsCredential, containerId: string):
  Readonly<{ url: string; init: RequestInit }> {
  checkCredential(credential);
  if (!isThreadsNumericId(containerId)) throw new ThreadsPublishError("THREADS_REQUEST_INVALID", "not_written");
  const body = new URLSearchParams({ creation_id: containerId, access_token: credential.accessToken });
  return {
    url: apiUrl(`${credential.threadsUserId}/threads_publish`).href,
    init: { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
  };
}

/** Publishes. The returned id is what the provider SAID; it is confirmed only by the read-back. */
export async function publishThreadsContainer(fetchImpl: FetchLike, credential: ThreadsCredential, containerId: string):
  Promise<Readonly<{ mediaId: string }>> {
  const { url, init } = buildThreadsPublishRequest(credential, containerId);
  const json = await requestJson(fetchImpl, url, init, "write");
  return { mediaId: readId(json.id, "unknown") };
}

// --- Step 4: read-back -------------------------------------------------------------------------------

export type ThreadsPublishedPost = Readonly<{ mediaId: string; permalink: string; timestamp: string | null; username: string | null }>;

export function isThreadsPermalink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && THREADS_PERMALINK_HOSTS.includes(url.hostname) && url.username === ""
    && url.password === "" && url.port === "" && url.href === value;
}

/**
 * Confirms a published post: same id, owned by this Threads user (when the owner is returned), and a
 * Threads permalink. Anything else is not a confirmation.
 */
export async function readThreadsPublishedPost(fetchImpl: FetchLike, credential: ThreadsCredential, mediaId: string):
  Promise<ThreadsPublishedPost> {
  checkCredential(credential);
  if (!isThreadsNumericId(mediaId)) throw new ThreadsPublishError("THREADS_REQUEST_INVALID", "not_written");
  const url = apiUrl(mediaId);
  url.searchParams.set("fields", "id,permalink,owner,username,timestamp");
  url.searchParams.set("access_token", credential.accessToken);
  const json = await requestJson(fetchImpl, url.href, { method: "GET" }, "read");
  if (readId(json.id, "not_written") !== mediaId) throw new ThreadsPublishError("THREADS_IDENTITY_MISMATCH", "not_written");
  const owner = json.owner;
  if (owner !== undefined) {
    if (owner === null || typeof owner !== "object" || Array.isArray(owner)) throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", "not_written");
    if (readId((owner as Record<string, unknown>).id, "not_written") !== credential.threadsUserId) {
      throw new ThreadsPublishError("THREADS_IDENTITY_MISMATCH", "not_written");
    }
  }
  if (!isThreadsPermalink(json.permalink)) throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", "not_written");
  return {
    mediaId,
    permalink: json.permalink,
    timestamp: typeof json.timestamp === "string" && json.timestamp.length <= 40 ? json.timestamp : null,
    username: typeof json.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(json.username) ? json.username : null,
  };
}

// --- Reconciliation (read-only) ----------------------------------------------------------------------------

export type ThreadsRecentPost = Readonly<{ mediaId: string; text: string | null; permalink: string | null; timestamp: string | null }>;

/**
 * The account's most recent posts since `sinceUnixSeconds` (newest first per the provider), used only
 * to find the id of a post whose container is PUBLISHED but whose publish response was lost.
 */
export async function listRecentThreadsPosts(fetchImpl: FetchLike, credential: ThreadsCredential, sinceUnixSeconds: number):
  Promise<readonly ThreadsRecentPost[]> {
  checkCredential(credential);
  if (!Number.isSafeInteger(sinceUnixSeconds) || sinceUnixSeconds <= 0) throw new ThreadsPublishError("THREADS_REQUEST_INVALID", "not_written");
  const url = apiUrl(`${credential.threadsUserId}/threads`);
  url.searchParams.set("fields", "id,text,permalink,timestamp");
  url.searchParams.set("since", String(sinceUnixSeconds));
  url.searchParams.set("limit", "25");
  url.searchParams.set("access_token", credential.accessToken);
  const json = await requestJson(fetchImpl, url.href, { method: "GET" }, "read");
  if (!Array.isArray(json.data) || json.data.length > 100) throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", "not_written");
  return json.data.map((item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", "not_written");
    const row = item as Record<string, unknown>;
    return {
      mediaId: readId(row.id, "not_written"),
      text: typeof row.text === "string" ? row.text : null,
      permalink: isThreadsPermalink(row.permalink) ? row.permalink : null,
      timestamp: typeof row.timestamp === "string" && row.timestamp.length <= 40 ? row.timestamp : null,
    };
  });
}

// --- Internals -----------------------------------------------------------------------------------------------

/** A JSON number, kept as its exact source text (never converted to a JavaScript number). */
class JsonNumber {
  constructor(readonly source: string) {}
}

const TOKEN_ERRORS = new Set(["190"]);
const PERMISSION_ERRORS = new Set(["10"]);
const RATE_LIMIT_ERRORS = new Set(["4", "17", "32", "613"]);
const TRANSIENT_ERRORS = new Set(["1", "2"]);

/** The Graph error code of a 4xx body, if it has one. Nothing else of the body is kept. */
function graphErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" ? new JsonNumber(context?.source ?? "") : value);
    const code = parsed?.error?.code;
    const digits = code instanceof JsonNumber ? code.source : typeof code === "string" ? code : null;
    return digits !== null && /^[0-9]{1,6}$/.test(digits) ? digits : null;
  } catch {
    return null;
  }
}

function classifyRefusal(status: number, text: string, kind: "write" | "read"): ThreadsPublishError {
  const code = graphErrorCode(text);
  // A transient Graph error is not a definite refusal: for a write, the outcome stays unknown.
  if (code !== null && TRANSIENT_ERRORS.has(code)) return new ThreadsPublishError("THREADS_UNAVAILABLE", kind === "write" ? "unknown" : "not_written");
  if (code !== null && TOKEN_ERRORS.has(code)) return new ThreadsPublishError("THREADS_TOKEN_INVALID", "not_written");
  if (code !== null && (PERMISSION_ERRORS.has(code) || (Number(code) >= 200 && Number(code) <= 299))) {
    return new ThreadsPublishError("THREADS_PERMISSION_MISSING", "not_written");
  }
  if (status === 429 || (code !== null && RATE_LIMIT_ERRORS.has(code))) return new ThreadsPublishError("THREADS_RATE_LIMITED", "not_written");
  return new ThreadsPublishError("THREADS_REQUEST_REJECTED", "not_written");
}

/**
 * One request, no retry, no redirect following, 10 s at most. A 4xx is a definite refusal (classified
 * by its Graph error code). For a write, anything without a definite answer (no response, timeout, 5xx,
 * a transient Graph error, a 2xx we cannot read) is `unknown`: the write may have happened.
 */
async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit, kind: "write" | "read"):
  Promise<Record<string, unknown>> {
  const uncertain = kind === "write" ? "unknown" : "not_written";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  let text: string;
  try {
    try {
      response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
    } catch {
      throw new ThreadsPublishError("THREADS_UNAVAILABLE", uncertain);
    }
    try {
      text = await response.text();
    } catch {
      throw new ThreadsPublishError(response.status >= 400 && response.status < 500 ? "THREADS_REQUEST_REJECTED" : "THREADS_UNAVAILABLE",
        response.status >= 400 && response.status < 500 ? "not_written" : uncertain);
    }
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 400 && response.status < 500) throw classifyRefusal(response.status, text, kind);
  if (response.status < 200 || response.status > 299) throw new ThreadsPublishError("THREADS_UNAVAILABLE", uncertain);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" ? new JsonNumber(context?.source ?? "") : value);
  } catch {
    throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", uncertain);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || parsed instanceof JsonNumber) {
    throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", uncertain);
  }
  return parsed as Record<string, unknown>;
}

/** An id as digits: a JSON string of digits or a JSON number (its exact source text). */
function readId(value: unknown, outcome: ThreadsWriteOutcome): string {
  const digits = value instanceof JsonNumber ? value.source : value;
  if (!isThreadsNumericId(digits)) throw new ThreadsPublishError("THREADS_RESPONSE_MALFORMED", outcome);
  return digits;
}
