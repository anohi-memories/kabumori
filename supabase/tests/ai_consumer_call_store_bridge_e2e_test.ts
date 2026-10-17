// End-to-end: the REAL H5 consumer bridge + the real SupabaseLedgerBudgetGuard against the ledger and call-store
// migrations in a disposable PostgreSQL. Test-only adapters: SqlCallStore (ConsumerCallStore over the
// public.ai_calls_* RPCs) and a fetch that turns the guard's PostgREST requests into the same RPC calls. Both run
// psql AS service_role on the local socket the runner gives. The AI provider is a fake fetch: no network, fake key.
// Run by supabase/tests/ai_consumer_call_store_run.sh (part "bridge"); skipped when its environment is absent.
//
// SqlCallStore is a test adapter that proves the SQL contract against the bridge, not the TypeScript store to ship.
import assert from "node:assert/strict";
import { createConsumerBridge } from "../functions/_shared/ai_consumer_bridge/bridge.ts";
import type {
  BridgeResult,
  CallClaim,
  CallIdentity,
  ConsumerCallStore,
  ConsumerFeature,
} from "../functions/_shared/ai_consumer_bridge/types.ts";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { resolveSecret, SupabaseLedgerBudgetGuard } from "../functions/_shared/ai_provider/mod.ts";
import { anthropicBody, jsonResponse, recordingFetch, type Responder } from "../functions/_shared/ai_provider/test_support.ts";
import type { AiSubject } from "../functions/_shared/ai_provider/types.ts";

const HOST = Deno.env.get("ACS_PGHOST");
const PORT = Deno.env.get("ACS_PGPORT");
const SUPER = Deno.env.get("ACS_PGSUPER");
const DB = Deno.env.get("ACS_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
const SUBJECTS: Record<string, AiSubject> = {
  user_a: { kind: "user", userId: USER_A, brandId: null },
  user_b: { kind: "user", userId: USER_B, brandId: null },
};

/** One SQL statement (or several separated by ;) on the local socket; stdout of the last one. */
async function psql(statement: string): Promise<{ ok: boolean; out: string; err: string }> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  return { ok: output.success, out: decode(output.stdout), err: decode(output.stderr) };
}

function literal(json: unknown): string {
  const text = JSON.stringify(json);
  if (text.includes("$acs$")) throw new Error("payload contains the quote tag");
  return `$acs$${text}$acs$::jsonb`;
}

/** A public RPC called AS service_role, as PostgREST would. */
async function rpc(name: string, p: unknown): Promise<unknown> {
  if (!/^ai_(calls|ledger)_[a-z_]+$/.test(name)) throw new Error("unexpected rpc");
  const result = await psql(`set role service_role; select public.${name}(${literal(p)})`);
  if (!result.ok) throw new Error(`RPC_FAILED:${name}:${result.err.split("\n")[0]}`);
  return JSON.parse(result.out);
}

async function rows(sql: string): Promise<string> {
  const result = await psql(sql);
  assert.ok(result.ok, result.err);
  return result.out;
}

/** ConsumerCallStore over the SQL RPCs. The context comes from the same verified authorization as the bridge's. */
class SqlCallStore implements ConsumerCallStore {
  loseNextComplete: "before_write" | "after_write" | null = null;
  constructor(private readonly context: { application: string; feature: string; subject: AiSubject; brandRef?: string }) {}

  async claim(identity: CallIdentity): Promise<CallClaim> {
    const subject = this.context.subject;
    return await rpc("ai_calls_claim", {
      call_key: identity.key,
      tenant_tag: identity.tenantTag,
      fingerprint: identity.fingerprint,
      application: this.context.application,
      feature: this.context.feature,
      subject_kind: subject.kind,
      ...(subject.kind === "user" ? { user_id: subject.userId } : {}),
      ...(this.context.brandRef ? { brand_ref: this.context.brandRef } : {}),
    }) as CallClaim;
  }

  async complete(identity: CallIdentity, owner: string, result: BridgeResult): Promise<void> {
    if (this.loseNextComplete === "before_write") {
      this.loseNextComplete = null;
      throw new Error("response_lost");
    }
    await rpc("ai_calls_complete", {
      call_key: identity.key,
      tenant_tag: identity.tenantTag,
      fingerprint: identity.fingerprint,
      owner,
      result,
    });
    if (this.loseNextComplete === "after_write") {
      this.loseNextComplete = null;
      throw new Error("response_lost");
    }
  }
}

/** The guard's PostgREST request -> the same RPC through psql (never a network request). */
const ledgerFetch: FetchLike = async (input, init) => {
  const match = new URL(String(input)).pathname.match(/^\/rest\/v1\/rpc\/(ai_ledger_[a-z_]+)$/);
  if (!match || init?.method !== "POST") return new Response("{}", { status: 404 });
  try {
    const body = JSON.parse(String(init.body)) as { p: unknown };
    return new Response(JSON.stringify(await rpc(match[1], body.p)), { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ code: "P0001" }), { status: 400 });
  }
};

function feature(id: string, policyFeature: string): ConsumerFeature {
  return {
    id,
    revision: "e2e-1",
    policy: {
      role: "postona.consult.reply",
      application: "postona",
      feature: policyFeature,
      allowedModels: ["anthropic.haiku@2026-10"],
      defaultModel: "anthropic.haiku@2026-10",
      allowedEfforts: ["low"],
      defaultEffort: "low",
      maxOutputTokens: 300,
      timeoutMs: 25_000,
      maxTransportAttempts: 1,
    },
    systemInstructions: "Reply with JSON { \"reply\": string }.",
    schema: {
      name: "consult_reply",
      schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string", minLength: 1 } } },
    },
    maxInputBytes: 4096,
    maxResultBytes: 4096,
    maxTotalCostUsd: 0.05,
    deadlineMs: 30_000,
    validateFacts: () => true,
  };
}
const CONSULT = feature("postona.consult", "consult");
const QUOTA = feature("postona.quota", "quota");

function world(
  credential: keyof typeof SUBJECTS,
  options: { respond?: Responder; feature?: ConsumerFeature; authorized?: boolean } = {},
) {
  const f = options.feature ?? CONSULT;
  const net = recordingFetch(options.respond ?? (() => jsonResponse(200, anthropicBody({ reply: "どうぞ" }))));
  const store = new SqlCallStore({ application: "postona", feature: f.id, subject: SUBJECTS[credential] });
  const key = resolveSecret("ACS_E2E_LEDGER_KEY", () => "local-e2e-key-not-a-secret");
  assert.ok(key.ok);
  const budget = new SupabaseLedgerBudgetGuard({ supabaseUrl: "http://127.0.0.1:9", serviceKey: key.value, fetch: ledgerFetch });
  const bridge = createConsumerBridge("postona-e2e-1", [f], {
    store,
    authorize: (cred) => {
      const subject = SUBJECTS[String(cred)];
      return Promise.resolve(subject && options.authorized !== false ? { subject, expiresAtMs: Date.now() + 60_000 } : null);
    },
    provider: {
      fetch: net.fetch,
      readEnv: (name: string) => (name === "ANTHROPIC_API_KEY" ? "test-anthropic-key-NOT-REAL-000000" : undefined),
      budget,
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
  });
  const execute = (operationId: string, input = "テーマを決めたい") => bridge.execute(credential, { feature: f.id, operationId, input });
  return { bridge, store, net, execute };
}

const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

Deno.test({ name: "setup: fully scoped POSTONA ledger policies (consult: 100 a day per user; quota: 1 a day per user)", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('anthropic.postona.consult.user.daily', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 100, 1, 0.05),
           ('anthropic.postona.quota.user.daily', 'anthropic', 'claude-haiku-5-5', 'postona', 'quota', 'user', true, 'day', 1, 1, 0.05)`);
});

Deno.test({ name: "one operation = one row, one ledger reservation under request_id = callId; a replay (even from a new bridge) sends nothing", ...opts }, async () => {
  const first = world("user_a");
  const result = await first.execute("e2e-op-1");
  assert.equal(result.ok, true);
  const callId = result.audit!.callId;
  assert.match(callId, /^h5m2_[0-9a-f]{64}$/);
  assert.equal(await rows(`select state || '|' || user_id || '|' || feature from ai_calls.consumer_calls where call_key = '${callId}'`), `complete|${USER_A}|postona.consult`);
  assert.equal(await rows(`select count(*) || '|' || min(status) || '|' || min(feature) from ai_ledger.reservations where request_id = '${callId}'`), "1|settled|consult");
  assert.deepEqual(await first.execute("e2e-op-1"), result);
  const restarted = world("user_a");
  assert.deepEqual(await restarted.execute("e2e-op-1"), result, "another bridge instance replays the stored result");
  assert.equal(first.net.calls.length + restarted.net.calls.length, 1, "one provider request in total");
});

Deno.test({ name: "parallel duplicates: exactly one provider request, the other is IN_PROGRESS", ...opts }, async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const w = world("user_a", {
    respond: async () => {
      await gate;
      return jsonResponse(200, anthropicBody({ reply: "どうぞ" }));
    },
  });
  const first = w.execute("e2e-op-2");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await w.execute("e2e-op-2");
  release();
  assert.deepEqual([second.ok, !second.ok && second.code], [false, "IN_PROGRESS"]);
  assert.equal((await first).ok, true);
  assert.equal(w.net.calls.length, 1);
});

Deno.test({ name: "the same operationId with other input is CONTENT_DRIFT; another user's operationId is another call", ...opts }, async () => {
  const a = world("user_a");
  await a.execute("e2e-op-3");
  const drift = await a.execute("e2e-op-3", "別の内容");
  assert.deepEqual([drift.ok, !drift.ok && drift.code, a.net.calls.length], [false, "CONTENT_DRIFT", 1]);
  const b = world("user_b");
  const other = await b.execute("e2e-op-3");
  assert.equal(other.ok, true);
  assert.equal(b.net.calls.length, 1);
  assert.notEqual(other.audit!.callId, drift.audit!.callId);
  assert.equal(await rows(`select user_id from ai_calls.consumer_calls where call_key = '${other.audit!.callId}'`), USER_B);
});

Deno.test({ name: "lost completion: before the write -> IN_PROGRESS until recovery abandons it (UNKNOWN, never resent); after the write -> stored result", ...opts }, async () => {
  const w = world("user_a");
  w.store.loseNextComplete = "before_write";
  const lost = await w.execute("e2e-op-4");
  assert.deepEqual([lost.ok, !lost.ok && lost.code], [false, "UNKNOWN"]);
  const busy = await w.execute("e2e-op-4");
  assert.deepEqual([busy.ok, !busy.ok && busy.code], [false, "IN_PROGRESS"]);
  const callId = lost.audit!.callId;
  // Recovery: the ledger attempt is final (settled); the row is old enough; the audit is rebuilt from the ledger.
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1 hour' where call_key = '${callId}'`);
  const cost = Number(await rows(`select sum(estimated_cost_usd) from ai_ledger.usage_events where request_id = '${callId}'`));
  const abandoned = await rpc("ai_calls_abandon", {
    call_key: callId,
    audit: { ...lost.audit!, attempts: 1, estimatedCostUsd: cost, costBasis: "measured" },
  });
  assert.deepEqual(abandoned, { abandoned: true });
  const replay = await w.execute("e2e-op-4");
  assert.deepEqual([replay.ok, !replay.ok && replay.code, replay.audit?.attempts], [false, "UNKNOWN", 1], "the SQL tombstone is accepted by the bridge");
  assert.equal(w.net.calls.length, 1, "never resent");

  const v = world("user_a");
  v.store.loseNextComplete = "after_write";
  const lostAfter = await v.execute("e2e-op-4b");
  assert.deepEqual([lostAfter.ok, !lostAfter.ok && lostAfter.code], [false, "UNKNOWN"]);
  const served = await v.execute("e2e-op-4b");
  assert.equal(served.ok, true, "the row was written before the response was lost: the stored result is served");
  assert.equal(v.net.calls.length, 1);
});

Deno.test({ name: "504: the ledger charges the upper bound (unknown), the store keeps UNKNOWN, a replay never resends", ...opts }, async () => {
  const w = world("user_a", { respond: () => jsonResponse(504, { type: "error", error: { type: "timeout_error", message: "gateway" } }) });
  const first = await w.execute("e2e-op-5");
  assert.deepEqual([first.ok, !first.ok && first.code, first.audit?.costBasis], [false, "UNKNOWN", "includes_upper_bound"]);
  const callId = first.audit!.callId;
  assert.equal(await rows(`select status from ai_ledger.reservations where request_id = '${callId}'`), "unknown");
  assert.equal(await rows(`select cost_basis from ai_ledger.usage_events where request_id = '${callId}'`), "upper_bound");
  assert.equal(await rows(`select result ->> 'code' from ai_calls.consumer_calls where call_key = '${callId}'`), "UNKNOWN");
  const replay = await w.execute("e2e-op-5");
  assert.deepEqual(replay, first);
  assert.equal(w.net.calls.length, 1);
});

Deno.test({ name: "quota: the second call of the day is BUDGET_DENIED before any request, stored and replayed as such", ...opts }, async () => {
  const w = world("user_a", { feature: QUOTA });
  assert.equal((await w.execute("e2e-q-1")).ok, true);
  const denied = await w.execute("e2e-q-2");
  assert.deepEqual([denied.ok, !denied.ok && denied.code, denied.audit?.attempts], [false, "BUDGET_DENIED", 0]);
  assert.equal(w.net.calls.length, 1, "no request for the denied call");
  assert.equal(await rows(`select count(*) from ai_ledger.reservations where request_id = '${denied.audit!.callId}'`), "0");
  assert.deepEqual(await w.execute("e2e-q-2"), denied);
  assert.equal(w.net.calls.length, 1);
});

Deno.test({ name: "content retention: purge turns the stored output into the UNKNOWN tombstone the bridge accepts; no resend, no output kept", ...opts }, async () => {
  const w = world("user_a", { respond: () => jsonResponse(200, anthropicBody({ reply: "E2E-SENTINEL-OUTPUT" })) });
  const first = await w.execute("e2e-op-6");
  assert.equal(first.ok, true);
  const callId = first.audit!.callId;
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set completed_at = completed_at - interval '25 hours' where call_key = '${callId}'`);
  assert.deepEqual(await rpc("ai_calls_purge_content", {}), { purged: 1 });
  const replay = await w.execute("e2e-op-6");
  assert.deepEqual([replay.ok, !replay.ok && replay.code], [false, "UNKNOWN"]);
  assert.deepEqual([replay.audit?.attempts, replay.audit?.costBasis, replay.audit?.estimatedCostUsd], [first.audit.attempts, first.audit.costBasis, first.audit.estimatedCostUsd]);
  assert.equal(w.net.calls.length, 1);
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls c where c::text like '%E2E-SENTINEL-OUTPUT%'`), "0");
});

Deno.test({ name: "account deletion: once the user can no longer be authorised, forget_user removes the rows and nothing is sent", ...opts }, async () => {
  assert.notEqual(await rows(`select count(*) from ai_calls.consumer_calls where user_id = '${USER_B}'`), "0");
  const forgotten = await rpc("ai_calls_forget_user", { user_id: USER_B }) as Record<string, unknown>;
  assert.equal(forgotten.forgotten, true);
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where user_id = '${USER_B}'`), "0");
  assert.equal(await rows(`select count(*) from ai_calls.consumer_calls where user_id = '${USER_A}' and state = 'complete'`) !== "0", true, "user A untouched");
  const gone = world("user_b", { authorized: false });
  const after = await gone.execute("e2e-op-3");
  assert.deepEqual([after.ok, !after.ok && after.code, gone.net.calls.length], [false, "AUTHORITY_DENIED", 0]);
});
