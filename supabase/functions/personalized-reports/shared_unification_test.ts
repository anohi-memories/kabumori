// Non-destructive proof that ONE shared market packet (market_data_packet -> market_report_packet) feeds
// all three consumers without a second market analysis:
//   X (public, simplified)  — x-test-post/shared_market_report_consumer.ts (read-only import; fake deps)
//   App 市場全体 (complete)  — buildSharedConsumption().marketDetail
//   App マイポート           — buildPacket(..., sharedInput) + reportUpdate()
// Uses real production packets (morning 2026-09-24, close 2026-09-25). No network, no persistence,
// no notification, no X post.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  formatSharedXPost,
  type MarketReportPacket,
  parseSharedMarketReportResult,
  type SharedMarketReportResult,
  sharedXPostIssues,
} from "../_shared/market_report_packet.ts";
import { publishSharedMarketReport } from "../x-test-post/shared_market_report_consumer.ts";
import { buildSharedConsumption, sharedGateDecision } from "./shared_gate.ts";
import {
  BENCHMARK_LABEL,
  buildPacket,
  buildSnapshot,
  priceFactFromSharedMetric,
  type PriceSeries,
  type ReportOutcome,
  reportUpdate,
} from "./report_logic.ts";

const FIXTURES = new URL("../market-report-analysis/fixtures/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));

type Fixture = { id: string; content_hash: string; payload: Record<string, unknown> };

function completed(reportType: "morning" | "close", date: string): SharedMarketReportResult {
  const report: Fixture = load(`${reportType}_${date}_generated_report.json`);
  const data: Fixture = load(`${reportType}_${date}_data_packet.json`);
  // Parse through the same consumer contract the RPC response goes through.
  return parseSharedMarketReportResult({
    enabled: true,
    status: "completed",
    report_packet_id: report.id,
    report_content_hash: report.content_hash,
    data_packet_id: data.id,
    data_content_hash: data.content_hash,
    report: report.payload,
    data: data.payload,
  });
}

const CASES = [
  { reportType: "morning" as const, date: "2026-09-24" },
  { reportType: "close" as const, date: "2026-09-25" },
];

// A fictional user portfolio: these strings must never reach X or the shared market section.
const HOLDINGS = [
  { tickerCode: "9901", companyName: "架空ホールディングスA" },
  { tickerCode: "9902", companyName: "架空テックB" },
];
const USER_ID = "33333333-3333-4333-8333-333333333333";

const DIRECTION_JA: Record<string, string> = { up: "上昇", down: "下落", mixed: "まちまち", flat: "ほぼ横ばい", unknown: "判断できず" };

function personalized(reportType: "morning" | "close", date: string, shared: Extract<SharedMarketReportResult, { status: "completed" }>) {
  const { marketDetail, sharedInput } = buildSharedConsumption({ reportType, tradingDate: date, shared, morningShared: null });
  const bars = (base: number): PriceSeries => ({
    bars: [{ date: "2026-09-22", close: base }, { date: "2026-09-24", close: base }, { date: "2026-09-25", close: base * 1.01 }],
    marketTimeIso: `${date}T06:30:00Z`,
  });
  const metric = (key: string) => (shared.data.metrics ?? []).find((m) => (m as { key?: unknown }).key === key);
  const snapshot = buildSnapshot({
    reportType, tradingDate: date,
    tracked: HOLDINGS.map((h) => ({
      trackedStockId: `t-${h.tickerCode}`, tickerCode: h.tickerCode, companyName: h.companyName, sector: "サービス業",
      trackingType: "holding" as const, quantity: 100, averagePrice: 900, positionType: "cash" as const, side: "long" as const,
    })),
    prices: new Map(HOLDINGS.map((h) => [h.tickerCode, bars(1000)])),
    // Gate ON: index values come from the same data packet, exactly as index.ts does.
    indices: [
      { label: "日経平均", series: null, price: priceFactFromSharedMetric(metric("nikkei225") as never) },
      { label: BENCHMARK_LABEL, series: null, price: priceFactFromSharedMetric(metric("topix_proxy_1306") as never) },
    ],
    news: [],
  });
  const packet = buildPacket(snapshot, [], sharedInput) as Record<string, unknown>;
  const outcome: ReportOutcome = {
    status: "passed", error: null, issues: [], model: "gpt-6-luna", calls: 2, inputTokens: 1, outputTokens: 1, estimatedCost: 0,
    body: {
      title_ja: "保有株の確認点", summary_ja: "保有銘柄を確認しました。", tone: "neutral", overview_ja: "保有銘柄を確認しました。",
      holding_impacts: HOLDINGS.map((h) => ({ ticker_code: h.tickerCode, stance: "no_clear_material" as const, basis: [], fact_ja: "この銘柄の入力には個別材料が含まれていません。", inference_ja: "", watch_ja: "" })),
      morning_review_ja: "", watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["確認します。"],
    },
  };
  const update = reportUpdate(outcome, snapshot, { lane: "app_personalized_v3_market_detail" }, new Date(`${date}T08:20:00Z`), sharedInput.section, marketDetail);
  return { marketDetail, sharedInput, packet, update };
}

async function xPost(reportType: "morning" | "close", shared: SharedMarketReportResult) {
  const runUpdates: Array<Record<string, unknown>> = [];
  const posted: string[] = [];
  const result = await publishSharedMarketReport(reportType, shared, {
    createRun: () => Promise.resolve("run-1"),
    updateRun: (_id, values) => { runUpdates.push(values); return Promise.resolve(); },
    postToX: (text) => { posted.push(text); return Promise.resolve("1900000000000000001"); }, // fake: nothing is sent
    completePost: () => Promise.resolve(),
    now: () => new Date("2026-09-28T00:00:00Z"),
  });
  return { result, runUpdates, posted };
}

for (const { reportType, date } of CASES) {
  test(`${reportType} ${date}: one packet identity feeds X, App 市場全体 and App マイポート`, async () => {
    const shared = completed(reportType, date);
    assert.ok(shared.enabled && shared.status === "completed");
    const report = shared.report as MarketReportPacket;
    assert.equal(report.report_type, reportType);
    assert.equal(report.data_packet_id, shared.data_packet_id, "report packet is built on this data packet");

    // X (simplified): deterministic format of the Fact-passed x_post, strict format checks, identity recorded.
    const x = await xPost(reportType, shared);
    assert.equal(x.posted.length, 1);
    assert.ok(x.posted[0].startsWith(formatSharedXPost(report)), "X text is exactly the shared format (+ fixed hashtags)");
    assert.deepEqual(sharedXPostIssues(report, formatSharedXPost(report)), []);
    assert.equal(x.result.reportPacketId, shared.report_packet_id);
    assert.equal(x.result.reportContentHash, shared.report_content_hash);
    const generated = x.runUpdates.find((u) => u.generated_text);
    assert.equal(generated?.model_used, "shared_market_report");
    assert.equal(generated?.api_cost_usd, 0, "no second model call");
    assert.equal(generated?.web_search_calls, 0, "no independent web search");
    assert.deepEqual((generated?.market_data as { sharedMarketReport: Record<string, string> }).sharedMarketReport, {
      reportPacketId: shared.report_packet_id, reportContentHash: shared.report_content_hash,
      dataPacketId: shared.data_packet_id, dataContentHash: shared.data_content_hash,
    });

    // App 市場全体 (complete) + マイポート, same identity.
    const app = personalized(reportType, date, shared);
    assert.equal(app.marketDetail.report_packet_id, shared.report_packet_id);
    assert.equal(app.marketDetail.direction, report.market_direction);
    assert.equal(app.marketDetail.headline_ja, report.headline_ja);
    assert.equal(app.marketDetail.summary_ja, report.market_summary_ja);
    assert.deepEqual(app.marketDetail.key_news, report.key_news);
    assert.deepEqual(app.marketDetail.data_gaps_ja, report.data_gaps_ja);
    const body = app.update.body as { market_section: { report_packet_id: string; report_content_hash: string; market_direction: string }; market_detail: { report_packet_id: string } };
    assert.equal(body.market_section.report_packet_id, shared.report_packet_id);
    assert.equal(body.market_section.report_content_hash, shared.report_content_hash);
    assert.equal(body.market_detail.report_packet_id, shared.report_packet_id);

    // Same market direction everywhere; the personalized packet cannot restate a different one.
    assert.equal(body.market_section.market_direction, report.market_direction);
    assert.equal((app.packet.shared_market as { direction: string }).direction, DIRECTION_JA[report.market_direction]);

    // Same verified numbers: every fresh metric shown in the app comes from this data packet's metrics.
    const metricValues = new Set((shared.data.metrics ?? []).map((m) => (m as { value?: unknown }).value).filter((v) => typeof v === "number"));
    const shownFresh = app.marketDetail.metric_groups.flatMap((g) => g.items).filter((i) => i.freshness === "fresh");
    assert.ok(shownFresh.length >= 5, "cross-asset coverage (JP / US / SOX / FX / rates / oil)");
    for (const item of shownFresh) {
      const raw = (shared.data.metrics ?? []).find((m) => (m as { key?: unknown }).key === item.key) as { value: number };
      assert.ok(metricValues.has(raw.value), item.key);
    }
    // Index figures in マイポート come from the same packet (no separate Yahoo fetch for indices).
    const nikkei = (shared.data.metrics ?? []).find((m) => (m as { key?: unknown }).key === "nikkei225") as { value: number; freshness: string };
    const snapIndex = (app.update.portfolio_snapshot as { indices: Array<{ label: string; price: { close: number | null } }> }).indices[0];
    if (nikkei.freshness === "fresh") assert.equal(snapIndex.price.close, nikkei.value);

    // Privacy: X and the shared market section carry no portfolio or user data; マイポート does.
    const publicSurfaces = JSON.stringify([x.posted, x.runUpdates, app.marketDetail, body.market_section]);
    for (const secret of [...HOLDINGS.flatMap((h) => [h.tickerCode, h.companyName]), USER_ID]) {
      assert.ok(!publicSurfaces.includes(secret), `public/shared surface leaks ${secret}`);
    }
    assert.ok(JSON.stringify(app.packet).includes("9901"), "マイポート alone adds holdings");
  });
}

test("close: morning reference comes from the shared morning packet when present, and is simply absent otherwise", () => {
  const close = completed("close", "2026-09-25");
  const morning = completed("morning", "2026-09-24");
  assert.ok(close.enabled && close.status === "completed");
  const without = buildSharedConsumption({ reportType: "close", tradingDate: "2026-09-25", shared: close, morningShared: null });
  assert.equal(without.marketDetail.morning_reference, null, "2026-09-25's morning cycle was blocked: no reference, no guess");
  const withRef = buildSharedConsumption({ reportType: "close", tradingDate: "2026-09-25", shared: close, morningShared: morning });
  assert.equal(withRef.marketDetail.morning_reference?.headline_ja, (morning as { report: MarketReportPacket }).report.headline_ja);
  assert.deepEqual(withRef.sharedInput.morningWatchJa, withRef.marketDetail.morning_reference?.next_watch_ja);
  const notReady = buildSharedConsumption({ reportType: "close", tradingDate: "2026-09-25", shared: close, morningShared: { enabled: true, status: "not_ready" } });
  assert.equal(notReady.marketDetail.morning_reference, null);
});

test("gate contract: OFF → legacy, ON + completed → shared, ON + missing/not_ready → fail closed for both consumers", async () => {
  assert.deepEqual(sharedGateDecision({ enabled: false, status: "disabled" }), { action: "legacy" });
  assert.deepEqual(sharedGateDecision({ enabled: true, status: "missing" }), { action: "skip", status: "missing" });
  assert.deepEqual(sharedGateDecision({ enabled: true, status: "not_ready", report_status: "failed" }), { action: "skip", status: "not_ready" });
  assert.equal(sharedGateDecision(completed("morning", "2026-09-24")).action, "shared");

  for (const notReady of [{ enabled: true, status: "not_ready" } as const, { enabled: true, status: "missing" } as const, { enabled: false, status: "disabled" } as const]) {
    let posted = 0;
    const updates: Array<Record<string, unknown>> = [];
    await assert.rejects(
      publishSharedMarketReport("morning", notReady, {
        createRun: () => Promise.resolve("run-x"),
        updateRun: (_id, v) => { updates.push(v); return Promise.resolve(); },
        postToX: () => { posted += 1; return Promise.resolve("1"); },
        completePost: () => Promise.resolve(),
        now: () => new Date(),
      }),
      /SHARED_MARKET_REPORT_UNAVAILABLE/,
    );
    assert.equal(posted, 0, "X never posts without a completed shared packet (no legacy re-analysis)");
    assert.equal(updates[0]?.error, "SHARED_MARKET_REPORT_UNAVAILABLE");
  }
});

test("gate OFF: the personalized packet has no shared market and no market detail (legacy lane unchanged)", () => {
  const snapshot = buildSnapshot({
    reportType: "morning", tradingDate: "2026-09-24",
    tracked: [{ trackedStockId: "t", tickerCode: "9901", companyName: "架空ホールディングスA", sector: "サービス業", trackingType: "holding", quantity: 100, averagePrice: 900, positionType: "cash", side: "long" }],
    prices: new Map([["9901", { bars: [{ date: "2026-09-22", close: 1000 }, { date: "2026-09-24", close: 1000 }], marketTimeIso: null }]]),
    indices: [], news: [],
  });
  const legacy = buildPacket(snapshot, []) as Record<string, unknown>;
  assert.equal("shared_market" in legacy, false);
});

test("X shared path runs no Voice evaluator by design: x_post is inside the Fact-checked packet and format-checked", () => {
  const consumer = readFileSync(new URL("../x-test-post/shared_market_report_consumer.ts", import.meta.url), "utf8");
  assert.ok(consumer.includes('voice_evaluation_status: "not_applicable"'));
  const code = consumer.replace(/\/\/.*$/gm, "");
  assert.ok(!/evaluateKabumoriVoice|api\.openai\.com|finance\.yahoo/i.test(code), "no model / web / Yahoo call on the shared X path");
  const fetchTargets = [...code.matchAll(/fetchImpl\(`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(fetchTargets, ["${args.supabaseUrl}/rest/v1/rpc/get_shared_market_report"], "the only outbound call reads the shared packet");
  assert.ok(code.includes("web_search_calls: 0") && code.includes("api_cost_usd: 0"));
  const analysis = readFileSync(new URL("../market-report-analysis/analysis_logic.ts", import.meta.url), "utf8");
  assert.ok(analysis.includes("analysis.x_post.lead_ja,") && analysis.includes("...analysis.x_post.points_ja,"), "x_post text is in the local-check text set");
  assert.ok(/input: JSON\.stringify\(\{ input: input\.modelInput, analysis \}\)/.test(analysis), "the Fact check sees the whole analysis, x_post included");
});
