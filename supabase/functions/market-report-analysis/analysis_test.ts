import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisInput, marketDirection } from "./analysis_input.ts";
import {
  type GeneratedAnalysis,
  generateSharedAnalysis,
  localAnalysisIssues,
  type Requester,
  reportContentHash,
} from "./analysis_logic.ts";
import { formatSharedXPost } from "../_shared/market_report_packet.ts";
import type { Metric } from "../market-report-data-packet/packet_schema.ts";
import { rich0917 } from "./test_support.ts";

const directory = new URL("./fixtures/", import.meta.url);
const dataFixture = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_data_packet.json", directory)));
const newsRows = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_news_rows.json", directory)));

function input() {
  return buildAnalysisInput({
    dataPacket: dataFixture.payload,
    dataPacketId: dataFixture.id,
    dataContentHash: dataFixture.content_hash,
    newsRows,
  });
}

/** A full presentation-v2 analysis for 9/17 (the shape a production run returns). */
function goodAnalysis(): GeneratedAnalysis {
  return rich0917(input());
}

function requester(responses: Array<{ step: "generate" | "fact"; payload: unknown }>, calls: Array<{ step: string; body: Record<string, unknown> }>): Requester {
  return async (step, body) => {
    calls.push({ step, body });
    const next = responses.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    return { payload: next.payload, inputTokens: 1000, outputTokens: 200 };
  };
}

const NOW = () => new Date("2026-09-17T07:20:05Z");

test("input from the real 9/17 close data packet: code-decided direction, displays, refs and gaps", () => {
  const built = input();
  assert.equal(built.direction, "up");
  assert.deepEqual(built.directionBasis, ["nikkei225", "topix_proxy_1306"]);
  const nikkei = built.majorMoves.find((move) => move.metric_key === "nikkei225")!;
  assert.equal(nikkei.value_display, "64,136.25");
  assert.equal(nikkei.change_pct_display, "+0.33%");
  const etf = built.majorMoves.find((move) => move.metric_key === "topix_proxy_1306")!;
  assert.equal(etf.label, "TOPIX連動ETF（1306）");
  // MIC changes compare with the previous stored observation and are not shown.
  assert.equal(built.majorMoves.find((move) => move.metric_key === "wti")!.change_pct_display, null);
  assert.equal(built.majorMoves.find((move) => move.metric_key === "jgb10y")!.freshness, "stale");
  assert.ok(built.news.length > 0 && built.news.length <= 15);
  assert.ok(built.allowedRefs.has("metric:nikkei225"));
  assert.ok(built.dataGapsJa.includes("日本国債10年利回りは8月31日時点の値です"));
  assert.ok(!JSON.stringify(built.modelInput).includes("http"));
});

test("direction is decided in code from fresh metrics", () => {
  const metric = (key: string, pct: number | null, freshness: Metric["freshness"] = "fresh") =>
    ({ key, change_pct: pct, freshness }) as Metric;
  assert.equal(marketDirection("close", [metric("nikkei225", -0.5), metric("topix_proxy_1306", -0.2)]).direction, "down");
  assert.equal(marketDirection("close", [metric("nikkei225", 0.5), metric("topix_proxy_1306", -0.2)]).direction, "mixed");
  assert.equal(marketDirection("close", [metric("nikkei225", 0.05), metric("topix_proxy_1306", -0.02)]).direction, "flat");
  assert.equal(marketDirection("morning", [metric("dow", null)]).direction, "unknown");
});

test("a well-grounded analysis passes the local checks and formats a valid X post", () => {
  const built = input();
  assert.deepEqual(localAnalysisIssues(goodAnalysis(), built), []);
});

test("local checks reject invented numbers, TOPIX mislabels, unsupported causality, unknown refs and multi-day words", () => {
  const built = input();
  const variants: Array<[string, (analysis: GeneratedAnalysis) => void]> = [
    ["入力に無い数値", (a) => { a.market_summary_ja = "日経平均は65,000を回復しました。"; }],
    ["TOPIX連動ETF（1306）をTOPIXと表記", (a) => { a.claims[0].text_ja = "TOPIXも上昇しました。"; }],
    ["ニュースの根拠が無い causal", (a) => { a.claims[1].evidence_refs = ["metric:nikkei225"]; }],
    ["入力に無い ref", (a) => { a.claims[0].evidence_refs = ["metric:growth250"]; }],
    ["複数日を前提にする語", (a) => { a.headline_ja = "日経平均は続伸"; }],
    ["URLを含む", (a) => { a.risks_ja = ["詳細は https://example.com"]; }],
    ["売買推奨・断定表現を含む", (a) => { a.x_post.closing_ja = "今が買い時です"; }],
    ["テーマの claim_ids が不正", (a) => { a.strong_themes = [{ name_ja: "半導体", claim_ids: ["c9"] }]; }],
    ["X_POST_POINTS_INVALID", (a) => { a.x_post.points_ja = ["一つだけ"]; }],
  ];
  for (const [expected, mutate] of variants) {
    const analysis = goodAnalysis();
    mutate(analysis);
    const issues = localAnalysisIssues(analysis, built);
    assert.ok(issues.some((issue) => issue.includes(expected)), `${expected} not detected: ${issues.join(" / ")}`);
  }
});

test("one generation + one Fact check produces the packet; usage and cost are counted", async () => {
  const calls: Array<{ step: string; body: Record<string, unknown> }> = [];
  const outcome = await generateSharedAnalysis(input(), requester([
    { step: "generate", payload: goodAnalysis() },
    { step: "fact", payload: { passed: true, issues: [] } },
  ], calls), NOW);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.calls, 2);
  assert.equal(outcome.inputTokens, 2000);
  assert.equal(outcome.costUsd, 0.00088);
  const packet = outcome.packet;
  assert.equal(packet.schema_version, "market_report_packet.v1");
  assert.equal(packet.data_packet_id, dataFixture.id);
  assert.equal(packet.market_direction, "up");
  // Broad-market news is listed first, whatever order the model returned.
  assert.equal(packet.key_news[0].headline_ja, input().news[0].headline_ja);
  assert.equal(packet.key_news[0].scope, "broad");
  assert.equal(packet.presentation_version, "market_presentation.v2");
  assert.equal(packet.fact.generation_attempts, 1);
  const post = formatSharedXPost(packet);
  assert.ok(post.startsWith("【大引け】きょうの日本株まとめ🌙\n"));
  assert.ok(post.includes("📌 今日の3ポイント\n・日経平均は64,136.25で取引終了"));
  // Only OpenAI Responses bodies, no tools (no web_search).
  for (const call of calls) assert.equal("tools" in call.body, false);
  assert.match(await reportContentHash(packet), /^[0-9a-f]{64}$/);
});

test("a local-check failure regenerates once with the issues; Fact failure twice fails closed", async () => {
  const bad = goodAnalysis();
  bad.headline_ja = "日経平均は続伸";
  const calls: Array<{ step: string; body: Record<string, unknown> }> = [];
  const recovered = await generateSharedAnalysis(input(), requester([
    { step: "generate", payload: bad },
    { step: "generate", payload: goodAnalysis() },
    { step: "fact", payload: { passed: true, issues: [] } },
  ], calls), NOW);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.ok && recovered.packet.fact.generation_attempts, 2);
  assert.ok(String(calls[1].body.instructions).includes("続伸"));

  const failed = await generateSharedAnalysis(input(), requester([
    { step: "generate", payload: goodAnalysis() },
    { step: "fact", payload: { passed: false, issues: ["根拠の無い因果"] } },
    { step: "generate", payload: goodAnalysis() },
    { step: "fact", payload: { passed: false, issues: ["根拠の無い因果"] } },
  ], []), NOW);
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.error, "ANALYSIS_FACT_FAILED");
  assert.equal(failed.calls, 4);
});

test("content hash ignores generated_at", async () => {
  const built = input();
  const a = await generateSharedAnalysis(built, requester([
    { step: "generate", payload: goodAnalysis() }, { step: "fact", payload: { passed: true, issues: [] } },
  ], []), () => new Date("2026-09-17T07:20:00Z"));
  const b = await generateSharedAnalysis(built, requester([
    { step: "generate", payload: goodAnalysis() }, { step: "fact", payload: { passed: true, issues: [] } },
  ], []), () => new Date("2026-09-17T07:30:00Z"));
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.equal(await reportContentHash(a.packet), await reportContentHash(b.packet));
});
