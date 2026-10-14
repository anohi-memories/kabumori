// TOPIX index in the shared analysis (2026-10-14, F2 Phase 2 follow-up). Offline only. The TOPIX values below are made
// up for the tests (3,412.56 etc. are not real TOPIX closes); the Nikkei 225 and 1306 values are the stored fixtures'.
// A "topix" metric reaches the analysis only when the data packet producer is given a TOPIX source (off by default).
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput, type JapanMetrics, TOPIX_GAP_JA, TOPIX_SESSION_GAP_JA } from "./analysis_input.ts";
import { generateSharedAnalysis, type GeneratedAnalysis, generationRequestBody, type Requester, unitChecker } from "./analysis_logic.ts";
import { formatSharedXPost, type MarketReportPacket } from "../_shared/market_report_packet.ts";
import { buildAppMarketStory } from "../_shared/market_report_story.ts";
import { type MarketDataPacket, type Metric, TOPIX_INDEX_LABEL } from "../market-report-data-packet/packet_schema.ts";
import { yahooDailyUrl } from "../market-report-data-packet/yahoo_daily.ts";
import { loadFixture } from "./test_support.ts";

const directory = new URL("./fixtures/", import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, directory)));

/** The stored packet plus a topix metric on the Nikkei 225's session (or as patched), placed after the Tokyo metrics. */
function withTopix(payload: MarketDataPacket, patch: Partial<Metric> = {}): MarketDataPacket {
  const nikkei = payload.metrics.find((metric) => metric.key === "nikkei225")!;
  const topix: Metric = {
    ...nikkei, key: "topix", label: TOPIX_INDEX_LABEL, required: false, source_url: yahooDailyUrl("^TOPX"),
    value: 3412.56, previous_close: 3390.1, change: 22.46, change_pct: 0.66, ...patch,
  };
  const at = payload.metrics.findIndex((metric) => metric.key === "topix_proxy_1306") + 1;
  return {
    ...payload,
    metrics: [...payload.metrics.slice(0, at), topix, ...payload.metrics.slice(at)],
    data_quality: {
      ...payload.data_quality,
      unavailable: topix.freshness === "unavailable" ? [...payload.data_quality.unavailable, "topix"] : payload.data_quality.unavailable,
    },
  };
}

const UNAVAILABLE: Partial<Metric> = {
  value: null, previous_close: null, change: null, change_pct: null, session_date: null, observed_at: null,
  freshness: "unavailable", gap_reason: "identity_mismatch",
};

async function closeInput(payloadOf: (payload: MarketDataPacket) => MarketDataPacket, japanMetrics: JapanMetrics = "nikkei_only") {
  const fixture = await loadFixture("close_2026-10-06");
  return buildAnalysisInput({
    dataPacket: payloadOf(fixture.data.payload), dataPacketId: fixture.data.id, dataContentHash: fixture.data.content_hash,
    newsRows: fixture.news, newsSelection: "market_wide", japanMetrics,
  });
}

const prompt = (input: Awaited<ReturnType<typeof closeInput>>) => String(generationRequestBody(input, []).instructions);
const INDEX_LINE = "入力の「TOPIX（東証株価指数）」（metric:topix）は TOPIX 指数そのものです";
const NO_TOPIX_LINE = "入力には TOPIX（指数）の値がありません";

test("with TOPIX: it is a Tokyo fact with its own value, change and date; no 'TOPIX not used' gap; the prompt says it is the index", async () => {
  const input = await closeInput((payload) => withTopix(payload));
  const fact = input.metricFacts.find((item) => item.key === "topix")!;
  assert.deepEqual(
    { label: fact.label, dateJa: fact.dateJa, value: fact.valueDisplay, change: fact.changeDisplay },
    { label: TOPIX_INDEX_LABEL, dateJa: "10月6日", value: "3,412.56", change: "+0.66%" },
  );
  assert.equal(fact.sessionDate, input.metricFacts.find((item) => item.key === "nikkei225")!.sessionDate);
  assert.ok(!input.metricFacts.some((item) => item.key === "topix_proxy_1306"), "still no 1306 in nikkei_only");
  assert.ok(!input.dataGapsJa.includes(TOPIX_GAP_JA));
  const listed = (input.modelInput.指標 as Array<{ ref: string; 名称: string; 値: string }>).find((item) => item.ref === "metric:topix");
  assert.deepEqual(listed && { 名称: listed.名称, 値: listed.値 }, { 名称: TOPIX_INDEX_LABEL, 値: "3,412.56" });
  assert.ok(prompt(input).includes(INDEX_LINE));
  assert.ok(!prompt(input).includes(NO_TOPIX_LINE));
});

test("direction: TOPIX joins the Nikkei 225 — both up is up, opposite moves are mixed", async () => {
  const up = await closeInput((payload) => withTopix(payload));
  assert.equal(up.direction, "up");
  assert.deepEqual(up.directionBasis, ["nikkei225", "topix"]);
  assert.deepEqual(up.sessionViews.find((view) => view.market === "tokyo")!.basis, ["nikkei225", "topix"]);
  const mixed = await closeInput((payload) => withTopix(payload, { value: 3376.53, change: -13.57, change_pct: -0.4 }));
  assert.equal(mixed.direction, "mixed");
});

test("TOPIX missing: the reader is told it could not be fetched; 1306 does not come back; the prompt rules TOPIX out", async () => {
  const input = await closeInput((payload) => withTopix(payload, UNAVAILABLE));
  assert.ok(input.dataGapsJa.includes(`${TOPIX_INDEX_LABEL}は取得できませんでした`));
  assert.ok(!input.dataGapsJa.includes(TOPIX_GAP_JA), "one TOPIX gap, not two");
  assert.ok(!input.metricFacts.some((item) => item.key === "topix" || item.key === "topix_proxy_1306"));
  assert.deepEqual(input.directionBasis, ["nikkei225"]);
  assert.ok(prompt(input).includes(NO_TOPIX_LINE));
  assert.ok(!prompt(input).includes(INDEX_LINE));
});

test("another session's TOPIX is never compared with the Nikkei 225: it is dropped with its own gap", async () => {
  const input = await closeInput((payload) => withTopix(payload, { session_date: "2026-10-03", expected_session_date: "2026-10-03" }));
  assert.ok(!input.metricFacts.some((item) => item.key === "topix"));
  assert.ok(!input.majorMoves.some((move) => move.metric_key === "topix"));
  assert.ok(input.dataGapsJa.includes(TOPIX_SESSION_GAP_JA));
  assert.deepEqual(input.directionBasis, ["nikkei225"]);
});

test("off (no topix in the packet): input and prompt are exactly as in Phase 2", async () => {
  const fixture = await loadFixture("close_2026-10-06");
  const off = await closeInput((payload) => payload);
  assert.ok(off.dataGapsJa.includes(TOPIX_GAP_JA));
  assert.ok(prompt(off).includes(NO_TOPIX_LINE));
  assert.ok(!prompt(off).includes(INDEX_LINE));
  assert.ok(!off.metricFacts.some((item) => item.key === "topix"));
  assert.equal(fixture.data.payload.metrics.some((metric: Metric) => metric.key === "topix"), false);
});

test("guards with TOPIX: its own value passes; 1306's yen value, an invented value or the wrong direction is removed", async () => {
  const input = await closeInput((payload) => withTopix(payload));
  const check = unitChecker(input, []);
  const codes = (text: string) => check(text, "factual").remove.map((finding) => finding.code);
  assert.deepEqual(codes("10月6日のTOPIXは3,412.56（前日比+0.66%）でした。"), []);
  assert.deepEqual(codes("10月6日の日経平均は70,683.98（前日比+1.05%）、TOPIXは3,412.56（前日比+0.66%）と、そろって上げました。"), []);
  assert.deepEqual(codes("10月6日のTOPIX（東証株価指数）は前日比+0.66%でした。"), []);
  assert.ok(codes("10月6日のTOPIXは3,450.00でした。").includes("VALUE_NOT_IN_INPUT"), "an invented TOPIX value");
  assert.ok(codes("10月6日のTOPIXは下落しました。").includes("WRONG_DIRECTION"), "the wrong direction");
  // 1306 is not in the nikkei_only input: its yen value under any name is a value not in the input.
  const proxy = (await loadFixture("close_2026-10-06")).data.payload.metrics.find((metric: Metric) => metric.key === "topix_proxy_1306")!;
  const proxyValue = proxy.value!.toFixed(1);
  assert.ok(codes(`10月6日のTOPIXは${proxyValue}でした。`).includes("VALUE_NOT_IN_INPUT"));
  assert.ok(codes(`10月6日のTOPIX連動ETF（1306）は${proxyValue}円でした。`).includes("VALUE_NOT_IN_INPUT"));
});

test("guards with TOPIX and 1306 both in the input (legacy_1306): 1306's value written as TOPIX is still removed", async () => {
  const input = await closeInput((payload) => withTopix(payload), "legacy_1306");
  const proxy = input.metricFacts.find((item) => item.key === "topix_proxy_1306")!;
  const check = unitChecker(input, []);
  const asTopix = check(`10月6日のTOPIXは${proxy.valueDisplay}（前日比${proxy.changeDisplay}）でした。`, "factual").remove;
  assert.ok(asTopix.length > 0 && asTopix.every((finding) => finding.code === "WRONG_VALUE"), JSON.stringify(asTopix));
  assert.deepEqual(check(`10月6日の${proxy.label}は${proxy.valueDisplay}でした。`, "factual").remove, []);
  assert.deepEqual(check("10月6日のTOPIXは3,412.56でした。", "factual").remove, []);
});

test("no TOPIX in the input: a TOPIX value the model makes up is removed", async () => {
  const input = await closeInput((payload) => payload);
  const codes = unitChecker(input, [])("10月6日のTOPIXは3,412.56（前日比+0.66%）でした。", "factual").remove.map((finding) => finding.code);
  assert.ok(codes.includes("TOPIX_MISLABEL"));
  assert.ok(codes.includes("VALUE_NOT_IN_INPUT"));
});

// ---------------------------------------------------------------------------
// Whole pipeline: the Phase 2 hand-written samples with one TOPIX sentence added (not model output).
// ---------------------------------------------------------------------------

const SAMPLES = [
  {
    name: "close_2026-10-06", after: "phase2_after_close_2026-10-06.json",
    topix: { value: 3412.56, previous_close: 3390.1, change: 22.46, change_pct: 0.66 },
    sentence: "10月6日のTOPIXも3,412.56（前日比+0.66%）と上げましたが、上げ幅は日経平均より小さめです。",
    referenceLine: `${TOPIX_INDEX_LABEL} 3,412.56（前日比+0.66%）`,
  },
  {
    name: "morning_2026-10-02", after: "phase2_after_morning_2026-10-02.json",
    topix: { value: 3450.2, previous_close: 3401.33, change: 48.87, change_pct: 1.44 },
    sentence: "10月1日のTOPIXは3,450.20（前日比+1.44%）で、日経平均ほどは上げていません。",
    referenceLine: `${TOPIX_INDEX_LABEL} 3,450.20（前日比+1.44%）`,
  },
] as const;

for (const sample of SAMPLES) {
  test(`${sample.name} with TOPIX: delivered whole (generate + Fact), TOPIX in the story and in the reference lines`, async () => {
    const fixture = await loadFixture(sample.name);
    const input = buildAnalysisInput({
      dataPacket: withTopix(fixture.data.payload, sample.topix), dataPacketId: fixture.data.id,
      dataContentHash: fixture.data.content_hash, newsRows: fixture.news, newsSelection: "market_wide", japanMetrics: "nikkei_only",
    });
    const draft = await read(sample.after) as GeneratedAnalysis;
    const japan = draft.app_story!.japan_ja.split("。");
    draft.app_story!.japan_ja = [japan[0], sample.sentence.replace(/。$/u, ""), ...japan.slice(1)].join("。");
    const calls: string[] = [];
    const requester: Requester = (step) => {
      calls.push(step);
      return Promise.resolve({ payload: step === "fact" ? { passed: true, issues: [], objective_issues: [] } : draft, inputTokens: 0, outputTokens: 0 });
    };
    const outcome = await generateSharedAnalysis(input, requester, () => new Date(fixture.data.payload.generated_at));
    assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.issues));
    const packet = (outcome as { packet: MarketReportPacket }).packet;
    assert.deepEqual(calls, ["generate", "fact"]);
    assert.deepEqual(packet.fact.removed_units ?? [], []);
    assert.ok(packet.app_story!.japan_ja.includes(sample.sentence));
    assert.ok(packet.major_moves.some((move) => move.metric_key === "topix" && move.label === TOPIX_INDEX_LABEL));
    assert.ok(!packet.major_moves.some((move) => move.metric_key === "topix_proxy_1306"));
    assert.ok(!packet.data_gaps_ja.includes(TOPIX_GAP_JA));
    const story = JSON.stringify(buildAppMarketStory(packet));
    assert.ok(story.includes(sample.referenceLine), "the TOPIX line sits with the Tokyo market");
    assert.ok(!/TOPIX連動ETF|1306/u.test(formatSharedXPost(packet) + story));
  });
}
