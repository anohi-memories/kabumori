export type JpxTradingDayState = {
  date: string;
  isTradingDay: boolean;
  reason: "weekday" | "weekend" | "holiday";
};

const CLOSED_DAY_MARKET_PATTERNS = [
  /(?:今日|本日|きょう)(?:の)?(?:日本株|相場|市場|日経(?:平均)?|株価|値動き|取引|引け|大引け)/,
  /(?:今日|本日|きょう)[^。！？\n]{0,16}(?:強かった|弱かった|上がった|下がった|動いた)/,
  /(?:今日|本日|きょう)[^。！？\n]{0,16}(?:強気|弱気|様子見)/,
];

function jstParts(referenceTimeIso: string): { date: string; weekday: string } {
  const value = new Date(referenceTimeIso);
  if (Number.isNaN(value.getTime())) throw new Error("INVALID_REFERENCE_TIME");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    weekday: part("weekday"),
  };
}

export function resolveJpxTradingDay(
  referenceTimeIso: string,
  holidayDates: ReadonlySet<string>,
): JpxTradingDayState {
  const { date, weekday } = jstParts(referenceTimeIso);
  if (weekday === "Sat" || weekday === "Sun") {
    return { date, isTradingDay: false, reason: "weekend" };
  }
  if (holidayDates.has(date)) {
    return { date, isTradingDay: false, reason: "holiday" };
  }
  return { date, isTradingDay: true, reason: "weekday" };
}

export function hasClosedDayMarketAssumption(text: string): boolean {
  return CLOSED_DAY_MARKET_PATTERNS.some((pattern) => pattern.test(text));
}

export function isInteractionTopicAllowed(
  title: string,
  promptHint: string,
  isTradingDay: boolean,
): boolean {
  return isTradingDay || !hasClosedDayMarketAssumption(`${title}\n${promptHint}`);
}

function mainQuestionCount(text: string): number {
  const segments = text.split(/[？?]/u).map((value) => value.trim()).filter(Boolean);
  return segments.filter((segment) => {
    const lastSentence = segment.split(/[。！!\n]/u).filter(Boolean).at(-1)?.trim() ?? "";
    if (Array.from(lastSentence).length < 8) return false;
    return /(?:ですか|ますか|ましたか|でしょうか|ありますか|どれ|どっち|どちら|どう|何|なに|どこ|いつ|なぜ|どのくらい|何を|何が)/u
      .test(lastSentence);
  }).length;
}

export function validateInteractionDraft(
  text: string,
  tradingDay: JpxTradingDayState,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!tradingDay.isTradingDay && hasClosedDayMarketAssumption(text)) {
    reasons.push("CLOSED_DAY_MARKET_ASSUMPTION");
  }
  if (mainQuestionCount(text) > 1) {
    reasons.push("MULTIPLE_MAIN_QUESTIONS");
  }
  return { passed: reasons.length === 0, reasons };
}
