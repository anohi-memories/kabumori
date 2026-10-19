// OFFLINE tests of the G6-06 UNKNOWN recovery coordinator (supabase/ai_gateway/recovery.ts) with a fake RPC port: which
// RPCs it may call, how it classifies each candidate, what audit it would close with, and how it treats every answer.
// The real SQL (ledger + ai_calls) is exercised by common_ai_gateway_recovery_pg_test.ts. No network.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net --deny-write \
//     supabase/tests/common_ai_gateway_recovery_test.ts
import assert from "node:assert/strict";
import { type FeaturePolicy, policyKey } from "../ai_gateway/gateway.ts";
import { definePolicyRegistry } from "../ai_gateway/policy_registry.ts";
import { longestRunMs, reconcileUnknownCalls, type RecoveryRpc } from "../ai_gateway/recovery.ts";

const SCHEMA = { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } };
const policy = (app: FeaturePolicy["app"], feature: string, over: Partial<FeaturePolicy> = {}): FeaturePolicy => ({
  app, feature, revision: "r7", ledgerFeature: feature, logicalRole: `${app}.${feature}`, provider: "openai", model: "gpt-6-luna",
  reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000, maxAttempts: 2, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000,
  subjectKinds: ["user"], brandRequired: false, systemInstructions: "JSON { reply }.", schema: SCHEMA,
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string", ...over,
});
const REGISTRY = definePolicyRegistry([
  policy("postona", "ideas"),
  policy("kabumori", "market_report", { subjectKinds: ["system"], provider: "anthropic", model: "claude-haiku-5-5" }),
  policy("postona", "long", { timeoutMs: 600_000, maxAttempts: 3, maxCostUsdPerOperation: 0.2 }),
]);
const NOW = Date.parse("2026-10-20T00:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
let n = 0;
const key = () => "h5m2_" + (++n).toString(16).padStart(64, "0");
const candidate = (over: Record<string, unknown> = {}) => ({
  call_key: key(), tenant_tag: "a".repeat(64), application: "postona", feature: "postona:ideas", subject_kind: "user", created_at: ago(3600),
  open_attempts: 0, sent_attempts: 1, estimated_cost_usd: 0.0123, includes_upper_bound: false, models: ["gpt-6-luna"], logical_roles: ["postona.ideas"], ...over,
});

/** A fake port: records every call; answers recover_stale, the listed candidates and per-key abandon answers. */
function fake(candidates: unknown[], abandon: (p: Record<string, unknown>) => unknown = () => ({ abandoned: true })) {
  const calls: Array<[string, unknown]> = [];
  const rpc: RecoveryRpc = (name, p) => {
    calls.push([name, structuredClone(p)]);
    if (name === "ai_ledger_recover_stale") return Promise.resolve({ released: 2, marked_unknown: 1 });
    if (name === "ai_calls_recovery_candidates") return Promise.resolve(structuredClone(candidates));
    if (name === "ai_calls_abandon") {
      try {
        return Promise.resolve(abandon(p as Record<string, unknown>));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.reject(new Error("unexpected"));
  };
  return { rpc, calls };
}
const run = (rpc: RecoveryRpc, mode: "advise" | "apply" = "apply") => reconcileUnknownCalls(rpc, REGISTRY, { mode, nowMs: () => NOW });

Deno.test("advise mode writes nothing: only the candidate list is read; apply = recover_stale, candidates, then abandon per closable row", async () => {
  const rows = [candidate(), candidate({ sent_attempts: 0, estimated_cost_usd: 0, models: [], logical_roles: [] })];
  const a = fake(rows);
  const advised = await run(a.rpc, "advise");
  assert.deepEqual(a.calls.map(([name]) => name), ["ai_calls_recovery_candidates"]);
  assert.deepEqual([advised.recovered, advised.candidates.map((c) => c.outcome)], [null, ["WOULD_ABANDON", "WOULD_ABANDON"]]);
  const b = fake(rows);
  const applied = await run(b.rpc);
  assert.deepEqual(b.calls.map(([name]) => name), ["ai_ledger_recover_stale", "ai_calls_recovery_candidates", "ai_calls_abandon", "ai_calls_abandon"]);
  assert.deepEqual([applied.recovered, applied.candidates.map((c) => c.outcome)], [{ released: 2, marked_unknown: 1 }, ["ABANDONED", "ABANDONED"]]);
  assert.deepEqual(b.calls[1][1], { older_than_seconds: 1800, limit: 100 });
});

Deno.test("classification from the ledger: no sent attempt = NOT_SENT_PROVEN (still only an UNKNOWN close: BLOCKED_SQL), measured = RESULT_LOST, upper bound = POSSIBLY_SENT; the audit never shows less than the ledger", async () => {
  const notSent = candidate({ sent_attempts: 0, estimated_cost_usd: 0, models: [], logical_roles: [] });
  const lost = candidate({ sent_attempts: 2, estimated_cost_usd: 0.012345671 });
  const maybe = candidate({ sent_attempts: 1, estimated_cost_usd: "0.03000000", includes_upper_bound: true });
  const f = fake([notSent, lost, maybe]);
  const r = await run(f.rpc);
  assert.deepEqual(r.candidates.map((c) => [c.classification, c.outcome, c.detail, c.attempts, c.costUsd]), [
    ["NOT_SENT_PROVEN", "ABANDONED", "BLOCKED_SQL_NO_NOT_SENT_CLOSE", 0, 0],
    ["RESULT_LOST", "ABANDONED", null, 2, 0.01234568],
    ["POSSIBLY_SENT", "ABANDONED", null, 1, 0.03],
  ]);
  const audits = f.calls.filter(([name]) => name === "ai_calls_abandon").map(([, p]) => (p as { audit: Record<string, unknown> }).audit);
  assert.deepEqual(audits[0], { callId: notSent.call_key, tenantTag: "a".repeat(64), feature: "postona:ideas", role: "postona.ideas", model: "gpt-6-luna", policyVersion: "r7", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" });
  assert.deepEqual([audits[1].costBasis, audits[1].estimatedCostUsd, audits[2].costBasis], ["measured", 0.01234568, "includes_upper_bound"]);
});

Deno.test("never fences a call that may still be running: younger than the policy's longest possible run (or the SQL age) -> WAIT_MAY_BE_RUNNING, nothing sent to abandon", async () => {
  const long = REGISTRY.get(policyKey("postona", "long"))!;
  assert.equal(longestRunMs(long, 120_000), 600_000 * 3 + 20_000 * 2 + 120_000);
  const rows = [
    candidate({ feature: "postona:long", logical_roles: ["postona.long"], created_at: ago(1900) }), // > 1800 s SQL age, < 1960 s running
    candidate({ feature: "postona:long", logical_roles: ["postona.long"], created_at: ago(2000) }),
    candidate({ created_at: ago(1700) }), // under the SQL age
  ];
  const f = fake(rows);
  const r = await run(f.rpc);
  assert.deepEqual(r.candidates.map((c) => c.outcome), ["WAIT_MAY_BE_RUNNING", "ABANDONED", "WAIT_MAY_BE_RUNNING"]);
  assert.equal(f.calls.filter(([name]) => name === "ai_calls_abandon").length, 1);
});

Deno.test("open ledger attempts wait; unregistered or another app's rows and every impossible state are left alone (UNREGISTERED / ANOMALY), never closed", async () => {
  const rows: unknown[] = [
    candidate({ open_attempts: 1 }),
    candidate({ feature: "miseiro:assistant", application: "miseiro" }),
    candidate({ application: "kabumori" }), // postona:ideas row claimed under another application
    candidate({ subject_kind: "system" }),
    candidate({ models: ["claude-opus-5-5"] }),
    candidate({ logical_roles: ["postona.consult"] }),
    candidate({ sent_attempts: 2, open_attempts: 1 }),
    candidate({ sent_attempts: 0, estimated_cost_usd: 0.01 }),
    candidate({ estimated_cost_usd: 1.5 }),
    candidate({ call_key: "not-a-key" }),
    candidate({ created_at: "yesterday" }),
    { ...candidate(), extra: 1 },
    "nonsense",
  ];
  const f = fake(rows);
  const r = await run(f.rpc);
  assert.deepEqual(r.candidates.map((c) => `${c.outcome}:${c.detail}`), [
    "WAIT_LEDGER_OPEN:1_OPEN",
    "UNREGISTERED:NO_POLICY",
    "UNREGISTERED:APPLICATION_MISMATCH",
    "ANOMALY:SUBJECT_KIND",
    "ANOMALY:LEDGER_MODEL",
    "ANOMALY:LEDGER_ROLE",
    "ANOMALY:ATTEMPTS",
    "ANOMALY:COST_WITHOUT_ATTEMPT",
    "ANOMALY:COST_ABOVE_STORE_LIMIT",
    "ANOMALY:CANDIDATE_IDENTITY",
    "ANOMALY:CANDIDATE_VALUES",
    "ANOMALY:CANDIDATE_SHAPE",
    "ANOMALY:CANDIDATE_SHAPE",
  ]);
  assert.equal(f.calls.filter(([name]) => name === "ai_calls_abandon").length, 0, "nothing closed");
});

Deno.test("abandon answers: too recent / ledger not final wait, closed meanwhile is ALREADY_CLOSED, a refused audit is RETRY_LATER; one failure never stops the others", async () => {
  const rows = Array.from({ length: 6 }, () => candidate());
  const answers: unknown[] = [{ abandoned: false, reason: "TOO_RECENT" }, { abandoned: false, reason: "LEDGER_NOT_FINAL" }, { abandoned: false, reason: "NOT_ACQUIRED" }, { abandoned: false, reason: "NOT_FOUND" }, new Error("AI_CALLS_AUDIT_LEDGER_MISMATCH"), { what: 1 }];
  let i = 0;
  const f = fake(rows, () => {
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return a;
  });
  const r = await run(f.rpc);
  assert.deepEqual(r.candidates.map((c) => c.outcome), ["WAIT_SQL_TOO_RECENT", "WAIT_LEDGER_OPEN", "ALREADY_CLOSED", "ALREADY_CLOSED", "RETRY_LATER", "ANOMALY"]);
});

Deno.test("the port: only the three recovery RPCs can be called; a bad ledger or candidate answer stops before any close; options are checked", async () => {
  const sneaky: RecoveryRpc = () => Promise.resolve([]);
  const names: string[] = [];
  await reconcileUnknownCalls((name, p) => (names.push(name), sneaky(name, p)), REGISTRY, { mode: "advise" });
  assert.deepEqual(names, ["ai_calls_recovery_candidates"]);
  const badLedger = fake([candidate()]);
  const rpc: RecoveryRpc = (name, p) => name === "ai_ledger_recover_stale" ? Promise.resolve({ released: -1 }) : badLedger.rpc(name, p);
  await assert.rejects(reconcileUnknownCalls(rpc, REGISTRY, { mode: "apply" }), /RECOVERY_LEDGER_ANSWER/);
  await assert.rejects(reconcileUnknownCalls(() => Promise.resolve({}), REGISTRY), /RECOVERY_CANDIDATES_ANSWER/);
  for (const bad of [{ mode: "fix" }, { abandonAfterSeconds: 10 }, { limit: 0 }, { marginMs: -1 }]) {
    await assert.rejects(reconcileUnknownCalls(fake([]).rpc, REGISTRY, bad as never));
  }
  // The module text names no other RPC, no provider, no gateway call and no environment.
  const text = await Deno.readTextFile(new URL("../ai_gateway/recovery.ts", import.meta.url));
  const rpcNames = new Set([...text.matchAll(/"(ai_[a-z_]+)"/gu)].map((m) => m[1]));
  assert.deepEqual([...rpcNames].sort(), ["ai_calls_abandon", "ai_calls_recovery_candidates", "ai_ledger_recover_stale"]);
  assert.doesNotMatch(text, /executeAiRequest|gatewayExecute|createAiGateway|\.execute\(|fetch\(|Deno\.|ai_provider/u);
});

Deno.test("idempotent: a second apply run on the same (now closed) state closes nothing more", async () => {
  const rows = [candidate(), candidate({ sent_attempts: 0, estimated_cost_usd: 0, models: [], logical_roles: [] })];
  const closed = new Set<string>();
  const f = fake(rows, (p) => {
    const k = String(p.call_key);
    if (closed.has(k)) return { abandoned: false, reason: "NOT_ACQUIRED" };
    closed.add(k);
    return { abandoned: true };
  });
  const first = await run(f.rpc);
  const second = await run(f.rpc);
  assert.deepEqual([first.candidates.map((c) => c.outcome), second.candidates.map((c) => c.outcome)], [["ABANDONED", "ABANDONED"], ["ALREADY_CLOSED", "ALREADY_CLOSED"]]);
});
