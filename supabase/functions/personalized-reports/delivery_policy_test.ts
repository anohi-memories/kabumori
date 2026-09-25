// Delivery policy Phase 1 (shadow): classification + telemetry only; delivery behaviour must be unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BLOCK_LOCAL_CODES,
  classifyDelivery,
  classifyLocalIssue,
  DELIVERY_POLICY_VERSION,
  WARN_LOCAL_CODES,
  withDeliveryPolicy,
} from "./delivery_policy.ts";
import {
  BENCHMARK_LABEL,
  buildPacket,
  buildSnapshot,
  generateReport,
  type PriceSeries,
  type ReportBody,
  type ReportOutcome,
  type Requester,
  reportUpdate,
} from "./report_logic.ts";

function outcome(overrides: Partial<ReportOutcome>): ReportOutcome {
  return {
    status: "failed", body: null, issues: [], error: null, model: "gpt-6-luna",
    calls: 1, inputTokens: 1, outputTokens: 1, estimatedCost: 0, ...overrides,
  };
}

const BODY: ReportBody = {
  title_ja: "今日の注目点", summary_ja: "保有銘柄を確認しました。", tone: "neutral", overview_ja: "保有銘柄を確認しました。",
  holding_impacts: [], morning_review_ja: "", watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["確認します。"],
};

// --- classification -------------------------------------------------------------------------

test("1: style-only local issues classify as WARN (shadow), never as a new blocker", () => {
  const t = classifyDelivery(outcome({ error: "REPORT_LOCAL_CHECK_FAILED", issues: ["IMPACT_TOO_LONG:1111", "CONTAINS_EMOJI", "TITLE_TOO_LONG"] }));
  assert.equal(t.voice_status, "warn");
  assert.deepEqual(t.warning_codes, ["IMPACT_TOO_LONG", "CONTAINS_EMOJI", "TITLE_TOO_LONG"]);
  assert.deepEqual(t.block_codes, []);
  assert.equal(t.delivery_blocked_by, "local_style", "records what actually stopped delivery today");
  for (const code of ["SUMMARY_TOO_LONG", "OVERVIEW_TOO_LONG", "CONTAINS_LATIN_WORD:SOX", "CONTAINS_NEWS_LABEL", "CONTAINS_ISO_DATE", "RISK_NOTES_INVALID"]) {
    assert.equal(classifyLocalIssue(code), "warn", code);
  }
});

test("2: existing Fact / Safety / structure blockers classify as BLOCK", () => {
  for (const code of ["NUMBER_NOT_IN_PACKET:12,345", "INFERENCE_NOT_HEDGED:1111", "CONTAINS_INVESTMENT_ADVICE", "MISSING_HOLDING_IMPACTS",
    "FALSE_NO_MATERIAL_CLAIM:2222", "CONTRADICTS_SHARED_MARKET:SAID_DOWN", "CONTAINS_URL", "UNSUPPORTED_MULTI_DAY_WORD:続落"]) {
    assert.equal(classifyLocalIssue(code), "block", code);
  }
  const mixed = classifyDelivery(outcome({ error: "REPORT_LOCAL_CHECK_FAILED", issues: ["IMPACT_TOO_LONG:1111", "INFERENCE_NOT_HEDGED:2222"] }));
  assert.equal(mixed.voice_status, "block");
  assert.deepEqual(mixed.warning_codes, ["IMPACT_TOO_LONG"]);
  assert.deepEqual(mixed.block_codes, ["INFERENCE_NOT_HEDGED"]);
  assert.equal(mixed.delivery_blocked_by, "local_fact_safety");
  const fact = classifyDelivery(outcome({ error: "REPORT_FACT_FAILED", issues: ["数字の取り違え"], calls: 2 }));
  assert.deepEqual([fact.voice_status, fact.delivery_blocked_by, fact.block_codes], ["block", "fact", ["REPORT_FACT_FAILED"]]);
  const structure = classifyDelivery(outcome({ error: "REPORT_INSUFFICIENT_INFORMATION" }));
  assert.deepEqual([structure.voice_status, structure.delivery_blocked_by], ["block", "structure"]);
});

test("unknown local codes are conservatively BLOCK, and every code report_logic emits is classified explicitly", () => {
  assert.equal(classifyLocalIssue("SOME_FUTURE_CHECK:1111"), "block");
  const source = readFileSync(new URL("./report_logic.ts", import.meta.url), "utf8");
  const emitted = [...source.matchAll(/issues\.push\(["`]([A-Z_]+)/g)].map((match) => match[1]);
  assert.ok(emitted.length >= 25, "found the local issue codes");
  for (const code of new Set(emitted)) {
    assert.ok(WARN_LOCAL_CODES.has(code) || BLOCK_LOCAL_CODES.has(code), `unclassified local code: ${code}`);
    assert.ok(!(WARN_LOCAL_CODES.has(code) && BLOCK_LOCAL_CODES.has(code)), `double-classified: ${code}`);
  }
});

test("3: clean content classifies as PASS", () => {
  const t = classifyDelivery(outcome({ status: "passed", body: BODY, calls: 2 }));
  assert.deepEqual(
    { voice_status: t.voice_status, warning_codes: t.warning_codes, block_codes: t.block_codes, blocked: t.delivery_blocked_by, deliver: t.would_deliver_under_warn_policy },
    { voice_status: "pass", warning_codes: [], block_codes: [], blocked: null, deliver: true },
  );
});

test("4: unavailable / unexpected inputs yield telemetry only, never a throw or a new failure", () => {
  const infra = classifyDelivery(outcome({ error: "REPORT_OPENAI_FAILED:500" }));
  assert.deepEqual([infra.voice_status, infra.delivery_blocked_by, infra.block_codes], ["unavailable", "infra", ["REPORT_OPENAI_FAILED"]]);
  const data = classifyDelivery(outcome({ error: "PRICES_UNAVAILABLE", calls: 0 }));
  assert.deepEqual([data.voice_status, data.delivery_blocked_by], ["unavailable", "data"]);
  const malformed = classifyDelivery({ status: "failed", error: null, issues: null as unknown as string[], calls: 0 });
  assert.equal(malformed.voice_status, "unavailable");
  assert.doesNotThrow(() => classifyDelivery(undefined as unknown as ReportOutcome));
  assert.equal(classifyDelivery(undefined as unknown as ReportOutcome).voice_status, "unavailable");
});

test("6: Phase 1 never rewrites or falls back", () => {
  for (const o of [outcome({ status: "passed", body: BODY }), outcome({ error: "REPORT_LOCAL_CHECK_FAILED", issues: ["CONTAINS_EMOJI"] }), outcome({ error: "REPORT_FACT_FAILED" })]) {
    const t = classifyDelivery(o);
    assert.deepEqual([t.rewrite_attempted, t.rewrite_succeeded, t.fallback_original_used, t.mode, t.version], [false, false, false, "shadow", DELIVERY_POLICY_VERSION]);
  }
});

// --- behaviour unchanged ---------------------------------------------------------------------

function series(closes: Array<[string, number]>): PriceSeries {
  return { bars: closes.map(([date, close]) => ({ date, close })), marketTimeIso: "2026-09-25T06:30:00Z" };
}
const FLAT = series([["2026-09-24", 1000], ["2026-09-25", 1000]]);
function snapshot() {
  return buildSnapshot({
    reportType: "close", tradingDate: "2026-09-25",
    tracked: [{ trackedStockId: "t", tickerCode: "1111", companyName: "会社1111", sector: "サービス業", trackingType: "holding", quantity: 100, averagePrice: 900, positionType: "cash", side: "long" }],
    prices: new Map([["1111", FLAT]]),
    indices: [{ label: "日経平均", series: FLAT }, { label: BENCHMARK_LABEL, series: FLAT }],
    news: [],
  });
}

test("5 & 7: save / notify decision is identical with the shadow telemetry (legacy lane, app_enabled=false)", async () => {
  const snap = snapshot();
  const packet = buildPacket(snap, []); // no shared_market: the app_enabled=false lane
  const sourceBasis = { lane: "app_personalized_v1", news_ids: [] };
  const now = new Date("2026-09-25T08:20:00Z");
  const good: ReportBody = { ...BODY, holding_impacts: [{ ticker_code: "1111", stance: "no_clear_material", basis: [], fact_ja: "この銘柄の入力には個別材料が含まれていません。", inference_ja: "", watch_ja: "" }] };
  const requester = (draft: unknown, verdict: unknown): Requester => (step) =>
    Promise.resolve({ payload: step === "draft" ? draft : verdict, inputTokens: 1, outputTokens: 1 });
  const outcomes = [
    await generateReport(snap, packet, requester({ ...good, sufficient_information: true }, { passed: true, issues: [] })),
    await generateReport(snap, packet, requester({ ...good, sufficient_information: true }, { passed: false, issues: ["x"] })),
    await generateReport(snap, packet, requester({ ...good, title_ja: "題".repeat(60), sufficient_information: true }, { passed: true, issues: [] })),
    await generateReport(snap, packet, requester({ sufficient_information: false }, {})),
    await generateReport(snap, packet, () => Promise.reject(new Error("REPORT_OPENAI_FAILED:500"))),
  ];
  assert.deepEqual(outcomes.map((o) => o.status), ["passed", "failed", "failed", "failed", "failed"]);
  for (const o of outcomes) {
    const before = reportUpdate(o, snap, sourceBasis, now);
    const after = reportUpdate(o, snap, withDeliveryPolicy(sourceBasis, o), now);
    const { source_basis: beforeBasis, ...beforeRest } = before;
    const { source_basis: afterBasis, ...afterRest } = after;
    assert.deepEqual(afterRest, beforeRest, `every delivery-relevant column is unchanged (${o.error})`);
    const { delivery_policy: _added, ...afterBasisRest } = afterBasis as Record<string, unknown>;
    assert.deepEqual(afterBasisRest, beforeBasis, "existing source_basis keys are untouched");
    // The notify path in index.ts keys only on update.status === "completed".
    assert.equal(after.status === "completed", before.status === "completed");
  }
  const styleOnly = classifyDelivery(outcomes[2]);
  assert.deepEqual([styleOnly.voice_status, styleOnly.delivery_blocked_by], ["warn", "local_style"]);
});

test("index.ts wires the telemetry without touching the save / notify conditions", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.ok(source.includes("withDeliveryPolicy(sourceBasis, outcome)"));
  assert.ok(source.includes('if (update.status === "completed") {'), "notify still keys on completed only");
  assert.ok(source.includes("if (!dryRun && reportId) {"), "dry_run still never writes or notifies");
  assert.ok(!/delivery_policy[^\n]*(status|completed)\s*=/.test(source), "no delivery decision is derived from the telemetry");
});
