// 1件の分析の流れ: 本物の共通パケット（2026-09-18 大引け）と、手元の模型の DB・AI（ネットワークなし）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { REPORT_MODEL, type PriceSeries, type Requester } from "../personalized-reports/report_logic.ts";
import { analyzeJob, type PipelineDb } from "./analysis_pipeline.ts";
import type { ClaimedJob } from "./worker_logic.ts";

const FIXTURES = new URL("../market-report-analysis/fixtures/", import.meta.url);
const REPORT = JSON.parse(readFileSync(new URL("close_2026-09-18_generated_report.json", FIXTURES), "utf8"));
const DATA = JSON.parse(readFileSync(new URL("close_2026-09-18_data_packet.json", FIXTURES), "utf8"));
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    job_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: USER, scope: "close", request_date: "2026-09-19",
    model_tier: "standard", attempt_count: 1, max_attempts: 2, lease_token: "t", lease_version: 1,
    lease_expires_at: "2026-09-19T03:05:00Z", ...overrides,
  };
}

type Calls = { gets: string[]; rpcs: Array<[string, Record<string, unknown>]> };

function db(options: { cycles?: unknown[]; tracked?: unknown[]; calls?: Calls } = {}): PipelineDb {
  const calls = options.calls ?? { gets: [], rpcs: [] };
  return {
    get<T>(path: string): Promise<T> {
      calls.gets.push(path);
      if (path.startsWith("market_report_cycles?")) {
        return Promise.resolve((options.cycles ?? [
          { report_type: "close", trading_date: "2026-09-18", report_status: "completed", current_report_packet_id: REPORT.id },
        ]) as T);
      }
      if (path.startsWith("market_report_packets?")) {
        assert.ok(path.includes(`id=eq.${REPORT.id}`));
        return Promise.resolve([{ id: REPORT.id, content_hash: REPORT.content_hash, data_packet_id: REPORT.payload.data_packet_id, payload: REPORT.payload }] as T);
      }
      if (path.startsWith("market_data_packets?")) {
        assert.ok(path.includes(`id=eq.${REPORT.payload.data_packet_id}`));
        return Promise.resolve([{ id: DATA.id, content_hash: DATA.content_hash, payload: DATA.payload }] as T);
      }
      if (path.startsWith("tracked_stocks?")) {
        return Promise.resolve((options.tracked ?? [
          {
            id: "ts-1", user_id: USER, tracking_type: "holding", quantity: "100", average_price: "900", position_type: "cash",
            side: "long", stock: { ticker_code: "1111", company_name: "会社1111", sector: "電気機器" },
          },
          // 万一、別の人の行が返っても使わない。
          {
            id: "ts-x", user_id: OTHER, tracking_type: "holding", quantity: "1", average_price: "1", position_type: "cash",
            side: "long", stock: { ticker_code: "9999", company_name: "他人の銘柄", sector: null },
          },
        ]) as T);
      }
      if (path.startsWith("market_holidays?")) return Promise.resolve([] as T);
      if (path.startsWith("personalized_reports?")) return Promise.resolve([] as T);
      if (path.startsWith("market_state_current?")) return Promise.reject(new Error("REST_GET_FAILED:market_state_current:404"));
      return Promise.reject(new Error(`UNEXPECTED_GET:${path}`));
    },
    rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
      calls.rpcs.push([name, args]);
      if (name === "personalized_report_news_inputs") return Promise.resolve([] as T);
      return Promise.reject(new Error(`UNEXPECTED_RPC:${name}`));
    },
  };
}

// 9/16 1000 → 9/17 1000 → 9/18 1050 → 9/19（依頼日、取引時間中）1100。基準は 9/18 の大引け。
const SERIES: PriceSeries = {
  bars: [
    { date: "2026-09-16", close: 1000 }, { date: "2026-09-17", close: 1000 },
    { date: "2026-09-18", close: 1050 }, { date: "2026-09-19", close: 1100 },
  ],
  marketTimeIso: "2026-09-19T02:00:00Z",
};

const DRAFT = {
  title_ja: "保有株の値動きと材料", summary_ja: "保有銘柄の値動きを確認しました。", tone: "neutral",
  overview_ja: "保有銘柄の値動きを整理しました。",
  holding_impacts: [{
    ticker_code: "1111", stance: "no_clear_material", basis: [],
    fact_ja: "明確な個別材料は確認できていません。", inference_ja: "", watch_ja: "",
  }],
  morning_review_ja: "", watch_notes: [], risk_notes_ja: [], checkpoints_ja: ["次の取引日の値動きを確認します。"],
  sufficient_information: true,
};

function requester(steps: string[], factPassed = true): Requester {
  return (step) => {
    steps.push(step);
    return Promise.resolve({
      payload: step === "draft" ? DRAFT : { passed: factPassed, issues: factPassed ? [] : ["UNSUPPORTED_CLAIM"] },
      inputTokens: 1000, outputTokens: 200,
    });
  };
}

function deps(overrides: { db?: PipelineDb; steps?: string[]; factPassed?: boolean; symbols?: string[][] } = {}) {
  const steps = overrides.steps ?? [];
  return {
    db: overrides.db ?? db(),
    fetchSeries: (symbols: string[]) => {
      overrides.symbols?.push(symbols);
      return Promise.resolve(new Map(symbols.map((symbol) => [symbol, symbol === "1111.T" ? SERIES : null])));
    },
    requester: requester(steps, overrides.factPassed ?? true),
    // 2026-09-19 12:00 JST
    now: () => new Date("2026-09-19T03:00:00Z"),
  };
}

test("前日の大引けを基準に、本人の保有だけで分析し、結果に基準の回と株価の基準日を残す", async () => {
  const calls: Calls = { gets: [], rpcs: [] };
  const steps: string[] = [];
  const symbols: string[][] = [];
  const outcome = await analyzeJob(job(), deps({ db: db({ calls }), steps, symbols }));
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  if (outcome.kind !== "completed") return;
  const { result } = outcome;
  assert.deepEqual(steps, ["draft", "fact"], "生成1回 + Fact 確認1回");
  assert.equal(result.fact_status, "passed");
  assert.equal(result.model_used, REPORT_MODEL);
  assert.equal(result.report_type, "close");
  assert.equal(result.trading_date, "2026-09-18");
  assert.equal(result.reference_report_packet_id, REPORT.id);
  assert.equal(result.reference_data_packet_id, DATA.id);
  assert.equal(result.source_basis.lane, "app_ondemand_v1");
  assert.equal(result.source_basis.basis_is_request_date, false);
  assert.equal(result.source_basis.price_pinned_to, "2026-09-18");
  assert.equal(result.source_basis.shared_market_report_content_hash, REPORT.content_hash);
  // 株価は 9/18 の終値（後の日の 1,100 円は使わない）。
  const snapshot = result.portfolio_snapshot as { trading_date: string; holdings: Array<{ ticker_code: string; price: { close: number; sessionDate: string; changePercent: number } }> };
  assert.equal(snapshot.trading_date, "2026-09-18");
  assert.deepEqual(snapshot.holdings.map((stock) => stock.ticker_code), ["1111"], "他人の銘柄は入らない");
  assert.equal(snapshot.holdings[0].price.close, 1050);
  assert.equal(snapshot.holdings[0].price.sessionDate, "2026-09-18");
  assert.equal(snapshot.holdings[0].price.changePercent, 5);
  assert.deepEqual(symbols, [["1111.T"]], "他人の銘柄の株価も取りに行かない");
  // 市場の節は共通パケットのまま（利用者ごとに書き換えない）。
  const body = result.body as { market_section: { report_packet_id: string; headline_ja: string }; market_detail: { headline_ja: string } };
  assert.equal(body.market_section.report_packet_id, REPORT.id);
  assert.equal(body.market_section.headline_ja, REPORT.payload.headline_ja);
  assert.equal(body.market_detail.headline_ja, REPORT.payload.headline_ja);
  // 読み込みは本人に固定。
  assert.ok(calls.gets.some((path) => path.startsWith("tracked_stocks?") && path.includes(`user_id=eq.${USER}`)));
  assert.deepEqual(calls.rpcs.map(([name, args]) => [name, args.p_user_id]), [["personalized_report_news_inputs", USER]]);
  assert.ok(result.api_cost_usd > 0);
  assert.equal(result.input_tokens, 2000);
});

test("今日の回が作成中なら AI を呼ばずに待つ。最後の試行では完成済みの前日の回で書く", async () => {
  const cycles = [
    { report_type: "close", trading_date: "2026-09-19", report_status: "running", current_report_packet_id: null },
    { report_type: "close", trading_date: "2026-09-18", report_status: "completed", current_report_packet_id: REPORT.id },
  ];
  const steps: string[] = [];
  const waiting = await analyzeJob(job(), deps({ db: db({ cycles }), steps }));
  assert.deepEqual(waiting, { kind: "failed", code: "MARKET_REPORT_NOT_READY", retryable: true, calls: 0 });
  assert.deepEqual(steps, []);
  const final = await analyzeJob(job({ attempt_count: 2 }), deps({ db: db({ cycles }), steps }));
  assert.equal(final.kind, "completed");
  assert.ok(final.kind === "completed" && final.result.trading_date === "2026-09-18");
});

test("共通の回が7日以内に1つも無ければ、最後は失敗（市場の節の無い分析には戻らない）", async () => {
  const steps: string[] = [];
  const outcome = await analyzeJob(job({ attempt_count: 2 }), deps({ db: db({ cycles: [] }), steps }));
  assert.deepEqual(outcome, { kind: "failed", code: "MARKET_REPORT_UNAVAILABLE", retryable: false, calls: 0 });
  assert.deepEqual(steps, []);
});

test("保有・ウォッチが無ければ AI を呼ばずに失敗（再試行しない）", async () => {
  const steps: string[] = [];
  const outcome = await analyzeJob(job(), deps({ db: db({ tracked: [] }), steps }));
  assert.deepEqual(outcome, { kind: "failed", code: "NO_TRACKED_STOCKS", retryable: false, calls: 0 });
  assert.deepEqual(steps, []);
});

test("上位のモデル・不正なジョブは AI を呼ばずに失敗", async () => {
  const steps: string[] = [];
  assert.deepEqual(await analyzeJob(job({ model_tier: "premium" }), deps({ steps })),
    { kind: "failed", code: "MODEL_TIER_UNAVAILABLE", retryable: false, calls: 0 });
  assert.deepEqual(await analyzeJob(job({ user_id: "x" }), deps({ steps })),
    { kind: "failed", code: "JOB_INVALID", retryable: false, calls: 0 });
  assert.deepEqual(steps, []);
});

test("Fact 確認で不合格なら完成にしない（再試行できる失敗）", async () => {
  const outcome = await analyzeJob(job(), deps({ factPassed: false }));
  assert.deepEqual(outcome, { kind: "failed", code: "REPORT_FACT_FAILED", retryable: true, calls: 2 });
});

test("パケットの中身が回と食い違えば使わない", async () => {
  const cycles = [{ report_type: "close", trading_date: "2026-09-17", report_status: "completed", current_report_packet_id: REPORT.id }];
  await assert.rejects(analyzeJob(job(), deps({ db: db({ cycles }) })), /MARKET_REPORT_PACKET_MISMATCH/);
});
