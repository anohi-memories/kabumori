// オンデマンド分析の1件分の処理。定時の個別レポートと同じ部品（スナップショット・パケット・生成・Fact 確認・
// 保存の形）を使うので、文章の方針（Fact V2）と表示の形は個別レポートと同じ。
//
// 違い
//   - 共通の朝刊・大引けは、アプリ用のゲート（market_report_consumer_settings.app_enabled）を通さず、
//     完成した回のパケットを直接読む（service_role の SELECT。どの回を使うかは market_basis.ts）。
//     共通の回が無いときは、旧来の「市場の節なし」の書き方には戻らない（待つか、失敗する）。
//   - 株価は基準の回の日付に合わせる（pinSeriesToSession）。
//   - 保存先は personalized_analysis_results（complete_personalized_analysis_job が書く）。

import {
  buildPacket,
  buildSnapshot,
  generateReport,
  jstParts,
  morningReportPath,
  morningStancesFromRows,
  newsWindowStartIso,
  priceFactFromSharedMetric,
  reportUpdate,
  yahooSymbol,
  BENCHMARK_LABEL,
  BENCHMARK_SYMBOL,
  type PriceSeries,
  type Requester,
  type Stance,
  type TrackedInput,
} from "../personalized-reports/report_logic.ts";
import { buildSharedConsumption, type CompletedSharedReport } from "../personalized-reports/shared_gate.ts";
import { withDeliveryPolicy } from "../personalized-reports/delivery_policy.ts";
import { loadMicMarketContext, micSourceBasis, toMicPacketEntries } from "../personalized-reports/mic_market_context.ts";
import { toNews, toTracked, TRACKED_SELECT, type NewsRow, type TrackedRow } from "../personalized-reports/portfolio_inputs.ts";
import type { MarketReportPacket, ReportType } from "../_shared/market_report_packet.ts";
import { addDays, BASIS_WINDOW_DAYS, modelForTier, pinSeriesToSession, resolveMarketBasis, type CycleRow } from "./market_basis.ts";
import type { AnalyzeOutcome, ClaimedJob } from "./worker_logic.ts";

export type PipelineDb = {
  get<T>(path: string): Promise<T>;
  rpc<T>(name: string, args: Record<string, unknown>): Promise<T>;
};

export type PipelineDeps = {
  db: PipelineDb;
  fetchSeries(symbols: string[]): Promise<Map<string, PriceSeries | null>>;
  requester: Requester;
  now: () => Date;
};

const INDEX_SYMBOLS = [{ label: "日経平均", symbol: "^N225" }, { label: BENCHMARK_LABEL, symbol: BENCHMARK_SYMBOL }];
const INDEX_METRIC_KEYS: Record<string, string> = { "^N225": "nikkei225", [BENCHMARK_SYMBOL]: "topix_proxy_1306" };
const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type PacketRow = { id: string; content_hash: string; data_packet_id: string; payload: MarketReportPacket };
type DataRow = { id: string; content_hash: string; payload: Record<string, unknown> };

/** 完成した回のパケット（共通レポートとその元のデータ）を、get_shared_market_report と同じ形で読む。 */
export async function loadCompletedShared(db: PipelineDb, reportPacketId: string): Promise<CompletedSharedReport> {
  if (!UUID.test(reportPacketId)) throw new Error("MARKET_REPORT_PACKET_INVALID");
  const reports = await db.get<PacketRow[]>(
    `market_report_packets?id=eq.${reportPacketId}&select=id,content_hash,data_packet_id,payload`,
  );
  const report = reports?.[0];
  if (!report || !UUID.test(report.data_packet_id)) throw new Error("MARKET_REPORT_PACKET_MISSING");
  const datas = await db.get<DataRow[]>(
    `market_data_packets?id=eq.${report.data_packet_id}&select=id,content_hash,payload`,
  );
  const data = datas?.[0];
  if (!data) throw new Error("MARKET_DATA_PACKET_MISSING");
  return {
    enabled: true,
    status: "completed",
    report_packet_id: report.id,
    report_content_hash: report.content_hash,
    data_packet_id: data.id,
    data_content_hash: data.content_hash,
    report: report.payload,
    data: data.payload as CompletedSharedReport["data"],
  };
}

export async function analyzeJob(job: ClaimedJob, deps: PipelineDeps): Promise<AnalyzeOutcome> {
  const { db } = deps;
  if (!UUID.test(job.user_id) || !DATE.test(job.request_date)) {
    return { kind: "failed", code: "JOB_INVALID", retryable: false, calls: 0 };
  }
  try {
    modelForTier(job.model_tier);
  } catch {
    return { kind: "failed", code: "MODEL_TIER_UNAVAILABLE", retryable: false, calls: 0 };
  }

  // 1. 基準の回
  const cycles = await db.get<CycleRow[]>(
    "market_report_cycles?report_type=in.(morning,close)" +
      `&trading_date=gte.${addDays(job.request_date, -BASIS_WINDOW_DAYS)}&trading_date=lte.${job.request_date}` +
      "&select=report_type,trading_date,report_status,current_report_packet_id&order=trading_date.desc",
  );
  const basis = resolveMarketBasis({
    scope: job.scope,
    requestDate: job.request_date,
    cycles: cycles ?? [],
    finalAttempt: job.attempt_count >= job.max_attempts,
  });
  if (basis.action !== "use") {
    return { kind: "failed", code: basis.code, retryable: basis.action === "retry", calls: 0 };
  }
  const reportType: ReportType = basis.reportType;
  const tradingDate = basis.tradingDate;
  const shared = await loadCompletedShared(db, basis.reportPacketId);
  if (shared.report.report_type !== reportType || shared.report.trading_date !== tradingDate) {
    throw new Error("MARKET_REPORT_PACKET_MISMATCH");
  }
  // 大引け: 同じ日の朝刊（朝→大引けの振り返り用。無くても書ける）。
  let morningShared: CompletedSharedReport | null = null;
  if (reportType === "close") {
    const morning = (cycles ?? []).find((row) =>
      row.report_type === "morning" && row.trading_date === tradingDate && row.report_status === "completed" &&
      typeof row.current_report_packet_id === "string"
    );
    if (morning) morningShared = await loadCompletedShared(db, morning.current_report_packet_id!).catch(() => null);
  }
  const consumption = buildSharedConsumption({ reportType, tradingDate, shared, morningShared });

  // 2. 本人の保有・ウォッチ（user_id を固定して読み、返った行も本人のものだけを使う）
  const trackedRows = await db.get<TrackedRow[]>(
    `tracked_stocks?is_active=eq.true&user_id=eq.${job.user_id}&select=${TRACKED_SELECT}&order=created_at.asc`,
  );
  const tracked = (trackedRows ?? [])
    .filter((row) => row.user_id === job.user_id)
    .map(toTracked)
    .filter((row): row is TrackedInput => row !== null);
  if (tracked.length === 0) return { kind: "failed", code: "NO_TRACKED_STOCKS", retryable: false, calls: 0 };

  // 3. 株価（基準の回の日付に合わせる）、指数（共通のデータパケットの値）、ニュース
  const holidayRows = await db.get<Array<{ holiday_date: string }>>(
    `market_holidays?market=eq.JPX&holiday_date=gte.${addDays(tradingDate, -60)}&holiday_date=lte.${tradingDate}&select=holiday_date`,
  );
  const holidays = new Set((holidayRows ?? []).map((row) => row.holiday_date));
  const todayJst = jstParts(deps.now()).date;
  const tickers = [...new Set(tracked.map((stock) => stock.tickerCode))];
  const series = await deps.fetchSeries(tickers.map(yahooSymbol));
  const prices = new Map(tickers.map((ticker) => [
    ticker,
    pinSeriesToSession(series.get(yahooSymbol(ticker)) ?? null, reportType, tradingDate, todayJst),
  ]));
  const indices = INDEX_SYMBOLS.map((index) => ({
    label: index.label,
    series: null,
    price: priceFactFromSharedMetric(
      (shared.data.metrics ?? []).find((metric) => metric.key === INDEX_METRIC_KEYS[index.symbol]),
    ),
  }));
  const since = newsWindowStartIso(tradingDate, holidays);
  const newsRows = await db.rpc<NewsRow[]>("personalized_report_news_inputs", { p_user_id: job.user_id, p_since: since });
  const news = (newsRows ?? []).map(toNews);

  // 大引け: 本人の同じ日の朝の見立て（定時の朝刊があれば。無くても書ける）。
  let morningStances = new Map<string, Stance>();
  let morningReportId: string | null = null;
  if (reportType === "close") {
    const rows = await db.get<Array<{ id?: unknown; user_id?: unknown; body?: unknown }>>(morningReportPath(job.user_id, tradingDate))
      .catch(() => null);
    const morning = morningStancesFromRows(rows, job.user_id);
    morningStances = morning.stances;
    morningReportId = morning.reportId;
  }

  const micStates = await loadMicMarketContext(db);
  const snapshot = buildSnapshot({ reportType, tradingDate, tracked, prices, indices, news, morningStances });
  const packet = buildPacket(snapshot, news, consumption.sharedInput, toMicPacketEntries(micStates));
  const outcome = await generateReport(snapshot, packet, deps.requester);
  const sourceBasis = {
    lane: "app_ondemand_v1",
    job_id: job.job_id,
    scope: job.scope,
    request_date: job.request_date,
    attempt: job.attempt_count,
    basis_report_type: reportType,
    basis_trading_date: tradingDate,
    basis_is_request_date: basis.isRequestDate,
    news_since: since,
    news_ids: snapshot.news.map((item) => item.news_id),
    price_source: "yahoo_chart_1d",
    price_pinned_to: tradingDate,
    index_source: "market_data_packet",
    shared_market_report_packet_id: shared.report_packet_id,
    shared_market_report_content_hash: shared.report_content_hash,
    market_data_packet_id: shared.data_packet_id,
    market_data_content_hash: shared.data_content_hash,
    ...(reportType === "close" ? { morning_report_id: morningReportId } : {}),
    ...micSourceBasis(micStates),
  };
  const update = reportUpdate(
    outcome, snapshot, withDeliveryPolicy(sourceBasis, outcome), deps.now(), consumption.sharedInput.section,
    consumption.marketDetail,
  );
  if (update.status !== "completed") {
    const code = typeof update.error === "string" && update.error ? update.error : "REPORT_FAILED";
    return { kind: "failed", code, retryable: true, calls: outcome.calls };
  }
  return {
    kind: "completed",
    calls: outcome.calls,
    result: {
      title_ja: String(update.title_ja),
      summary_ja: String(update.summary_ja ?? ""),
      body: update.body as Record<string, unknown>,
      portfolio_snapshot: update.portfolio_snapshot,
      source_basis: update.source_basis as Record<string, unknown>,
      fact_status: "passed",
      model_used: String(update.model_used ?? outcome.model),
      input_tokens: outcome.inputTokens,
      output_tokens: outcome.outputTokens,
      api_cost_usd: outcome.estimatedCost,
      reference_report_packet_id: shared.report_packet_id,
      reference_data_packet_id: shared.data_packet_id,
      report_type: reportType,
      trading_date: tradingDate,
    },
  };
}
