// HTTP layer for social-mobile-threads-publish. SOURCE CANDIDATE (hard-disabled).
//
// Outgoing calls, and with which credential:
//  - Auth:   GET  /auth/v1/user                                     caller's token (is it valid)
//  - RPC:    begin / read / set permission / account state           CALLER'S token: auth.uid() is the caller
//  - RPC:    release / record                                        CALLER'S token + this server's attestation
//            (HMAC-SHA256 with THREADS_PUBLISH_ATTESTATION_KEY, the same secret the database holds in Vault as
//            postona_threads_publish_attestation_v1; single-use nonce, 60 s): the database decides everything
//            for the caller and hands the credential only to a request this server attested
//  - Threads: through _shared/social/threads_publish_contract.ts only
// No service-role key: this function has no privileged database path at all. It never decodes a JWT
// (the database takes the user and session from the verified claims). No table is read or written
// directly. No token, text, key or provider body is logged or returned.

import {
  THREADS_ATTEMPT_STATUSES,
  THREADS_STORE_REFUSALS,
  type ThreadsAccountPublishState,
  type ThreadsAttempt,
  type ThreadsClaimStep,
  type ThreadsPublishPermissionStore,
  type ThreadsPublishStore,
  type ThreadsReleasedStep,
  type ThreadsStepResult,
  ThreadsStoreError,
  type ThreadsStoreRefusal,
  type VerifiedCaller,
} from "../_shared/social/threads_manual_publish.ts";
import type { FetchLike } from "../_shared/social/threads_publish_contract.ts";
import { gatedHandler, handleThreadsPublish, THREADS_MANUAL_PUBLISH_PREREQUISITES_MET } from "./logic.ts";

export const THREADS_PUBLISH_RPC = Object.freeze({
  begin: "begin_threads_manual_publish",
  read: "get_threads_manual_publish_attempt",
  release: "release_threads_manual_publish_step",
  record: "record_threads_manual_publish_result",
  setPermission: "set_threads_manual_publish_permission",
  accountState: "get_threads_manual_publish_state",
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unavailable = () => new ThreadsStoreError("STORE_UNAVAILABLE");
const nullableString = (value: unknown, max = 512): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > max) throw unavailable();
  return value;
};

/** The SQL candidate's attempt object -> the shared type. Anything off-shape is "unavailable". */
export function parseAttempt(value: unknown, replayed = false): ThreadsAttempt {
  if (!isRecord(value)) throw unavailable();
  const status = value.status;
  if (typeof status !== "string" || !(THREADS_ATTEMPT_STATUSES as readonly string[]).includes(status)) throw unavailable();
  if (typeof value.attempt_id !== "string" || typeof value.social_account_id !== "string" || typeof value.created_at !== "string") throw unavailable();
  return {
    attemptId: value.attempt_id,
    socialAccountId: value.social_account_id,
    status: status as ThreadsAttempt["status"],
    containerId: nullableString(value.container_id, 32),
    providerPostId: nullableString(value.provider_post_id, 32),
    permalink: nullableString(value.permalink),
    errorCode: nullableString(value.error_code, 64),
    replayed,
    createdAt: value.created_at,
  };
}

/** `{"status":"refused","code":...}` -> the fixed refusal; any other unknown code is "unavailable". */
function refusal(body: Record<string, unknown>): ThreadsStoreError | null {
  if (body.status !== "refused") return null;
  return typeof body.code === "string" && (THREADS_STORE_REFUSALS as readonly string[]).includes(body.code)
    ? new ThreadsStoreError(body.code as ThreadsStoreRefusal)
    : unavailable();
}

export type StoreConfig = Readonly<{ supabaseUrl: string; anonKey: string; attestationKey: string }>;

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The attestation key must be a long random secret; anything shorter is refused at startup. */
export function isAcceptableAttestationKey(key: string): boolean {
  return key.length >= 32 && key.length <= 512 && !/\s/.test(key);
}

/** Exactly the database's message (threads_publish_release_candidate.sql), signed with the shared key. */
export async function attest(key: string, parts: readonly string[]): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(parts.join("\n"))));
}

/** 32 random bytes as hex: single use, the database refuses a repeat. */
export function newNonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export function createStore(
  config: StoreConfig,
  fetchImpl: FetchLike = fetch,
  clock: Readonly<{ nowSeconds: () => number; nonce: () => string }> = { nowSeconds: () => Math.floor(Date.now() / 1000), nonce: newNonce },
): ThreadsPublishStore & ThreadsPublishPermissionStore {
  const call = async (rpc: string, bearer: string, apikey: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${rpc}`, {
        method: "POST",
        redirect: "manual",
        headers: { apikey, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(args),
      });
    } catch {
      throw unavailable();
    }
    if (response.status === 401) throw new ThreadsStoreError("AUTH_REQUIRED");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw unavailable();
    }
    if (!response.ok || !isRecord(body)) throw unavailable();
    const refused = refusal(body);
    if (refused) throw refused;
    return body;
  };
  const asCaller = (caller: VerifiedCaller, rpc: string, args: Record<string, unknown>) => call(rpc, caller.bearerToken, config.anonKey, args);
  /** The caller's own request, plus this server's attestation over exactly these values. */
  const attested = async (caller: VerifiedCaller, rpc: string, prefix: string, parts: readonly string[], args: Record<string, unknown>) => {
    const issuedAt = clock.nowSeconds();
    const nonce = clock.nonce();
    const attestation = await attest(config.attestationKey, [prefix, caller.userId, ...parts, String(issuedAt), nonce]);
    return await asCaller(caller, rpc, { ...args, p_issued_at: issuedAt, p_nonce: nonce, p_attestation: attestation });
  };

  return {
    async begin(caller, input) {
      const body = await asCaller(caller, THREADS_PUBLISH_RPC.begin, {
        p_social_account_id: input.socialAccountId,
        p_idempotency_key: input.idempotencyKey,
        p_text: input.text,
      });
      if (body.status !== "reserved" && body.status !== "replayed") throw unavailable();
      return parseAttempt(body.attempt, body.status === "replayed");
    },
    async read(caller, attemptId) {
      const body = await asCaller(caller, THREADS_PUBLISH_RPC.read, { p_attempt_id: attemptId });
      if (body.status !== "ok") throw unavailable();
      return parseAttempt(body.attempt);
    },
    async release(caller, input): Promise<ThreadsReleasedStep> {
      const body = await attested(caller, THREADS_PUBLISH_RPC.release, "postona-threads-publish-release-v1", [input.attemptId, input.step], {
        p_attempt_id: input.attemptId,
        p_step: input.step,
      });
      if (body.status !== "released" || typeof body.grant !== "string" || !/^[0-9a-f]{64}$/.test(body.grant)
        || typeof body.threads_user_id !== "string" || typeof body.access_token !== "string" || typeof body.attempt_created_at !== "string") {
        throw unavailable();
      }
      return {
        grant: body.grant,
        credential: { threadsUserId: body.threads_user_id, accessToken: body.access_token },
        text: nullableString(body.text, 8192),
        containerId: nullableString(body.container_id, 32),
        providerPostId: nullableString(body.provider_post_id, 32),
        attemptCreatedAt: body.attempt_created_at,
      };
    },
    async record(caller: VerifiedCaller, input: Readonly<{ attemptId: string; step: ThreadsClaimStep; grant: string; result: ThreadsStepResult }>) {
      const r = input.result;
      const containerId = r.to === "container_created" ? r.containerId : null;
      const providerPostId = r.to === "publish_returned" || r.to === "published" ? r.providerPostId : null;
      const permalink = r.to === "published" ? r.permalink : null;
      const errorCode = "errorCode" in r ? r.errorCode : null;
      const body = await attested(
        caller,
        THREADS_PUBLISH_RPC.record,
        "postona-threads-publish-record-v1",
        [input.attemptId, input.step, input.grant, r.to, containerId ?? "", providerPostId ?? "", permalink ?? "", errorCode ?? ""],
        {
          p_attempt_id: input.attemptId,
          p_step: input.step,
          p_grant: input.grant,
          p_to_status: r.to,
          p_container_id: containerId,
          p_provider_post_id: providerPostId,
          p_permalink: permalink,
          p_error_code: errorCode,
        },
      );
      if (body.status !== "recorded") throw unavailable();
      return parseAttempt(body.attempt);
    },
    async setPermission(caller, input) {
      const body = await asCaller(caller, THREADS_PUBLISH_RPC.setPermission, {
        p_social_account_id: input.socialAccountId,
        p_desired: input.desired,
        p_expected: input.expected,
      });
      if ((body.status !== "updated" && body.status !== "unchanged" && body.status !== "stale") || typeof body.permitted !== "boolean") throw unavailable();
      return { status: body.status, permitted: body.permitted };
    },
    async accountState(caller, socialAccountId): Promise<ThreadsAccountPublishState> {
      const body = await asCaller(caller, THREADS_PUBLISH_RPC.accountState, { p_social_account_id: socialAccountId });
      if (body.status !== "ok" || typeof body.permitted !== "boolean") throw unavailable();
      return {
        socialAccountId,
        permitted: body.permitted,
        openAttempt: body.open_attempt === null ? null : parseAttempt(body.open_attempt),
        lastAttempt: body.last_attempt === null ? null : parseAttempt(body.last_attempt),
      };
    },
  };
}

export function createGetUser(config: Readonly<{ supabaseUrl: string; anonKey: string }>, fetchImpl: FetchLike = fetch) {
  return async (token: string): Promise<{ id: string } | null> => {
    let response: Response;
    try {
      response = await fetchImpl(`${config.supabaseUrl}/auth/v1/user`, {
        method: "GET",
        redirect: "manual",
        headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` },
      });
    } catch {
      throw unavailable();
    }
    if (response.status >= 500) throw unavailable();
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || !isRecord(body) || typeof body.id !== "string" || !body.id) return null;
    return { id: body.id };
  };
}

/** The deployable entry. Closed while the static gate is false, whatever the environment says. */
export function createHandler(env: { get: (name: string) => string | undefined }, fetchImpl: FetchLike = fetch) {
  return gatedHandler(THREADS_MANUAL_PUBLISH_PREREQUISITES_MET, (request) => {
    const supabaseUrl = (env.get("SUPABASE_URL") ?? "").replace(/\/$/u, "");
    const anonKey = env.get("SUPABASE_ANON_KEY") ?? "";
    const attestationKey = env.get("THREADS_PUBLISH_ATTESTATION_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !isAcceptableAttestationKey(attestationKey)) {
      return Promise.resolve(Response.json({ success: false, error: "STORE_UNAVAILABLE" }, { status: 503 }));
    }
    return handleThreadsPublish(request, {
      getUser: createGetUser({ supabaseUrl, anonKey }, fetchImpl),
      store: createStore({ supabaseUrl, anonKey, attestationKey }, fetchImpl),
      fetch: fetchImpl,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
    });
  });
}
