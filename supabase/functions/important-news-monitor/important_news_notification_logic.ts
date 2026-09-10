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
export const IMPORTANT_NEWS_NOTIFICATION_EMPTY_FALLBACK = "登録銘柄の重要ニュースが公開されました。";

const PUSHABLE_IMPORTANCE = ["important", "most_important"] as const;

/** Shape of the freshly published candidate, read separately from the publish projection. */
export type ImportantNewsNotificationSource = {
  candidateId: string;
  companyCode: string | null;
  importance: string;
  title: string;
  bodySummary: string | null;
  generatedText?: string | null;
  generationFactStatus?: string | null;
  generationVoiceStatus?: string | null;
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

// ---------------------------------------------------------------------------
// Push body
//
// TDnet body_summary is text scraped from the disclosure PDF, so it usually
// opens with the letterhead ("各 位 会社名 … 代表者名 … （TEL …）", "本店所在地 …",
// "Copyright …") and often has a space between every character. Using it as the
// push body put an address on the lock screen instead of the news.
//
// The body is therefore chosen deterministically, most trustworthy first:
//   1. verified_post_text   - the generated X post text, but ONLY when it passed
//                             both the Fact and the Voice checks. The producer
//                             only runs after a successful publish, and publishing
//                             itself requires both checks, so on the live path
//                             this is exactly the text that already went out on X.
//   2. cleaned_body_summary - the PDF text after the headline (or from "当社は"),
//                             with the letterhead dropped and PDF character
//                             spacing removed.
//   3. headline             - the news title; last resort, never empty.
// No AI is called for the push.
// ---------------------------------------------------------------------------

export type ImportantNewsNotificationSummaryStrategy =
  | "verified_post_text"
  | "cleaned_body_summary"
  | "headline";

export type ImportantNewsNotificationSummary = {
  text: string;
  strategy: ImportantNewsNotificationSummaryStrategy;
};

const LEADING_NEWS_LABELS = /^\s*(?:【(?:重大)?速報】\s*)+/u;
const TRAILING_SOURCE_LINE = /\s*出典\s*[:：]\s*https?:\/\/\S+\s*$/u;
const CJK_RANGE = "\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
// PDF extraction spaces characters out ("業 績 予 想"). Whitespace touching a
// CJK/full-width character carries no meaning in Japanese, while spaces between
// two ASCII words ("Mitsui High-tec") are kept.
const SPACE_TOUCHING_CJK = new RegExp(`(?<=[${CJK_RANGE}])\\s+|\\s+(?=[${CJK_RANGE}])`, "gu");
const SENTENCE_END = new Set(["。", "！", "？", "!", "?"]);
const OPENING_BRACKETS = new Set(["（", "(", "「", "『", "【", "［", "["]);
const CLOSING_BRACKETS = new Set(["）", ")", "」", "』", "】", "］", "]"]);
const NUMBER_CHARACTER = /[0-9０-９,，.．]/u;

/**
 * Splits on 。！？ that are NOT inside brackets. Disclosures define terms inline
 * ("（以下「ＳＬＣ社」という。）"), and ending a sentence at that inner 。 leaves a
 * fragment with an unclosed bracket.
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of Array.from(text)) {
    current += character;
    if (OPENING_BRACKETS.has(character)) depth += 1;
    else if (CLOSING_BRACKETS.has(character)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && SENTENCE_END.has(character)) {
      sentences.push(current);
      current = "";
    }
  }
  if (current.trim()) sentences.push(current);
  return sentences;
}

/** The published X post minus its 【速報】 label and trailing 出典 line. */
export function extractVerifiedPostBody(generatedText: string | null | undefined): string | null {
  if (typeof generatedText !== "string") return null;
  const body = collapseWhitespace(
    generatedText.replace(TRAILING_SOURCE_LINE, "").replace(LEADING_NEWS_LABELS, ""),
  );
  return body.length > 0 ? body : null;
}

function removePdfSpacing(value: string): string {
  return collapseWhitespace(value).replace(SPACE_TOUCHING_CJK, "");
}

/**
 * Returns the prose that follows the disclosure's own headline, or null when no
 * trustworthy starting point exists. Matching ignores whitespace because the
 * PDF text frequently spaces the headline out character by character.
 */
export function cleanDisclosureBodySummary(
  bodySummary: string | null | undefined,
  headline: string,
): string | null {
  if (typeof bodySummary !== "string" || bodySummary.trim().length === 0) return null;
  const compactChars: string[] = [];
  const originalIndex: number[] = [];
  for (let index = 0; index < bodySummary.length; index += 1) {
    const character = bodySummary[index];
    if (/\s/.test(character)) continue;
    compactChars.push(character);
    originalIndex.push(index);
  }
  const compact = compactChars.join("");
  const compactHeadline = headline.replace(/\s+/g, "");

  let start = -1;
  if (compactHeadline.length >= 6) {
    const at = compact.indexOf(compactHeadline);
    if (at >= 0) start = originalIndex[at + compactHeadline.length - 1] + 1;
  }
  if (start < 0) {
    const companyStatement = bodySummary.search(/当\s*社\s*(?:グ\s*ル\s*ー\s*プ\s*)?[はが]/u);
    if (companyStatement >= 0) start = companyStatement;
  }
  if (start < 0) return null;

  const prose = removePdfSpacing(bodySummary.slice(start));
  // Only accept something that reads as a sentence; otherwise the headline is safer.
  if (!prose.includes("。") || Array.from(prose).length < 15) return null;
  return prose;
}

/**
 * Keeps whole sentences up to the limit. Only when even the first sentence is
 * too long is it cut, and never inside a number: a figure is either shown in
 * full or not at all, so "300億円" can never be displayed as "30…".
 */
export function fitImportantNewsNotificationText(
  text: string,
  maxCharacters = IMPORTANT_NEWS_NOTIFICATION_SUMMARY_MAX_CHARACTERS,
): string {
  const normalized = collapseWhitespace(text);
  if (Array.from(normalized).length <= maxCharacters) return normalized;

  let fitted = "";
  for (const rawSentence of splitSentences(normalized)) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    const next = `${fitted}${sentence}`;
    if (Array.from(next).length > maxCharacters) break;
    fitted = next;
  }
  if (fitted) return fitted;

  const characters = Array.from(normalized);
  let cut = maxCharacters - 1;
  while (cut > 1 && NUMBER_CHARACTER.test(characters[cut - 1]) && NUMBER_CHARACTER.test(characters[cut])) {
    cut -= 1;
  }
  return `${characters.slice(0, cut).join("").trimEnd()}…`;
}

export function selectImportantNewsNotificationSummary(
  source: ImportantNewsNotificationSource,
): ImportantNewsNotificationSummary {
  if (source.generationFactStatus === "passed" && source.generationVoiceStatus === "passed") {
    const post = extractVerifiedPostBody(source.generatedText);
    if (post) return { text: fitImportantNewsNotificationText(post), strategy: "verified_post_text" };
  }
  const cleaned = cleanDisclosureBodySummary(source.bodySummary, source.title);
  if (cleaned) return { text: fitImportantNewsNotificationText(cleaned), strategy: "cleaned_body_summary" };
  const headline = collapseWhitespace(source.title ?? "");
  return {
    text: fitImportantNewsNotificationText(headline.length > 0 ? headline : IMPORTANT_NEWS_NOTIFICATION_EMPTY_FALLBACK),
    strategy: "headline",
  };
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
  const summary = selectImportantNewsNotificationSummary(source).text;
  return Array.from(bestByUser.values())
    .sort((left, right) => left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0)
    .map((target) => ({
      user_id: target.userId,
      tracked_stock_id: target.trackedStockId,
      source_type: IMPORTANT_NEWS_NOTIFICATION_SOURCE_TYPE,
      source_id: source.candidateId,
      title: buildImportantNewsNotificationTitle(target.companyName, source.title),
      summary,
      importance: source.importance,
      push_status: "pending",
    }));
}
