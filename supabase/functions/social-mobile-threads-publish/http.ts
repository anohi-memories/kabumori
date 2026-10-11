// HTTP layer for social-mobile-threads-publish. SOURCE CANDIDATE (hard-disabled).
//
// Outgoing calls, and with which credential:
//  - Auth:   GET  /auth/v1/user                                    caller's token (is it valid)
//  - RPC:    begin / claim / read / set permission / account state  CALLER'S token: auth.uid() is the caller
//  - RPC:    redeem / record                                        service-role key, server only; bound to a
//                                                                   single-use grant a caller-authorized claim
//                                                                   issued moments before
//  - Threads: through _shared/social/threads_publish_contract.ts only
// The service-role key is used for exactly the two server-only functions and nothing else; it is never
// combined with a caller-chosen user, workspace or account as authority. No table is read or written
// directly. No token, text or provider body is logged or returned.

import {
  THREADS_ATTEMPT_STATUSES,
  THREADS_STORE_REFUSALS,
  type ThreadsAccountPublishState,
  type ThreadsAttempt,
  type ThreadsClaimStep,
  type ThreadsPublishPermissionStore,
  type ThreadsPublishStore,
  type ThreadsRedeemedStep,
  type ThreadsStepResult,
  ThreadsStoreError,
  type ThreadsStoreRefusal,
  type VerifiedCaller,
} from "../_shared/social/threads_manual_publish.ts";
import type { FetchLike } from "../_shared/social/threads_publish_contract.ts";
import { gatedHandler, handleThreadsPublish, THREADS_MANUAL_PUBLISH_PREREQUISITES_MET } from "./logic.ts";

export const THREADS_PUBLISH_RPC = Object.freeze({
  begin: "begin_threads_manual_publish",
  claim: "claim_threads_manual_publish_step",
  read: "get_threads_manual_publish_attempt",
  redeem: "redeem_threads_manual_publish_step",
  record: "record_threads_manual_publish_step",
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

export type StoreConfig = Readonly<{ supabaseUrl: string; anonKey: string; serviceRoleKey: string }>;

export function createStore(config: StoreConfig, fetchImpl: FetchLike = fetch): ThreadsPublishStore & ThreadsPublishPermissionStore {
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
  const asServer = (rpc: string, args: Record<string, unknown>) => call(rpc, config.serviceRoleKey, config.serviceRoleKey, args);

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
    async claim(caller, input) {
      const body = await asCaller(caller, THREADS_PUBLISH_RPC.claim, { p_attempt_id: input.attemptId, p_step: input.step });
      if (body.status !== "claimed" || typeof body.grant !== "string" || !/^[0-9a-f]{64}$/.test(body.grant)) throw unavailable();
      return { grant: body.grant, attempt: parseAttempt(body.attempt) };
    },
    async read(caller, attemptId) {
      const body = await asCaller(caller, THREADS_PUBLISH_RPC.read, { p_attempt_id: attemptId });
      if (body.status !== "ok") throw unavailable();
      return parseAttempt(body.attempt);
    },
    async redeem(input): Promise<ThreadsRedeemedStep> {
      const body = await asServer(THREADS_PUBLISH_RPC.redeem, { p_attempt_id: input.attemptId, p_step: input.step, p_grant: input.grant });
      if (body.status !== "redeemed" || typeof body.threads_user_id !== "string" || typeof body.access_token !== "string"
        || typeof body.attempt_created_at !== "string") {
        throw unavailable();
      }
      return {
        credential: { threadsUserId: body.threads_user_id, accessToken: body.access_token },
        text: nullableString(body.text, 8192),
        containerId: nullableString(body.container_id, 32),
        providerPostId: nullableString(body.provider_post_id, 32),
        attemptCreatedAt: body.attempt_created_at,
      };
    },
    async record(input: Readonly<{ attemptId: string; step: ThreadsClaimStep; grant: string; result: ThreadsStepResult }>) {
      const r = input.result;
      const body = await asServer(THREADS_PUBLISH_RPC.record, {
        p_attempt_id: input.attemptId,
        p_step: input.step,
        p_grant: input.grant,
        p_to_status: r.to,
        p_container_id: r.to === "container_created" ? r.containerId : null,
        p_provider_post_id: r.to === "publish_returned" || r.to === "published" ? r.providerPostId : null,
        p_permalink: r.to === "published" ? r.permalink : null,
        p_error_code: "errorCode" in r ? r.errorCode : null,
      });
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
    const serviceRoleKey = env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return Promise.resolve(Response.json({ success: false, error: "STORE_UNAVAILABLE" }, { status: 503 }));
    }
    return handleThreadsPublish(request, {
      getUser: createGetUser({ supabaseUrl, anonKey }, fetchImpl),
      store: createStore({ supabaseUrl, anonKey, serviceRoleKey }, fetchImpl),
      fetch: fetchImpl,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
    });
  });
}
