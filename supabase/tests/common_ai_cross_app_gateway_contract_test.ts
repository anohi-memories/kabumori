// OFFLINE contract tests of the cross-app common AI gateway (no network, fake keys): synthetic authority verdicts,
// app feature policies, a fake provider, the REAL shared provider (executeAiRequest), a recording ledger guard and an
// in-memory call store with the durable store's semantics. Every PASS here is a mock PASS: the managed runtime,
// G5's real verdicts, the production ledger rows and the call store's production application are NOT_VERIFIED.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS supabase/tests/common_ai_cross_app_gateway_contract_test.ts
import assert from "node:assert/strict";
import {
  type BudgetCallContext,
  type BudgetGuard,
  type BudgetReservation,
  type BudgetSettlement,
  InMemoryBudgetGuard,
} from "../functions/_shared/ai_provider/budget.ts";
import { jsonResponse, openAiBody, recordingFetch, type Responder } from "../functions/_shared/ai_provider/test_support.ts";
import {
  type AppId,
  type AuthorityPort,
  type AuthVerdict,
  type CallClaim,
  type CallIdentity,
  type CallStore,
  type FeaturePolicy,
  gatewayExecute,
  type GatewaySubject,
  policyKey,
  type StoredOutcome,
} from "./common_ai_cross_app_gateway_reference.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BRAND_A = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const BRAND_B = { app: "postona" as const, slug: "u_0b1c2d3e4f5061728394a5b6" };
const FAKE_OPENAI_KEY = "test-openai-key-NOT-REAL-0000000000";
const HOUR = 3_600_000;

const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };
function policy(app: AppId, feature: string, over: Partial<FeaturePolicy> = {}): FeaturePolicy {
  return {
    app,
    feature,
    ledgerFeature: feature.replace(/\./g, "_"),
    logicalRole: `${app}.${feature}`,
    provider: "openai",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    maxOutputTokens: 300,
    timeoutMs: 20_000,
    maxAttempts: 1,
    maxCostUsdPerOperation: 0.05,
    maxInputBytes: 8_000,
    subjectKinds: ["user"],
    brandRequired: false,
    systemInstructions: `Answer for ${app} ${feature} as JSON { reply }.`,
    schema: SCHEMA,
    validate: (p) => typeof (p as { reply?: unknown })?.reply === "string" && !(p as { reply: string }).reply.includes("FORBIDDEN"),
    ...over,
  };
}
const POLICIES = new Map<string, FeaturePolicy>([
  [policyKey("kabumori", "market_report"), policy("kabumori", "market_report", { subjectKinds: ["system"] })],
  [policyKey("postona", "consult"), policy("postona", "consult", { brandRequired: true })],
  [policyKey("postona", "ideas"), policy("postona", "ideas")],
  // miseiro: no policy registered yet -> every call is refused.
]);

const user = (userId: string, brand: typeof BRAND_A | null): GatewaySubject => ({ kind: "user", app: "postona", userId, brand });
const allow = (subject: GatewaySubject, generation = "epoch-1"): AuthVerdict => ({ decision: "allow", subject, generation, expiresAtMs: Date.now() + HOUR });
const VERDICTS: Record<string, AuthVerdict | Error> = {
  "jwt-a": allow(user(USER_A, BRAND_A)),
  "jwt-b": allow(user(USER_B, BRAND_B)),
  "cron-kabumori": allow({ kind: "system", app: "kabumori" }),
  "jwt-denied": { decision: "deny", subject: user(USER_A, BRAND_A), generation: "epoch-1", expiresAtMs: Date.now() + HOUR, reason: "SERVICE_NOT_ACTIVE" },
  "jwt-unknown": { decision: "unknown", subject: user(USER_A, BRAND_A), generation: "epoch-1", expiresAtMs: Date.now() + HOUR },
  "jwt-pending": { decision: "pending", subject: user(USER_A, BRAND_A), generation: "epoch-1", expiresAtMs: Date.now() + HOUR },
  "jwt-expired": { ...allow(user(USER_A, BRAND_A)), expiresAtMs: Date.now() - 1 },
  "jwt-unavailable": new Error("authority down"),
  "jwt-wrong-app": allow({ kind: "user", app: "kabumori", userId: USER_A, brand: null } as GatewaySubject),
  "jwt-slug-as-user": allow({ kind: "user", app: "postona", userId: BRAND_A.slug, brand: BRAND_A } as GatewaySubject),
  "jwt-no-generation": { ...allow(user(USER_A, BRAND_A)), generation: "" },
  "jwt-a-no-brand": allow(user(USER_A, null)),
  "jwt-kabumori-user": allow({ kind: "user", app: "kabumori", userId: USER_A, brand: null }),
};

class Authority implements AuthorityPort {
  readonly scopes: unknown[] = [];
  rechecks = 0;
  /** What the recheck answers: the same verdict (default), or a changed one. */
  next: ((prior: AuthVerdict) => AuthVerdict | Error) | null = null;
  verdict(credential: unknown, scope: unknown): Promise<AuthVerdict> {
    this.scopes.push(scope);
    const v = VERDICTS[String(credential)];
    if (!v) return Promise.resolve({ decision: "deny", subject: user(USER_A, null), generation: "x", expiresAtMs: Date.now() + HOUR });
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(structuredClone(v));
  }
  recheck(prior: AuthVerdict): Promise<AuthVerdict> {
    this.rechecks++;
    const v = this.next ? this.next(prior) : prior;
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(structuredClone(v));
  }
}

class Store implements CallStore {
  readonly rows = new Map<string, { identity: CallIdentity; context: unknown; owner: string; state: "acquired" | "complete"; outcome: StoredOutcome | null }>();
  failNextComplete = false;
  private n = 0;
  claim(identity: CallIdentity, context: unknown): Promise<CallClaim> {
    const row = this.rows.get(identity.key);
    if (!row) {
      const owner = `owner-${++this.n}`;
      this.rows.set(identity.key, { identity, context, owner, state: "acquired", outcome: null });
      return Promise.resolve({ kind: "acquired", owner });
    }
    if (row.identity.tenantTag !== identity.tenantTag || row.identity.fingerprint !== identity.fingerprint) return Promise.resolve({ kind: "conflict" });
    if (row.state === "acquired") return Promise.resolve({ kind: "busy" });
    return Promise.resolve({ kind: "complete", fingerprint: row.identity.fingerprint, outcome: structuredClone(row.outcome!) });
  }
  complete(identity: CallIdentity, owner: string, outcome: StoredOutcome): Promise<void> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      return Promise.reject(new Error("response_lost"));
    }
    const row = this.rows.get(identity.key);
    if (!row || row.owner !== owner || row.state !== "acquired") return Promise.reject(new Error("fenced"));
    row.state = "complete";
    row.outcome = structuredClone(outcome);
    return Promise.resolve();
  }
}

class Ledger implements BudgetGuard {
  readonly inner: InMemoryBudgetGuard;
  readonly events: string[] = [];
  readonly contexts: BudgetCallContext[] = [];
  readonly settlements: Array<BudgetSettlement | undefined> = [];
  constructor(maxCalls = 100) {
    this.inner = new InMemoryBudgetGuard([
      { id: "kabumori", scope: { application: "kabumori" }, maxCalls, maxUsdPerCall: 0.05 },
      { id: "postona", scope: { application: "postona" }, maxCalls, maxUsdPerCall: 0.05 },
      { id: "miseiro", scope: { application: "miseiro" }, maxCalls, maxUsdPerCall: 0.05 },
    ]);
  }
  async reserve(c: BudgetCallContext, upper: number) {
    const d = await this.inner.reserve(c, upper);
    this.events.push(d.allowed ? "reserve" : "deny");
    if (d.allowed) this.contexts.push(c);
    return d;
  }
  markSent(_r: BudgetReservation) {
    this.events.push("mark_sent");
    return Promise.resolve();
  }
  async settle(r: BudgetReservation, cost: number, s?: BudgetSettlement) {
    this.events.push(`settle:${s?.costBasis ?? "?"}`);
    this.settlements.push(s);
    await this.inner.settle(r, cost);
  }
  release(_r: BudgetReservation) {
    this.events.push("release");
    return Promise.resolve();
  }
}

function world(options: { respond?: Responder; maxCalls?: number; policies?: Map<string, FeaturePolicy> } = {}) {
  const provider = recordingFetch(options.respond ?? (() => jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }))));
  const authority = new Authority();
  const ledger = new Ledger(options.maxCalls);
  const store = new Store();
  const deps = {
    authority,
    policies: options.policies ?? POLICIES,
    provider: {
      readEnv: (name: string) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : undefined),
      fetch: provider.fetch,
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
    budget: ledger,
    store,
  };
  const run = (credential: string, request: Record<string, unknown>) => gatewayExecute(deps, credential, request);
  /** Nothing happened at all: no provider request, no ledger reservation, no claim. */
  const untouched = () => provider.calls.length === 0 && ledger.contexts.length === 0 && store.rows.size === 0;
  return { run, provider, authority, ledger, store, untouched };
}
const consult = (over: Record<string, unknown> = {}) => ({ app: "postona", feature: "consult", operationId: "op-0000000001", input: "今日何投稿しよう", brand: BRAND_A, ...over });
const report = (over: Record<string, unknown> = {}) => ({ app: "kabumori", feature: "market_report", operationId: "run-2026-10-19-close", input: "市況のデータ", brand: null, ...over });

Deno.test("each app through the same gateway: Kabumori system work and a POSTONA person, attributed to the right app, subject and feature", async () => {
  const w = world();
  const k = await w.run("cron-kabumori", report());
  const p = await w.run("jwt-a", consult());
  assert.equal(k.ok, true);
  assert.equal(p.ok, true);
  assert.deepEqual(p.ok && p.data, { reply: "ok" });
  assert.equal(w.provider.calls.length, 2);
  assert.deepEqual(w.ledger.contexts.map((c) => [c.application, c.feature, c.logicalRole, JSON.stringify(c.subject)]), [
    ["kabumori", "market_report", "kabumori.market_report", JSON.stringify({ kind: "system" })],
    ["postona", "consult", "postona.consult", JSON.stringify({ kind: "user", userId: USER_A, brandId: null })],
  ]);
  assert.deepEqual(w.ledger.events, ["reserve", "mark_sent", "settle:measured", "reserve", "mark_sent", "settle:measured"]);
  assert.equal(w.authority.rechecks, 2, "one recheck right before each provider request");
  // The brand slug and the person's id never reach the provider; the slug never becomes a ledger brand_id.
  const sent = JSON.stringify(w.provider.calls.map((c) => c.body));
  for (const s of [USER_A, BRAND_A.slug, "jwt-a"]) assert.ok(!sent.includes(s), `not sent: ${s}`);
  assert.ok(w.ledger.contexts.every((c) => !JSON.stringify(c).includes(BRAND_A.slug)));
});

Deno.test("an app without a registered policy, a feature that is not registered, a subject the policy does not allow: refused, nothing happens", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["jwt-a", consult({ app: "miseiro", feature: "consult", brand: null }), "AUTH_SCOPE_MISMATCH"],
    ["jwt-a", consult({ feature: "post_generation" }), "POLICY_MISSING"],
    ["cron-kabumori", report({ app: "kabumori", feature: "consult" }), "POLICY_MISSING"],
    ["jwt-a-no-brand", consult({ brand: null }), "POLICY_SUBJECT_DENIED"],
  ];
  for (const [credential, request, code] of cases) {
    const w = world();
    const r = await w.run(credential, request);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, code], `${credential} ${JSON.stringify(request)}`);
    assert.ok(w.untouched(), `${code}: nothing happened`);
  }
  // A Miseiro system job (its own authority) with no Miseiro policy registered: fail closed.
  const w = world();
  VERDICTS["cron-miseiro"] = allow({ kind: "system", app: "miseiro" });
  const r = await w.run("cron-miseiro", { app: "miseiro", feature: "daily_digest", operationId: "run-0000000001", input: "x", brand: null });
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "POLICY_MISSING"]);
  assert.ok(w.untouched());
});

Deno.test("authority: deny / unknown / pending / expired / unavailable / wrong app / a slug as the user id / no generation -> refused, nothing happens", async () => {
  const cases: Array<[string, string]> = [
    ["jwt-denied", "AUTH_DENIED"],
    ["jwt-unknown", "AUTH_UNKNOWN"],
    ["jwt-pending", "AUTH_PENDING"],
    ["jwt-expired", "AUTH_EXPIRED"],
    ["jwt-unavailable", "AUTH_UNAVAILABLE"],
    ["jwt-wrong-app", "AUTH_SCOPE_MISMATCH"],
    ["jwt-slug-as-user", "AUTH_SCOPE_MISMATCH"],
    ["jwt-no-generation", "AUTH_UNKNOWN"],
    ["forged", "AUTH_DENIED"],
  ];
  for (const [credential, code] of cases) {
    const w = world();
    const r = await w.run(credential, consult());
    assert.deepEqual([r.ok, !r.ok && r.code], [false, code], credential);
    assert.ok(w.untouched(), `${credential}: nothing happened`);
  }
  // The request's brand is a selector: a brand the authority did not approve is refused.
  const w = world();
  const r = await w.run("jwt-a", consult({ brand: BRAND_B }));
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "AUTH_SCOPE_MISMATCH"]);
  assert.ok(w.untouched());
});

Deno.test("the request cannot choose: unknown keys (model, provider, user, subject, limits), a bad operation id or an oversized input -> refused before the authority", async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...consult(), model: "gpt-6.1-sol" },
    { ...consult(), provider: "anthropic" },
    { ...consult(), userId: USER_B },
    { ...consult(), maxCostUsd: 10 },
    consult({ operationId: "op" }),
    consult({ operationId: "op 0000000001" }),
    consult({ brand: { app: "postona", slug: USER_A } }),
    consult({ brand: { app: "kabumori", slug: "u_ae343f5caedb67d4af33fc7a" } }),
    consult({ app: "other" }),
  ];
  for (const request of cases) {
    const w = world();
    const r = await w.run("jwt-a", request);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "REQUEST_INVALID"], JSON.stringify(request));
    assert.equal(w.authority.scopes.length, 0, "the authority is not even asked");
    assert.ok(w.untouched());
  }
  const w = world();
  const big = await w.run("jwt-a", consult({ input: "あ".repeat(3000) }));
  assert.deepEqual([big.ok, !big.ok && big.code], [false, "REQUEST_INVALID"]);
  assert.ok(w.untouched());
});

Deno.test("cost and quota: an operation whose upper bound exceeds the policy is refused before any reservation; a full quota sends nothing", async () => {
  const tight = new Map(POLICIES);
  tight.set(policyKey("postona", "consult"), policy("postona", "consult", { brandRequired: true, maxCostUsdPerOperation: 0.0000001 }));
  const w = world({ policies: tight });
  const r = await w.run("jwt-a", consult());
  assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis], [false, "COST_DENIED", "no_request"]);
  assert.ok(w.untouched());

  const q = world({ maxCalls: 0 });
  const first = await q.run("jwt-a", consult());
  assert.deepEqual([first.ok, !first.ok && first.code], [false, "QUOTA_EXCEEDED"]);
  assert.equal(q.provider.calls.length, 0);
  assert.deepEqual(q.ledger.events, ["deny"]);
  assert.deepEqual(await q.run("jwt-a", consult()), first, "the same operation replays the stored refusal");
  assert.deepEqual(q.ledger.events, ["deny"], "the ledger is not asked again");
});

Deno.test("recheck right before the provider: a revoked, changed (generation / subject), expired or unreadable answer stops the send and releases the reservation", async () => {
  const changes: Array<[string, (p: AuthVerdict) => AuthVerdict | Error]> = [
    ["revoked", (p) => ({ ...p, decision: "deny" })],
    ["pending", (p) => ({ ...p, decision: "pending" })],
    ["new generation", (p) => ({ ...p, generation: "epoch-2" })],
    ["other subject", (p) => ({ ...p, subject: user(USER_B, BRAND_B) })],
    ["expired", (p) => ({ ...p, expiresAtMs: Date.now() - 1 })],
    ["unreadable", () => new Error("down")],
  ];
  for (const [label, next] of changes) {
    const w = world();
    w.authority.next = next;
    const r = await w.run("jwt-a", consult());
    assert.deepEqual([r.ok, !r.ok && r.code, r.audit?.costBasis], [false, "AUTH_REVOKED_BEFORE_SEND", "no_request"], label);
    assert.equal(w.provider.calls.length, 0, `${label}: nothing sent`);
    assert.deepEqual(w.ledger.events, ["reserve", "release"], `${label}: reserved, then released, never marked sent`);
    // A replay of the same operation only knows that nothing was sent.
    w.authority.next = null;
    const again = await w.run("jwt-a", consult());
    assert.deepEqual([again.ok, !again.ok && again.code], [false, "NOT_SENT"], label);
    assert.equal(w.provider.calls.length, 0);
  }
});

Deno.test("idempotency: a replay returns the stored answer (one request, one charge); other content with the same operation id is refused; concurrent duplicates send once", async () => {
  const w = world();
  const first = await w.run("jwt-a", consult());
  assert.deepEqual(await w.run("jwt-a", consult()), first);
  assert.equal(w.provider.calls.length, 1);
  assert.equal(w.ledger.contexts.length, 1);
  const drift = await w.run("jwt-a", consult({ input: "別の内容" }));
  assert.deepEqual([drift.ok, !drift.ok && drift.code], [false, "OPERATION_REUSED"]);
  assert.equal(w.provider.calls.length, 1);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const c = world({
    respond: async () => {
      await gate;
      return jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" }));
    },
  });
  const one = c.run("jwt-a", consult());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const two = await c.run("jwt-a", consult());
  release();
  assert.deepEqual([two.ok, !two.ok && two.code], [false, "IN_PROGRESS"]);
  assert.equal((await one).ok, true);
  assert.equal(c.provider.calls.length, 1);
});

Deno.test("cross-app / cross-user / cross-brand: the same operation id is another call, another key and another charge; no stored answer crosses over", async () => {
  const w = world({ respond: (_c, i) => jsonResponse(200, openAiBody({ reply: `answer-${i}` }, { model: "gpt-6-luna" })) });
  const a = await w.run("jwt-a", consult({ operationId: "shared-op-0001" }));
  const b = await w.run("jwt-b", consult({ operationId: "shared-op-0001", brand: BRAND_B }));
  const k = await w.run("cron-kabumori", report({ operationId: "shared-op-0001" }));
  assert.deepEqual([a.ok && a.data, b.ok && b.data, k.ok && k.data], [{ reply: "answer-0" }, { reply: "answer-1" }, { reply: "answer-2" }]);
  const keys = new Set([a, b, k].map((r) => r.audit?.callKey));
  assert.equal(keys.size, 3);
  assert.equal(w.store.rows.size, 3);
  assert.equal(w.provider.calls.length, 3);
  assert.deepEqual(w.ledger.contexts.map((c) => c.application), ["postona", "postona", "kabumori"]);
  // Replays stay with their own tenant.
  const bAgain = await w.run("jwt-b", consult({ operationId: "shared-op-0001", brand: BRAND_B }));
  assert.deepEqual(bAgain.ok && bAgain.data, { reply: "answer-1" });
  assert.equal(w.provider.calls.length, 3);
});

Deno.test("timeout / connection lost: charged at the upper bound once, stored UNKNOWN, never resent; a lost record stays IN_PROGRESS", async () => {
  const w = world({ respond: () => Promise.reject(new TypeError("connection reset")) });
  const first = await w.run("jwt-a", consult());
  assert.deepEqual([first.ok, !first.ok && first.code, first.audit?.costBasis], [false, "UNKNOWN", "includes_upper_bound"]);
  assert.deepEqual(w.ledger.events, ["reserve", "mark_sent", "settle:upper_bound"]);
  assert.deepEqual(await w.run("jwt-a", consult()), first);
  assert.equal(w.provider.calls.length, 1, "never resent");
  assert.equal(w.ledger.events.filter((e) => e.startsWith("settle")).length, 1, "never billed twice");

  const l = world();
  l.store.failNextComplete = true;
  const lost = await l.run("jwt-a", consult());
  assert.deepEqual([lost.ok, !lost.ok && lost.code], [false, "UNKNOWN"]);
  const busy = await l.run("jwt-a", consult());
  assert.deepEqual([busy.ok, !busy.ok && busy.code], [false, "IN_PROGRESS"]);
  assert.equal(l.provider.calls.length, 1);
});

Deno.test("model errors: provider failure, malformed output and an output the app refuses are final for the operation (no resend, one charge)", async () => {
  const cases: Array<[Responder, string]> = [
    [() => jsonResponse(400, { error: { type: "invalid_request_error", message: "bad" } }), "PROVIDER_FAILED"],
    [() => jsonResponse(200, openAiBody({ wrong: 1 }, { model: "gpt-6-luna" })), "OUTPUT_REJECTED"],
    [() => jsonResponse(200, openAiBody({ reply: "FORBIDDEN content" }, { model: "gpt-6-luna" })), "OUTPUT_REJECTED"],
  ];
  for (const [respond, code] of cases) {
    const w = world({ respond });
    const first = await w.run("jwt-a", consult());
    assert.deepEqual([first.ok, !first.ok && first.code], [false, code]);
    assert.deepEqual(await w.run("jwt-a", consult()), first);
    assert.equal(w.provider.calls.length, 1, `${code}: never resent`);
    assert.equal(w.ledger.contexts.length, 1, `${code}: one reservation`);
  }
});

Deno.test("scope edges: a verdict for another app on a brand-free feature, a person on a system-only feature, a mis-registered policy or one without its app check: refused, nothing happens", async () => {
  let w = world();
  let r = await w.run("jwt-wrong-app", { app: "postona", feature: "ideas", operationId: "op-0000000009", input: "x", brand: null });
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "AUTH_SCOPE_MISMATCH"]);
  assert.ok(w.untouched());

  w = world();
  r = await w.run("jwt-kabumori-user", report());
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "POLICY_SUBJECT_DENIED"]);
  assert.ok(w.untouched());

  const misregistered = new Map(POLICIES);
  misregistered.set(policyKey("postona", "consult"), policy("kabumori", "consult", { brandRequired: true }));
  w = world({ policies: misregistered });
  r = await w.run("jwt-a", consult());
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "POLICY_MISSING"]);
  assert.ok(w.untouched());

  const unchecked = new Map(POLICIES);
  unchecked.set(policyKey("postona", "consult"), { ...policy("postona", "consult", { brandRequired: true }), validate: undefined } as unknown as FeaturePolicy);
  w = world({ policies: unchecked });
  r = await w.run("jwt-a", consult());
  assert.deepEqual([r.ok, !r.ok && r.code], [false, "POLICY_MISSING"]);
  assert.ok(w.untouched());
});
