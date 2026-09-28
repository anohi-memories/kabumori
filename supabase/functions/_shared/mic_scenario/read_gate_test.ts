import assert from "node:assert/strict";
import test from "node:test";
import { classifyFreshness, type ScenarioDomain, type StateRow } from "./policy.ts";
import { evaluateScenarioRead, type ScenarioReadInput } from "./read_gate.ts";

const HOUR = 60 * 60 * 1000;
const GEN = Date.parse("2026-09-28T02:00:00Z"); // when the Scenario was generated
const NOW = Date.parse("2026-09-28T13:30:00Z");
const EVALUATED = "2026-09-28T01:15:00.000Z";
const SCENARIO_RUN = "9f9ff0b6-3da8-4b6b-b9f9-a88a998ac056";
const RUN: Record<ScenarioDomain, string> = {
  rates: "f02387cb-b8d8-4bdc-aba1-4407beb38c80",
  macro: "11111111-1111-4111-8111-111111111111",
  equity_index: "3e186bef-f2bb-4ed4-8ced-422825d1fda8",
};
const iso = (ms: number) => new Date(ms).toISOString();

function stateRow(domain: ScenarioDomain, overrides: Record<string, unknown> = {}): StateRow {
  return {
    domain, narrative: `${domain} narrative`, bullish_factors: ["b"], bearish_factors: ["r"], key_risks: ["k"],
    ai_confidence: 0.8, data_confidence: 0.9, coverage_status: "full", observation_status: "fresh",
    ai_evaluated_at: EVALUATED, source_evaluation_run_id: RUN[domain], ...overrides,
  };
}

const snapshotOf = (row: StateRow) => ({
  domain: row.domain, narrative: row.narrative, bullish_factors: row.bullish_factors, bearish_factors: row.bearish_factors,
  key_risks: row.key_risks, ai_confidence: row.ai_confidence, data_confidence: row.data_confidence,
  coverage_status: row.coverage_status, observation_status: row.observation_status,
  ai_evaluated_at: row.ai_evaluated_at, source_evaluation_run_id: row.source_evaluation_run_id,
});

const baseCase = {
  title: "金利と株式の併存", description: "条件付きの基本ケース", supporting_state_domains: ["rates", "equity_index"],
  confirmation_conditions: ["c"], invalidation_conditions: ["i"], watch_items: ["w"],
};
const directional = (title: string) => ({
  title, description: `${title}の場合`, triggers: ["t"], implications: ["m"], invalidation_conditions: ["i"], watch_items: ["w"],
});

type FixtureOptions = {
  domains?: ScenarioDomain[];
  generationStates?: Partial<Record<ScenarioDomain, Record<string, unknown>>>;
  liveStates?: Partial<Record<ScenarioDomain, Record<string, unknown>>> | null;
  confidence?: number;
  aiConfidence?: number;
  assessment?: "assessed" | "indeterminate";
};

// A Scenario exactly as apply_mic_scenario_update would have stored it, plus
// live States (by default unchanged since generation).
function fixture(opts: FixtureOptions = {}): ScenarioReadInput {
  const domains = [...(opts.domains ?? ["rates", "macro", "equity_index"])].sort() as ScenarioDomain[];
  const genRows = domains.map((d) => stateRow(d, opts.generationStates?.[d] ?? {}));
  const validUntil = Math.min(...genRows.map((row) =>
    Date.parse(row.ai_evaluated_at as string) + (row.domain === "macro" ? 840 : 96) * HOUR
  ));
  const pairs = genRows.map((row) => `${row.domain}:${row.source_evaluation_run_id}`).sort();
  const fingerprint = ["mic-scenario-v1", ...pairs].join("|");
  const current = {
    source_scenario_run_id: SCENARIO_RUN,
    assessment_status: opts.assessment ?? "assessed",
    base_case: { ...baseCase, supporting_state_domains: domains.filter((d) => d !== "macro").slice(0, 2) },
    upside_case: directional("上振れ"),
    downside_case: directional("下振れ"),
    state_conflicts: ["conflict"],
    confidence: opts.confidence ?? 0.7,
    ai_confidence: opts.aiConfidence ?? 0.8,
    state_as_of: [...genRows.map((r) => r.ai_evaluated_at as string)].sort()[0],
    valid_until: iso(validUntil),
    source_state_run_ids: genRows.map((row) => row.source_evaluation_run_id),
    source_state_domains: domains,
    input_fingerprint: fingerprint,
    ai_evaluated_at: iso(GEN),
  };
  const evidence = genRows.map((row) => ({
    scenario_run_id: SCENARIO_RUN,
    domain: row.domain,
    state_evaluation_run_id: row.source_evaluation_run_id,
    freshness: classifyFreshness(row.domain as ScenarioDomain, row.ai_evaluated_at, GEN),
    usability: "strong",
    state_snapshot: snapshotOf(row),
  }));
  const live = (["rates", "macro", "equity_index"] as ScenarioDomain[]).map((d) => {
    const generated = genRows.find((row) => row.domain === d);
    const baseRow = generated ?? stateRow(d, { source_evaluation_run_id: null });
    return { ...baseRow, ...(opts.liveStates?.[d] ?? {}) };
  });
  return {
    current,
    run: { id: SCENARIO_RUN, status: "evaluated", input_fingerprint: fingerprint },
    evidence,
    states: live,
  };
}

// ------------------------------------------------------------------ A
test("[A] all three States fresh, strong and unchanged -> usable, content returned", () => {
  const out = evaluateScenarioRead(fixture(), NOW);
  assert.equal(out.status, "usable");
  assert.deepEqual(out.reason_codes, []);
  assert.equal(out.scenario?.base_case.title, "金利と株式の併存");
  assert.equal(out.effective_confidence, 0.7);
  assert.equal(out.stored_confidence, 0.7);
  assert.equal(out.evaluated_at, iso(GEN));
  assert.deepEqual(out.source_domains.map((d) => d.domain), ["equity_index", "macro", "rates"]);
  assert.deepEqual(out.excluded_or_invalid_domains, []);
});

test("[A] recent narrative -> degraded (still returned, reason names the concept and domain)", () => {
  const out = evaluateScenarioRead(fixture(), GEN + 60 * HOUR);
  assert.equal(out.status, "degraded");
  assert.ok(out.reason_codes.includes("narrative_recent:rates"));
  assert.ok(out.reason_codes.includes("narrative_aged:rates"));
  assert.ok(out.scenario);
});

test("contract never exposes internal DB metadata", () => {
  const out = evaluateScenarioRead(fixture(), NOW);
  const text = JSON.stringify(out);
  for (const internal of [SCENARIO_RUN, RUN.rates, "mic-scenario-v1", "input_fingerprint", "ai_model", "ai_cost", "tokens", "rates narrative"]) {
    assert.equal(text.includes(internal), false, internal);
  }
  assert.deepEqual(Object.keys(out).sort(), [
    "effective_confidence", "evaluated_at", "excluded_or_invalid_domains", "reason_codes", "scenario",
    "source_domains", "status", "stored_confidence", "valid_until",
  ]);
});

// ------------------------------------------------------------------ B
test("[B] now >= valid_until -> expired, no content", () => {
  const input = fixture();
  const validUntil = Date.parse(input.current!.valid_until as string);
  const out = evaluateScenarioRead(input, validUntil);
  assert.equal(out.status, "expired");
  assert.deepEqual(out.reason_codes, ["valid_until_passed"]);
  assert.equal(out.scenario, null);
  assert.equal(out.effective_confidence, null);
  assert.equal(evaluateScenarioRead(input, validUntil - 1).status !== "expired", true);
});

test("[B] a stored valid_until later than the evidence allows is invalid, never an extension", () => {
  const input = fixture();
  input.current!.valid_until = iso(Date.parse(input.current!.valid_until as string) + 48 * HOUR);
  assert.deepEqual(evaluateScenarioRead(input, NOW).reason_codes, ["valid_until_inconsistent"]);
});

// ------------------------------------------------------------------ C / D
test("[C] source run missing -> invalid", () => {
  const input = fixture();
  input.run = null;
  assert.deepEqual(evaluateScenarioRead(input, NOW), { ...evaluateScenarioRead(input, NOW), status: "invalid" });
  assert.deepEqual(evaluateScenarioRead(input, NOW).reason_codes, ["source_run_missing"]);
  input.run = { id: "22222222-2222-4222-8222-222222222222", status: "evaluated", input_fingerprint: "x" };
  assert.deepEqual(evaluateScenarioRead(input, NOW).reason_codes, ["source_run_missing"]);
});

test("[D] source run not evaluated -> invalid", () => {
  for (const status of ["running", "failed", "no_change", null]) {
    const input = fixture();
    input.run!.status = status;
    const out = evaluateScenarioRead(input, NOW);
    assert.equal(out.status, "invalid");
    assert.deepEqual(out.reason_codes, [`source_run_not_evaluated:${status}`]);
    assert.equal(out.scenario, null);
  }
  const input = fixture();
  input.run!.input_fingerprint = "mic-scenario-v1|other";
  assert.deepEqual(evaluateScenarioRead(input, NOW).reason_codes, ["fingerprint_mismatch"]);
});

// ------------------------------------------------------------------ E
test("[E] evidence missing, short, malformed or disagreeing with current -> invalid", () => {
  const cases: Array<[(input: ScenarioReadInput) => void, string]> = [
    [(i) => { i.evidence = []; }, "evidence_missing"],
    [(i) => { i.evidence = i.evidence.slice(1); }, "evidence_domain_mismatch"],
    [(i) => { i.evidence = [...i.evidence, i.evidence[0]]; }, "evidence_domain_mismatch"],
    [(i) => { (i.evidence[0].state_snapshot as Record<string, unknown>).extra = 1; }, "evidence_malformed"],
    [(i) => { delete (i.evidence[0].state_snapshot as Record<string, unknown>).key_risks; }, "evidence_malformed"],
    [(i) => { i.evidence[0].scenario_run_id = "22222222-2222-4222-8222-222222222222"; }, "evidence_malformed"],
    [(i) => { i.evidence[0].freshness = "stale"; }, "evidence_malformed"],
    [(i) => { i.current!.source_state_domains = ["macro", "equity_index", "rates"]; }, "evidence_current_run_mismatch:equity_index"],
  ];
  for (const [mutate, reason] of cases) {
    const input = fixture();
    mutate(input);
    const out = evaluateScenarioRead(input, NOW);
    assert.equal(out.status, "invalid", reason);
    assert.ok(out.reason_codes.includes(reason), `${reason}: ${out.reason_codes}`);
  }
});

test("[E] evidence rewritten to another State run (consistent with itself) still fails against current", () => {
  const input = fixture();
  const other = "33333333-3333-4333-8333-333333333333";
  input.evidence[2].state_evaluation_run_id = other;
  (input.evidence[2].state_snapshot as Record<string, unknown>).source_evaluation_run_id = other;
  assert.deepEqual(evaluateScenarioRead(input, NOW).reason_codes, ["evidence_current_run_mismatch:rates"]);
});

// ------------------------------------------------------------------ F
test("[F] live State now carries a different source run -> invalid identity drift", () => {
  const out = evaluateScenarioRead(fixture({ liveStates: { rates: { source_evaluation_run_id: "44444444-4444-4444-8444-444444444444" } } }), NOW);
  assert.equal(out.status, "invalid");
  assert.deepEqual(out.reason_codes, ["state_identity_drift:rates"]);
  assert.deepEqual(out.excluded_or_invalid_domains, [{ domain: "rates", reason: "state_identity_drift" }]);
  assert.equal(out.scenario, null);
});

test("[F] same run but a different narrative timestamp -> invalid; same run text re-save -> not invalid", () => {
  assert.deepEqual(
    evaluateScenarioRead(fixture({ liveStates: { rates: { ai_evaluated_at: "2026-09-28T01:20:00Z" } } }), NOW).reason_codes,
    ["state_identity_drift:rates"],
  );
  const resaved = evaluateScenarioRead(fixture({ liveStates: { rates: { narrative: "same run, text re-saved" } } }), NOW);
  assert.equal(resaved.status, "usable");
});

test("source State row gone or duplicated -> invalid", () => {
  const gone = fixture();
  gone.states = gone.states.filter((row) => row.domain !== "equity_index");
  assert.ok(evaluateScenarioRead(gone, NOW).reason_codes.includes("state_row_missing:equity_index"));
  const dup = fixture();
  dup.states = [...dup.states, stateRow("rates")];
  const out = evaluateScenarioRead(dup, NOW);
  assert.equal(out.status, "invalid");
  assert.deepEqual(out.excluded_or_invalid_domains, [{ domain: "rates", reason: "state_row_duplicated" }]);
});

// ------------------------------------------------------------------ G
test("[G] same run, observation fresh -> stale: re-evaluated as degraded, kept distinct from narrative freshness", () => {
  const out = evaluateScenarioRead(fixture({ liveStates: { rates: { observation_status: "stale" } } }), NOW);
  assert.equal(out.status, "degraded");
  assert.ok(out.reason_codes.includes("observation_stale:rates"));
  assert.ok(out.reason_codes.includes("observation_worsened:rates"));
  const rates = out.source_domains.find((d) => d.domain === "rates")!;
  assert.equal(rates.narrative_freshness, "fresh", "a stale observation does not make the State narrative stale");
  assert.equal(rates.observation_status, "stale");
  assert.equal(rates.quality_changed_since_generation, true);
  assert.equal(out.reason_codes.some((r) => r.startsWith("narrative_stale")), false);
});

test("[G] observation stale at generation and still stale: weak, but not a worsening", () => {
  const out = evaluateScenarioRead(
    fixture({ generationStates: { rates: { observation_status: "stale" } }, liveStates: { rates: { observation_status: "stale" } } }),
    NOW,
  );
  assert.equal(out.status, "degraded");
  assert.ok(out.reason_codes.includes("observation_stale:rates"));
  assert.equal(out.reason_codes.includes("observation_worsened:rates"), false);
  assert.equal(out.source_domains.find((d) => d.domain === "rates")!.quality_changed_since_generation, false);
});

// ------------------------------------------------------------------ H / N / O
test("[H][N] data_confidence drop lowers the effective confidence below the stored one", () => {
  const out = evaluateScenarioRead(fixture({ confidence: 0.7, liveStates: { rates: { data_confidence: 0.5 } } }), NOW);
  assert.equal(out.status, "degraded");
  assert.ok(out.reason_codes.includes("data_confidence_decreased:rates"));
  assert.ok(out.reason_codes.includes("data_confidence_low:rates"));
  assert.ok(out.reason_codes.includes("confidence_cap_lowered"));
  assert.equal(out.stored_confidence, 0.7);
  assert.equal(out.effective_confidence, 0.5);
});

test("[O] a higher dynamic cap never raises confidence above the stored value", () => {
  const out = evaluateScenarioRead(
    fixture({ confidence: 0.4, aiConfidence: 0.9, generationStates: { rates: { data_confidence: 0.5 } }, liveStates: { rates: { data_confidence: 0.95 } } }),
    NOW,
  );
  assert.equal(out.effective_confidence, 0.4);
  assert.equal(out.reason_codes.includes("confidence_cap_lowered"), false);
});

test("data_confidence below the usable floor -> invalid", () => {
  const out = evaluateScenarioRead(fixture({ liveStates: { equity_index: { data_confidence: 0.2 } } }), NOW);
  assert.equal(out.status, "invalid");
  assert.ok(out.reason_codes.includes("state_unusable:equity_index:data_confidence_too_low"));
});

// ------------------------------------------------------------------ I
test("[I] coverage full -> partial: degraded; -> unavailable: invalid", () => {
  const partial = evaluateScenarioRead(fixture({ liveStates: { macro: { coverage_status: "partial" } } }), NOW);
  assert.equal(partial.status, "degraded");
  assert.ok(partial.reason_codes.includes("coverage_partial:macro"));
  assert.ok(partial.reason_codes.includes("coverage_worsened:macro"));
  const unavailable = evaluateScenarioRead(fixture({ liveStates: { macro: { coverage_status: "unavailable" } } }), NOW);
  assert.equal(unavailable.status, "invalid");
  assert.ok(unavailable.reason_codes.includes("state_unusable:macro:coverage_unavailable"));
});

// ------------------------------------------------------------------ J
test("[J] narrative aging: fresh -> recent -> stale follows the shared per-domain limits", () => {
  const evaluated = Date.parse(EVALUATED);
  const input = fixture({ domains: ["rates", "equity_index"] });
  assert.equal(evaluateScenarioRead(input, evaluated + 36 * HOUR).reason_codes.includes("narrative_recent:rates"), false);
  const recent = evaluateScenarioRead(input, evaluated + 36 * HOUR + 1);
  assert.equal(recent.status, "degraded");
  assert.ok(recent.reason_codes.includes("narrative_recent:rates"));
  // recent x0.8 and one missing domain (-0.1): 0.9*0.8-0.1 = 0.62 < stored 0.7
  assert.equal(recent.effective_confidence, 0.62);
  // After 96h the rates narrative is stale; valid_until was derived from it.
  assert.equal(evaluateScenarioRead(input, evaluated + 96 * HOUR).status, "expired");
});

test("[J] macro keeps its own (monthly) limits in the same shared policy", () => {
  const macroOld = "2026-09-20T05:45:00.000Z"; // ~8 days: recent for macro, stale for rates
  const input = fixture({ generationStates: { macro: { ai_evaluated_at: macroOld } } });
  const out = evaluateScenarioRead(input, NOW);
  assert.equal(out.source_domains.find((d) => d.domain === "macro")!.narrative_freshness, "recent");
  assert.ok(out.reason_codes.includes("narrative_recent:macro"));
});

// ------------------------------------------------------------------ K
test("[K] future-dated evidence is rejected as malformed", () => {
  const out = evaluateScenarioRead(fixture({ generationStates: { rates: { ai_evaluated_at: iso(GEN + 2 * HOUR) } } }), NOW);
  assert.equal(out.status, "invalid");
  assert.deepEqual(out.reason_codes, ["evidence_malformed"]);
});

test("[K] a State timestamp in the future at read time (clock skew) -> invalid, unknown freshness", () => {
  const input = fixture({ generationStates: { rates: { ai_evaluated_at: iso(GEN + 3 * 60 * 1000) } } });
  const out = evaluateScenarioRead(input, GEN - 10 * 60 * 1000);
  assert.equal(out.status, "invalid");
  assert.ok(out.reason_codes.includes("state_unusable:rates:freshness_unknown"), String(out.reason_codes));
  assert.equal(out.source_domains.find((d) => d.domain === "rates")!.narrative_freshness, "unknown");
  assert.equal(out.scenario, null);
});

// ------------------------------------------------------------------ L
test("[L] macro missing, rates + equity_index usable -> degraded with the missing domain disclosed", () => {
  const out = evaluateScenarioRead(
    fixture({ domains: ["rates", "equity_index"], confidence: 0.38, aiConfidence: 0.46 }),
    NOW,
  );
  assert.equal(out.status, "degraded");
  assert.ok(out.reason_codes.includes("missing_domain:macro"));
  assert.deepEqual(out.excluded_or_invalid_domains, [{ domain: "macro", reason: "not_in_scenario" }]);
  assert.equal(out.effective_confidence, 0.38);
});

test("[L] a usable State the Scenario was not built from is reported (no regeneration)", () => {
  const out = evaluateScenarioRead(
    fixture({ domains: ["rates", "equity_index"], liveStates: { macro: { source_evaluation_run_id: RUN.macro } } }),
    NOW,
  );
  assert.equal(out.status, "degraded");
  assert.ok(out.reason_codes.includes("state_available_not_in_scenario:macro"));
});

// ------------------------------------------------------------------ M
test("[M] fewer than two usable source States -> invalid", () => {
  const out = evaluateScenarioRead(
    fixture({ domains: ["rates", "equity_index"], liveStates: { equity_index: { coverage_status: "unavailable" } } }),
    NOW,
  );
  assert.equal(out.status, "invalid");
  assert.ok(out.reason_codes.includes("insufficient_usable_states"));
  assert.ok(out.reason_codes.includes("state_unusable:equity_index:coverage_unavailable"));
});

// ------------------------------------------------------------------ P
test("[P] indeterminate is degraded and effective confidence <= 0.3", () => {
  const empty = { title: "", description: "", triggers: [], implications: [], invalidation_conditions: [], watch_items: [] };
  const input = fixture({ assessment: "indeterminate", confidence: 0.3, aiConfidence: 0.9 });
  input.current!.upside_case = empty;
  input.current!.downside_case = empty;
  const out = evaluateScenarioRead(input, NOW);
  assert.equal(out.status, "degraded");
  assert.ok(out.reason_codes.includes("assessment_indeterminate"));
  assert.ok((out.effective_confidence ?? 1) <= 0.3);
  input.current!.confidence = 0.5;
  assert.equal(evaluateScenarioRead(input, NOW).status, "invalid", "stored indeterminate above 0.3 is malformed");
});

// ------------------------------------------------------------------ R
test("[R] malformed current shapes fail closed", () => {
  const mutations: Array<(c: Record<string, unknown>) => void> = [
    (c) => { c.source_scenario_run_id = "not-a-uuid"; },
    (c) => { c.assessment_status = "likely"; },
    (c) => { c.confidence = 0.9; }, // above ai_confidence
    (c) => { c.confidence = "0.7"; },
    (c) => { c.ai_confidence = Number.NaN; },
    (c) => { c.valid_until = null; },
    (c) => { c.valid_until = "soon"; },
    (c) => { c.valid_until = c.state_as_of; },
    (c) => { c.base_case = null; },
    (c) => { c.base_case = { ...(c.base_case as object), probability: 0.7 }; },
    (c) => { c.base_case = { ...(c.base_case as object), supporting_state_domains: ["fx"] }; },
    (c) => { c.upside_case = { ...(c.upside_case as object), triggers: [] }; },
    (c) => { c.downside_case = "down"; },
    (c) => { c.state_conflicts = [1]; },
    (c) => { c.source_state_domains = ["rates"]; },
    (c) => { c.source_state_domains = ["rates", "rates", "macro"]; },
    (c) => { c.source_state_run_ids = [RUN.rates]; },
    (c) => { c.input_fingerprint = null; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = fixture();
    mutate(input.current!);
    const out = evaluateScenarioRead(input, NOW);
    assert.equal(out.status, "invalid", `mutation ${index}`);
    assert.equal(out.scenario, null);
    assert.equal(out.effective_confidence, null);
  }
});

test("unavailable only for the untouched seed; a partial seed or a missing row is invalid", () => {
  const seed = Object.fromEntries(Object.keys(fixture().current!).map((key) => [key, null]));
  assert.deepEqual(evaluateScenarioRead({ current: seed, run: null, evidence: [], states: [] }, NOW).status, "unavailable");
  assert.deepEqual(evaluateScenarioRead({ current: seed, run: null, evidence: [], states: [] }, NOW).reason_codes, ["scenario_not_generated"]);
  assert.equal(evaluateScenarioRead({ current: { ...seed, confidence: 0.5 }, run: null, evidence: [], states: [] }, NOW).status, "invalid");
  assert.deepEqual(evaluateScenarioRead({ current: null, run: null, evidence: [], states: [] }, NOW).reason_codes, ["current_row_missing"]);
});

test("the gate is a pure function of its input: repeated reads agree and never mutate input", () => {
  const input = fixture({ liveStates: { rates: { observation_status: "stale" } } });
  const before = JSON.stringify(input);
  const a = evaluateScenarioRead(input, NOW);
  const b = evaluateScenarioRead(input, NOW);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
  a.scenario!.base_case.watch_items.push("mutated");
  assert.equal(JSON.stringify(input), before, "returned content is a copy");
});

test("Phase 3A production shape (rates recent/observation stale, equity recent, macro excluded) -> degraded, 0.38", () => {
  const generated = "2026-09-26T01:15:09.317Z";
  const input = fixture({
    domains: ["rates", "equity_index"],
    confidence: 0.38,
    aiConfidence: 0.46,
    generationStates: {
      rates: { ai_evaluated_at: generated, data_confidence: 0.6, observation_status: "stale" },
      equity_index: { ai_evaluated_at: "2026-09-26T01:15:08.875Z", observation_status: "delayed_expected" },
    },
  });
  const out = evaluateScenarioRead(input, Date.parse("2026-09-28T13:30:00Z"));
  assert.equal(out.status, "degraded");
  assert.equal(out.effective_confidence, 0.38);
  assert.equal(out.valid_until, "2026-09-30T01:15:08.875Z");
  const rates = out.source_domains.find((d) => d.domain === "rates")!;
  assert.equal(rates.narrative_freshness, "recent");
  assert.equal(rates.observation_status, "stale");
  assert.ok(out.reason_codes.includes("narrative_recent:rates") && out.reason_codes.includes("observation_stale:rates"));
  assert.equal(out.reason_codes.includes("observation_stale:equity_index"), false, "delayed_expected is not stale");
});
