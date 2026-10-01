// The app's market-wide story (presentation v2) is built once from the shared packet and is the same
// for every user; the per-user layer adds holdings without changing it.
import assert from "node:assert/strict";
import test from "node:test";
import { assemblePacket, reportContentHash } from "../market-report-analysis/analysis_logic.ts";
import { inputOf, loadFixture, richClose0930, richMorning1001 } from "../market-report-analysis/test_support.ts";
import { formatSharedXPost, type MarketReportPacket, type SharedMarketReportResult } from "../_shared/market_report_packet.ts";
import { appStoryText, buildAppMarketStory } from "../_shared/market_report_story.ts";
import { buildSharedConsumption, type CompletedSharedReport } from "./shared_gate.ts";

const close = await loadFixture("close_2026-09-30");
const morning = await loadFixture("morning_2026-10-01");
const morning0930: MarketReportPacket = JSON.parse(await Deno.readTextFile(
  new URL("../market-report-analysis/fixtures/morning_2026-09-30_generated_report.json", import.meta.url),
)).payload;

async function completed(fixture: typeof close, report: MarketReportPacket): Promise<CompletedSharedReport> {
  return {
    enabled: true, status: "completed", report_packet_id: "report-1", report_content_hash: await reportContentHash(report),
    data_packet_id: fixture.data.id, data_content_hash: fixture.data.content_hash, report,
    data: fixture.data.payload as unknown as CompletedSharedReport["data"],
  };
}

test("close: market_detail carries the story built from the packet X is posted from, with the morning check", async () => {
  const input = inputOf(close);
  const report = assemblePacket(input, richClose0930(input), { generatedAt: new Date("2026-09-30T07:35:20Z"), attempts: 1 });
  const shared = await completed(close, report);
  const morningShared: SharedMarketReportResult = { ...shared, report_packet_id: "morning-1", report: morning0930 };
  const { marketDetail, sharedInput } = buildSharedConsumption({ reportType: "close", tradingDate: "2026-09-30", shared, morningShared });
  assert.deepEqual(marketDetail.story, buildAppMarketStory(report, morning0930));
  assert.equal(marketDetail.story.version, "app_market_story.v2");
  assert.ok(marketDetail.story.sections.some((section) => section.key === "morning_check"));
  // Same packet, same facts as the X digest; the existing v1 fields of market_detail are untouched.
  assert.equal(marketDetail.report_packet_id, "report-1");
  assert.equal(sharedInput.section.report_content_hash, shared.report_content_hash);
  assert.equal(marketDetail.headline_ja, report.headline_ja);
  assert.ok(formatSharedXPost(report).includes("66,753.72") && appStoryText(marketDetail.story).includes("日経平均 66,753.72（前日比+1.94%）"));
  assert.equal(marketDetail.version, "app_market_detail.v1");
});

test("morning: the story takes no user input, so every user in a run gets the identical market story", async () => {
  const input = inputOf(morning);
  const report = assemblePacket(input, richMorning1001(input), { generatedAt: new Date("2026-09-30T22:55:20Z"), attempts: 1 });
  const shared = await completed(morning, report);
  const first = buildSharedConsumption({ reportType: "morning", tradingDate: "2026-10-01", shared });
  const second = buildSharedConsumption({ reportType: "morning", tradingDate: "2026-10-01", shared });
  assert.deepEqual(first.marketDetail.story, second.marketDetail.story);
  assert.equal(first.marketDetail.story.sections.some((section) => section.key === "morning_check"), false);
  // A company item a user holds can be raised in the per-user layer; the shared story is not rewritten for it.
  const text = appStoryText(first.marketDetail.story);
  const news = first.marketDetail.story.sections.find((section) => section.key === "news")!;
  assert.ok(news.lines_ja[0].startsWith("トランプ氏、AI企業と自主協定を発表"), "market-wide items lead the shared story");
  assert.ok(news.lines_ja[news.lines_ja.length - 1].includes("減損損失"), "the company notice stays last in the shared story");
  for (const forbidden of ["保有銘柄", "保有株", "評価額", "損益"]) assert.ok(!text.includes(forbidden), forbidden);
});
