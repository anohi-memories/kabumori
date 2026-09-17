// Calendar and session arithmetic for market_data_packet.v1. Pure: no I/O.
//
// Dates are YYYY-MM-DD strings in the named exchange timezone. Conversions use
// Intl with the IANA zone, so US daylight-saving changes are handled without a
// hard-coded offset.

export type ReportType = "morning" | "close";

export type SessionSpec = {
  timezone: string;
  closeMinutes: number;
};

export const JPX_SESSION: SessionSpec = { timezone: "Asia/Tokyo", closeMinutes: 15 * 60 + 30 };
export const NYSE_SESSION: SessionSpec = { timezone: "America/New_York", closeMinutes: 16 * 60 };

/** Morning packets describe the state before the Tokyo open. */
export const MORNING_LATEST_JST_MINUTES = 9 * 60;

export type LocalParts = { date: string; minutes: number; weekday: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(instant: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? -1,
  };
}

function offsetMinutes(instantMs: number, timezone: string): number {
  const parts = localParts(new Date(instantMs), timezone);
  const [year, month, day] = parts.date.split("-").map(Number);
  const asUtc = Date.UTC(year, month - 1, day, Math.floor(parts.minutes / 60), parts.minutes % 60);
  const truncated = Math.floor(instantMs / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** The UTC instant of a wall-clock time (date + minutes) in `timezone`. */
export function zonedInstant(date: string, minutes: number, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let result = guess - offsetMinutes(guess, timezone) * 60_000;
  result = guess - offsetMinutes(result, timezone) * 60_000;
  return new Date(result);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isSessionDay(date: string, holidays: ReadonlySet<string>): boolean {
  const weekday = weekdayOf(date);
  return weekday !== 0 && weekday !== 6 && !holidays.has(date);
}

export function previousSessionDay(date: string, holidays: ReadonlySet<string>): string {
  let cursor = addDays(date, -1);
  for (let guard = 0; guard < 20 && !isSessionDay(cursor, holidays); guard += 1) cursor = addDays(cursor, -1);
  return cursor;
}

/** The session whose close must be in the packet for this report. */
export function expectedJpxSessionDate(
  reportType: ReportType,
  tradingDate: string,
  jpxHolidays: ReadonlySet<string>,
): string {
  return reportType === "close" ? tradingDate : previousSessionDay(tradingDate, jpxHolidays);
}

/** The latest NYSE session that had already closed at `asOf`. */
export function expectedUsSessionDate(asOf: Date, nyseHolidays: ReadonlySet<string>): string {
  const local = localParts(asOf, NYSE_SESSION.timezone);
  if (isSessionDay(local.date, nyseHolidays) && local.minutes >= NYSE_SESSION.closeMinutes) return local.date;
  return previousSessionDay(local.date, nyseHolidays);
}

/** Start of the news window: the close of the JPX session before `tradingDate`. */
export function newsWindowStart(tradingDate: string, jpxHolidays: ReadonlySet<string>): Date {
  return zonedInstant(previousSessionDay(tradingDate, jpxHolidays), JPX_SESSION.closeMinutes, JPX_SESSION.timezone);
}

export type RunWindowDecision =
  | { run: true; tradingDate: string }
  | { run: false; tradingDate: string; reason: "NOT_TRADING_DAY" | "CLOSE_TOO_EARLY" | "MORNING_TOO_LATE" };

export function decideRunWindow(
  reportType: ReportType,
  now: Date,
  jpxHolidays: ReadonlySet<string>,
): RunWindowDecision {
  const jst = localParts(now, JPX_SESSION.timezone);
  const tradingDate = jst.date;
  if (!isSessionDay(tradingDate, jpxHolidays)) return { run: false, tradingDate, reason: "NOT_TRADING_DAY" };
  if (reportType === "close" && jst.minutes < JPX_SESSION.closeMinutes) {
    return { run: false, tradingDate, reason: "CLOSE_TOO_EARLY" };
  }
  if (reportType === "morning" && jst.minutes >= MORNING_LATEST_JST_MINUTES) {
    return { run: false, tradingDate, reason: "MORNING_TOO_LATE" };
  }
  return { run: true, tradingDate };
}
