import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMacroReleaseEvent,
  decideMacroReleaseEvent,
  MACRO_RELEASE_METRIC_KEYS,
} from "./mic_macro_release_logic.ts";

type FredMacroReleaseContext = Extract<Parameters<typeof buildMacroReleaseEvent>[1], { sourceKey: "fred" }>;

function ctx(overrides: Partial<FredMacroReleaseContext> = {}): FredMacroReleaseContext {
  return {
    metricKey: "US_CPI_YOY",
    observedDate: "2026-08-01",
    newValue: 3.1,
    unit: "percent",
    sourceKey: "fred",
    sourceName: "FRED",
    seriesId: "CPIAUCSL",
    fredUnits: "pc1",
    underlyingSource: "U.S. Bureau of Labor Statistics",
    sourceUrl: "https://fred.stlouisfed.org/series/CPIAUCSL",
    fetchedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

// --- decideMacroReleaseEvent ---

test("decideMacroReleaseEvent: no prior value -> new_release", () => {
  assert.deepEqual(decideMacroReleaseEvent(null, 3.1), { kind: "new_release" });
});

test("decideMacroReleaseEvent: same prior value -> unchanged", () => {
  assert.deepEqual(decideMacroReleaseEvent(3.1, 3.1), { kind: "unchanged" });
});

test("decideMacroReleaseEvent: different prior value -> revision, carries oldValue", () => {
  assert.deepEqual(decideMacroReleaseEvent(3.0, 3.1), { kind: "revision", oldValue: 3.0 });
});

// --- buildMacroReleaseEvent ---

test("buildMacroReleaseEvent: unchanged -> null (no event written)", () => {
  assert.equal(buildMacroReleaseEvent({ kind: "unchanged" }, ctx()), null);
});

test("buildMacroReleaseEvent: new_release -> event_type=macro_release, is_revision=false, old_value=null", () => {
  const event = buildMacroReleaseEvent({ kind: "new_release" }, ctx());
  assert.ok(event);
  assert.equal(event!.eventType, "macro_release");
  assert.equal(event!.category, "macro");
  assert.equal(event!.entityId, "US_CPI_YOY");
  assert.equal(event!.sourceKey, "fred");
  assert.equal(event!.sourceName, "FRED");
  assert.equal(event!.occurredAt, null, "no fabricated intraday time for a date-only source");
  assert.equal(event!.publishedAt, "2026-09-17T00:00:00.000Z");
  assert.match(event!.title, /released for 2026-08-01/);
  assert.match(event!.summary, /first release/);
  assert.deepEqual(event!.rawPayload, {
    metric_key: "US_CPI_YOY",
    observed_date: "2026-08-01",
    value: 3.1,
    new_value: 3.1,
    old_value: null,
    is_revision: false,
    source_key: "fred",
    source_name: "FRED",
    underlying_source: "U.S. Bureau of Labor Statistics",
    series_id: "CPIAUCSL",
    fred_units: "pc1",
  });
});

test("buildMacroReleaseEvent: revision -> event_type=macro_release, is_revision=true, old_value/new_value both present", () => {
  const event = buildMacroReleaseEvent({ kind: "revision", oldValue: 3.0 }, ctx({ newValue: 3.1 }));
  assert.ok(event);
  assert.match(event!.title, /revised for 2026-08-01/);
  assert.match(event!.summary, /revised to 3\.1 percent \(was 3 percent\)/);
  assert.equal(event!.rawPayload?.is_revision, true);
  assert.equal(event!.rawPayload?.old_value, 3.0);
  assert.equal(event!.rawPayload?.new_value, 3.1);
});

test("buildMacroReleaseEvent: raw (non-derived) mapping carries fred_units=null in raw_payload, not a fabricated units string", () => {
  const event = buildMacroReleaseEvent(
    { kind: "new_release" },
    ctx({ metricKey: "US_CPI", newValue: 313.53, unit: "cpi_index_1982_84_100", fredUnits: null }),
  );
  assert.equal(event!.rawPayload?.fred_units, null);
});

// --- Idempotency: same fact never produces two distinct market_events rows ---
// (content_hash is computed downstream by finalizeMarketEvent over
// normalized title+summary+entityIdentity -- proven here by checking that
// two calls describing the exact same fact produce byte-identical
// title/summary/entityId, which is what makes them hash identically and
// collide on market_events_content_hash_uidx.)

test("buildMacroReleaseEvent: two calls for the same unchanged-value re-fetch never even reach event construction (both return null)", () => {
  const first = buildMacroReleaseEvent(decideMacroReleaseEvent(null, 3.1), ctx());
  // Second ingest run: prior value is now 3.1 (what the first run wrote),
  // new value is still 3.1 -- a plain re-fetch, not a revision.
  const second = buildMacroReleaseEvent(decideMacroReleaseEvent(3.1, 3.1), ctx());
  assert.ok(first, "first observation of this metric/date does produce an event");
  assert.equal(second, null, "an unchanged re-fetch must produce zero events");
});

test("buildMacroReleaseEvent: two new_release calls for the identical (metric_key, observed_date, value) produce byte-identical title/summary/entityId -- this is what makes their content_hash collide downstream", () => {
  const a = buildMacroReleaseEvent({ kind: "new_release" }, ctx());
  const b = buildMacroReleaseEvent({ kind: "new_release" }, ctx());
  assert.equal(a!.title, b!.title);
  assert.equal(a!.summary, b!.summary);
  assert.equal(a!.entityId, b!.entityId);
});

test("buildMacroReleaseEvent: a genuine revision (different value) produces a title/summary distinct from the original release -- this is what makes it hash differently and become a NEW event row, not a duplicate", () => {
  const originalRelease = buildMacroReleaseEvent({ kind: "new_release" }, ctx({ newValue: 3.0 }));
  const revisedRelease = buildMacroReleaseEvent({ kind: "revision", oldValue: 3.0 }, ctx({ newValue: 3.1 }));
  assert.notEqual(originalRelease!.title, revisedRelease!.title);
  assert.notEqual(originalRelease!.summary, revisedRelease!.summary);
});

test("buildMacroReleaseEvent: a genuinely new observed_date (even with the same value as before) produces a title/summary distinct from the prior period's release", () => {
  const julyRelease = buildMacroReleaseEvent({ kind: "new_release" }, ctx({ observedDate: "2026-07-01", newValue: 3.1 }));
  const augustRelease = buildMacroReleaseEvent({ kind: "new_release" }, ctx({ observedDate: "2026-08-01", newValue: 3.1 }));
  assert.notEqual(julyRelease!.title, augustRelease!.title);
  assert.notEqual(julyRelease!.summary, augustRelease!.summary);
});

// --- MACRO_RELEASE_METRIC_KEYS scope ---

test("MACRO_RELEASE_METRIC_KEYS: exactly the 16 Phase 1A FRED macro metrics + 4 Phase 1B e-Stat macro metrics (20 total), nothing from existing domains", () => {
  assert.equal(MACRO_RELEASE_METRIC_KEYS.size, 20);
  for (const key of ["US2Y", "US10Y", "NIKKEI225", "SP500", "NASDAQCOMPOSITE", "NASDAQ100", "VIX", "USDJPY", "WTI", "BRENT"]) {
    assert.equal(MACRO_RELEASE_METRIC_KEYS.has(key), false, `${key} must not be in the macro_release scope`);
  }
  for (const key of ["US_CPI", "US_CPI_YOY", "US_CORE_PCE_YOY", "US_UNEMPLOYMENT_RATE", "US_GDP_GROWTH", "JP_GDP"]) {
    assert.equal(MACRO_RELEASE_METRIC_KEYS.has(key), true, `${key} must be in the macro_release scope`);
  }
  for (const key of ["JP_CPI", "JP_CPI_YOY", "JP_CORE_CPI", "JP_CORE_CPI_YOY"]) {
    assert.equal(MACRO_RELEASE_METRIC_KEYS.has(key), true, `${key} (Phase 1B e-Stat) must be in the macro_release scope`);
  }
});

// --- Phase 1B: buildMacroReleaseEvent must not assume FRED-only metadata
// (e-Stat metrics have no seriesId/fredUnits keys at all) ---

test("buildMacroReleaseEvent: e-Stat provenance and payload are source-specific, with no FRED-only fields", () => {
  const event = buildMacroReleaseEvent(
    { kind: "new_release" },
    {
      metricKey: "JP_CPI",
      observedDate: "2026-08-01",
      newValue: 102.2,
      unit: "cpi_index_2025_100",
      sourceKey: "estat",
      sourceName: "e-Stat",
      statsDataId: "0004052037",
      cdArea: "00000",
      cdCat01: "0001",
      tabCode: "1",
      cdTime: "2026000808",
      baseYear: 2025,
      underlyingSource: "Statistics Bureau of Japan",
      sourceUrl: "https://www.e-stat.go.jp/dbview?sid=0004052037",
      fetchedAt: "2026-09-20T00:00:00.000Z",
    },
  );
  assert.ok(event);
  assert.equal(event!.eventType, "macro_release");
  assert.equal(event!.entityId, "JP_CPI");
  assert.equal(event!.sourceKey, "estat");
  assert.equal(event!.sourceName, "e-Stat");
  assert.match(event!.title, /released for 2026-08-01/);
  assert.equal("series_id" in event!.rawPayload!, false);
  assert.equal("fred_units" in event!.rawPayload!, false);
  assert.equal(event!.rawPayload?.stats_data_id, "0004052037");
  assert.equal(event!.rawPayload?.cd_area, "00000");
  assert.equal(event!.rawPayload?.cd_cat01, "0001");
  assert.equal(event!.rawPayload?.tab_code, "1");
  assert.equal(event!.rawPayload?.cd_time, "2026000808");
  assert.equal(event!.rawPayload?.base_year, 2025);
  assert.equal(event!.rawPayload?.source_key, "estat");
  assert.equal(event!.rawPayload?.source_name, "e-Stat");
  assert.equal(event!.rawPayload?.underlying_source, "Statistics Bureau of Japan");
});
