import assert from "node:assert/strict";
import test from "node:test";
import { loadSharedMarketReport, publishSharedMarketReport, type SharedPublishDeps } from "./shared_market_report_consumer.ts";
import {
  appMarketSection,
  formatSharedXPost,
  type MarketReportPacket,
  type SharedMarketReportResult,
} from "../_shared/market_report_packet.ts";
import { appendKabumoriReportFixedHashtags } from "./fixed_hashtags_logic.ts";

const REPORT: MarketReportPacket = {
  schema_version: "market_report_packet.v1",
  report_type: "close",
  trading_date: "2026-09-17",
  data_packet_id: "d1",
  data_content_hash: "a".repeat(64),
  generated_at: "2026-09-17T07:20:05.000Z",
  model: "gpt-5.6-luna",
  market_direction: "up",
  direction_basis: ["nikkei225", "topix_proxy_1306"],
  headline_ja: "日経平均は64,136.25で小幅高",
  market_summary_ja: "日経平均は+0.33%、TOPIX連動ETF（1306）は+0.83%でした。",
  major_moves: [{ metric_key: "nikkei225", label: "日経平均", session_date: "2026-09-17", value_display: "64,136.25", change_pct_display: "+0.33%", freshness: "fresh" }],
  claims: [{ claim_id: "c1", text_ja: "日経平均は+0.33%でした。", claim_type: "observation", evidence_refs: ["metric:nikkei225"], scope: "today" }],
  key_news: [],
  strong_themes: [],
  weak_themes: [],
  next_watch_ja: ["今夜の米国株"],
  risks_ja: [],
  data_gaps_ja: ["日経平均先物は確認できる取得元がないため載せていません"],
  x_post: {
    lead_ja: "きょうの日本株は日経平均が+0.33%、TOPIX連動ETF（1306）が+0.83%でした",
    points_ja: ["日経平均は64,136.25で取引終了", "TOPIX連動ETF（1306）は427.4円", "前夜のNYダウは−1.21%でした"],
    closing_ja: "今夜の米国株の動きもあわせて見ておきたいです",
  },
  fact: { local_issues: [], ai_status: "passed", generation_attempts: 1 },
};

const COMPLETED: SharedMarketReportResult = {
  enabled: true,
  status: "completed",
  report_packet_id: "r1",
  report_content_hash: "b".repeat(64),
  data_packet_id: "d1",
  data_content_hash: "a".repeat(64),
  report: REPORT,
  data: {
    as_of: "2026-09-17T07:15:00.000Z",
    metrics: [
      { key: "nikkei225", label: "日経平均", value: 64136.25, session_date: "2026-09-17", observed_at: "2026-09-17T06:45:03.000Z", freshness: "fresh", source_url: "https://query2.finance.yahoo.com/v8/finance/chart/%5EN225?range=1mo&interval=1d&events=history" },
      { key: "topix_proxy_1306", label: "TOPIX連動ETF（1306）", value: 427.4, session_date: "2026-09-17", observed_at: "2026-09-17T06:30:00.000Z", freshness: "fresh", source_url: "https://query2.finance.yahoo.com/v8/finance/chart/1306.T?range=1mo&interval=1d&events=history" },
    ],
  },
};

function recordingDeps(options: { postFails?: string } = {}) {
  const log: Array<{ op: string; args: unknown[] }> = [];
  const deps: SharedPublishDeps = {
    createRun: async () => { log.push({ op: "createRun", args: [] }); return "run-1"; },
    updateRun: async (runId, values) => { log.push({ op: "updateRun", args: [runId, values] }); },
    postToX: async (text) => {
      log.push({ op: "postToX", args: [text] });
      if (options.postFails) throw new Error(options.postFails);
      return "x-post-1";
    },
    completePost: async (runId, xPostId) => { log.push({ op: "completePost", args: [runId, xPostId] }); },
    now: () => new Date("2026-09-17T08:00:01Z"),
  };
  return { log, deps };
}

test("gate ON + completed packet: posts the deterministic shared text once and completes the run", async () => {
  const { log, deps } = recordingDeps();
  const result = await publishSharedMarketReport("close", COMPLETED, deps);
  const body = formatSharedXPost(REPORT);
  assert.equal(result.text, appendKabumoriReportFixedHashtags(body));
  assert.ok(result.text.startsWith("【大引け】きょうの日本株まとめ🌙\nきょうの日本株は日経平均が+0.33%"));
  assert.ok(result.text.startsWith(body));
  assert.deepEqual(log.map((entry) => entry.op), ["createRun", "updateRun", "postToX", "completePost"]);
  const values = log[1].args[1] as Record<string, unknown>;
  assert.equal(values.model_used, "shared_market_report");
  assert.equal(values.web_search_calls, 0);
  assert.equal(values.api_cost_usd, 0);
  assert.equal(values.generated_text, body);
  assert.equal((values.market_data as { sharedMarketReport: { reportPacketId: string } }).sharedMarketReport.reportPacketId, "r1");
  assert.equal((values.nikkei_data as { value: string }).value, "64136.25");
  assert.equal((values.topix_data as { label: string }).label, "TOPIX連動ETF（1306）");
  assert.equal(result.reportContentHash, "b".repeat(64));
});

test("gate ON + packet not ready: fails closed, records the run, never posts", async () => {
  const { log, deps } = recordingDeps();
  await assert.rejects(
    publishSharedMarketReport("close", { enabled: true, status: "not_ready", report_status: "failed" }, deps),
    /SHARED_MARKET_REPORT_UNAVAILABLE/,
  );
  assert.deepEqual(log.map((entry) => entry.op), ["createRun", "updateRun"]);
  assert.equal((log[1].args[1] as { error: string }).error, "SHARED_MARKET_REPORT_UNAVAILABLE");
});

test("packet for another report type or an invalid body is never posted", async () => {
  const wrongType = recordingDeps();
  await assert.rejects(publishSharedMarketReport("morning", COMPLETED, wrongType.deps), /TYPE_MISMATCH/);
  assert.ok(!wrongType.log.some((entry) => entry.op === "postToX"));

  const broken = recordingDeps();
  // Fewer than three points is postable since 2026-10-07 (a wrong point is removed upstream); no lead is not.
  const invalid = { ...COMPLETED, report: { ...REPORT, x_post: { ...REPORT.x_post, lead_ja: "" } } } as SharedMarketReportResult;
  await assert.rejects(publishSharedMarketReport("close", invalid, broken.deps), /FORMAT_INVALID/);
  assert.ok(!broken.log.some((entry) => entry.op === "postToX"));
});

test("X failure marks the run failed; unknown post id leaves it for manual check", async () => {
  const failed = recordingDeps({ postFails: "X_POST_FAILED:503" });
  await assert.rejects(publishSharedMarketReport("close", COMPLETED, failed.deps), /X_POST_FAILED/);
  assert.equal((failed.log.at(-1)!.args[1] as { status: string }).status, "failed");

  const unknown = recordingDeps({ postFails: "X_RESPONSE_MISSING_POST_ID" });
  await assert.rejects(publishSharedMarketReport("close", COMPLETED, unknown.deps), /MISSING_POST_ID/);
  assert.equal(unknown.log.at(-1)!.op, "postToX");
});

test("gate read: disabled, missing RPC (404) and completed responses; other errors retry once then throw", async () => {
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  const base = { supabaseUrl: "https://p.supabase.co", serviceRoleKey: "k", reportType: "close" as const, scheduledFor: "2026-09-17T08:00:00Z" };

  assert.deepEqual(await loadSharedMarketReport({ ...base, fetchImpl: respond(200, { enabled: false, status: "disabled" }) }), { enabled: false, status: "disabled" });
  assert.deepEqual(await loadSharedMarketReport({ ...base, fetchImpl: respond(404, { code: "PGRST202" }) }), { enabled: false, status: "disabled" });
  const completed = await loadSharedMarketReport({ ...base, fetchImpl: respond(200, COMPLETED) });
  assert.equal(completed.status, "completed");

  let calls = 0;
  const bodies: string[] = [];
  const flaky: typeof fetch = async (_url, init) => {
    calls += 1;
    bodies.push(String(init?.body));
    return new Response("{}", { status: 503 });
  };
  await assert.rejects(loadSharedMarketReport({ ...base, fetchImpl: flaky }), /SHARED_MARKET_REPORT_GATE_FAILED:503/);
  assert.equal(calls, 2);
  // 17:00 JST on 9/17 is trading date 2026-09-17 in Tokyo.
  assert.ok(bodies[0].includes('"p_trading_date":"2026-09-17"') && bodies[0].includes('"p_consumer":"x"'));
});

test("app market section is the shared packet verbatim", () => {
  const section = appMarketSection(REPORT, "r1", "b".repeat(64));
  assert.equal(section.headline_ja, REPORT.headline_ja);
  assert.equal(section.market_summary_ja, REPORT.market_summary_ja);
  assert.deepEqual(section.major_moves, REPORT.major_moves);
  assert.deepEqual(section.claims, [{ text_ja: "日経平均は+0.33%でした。", claim_type: "observation", scope: "today" }]);
});

// --- presentation v2 (2026-10-01): the ~500-character digest from the same packet the app reads -----------------

import { assemblePacket } from "../market-report-analysis/analysis_logic.ts";
import { inputOf, loadFixture, richClose0930 } from "../market-report-analysis/test_support.ts";
import { PRESENTATION_VERSION, REPORT_DISCLAIMER_JA, X_POST_TARGET_MAX_CHARS, X_POST_TARGET_MIN_CHARS } from "../_shared/market_report_packet.ts";

const close0930 = await loadFixture("close_2026-09-30");
function v2Completed(): Extract<SharedMarketReportResult, { status: "completed" }> {
  const input = inputOf(close0930);
  const report = assemblePacket(input, richClose0930(input), { generatedAt: new Date("2026-09-30T07:35:20Z"), attempts: 1 });
  return { ...(COMPLETED as Extract<SharedMarketReportResult, { status: "completed" }>), report, data: close0930.data.payload as unknown as Record<string, unknown> };
}

test("presentation v2 packet: the X post is the ~500-character digest, formatted in code with no model call", async () => {
  const shared = v2Completed();
  assert.equal(shared.report.presentation_version, PRESENTATION_VERSION);
  const { log, deps } = recordingDeps();
  const result = await publishSharedMarketReport("close", shared, deps);
  const body = formatSharedXPost(shared.report);
  // The disclaimer closes the post once and is not part of the editorial length (2026-10-07).
  assert.ok(body.endsWith(`\n\n${REPORT_DISCLAIMER_JA}`));
  const length = Array.from(body).length - Array.from(REPORT_DISCLAIMER_JA).length - 2;
  assert.ok(length >= X_POST_TARGET_MIN_CHARS && length <= X_POST_TARGET_MAX_CHARS, `length ${length}`);
  assert.equal(result.text, appendKabumoriReportFixedHashtags(body));
  for (const heading of ["📌 今日の3ポイント", "📰 ", "👀 明日以降の注目点", "💬 今日のひとこと"]) assert.ok(body.includes(heading), heading);
  const values = log[1].args[1] as Record<string, unknown>;
  assert.deepEqual([values.api_cost_usd, values.web_search_calls, values.fact_check_status], [0, 0, "passed"]);
  assert.deepEqual((values.market_data as { quality_warnings: string[] }).quality_warnings, []);
  // The market detail the app builds from the same packet cites the same Nikkei value.
  assert.ok(body.includes("66,753.72") && appMarketSection(shared.report, "r1", "b".repeat(64)).market_summary_ja.includes("66,753.72"));
});

test("a short packet is posted with its quality warnings recorded; only broken output is withheld", async () => {
  const { log, deps } = recordingDeps();
  await publishSharedMarketReport("close", COMPLETED, deps);
  const recorded = (log[1].args[1] as { market_data: { quality_warnings: string[] } }).market_data.quality_warnings;
  assert.ok(recorded.some((warning) => warning.startsWith("X_POST_SHORTER_THAN_TARGET")), recorded.join(" / "));
  assert.deepEqual(log.map((entry) => entry.op), ["createRun", "updateRun", "postToX", "completePost"], "posted");

  const broken = v2Completed();
  broken.report = { ...broken.report, x_post: { ...broken.report.x_post, lead_ja: "" } };
  const second = recordingDeps();
  await assert.rejects(() => publishSharedMarketReport("close", broken, second.deps), /SHARED_MARKET_REPORT_FORMAT_INVALID/);
  assert.ok(!second.log.some((entry) => entry.op === "postToX"));
});
