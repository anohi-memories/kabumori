import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "./policy.ts";
import * as evaluatorLogic from "../../market-intelligence-scenario-evaluator/mic_scenario_state_logic.ts";
import { readScenarioForConsumer } from "./read_adapter.ts";

const ctx = { supabaseUrl: "https://example.supabase.co", secretKey: "sk_test" };
const NOW = new Date("2026-09-28T13:30:00Z");
const RUN = "9f9ff0b6-3da8-4b6b-b9f9-a88a998ac056";
const R = "f02387cb-b8d8-4bdc-aba1-4407beb38c80";
const E = "3e186bef-f2bb-4ed4-8ced-422825d1fda8";
const T = "2026-09-28T01:15:00.000Z";

function state(domain: string, run: string | null) {
  return {
    updated_at: T, domain, narrative: `${domain} n`, bullish_factors: [], bearish_factors: [], key_risks: [], ai_confidence: 0.8,
    data_confidence: 0.9, coverage_status: "full", observation_status: "fresh", ai_evaluated_at: T, source_evaluation_run_id: run,
  };
}
const fingerprint = `mic-scenario-v1|equity_index:${E}|rates:${R}`;
const current = {
  updated_at: T, prompt_version: "mic-scenario-v1", source_scenario_run_id: RUN, assessment_status: "assessed",
  base_case: { title: "t", description: "d", supporting_state_domains: ["rates"], confirmation_conditions: [], invalidation_conditions: [], watch_items: [] },
  upside_case: { title: "u", description: "d", triggers: ["x"], implications: [], invalidation_conditions: [], watch_items: [] },
  downside_case: { title: "d", description: "d", triggers: ["x"], implications: [], invalidation_conditions: [], watch_items: [] },
  state_conflicts: [], confidence: 0.5, ai_confidence: 0.6, state_as_of: T, valid_until: "2026-10-02T01:15:00.000Z",
  source_state_run_ids: [E, R], source_state_domains: ["equity_index", "rates"], input_fingerprint: fingerprint,
  ai_evaluated_at: "2026-09-28T02:00:00Z",
};
const evidence = [["equity_index", E], ["rates", R]].map(([domain, run]) => ({
  scenario_run_id: RUN, domain, state_evaluation_run_id: run, freshness: "fresh", usability: "strong",
  state_snapshot: Object.fromEntries(Object.entries(state(domain, run)).filter(([key]) => key !== "updated_at")),
}));

function backend(overrides: Partial<Record<"current" | "run" | "evidence" | "states", Response>> = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const impl = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    const path = url.replace(`${ctx.supabaseUrl}/rest/v1/`, "");
    if (path.startsWith("mic_scenario_current")) return Promise.resolve(overrides.current ?? json([current]));
    if (path.startsWith("mic_scenario_evaluation_runs")) {
      return Promise.resolve(overrides.run ?? json([{ id: RUN, status: "evaluated", input_fingerprint: fingerprint }]));
    }
    if (path.startsWith("mic_scenario_evidence")) return Promise.resolve(overrides.evidence ?? json(evidence));
    if (path.startsWith("market_state_current")) {
      return Promise.resolve(overrides.states ?? json([state("rates", R), state("equity_index", E), state("macro", null)]));
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("[Q] a read makes GET requests to the four authoritative tables only: no AI, no writes, no invoke", async () => {
  const b = backend();
  const out = await readScenarioForConsumer(ctx, NOW, b.impl);
  assert.equal(out.status, "degraded"); // macro missing
  assert.deepEqual(out.reason_codes, ["missing_domain:macro"]);
  assert.equal(b.calls.length, 6);
  for (const call of b.calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.body, undefined);
    assert.ok(call.url.startsWith(`${ctx.supabaseUrl}/rest/v1/`), call.url);
    assert.equal(/\/rpc\/|\/functions\/v1\/|openai/.test(call.url), false, call.url);
  }
  assert.deepEqual(b.calls.map((c) => c.url.split("/rest/v1/")[1].split("?")[0]), [
    "mic_scenario_current", "market_state_current", "mic_scenario_evaluation_runs", "mic_scenario_evidence", "market_state_current", "mic_scenario_current",
  ]);
  assert.match(b.calls[3].url, new RegExp(`scenario_run_id=eq\\.${RUN}`));
});

test("seed row (no source run): no run/evidence reads, unavailable", async () => {
  const seed = { ...Object.fromEntries(Object.keys(current).map((k) => [k, null])), updated_at: T };
  const b = backend({ current: new Response(JSON.stringify([seed])) });
  const out = await readScenarioForConsumer(ctx, NOW, b.impl);
  assert.equal(out.status, "unavailable");
  assert.equal(b.calls.some((c) => c.url.includes("mic_scenario_evidence")), false);
});

test("read failure or a malformed response fails closed as unavailable, never usable", async () => {
  for (const key of ["current", "run", "evidence", "states"] as const) {
    const out = await readScenarioForConsumer(ctx, NOW, backend({ [key]: new Response("{}", { status: 500 }) }).impl);
    assert.equal(out.status, "unavailable", key);
    assert.deepEqual(out.reason_codes, ["read_failed"]);
    assert.equal(out.scenario, null);
  }
  const notArray = await readScenarioForConsumer(ctx, NOW, backend({ states: new Response("{}", { status: 200 }) }).impl);
  assert.equal(notArray.status, "unavailable");
  const twoCurrents = await readScenarioForConsumer(ctx, NOW, backend({ current: new Response(JSON.stringify([current, current])) }).impl);
  assert.equal(twoCurrents.status, "unavailable");
  const down = await readScenarioForConsumer(ctx, NOW, (() => Promise.reject(new Error("net"))) as unknown as typeof fetch);
  assert.equal(down.status, "unavailable");
});

test("run not found through the adapter -> invalid", async () => {
  const out = await readScenarioForConsumer(ctx, NOW, backend({ run: new Response("[]") }).impl);
  assert.equal(out.status, "invalid");
  assert.deepEqual(out.reason_codes, ["source_run_missing"]);
});

test("no policy drift: the evaluator uses the very same policy objects as the read gate", () => {
  assert.equal(evaluatorLogic.FRESHNESS_HOURS, policy.FRESHNESS_HOURS);
  assert.equal(evaluatorLogic.classifyStates, policy.classifyStates);
  assert.equal(evaluatorLogic.classifyFreshness, policy.classifyFreshness);
  assert.equal(evaluatorLogic.confidenceCap, policy.confidenceCap);
  assert.equal(evaluatorLogic.RECENT_FRESHNESS_FACTOR, policy.RECENT_FRESHNESS_FACTOR);
  assert.equal(evaluatorLogic.EXCLUDED_DOMAIN_PENALTY, policy.EXCLUDED_DOMAIN_PENALTY);
  assert.equal(evaluatorLogic.INDETERMINATE_CONFIDENCE_CAP, policy.INDETERMINATE_CONFIDENCE_CAP);
  assert.deepEqual(policy.FRESHNESS_HOURS, {
    rates: { fresh: 36, recent: 96 }, equity_index: { fresh: 36, recent: 96 }, macro: { fresh: 168, recent: 840 },
  });
});

test("review: current commit at each multi-read boundary invalidates; next stable read recovers", async () => {
  // Include the same-State/prompt-version successor: the old four-GET path
  // would return old content even though all old identities still agree.
  for (const afterCall of [1, 2, 3, 4, 5]) {
    const b = backend();
    let calls = 0;
    const changedFetch = (async (url: string, init?: RequestInit) => {
      const response = await b.impl(url, init);
      calls++;
      if (url.includes("mic_scenario_current") && calls > afterCall) {
        return new Response(JSON.stringify([{ ...current, updated_at: "2026-09-28T02:00:01Z" }]));
      }
      return response;
    }) as typeof fetch;
    const out = await readScenarioForConsumer(ctx, NOW, changedFetch);
    assert.equal(out.status, "invalid", `commit after GET ${afterCall}`);
    assert.deepEqual(out.reason_codes, ["read_race_detected"]);
    assert.equal(out.scenario, null);
    assert.equal((await readScenarioForConsumer(ctx, NOW, backend().impl)).status, "degraded");
  }
});

test("review: material, no_change quality and ABA State commits fail optimistic validation", async () => {
  for (const update of [
    { source_evaluation_run_id: E }, { data_confidence: 0.5 }, { observation_status: "stale" },
    { coverage_status: "partial" }, {}, // identical values re-saved: updated_at still detects ABA
  ]) {
    const b = backend();
    let stateReads = 0;
    const impl = (async (url: string, init?: RequestInit) => {
      if (url.includes("market_state_current") && ++stateReads === 2) {
        return new Response(JSON.stringify([
          { ...state("rates", R), ...update, updated_at: "2026-09-28T02:00:01Z" },
          state("equity_index", E), state("macro", null),
        ]));
      }
      return await b.impl(url, init);
    }) as typeof fetch;
    const out = await readScenarioForConsumer(ctx, NOW, impl);
    assert.equal(out.status, "invalid");
    assert.equal(out.scenario, null);
  }
});

test("review: row/key ordering alone is not a race", async () => {
  const b = backend(); let count = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    const response = await b.impl(url, init);
    if (url.includes("market_state_current") && ++count === 2) {
      const rows = await response.json() as Record<string, unknown>[];
      return new Response(JSON.stringify(rows.reverse().map((row) => Object.fromEntries(Object.entries(row).reverse()))));
    }
    return response;
  }) as typeof fetch;
  assert.equal((await readScenarioForConsumer(ctx, NOW, impl)).status, "degraded");
});

test("review: malformed row arrays and errors containing a secret cannot escape the adapter", async () => {
  for (const value of [[null], [1], ["bad"], [[]]]) {
    const out = await readScenarioForConsumer(ctx, NOW, backend({ current: new Response(JSON.stringify(value)) }).impl);
    assert.equal(out.status, "unavailable");
    assert.equal(out.scenario, null);
  }
  const impl = (() => Promise.reject(new Error(`DB error with ${ctx.secretKey}`))) as typeof fetch;
  const out = await readScenarioForConsumer(ctx, NOW, impl);
  assert.equal(JSON.stringify(out).includes(ctx.secretKey), false);
  assert.deepEqual(out.reason_codes, ["read_failed"]);
});

test("review: validation read failures fail closed; missing row versions do not imply stability", async () => {
  for (const failAt of [5, 6]) {
    const b = backend(); let calls = 0;
    const impl = (async (url: string, init?: RequestInit) => ++calls === failAt ? new Response("", { status: 503 }) : await b.impl(url, init)) as typeof fetch;
    const out = await readScenarioForConsumer(ctx, NOW, impl);
    assert.deepEqual(out.reason_codes, ["read_failed"]);
    assert.equal(out.scenario, null);
  }
  const unversioned = { ...current }; delete (unversioned as Record<string, unknown>).updated_at;
  const b = backend();
  const impl = (async (url: string, init?: RequestInit) => url.includes("mic_scenario_current") ?
    new Response(JSON.stringify([unversioned])) : await b.impl(url, init)) as typeof fetch;
  assert.equal((await readScenarioForConsumer(ctx, NOW, impl)).status, "invalid");
});

test("review: default clock is sampled after slow reads, so they cannot extend expiry", async () => {
  const RealDate = Date;
  let time = Date.parse(current.valid_until) - 1;
  class ClockDate extends RealDate {
    constructor(value?: string | number) { super(value ?? time); }
  }
  const b = backend(); let reads = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    const response = await b.impl(url, init);
    if (++reads === 6) time += 1;
    return response;
  }) as typeof fetch;
  try {
    globalThis.Date = ClockDate as DateConstructor;
    const out = await readScenarioForConsumer(ctx, undefined, impl);
    assert.equal(out.status, "expired");
    assert.equal(out.scenario, null);
  } finally {
    globalThis.Date = RealDate;
  }
});

test("review: validation is point-in-time, not a lease over a later State commit", async () => {
  const b = backend(); let calls = 0; let afterBoundary = false;
  const impl = (async (url: string, init?: RequestInit) => {
    const response = url.includes("market_state_current") && afterBoundary ? new Response(JSON.stringify([
      { ...state("rates", R), data_confidence: 0.2, updated_at: "2026-09-28T02:00:01Z" },
      state("equity_index", E), state("macro", null),
    ])) : await b.impl(url, init);
    // A committed State update after its final observation is not observable
    // by the last current-only GET. Do NOT claim latest-at-return guarantees.
    if (++calls === 5) afterBoundary = true;
    return response;
  }) as typeof fetch;
  assert.equal((await readScenarioForConsumer(ctx, NOW, impl)).status, "degraded");
  assert.equal((await readScenarioForConsumer(ctx, NOW, impl)).status, "invalid");
});
