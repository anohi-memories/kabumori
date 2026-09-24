import assert from "node:assert/strict";
import test from "node:test";
import {
  FedStatementDiffAmbiguousError,
  fetchDomainMetricMap,
  fetchMetricObservationStatus,
  fetchPriorState,
  fetchRecentDomainEvents,
  fetchSourceFetchStatuses,
  resolveFedStatementDiffEvidenceIds,
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

// --- State Evidence Phase 2C1: resolveFedStatementDiffEvidenceIds ---

test("resolveFedStatementDiffEvidenceIds: empty input never calls fetch, returns []", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("[]", { status: 200 });
  };
  const ids = await resolveFedStatementDiffEvidenceIds(ctx, [], fetchImpl as typeof fetch);
  assert.deepEqual(ids, []);
  assert.equal(called, false);
});

test("resolveFedStatementDiffEvidenceIds: 0 matching diffs for an event -> that event contributes no evidence id (not an error)", async () => {
  const fetchImpl = async () => new Response(JSON.stringify([]), { status: 200 });
  const ids = await resolveFedStatementDiffEvidenceIds(ctx, ["39ec45a4-77b5-4869-a011-2f4aa98c228d"], fetchImpl as typeof fetch);
  assert.deepEqual(ids, []);
});

test("resolveFedStatementDiffEvidenceIds: exactly 1 matching diff -> that diff id is returned", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify([{ id: "4c6f1ad7-255e-4ac7-8eab-b44904bf94b0", current_event_id: "39ec45a4-77b5-4869-a011-2f4aa98c228d" }]),
      { status: 200 },
    );
  };
  const ids = await resolveFedStatementDiffEvidenceIds(ctx, ["39ec45a4-77b5-4869-a011-2f4aa98c228d"], fetchImpl as typeof fetch);
  assert.deepEqual(ids, ["4c6f1ad7-255e-4ac7-8eab-b44904bf94b0"]);
  assert.match(calls[0], /current_event_id=in\.\(39ec45a4-77b5-4869-a011-2f4aa98c228d\)/);
});

test("resolveFedStatementDiffEvidenceIds: 2+ matching diffs for the SAME event -> fails closed with FedStatementDiffAmbiguousError, never guesses 'latest'", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([
        { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", current_event_id: "39ec45a4-77b5-4869-a011-2f4aa98c228d" },
        { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", current_event_id: "39ec45a4-77b5-4869-a011-2f4aa98c228d" },
      ]),
      { status: 200 },
    );
  await assert.rejects(
    () => resolveFedStatementDiffEvidenceIds(ctx, ["39ec45a4-77b5-4869-a011-2f4aa98c228d"], fetchImpl as typeof fetch),
    FedStatementDiffAmbiguousError,
  );
});

test("resolveFedStatementDiffEvidenceIds: resolves multiple distinct events independently", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify([
        { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", current_event_id: "event-a" },
        { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", current_event_id: "event-b" },
      ]),
      { status: 200 },
    );
  const ids = await resolveFedStatementDiffEvidenceIds(ctx, ["event-a", "event-b"], fetchImpl as typeof fetch);
  assert.deepEqual(ids.sort(), ["cccccccc-cccc-cccc-cccc-cccccccccccc", "dddddddd-dddd-dddd-dddd-dddddddddddd"]);
});

test("resolveFedStatementDiffEvidenceIds: one ambiguous event in a multi-event response fails the whole lookup", async () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify([
    { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", current_event_id: "event-a" },
    { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", current_event_id: "event-b" },
    { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", current_event_id: "event-b" },
  ]), { status: 200 }));
  await assert.rejects(
    () => resolveFedStatementDiffEvidenceIds(ctx, ["event-a", "event-b"], fetchImpl as typeof fetch),
    FedStatementDiffAmbiguousError,
  );
});

test("resolveFedStatementDiffEvidenceIds: throws on a non-2xx status", async () => {
  const fetchImpl = async () => new Response("error", { status: 500 });
  await assert.rejects(
    () => resolveFedStatementDiffEvidenceIds(ctx, ["39ec45a4-77b5-4869-a011-2f4aa98c228d"], fetchImpl as typeof fetch),
    /FED_STATEMENT_DIFF_LOOKUP_FAILED:500/,
  );
});

test("resolveFedStatementDiffEvidenceIds: duplicate input event IDs return one diff ID", async () => {
  const eventId = "39ec45a4-77b5-4869-a011-2f4aa98c228d";
  const diffId = "4c6f1ad7-255e-4ac7-8eab-b44904bf94b0";
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify([{ id: diffId, current_event_id: eventId }]), { status: 200 }));
  assert.deepEqual(await resolveFedStatementDiffEvidenceIds(ctx, [eventId, eventId], fetchImpl as typeof fetch), [diffId]);
});

test("resolveFedStatementDiffEvidenceIds: malformed successful response fails closed", async () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify([{ id: null, current_event_id: "event-a" }]), { status: 200 }));
  await assert.rejects(
    () => resolveFedStatementDiffEvidenceIds(ctx, ["event-a"], fetchImpl as typeof fetch),
    /FED_STATEMENT_DIFF_LOOKUP_INVALID_RESPONSE/,
  );
});

test("resolveFedStatementDiffEvidenceIds: capped PostgREST response fails closed", async () => {
  const fetchImpl = () => Promise.resolve(new Response(JSON.stringify([
    { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", current_event_id: "event-a" },
  ]), { status: 206, headers: { "Content-Range": "0-0/2" } }));
  await assert.rejects(
    () => resolveFedStatementDiffEvidenceIds(ctx, ["event-a"], fetchImpl as typeof fetch),
    /FED_STATEMENT_DIFF_LOOKUP_TRUNCATED/,
  );
});

test("resolveFedStatementDiffEvidenceIds: network failure is not treated as zero diffs", async () => {
  const fetchImpl = () => Promise.reject(new Error("network unavailable"));
  await assert.rejects(
    () => resolveFedStatementDiffEvidenceIds(ctx, ["event-a"], fetchImpl as typeof fetch),
    /network unavailable/,
  );
});
