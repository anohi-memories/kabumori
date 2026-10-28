// OFFLINE conformance of the cross-app common AI gateway contract (PR284, unchanged reference) against the REAL shared
// parts it would run on: both provider adapters (OpenAI and Anthropic, through executeAiRequest) and the REAL
// SupabaseLedgerBudgetGuard speaking to a fake in-memory PostgREST. The provider and the ledger endpoints are fake
// fetches: no network, fake keys. Every PASS here is a mock PASS (the managed runtime, the production ledger and real
// provider behaviour are NOT_VERIFIED). Tests named "GAP-n fixed" assert the behaviour after the fixes of
// docs/ai-provider/F6_GATEWAY_GAP_FIXES.md (the gaps PR289 recorded: the label half used to be wrong; the safety half
// is unchanged and still asserted).
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY supabase/tests/common_ai_gateway_conformance_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import {
  type BudgetCallContext,
  type BudgetGuard,
  type BudgetReservation,
  type BudgetSettlement,
  InMemoryBudgetGuard,
} from "../functions/_shared/ai_provider/budget.ts";
import { resolveSecret, SupabaseLedgerBudgetGuard } from "../functions/_shared/ai_provider/mod.ts";
import {
  anthropicBody,
  anthropicError,
  FAKE_ANTHROPIC_KEY,
  FAKE_OPENAI_KEY,
  hangUntilAborted,
  jsonResponse,
  openAiBody,
  recordingFetch,
  type Responder,
} from "../functions/_shared/ai_provider/test_support.ts";
import {
  type AuthorityPort,
  type AuthVerdict,
  type CallClaim,
  type CallIdentity,
  type CallStore,
  type FeaturePolicy,
  gatewayExecute,
  type GatewayResult,
  type GatewaySubject,
  policyKey,
  type StoredOutcome,
} from "./common_ai_cross_app_gateway_reference.ts";

type Provider = "openai" | "anthropic";
const PROVIDERS: readonly Provider[] = ["openai", "anthropic"];
const MODEL: Record<Provider, string> = { openai: "gpt-6-luna", anthropic: "claude-haiku-5-5" };
const USER_A = "11111111-1111-4111-8111-111111111111";
const BRAND_A = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const HOUR = 3_600_000;
const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };

function policy(provider: Provider, over: Partial<FeaturePolicy> = {}): FeaturePolicy {
  return {
    app: "postona",
    feature: "ideas",
    revision: "r1",
    ledgerFeature: "ideas",
    logicalRole: "postona.ideas",
    provider,
    model: MODEL[provider],
    reasoningEffort: "low",
    maxOutputTokens: 300,
    timeoutMs: 20_000,
    maxAttempts: 1,
    maxCostUsdPerOperation: 0.05,
    maxInputBytes: 8_000,
    subjectKinds: ["user"],
    brandRequired: false,
    systemInstructions: "Answer as JSON { reply }.",
    schema: SCHEMA,
    validate: (p) => typeof (p as { reply?: unknown })?.reply === "string" && !(p as { reply: string }).reply.includes("FORBIDDEN"),
    ...over,
  };
}

const subjectA: GatewaySubject = { kind: "user", app: "postona", userId: USER_A, brand: BRAND_A };
const verdictA: AuthVerdict = { decision: "allow", subject: subjectA, generation: "epoch-1", expiresAtMs: Date.now() + HOUR };

class Authority implements AuthorityPort {
  rechecks = 0;
  /** The recheck answer for recheck number n (1-based); default: the same verdict. */
  answer: (n: number, prior: AuthVerdict) => AuthVerdict | Error = (_n, prior) => prior;
  verdict(): Promise<AuthVerdict> {
    return Promise.resolve(structuredClone(verdictA));
  }
  recheck(prior: AuthVerdict): Promise<AuthVerdict> {
    const v = this.answer(++this.rechecks, prior);
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(structuredClone(v));
  }
}

class Store implements CallStore {
  readonly rows = new Map<string, { identity: CallIdentity; owner: string; outcome: StoredOutcome | null }>();
  claim(identity: CallIdentity): Promise<CallClaim> {
    const row = this.rows.get(identity.key);
    if (!row) {
      const owner = crypto.randomUUID();
      this.rows.set(identity.key, { identity, owner, outcome: null });
      return Promise.resolve({ kind: "acquired", owner });
    }
    if (row.identity.fingerprint !== identity.fingerprint || row.identity.tenantTag !== identity.tenantTag) return Promise.resolve({ kind: "conflict" });
    if (!row.outcome) return Promise.resolve({ kind: "busy" });
    return Promise.resolve({ kind: "complete", fingerprint: row.identity.fingerprint, outcome: structuredClone(row.outcome) });
  }
  complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void> {
    const row = this.rows.get(identity.key);
    if (!row || row.owner !== owner || row.outcome) return Promise.reject(new Error("fenced"));
    row.outcome = structuredClone(outcome);
    return Promise.resolve();
  }
}

/** A recording guard with the database guard's shape (reserve -> markSent -> settle | release). */
class RecordingLedger implements BudgetGuard {
  inner = new InMemoryBudgetGuard([{ id: "postona", scope: { application: "postona" }, maxCalls: 100, maxUsdPerCall: 0.05 }]);
  readonly events: string[] = [];
  async reserve(c: BudgetCallContext, upper: number) {
    const d = await this.inner.reserve(c, upper);
    this.events.push(d.allowed ? "reserve" : "deny");
    return d;
  }
  markSent(_r: BudgetReservation) {
    this.events.push("mark_sent");
    return Promise.resolve();
  }
  async settle(r: BudgetReservation, cost: number, s?: BudgetSettlement) {
    this.events.push(`settle:${s?.costBasis}:${s?.outcome}`);
    await this.inner.settle(r, cost);
  }
  release(_r: BudgetReservation) {
    this.events.push("release");
    return Promise.resolve();
  }
}

const RETRY = { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 };
function deps(net: FetchLike, budget: BudgetGuard, authority: AuthorityPort, store: CallStore, p: FeaturePolicy) {
  return {
    authority,
    policies: new Map([[policyKey("postona", "ideas"), p]]),
    provider: {
      readEnv: (name: string) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
      fetch: net,
      retryTiming: RETRY,
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
    budget,
    legacyBusyHeldCheck: true, // G6-20: pins the legacy busy re-claim check (the owner-held path has its own suites)
    store,
  };
}
const ideas = (operationId = "op-conformance-1") => ({ app: "postona", feature: "ideas", operationId, input: "今日の投稿のアイデア", brand: BRAND_A });

/** One provider-neutral situation and how each provider spells it. */
type Situation = Readonly<{ name: string; maxAttempts?: 1 | 2; timeoutMs?: number; respond: Record<Provider, Responder> }>;
const ok = (reply: string): Record<Provider, Responder> => ({
  openai: () => jsonResponse(200, openAiBody({ reply }, { model: MODEL.openai })),
  anthropic: () => jsonResponse(200, anthropicBody({ reply }, { model: MODEL.anthropic })),
});
const status = (s: number, openai: unknown, anthropic: unknown): Record<Provider, Responder> => ({
  openai: () => jsonResponse(s, openai),
  anthropic: () => jsonResponse(s, anthropic),
});
const SITUATIONS: readonly Situation[] = [
  { name: "success", respond: ok("どうぞ") },
  { name: "rate limited (one attempt allowed)", respond: status(429, { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }, anthropicError(429, "rate_limit_error", "slow down")) },
  {
    name: "overloaded (OpenAI 503 / Anthropic 529)",
    respond: {
      openai: () => jsonResponse(503, { error: { type: "server_error", code: "overloaded" } }),
      anthropic: () => jsonResponse(529, anthropicError(529, "overloaded_error", "busy")),
    },
  },
  { name: "bad request 400", respond: status(400, { error: { type: "invalid_request_error", code: "bad" } }, anthropicError(400, "invalid_request_error", "bad")) },
  { name: "credentials 401", respond: status(401, { error: { type: "invalid_request_error", code: "invalid_api_key" } }, anthropicError(401, "authentication_error", "key")) },
  { name: "server error 500 (two attempts allowed)", maxAttempts: 2, respond: status(500, { error: { type: "server_error" } }, anthropicError(500, "api_error", "oops")) },
  { name: "gateway timeout 504 (two attempts allowed)", maxAttempts: 2, respond: status(504, { error: { type: "timeout" } }, anthropicError(504, "timeout_error", "late")) },
  {
    name: "lost connection (two attempts allowed)",
    maxAttempts: 2,
    respond: { openai: () => Promise.reject(new TypeError("connection reset")), anthropic: () => Promise.reject(new TypeError("connection reset")) },
  },
  {
    name: "client timeout",
    timeoutMs: 1_000,
    respond: { openai: (_c, _i, init) => hangUntilAborted(init), anthropic: (_c, _i, init) => hangUntilAborted(init) },
  },
  {
    name: "output is not JSON",
    respond: {
      openai: () =>
        jsonResponse(200, openAiBody(null, { model: MODEL.openai, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "not json", annotations: [] }] }] })),
      anthropic: () => jsonResponse(200, anthropicBody(null, { model: MODEL.anthropic, text: "not json" })),
    },
  },
  {
    name: "output breaks the schema",
    respond: {
      openai: () => jsonResponse(200, openAiBody({ wrong: 1 }, { model: MODEL.openai })),
      anthropic: () => jsonResponse(200, anthropicBody({ wrong: 1 }, { model: MODEL.anthropic })),
    },
  },
  { name: "output the app refuses", respond: ok("FORBIDDEN words") },
  {
    name: "the model declines (refusal)",
    respond: {
      openai: () =>
        jsonResponse(200, openAiBody(null, { model: MODEL.openai, output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] })),
      anthropic: () => jsonResponse(200, anthropicBody(null, { model: MODEL.anthropic, stopReason: "refusal", text: "" })),
    },
  },
  {
    name: "output cut off (output cap)",
    respond: {
      openai: () => jsonResponse(200, openAiBody({ reply: "どう" }, { model: MODEL.openai, incomplete: "max_output_tokens" })),
      anthropic: () => jsonResponse(200, anthropicBody({ reply: "どう" }, { model: MODEL.anthropic, stopReason: "max_tokens" })),
    },
  },
];

type Observed = { code: string; sends: number; costBasis: string | null; ledger: string; replay: string; replaySends: number };
async function observe(provider: Provider, s: Situation): Promise<Observed> {
  const net = recordingFetch(s.respond[provider]);
  const ledger = new RecordingLedger();
  const store = new Store();
  const d = deps(net.fetch, ledger, new Authority(), store, policy(provider, { maxAttempts: s.maxAttempts ?? 1, timeoutMs: s.timeoutMs ?? 20_000 }));
  const first = await gatewayExecute(d, "jwt-a", ideas());
  const sends = net.calls.length;
  const replay = await gatewayExecute(d, "jwt-a", ideas());
  return {
    code: first.ok ? "OK" : first.code,
    sends,
    costBasis: first.audit?.costBasis ?? null,
    ledger: ledger.events.join(" "),
    replay: replay.ok ? "OK" : replay.code,
    replaySends: net.calls.length - sends,
  };
}

// What the contract requires for each situation, for EITHER provider (docs table 2).
const EXPECTED: Record<string, Omit<Observed, "replaySends">> = {
  "success": { code: "OK", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:succeeded", replay: "OK" },
  "rate limited (one attempt allowed)": { code: "PROVIDER_FAILED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "PROVIDER_FAILED" },
  "overloaded (OpenAI 503 / Anthropic 529)": { code: "PROVIDER_FAILED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "PROVIDER_FAILED" },
  "bad request 400": { code: "PROVIDER_FAILED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "PROVIDER_FAILED" },
  "credentials 401": { code: "PROVIDER_FAILED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "PROVIDER_FAILED" },
  "server error 500 (two attempts allowed)": { code: "UNKNOWN", sends: 1, costBasis: "includes_upper_bound", ledger: "reserve mark_sent settle:upper_bound:unknown", replay: "UNKNOWN" },
  "gateway timeout 504 (two attempts allowed)": { code: "UNKNOWN", sends: 1, costBasis: "includes_upper_bound", ledger: "reserve mark_sent settle:upper_bound:unknown", replay: "UNKNOWN" },
  "lost connection (two attempts allowed)": { code: "UNKNOWN", sends: 1, costBasis: "includes_upper_bound", ledger: "reserve mark_sent settle:upper_bound:unknown", replay: "UNKNOWN" },
  "client timeout": { code: "UNKNOWN", sends: 1, costBasis: "includes_upper_bound", ledger: "reserve mark_sent settle:upper_bound:unknown", replay: "UNKNOWN" },
  "output is not JSON": { code: "OUTPUT_REJECTED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "OUTPUT_REJECTED" },
  "output breaks the schema": { code: "OUTPUT_REJECTED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "OUTPUT_REJECTED" },
  "output the app refuses": { code: "OUTPUT_REJECTED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:succeeded", replay: "OUTPUT_REJECTED" },
  "the model declines (refusal)": { code: "PROVIDER_FAILED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "PROVIDER_FAILED" },
  "output cut off (output cap)": { code: "PROVIDER_FAILED", sends: 1, costBasis: "measured", ledger: "reserve mark_sent settle:measured:failed", replay: "PROVIDER_FAILED" },
};

Deno.test("both providers through the same gateway: every situation gives the same answer, sends, cost basis, ledger steps and replay (never resent)", async () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), SITUATIONS.map((s) => s.name).sort());
  for (const s of SITUATIONS) {
    const seen = await Promise.all(PROVIDERS.map((p) => observe(p, s)));
    for (const [i, p] of PROVIDERS.entries()) {
      assert.deepEqual(seen[i], { ...EXPECTED[s.name], replaySends: 0 }, `${s.name} / ${p}`);
    }
  }
});

Deno.test("both providers: a known refusal (429 / overload) is resent within maxAttempts with a fresh reservation AND a fresh recheck per attempt", async () => {
  for (const p of PROVIDERS) {
    const refusal = p === "openai" ? () => jsonResponse(429, { error: { type: "rate_limit_error", code: "rate_limit_exceeded" } }) : () => jsonResponse(529, anthropicError(529, "overloaded_error", "busy"));
    const net = recordingFetch((c, i, init) => (i === 0 ? refusal() : ok("どうぞ")[p](c, i, init)));
    const ledger = new RecordingLedger();
    const authority = new Authority();
    const r = await gatewayExecute(deps(net.fetch, ledger, authority, new Store(), policy(p, { maxAttempts: 2 })), "jwt-a", ideas());
    assert.equal(r.ok, true, p);
    assert.equal(net.calls.length, 2, p);
    assert.equal(authority.rechecks, 2, `${p}: one recheck before each attempt`);
    assert.deepEqual(ledger.events, ["reserve", "mark_sent", "settle:measured:failed", "reserve", "mark_sent", "settle:measured:succeeded"], p);
    assert.equal(r.audit?.attempts, 2);
  }
});

const refused429 = (p: Provider): Responder => () => jsonResponse(429, p === "openai" ? { error: { type: "rate_limit_error" } } : anthropicError(429, "rate_limit_error", "x"));

Deno.test("GAP-1 fixed (both providers): revoked before the SECOND attempt -> AUTH_REVOKED_BEFORE_SEND (not a quota); nothing more sent, the reservation released, replay NOT_SENT", async () => {
  for (const p of PROVIDERS) {
    for (const [label, revoke] of [
      ["deny", (prior: AuthVerdict) => ({ ...prior, decision: "deny" as const })],
      ["new generation", (prior: AuthVerdict) => ({ ...prior, generation: "epoch-2" })],
      ["unreadable", () => new Error("authority down")],
    ] as const) {
      const net = recordingFetch(refused429(p));
      const ledger = new RecordingLedger();
      const authority = new Authority();
      authority.answer = (n, prior) => (n === 1 ? prior : revoke(prior));
      const store = new Store();
      const d = deps(net.fetch, ledger, authority, store, policy(p, { maxAttempts: 2 }));
      const r = await gatewayExecute(d, "jwt-a", ideas());
      assert.equal(net.calls.length, 1, `${p} ${label}`);
      assert.deepEqual(ledger.events, ["reserve", "mark_sent", "settle:measured:failed", "reserve", "release"], `${p} ${label}`);
      assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis, r.audit?.attempts], [false, "AUTH_REVOKED_BEFORE_SEND", "measured", 1], `${p} ${label}`);
      const [row] = [...store.rows.values()];
      assert.equal(row.outcome?.ok === false && row.outcome.code, "POLICY_DENIED", `${p} ${label}`);
      authority.answer = (_n, prior) => prior;
      const replay = await gatewayExecute(d, "jwt-a", ideas());
      assert.deepEqual([replay.ok, !replay.ok && replay.code, net.calls.length], [false, "NOT_SENT", 1], `${p} ${label}: never resent`);
    }
  }
});

Deno.test("GAP-1 fixed: a possibly billed first attempt stays UNKNOWN (upper bound) even if a revocation follows; a quota on the second attempt stays a quota", async () => {
  for (const p of PROVIDERS) {
    // 504 is final (never retried), so a later revocation cannot even be asked: UNKNOWN wins.
    const net = recordingFetch(() => jsonResponse(504, p === "openai" ? { error: { type: "timeout" } } : anthropicError(504, "timeout_error", "late")));
    const authority = new Authority();
    authority.answer = (n, prior) => (n === 1 ? prior : { ...prior, decision: "deny" });
    const r = await gatewayExecute(deps(net.fetch, new RecordingLedger(), authority, new Store(), policy(p, { maxAttempts: 2 })), "jwt-a", ideas());
    assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis, net.calls.length], [false, "UNKNOWN", "includes_upper_bound", 1], p);
    // A real budget limit on the second attempt (no revocation) is still QUOTA_EXCEEDED.
    const q = recordingFetch(refused429(p));
    const ledger = new RecordingLedger();
    ledger.inner = new InMemoryBudgetGuard([{ id: "postona", scope: { application: "postona" }, maxCalls: 1, maxUsdPerCall: 0.05 }]);
    const quota = await gatewayExecute(deps(q.fetch, ledger, new Authority(), new Store(), policy(p, { maxAttempts: 2 })), "jwt-a", ideas());
    assert.deepEqual([quota.ok, !quota.ok && quota.code, q.calls.length], [false, "QUOTA_EXCEEDED", 1], p);
  }
});

// ---- the REAL database guard against a fake PostgREST (in memory, no network) -----------------------------------
type Rpc = "ai_ledger_reserve" | "ai_ledger_mark_sent" | "ai_ledger_settle" | "ai_ledger_release";
class FakeLedgerRest {
  readonly calls: string[] = [];
  readonly status = new Map<string, string>();
  /** Per RPC: an injected failure (HTTP status, "network", a mark_sent refusal, or a reserve refusal "deny:<reason>"). */
  fault: Partial<Record<Rpc, number | "network" | "refuse" | `deny:${string}`>> = {};
  private n = 0;
  readonly fetch: FetchLike = (input, init) => {
    const rpc = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "") as Rpc;
    this.calls.push(rpc.replace("ai_ledger_", ""));
    const f = this.fault[rpc];
    if (f === "network") return Promise.reject(new TypeError("ledger unreachable"));
    if (typeof f === "number") return Promise.resolve(jsonResponse(f, { code: "XX000" }));
    const p = (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p;
    switch (rpc) {
      case "ai_ledger_reserve": {
        if (typeof f === "string" && f.startsWith("deny:")) return Promise.resolve(jsonResponse(200, { allowed: false, reason: f.slice(5), policy_key: "gwc.policy" }));
        const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
        this.status.set(id, "reserved");
        return Promise.resolve(jsonResponse(200, { allowed: true, reservation_id: id }));
      }
      case "ai_ledger_mark_sent": {
        const id = String(p.reservation_id);
        if (f === "refuse") return Promise.resolve(jsonResponse(200, { may_send: false, status: "ATTEMPT_IN_FLIGHT" }));
        this.status.set(id, "sent");
        return Promise.resolve(jsonResponse(200, { may_send: true, status: "sent" }));
      }
      case "ai_ledger_settle":
        this.status.set(String(p.reservation_id), String(p.outcome) === "unknown" ? "unknown" : "settled");
        return Promise.resolve(jsonResponse(200, { settled: true }));
      case "ai_ledger_release":
        this.status.set(String(p.reservation_id), "released");
        return Promise.resolve(jsonResponse(200, { released: true }));
    }
    return Promise.resolve(jsonResponse(404, { code: "PGRST404" }));
  };
}
function realGuard(rest: FakeLedgerRest) {
  const key = resolveSecret("CONFORMANCE_LEDGER_KEY", () => "local-conformance-key-not-a-secret");
  assert.ok(key.ok);
  return new SupabaseLedgerBudgetGuard({ supabaseUrl: "http://127.0.0.1:9", serviceKey: key.value, fetch: rest.fetch });
}

Deno.test("real ledger guard (both providers): reserve -> recheck -> mark_sent -> ONE request -> settle; the ledger holds exactly one final row", async () => {
  for (const p of PROVIDERS) {
    const rest = new FakeLedgerRest();
    const net = recordingFetch(ok("どうぞ")[p]);
    const authority = new Authority();
    let recheckedBeforeMarkSent = false;
    authority.answer = (_n, prior) => {
      recheckedBeforeMarkSent = rest.calls.at(-1) === "reserve";
      return prior;
    };
    const r = await gatewayExecute(deps(net.fetch, realGuard(rest), authority, new Store(), policy(p)), "jwt-a", ideas());
    assert.equal(r.ok, true, p);
    assert.deepEqual(rest.calls, ["reserve", "mark_sent", "settle"], p);
    assert.equal(recheckedBeforeMarkSent, true, `${p}: the recheck runs after reserve and before mark_sent`);
    assert.deepEqual([...rest.status.values()], ["settled"], p);
    assert.equal(net.calls.length, 1);
  }
});

Deno.test("real ledger guard: a revoked recheck never reaches mark_sent; the reservation is released; nothing is sent", async () => {
  for (const p of PROVIDERS) {
    const rest = new FakeLedgerRest();
    const net = recordingFetch(ok("どうぞ")[p]);
    const authority = new Authority();
    authority.answer = (_n, prior) => ({ ...prior, generation: "epoch-2" });
    const r = await gatewayExecute(deps(net.fetch, realGuard(rest), authority, new Store(), policy(p)), "jwt-a", ideas());
    assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis, r.audit?.attempts], [false, "AUTH_REVOKED_BEFORE_SEND", "no_request", 0], p);
    assert.deepEqual(rest.calls, ["reserve", "release"], p);
    assert.deepEqual([...rest.status.values()], ["released"], p);
    assert.equal(net.calls.length, 0, p);
  }
});

// G6-09 / G6-10 (R1): a refusal that another process may have sent under (ATTEMPT_FINALIZED; SEND_NOT_CONFIRMED, into
// which the shared guard folds ATTEMPT_IN_FLIGHT and a failed / refused mark_sent; GUARD_UNAVAILABLE, into which
// execute.ts folds every reserve failure and the guard an unknown ledger reason) is UNKNOWN, recorded by nobody but
// recovery. No ledger refusal of this kind is left that proves "not sent".
Deno.test("GAP-2 fixed (real ledger guard): an unreachable / failing ledger or a refusal someone else may have sent under -> UNKNOWN, nothing recorded (G6-09 / G6-10), not a quota; nothing sent; the same operation never resends; a new operation works after recovery", async () => {
  const cases: Array<[string, FakeLedgerRest["fault"], string[], "not_sent" | "unknown"]> = [
    ["reserve network", { ai_ledger_reserve: "network" }, ["reserve"], "unknown"],
    ["reserve 500", { ai_ledger_reserve: 500 }, ["reserve"], "unknown"],
    ["reserve refused: attempt already final", { ai_ledger_reserve: "deny:ATTEMPT_FINALIZED" }, ["reserve"], "unknown"],
    ["reserve refused: attempt in flight elsewhere", { ai_ledger_reserve: "deny:ATTEMPT_IN_FLIGHT" }, ["reserve"], "unknown"],
    ["reserve refused: unknown reason", { ai_ledger_reserve: "deny:SOMETHING_NEW" }, ["reserve"], "unknown"],
    ["mark_sent network", { ai_ledger_mark_sent: "network" }, ["reserve", "mark_sent", "release"], "unknown"],
    ["mark_sent 503", { ai_ledger_mark_sent: 503 }, ["reserve", "mark_sent", "release"], "unknown"],
    ["mark_sent refused (no permit)", { ai_ledger_mark_sent: "refuse" }, ["reserve", "mark_sent", "release"], "unknown"],
  ];
  for (const p of PROVIDERS) {
    for (const [label, fault, calls, kind] of cases) {
      const rest = new FakeLedgerRest();
      rest.fault = fault;
      const net = recordingFetch(ok("どうぞ")[p]);
      const store = new Store();
      const d = deps(net.fetch, realGuard(rest), new Authority(), store, policy(p));
      const r = await gatewayExecute(d, "jwt-a", ideas());
      assert.equal(net.calls.length, 0, `${p} ${label}: nothing sent`);
      assert.deepEqual(rest.calls, calls, `${p} ${label}`);
      const [row] = [...store.rows.values()];
      rest.fault = {};
      const again = await gatewayExecute(d, "jwt-a", ideas());
      if (kind === "not_sent") {
        assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis], [false, "LEDGER_UNAVAILABLE", "no_request"], `${p} ${label}`);
        assert.equal(row.outcome?.ok === false && row.outcome.code, "POLICY_DENIED", `${p} ${label}: stored as not sent`);
        assert.deepEqual([again.ok, !again.ok && again.code, net.calls.length], [false, "NOT_SENT", 0], `${p} ${label}: the same operation is final, never resent`);
      } else {
        assert.deepEqual([r.ok, !r.ok && r.code, r.audit], [false, "UNKNOWN", null], `${p} ${label}: no "not sent", no 0 USD`);
        assert.equal(row.outcome, null, `${p} ${label}: nothing recorded (left for recovery, which builds the audit from the ledger)`);
        assert.deepEqual([again.ok, !again.ok && again.code, net.calls.length], [false, "IN_PROGRESS", 0], `${p} ${label}: the same operation waits for recovery, never resent`);
      }
      const fresh = await gatewayExecute(d, "jwt-a", ideas("op-conformance-2"));
      assert.deepEqual([fresh.ok, net.calls.length], [true, 1], `${p} ${label}: a new operation works after recovery`);
    }
  }
});

Deno.test("GAP-2 fixed (real ledger guard): only a budget limit is QUOTA_EXCEEDED; the ledger failing on the SECOND attempt after a refused first one is UNKNOWN, nothing recorded (G6-10)", async () => {
  for (const p of PROVIDERS) {
    for (const reason of ["CALL_LIMIT", "COST_LIMIT", "PER_CALL_LIMIT", "NO_MATCHING_POLICY"]) {
      const rest = new FakeLedgerRest();
      rest.fault = { ai_ledger_reserve: `deny:${reason}` };
      const net = recordingFetch(ok("どうぞ")[p]);
      const store = new Store();
      const r = await gatewayExecute(deps(net.fetch, realGuard(rest), new Authority(), store, policy(p)), "jwt-a", ideas());
      assert.deepEqual([r.ok, !r.ok && r.code, net.calls.length], [false, "QUOTA_EXCEEDED", 0], `${p} ${reason}`);
      const [row] = [...store.rows.values()];
      assert.equal(row.outcome?.ok === false && row.outcome.code, "BUDGET_DENIED", `${p} ${reason}`);
    }
    const rest = new FakeLedgerRest();
    const net = recordingFetch((c, i, init) => {
      rest.fault = { ai_ledger_reserve: "network" }; // the ledger goes away after the first request
      return refused429(p)(c, i, init);
    });
    const second = new Store();
    const r = await gatewayExecute(deps(net.fetch, realGuard(rest), new Authority(), second, policy(p, { maxAttempts: 2 })), "jwt-a", ideas());
    assert.deepEqual([r.ok, !r.ok && r.code, r.audit, net.calls.length], [false, "UNKNOWN", null, 1], p);
    assert.equal([...second.rows.values()][0].outcome, null, `${p}: nothing recorded`);
    assert.deepEqual(rest.calls, ["reserve", "mark_sent", "settle", "reserve"], p);
  }
});

Deno.test("GAP-3 fixed: the stored outcome is the call store's nine-key audit (feature app:feature, role, policyVersion); replay checks every field and refuses a tampered or foreign one (UNKNOWN, nothing sent)", async () => {
  const net = recordingFetch(ok("どうぞ").openai);
  const store = new Store();
  const pol = policy("openai");
  const d = deps(net.fetch, new RecordingLedger(), new Authority(), store, pol);
  const first = await gatewayExecute(d, "jwt-a", ideas());
  assert.equal(first.ok, true);
  const [row] = [...store.rows.values()];
  assert.deepEqual(row.outcome?.audit, {
    callId: first.audit!.callKey,
    tenantTag: first.audit!.tenantTag,
    feature: "postona:ideas",
    role: "postona.ideas",
    model: "gpt-6-luna",
    policyVersion: "r1",
    attempts: 1,
    estimatedCostUsd: first.audit!.estimatedCostUsd,
    costBasis: "measured",
  });
  assert.deepEqual(await gatewayExecute(d, "jwt-a", ideas()), first, "the GatewayAudit is rebuilt exactly");
  const original = structuredClone(row.outcome!);
  const tampered: Array<[string, (o: Record<string, unknown>) => void]> = [
    ["role", (o) => (o.audit as Record<string, unknown>).role = "postona.consult"],
    ["policyVersion", (o) => (o.audit as Record<string, unknown>).policyVersion = "r0"],
    ["feature", (o) => (o.audit as Record<string, unknown>).feature = "postona:consult"],
    ["model", (o) => (o.audit as Record<string, unknown>).model = "claude-haiku-5-5"],
    ["callId", (o) => (o.audit as Record<string, unknown>).callId = "h5m2_" + "0".repeat(64)],
    ["extra audit key", (o) => (o.audit as Record<string, unknown>).app = "postona"],
    ["gateway audit shape", (o) => o.audit = first.audit],
    ["attempts > maxAttempts", (o) => (o.audit as Record<string, unknown>).attempts = 2],
    ["attempts vs cost basis", (o) => (o.audit as Record<string, unknown>).costBasis = "no_request"],
    ["negative cost", (o) => (o.audit as Record<string, unknown>).estimatedCostUsd = -1],
    ["public code stored", (o) => { o.ok = false; delete o.data; o.code = "QUOTA_EXCEEDED"; }],
    ["extra result key", (o) => o.extra = 1],
  ];
  for (const [label, mutate] of tampered) {
    const o = structuredClone(original) as unknown as Record<string, unknown>;
    mutate(o);
    row.outcome = o as unknown as StoredOutcome;
    const r = await gatewayExecute(d, "jwt-a", ideas());
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "UNKNOWN"], label);
  }
  assert.equal(net.calls.length, 1, "never resent");
  // A new policy revision is another operation content: the same operation id is refused, not replayed or resent.
  row.outcome = original;
  const bumped = deps(net.fetch, new RecordingLedger(), new Authority(), store, { ...pol, revision: "r2" });
  const r = await gatewayExecute(bumped, "jwt-a", ideas());
  assert.deepEqual([r.ok, !r.ok && r.code, net.calls.length], [false, "OPERATION_REUSED", 1]);
});

Deno.test("GAP-3 fixed: a policy without a usable revision or store role is refused before anything happens", async () => {
  for (const over of [{ revision: "" }, { revision: undefined as unknown as string }, { revision: "r 1" }, { logicalRole: "bad role" }]) {
    const net = recordingFetch(ok("どうぞ").openai);
    const ledger = new RecordingLedger();
    const store = new Store();
    const r = await gatewayExecute(deps(net.fetch, ledger, new Authority(), store, policy("openai", over)), "jwt-a", ideas());
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "POLICY_MISSING"], JSON.stringify(over));
    assert.deepEqual([net.calls.length, ledger.events.length, store.rows.size], [0, 0, 0]);
  }
});

Deno.test("real ledger guard: a failed settle does not change the answer; the ledger keeps the attempt open (sent) for its recovery, which charges the upper bound", async () => {
  for (const p of PROVIDERS) {
    const rest = new FakeLedgerRest();
    rest.fault = { ai_ledger_settle: 500 };
    const net = recordingFetch(ok("どうぞ")[p]);
    const r = await gatewayExecute(deps(net.fetch, realGuard(rest), new Authority(), new Store(), policy(p)), "jwt-a", ideas());
    assert.equal(r.ok, true, p);
    assert.equal(r.audit?.costBasis, "measured", `${p}: the answer's audit is a copy, the ledger stays the source of truth`);
    assert.deepEqual(rest.calls, ["reserve", "mark_sent", "settle"], p);
    assert.deepEqual([...rest.status.values()], ["sent"], p);
    assert.equal(net.calls.length, 1, p);
  }
});

Deno.test("the ledger sees only the person (no brand slug, no app-level brand) and the provider sees neither the person nor the slug, for both providers", async () => {
  for (const p of PROVIDERS) {
    const rest = new FakeLedgerRest();
    const bodies: unknown[] = [];
    const inner = rest.fetch;
    const spy: FetchLike = (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return inner(input, init);
    };
    const key = resolveSecret("CONFORMANCE_LEDGER_KEY", () => "local-conformance-key-not-a-secret");
    assert.ok(key.ok);
    const guard = new SupabaseLedgerBudgetGuard({ supabaseUrl: "http://127.0.0.1:9", serviceKey: key.value, fetch: spy });
    const net = recordingFetch(ok("どうぞ")[p]);
    const r: GatewayResult = await gatewayExecute(deps(net.fetch, guard, new Authority(), new Store(), policy(p)), "jwt-a", ideas());
    assert.equal(r.ok, true);
    const reserve = (bodies[0] as { p: Record<string, unknown> }).p;
    assert.deepEqual([reserve.application, reserve.feature, reserve.subject_kind, reserve.user_id, "brand_id" in reserve], ["postona", "ideas", "user", USER_A, false], p);
    assert.equal(reserve.request_id, r.audit?.callKey, `${p}: the ledger request_id is the gateway call key`);
    const sent = JSON.stringify(net.calls.map((c) => c.body));
    assert.equal(sent.includes(USER_A) || sent.includes(BRAND_A.slug), false, `${p}: no person / brand id in the provider request`);
    assert.equal(JSON.stringify(bodies).includes(BRAND_A.slug), false, `${p}: no brand slug in the ledger`);
  }
});
