// Determines "the most recently completed NYSE/Nasdaq regular trading session date" as a fixed, code-side
// fact for the morning report — the same role getJpxTradingDay/resolveJpxTradingDay already plays for the
// JPX side. No LLM ever derives or votes on this value; Lane A/B are only ever told the answer.
export const US_MARKET_CALENDAR_SELECT_FAILED = "US_MARKET_CALENDAR_SELECT_FAILED";

// Standard NYSE/Nasdaq regular-session hours, in America/New_York wall-clock time. Early-close days (the
// Friday after Thanksgiving, and Dec 24/Jul 3 when they fall on a trading day) close at 13:00 ET instead
// of 16:00, but market_holidays has no early-close data to detect them. Using the standard 16:00 close is
// safe for the real production schedule (the report runs ~18-19 ET the *previous* day, always well past
// any close) and for the vast majority of manual runs; it is only wrong for a manual run made between
// 13:00-16:00 ET on one of those 1-2 days a year, where it would treat that day's (already-finished, early)
// session as still in progress and fall back to the prior trading day instead. This is a known, deliberately
// unhandled gap — see the investigation report; do not guess at early-close dates here.
const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const MARKET_CLOSE_MINUTES = 16 * 60;

// A generous bound on how many consecutive non-trading days (weekends stacked against holidays) the walk-
// back loop will cross before giving up. NYSE has never been closed anywhere near this long.
const MAX_BACKWARD_STEPS = 14;

function nyWallClock(referenceTimeIso: string): { date: string; weekday: number; minutes: number } {
  const value = new Date(referenceTimeIso);
  if (Number.isNaN(value.getTime())) throw new Error("INVALID_REFERENCE_TIME");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const weekdayShort = part("weekday");
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayShort);
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    weekday: weekdayIndex,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

function weekdayOfDate(dateOnly: string): number {
  // Noon UTC sidesteps any timezone/date-boundary ambiguity for a bare calendar date.
  return new Date(`${dateOnly}T12:00:00Z`).getUTCDay();
}

function previousCalendarDate(dateOnly: string): string {
  const value = new Date(`${dateOnly}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function isNyseTradingDay(dateOnly: string, weekday: number, holidayDates: ReadonlySet<string>): boolean {
  if (weekday === 0 || weekday === 6) return false;
  return !holidayDates.has(dateOnly);
}

export function resolveExpectedUsSessionDate(
  referenceTimeIso: string,
  holidayDates: ReadonlySet<string>,
): string {
  const { date, weekday, minutes } = nyWallClock(referenceTimeIso);

  // Today's own session only counts once it has closed. Before that — whether today isn't a trading day at
  // all, or it is but the close hasn't happened yet — the answer is the most recent prior trading day.
  const todaySessionComplete = isNyseTradingDay(date, weekday, holidayDates) && minutes >= MARKET_CLOSE_MINUTES;
  if (todaySessionComplete) return date;

  let cursor = previousCalendarDate(date);
  for (let step = 0; step < MAX_BACKWARD_STEPS; step += 1) {
    const cursorWeekday = weekdayOfDate(cursor);
    if (isNyseTradingDay(cursor, cursorWeekday, holidayDates)) return cursor;
    cursor = previousCalendarDate(cursor);
  }
  throw new Error("US_SESSION_DATE_RESOLUTION_FAILED");
}

// Only used by isMarketOpenNow-style diagnostics if ever needed; kept out of the main resolver's return
// value since the report only needs the completed-session date, not live market status.
export function isNyseMarketOpen(referenceTimeIso: string, holidayDates: ReadonlySet<string>): boolean {
  const { date, weekday, minutes } = nyWallClock(referenceTimeIso);
  return isNyseTradingDay(date, weekday, holidayDates) &&
    minutes >= MARKET_OPEN_MINUTES && minutes < MARKET_CLOSE_MINUTES;
}

export async function getExpectedUsSessionDate(
  supabaseUrl: string,
  serviceRoleKey: string,
  referenceTimeIso: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const { date: referenceDate } = nyWallClock(referenceTimeIso);
  const windowStart = (() => {
    let cursor = referenceDate;
    for (let i = 0; i < MAX_BACKWARD_STEPS; i += 1) cursor = previousCalendarDate(cursor);
    return cursor;
  })();
  const params = new URLSearchParams({ select: "holiday_date", market: "eq.NYSE" });
  params.append("holiday_date", `gte.${windowStart}`);
  params.append("holiday_date", `lte.${referenceDate}`);
  const response = await fetcher(`${supabaseUrl}/rest/v1/market_holidays?${params}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok) throw new Error(US_MARKET_CALENDAR_SELECT_FAILED);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error(US_MARKET_CALENDAR_SELECT_FAILED);
  const holidayDates = new Set(
    rows.map((row) => (typeof row === "object" && row !== null ? (row as { holiday_date?: unknown }).holiday_date : null))
      .filter((value): value is string => typeof value === "string"),
  );
  return resolveExpectedUsSessionDate(referenceTimeIso, holidayDates);
}
