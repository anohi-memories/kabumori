// 基準の回の決め方・東京時間の日付・株価の基準日の確認。
import assert from "node:assert/strict";
import test from "node:test";
import { jstParts, priceFactFor, REPORT_MODEL, type PriceSeries } from "../personalized-reports/report_logic.ts";
import {
  addDays,
  isRetryable,
  modelForTier,
  pinSeriesToSession,
  resolveMarketBasis,
  safeCode,
  type CycleRow,
} from "./market_basis.ts";

function cycle(report_type: "morning" | "close", trading_date: string, report_status = "completed"): CycleRow {
  return {
    report_type,
    trading_date,
    report_status,
    current_report_packet_id: report_status === "completed" ? `${report_type}-${trading_date}`.padEnd(36, "0") : null,
  };
}

test("latest: 同じ日なら大引けを朝刊より新しいとみなす", () => {
  const basis = resolveMarketBasis({
    scope: "latest", requestDate: "2026-10-09",
    cycles: [cycle("morning", "2026-10-09"), cycle("close", "2026-10-09"), cycle("close", "2026-10-08")],
    finalAttempt: false,
  });
  assert.equal(basis.action, "use");
  assert.ok(basis.action === "use" && basis.reportType === "close" && basis.tradingDate === "2026-10-09" && basis.isRequestDate);
});

test("latest: 午前は今日の朝刊、まだ作成中なら待ち、最後の試行では前日の大引け", () => {
  const morningDone = resolveMarketBasis({
    scope: "latest", requestDate: "2026-10-09",
    cycles: [cycle("morning", "2026-10-09"), cycle("close", "2026-10-09", "pending"), cycle("close", "2026-10-08")],
    finalAttempt: false,
  });
  // 今日の大引けが pending でも、朝刊より新しい回の「作成中」なので待つ。
  assert.deepEqual(morningDone, { action: "retry", code: "MARKET_REPORT_NOT_READY" });
  const final = resolveMarketBasis({
    scope: "latest", requestDate: "2026-10-09",
    cycles: [cycle("morning", "2026-10-09"), cycle("close", "2026-10-09", "pending"), cycle("close", "2026-10-08")],
    finalAttempt: true,
  });
  assert.ok(final.action === "use" && final.reportType === "morning" && final.tradingDate === "2026-10-09");
  const early = resolveMarketBasis({
    scope: "latest", requestDate: "2026-10-09",
    cycles: [cycle("morning", "2026-10-09", "running"), cycle("close", "2026-10-08")],
    finalAttempt: true,
  });
  assert.ok(early.action === "use" && early.reportType === "close" && early.tradingDate === "2026-10-08" && !early.isRequestDate);
});

test("morning / close: その種類だけを見る。失敗した回は待たずに前の回へ", () => {
  const close = resolveMarketBasis({
    scope: "close", requestDate: "2026-10-09",
    cycles: [cycle("morning", "2026-10-09"), cycle("close", "2026-10-09", "failed"), cycle("close", "2026-10-08")],
    finalAttempt: false,
  });
  assert.ok(close.action === "use" && close.reportType === "close" && close.tradingDate === "2026-10-08");
  const morning = resolveMarketBasis({
    scope: "morning", requestDate: "2026-10-12", // 日曜: 直近の完成した朝刊（金曜）
    cycles: [cycle("morning", "2026-10-10"), cycle("close", "2026-10-10")],
    finalAttempt: false,
  });
  assert.ok(morning.action === "use" && morning.reportType === "morning" && morning.tradingDate === "2026-10-10");
});

test("7日より古い回・依頼日より後の回は使わない。候補が無ければ待ち、最後は失敗", () => {
  const cycles = [cycle("close", "2026-10-01"), cycle("close", "2026-10-10")];
  assert.deepEqual(resolveMarketBasis({ scope: "close", requestDate: "2026-10-09", cycles, finalAttempt: false }),
    { action: "retry", code: "MARKET_REPORT_NOT_READY" });
  assert.deepEqual(resolveMarketBasis({ scope: "close", requestDate: "2026-10-09", cycles, finalAttempt: true }),
    { action: "fail", code: "MARKET_REPORT_UNAVAILABLE" });
  assert.ok(resolveMarketBasis({ scope: "close", requestDate: "2026-10-08", cycles, finalAttempt: false }).action === "use");
  assert.equal(addDays("2026-10-01", 7), "2026-10-08");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

const SERIES: PriceSeries = {
  bars: [
    { date: "2026-10-07", close: 1000 },
    { date: "2026-10-08", close: 1020 },
    { date: "2026-10-09", close: 1050 },
  ],
  // Yahoo の市場の時刻は最新の足（10/09 の取引時間中、11:00 JST）。
  marketTimeIso: "2026-10-09T02:00:00Z",
};

test("過去の日の大引け: その日の足を確定値として使い、後の日の足は使わない", () => {
  const raw = priceFactFor(SERIES, "close", "2026-10-08");
  assert.equal(raw.status, "unavailable", "そのままでは市場の時刻が別の日なので使えない");
  const pinned = pinSeriesToSession(SERIES, "close", "2026-10-08", "2026-10-09");
  assert.deepEqual(pinned?.bars.map((bar) => bar.date), ["2026-10-07", "2026-10-08"]);
  assert.equal(pinned?.marketTimeIso, "2026-10-08T06:30:00.000Z");
  const fact = priceFactFor(pinned, "close", "2026-10-08");
  assert.equal(fact.status, "ok");
  assert.equal(fact.close, 1020);
  assert.equal(fact.changePercent, 2);
});

test("今日の大引けは Yahoo の市場の時刻のまま（取引時間中の値を終値にしない）", () => {
  const pinned = pinSeriesToSession(SERIES, "close", "2026-10-09", "2026-10-09");
  assert.equal(pinned?.marketTimeIso, SERIES.marketTimeIso);
  assert.equal(priceFactFor(pinned, "close", "2026-10-09").status, "unavailable");
});

test("朝刊: 基準日より前の足だけ（前営業日の終値）", () => {
  const pinned = pinSeriesToSession(SERIES, "morning", "2026-10-09", "2026-10-09");
  const fact = priceFactFor(pinned, "morning", "2026-10-09");
  assert.equal(fact.sessionDate, "2026-10-08");
  assert.equal(fact.close, 1020);
  assert.equal(pinSeriesToSession(null, "morning", "2026-10-09", "2026-10-09"), null);
});

test("東京時間の日付: 日本時間の深夜0時を越えたら、前日の大引けは過去の日として確定値になる", () => {
  // 2026-10-09 15:10 UTC = 2026-10-10 00:10 JST
  const today = jstParts(new Date("2026-10-09T15:10:00Z")).date;
  assert.equal(today, "2026-10-10");
  const pinned = pinSeriesToSession(SERIES, "close", "2026-10-09", today);
  assert.equal(pinned?.marketTimeIso, "2026-10-09T06:30:00.000Z");
  assert.equal(priceFactFor(pinned, "close", "2026-10-09").close, 1050);
  // 同じ瞬間でも UTC の日付（10/09）を使うと「今日の大引け」扱いになり、値が出ない（UTC を使ってはいけない理由）。
  assert.equal(priceFactFor(pinSeriesToSession(SERIES, "close", "2026-10-09", "2026-10-09"), "close", "2026-10-09").status, "unavailable");
});

test("モデル: 通常分析だけ（今の低費用のモデル）。上位の分析は受け付けない", () => {
  assert.equal(modelForTier("standard"), REPORT_MODEL);
  assert.throws(() => modelForTier("premium"), /MODEL_TIER_UNAVAILABLE/);
  assert.throws(() => modelForTier("opus"), /MODEL_TIER_UNAVAILABLE/);
});

test("失敗の分類と、記録する失敗のコード", () => {
  assert.equal(isRetryable("REPORT_FACT_FAILED"), true);
  assert.equal(isRetryable("REPORT_OPENAI_FAILED:429"), true);
  assert.equal(isRetryable("MARKET_REPORT_NOT_READY"), true);
  assert.equal(isRetryable("NO_TRACKED_STOCKS"), false);
  assert.equal(isRetryable("MARKET_REPORT_UNAVAILABLE"), false);
  assert.equal(safeCode(new Error("REST_GET_FAILED:tracked_stocks:503")), "REST_GET_FAILED:tracked_stocks:503");
  assert.equal(safeCode(new Error("secret key sk-abc leaked in message")), "ANALYSIS_UNEXPECTED_ERROR");
  assert.equal(safeCode("x"), "ANALYSIS_UNEXPECTED_ERROR");
});
