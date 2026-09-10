// Producer side of the important-news push pipeline.
//
// The dispatcher (supabase/functions/send-push-notifications) only drains rows
// that already sit at notifications.push_status='pending'; nothing was creating
// those rows, so no important news ever reached a device. This module decides
// *whether* a freshly published candidate should enqueue a notification and
// *for whom*, keeping that decision pure so it can be tested without a database.
//
// Targeting deliberately reuses the mapping the app itself already uses in
// public.get_my_important_stock_news: a TDnet-shaped 5-character company_code
// whose first four characters match stocks_master.ticker_code of one of the
// user's active tracked_stocks. Market-wide news (no company_code) therefore
// targets nobody rather than fanning out to every user.
//
// alert_settings is intentionally NOT consulted here. notifications rows are the
// in-app record as well as the push queue, and the dispatcher already applies
// push_enabled / important_news opt-outs at send time (marking rows 'skipped').
// Filtering here too would silently erase the in-app history for opted-out users.

export const IMPORTANT_NEWS_NOTIFICATION_SOURCE_TYPE = "important_news";
export const IMPORTANT_NEWS_NOTIFICATION_TITLE_MAX_CHARACTERS = 60;
export const IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS = 140;
export const IMPORTANT_NEWS_NOTIFICATION_COMPANY_MAX_CHARACTERS = 20;

const PUSHABLE_IMPORTANCE = ["important", "most_important"] as const;

/** Shape of the freshly published candidate, read separately from the publish projection. */
export type ImportantNewsNotificationSource = {
  candidateId: string;
  companyCode: string | null;
  importance: string;
  title: string;
  bodySummary: string | null;
};

/** One active tracked_stocks row whose stock matches the candidate's ticker. */
export type ImportantNewsNotificationTarget = {
  userId: string;
  trackedStockId: string;
  tickerCode: string;
  companyName: string;
};

export type ImportantNewsNotificationRow = {
  user_id: string;
  tracked_stock_id: string;
  source_type: typeof IMPORTANT_NEWS_NOTIFICATION_SOURCE_TYPE;
  source_id: string;
  title: string;
  summary: string;
  importance: string;
  push_status: "pending";
};

/** Only the publish outcome fields that may authorize an enqueue. */
export type ImportantNewsPublishOutcome = {
  published: boolean;
  importance: string | null;
  xPostId: string | null;
};

export type ImportantNewsEnqueueDecision = {
  enqueue: boolean;
  reason:
    | "ENQUEUE_ALLOWED"
    | "NOT_PUBLISHED"
    | "X_POST_ID_MISSING"
    | "IMPORTANCE_NOT_PUSHABLE";
};

/**
 * Gate the producer on the authoritative publish success.
 *
 * `published` only becomes true after markPublished() has flipped the candidate
 * to status='published' with an X post id, so a dry run, a blocked candidate, a
 * rate-limited or overnight-held candidate, and every failure path all return
 * false here.
 */
export function evaluateImportantNewsNotificationEnqueue(
  outcome: ImportantNewsPublishOutcome,
): ImportantNewsEnqueueDecision {
  if (!outcome.published) return { enqueue: false, reason: "NOT_PUBLISHED" };
  if (typeof outcome.xPostId !== "string" || outcome.xPostId.trim().length === 0) {
    return { enqueue: false, reason: "X_POST_ID_MISSING" };
  }
  if (!PUSHABLE_IMPORTANCE.includes(outcome.importance as typeof PUSHABLE_IMPORTANCE[number])) {
    return { enqueue: false, reason: "IMPORTANCE_NOT_PUSHABLE" };
  }
  return { enqueue: true, reason: "ENQUEUE_ALLOWED" };
}

/**
 * TDnet company codes are 5 characters ("79740"); stocks_master keeps the plain
 * 4-character ticker. This mirrors get_my_important_stock_news exactly, so the
 * push audience can never be wider than the in-app feed audience.
 */
export function extractImportantNewsTickerCode(
  companyCode: string | null | undefined,
): string | null {
  if (typeof companyCode !== "string") return null;
  const trimmed = companyCode.trim();
  if (!/^[0-9A-Z]{5}$/.test(trimmed)) return null;
  return trimmed.slice(0, 4);
}

function truncate(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Push title/body reuse the already-published news text only; nothing here calls
 * an AI. The company name comes from the user's own tracked stock so the push
 * says which of their holdings it is about.
 */
export function buildImportantNewsNotificationTitle(
  companyName: string,
  newsTitle: string,
): string {
  const company = truncate(collapseWhitespace(companyName), IMPORTANT_NEWS_NOTIFICATION_COMPANY_MAX_CHARACTERS);
  const headline = collapseWhitespace(newsTitle);
  const prefix = company.length > 0 ? `【${company}】` : "";
  return truncate(`${prefix}${headline}`, IMPORTANT_NEWS_NOTIFICATION_TITLE_MAX_CHARACTERS);
}

export function buildImportantNewsNotificationSummary(
  bodySummary: string | null | undefined,
  newsTitle: string,
): string {
  const summary = collapseWhitespace(typeof bodySummary === "string" ? bodySummary : "");
  // notifications.summary is NOT NULL; fall back to the headline rather than
  // inventing text when a candidate has no stored summary.
  const source = summary.length > 0 ? summary : collapseWhitespace(newsTitle);
  return truncate(source, IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS);
}

/**
 * At most one row per user per news.
 *
 * A user could in principle track the same ticker through two stocks_master rows
 * (different market), which would otherwise produce two notifications for one
 * news item. Picking the lexicographically smallest tracked_stock_id keeps the
 * choice deterministic, so a re-run collides with the same
 * notifications_dedupe(user_id, tracked_stock_id, source_type, source_id) row
 * instead of inserting a second one.
 */
export function buildImportantNewsNotificationRows(
  source: ImportantNewsNotificationSource,
  targets: readonly ImportantNewsNotificationTarget[],
): ImportantNewsNotificationRow[] {
  const bestByUser = new Map<string, ImportantNewsNotificationTarget>();
  for (const target of targets) {
    if (!target.userId || !target.trackedStockId) continue;
    const current = bestByUser.get(target.userId);
    if (!current || target.trackedStockId < current.trackedStockId) {
      bestByUser.set(target.userId, target);
    }
  }
  return Array.from(bestByUser.values())
    .sort((left, right) => left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0)
    .map((target) => ({
      user_id: target.userId,
      tracked_stock_id: target.trackedStockId,
      source_type: IMPORTANT_NEWS_NOTIFICATION_SOURCE_TYPE,
      source_id: source.candidateId,
      title: buildImportantNewsNotificationTitle(target.companyName, source.title),
      summary: buildImportantNewsNotificationSummary(source.bodySummary, source.title),
      importance: source.importance,
      push_status: "pending",
    }));
}
