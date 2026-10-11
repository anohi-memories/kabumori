// market_report_packet.v1: the shared market analysis that X and the app both
// read (docs/market-report-shared-platform/DESIGN.md §5). Pure: no I/O.
//
// Numbers and directions in the packet are computed in code from the immutable
// market_data_packet; the model only writes the explanatory text, and every
// claim carries evidence refs. Consumers never re-analyse the market: X formats
// x_post deterministically, the app copies market_section verbatim.
//
// Presentation v2 (2026-10-01) is additive: market_report_packets.schema_version is pinned to
// "market_report_packet.v1" by a table check, so the richer X digest and the app story travel as
// optional fields marked by presentation_version. A stored packet without them renders as before.

export const REPORT_SCHEMA_VERSION = "market_report_packet.v1";
export const PRESENTATION_VERSION = "market_presentation.v2";

export type ReportType = "morning" | "close";
export type MarketDirection = "up" | "down" | "mixed" | "flat" | "unknown";
export type ClaimType = "observation" | "causal" | "consistent_with" | "insufficient_evidence" | "watch_point";

export type MajorMove = {
  metric_key: string;
  label: string;
  session_date: string;
  value_display: string;
  change_pct_display: string | null;
  freshness: "fresh" | "stale";
};

export type Claim = {
  claim_id: string;
  text_ja: string;
  claim_type: ClaimType;
  evidence_refs: string[];
  scope: "today" | "overnight" | "next";
};

/** How widely a news item matters: the whole market, a sector/theme, or one company. */
export type NewsScope = "broad" | "sector" | "company";
export type KeyNews = { ref_id: string; headline_ja: string; why_it_matters_ja: string; scope?: NewsScope };
export type Theme = { name_ja: string; claim_ids: string[] };
/** context_ja / news_ja / watch_ja exist only on presentation v2 packets (news_ja may be empty). */
export type XPost = {
  lead_ja: string;
  points_ja: string[];
  closing_ja: string;
  context_ja?: string;
  news_ja?: string;
  watch_ja?: string;
};
/** Model-written prose for the app's market story; headings and metric lines are added in code. */
export type AppStoryDraft = {
  summary_ja: string;
  overseas_ja: string;
  japan_ja: string;
  cross_asset_ja: string;
  news_ja: string;
  strong_ja: string;
  caution_ja: string;
  watch_ja: string;
};
/** Direction of one market session, decided in code. A morning packet has two different sessions. */
export type SessionView = {
  market: "tokyo" | "us";
  session_date: string | null;
  direction: MarketDirection;
  basis: string[];
};

export type MarketReportPacket = {
  schema_version: typeof REPORT_SCHEMA_VERSION;
  report_type: ReportType;
  trading_date: string;
  data_packet_id: string;
  data_content_hash: string;
  generated_at: string;
  model: string;
  market_direction: MarketDirection;
  direction_basis: string[];
  headline_ja: string;
  market_summary_ja: string;
  major_moves: MajorMove[];
  claims: Claim[];
  key_news: KeyNews[];
  strong_themes: Theme[];
  weak_themes: Theme[];
  next_watch_ja: string[];
  risks_ja: string[];
  data_gaps_ja: string[];
  x_post: XPost;
  presentation_version?: typeof PRESENTATION_VERSION;
  app_story?: AppStoryDraft;
  session_views?: SessionView[];
  /**
   * quality_warnings never block delivery; they are recorded for observation.
   * ai_status: "passed" when the delivered text passed the Fact check; "advisory" when the Fact check reported
   * findings the deterministic guards could not confirm (delivered, findings recorded); "not_run" when no Fact verdict
   * was obtained for it. Packets before 2026-10-07 are always "passed".
   */
  fact: {
    local_issues: string[];
    ai_status: MarketReportFactStatus;
    generation_attempts: number;
    quality_warnings?: string[];
    /** Fixed codes of the units removed or neutralized before delivery (UNIT_<ACTION>:<CODE>@<path>). */
    removed_units?: string[];
  };
};

export type MarketReportFactStatus = "passed" | "advisory" | "not_run";

export function isPresentationV2(packet: MarketReportPacket): boolean {
  return packet.presentation_version === PRESENTATION_VERSION && typeof packet.x_post.context_ja === "string";
}

// ---------------------------------------------------------------------------
// X: deterministic formatting of the shared packet
// ---------------------------------------------------------------------------

export const X_HEADERS: Record<ReportType, string> = {
  morning: "【朝刊】きょうの日本株、ここをチェック☀️",
  close: "【大引け】きょうの日本株まとめ🌙",
};

const X_POINTS_TITLE: Record<ReportType, (count: number) => string> = {
  morning: () => "📌 今日の注目ポイント",
  close: (count) => `📌 今日の${count}ポイント`,
};

const X_WATCH_TITLE: Record<ReportType, string> = {
  morning: "👀 今日見るポイント",
  close: "👀 明日以降の注目点",
};
const X_CLOSING_TITLE = "💬 今日のひとこと";

/**
 * Added by code, once, at the end of every X post and every app story (2026-10-07). The model never writes it, no
 * length rule measures or shortens it.
 */
export const REPORT_DISCLAIMER_JA = "※本レポートはAIによる分析です。内容に誤り・不足を含む可能性があります。最終的な投資判断はご自身でお願いします。";

/** Below this a body is broken output, not a short digest (measured without the disclaimer). */
export const X_POST_HARD_MIN_CHARS = 80;
/**
 * Above this the body is not postable. The Kabumori X account is Premium (long posts up to 25,000 weighted
 * characters; a CJK character weighs 2), so 12,500 characters fit whatever the script. The editorial targets below
 * are warnings only.
 */
export const X_POST_HARD_MAX_CHARS = 12_500;
/** Editorial target for the formatted body (header included, fixed hashtags excluded). */
export const X_POST_TARGET_MIN_CHARS = 430;
export const X_POST_TARGET_MAX_CHARS = 560;
export const X_POST_EMOJI_MIN = 3;
export const X_POST_EMOJI_MAX = 8;

/** The formatted X body ends with the disclaimer exactly once. */
export function formatSharedXPost(packet: MarketReportPacket): string {
  return `${formatXBody(packet)}\n\n${REPORT_DISCLAIMER_JA}`;
}

/** The body without the disclaimer: what the length and shape rules measure. */
function xBodyOf(text: string): string {
  return text.endsWith(REPORT_DISCLAIMER_JA) ? text.slice(0, -REPORT_DISCLAIMER_JA.length).trimEnd() : text;
}

function formatXBody(packet: MarketReportPacket): string {
  // Points or a closing removed as factually wrong before delivery are left out with their heading.
  const pointList = packet.x_post.points_ja.map((point) => point.trim()).filter(Boolean);
  const points = pointList.length > 0
    ? [X_POINTS_TITLE[packet.report_type](pointList.length), ...pointList.map((point) => `・${point}`)].join("\n")
    : "";
  const closing = packet.x_post.closing_ja.trim();
  if (!isPresentationV2(packet)) {
    return [
      [X_HEADERS[packet.report_type], packet.x_post.lead_ja.trim()].join("\n"),
      points,
      closing ? `💬 ${closing}` : "",
    ].filter(Boolean).join("\n\n");
  }
  const context = (packet.x_post.context_ja ?? "").trim();
  const news = (packet.x_post.news_ja ?? "").trim();
  const watch = (packet.x_post.watch_ja ?? "").trim();
  // Optional paragraphs are dropped when the evidence did not support them.
  return [
    [X_HEADERS[packet.report_type], packet.x_post.lead_ja.trim()].join("\n"),
    points,
    context,
    news ? `📰 ${news}` : "",
    watch ? [X_WATCH_TITLE[packet.report_type], watch].join("\n") : "",
    closing ? [X_CLOSING_TITLE, closing].join("\n") : "",
  ].filter(Boolean).join("\n\n");
}

export function emojiCount(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

/**
 * Codes for a formatted X body that must not be posted (broken or platform-unsafe output only). Up to three points
 * and an empty closing are postable: a point or sentence removed as wrong is left out (2026-10-07, delivery first).
 */
export function sharedXPostIssues(packet: MarketReportPacket, text: string): string[] {
  const issues: string[] = [];
  const length = Array.from(xBodyOf(text)).length;
  if (length < X_POST_HARD_MIN_CHARS) issues.push("X_POST_TOO_SHORT");
  if (Array.from(text).length > X_POST_HARD_MAX_CHARS) issues.push("X_POST_TOO_LONG");
  if (packet.x_post.points_ja.length > 3 || packet.x_post.points_ja.some((point) => !point.trim())) {
    issues.push("X_POST_POINTS_INVALID");
  }
  if (!packet.x_post.lead_ja.trim()) issues.push("X_POST_SECTION_EMPTY");
  if (text.split(REPORT_DISCLAIMER_JA).length !== 2) issues.push("X_POST_DISCLAIMER_INVALID");
  if (/https?:\/\/|www\./i.test(text)) issues.push("X_POST_URL");
  if (/[#＃]\S/.test(text)) issues.push("X_POST_HASHTAG");
  if (/\n{3,}/.test(text)) issues.push("X_POST_BLANK_LINES");
  return issues;
}

/** Editorial shortfalls of a postable X body. These are recorded and never suppress the post. */
export function sharedXPostWarnings(packet: MarketReportPacket, text: string): string[] {
  const warnings: string[] = [];
  const length = Array.from(xBodyOf(text)).length;
  if (length < X_POST_TARGET_MIN_CHARS) warnings.push(`X_POST_SHORTER_THAN_TARGET:${length}`);
  if (length > X_POST_TARGET_MAX_CHARS) warnings.push(`X_POST_LONGER_THAN_TARGET:${length}`);
  const emoji = emojiCount(text);
  if (emoji < X_POST_EMOJI_MIN || emoji > X_POST_EMOJI_MAX) warnings.push(`X_POST_EMOJI_COUNT:${emoji}`);
  if (isPresentationV2(packet)) {
    if (!(packet.x_post.context_ja ?? "").trim()) warnings.push("X_POST_CONTEXT_OMITTED");
    if (!(packet.x_post.news_ja ?? "").trim()) warnings.push("X_POST_NEWS_OMITTED");
    if (!(packet.x_post.watch_ja ?? "").trim()) warnings.push("X_POST_WATCH_OMITTED");
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// App: the market section copied verbatim into personalized reports
// ---------------------------------------------------------------------------

export type AppMarketSection = {
  report_packet_id: string;
  report_content_hash: string;
  market_direction: MarketDirection;
  headline_ja: string;
  market_summary_ja: string;
  major_moves: MajorMove[];
  claims: Array<Pick<Claim, "text_ja" | "claim_type" | "scope">>;
  key_news: KeyNews[];
  next_watch_ja: string[];
  risks_ja: string[];
  data_gaps_ja: string[];
};

export function appMarketSection(
  packet: MarketReportPacket,
  reportPacketId: string,
  reportContentHash: string,
): AppMarketSection {
  return {
    report_packet_id: reportPacketId,
    report_content_hash: reportContentHash,
    market_direction: packet.market_direction,
    headline_ja: packet.headline_ja,
    market_summary_ja: packet.market_summary_ja,
    major_moves: packet.major_moves,
    claims: packet.claims.map(({ text_ja, claim_type, scope }) => ({ text_ja, claim_type, scope })),
    key_news: packet.key_news,
    next_watch_ja: packet.next_watch_ja,
    risks_ja: packet.risks_ja,
    data_gaps_ja: packet.data_gaps_ja,
  };
}

// ---------------------------------------------------------------------------
// Consumer contract for get_shared_market_report
// ---------------------------------------------------------------------------

export type SharedMarketReportResult =
  | { enabled: false; status: "disabled" }
  | { enabled: true; status: "missing" | "not_ready"; cycle_status?: string; report_status?: string; report_last_error?: string | null }
  | {
    enabled: true;
    status: "completed";
    report_packet_id: string;
    report_content_hash: string;
    data_packet_id: string;
    data_content_hash: string;
    report: MarketReportPacket;
    data: { metrics?: Array<Record<string, unknown>> } & Record<string, unknown>;
  };

export function parseSharedMarketReportResult(value: unknown): SharedMarketReportResult {
  const row = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
  const payload = row && typeof row === "object" && "get_shared_market_report" in row
    ? row.get_shared_market_report as Record<string, unknown>
    : row;
  if (!payload || typeof payload !== "object" || typeof payload.enabled !== "boolean") {
    throw new Error("SHARED_MARKET_REPORT_INVALID_RESPONSE");
  }
  if (payload.enabled === false) return { enabled: false, status: "disabled" };
  if (payload.status === "completed") {
    const report = payload.report as MarketReportPacket | undefined;
    if (
      !report || report.schema_version !== REPORT_SCHEMA_VERSION ||
      typeof payload.report_packet_id !== "string" || typeof payload.report_content_hash !== "string"
    ) {
      throw new Error("SHARED_MARKET_REPORT_INVALID_RESPONSE");
    }
    return payload as SharedMarketReportResult;
  }
  return {
    enabled: true,
    status: payload.status === "missing" ? "missing" : "not_ready",
    cycle_status: typeof payload.cycle_status === "string" ? payload.cycle_status : undefined,
    report_status: typeof payload.report_status === "string" ? payload.report_status : undefined,
    report_last_error: typeof payload.report_last_error === "string" ? payload.report_last_error : null,
  };
}

/** Tokyo calendar date of an instant, YYYY-MM-DD. */
export function tokyoDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}
