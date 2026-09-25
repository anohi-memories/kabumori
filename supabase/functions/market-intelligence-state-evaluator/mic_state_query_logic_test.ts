import assert from "node:assert/strict";
import test from "node:test";
import {
  FED_STATEMENT_DIFF_SNAPSHOT_FIELDS,
  FedStatementDiffAmbiguousError,
  fetchDomainMetricMap,
  fetchMetricObservationStatus,
  fetchPriorState,
  fetchRecentDomainEvents,
  fetchSourceFetchStatuses,
  resolveFedStatementDiffEvidence,
} from "./mic_state_query_logic.ts";
import type { RestContext } from "./mic_state_run_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

test("fetchDomainMetricMap: filters by domain and parses snake_case into camelCase", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify([
        { metric_key: "US10Y", domain: "rates", display_name: "US10Y", pct_change_threshold: null, abs_change_threshold: 0.05, always_material: false },
      ]),
      { status: 200 },
    );
  };
  const rows = await fetchDomainMetricMap(ctx, "rates", fetchImpl as typeof fetch);
  assert.match(calls[0], /mic_metric_domain_map\?domain=eq\.rates/);
  assert.deepEqual(rows, [
    { metricKey: "US10Y", domain: "rates", displayName: "US10Y", pctChangeThreshold: null, absChangeThreshold: 0.05, alwaysMaterial: false },
  ]);
});

test("fetchDomainMetricMap: throws on a non-2xx status", async () => {
  const fetchImpl = async () => new Response("error", { status: 500 });
  await assert.rejects(() => fetchDomainMetricMap(ctx, "rates", fetchImpl as typeof fetch), /DOMAIN_METRIC_MAP_FETCH_FAILED:500/);
});

test("fetchMetricObservationStatus: queries the view filtered by domain", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify([
        {
          metric_key: "US10Y", domain: "rates", current_value: 4.5, previous_value: 4.4, pct_change: 2.27,
          abs_change: 0.1, unit: "percent", observed_date: "2026-09-10", observed_at: null, time_precision: "date",
          fetched_at: "2026-09-12T00:00:00.000Z", source_key: "fred", provider: "FRED", is_official: true,
          expected_lag_minutes: 1440, observation_age_minutes: 2880, observation_status: "fresh",
        },
      ]),
      { status: 200 },
    );
  };
  const rows = await fetchMetricObservationStatus(ctx, "rates", fetchImpl as typeof fetch);
  assert.match(calls[0], /v_mic_metric_observation_status\?domain=eq\.rates/);
  assert.equal(rows[0].metricKey, "US10Y");
  assert.equal(rows[0].observationStatus, "fresh");
  assert.equal(rows[0].currentValue, 4.5);
});

test("fetchMetricObservationStatus: a row with no Fact yet parses to currentValue null / observationStatus unknown", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([
        {
          metric_key: "US2Y", domain: "rates", current_value: null, previous_value: null, pct_change: null,
          abs_change: null, unit: null, observed_date: null, observed_at: null, time_precision: null,
          fetched_at: null, source_key: null, provider: null, is_official: null,
          expected_lag_minutes: null, observation_age_minutes: null, observation_status: "unknown",
        },
      ]),
      { status: 200 },
    );
  const rows = await fetchMetricObservationStatus(ctx, "rates", fetchImpl as typeof fetch);
  assert.equal(rows[0].currentValue, null);
  assert.equal(rows[0].observationStatus, "unknown");
});

test("fetchSourceFetchStatuses: empty input never calls fetch, returns an empty map", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("[]", { status: 200 });
  };
  const map = await fetchSourceFetchStatuses(ctx, [], fetchImpl as typeof fetch);
  assert.equal(called, false);
  assert.equal(map.size, 0);
});

test("fetchSourceFetchStatuses: dedupes source keys in the in.() filter and builds a lookup map", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify([{ source_key: "fred", fetch_status: "fresh" }]), { status: 200 });
  };
  const map = await fetchSourceFetchStatuses(ctx, ["fred", "fred", "mof_jgb"], fetchImpl as typeof fetch);
  assert.match(calls[0], /source_key=in\.\(fred,mof_jgb\)/);
  assert.equal(map.get("fred"), "fresh");
  assert.equal(map.get("mof_jgb"), undefined);
});

test("fetchPriorState: no existing row -> narrativeIsNull true, baseline null", async () => {
  const fetchImpl = async () => new Response("[]", { status: 200 });
  const state = await fetchPriorState(ctx, "rates", fetchImpl as typeof fetch);
  assert.deepEqual(state, { domain: "rates", narrativeIsNull: true, numericBaselineSnapshot: null, sourceEventIds: [], updatedAt: null, aiEvaluatedAt: null });
});

test("fetchPriorState: existing row with a narrative -> narrativeIsNull false", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([{ domain: "rates", narrative: "existing", numeric_baseline_snapshot: { US10Y: { value: 4.5, observedDate: "2026-09-10", observedAt: null } } }]),
      { status: 200 },
    );
  const state = await fetchPriorState(ctx, "rates", fetchImpl as typeof fetch);
  assert.equal(state.narrativeIsNull, false);
  assert.deepEqual(state.numericBaselineSnapshot, { US10Y: { value: 4.5, observedDate: "2026-09-10", observedAt: null } });
  assert.deepEqual(state.sourceEventIds, []);
  assert.equal(state.updatedAt, null);
  assert.equal(state.aiEvaluatedAt, null);
});

test("fetchPriorState: reads prior event IDs and AI timestamp for the revision-aware material-event gate", async () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify([{
    narrative: "existing", source_event_ids: ["event-a"],
    ai_evaluated_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:01Z",
  }]), { status: 200 }));
  const state = await fetchPriorState(ctx, "rates", fetchImpl as typeof fetch);
  assert.deepEqual(state.sourceEventIds, ["event-a"]);
  assert.equal(state.aiEvaluatedAt, "2026-09-14T00:00:00Z");
  assert.equal(state.updatedAt, "2026-09-14T00:00:01Z");
});

test("fetchRecentDomainEvents: a domain with no mapped event_types (e.g. equity_index) never calls fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("[]", { status: 200 });
  };
  const events = await fetchRecentDomainEvents(ctx, "equity_index", null, fetchImpl as typeof fetch);
  assert.equal(called, false);
  assert.deepEqual(events, []);
});

test("fetchRecentDomainEvents: geopolitical filters on its mapped event_types", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify([{ id: "1", title: "t", summary: "s", importance: "high", event_type: "geopolitical", published_at: "2026-09-13T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z" }]),
      { status: 200 },
    );
  };
  const events = await fetchRecentDomainEvents(ctx, "geopolitical", null, fetchImpl as typeof fetch);
  assert.match(calls[0], /event_type=in\.\(geopolitical,sanction,political_statement\)/);
  assert.equal(events.length, 1);
  assert.equal(events[0].importance, "high");
  assert.equal(events[0].updatedAt, "2026-09-14T00:00:00.000Z");
});

// --- State Evidence Phase 2C1: resolveFedStatementDiffEvidence ---

const FED_EVENT = "39ec45a4-77b5-4869-a011-2f4aa98c228d";
const FED_DIFF = "4c6f1ad7-255e-4ac7-8eab-b44904bf94b0";

function diffRow(id: string, currentEventId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    current_event_id: currentEventId,
    previous_event_id: "50e3601d-2de6-483c-bed3-86892cff3cd3",
    current_document_hash: "f".repeat(64),
    previous_document_hash: "e".repeat(64),
    diff_hash: "1".repeat(64),
    meeting_date: "2026-09-16",
    previous_meeting_date: "2026-07-29",
    changed_paragraph_count: 3,
    material_change_count: 4,
    deterministic_diff: { comparisonStatus: "compared", policyDecisionChange: { upperChangeBps: 25 } },
    semantic_buckets: ["policy stance", "risks"],
    ai_interpretation: { overall_bias_change: "hawkish" },
    model: "gpt-6-luna",
    prompt_version: "fed-statement-diff-v2",
    generated_at: "2026-09-16T19:00:00+00:00",
    ai_usage_receipt: { feature: "mic_fed_statement_diff", cost_usd: 0.0012 },
    ai_usage_recorded_at: "2026-09-16T19:00:01.5+00:00",
    updated_at: "2026-09-16T19:00:01.5+00:00",
    ...overrides,
  };
}

function respondWith(body: unknown, init: ResponseInit = { status: 200 }) {
  const calls: string[] = [];
  const fetchImpl = (url: string | URL) => {
    calls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify(body), init));
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

test("resolveFedStatementDiffEvidence: empty input never calls fetch, returns []", async () => {
  const { calls, fetchImpl } = respondWith([]);
  assert.deepEqual(await resolveFedStatementDiffEvidence(ctx, [], fetchImpl), []);
  assert.equal(calls.length, 0);
});

test("resolveFedStatementDiffEvidence: 0 matching diffs for an event -> no evidence (not an error)", async () => {
  const { fetchImpl } = respondWith([]);
  assert.deepEqual(await resolveFedStatementDiffEvidence(ctx, [FED_EVENT], fetchImpl), []);
});

test("resolveFedStatementDiffEvidence: exactly 1 matching diff -> its id plus the full row as read, verbatim", async () => {
  const row = diffRow(FED_DIFF, FED_EVENT);
  const { calls, fetchImpl } = respondWith([row]);
  const evidence = await resolveFedStatementDiffEvidence(ctx, [FED_EVENT], fetchImpl);
  assert.deepEqual(evidence, [{ id: FED_DIFF, snapshot: row }]);
  assert.match(calls[0], /current_event_id=in\.\(39ec45a4-77b5-4869-a011-2f4aa98c228d\)/);
  // Every audited column is requested, created_at is not.
  const select = new URL(calls[0]).searchParams.get("select")!;
  assert.equal(select, FED_STATEMENT_DIFF_SNAPSHOT_FIELDS.join(","));
  assert.equal(select.split(",").includes("created_at"), false);
});

test("resolveFedStatementDiffEvidence: 2+ matching diffs for the SAME event -> fails closed with FedStatementDiffAmbiguousError, never guesses 'latest'", async () => {
  const { fetchImpl } = respondWith([
    diffRow("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", FED_EVENT),
    diffRow("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", FED_EVENT),
  ]);
  await assert.rejects(() => resolveFedStatementDiffEvidence(ctx, [FED_EVENT], fetchImpl), FedStatementDiffAmbiguousError);
});

test("resolveFedStatementDiffEvidence: resolves multiple distinct events independently", async () => {
  const { fetchImpl } = respondWith([
    diffRow("cccccccc-cccc-cccc-cccc-cccccccccccc", "event-a"),
    diffRow("dddddddd-dddd-dddd-dddd-dddddddddddd", "event-b"),
  ]);
  const evidence = await resolveFedStatementDiffEvidence(ctx, ["event-a", "event-b"], fetchImpl);
  assert.deepEqual(evidence.map((e) => e.id).sort(), ["cccccccc-cccc-cccc-cccc-cccccccccccc", "dddddddd-dddd-dddd-dddd-dddddddddddd"]);
  assert.ok(evidence.every((e) => e.snapshot.id === e.id));
});

test("resolveFedStatementDiffEvidence: one ambiguous event in a multi-event response fails the whole lookup", async () => {
  const { fetchImpl } = respondWith([
    diffRow("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "event-a"),
    diffRow("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "event-b"),
    diffRow("cccccccc-cccc-cccc-cccc-cccccccccccc", "event-b"),
  ]);
  await assert.rejects(() => resolveFedStatementDiffEvidence(ctx, ["event-a", "event-b"], fetchImpl), FedStatementDiffAmbiguousError);
});

test("resolveFedStatementDiffEvidence: duplicate input event IDs return one diff", async () => {
  const { fetchImpl } = respondWith([diffRow(FED_DIFF, FED_EVENT)]);
  const evidence = await resolveFedStatementDiffEvidence(ctx, [FED_EVENT, FED_EVENT], fetchImpl);
  assert.deepEqual(evidence.map((e) => e.id), [FED_DIFF]);
});

test("resolveFedStatementDiffEvidence: throws on a non-2xx status", async () => {
  const { fetchImpl } = respondWith("error", { status: 500 });
  await assert.rejects(() => resolveFedStatementDiffEvidence(ctx, [FED_EVENT], fetchImpl), /FED_STATEMENT_DIFF_LOOKUP_FAILED:500/);
});

test("resolveFedStatementDiffEvidence: malformed successful responses fail closed", async () => {
  const { id: _omitted, ...withoutId } = diffRow(FED_DIFF, "event-a");
  const { ai_usage_receipt: _receipt, ...missingColumn } = diffRow(FED_DIFF, "event-a");
  const cases: unknown[] = [
    [diffRow(null as unknown as string, "event-a")],
    [withoutId],
    [missingColumn],
    [{ ...diffRow(FED_DIFF, "event-a"), created_at: "2026-09-16T19:00:00+00:00" }],
    [diffRow(FED_DIFF, "unrequested-event")],
    [null],
    { not: "an array" },
  ];
  for (const body of cases) {
    const { fetchImpl } = respondWith(body);
    await assert.rejects(
      () => resolveFedStatementDiffEvidence(ctx, ["event-a"], fetchImpl),
      /FED_STATEMENT_DIFF_LOOKUP_INVALID_RESPONSE/,
      JSON.stringify(body).slice(0, 80),
    );
  }
});

test("resolveFedStatementDiffEvidence: capped PostgREST response fails closed", async () => {
  const { fetchImpl } = respondWith([diffRow("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "event-a")], {
    status: 206,
    headers: { "Content-Range": "0-0/2" },
  });
  await assert.rejects(() => resolveFedStatementDiffEvidence(ctx, ["event-a"], fetchImpl), /FED_STATEMENT_DIFF_LOOKUP_TRUNCATED/);
});

test("resolveFedStatementDiffEvidence: network failure is not treated as zero diffs", async () => {
  const fetchImpl = () => Promise.reject(new Error("network unavailable"));
  await assert.rejects(() => resolveFedStatementDiffEvidence(ctx, ["event-a"], fetchImpl as typeof fetch), /network unavailable/);
});
