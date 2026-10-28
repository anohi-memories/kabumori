// G6-07 (2026-10-20): ONE separate OS process of the restart / concurrent-recovery harness
// (common_ai_gateway_restart_race_pg_test.ts starts it with `deno run`, and may SIGKILL it).
//   role "gateway": the real G6 runtime (createAiGateway: ledger guard + call store) with the real G5 strict authority
//     port over the real G5 RPC transport (PR345). Its only stand-ins: G5's verdict RPC (answered from the harness's
//     fake-G5 tables), the providers (fake OpenAI / Anthropic HTTP), and a system-job authority for the Kabumori job.
//     It can pause at one step and wait there (until the harness opens its gate or kills it).
//   role "recover": the G6-06 coordinator (reconcileUnknownCalls) over the real service RPCs.
// Every ledger / ai_calls RPC runs through psql AS service_role against the harness's local socket. No network.
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { anthropicBody, FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet, type FeatureConfig, type FeatureContent } from "../ai_gateway/app_policies.ts";
import { createG5AuthorityPort, type G5Transport } from "../ai_gateway/authority_port.ts";
import { createG5RpcTransport, G5_VERDICT_RPC } from "../ai_gateway/g5_rpc_transport.ts";
import { reconcileUnknownCalls } from "../ai_gateway/recovery.ts";
import { createAiGateway } from "../ai_gateway/runtime.ts";
import { PROVIDER_API_KEY_ENV, SupabaseLedgerBudgetGuard } from "../functions/_shared/ai_provider/mod.ts";
import { SupabaseAiCallsStore } from "../ai_gateway/ai_calls_store.ts";
import { type CallClaim, type CallIdentity, type CallStore, type ClaimContext, gatewayExecute, type StoredOutcome } from "../ai_gateway/gateway.ts";

const HOST = Deno.env.get("GRR_PGHOST") ?? "";
const PORT = Deno.env.get("GRR_PGPORT") ?? "";
const SUPER = Deno.env.get("GRR_PGSUPER") ?? "";
const DB = Deno.env.get("GRR_DB") ?? "";
if (!/^\/(private\/)?tmp\//.test(HOST) || !PORT || !SUPER || !DB) throw new Error("GRR environment missing");

export const SUPABASE = "http://127.0.0.1:54321";
export const SERVICE_KEY = "local-g6-07-service-NOT-A-SECRET";
export const PUBLISHABLE_KEY = "local-g6-07-publishable-NOT-A-SECRET";

export type GatewayJob = Readonly<{
  role: "gateway";
  name: string;
  revision: string;
  credential: string;
  app: "postona" | "kabumori";
  feature: string;
  operationId: string;
  brand: string | null;
  /**
   * "before:<rpc>" | "after:<rpc>" (the RPC committed) | "provider" (the provider has the request, no answer yet);
   * "<when>:<rpc>#<n>" names the n-th call of that RPC (G6-08: the second ai_calls_claim is the pre-send check);
   * "after:g5_verdict#<n>" the n-th answer of the fake G5 (G6-09: #2 is the first recheck).
   */
  pauseAt: string | readonly string[] | null;
  /**
   * G6-08: "<rpc>#<n>" -> "lost" (the RPC commits, the answer never arrives: a network error);
   * G6-10: -> "down" (the statement never reaches the database: a network error, nothing ran).
   */
  faults?: Readonly<Record<string, "lost" | "down">>;
  /** G6-08: the provider's answer per request, in order ("ok" or an HTTP status); default always "ok". */
  providerReplies?: readonly string[];
  /** G6-08: the runtime's per-RPC timeout (the fake transport honours the abort signal). */
  rpcTimeoutMs?: number;
  /** G6-08: write "start:<rpc>#<n>" / "end:<rpc>#<n>" events (with the clock) around every ledger / ai_calls RPC. */
  trace?: boolean;
  /**
   * G6-11: compose the gateway with a TEST-ONLY call store whose pre-send check asks the CANDIDATE RPC
   * ai_calls_claim_held (created by the G6-11 test in its scratch database only) with the ORIGINAL claim token,
   * instead of calling ai_calls_claim again. gateway.ts is unchanged; nothing here exists in any migration.
   */
  ownerHeld?: boolean;
  /** G6-20: the runtime's ledger mode (default here: the legacy check the older suites pin). */
  ledgerMode?: "owner_held" | "legacy_busy_check_unsafe";
}>;
export type RecoverJob = Readonly<{ role: "recover"; name: string; revision: string; apps: "all" | "postona"; mode: "advise" | "apply"; abandonAfterSeconds: number }>;

async function psql(statement: string): Promise<{ ok: boolean; out: string; err: string }> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST, "-p", PORT, "-U", SUPER, "-d", DB, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  return { ok: output.success, out: decode(output.stdout), err: decode(output.stderr) };
}
async function rows(sql: string): Promise<string> {
  const r = await psql(sql);
  if (!r.ok) throw new Error(`SQL_FAILED:${r.err.split("\n")[0]}`);
  return r.out;
}
const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;
async function serviceRpc(name: string, p: unknown): Promise<{ ok: true; answer: unknown } | { ok: false; code: string }> {
  const text = JSON.stringify(p);
  if (text.includes("$gwr$")) throw new Error("quote tag in payload");
  const r = await psql(`set role service_role; select public.${name}($gwr$${text}$gwr$::jsonb)`);
  if (!r.ok) return { ok: false, code: r.err.match(/ERROR:\s+([A-Z_]+)/)?.[1] ?? "XX000" };
  return { ok: true, answer: JSON.parse(r.out) };
}

/** Stop here until the harness opens this worker's gate (or kills the process). */
async function pause(name: string, point: string): Promise<void> {
  await rows(`insert into g6r_fake.events (worker, point) values (${literal(name)}, ${literal(point)})`);
  // G6-12: a gate opens one pause point, or ('*') every one of this worker.
  while ((await rows(`select count(*) from g6r_fake.gates where worker = ${literal(name)} and point in ('*', ${literal(point)})`)) === "0") {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };
const content = (label: string): FeatureContent => ({
  systemInstructions: `Test instructions for ${label}; JSON { reply }.`,
  schema: SCHEMA,
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
});
/** The operator config of the harness: consult (short), post_generation (long-running, 3 attempts), the Kabumori system job on Anthropic. */
export function policySet(revision: string, apps: "all" | "postona") {
  const consult: FeatureConfig = {
    enabled: true, revision, provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
    maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
  };
  const config: Record<string, FeatureConfig> = {
    "postona:consult": consult,
    "postona:post_generation": { ...consult, timeoutMs: 600_000, maxAttempts: 3, maxCostUsdPerOperation: 0.2 },
  };
  const body: Record<string, FeatureContent> = { "postona:consult": content("consult"), "postona:post_generation": content("post") };
  if (apps === "all") {
    config["kabumori:market_report"] = { ...consult, provider: "anthropic", model: "claude-haiku-5-5", entitlements: [] };
    body["kabumori:market_report"] = content("report");
  }
  return buildAppPolicySet(config, body);
}

/** G5's proposed verdict RPC, answered from the fake-G5 tables (sessions by JWT, brand owner + owner epoch, entitlements). */
async function fakeG5(init: RequestInit | undefined): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (headers.get("apikey") !== PUBLISHABLE_KEY) return jsonResponse(401, { code: "PGRST301" });
  const jwt = /^Bearer (\S+)$/u.exec(headers.get("Authorization") ?? "")?.[1] ?? "";
  const { p_app, p_feature, p_brand_id } = JSON.parse(String(init?.body)) as { p_app: string; p_feature: string; p_brand_id: string | null };
  const session = await rows(`select user_id || '|' || session_ref || '|' || state from g6r_fake.sessions where jwt = ${literal(jwt)}`);
  if (session === "") return jsonResponse(401, { code: "PGRST301" });
  const [userId, ref, state] = session.split("|");
  const scope = { app: p_app, feature: p_feature, brand_slug: p_brand_id };
  const entitlements = (await rows(`select coalesce(string_agg(entitlement, ',' order by entitlement), '') from g6r_fake.entitlements where user_id = ${literal(userId)}`))
    .split(",").filter((e) => e !== "");
  const wire = (decision: string, reason: string | null, ownerEpoch: string | null) => ({
    v: 1, decision, reason, scope, subject: { kind: "user", user_id: userId }, session: { state, ref }, owner_epoch: ownerEpoch, entitlements,
  });
  if (p_brand_id === null) return jsonResponse(200, wire("allow", null, null));
  const brand = await rows(`select owner || '|' || owner_epoch || '|' || lifecycle from g6r_fake.brands where slug = ${literal(p_brand_id)}`);
  const [owner, epoch, lifecycle] = brand.split("|");
  if (brand === "" || owner !== userId) return jsonResponse(200, wire("deny", "BRAND_NOT_OWNED", null));
  return jsonResponse(200, wire("allow", null, `g5oe:${epoch}:${lifecycle}`));
}

/** The Kabumori system job's own authority (G5 never answers for system work): a stand-in that always allows the job. */
const JOB_TRANSPORT: G5Transport = {
  fetchVerdict: (_credential, scope) => Promise.resolve(jobWire(scope.app, scope.feature)),
  fetchRecheck: (_credential, scope) => Promise.resolve(jobWire(scope.app, scope.feature)),
};
function jobWire(app: string, feature: string) {
  const now = Date.now();
  return {
    v: 1, decision: "allow", reason: null, scope: { app, feature, brand_slug: null }, subject: { kind: "system" }, session: null, owner_epoch: null,
    entitlements: [], issued_at_ms: now, expires_at_ms: now + 60_000,
  };
}

async function runGateway(job: GatewayJob): Promise<unknown> {
  const set = policySet(job.revision, "all");
  const pauseIf = async (point: string, n?: number) => {
    // G6-12: several pause points may be given; each is entered once.
    const points: readonly string[] = Array.isArray(job.pauseAt) ? job.pauseAt : job.pauseAt ? [job.pauseAt as string] : [];
    const hit = points.find((p) => p === point || (n !== undefined && p === `${point}#${n}`));
    if (hit) await pause(job.name, hit);
  };
  const event = (point: string) => rows(`insert into g6r_fake.events (worker, point) values (${literal(job.name)}, ${literal(point)})`);
  const counts = new Map<string, number>();
  let providerCalls = 0;
  const route: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === `${SUPABASE}/rest/v1/rpc/${G5_VERDICT_RPC}`) {
      // G6-09: the n-th G5 question ("after:g5_verdict#2" = after the first recheck's answer).
      const n = (counts.get("g5_verdict") ?? 0) + 1;
      counts.set("g5_verdict", n);
      const answer = await fakeG5(init);
      await pauseIf("after:g5_verdict", n);
      return answer;
    }
    const rpc = url.match(/^http:\/\/127\.0\.0\.1:54321\/rest\/v1\/rpc\/(ai_(?:ledger|calls)_[a-z_]+)$/u)?.[1];
    if (rpc) {
      if (new Headers(init?.headers).get("apikey") !== SERVICE_KEY) return jsonResponse(401, { code: "PGRST301" });
      const n = (counts.get(rpc) ?? 0) + 1;
      counts.set(rpc, n);
      await pauseIf(`before:${rpc}`, n);
      if (job.faults?.[`${rpc}#${n}`] === "down") throw new TypeError("unreachable: the statement never ran");
      if (job.trace) await event(`start:${rpc}#${n}`);
      // The database keeps running a statement whose caller gave up (as PostgREST would); the caller sees the abort.
      const running = serviceRpc(rpc, (JSON.parse(String(init?.body)) as { p: unknown }).p);
      // (The listener is removed afterwards: a pending abort listener would keep the timeout's timer, and the process, alive.)
      const signal = init?.signal;
      let onAbort = () => {};
      const aborted = new Promise<never>((_, reject) => onAbort = () => reject(new DOMException("timeout", "AbortError")));
      signal?.addEventListener("abort", onAbort, { once: true });
      let r: Awaited<typeof running>;
      try {
        r = await Promise.race([running, aborted]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (job.trace) await event(`end:${rpc}#${n}`);
      await pauseIf(`after:${rpc}`, n);
      if (job.faults?.[`${rpc}#${n}`] === "lost") throw new TypeError("connection lost after the statement ran");
      return r.ok ? jsonResponse(200, r.answer) : jsonResponse(400, { code: r.code });
    }
    // The providers: every request that reaches one is written down first (it survives a SIGKILL), then answered.
    const provider = url.startsWith("https://api.openai.com/") ? "openai" : url.startsWith("https://api.anthropic.com/") ? "anthropic" : null;
    if (!provider) return jsonResponse(404, {});
    await rows(`insert into g6r_fake.provider_requests (worker, operation_id, provider) values (${literal(job.name)}, ${literal(job.operationId)}, '${provider}')`);
    await pauseIf("provider", providerCalls + 1);
    const reply = job.providerReplies?.[providerCalls++] ?? "ok";
    if (reply !== "ok") return jsonResponse(Number(reply), { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "slow down" } });
    return provider === "openai"
      ? jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }))
      : jsonResponse(200, anthropicBody({ reply: "ok" }, { model: "claude-haiku-5-5" }));
  };
  const transport = job.app === "kabumori" ? JOB_TRANSPORT : createG5RpcTransport({ supabaseUrl: SUPABASE, publishableKey: PUBLISHABLE_KEY, fetch: route });
  const gateway = createAiGateway({
    // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
    ledgerMode: job.ledgerMode ?? "legacy_busy_check_unsafe",
    supabaseUrl: SUPABASE,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    authority: createG5AuthorityPort({ transport, planAllowlist: set.planAllowlist, acceptSystemSubject: job.app === "kabumori" }),
    policies: set.registry,
    fetch: route,
    holdSeconds: 30,
    rpcTimeoutMs: job.rpcTimeoutMs,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  const brand = job.brand === null ? null : { app: job.app, slug: job.brand };
  const request = { app: job.app, feature: job.feature, operationId: job.operationId, input: `operation ${job.operationId}`, brand };
  if (!job.ownerHeld) return await gateway.execute(job.credential, request);
  // G6-11: the same composition as createAiGateway, with the owner-held store.
  const serviceKey = new SecretValue("AI_GATEWAY_SERVICE_KEY", SERVICE_KEY);
  const keyNames: readonly string[] = Object.values(PROVIDER_API_KEY_ENV);
  return await gatewayExecute({
    authority: createG5AuthorityPort({ transport, planAllowlist: set.planAllowlist, acceptSystemSubject: job.app === "kabumori" }),
    policies: set.registry,
    provider: {
      readEnv: (name) => keyNames.includes(name) ? (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined) : undefined,
      fetch: route,
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
    legacyBusyHeldCheck: true, // G6-20: pins the legacy busy re-claim check (the owner-held path has its own suites)
    budget: new SupabaseLedgerBudgetGuard({ supabaseUrl: SUPABASE, serviceKey, fetch: route, holdSeconds: 30, rpcTimeoutMs: job.rpcTimeoutMs }),
    store: new OwnerHeldStore(new SupabaseAiCallsStore({ supabaseUrl: SUPABASE, serviceKey, fetch: route, rpcTimeoutMs: job.rpcTimeoutMs }), route, job.rpcTimeoutMs ?? 10_000),
  }, job.credential, request);
}

/**
 * G6-11 TEST-ONLY call store. The first claim of an operation is the real ai_calls_claim (its owner token is kept in
 * memory only). Every later claim of the same identity is the gateway's pre-send check: it asks the candidate
 * ai_calls_claim_held with that ORIGINAL token and answers "busy" (held, go on) only for {held: true}; anything else,
 * an error, a timeout or a lost answer is "conflict" (not held, send nothing). The check never creates a row.
 */
class OwnerHeldStore implements CallStore {
  readonly #owners = new Map<string, string>();
  constructor(readonly inner: SupabaseAiCallsStore, readonly fetch: FetchLike, readonly timeoutMs: number) {}
  async claim(identity: CallIdentity, context: ClaimContext): Promise<CallClaim> {
    const owner = this.#owners.get(identity.key);
    if (owner === undefined) {
      const first = await this.inner.claim(identity, context);
      if (first.kind === "acquired") this.#owners.set(identity.key, first.owner);
      return first;
    }
    const s = context.subject;
    const p: Record<string, unknown> = {
      call_key: identity.key, tenant_tag: identity.tenantTag, fingerprint: identity.fingerprint, application: context.app,
      feature: context.storeFeature, subject_kind: s.kind, owner,
    };
    if (s.kind === "user") {
      p.user_id = s.userId;
      if (s.brand) p.brand_ref = s.brand.slug;
    }
    const response = await this.fetch(`${SUPABASE}/rest/v1/rpc/ai_calls_claim_held`, {
      method: "POST",
      headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return response.ok && body !== null && body.held === true && Object.keys(body).length === 1 ? { kind: "busy" } : { kind: "conflict" };
  }
  complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void> {
    return this.inner.complete(identity, owner, outcome);
  }
}

async function runRecover(job: RecoverJob): Promise<unknown> {
  const rpc = async (name: string, p: unknown) => {
    const r = await serviceRpc(name, p);
    if (!r.ok) throw new Error(`RPC_FAILED:${name}:${r.code}`);
    return r.answer;
  };
  return await reconcileUnknownCalls(rpc, policySet(job.revision, job.apps).registry, { mode: job.mode, abandonAfterSeconds: job.abandonAfterSeconds });
}

if (import.meta.main) {
  const job = JSON.parse(Deno.args[0]) as GatewayJob | RecoverJob;
  const result = job.role === "gateway" ? await runGateway(job) : await runRecover(job);
  console.log("RESULT " + JSON.stringify(result));
}
