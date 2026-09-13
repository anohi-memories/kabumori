import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchDomainMetricMap,
  fetchMetricObservationStatus,
  fetchPriorState,
  fetchRecentDomainEvents,
  fetchSourceFetchStatuses,
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
  assert.deepEqual(state, { domain: "rates", narrativeIsNull: true, numericBaselineSnapshot: null });
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
      JSON.stringify([{ id: "1", title: "t", summary: "s", importance: "high", event_type: "geopolitical", published_at: "2026-09-13T00:00:00.000Z" }]),
      { status: 200 },
    );
  };
  const events = await fetchRecentDomainEvents(ctx, "geopolitical", null, fetchImpl as typeof fetch);
  assert.match(calls[0], /event_type=in\.\(geopolitical,sanction,political_statement\)/);
  assert.equal(events.length, 1);
  assert.equal(events[0].importance, "high");
});
