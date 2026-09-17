// market_report_packet.v1: the shared market analysis that X and the app both
// read (docs/market-report-shared-platform/DESIGN.md §5). Pure: no I/O.
//
// Numbers and directions in the packet are computed in code from the immutable
// market_data_packet; the model only writes the explanatory text, and every
// claim carries evidence refs. Consumers never re-analyse the market: X formats
// x_post deterministically, the app copies market_section verbatim.

export const REPORT_SCHEMA_VERSION = "market_report_packet.v1";

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

export type KeyNews = { ref_id: string; headline_ja: string; why_it_matters_ja: string };
export type Theme = { name_ja: string; claim_ids: string[] };
export type XPost = { lead_ja: string; points_ja: string[]; closing_ja: string };

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
  fact: { local_issues: string[]; ai_status: "passed"; generation_attempts: number };
};

// ---------------------------------------------------------------------------
// X: deterministic formatting of the shared packet
// ---------------------------------------------------------------------------

export const X_HEADERS: Record<ReportType, string> = {
  morning: "【朝刊】きょうの日本株、ここをチェック☀️",
  close: "【大引け】きょうの日本株まとめ🌙",
};

const X_POINTS_TITLE: Record<ReportType, string> = {
  morning: "📌 今日の注目ポイント",
  close: "📌 今日の3ポイント",
};

export const X_POST_MIN_CHARS = 150;
export const X_POST_MAX_CHARS = 520;

export function formatSharedXPost(packet: MarketReportPacket): string {
  const points = packet.x_post.points_ja.map((point) => `・${point.trim()}`).join("\n");
  return [
    X_HEADERS[packet.report_type],
    packet.x_post.lead_ja.trim(),
    "",
    X_POINTS_TITLE[packet.report_type],
    points,
    "",
    `💬 ${packet.x_post.closing_ja.trim()}`,
  ].join("\n");
}

/** Codes for a formatted X body that must not be posted. */
export function sharedXPostIssues(packet: MarketReportPacket, text: string): string[] {
  const issues: string[] = [];
  const length = Array.from(text).length;
  if (length < X_POST_MIN_CHARS) issues.push("X_POST_TOO_SHORT");
  if (length > X_POST_MAX_CHARS) issues.push("X_POST_TOO_LONG");
  if (packet.x_post.points_ja.length !== 3 || packet.x_post.points_ja.some((point) => !point.trim())) {
    issues.push("X_POST_POINTS_INVALID");
  }
  if (/https?:\/\/|www\./i.test(text)) issues.push("X_POST_URL");
  if (/[#＃]\S/.test(text)) issues.push("X_POST_HASHTAG");
  if (/\n{3,}/.test(text)) issues.push("X_POST_BLANK_LINES");
  return issues;
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
