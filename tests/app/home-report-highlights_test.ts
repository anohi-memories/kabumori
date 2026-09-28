import assert from "node:assert/strict";
import test from "node:test";

import { buildReportHighlights, latestReport } from "../../src/lib/home-report-highlights.ts";
import type { PersonalizedReport, ReportBody } from "../../src/lib/report-presentation.ts";

function report(overrides: Partial<PersonalizedReport> & { body?: ReportBody | null } = {}): PersonalizedReport {
  return {
    id: overrides.id ?? "r1",
    report_type: overrides.report_type ?? "morning",
    trading_date: overrides.trading_date ?? "2026-09-28",
    title_ja: overrides.title_ja ?? "朝刊",
    summary_ja: overrides.summary_ja ?? null,
    generated_at: overrides.generated_at ?? null,
    body: overrides.body ?? null,
    portfolio_snapshot: overrides.portfolio_snapshot ?? null,
  };
}

test("latestReport picks the newest by trading_date then generated_at", () => {
  const older = report({ id: "a", trading_date: "2026-09-27" });
  const sameDayEarlier = report({ id: "b", trading_date: "2026-09-28", generated_at: "2026-09-28T00:00:00Z" });
  const sameDayLater = report({ id: "c", trading_date: "2026-09-28", generated_at: "2026-09-28T08:00:00Z" });
  assert.equal(latestReport([older, sameDayEarlier, sameDayLater])?.id, "c");
  assert.equal(latestReport([])?.id, undefined);
});

test("no report yields no points, source none", () => {
  assert.deepEqual(buildReportHighlights(null), { points: [], source: "none" });
});

test("prefers today_claims from market_detail when present", () => {
  const result = buildReportHighlights(report({
    body: {
      market_detail: {
        version: "1",
        report_type: "morning",
        direction: "up",
        headline_ja: "h",
        summary_ja: "s",
        metric_groups: [],
        overnight_claims: [],
        today_claims: [
          { text_ja: "日経平均は続伸しました。", claim_type: "observation" },
          { text_ja: "半導体関連株が買われました。", claim_type: "observation" },
        ],
        tailwind_themes_ja: [],
        headwind_themes_ja: [],
        key_news: [],
        watch_points_ja: [],
        risks_ja: [],
        data_gaps_ja: [],
        morning_reference: null,
      },
      checkpoints_ja: ["これは使われないはず"],
    },
    summary_ja: "これも使われないはず",
  }));
  assert.equal(result.source, "today_claims");
  assert.deepEqual(result.points, ["日経平均は続伸しました。", "半導体関連株が買われました。"]);
});

test("falls back to checkpoints_ja when no today_claims", () => {
  const result = buildReportHighlights(report({
    body: { checkpoints_ja: ["円安が進みました。", "米国株は上昇しました。"] },
  }));
  assert.equal(result.source, "checkpoints");
  assert.deepEqual(result.points, ["円安が進みました。", "米国株は上昇しました。"]);
});

test("falls back to market_section claims when no checkpoints", () => {
  const result = buildReportHighlights(report({
    body: {
      market_section: {
        report_packet_id: "p1",
        market_direction: "up",
        headline_ja: "h",
        market_summary_ja: "s",
        major_moves: [],
        claims: [{ text_ja: "原油価格が上昇しました。", claim_type: "observation", scope: "market" }],
        key_news: [],
        next_watch_ja: [],
        risks_ja: [],
        data_gaps_ja: [],
      },
    },
  }));
  assert.equal(result.source, "market_claims");
  assert.deepEqual(result.points, ["原油価格が上昇しました。"]);
});

test("falls back to overview_ja split into sentences, capped at 3", () => {
  const result = buildReportHighlights(report({
    body: { overview_ja: "市場は堅調でした。個別では半導体が強かったです。為替は落ち着いていました。余分な文です。" },
  }));
  assert.equal(result.source, "overview");
  assert.equal(result.points.length, 3);
  assert.equal(result.points[0], "市場は堅調でした。");
});

test("fails soft to summary_ja as a single point when nothing structured exists", () => {
  const result = buildReportHighlights(report({ body: null, summary_ja: "今日は全体的に穏やかな一日でした。" }));
  assert.equal(result.source, "summary");
  assert.deepEqual(result.points, ["今日は全体的に穏やかな一日でした。"]);
});

test("never fabricates points when every field is empty", () => {
  const result = buildReportHighlights(report({ body: {}, summary_ja: null }));
  assert.deepEqual(result, { points: [], source: "none" });
});

test("drops duplicate/empty points and caps at 3", () => {
  const result = buildReportHighlights(report({
    body: { checkpoints_ja: ["同じ文です。", "同じ文です。", "", "二つ目です。", "三つ目です。", "四つ目です。"] },
  }));
  assert.deepEqual(result.points, ["同じ文です。", "二つ目です。", "三つ目です。"]);
});
