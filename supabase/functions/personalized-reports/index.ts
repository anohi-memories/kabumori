// App-only personalized portfolio reports (morning / close), Phase 1.
//
// A separate lane from x-test-post's public morning_report / close_report:
// nothing here reads, writes or waits on X runs, scheduled_posts or OAuth.
// Per user with active tracked stocks it
//   1. claims (user, type, trading_date) by inserting a 'generating' row
//      (the unique constraint makes a second run a no-op),
//   2. builds a deterministic snapshot from Yahoo daily closes + the user's
//      Fact-passed news inputs (personalized_report_news_inputs),
//   3. runs one generation + one Fact check (report_logic.generateReport),
//   4. stores the result, and only for a completed, Fact-passed report asks
//      enqueue_personalized_report_notification for the completion push
//      (which itself checks push_enabled + morning_report / close_report).
//
// Auth: verify_jwt = false + the X-Cron-Secret header, compared with the
// existing SEND_PUSH_NOTIFICATIONS_CRON_SECRET (the same Vault-held value the
// dispatch cron already sends), so no new secret is introduced.
//
// dry_run: builds and generates but writes nothing and enqueues nothing; the
// response carries the snapshot and report for inspection.
import {
  buildPacket,
  buildSnapshot,
  generateReport,
  isTradingDay,
  jstParts,
  newsWindowStartIso,
  openAiRequester,
  parseYahooDaily,
  reportUpdate,
  yahooSymbol,
  type NewsInput,
  type PriceSeries,
  type ReportType,
  type TrackedInput,
  CLOSE_SESSION_END_MINUTES,
} from "./report_logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/";
const INDEX_SYMBOLS = [{ label: "日経平均", symbol: "^N225" }, { label: "TOPIX", symbol: "^TPX" }];
const PRICE_CONCURRENCY = 6;
const TIME_BUDGET_MS = 110_000;
const MAX_USERS_PER_RUN = 20;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return value.slice(0, 300);
}

function isAuthorizedCronCaller(req: Request): boolean {
  const expected = Deno.env.get("SEND_PUSH_NOTIFICATIONS_CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret");
  return typeof expected === "string" && expected.length > 0 && provided === expected;
}

function getSecretKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)["default"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function headers(secretKey: string, prefer?: string): Record<string, string> {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

type Rest = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, prefer?: string): Promise<T>;
  patch(path: string, body: unknown): Promise<void>;
};

function rest(supabaseUrl: string, secretKey: string): Rest {
  return {
    async get<T>(path: string) {
      const result = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: headers(secretKey) });
      if (!result.ok) throw new Error(`REST_GET_FAILED:${path.split("?")[0]}:${result.status}`);
      return await result.json() as T;
    },
    async post<T>(path: string, body: unknown, prefer = "return=representation") {
      const result = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method: "POST", headers: headers(secretKey, prefer), body: JSON.stringify(body),
      });
      if (!result.ok) throw new Error(`REST_POST_FAILED:${path.split("?")[0]}:${result.status}`);
      const text = await result.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    async patch(path: string, body: unknown) {
      const result = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        method: "PATCH", headers: headers(secretKey, "return=minimal"), body: JSON.stringify(body),
      });
      if (!result.ok) throw new Error(`REST_PATCH_FAILED:${path.split("?")[0]}:${result.status}`);
    },
  };
}

type TrackedRow = {
  id: string;
  user_id: string;
  tracking_type: "holding" | "watch";
  quantity: number | string | null;
  average_price: number | string | null;
  position_type: "cash" | "margin" | null;
  side: "long" | "short" | null;
  stock: { ticker_code: string; company_name: string; sector: string | null } | null;
};

type NewsRow = {
  news_id: string;
  ticker_code: string | null;
  company_name: string;
  tracking_type: "holding" | "watch";
  severity: string;
  matched_sectors: string[] | null;
  news_time: string;
  source_url: string | null;
  source_type: string | null;
  text_origin: NewsInput["textOrigin"];
  headline_ja: string;
  summary_ja: string | null;
  key_points_ja: unknown;
};

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toTracked(row: TrackedRow): TrackedInput | null {
  if (!row.stock?.ticker_code) return null;
  return {
    trackedStockId: row.id,
    tickerCode: row.stock.ticker_code,
    companyName: row.stock.company_name,
    sector: row.stock.sector,
    trackingType: row.tracking_type,
    quantity: toNumber(row.quantity),
    averagePrice: toNumber(row.average_price),
    positionType: row.position_type,
    side: row.side,
  };
}

function toNews(row: NewsRow): NewsInput {
  return {
    newsId: row.news_id,
    tickerCode: row.ticker_code,
    companyName: row.company_name,
    trackingType: row.tracking_type,
    severity: row.severity,
    matchedSectors: Array.isArray(row.matched_sectors) ? row.matched_sectors : [],
    newsTime: row.news_time,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    textOrigin: row.text_origin,
    headlineJa: row.headline_ja,
    summaryJa: row.summary_ja,
    keyPointsJa: Array.isArray(row.key_points_ja)
      ? row.key_points_ja.filter((point): point is string => typeof point === "string")
      : [],
  };
}

async function fetchSeries(symbol: string): Promise<PriceSeries | null> {
  try {
    const result = await fetch(
      `${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?range=1mo&interval=1d&events=history`,
      { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) },
    );
    if (!result.ok) return null;
    return parseYahooDaily(await result.json());
  } catch {
    return null;
  }
}

async function fetchAllSeries(symbols: string[]): Promise<Map<string, PriceSeries | null>> {
  const results = new Map<string, PriceSeries | null>();
  const queue = [...new Set(symbols)];
  const workers = Array.from({ length: Math.min(PRICE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const symbol = queue.shift()!;
      results.set(symbol, await fetchSeries(symbol));
    }
  });
  await Promise.all(workers);
  return results;
}

type RequestBody = { mode?: unknown; dry_run?: unknown; user_id?: unknown };

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!isAuthorizedCronCaller(req)) return response({ error: "UNAUTHORIZED" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!supabaseUrl || !secretKey || !openAiApiKey) return response({ error: "MISSING_CONFIGURATION" }, 500);

  let body: RequestBody = {};
  try { body = await req.json() as RequestBody; } catch { /* empty body */ }
  const reportType: ReportType | null = body.mode === "morning" || body.mode === "close" ? body.mode : null;
  if (!reportType) return response({ error: "INVALID_MODE" }, 400);
  const dryRun = body.dry_run === true;
  const onlyUser = typeof body.user_id === "string" && /^[0-9a-f-]{36}$/i.test(body.user_id) ? body.user_id : null;

  const startedAt = Date.now();
  const now = new Date();
  const jst = jstParts(now);
  const tradingDate = jst.date;
  const db = rest(supabaseUrl, secretKey);

  try {
    const holidayRows = await db.get<Array<{ holiday_date: string }>>(
      `market_holidays?market=eq.JPX&holiday_date=gte.${tradingDate.slice(0, 4)}-01-01&select=holiday_date`,
    );
    // Previous-year holidays matter for the first days of January.
    const priorYear = await db.get<Array<{ holiday_date: string }>>(
      `market_holidays?market=eq.JPX&holiday_date=gte.${Number(tradingDate.slice(0, 4)) - 1}-12-01&holiday_date=lt.${tradingDate.slice(0, 4)}-01-01&select=holiday_date`,
    );
    const holidays = new Set([...holidayRows, ...priorYear].map((row) => row.holiday_date));
    if (!isTradingDay(tradingDate, holidays)) {
      return response({ status: "skipped", reason: "NOT_TRADING_DAY", reportType, tradingDate });
    }
    if (reportType === "close" && jst.minutes < CLOSE_SESSION_END_MINUTES) {
      return response({ status: "skipped", reason: "CLOSE_TOO_EARLY", reportType, tradingDate });
    }

    const trackedRows = await db.get<TrackedRow[]>(
      "tracked_stocks?is_active=eq.true" +
        (onlyUser ? `&user_id=eq.${onlyUser}` : "") +
        "&select=id,user_id,tracking_type,quantity,average_price,position_type,side," +
        "stock:stocks_master(ticker_code,company_name,sector)&order=user_id.asc,created_at.asc",
    );
    const byUser = new Map<string, TrackedInput[]>();
    for (const row of trackedRows) {
      const tracked = toTracked(row);
      if (!tracked) continue;
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), tracked]);
    }
    const userIds = [...byUser.keys()].slice(0, MAX_USERS_PER_RUN);
    if (userIds.length === 0) return response({ status: "completed", reportType, tradingDate, users: [] });

    const tickers = [...new Set(userIds.flatMap((id) => byUser.get(id)!.map((stock) => stock.tickerCode)))];
    const series = await fetchAllSeries([...tickers.map(yahooSymbol), ...INDEX_SYMBOLS.map((index) => index.symbol)]);
    const prices = new Map(tickers.map((ticker) => [ticker, series.get(yahooSymbol(ticker)) ?? null]));
    const indices = INDEX_SYMBOLS.map((index) => ({ label: index.label, series: series.get(index.symbol) ?? null }));
    const since = newsWindowStartIso(tradingDate, holidays);
    const requester = openAiRequester(openAiApiKey);

    const results: Array<Record<string, unknown>> = [];
    for (const userId of userIds) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        results.push({ user: userId.slice(0, 8), status: "deferred", reason: "TIME_BUDGET" });
        continue;
      }
      let reportId: string | null = null;
      try {
        if (!dryRun) {
          const claimed = await db.post<Array<{ id: string }>>(
            "personalized_reports?on_conflict=user_id,report_type,trading_date",
            { user_id: userId, report_type: reportType, trading_date: tradingDate, status: "generating" },
            "resolution=ignore-duplicates,return=representation",
          );
          reportId = claimed?.[0]?.id ?? null;
          if (!reportId) {
            results.push({ user: userId.slice(0, 8), status: "skipped", reason: "ALREADY_EXISTS" });
            continue;
          }
        }
        const newsRows = await db.post<NewsRow[]>("rpc/personalized_report_news_inputs", {
          p_user_id: userId, p_since: since,
        });
        const news = (newsRows ?? []).map(toNews);
        const snapshot = buildSnapshot({
          reportType, tradingDate, tracked: byUser.get(userId)!, prices, indices, news,
        });
        const packet = buildPacket(snapshot, news);
        const outcome = await generateReport(snapshot, packet, requester);
        const sourceBasis = {
          news_since: since,
          news_ids: snapshot.news.map((item) => item.news_id),
          price_source: "yahoo_chart_1d",
          index_symbols: INDEX_SYMBOLS.map((index) => index.symbol),
          lane: "app_personalized_v1",
        };
        const update = reportUpdate(outcome, snapshot, sourceBasis);
        let notification: string = "not_attempted";
        if (!dryRun && reportId) {
          await db.patch(`personalized_reports?id=eq.${reportId}`, update);
          if (update.status === "completed") {
            const queued = await db.post<Array<{ notification_id: string }>>(
              "rpc/enqueue_personalized_report_notification", { p_report_id: reportId },
            );
            notification = queued?.length ? "queued" : "not_queued_by_settings_or_duplicate";
          }
        }
        console.log(JSON.stringify({
          event: "personalized_report", reportType, tradingDate, user: userId.slice(0, 8), dryRun,
          status: update.status, error: update.error, issues: outcome.issues, calls: outcome.calls,
          gaps: snapshot.data_gaps, news: snapshot.news.length, notification,
        }));
        results.push({
          user: userId.slice(0, 8),
          reportId,
          status: update.status,
          error: update.error,
          issues: outcome.issues,
          calls: outcome.calls,
          cost: outcome.estimatedCost,
          notification,
          ...(dryRun ? { snapshot, report: outcome.body } : {}),
        });
      } catch (error) {
        const code = safeError(error);
        if (reportId) {
          await db.patch(`personalized_reports?id=eq.${reportId}`, {
            status: "failed", fact_status: "pending", error: code, updated_at: new Date().toISOString(),
          }).catch(() => {});
        }
        results.push({ user: userId.slice(0, 8), reportId, status: "failed", error: code });
      }
    }
    return response({ status: "completed", reportType, tradingDate, dryRun, users: results });
  } catch (error) {
    return response({ status: "failed", error: safeError(error) }, 500);
  }
});
