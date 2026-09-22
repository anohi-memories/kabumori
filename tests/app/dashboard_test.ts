import assert from "node:assert/strict";
import test from "node:test";

import {
  dashboardGreeting,
  dashboardSectionError,
  summarizeTrackedStocks,
  todayJst,
  todaysReports,
} from "../../src/lib/dashboard.ts";
import type { PersonalizedReport } from "../../src/lib/report-presentation.ts";
import type { TrackedStock } from "../../src/lib/stocks.ts";

function stock(tracking_type: 'holding' | 'watch', id: string): TrackedStock {
  return {
    id,
    user_id: 'user',
    stock_id: id,
    tracking_type,
    quantity: null,
    average_price: null,
    position_type: null,
    side: null,
    target_buy_price: null,
    target_sell_price: null,
    memo: null,
    stocks_master: { id, ticker_code: id, company_name: id, market: '東P' },
  };
}

function report(report_type: 'morning' | 'close', trading_date: string): PersonalizedReport {
  return {
    id: `${report_type}-${trading_date}`,
    report_type,
    trading_date,
    title_ja: report_type,
    summary_ja: null,
    generated_at: null,
    body: null,
    portfolio_snapshot: null,
  };
}

test('greeting follows JST time buckets', () => {
  assert.equal(dashboardGreeting(new Date('2026-09-21T01:00:00Z')).title, 'おはようございます');
  assert.equal(dashboardGreeting(new Date('2026-09-21T03:00:00Z')).title, '今日のかぶモリ');
  assert.equal(dashboardGreeting(new Date('2026-09-21T10:00:00Z')).title, '今日もお疲れさまでした');
});

test('tracked summary counts holdings and watch rows', () => {
  assert.deepEqual(summarizeTrackedStocks([stock('holding', '1'), stock('watch', '2'), stock('holding', '3')]), {
    holdingCount: 2,
    watchCount: 1,
    totalCount: 3,
  });
});

test('today and report selection use JST and keep report types separate', () => {
  const now = new Date('2026-09-21T15:30:00Z');
  assert.equal(todayJst(now), '2026-09-22');
  const selected = todaysReports([
    report('morning', '2026-09-22'),
    report('close', '2026-09-22'),
    report('close', '2026-09-21'),
  ], '2026-09-22');
  assert.equal(selected.morning?.id, 'morning-2026-09-22');
  assert.equal(selected.close?.id, 'close-2026-09-22');
});

test('dashboard section errors use fixed copy instead of backend details', () => {
  const backendError = 'PostgREST: internal database detail';

  assert.equal(dashboardSectionError('stocks'), '登録銘柄を読み込めませんでした。');
  assert.equal(dashboardSectionError('news'), '重要ニュースを読み込めませんでした。');
  assert.equal(dashboardSectionError('reports'), 'レポートを読み込めませんでした。');

  for (const section of ['stocks', 'news', 'reports'] as const) {
    assert.notEqual(dashboardSectionError(section), backendError);
    assert.equal(dashboardSectionError(section).includes(backendError), false);
  }
});
