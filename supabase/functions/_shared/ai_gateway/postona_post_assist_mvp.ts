// G6-21 (2026-10-28): the POSTONA personal MVP post assist (G6-20 postona_post_assist.ts) composed with G5-47's R1-MVP
// verdict, as ONE versioned G6 adapter. Nothing in the reviewed core changes (authority_port.ts, gateway.ts, runtime.ts,
// the ledger guard and the SQL stay as they are).
//
// G5-47 (Issue #320, PR #550 head 4c97140a, docs/common-account/g5-47-postona-mvp-r1-personal-token.md): the same RPC,
// arguments, 8-key wire, reasons and recheck as R1 v1; in the personal-MVP profile a workspace-scoped allow carries
// owner_epoch = "g5pv:<lifecycle_version>" (a per-person generation token, +1 on every account / entitlement change,
// never reused) instead of "g5oe:<owner epoch>:<lifecycle_version>". New reasons: OWN_WORKSPACE_CONFLICT (deny),
// SERVICE_GENERATION_UNAVAILABLE (unknown). The R1-MVP ACL for `authenticated` is NOT decided yet (owner-only as
// shipped), so a real call answers 401 / 403 / 404 today and nothing is sent (BLOCKED_G5_AUTH_EXECUTE).
//
// The profile is PINNED (G5's recommendation): this adapter accepts only g5pv tokens. A g5oe token, a malformed g5pv
// or any other value in an allow becomes an invalid token, which the unchanged strict port refuses (unknown). A valid
// "g5pv:<n>" is handed to the port as "g5oe:1:<n>": the port's owner-epoch shape check and its generation (user,
// session, token, entitlements) then work unchanged, and a different n is a different generation (the send stops).
// The mapping exists only inside this adapter; the full profile (g5oe) is never accepted here.
import { buildAppPolicySet, type FeatureConfig } from "./app_policies.ts";
import { createG5AuthorityPort, type G5Transport, type VerdictScope } from "./authority_port.ts";
import { createG5RpcTransport } from "./g5_rpc_transport.ts";
import { handlePostAssistRequest, POSTONA_POST_ASSIST_CONTENT } from "./postona_post_assist.ts";
import { type AiGateway, type AiGatewayOptions, createAiGateway } from "./runtime.ts";

/** The G5 contract version this adapter is written for (Issue #320 G5-47; any change of it needs a new adapter version). */
export const G5_R1_PERSONAL_MVP_PROFILE = "g5-47-r1-personal-mvp-v1";
const G5PV = /^g5pv:([1-9][0-9]{0,18})$/u;
/** A value the port's owner-epoch check always refuses (allowed token characters, wrong shape). */
const REFUSED_TOKEN = "g6-personal-mvp-token-refused";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One G5 answer, personal-MVP profile: a valid g5pv allow is mapped for the port; every other allow token is refused. */
export function pinPersonalMvpWire(wire: unknown): unknown {
  if (!isRecord(wire) || wire.decision !== "allow" || !("owner_epoch" in wire) || wire.owner_epoch === null) return wire;
  const m = typeof wire.owner_epoch === "string" ? G5PV.exec(wire.owner_epoch) : null;
  return { ...wire, owner_epoch: m ? `g5oe:1:${m[1]}` : REFUSED_TOKEN };
}

/** The G5 transport, pinned to the personal-MVP profile (verdict and recheck alike). */
export function pinPersonalMvpProfile(inner: G5Transport): G5Transport {
  return Object.freeze({
    fetchVerdict: async (credential: unknown, scope: VerdictScope) => pinPersonalMvpWire(await inner.fetchVerdict(credential, scope)),
    fetchRecheck: async (credential: unknown, scope: VerdictScope, subject: Parameters<G5Transport["fetchRecheck"]>[2]) =>
      pinPersonalMvpWire(await inner.fetchRecheck(credential, scope, subject)),
  });
}

export class PostonaPostAssistMvpConfigError extends Error {
  constructor(reason: string) {
    super(`POSTONA_POST_ASSIST_MVP_CONFIG_INVALID:${reason}`);
  }
}

export type PostonaPostAssistMvpConfig = Readonly<{
  /** Must be G5_R1_PERSONAL_MVP_PROFILE: the caller states which G5 contract it was deployed against. */
  profile: string;
  supabaseUrl: string;
  /** The project's publishable key (the G5 RPC is called with the person's own JWT; this key grants nothing). */
  publishableKey: string;
  serviceKey: AiGatewayOptions["serviceKey"];
  readEnv: AiGatewayOptions["readEnv"];
  /** The operator's settings for postona:post_generation (OpenAI only; the x_autopost service opens it). */
  feature: FeatureConfig;
  fetch?: AiGatewayOptions["fetch"];
  holdSeconds?: number;
  rpcTimeoutMs?: number;
  /** Per G5 call (default 3 000 ms); a slower answer is unreachable (nothing claimed or sent). */
  g5TimeoutMs?: number;
  nowMs?: () => number;
  retryTiming?: AiGatewayOptions["retryTiming"];
  sleep?: AiGatewayOptions["sleep"];
  random?: AiGatewayOptions["random"];
}>;

export type PostonaPostAssistMvp = Readonly<{
  gateway: AiGateway;
  /** POST JSON {brand_id, mode, platform, notes?, draft?, instruction?} + Authorization + Idempotency-Key. */
  handle(request: Request): Promise<Response>;
}>;

/**
 * Everything an Edge Function (its owner adds CORS, the deployment and the secrets) needs to serve the person's post
 * assist: the G5 RPC transport pinned to the personal MVP, the strict port, the owner-held gateway (the runtime default)
 * and the post_generation policy. Configuration problems throw here, before any request.
 */
export function createPostonaPostAssistMvp(config: PostonaPostAssistMvpConfig): PostonaPostAssistMvp {
  if (config.profile !== G5_R1_PERSONAL_MVP_PROFILE) throw new PostonaPostAssistMvpConfigError("profile");
  if (config.feature.provider !== "openai") throw new PostonaPostAssistMvpConfigError("provider"); // personal data: OpenAI only
  if (config.feature.entitlements.length !== 1 || config.feature.entitlements[0] !== "postona:x_autopost") {
    throw new PostonaPostAssistMvpConfigError("entitlements");
  }
  const set = buildAppPolicySet({ "postona:post_generation": config.feature }, { "postona:post_generation": POSTONA_POST_ASSIST_CONTENT });
  if (!set.planAllowlist.has("postona:post_generation")) throw new PostonaPostAssistMvpConfigError("feature_disabled");
  const transport = pinPersonalMvpProfile(createG5RpcTransport({
    supabaseUrl: config.supabaseUrl,
    publishableKey: config.publishableKey,
    fetch: config.fetch,
    nowMs: config.nowMs,
  }));
  const gateway = createAiGateway({
    supabaseUrl: config.supabaseUrl,
    serviceKey: config.serviceKey,
    readEnv: config.readEnv,
    // G5 never answers for system work: a person's verdict only.
    authority: createG5AuthorityPort({ transport, planAllowlist: set.planAllowlist, nowMs: config.nowMs, timeoutMs: config.g5TimeoutMs }),
    policies: set.registry,
    fetch: config.fetch,
    holdSeconds: config.holdSeconds,
    rpcTimeoutMs: config.rpcTimeoutMs,
    nowMs: config.nowMs,
    retryTiming: config.retryTiming,
    sleep: config.sleep,
    random: config.random,
    // ledgerMode: the runtime default, owner_held (G6-20).
  });
  return Object.freeze({ gateway, handle: (request: Request) => handlePostAssistRequest(request, gateway) });
}
