const TOKYO_TIME_ZONE = "Asia/Tokyo";
const HOLD_START_MINUTES = 1 * 60;
const HOLD_END_MINUTES = 5 * 60;

export type ImportantNewsOvernightHoldDecision = {
  held: boolean;
  bypassed: boolean;
  overnightHoldUntil: string | null;
  reason: string | null;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const tokyoFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TOKYO_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function tokyoParts(date: Date): LocalDateTime {
  const parts = Object.fromEntries(tokyoFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function localTokyoTimeToUtc(value: LocalDateTime): Date {
  const targetSerial = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
  let utc = targetSerial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = tokyoParts(new Date(utc));
    const actualSerial = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const correction = targetSerial - actualSerial;
    utc += correction;
    if (correction === 0) break;
  }
  return new Date(utc);
}

export function evaluateImportantNewsOvernightHold(
  importance: string,
  now: Date,
): ImportantNewsOvernightHoldDecision {
  const local = tokyoParts(now);
  const minutes = local.hour * 60 + local.minute;
  const insideWindow = minutes >= HOLD_START_MINUTES && minutes < HOLD_END_MINUTES;
  if (!insideWindow) {
    return { held: false, bypassed: false, overnightHoldUntil: null, reason: null };
  }
  if (importance === "most_important") {
    return { held: false, bypassed: true, overnightHoldUntil: null, reason: null };
  }
  if (importance !== "important") {
    return { held: false, bypassed: false, overnightHoldUntil: null, reason: null };
  }

  const until = localTokyoTimeToUtc({ ...local, hour: 5, minute: 0 }).toISOString();
  return {
    held: true,
    bypassed: false,
    overnightHoldUntil: until,
    reason: "NEWS_PUBLISH_OVERNIGHT_HOLD",
  };
}
