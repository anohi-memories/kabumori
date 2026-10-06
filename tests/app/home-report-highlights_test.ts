import assert from "node:assert/strict";
import test from "node:test";

import { buildReportHighlights, currentReport, reportCardStatus } from "../../src/lib/home-report-highlights.ts";
import type { MarketDetail, PersonalizedReport, ReportBody } from "../../src/lib/report-presentation.ts";

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

const TODAY = "2026-09-28";

test("currentReport: yesterday-only rows never leak in as today's report", () => {
  const yesterday = report({ id: "a", trading_date: "2026-09-27" });
  assert.equal(currentReport([yesterday], TODAY), null);
  assert.equal(currentReport([], TODAY), null);
});

test("currentReport: today's morning report is used when it's the only one today", () => {
  const morning = report({ id: "m", trading_date: TODAY, report_type: "morning", generated_at: "2026-09-28T00:00:00Z" });
  const yesterday = report({ id: "y", trading_date: "2026-09-27", generated_at: "2026-09-28T09:00:00Z" });
  assert.equal(currentReport([yesterday, morning], TODAY)?.id, "m");
});

test("currentReport: with both morning and close today, the later-generated one wins", () => {
  const morning = report({ id: "m", trading_date: TODAY, report_type: "morning", generated_at: "2026-09-28T00:00:00Z" });
  const close = report({ id: "c", trading_date: TODAY, report_type: "close", generated_at: "2026-09-28T08:30:00Z" });
  assert.equal(currentReport([morning, close], TODAY)?.id, "c");
  assert.equal(currentReport([close, morning], TODAY)?.id, "c");
});

test("currentReport: a future-dated row never leaks in either", () => {
  const future = report({ id: "f", trading_date: "2026-09-29" });
  assert.equal(currentReport([future], TODAY), null);
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

test("prefers the shared report's three headlines over today_claims", () => {
  const detail: MarketDetail = {
    version: "1",
    report_type: "close",
    direction: "up",
    headline_ja: "h",
    summary_ja: "s",
    metric_groups: [],
    overnight_claims: [],
    today_claims: [{ text_ja: "日経平均は69,946.86（前日比+2.40%）で終えました。", claim_type: "observation" }],
    tailwind_themes_ja: [],
    headwind_themes_ja: [],
    key_news: [],
    watch_points_ja: [],
    risks_ja: [],
    data_gaps_ja: [],
    morning_reference: null,
  };
  const points = ["主要指数がそろって上昇、主因は絞れず", "G7が原油の協調放出で合意", "次は米国株と為替の反応を確認"];
  const result = buildReportHighlights(report({ body: { market_detail: { ...detail, points_ja: points } } }));
  assert.equal(result.source, "shared_points");
  assert.deepEqual(result.points, points);

  // An older report without the field, or with an empty list, keeps today_claims.
  for (const market_detail of [detail, { ...detail, points_ja: [] }]) {
    const fallback = buildReportHighlights(report({ body: { market_detail } }));
    assert.equal(fallback.source, "today_claims");
  }
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

test("reportCardStatus: loading only applies while nothing is shown yet", () => {
  assert.equal(reportCardStatus(false, true, ""), "loading");
  assert.equal(reportCardStatus(true, true, ""), "report");
});

test("reportCardStatus: a fetch error is never shown as the empty/not-generated state", () => {
  assert.equal(reportCardStatus(false, false, "レポートを読み込めませんでした。"), "error");
});

test("reportCardStatus: an already-loaded report is shown even if a later refresh errors", () => {
  assert.equal(reportCardStatus(true, false, "レポートを読み込めませんでした。"), "report");
});

test("reportCardStatus: no report and no error, loading finished, is the honest empty state", () => {
  assert.equal(reportCardStatus(false, false, ""), "empty");
});
