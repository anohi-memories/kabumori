// Where a judged candidate could reach a user, per channel, and how the "generation failed" rate changes with its definition.
//
// Channels are kept apart because they are not the same thing:
//   x           the post on X (status published / x_post_id)
//   app_listed  the candidate is a row the in-app news feed function can return for SOME user. Whether one user sees it also
//               depends on that user's tracked stocks and sectors, which this module does not (and must not) read.
//   app_text    Japanese text that passed Fact exists, so the app can show a verified summary instead of the raw title
//   pushable    the notification enqueue function would build a notification (severity and Japanese text present)
//   notified    notification rows were actually created (counted per candidate, no user data)
// An item can be on X and not in the app, in the app and not on X, or on neither.

export type ChannelRow = {
  id8: string;
  source_name: string;
  source_type: string;
  importance: string;
  status: string;
  title: string;
  news_jst: string;
  is_duplicate: boolean;
  created_day: string;
  company_code: string;
  category: string;
  severity: string;
  x_posted: boolean;
  x_text_passed: boolean;
  app_copy_passed: boolean;
  app_copy_status: string;
  japanese_title: boolean;
  feed_status: boolean;
  notifications: number;
  notifications_sent: number;
};

const FEED_SEVERITIES = new Set(["emergency", "critical", "high", "medium"]);

export type Reach = {
  x: boolean;
  appListed: boolean;
  appText: boolean;
  pushable: boolean;
  notified: boolean;
  sent: boolean;
  /** severity could not be read from the stored column (the SQL function would derive it); reported, not guessed. */
  severityUnknown: boolean;
};

export function reachOf(row: ChannelRow): Reach {
  const severityKnown = row.severity !== "unknown";
  const sevOk = FEED_SEVERITIES.has(row.severity);
  const tdnetLike = row.source_type === "tdnet" || row.source_type === "company_ir";
  const appListed = !row.is_duplicate && row.feed_status && sevOk && (row.status !== "rejected" || tdnetLike);
  const appText = row.app_copy_passed || row.x_text_passed;
  const pushable = !row.is_duplicate && row.feed_status && sevOk && appText &&
    (row.status !== "rejected" || row.company_code === "" || tdnetLike);
  return {
    x: row.x_posted || row.status === "published",
    appListed,
    appText,
    pushable,
    notified: row.notifications > 0,
    sent: row.notifications_sent > 0,
    severityUnknown: !severityKnown,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Events. A candidate is a document; an event is what readers care about (a raid reported by three companies and a wire).

const STOP = new Set(["the", "a", "an", "of", "in", "to", "and", "for", "on", "as", "at", "by", "with", "after", "over", "says", "say"]);

function tokens(title: string): Set<string> {
  const words = title.normalize("NFKC").toLowerCase().split(/[^a-z0-9぀-ヿ一-鿿]+/).filter((w) => w.length > 1 && !STOP.has(w));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Approximate event grouping. Company disclosures group by issuer, category and day (a company issues one disclosure of a kind
 * per day). Market items group by title token overlap within 36 hours. It is an approximation of the SQL same-event function,
 * which the harness does not call; events are counted to size the difference between candidate-level and event-level reach.
 */
export function groupEvents(rows: readonly ChannelRow[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const r of rows) parent.set(r.id8, r.id8);
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const byCompany = new Map<string, string>();
  const market = rows.filter((r) => r.company_code === "");
  for (const r of rows) {
    if (r.company_code === "") continue;
    const key = `${r.company_code}|${r.category}|${r.created_day}`;
    const first = byCompany.get(key);
    if (first === undefined) byCompany.set(key, r.id8);
    else union(first, r.id8);
  }
  const tok = new Map(market.map((r) => [r.id8, tokens(r.title)]));
  const time = (r: ChannelRow) => Date.parse(r.news_jst.replace(" ", "T") + "+09:00");
  const sorted = [...market].sort((a, b) => time(a) - time(b));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (time(sorted[j]) - time(sorted[i]) > 36 * 3600_000) break;
      if (jaccard(tok.get(sorted[i].id8)!, tok.get(sorted[j].id8)!) >= 0.5) union(sorted[i].id8, sorted[j].id8);
    }
  }
  return new Map(rows.map((r) => [r.id8, find(r.id8)]));
}

export type ChannelCounts = {
  candidates: number;
  events: number;
  x: { candidates: number; events: number };
  appListed: { candidates: number; events: number };
  appText: { candidates: number; events: number };
  pushable: { candidates: number; events: number };
  notified: { candidates: number; events: number };
  /** Reached on no channel at all (candidate-level and event-level). */
  none: { candidates: number; events: number };
  /** On X but not listed in the app, and listed in the app but not on X. */
  xOnly: number;
  appOnly: number;
  severityUnknown: number;
};

export function summariseChannels(rows: readonly ChannelRow[]): ChannelCounts {
  const event = groupEvents(rows);
  const reach = new Map(rows.map((r) => [r.id8, reachOf(r)]));
  const events = new Set(event.values());
  const eventHas = (pick: (r: Reach) => boolean) => {
    const hit = new Set<string>();
    for (const r of rows) if (pick(reach.get(r.id8)!)) hit.add(event.get(r.id8)!);
    return hit.size;
  };
  const candidateHas = (pick: (r: Reach) => boolean) => rows.filter((r) => pick(reach.get(r.id8)!)).length;
  const any = (r: Reach) => r.x || r.appListed || r.pushable || r.notified;
  return {
    candidates: rows.length,
    events: events.size,
    x: { candidates: candidateHas((r) => r.x), events: eventHas((r) => r.x) },
    appListed: { candidates: candidateHas((r) => r.appListed), events: eventHas((r) => r.appListed) },
    appText: { candidates: candidateHas((r) => r.appText), events: eventHas((r) => r.appText) },
    pushable: { candidates: candidateHas((r) => r.pushable), events: eventHas((r) => r.pushable) },
    notified: { candidates: candidateHas((r) => r.notified), events: eventHas((r) => r.notified) },
    none: {
      candidates: rows.length - candidateHas(any),
      events: events.size - eventHas(any),
    },
    xOnly: rows.filter((r) => reach.get(r.id8)!.x && !reach.get(r.id8)!.appListed).length,
    appOnly: rows.filter((r) => !reach.get(r.id8)!.x && reach.get(r.id8)!.appListed).length,
    severityUnknown: rows.filter((r) => reach.get(r.id8)!.severityUnknown).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rates. One numerator, many denominators; every figure is printed with the rule that produced it.

export type RateDefinition = {
  name: string;
  window: string;
  rule: string;
  numerator: number;
  denominator: number;
  rate: number | null;
};

export type RateOptions = {
  windowFrom: string; // yyyy-mm-dd, inclusive (created day, JST)
  windowTo: string;   // yyyy-mm-dd, inclusive
  excludeId8?: ReadonlySet<string>;
};

const positive = (r: ChannelRow) => r.importance !== "no_post";

function rate(name: string, window: string, rule: string, rows: readonly ChannelRow[], num: (r: ChannelRow) => boolean, den: (r: ChannelRow) => boolean): RateDefinition {
  const denominator = rows.filter(den).length;
  const numerator = rows.filter((r) => den(r) && num(r)).length;
  return { name, window, rule, numerator, denominator, rate: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000 };
}

export function failureRateDefinitions(all: readonly ChannelRow[], options: RateOptions): RateDefinition[] {
  const inWindow = (r: ChannelRow) => r.created_day >= options.windowFrom && r.created_day <= options.windowTo;
  const failed = (r: ChannelRow) => r.status === "generation_failed";
  const label = `${options.windowFrom}..${options.windowTo}`;
  const base = all.filter(inWindow);
  const lastDay = options.windowTo;
  const sevenFrom = shiftDay(lastDay, -6);
  const threeFrom = shiftDay(lastDay, -2);
  const seven = base.filter((r) => r.created_day >= sevenFrom);
  const three = base.filter((r) => r.created_day >= threeFrom);
  const out: RateDefinition[] = [];
  out.push(rate("A all important+ in window", label, "importance <> no_post; every status; duplicates kept", base, failed, positive));
  out.push(rate("B published + failed only", label, "importance <> no_post; status in (published, generation_failed)", base, failed, (r) => positive(r) && (r.status === "published" || failed(r))));
  out.push(rate("C duplicates removed", label, "importance <> no_post; duplicate_of is null", base, failed, (r) => positive(r) && !r.is_duplicate));
  if (options.excludeId8) {
    const ex = options.excludeId8;
    out.push(rate("D evaluation cases removed (Phase 4)", label, "importance <> no_post; the 212 evaluation cases removed", base, failed, (r) => positive(r) && !ex.has(r.id8)));
  }
  out.push(rate("E all judged, no_post included", label, "denominator is every AI-judged candidate", base, failed, () => true));
  out.push(rate("F last 7 days, important+", `${sevenFrom}..${lastDay}`, "as A, last 7 created days", seven, failed, positive));
  out.push(rate("G last 7 days, TDnet", `${sevenFrom}..${lastDay}`, "as F, source_type = tdnet", seven, failed, (r) => positive(r) && r.source_type === "tdnet"));
  out.push(rate("H last 7 days, not TDnet", `${sevenFrom}..${lastDay}`, "as F, source_type <> tdnet", seven, failed, (r) => positive(r) && r.source_type !== "tdnet"));
  out.push(rate("I last 7 days, all judged", `${sevenFrom}..${lastDay}`, "as E, last 7 created days", seven, failed, () => true));
  out.push(rate("J last 3 days, important+", `${threeFrom}..${lastDay}`, "as A, last 3 created days", three, failed, positive));
  return out;
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
