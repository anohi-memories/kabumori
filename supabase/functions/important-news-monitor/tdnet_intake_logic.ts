import type { IncomingNewsCandidate } from "./news_candidate_logic.ts";

// TDnet T1: pure logic of the intake queue (Stage A) and the PDF worker's claim planning (Stage B).
// Nothing here touches the network or the DB. The queue exists so that EVERY disclosure the TDnet list shows is
// known immediately (cheap), while the expensive PDF step is spent in priority order, with aging so that a
// low-priority disclosure is delayed but never dropped.

export type TdnetPriorityTier = 1 | 2 | 3;

export type TdnetQueueState =
  | "queued"
  | "enriching"
  | "candidate_created"
  | "skipped_routine"
  | "failed_retryable"
  | "failed_terminal";

export type TdnetQueueRow = {
  id: string;
  source_url: string;
  company_code: string;
  company_name: string;
  title: string;
  published_at: string;
  priority_tier: TdnetPriorityTier;
  priority_reason: string;
  group_key: string;
  state: TdnetQueueState;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  candidate_id: string | null;
  discovered_at: string;
};

export type TdnetQueueInsert = Pick<
  TdnetQueueRow,
  "source_url" | "company_code" | "company_name" | "title" | "published_at" | "priority_tier" | "priority_reason" | "group_key"
>;

export const TDNET_WORKER_LIMITS = {
  /** Attempts per row: the last one falls back to a body-less candidate (what the legacy path did on a PDF failure). */
  maxAttempts: 3,
  /** A claim is valid this long; a worker that died leaves a stale claim that the next claim may take over. */
  leaseMs: 3 * 60 * 1000,
  /** Retry delays after attempt 1, 2 (attempt 3 is final). */
  backoffMs: [5 * 60 * 1000, 15 * 60 * 1000],
  /** Disclosures of one issuer within this window are one event group (same window the legacy grouping uses). */
  groupWindowMs: 5 * 60 * 1000,
  /** Hard cap on one group's size: a pathological issuer cannot make one claim unbounded. */
  maxGroupMembers: 6,
  /** PDFs per invocation and parallelism. Concurrency 2 keeps Edge memory well under 256MB (see the T1 report). */
  defaultMaxItems: 10,
  defaultConcurrency: 2,
  maxConcurrency: 3,
  /** A worker invocation stops taking new groups after this long (the Function limit is 150s). */
  budgetMs: 90_000,
  /** Reserved for the oldest waiting disclosure per invocation, whatever its tier (starvation guard). */
  oldestSlots: 1,
  /** Queue candidates read per invocation. */
  readLimit: 300,
} as const;

// ---------------------------------------------------------------- priority

type TierRule = { pattern: RegExp; reason: string };

// Recurring routine notices. Checked first so a keyword they contain cannot make them high priority.
const LOW_ROUTINE: TierRule[] = [
  { pattern: /ETF|ＥＴＦ|ETN|ＥＴＮ|上場投資信託|ETFに関する日々|日々の開示事項|収益分配|信託財産|約款変更|シリーズ\s*\d|トラスト\s*シリーズ|SPDR|ゴールド・シェア/iu, reason: "etf_etn_routine" },
  // "取得枠拡大 / 期間の延長 / 決定" next to a status wording is a real decision, not the monthly status notice.
  { pattern: /^(?!.*(?:枠拡大|枠の拡大|拡大|延長|決定|決議|変更|増額)).*(?:自己株式の取得状況|自己株式の取得結果|取得状況及び取得終了|取得状況および取得終了)/u, reason: "buyback_status_routine" },
  { pattern: /月間行使状況|新株予約権.*行使状況/u, reason: "warrant_monthly_routine" },
  { pattern: /支配株主等に関する事項|事業計画及び成長可能性|コーポレート・ガバナンスに関する報告書|議決権行使結果|臨時報告書の提出|有価証券報告書の提出/u, reason: "periodic_filing_routine" },
  { pattern: /基準日設定|基準日及び|臨時株主総会招集|定時株主総会.*開催|株主総会招集/u, reason: "meeting_admin_routine" },
  { pattern: /役員人事|人事異動|代表取締役の異動|取締役の辞任|執行役員|組織変更|組織改編/u, reason: "personnel_routine" },
  { pattern: /資金の借入|資金の借入れ|譲渡制限付株式報酬|株式報酬としての|連結子会社からの配当金受領|子会社からの配当/u, reason: "treasury_admin_routine" },
];

const HIGH_RULES: TierRule[] = [
  { pattern: /公開買付|ＴＯＢ|TOB|ＭＢＯ|MBO|株式等売渡請求|スクイーズアウト|完全子会社化/u, reason: "tob_mbo" },
  { pattern: /業績予想の修正|業績予想及び|業績予想に関する|予想値と実績値の差異|特別損失|特別利益|減損|債務超過|継続企業の前提/u, reason: "earnings_revision" },
  { pattern: /配当予想の修正|剰余金の配当(?:予想)?の修正|増配|減配|無配|配当方針の変更|配当予想.*(?:修正|変更)|株主還元方針/u, reason: "dividend_change" },
  { pattern: /自己株式取得に係る事項の決定|自己株式の取得に係る事項|自己株式の取得(?:に関する|について)?(?:お知らせ)?(?!状況|結果)|自己株式の消却|自己株式の公開買付|株式分割|株式併合/u, reason: "capital_policy" },
  { pattern: /合併|株式交換|株式移転|会社分割|事業譲渡|事業譲受|子会社の異動|子会社化|株式取得|買収|資本業務提携|業務提携|資本提携|共同出資|合弁/u, reason: "ma_alliance" },
  { pattern: /大量買付|買収防衛|対応方針/u, reason: "takeover_defense" },
  { pattern: /第三者割当|新株式の発行|新株予約権の発行|公募増資|売出し|転換社債|新株発行/u, reason: "financing" },
  { pattern: /上場廃止|監理銘柄|整理銘柄|特設注意市場銘柄|上場維持|不適切な会計|不適切会計|訂正|第三者委員会|調査委員会|不祥事|不正|行政処分|業務改善命令|課徴金|訴訟|提訴|和解|破産|民事再生|会社更生|事業再生/u, reason: "governance_legal" },
  { pattern: /火災|爆発|事故|工場.*停止|操業停止|生産停止|稼働停止|リコール|サイバー|ランサムウェア|不正アクセス|情報漏えい|災害|被害|地震|システム障害/u, reason: "incident" },
  { pattern: /受注|失注|契約解除|契約の解除|契約の締結|解約|特許|ライセンス/u, reason: "contract_order" },
];

export function classifyTdnetPriority(rawTitle: string): { tier: TdnetPriorityTier; reason: string } {
  const title = rawTitle.normalize("NFKC").replace(/\s+/gu, " ").trim();
  for (const rule of LOW_ROUTINE) if (rule.pattern.test(title)) return { tier: 3, reason: rule.reason };
  for (const rule of HIGH_RULES) if (rule.pattern.test(title)) return { tier: 1, reason: rule.reason };
  if (/決算短信|決算補足|決算説明|四半期報告|半期報告/u.test(title)) return { tier: 2, reason: "financial_results" };
  return { tier: 2, reason: "default_mid" };
}

// ---------------------------------------------------------------- intake mapping

function normalizedCode(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/** Identity used to put one issuer's near-simultaneous disclosures into one event group (5-minute buckets). */
export function tdnetGroupKey(companyCode: string, publishedAt: string): string {
  const bucket = Math.floor(Date.parse(publishedAt) / TDNET_WORKER_LIMITS.groupWindowMs);
  return `${normalizedCode(companyCode)}:${bucket}`;
}

export function toTdnetQueueInsert(candidate: IncomingNewsCandidate): TdnetQueueInsert | null {
  if (candidate.sourceType !== "tdnet" || !candidate.companyCode || !candidate.companyName) return null;
  if (!/^https:\/\//u.test(candidate.sourceUrl) || !Number.isFinite(Date.parse(candidate.publishedAt))) return null;
  const priority = classifyTdnetPriority(candidate.title);
  return {
    source_url: candidate.sourceUrl,
    company_code: candidate.companyCode,
    company_name: candidate.companyName,
    title: candidate.title,
    published_at: new Date(candidate.publishedAt).toISOString(),
    priority_tier: priority.tier,
    priority_reason: priority.reason,
    group_key: tdnetGroupKey(candidate.companyCode, candidate.publishedAt),
  };
}

export function queueRowToCandidate(row: Pick<TdnetQueueRow, "source_url" | "company_code" | "company_name" | "title" | "published_at">): IncomingNewsCandidate {
  return {
    sourceType: "tdnet",
    sourceName: "tdnet",
    sourceUrl: row.source_url,
    title: row.title,
    bodySummary: null,
    companyName: row.company_name,
    companyCode: row.company_code,
    entityKey: `company:${row.company_code.trim().toLowerCase()}`,
    category: "other_corporate_ir",
    publishedAt: new Date(row.published_at).toISOString(),
  };
}

// ---------------------------------------------------------------- claim planning

/**
 * Notices that are unambiguously routine (ETF / ETN daily & distribution notices, monthly buyback status, monthly
 * warrant exercise status). With IMPORTANT_NEWS_TDNET_SKIP_ROUTINE on the worker records them as skipped_routine
 * instead of fetching a PDF and creating a candidate that the AI judgement would only reject. They stay in the queue
 * table (audit / reprocess); nothing is deleted.
 */
export const TDNET_SKIPPABLE_REASONS: ReadonlySet<string> = new Set(["etf_etn_routine", "buyback_status_routine", "warrant_monthly_routine"]);

/** Aging: a row that has waited long enough competes as if it were one (two) tiers higher. */
export const TDNET_AGING_STEPS_MS = [90 * 60 * 1000, 240 * 60 * 1000] as const;

export function effectiveTier(row: Pick<TdnetQueueRow, "priority_tier" | "published_at">, nowMs: number): number {
  const waited = nowMs - Date.parse(row.published_at);
  const boost = TDNET_AGING_STEPS_MS.filter((step) => waited >= step).length;
  return Math.max(1, row.priority_tier - boost);
}

/** A row the worker may take now: queued, or retryable and due, or an enriching row whose lease has expired. */
export function isClaimable(row: TdnetQueueRow, nowMs: number): boolean {
  if (row.attempt_count >= TDNET_WORKER_LIMITS.maxAttempts + 1) return false;
  if (row.state === "queued") return true;
  if (row.state === "failed_retryable") return Date.parse(row.next_attempt_at) <= nowMs;
  if (row.state === "enriching") return row.lease_expires_at !== null && Date.parse(row.lease_expires_at) < nowMs;
  return false;
}

export type TdnetClaimGroup = { key: string; rows: TdnetQueueRow[]; reason: "priority" | "oldest" };

/**
 * Orders claimable rows into event groups for one invocation.
 *  - the `oldestSlots` oldest waiting groups come first (starvation guard), then groups by effective tier and age;
 *  - disclosures of the same issuer in the same 5-minute bucket stay together (the legacy grouping's atomic group),
 *    capped at maxGroupMembers;
 *  - at most `maxItems` rows in total; the first group is always taken whole even if it alone exceeds the budget.
 */
export function planTdnetClaims(
  rows: readonly TdnetQueueRow[],
  nowMs: number,
  options: { maxItems?: number; oldestSlots?: number } = {},
): TdnetClaimGroup[] {
  const maxItems = options.maxItems ?? TDNET_WORKER_LIMITS.defaultMaxItems;
  const oldestSlots = options.oldestSlots ?? TDNET_WORKER_LIMITS.oldestSlots;
  const byKey = new Map<string, TdnetQueueRow[]>();
  for (const row of rows) {
    if (!isClaimable(row, nowMs)) continue;
    const members = byKey.get(row.group_key) ?? [];
    members.push(row);
    byKey.set(row.group_key, members);
  }
  const groups = [...byKey].map(([key, members]) => {
    const sorted = [...members].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at) || a.source_url.localeCompare(b.source_url));
    return {
      key,
      rows: sorted.slice(0, TDNET_WORKER_LIMITS.maxGroupMembers),
      oldestAt: Date.parse(sorted[0].published_at),
      tier: Math.min(...sorted.map((row) => effectiveTier(row, nowMs))),
    };
  });
  const byAge = [...groups].sort((a, b) => a.oldestAt - b.oldestAt || a.key.localeCompare(b.key));
  const byPriority = [...groups].sort((a, b) => a.tier - b.tier || a.oldestAt - b.oldestAt || a.key.localeCompare(b.key));
  const ordered: Array<{ group: typeof groups[number]; reason: "priority" | "oldest" }> = [];
  const taken = new Set<string>();
  for (const group of byAge.slice(0, oldestSlots)) {
    ordered.push({ group, reason: "oldest" });
    taken.add(group.key);
  }
  for (const group of byPriority) {
    if (!taken.has(group.key)) ordered.push({ group, reason: "priority" });
  }
  const plan: TdnetClaimGroup[] = [];
  let used = 0;
  for (const { group, reason } of ordered) {
    if (plan.length > 0 && used + group.rows.length > maxItems) continue;
    plan.push({ key: group.key, rows: group.rows, reason });
    used += group.rows.length;
    if (used >= maxItems) break;
  }
  return plan;
}

// ---------------------------------------------------------------- failure handling

export type TdnetFailureDecision =
  | { action: "retry"; nextAttemptAt: string }
  | { action: "fallback_without_body" };

// PDF errors that no retry can fix: the legacy path would also store a body-less candidate.
const PERMANENT_PDF_ERRORS = /^(?:TDNET_PDF_TOO_LARGE|TDNET_PDF_INVALID|TDNET_PDF_TEXT_EMPTY|TDNET_PDF_FETCH_FAILED:4\d\d)$/u;

export function decideTdnetFailure(attemptCount: number, errorCode: string, nowMs: number): TdnetFailureDecision {
  if (PERMANENT_PDF_ERRORS.test(errorCode) || attemptCount >= TDNET_WORKER_LIMITS.maxAttempts) {
    return { action: "fallback_without_body" };
  }
  const delay = TDNET_WORKER_LIMITS.backoffMs[Math.min(attemptCount, TDNET_WORKER_LIMITS.backoffMs.length) - 1] ??
    TDNET_WORKER_LIMITS.backoffMs[TDNET_WORKER_LIMITS.backoffMs.length - 1];
  return { action: "retry", nextAttemptAt: new Date(nowMs + delay).toISOString() };
}

/** Short, secret-free error code stored in last_error. */
export function safeQueueError(error: unknown): string {
  const value = error instanceof Error ? error.message : "TDNET_QUEUE_UNKNOWN_ERROR";
  return /^[A-Z0-9_:-]+$/u.test(value) ? value.slice(0, 120) : "TDNET_QUEUE_ERROR";
}
