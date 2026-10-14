// ゆめちゃん（かぶモリの AI 評論家）の見立て (2026-10-13, F2). Pure: no I/O.
//
// The morning report carries ゆめちゃん's own call on today's Nikkei 225 (up / down / flat against the previous close),
// with her reasons, the counter-arguments and what would prove her wrong. The close report looks back at that call and
// gives her view of the next session. Her call is an opinion, never a fact: it lives in its own packet field
// (`yume`), separate from the fact sections, and the code never lets it rewrite a fact.
//
// The verdict of the look-back is decided here in code, never by the model, and only against a definition fixed
// before the session: the morning packet is immutable once stored (market_report_packets has no-update / no-delete
// triggers, and a completed cycle never changes its current packet), and it records the target, the horizon date and
// the flat band. When anything is missing or does not match, the verdict is 「判定できません」 with a fixed reason; the
// morning call is never reconstructed.

import type { MarketReportPacket } from "./market_report_packet.ts";

export const YUME_VERSION = "yume.v1";
export const YUME_NAME_JA = "ゆめちゃん";
/** The one metric her daily call is about. */
export const YUME_TARGET = "nikkei225";
/** |前日比| below this many percent is 「横ばい」, for the call and for its evaluation (stored in each record). */
export const YUME_FLAT_BAND_PCT = 0.3;

export type YumeStance = "up" | "down" | "flat";
export type YumeVerdict = "hit" | "partial" | "miss" | "undeterminable";

export const YUME_STANCES: readonly YumeStance[] = ["up", "down", "flat"];
export const YUME_STANCE_JA: Record<YumeStance, string> = { up: "上昇", down: "下落", flat: "横ばい" };
export const YUME_VERDICT_JA: Record<YumeVerdict, string> = {
  hit: "当たり",
  partial: "部分的に当たり",
  miss: "外れ",
  undeterminable: "判定できません",
};

/** Why a look-back is 「判定できません」, in words for the reader (the code stays in the record). */
export const YUME_UNDETERMINABLE_JA: Record<string, string> = {
  NO_MORNING_REPORT: "この日の朝刊が見つかりません",
  MORNING_READ_FAILED: "朝刊の記録を読み込めませんでした",
  MORNING_TARGET_MISMATCH: "朝刊の日付・種類がこの大引けと合いません",
  NO_MORNING_FORECAST: "この日の朝刊に予想の記録がありません",
  FORECAST_DEFINITION_INVALID: "朝刊の予想の条件が記録と合いません",
  ACTUAL_UNAVAILABLE: "日経平均の終値を確認できません",
  ACTUAL_NOT_THIS_SESSION: "この日の日経平均の終値を確認できません",
  ACTUAL_CHANGE_UNAVAILABLE: "日経平均の前日比を確認できません",
};

export type YumeReview = {
  verdict: YumeVerdict;
  /** How the verdict was reached ("COMPARED"), or why it could not be (a key of YUME_UNDETERMINABLE_JA). */
  reason_code: string;
  morning_report_packet_id: string | null;
  morning_stance: YumeStance | null;
  morning_headline_ja: string | null;
  flat_band_pct: number | null;
  /** The close's own Nikkei 225 day change in percent, as displayed in the input (null when not comparable). */
  actual_change_pct: number | null;
  actual_change_display: string | null;
  actual_session_date: string | null;
  /** ゆめちゃん's own words about the verdict (opinion). The verdict itself is the code's. */
  text_ja: string;
};

export type YumeView = {
  version: typeof YUME_VERSION;
  target: typeof YUME_TARGET;
  /** morning: this trading date's close vs the previous close. close: the next session (not evaluated). */
  horizon: "this_session" | "next_session";
  /** The trading date the call is about (morning); null for the close's next-session view. */
  horizon_date: string | null;
  flat_band_pct: number;
  stance: YumeStance;
  headline_ja: string;
  reasons_ja: string;
  /** The scenario she expects (2026-10-14); absent on older packets. */
  scenario_ja?: string;
  counter_ja: string;
  invalidation_ja: string;
  /** Close only: the look-back at the same day's morning call. */
  review?: YumeReview;
};

/** The close's Nikkei 225 fact, as the analysis input carries it. */
export type YumeActual = { sessionDate: string; changeDisplay: string | null; freshness: "fresh" | "stale" };

/** What the close handler read for the same trading date's morning report (null: none; "error": the read failed). */
export type YumeMorningSource = { packetId: string; packet: unknown } | null | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored morning call that can be evaluated: the definition must be the one this code evaluates against. */
export function morningForecastOf(packet: unknown, tradingDate: string):
  { ok: true; view: YumeView } | { ok: false; code: "MORNING_TARGET_MISMATCH" | "NO_MORNING_FORECAST" | "FORECAST_DEFINITION_INVALID" } {
  if (!isRecord(packet) || packet.report_type !== "morning" || packet.trading_date !== tradingDate) {
    return { ok: false, code: "MORNING_TARGET_MISMATCH" };
  }
  const yume = packet.yume;
  if (yume === undefined || yume === null) return { ok: false, code: "NO_MORNING_FORECAST" };
  if (!isRecord(yume)) return { ok: false, code: "FORECAST_DEFINITION_INVALID" };
  const band = yume.flat_band_pct;
  if (
    yume.version !== YUME_VERSION || yume.target !== YUME_TARGET || yume.horizon !== "this_session" ||
    yume.horizon_date !== tradingDate || !YUME_STANCES.includes(yume.stance as YumeStance) ||
    typeof band !== "number" || !Number.isFinite(band) || band <= 0 || band >= 5 || typeof yume.headline_ja !== "string"
  ) {
    return { ok: false, code: "FORECAST_DEFINITION_INVALID" };
  }
  return { ok: true, view: yume as unknown as YumeView };
}

/** "+1.23%" / "−0.45%" / "±0.00%" (changePctDisplay) -> number; null for anything else. */
export function parseChangeDisplay(display: string | null): number | null {
  const match = display?.match(/^([+−±])(\d+\.\d{2})%$/u);
  if (!match) return null;
  const value = Number(match[2]);
  return match[1] === "−" ? -value : value;
}

/** up / down / flat of a day change against a band (a change inside the band, either way, is flat). */
export function stanceOfChange(changePct: number, bandPct: number): YumeStance {
  return Math.abs(changePct) < bandPct ? "flat" : changePct > 0 ? "up" : "down";
}

/**
 * The verdict of a morning call against the close, fixed in advance:
 *   the same stance                                  -> hit
 *   up/down called, the day ended inside the band    -> partial (no big move either way)
 *   flat called, the day moved but less than 2 bands -> partial
 *   anything else (opposite, or flat vs a big move)  -> miss
 */
export function verdictOf(called: YumeStance, changePct: number, bandPct: number): YumeVerdict {
  const actual = stanceOfChange(changePct, bandPct);
  if (actual === called) return "hit";
  if (actual === "flat") return "partial";
  if (called === "flat") return Math.abs(changePct) < 2 * bandPct ? "partial" : "miss";
  return "miss";
}

/** The close's look-back, without ゆめちゃん's words (text_ja is filled from the model's review, or left empty). */
export function evaluateMorningForecast(args: {
  tradingDate: string;
  morning: YumeMorningSource;
  actual: YumeActual | null;
}): YumeReview {
  const base: YumeReview = {
    verdict: "undeterminable",
    reason_code: "NO_MORNING_REPORT",
    morning_report_packet_id: null,
    morning_stance: null,
    morning_headline_ja: null,
    flat_band_pct: null,
    actual_change_pct: null,
    actual_change_display: null,
    actual_session_date: null,
    text_ja: "",
  };
  if (args.morning === "error") return { ...base, reason_code: "MORNING_READ_FAILED" };
  if (args.morning === null) return base;
  const forecast = morningForecastOf(args.morning.packet, args.tradingDate);
  const withMorning = { ...base, morning_report_packet_id: args.morning.packetId };
  if (!forecast.ok) return { ...withMorning, reason_code: forecast.code };
  const view = forecast.view;
  const called = {
    ...withMorning,
    morning_stance: view.stance,
    morning_headline_ja: view.headline_ja,
    flat_band_pct: view.flat_band_pct,
  };
  const actual = args.actual;
  if (!actual) return { ...called, reason_code: "ACTUAL_UNAVAILABLE" };
  if (actual.freshness !== "fresh" || actual.sessionDate !== args.tradingDate) {
    return { ...called, reason_code: "ACTUAL_NOT_THIS_SESSION", actual_session_date: actual.sessionDate };
  }
  const change = parseChangeDisplay(actual.changeDisplay);
  if (change === null) return { ...called, reason_code: "ACTUAL_CHANGE_UNAVAILABLE", actual_session_date: actual.sessionDate };
  return {
    ...called,
    verdict: verdictOf(view.stance, change, view.flat_band_pct),
    reason_code: "COMPARED",
    actual_change_pct: change,
    actual_change_display: actual.changeDisplay,
    actual_session_date: actual.sessionDate,
  };
}

/** The band in words, for prompts and the app (「前日比±0.3%未満は横ばい」). */
export function bandRuleJa(bandPct: number): string {
  return `日経平均の前日比が±${bandPct}%未満なら横ばい、それ以上なら上昇・下落`;
}

/** The look-back in one line, from code only (the verdict, the stance, the actual change). */
export function reviewLineJa(review: YumeReview): string {
  if (review.verdict === "undeterminable") {
    const why = YUME_UNDETERMINABLE_JA[review.reason_code] ?? "比べられる記録がありません";
    return `朝の予想との答え合わせはできません（${why}）`;
  }
  return `朝の予想は「${YUME_STANCE_JA[review.morning_stance!]}」→ 結果は「${YUME_VERDICT_JA[review.verdict]}」（日経平均 前日比${review.actual_change_display}）`;
}

/**
 * ゆめちゃん's lines for the X digest, from code and her checked headline. They become the closing paragraph
 * (「💬 今日のひとこと」), which every deployed X formatter already renders, so no consumer change is needed. A look-back
 * that cannot be judged is left to the app (the X digest keeps its length).
 */
export function yumeXLines(view: YumeView): string[] {
  const stance = YUME_STANCE_JA[view.stance];
  if (view.horizon === "this_session") {
    return [`🔮${YUME_NAME_JA}の予想：きょうの日経平均は「${stance}」とみています。${view.headline_ja}`];
  }
  const review = view.review && view.review.verdict !== "undeterminable" ? [`🔮${reviewLineJa(view.review)}`] : [];
  return [...review, `${review.length > 0 ? "" : "🔮"}${YUME_NAME_JA}の次の見立ては「${stance}」。${view.headline_ja}`];
}

/** The app story section for ゆめちゃん (heading, prose, lines), or null when the packet has no view. */
export function yumeStorySection(packet: Pick<MarketReportPacket, "report_type"> & { yume?: YumeView }):
  { key: string; heading_ja: string; body_ja: string; lines_ja: string[] } | null {
  const view = packet.yume;
  if (!view) return null;
  const stance = YUME_STANCE_JA[view.stance];
  const lines = [
    view.horizon === "this_session" ? `予想：きょうの日経平均は「${stance}」` : `次の営業日の見立て：日経平均は「${stance}」`,
    `基準：${bandRuleJa(view.flat_band_pct)}`,
    ...(view.counter_ja ? [`反対の材料：${view.counter_ja}`] : []),
    ...(view.invalidation_ja ? [`外れるとしたら：${view.invalidation_ja}`] : []),
  ];
  return {
    key: "yume",
    heading_ja: view.horizon === "this_session" ? `🔮 ${YUME_NAME_JA}の予想` : `🔮 ${YUME_NAME_JA}の次の見立て`,
    body_ja: [view.headline_ja, view.reasons_ja, view.scenario_ja ?? ""].filter(Boolean).join("\n"),
    lines_ja: lines,
  };
}
