// F2 かぶモリ休止のオフライン設計モデル（2026-10-15）。純粋関数だけ: 実 HTTP・DB・SDK・SNS・Push・課金は一切ない。
//
// main d2309afc の次の挙動を、合成データで検証できる最小の形に写したもの（実 runtime の証明ではない）:
//   - claim_due_post: pending かつ期限到来、morning_greeting 以外の最古の1行を、ブランドを問わず取る
//     （supabase/migrations/20260901044548_*.sql:17-46。本番の本体は未確認）
//   - brandIdFromScheduledRow: NULL / 空の brand_id は kabumori（_shared/brand/brand_context.ts:50-56）
//   - assertBrandPublishAllowed: is_active / publish_mode=live / X アカウント publish_enabled（publish_guard.ts:7-19）。
//     判定は claim の後・トークンと生成の前（x-test-post/index.ts:3985-3993）。失敗した行は fail_scheduled_post で
//     終端の failed になる（同 :4840-4866）
//   - x_enabled=false の朝刊・大引けは旧生成（OpenAI web search）へ戻る（shared_market_report_consumer.ts:4、
//     index.ts:4270-4290）。ただしブランドの判定はそれより前
//   - notifications の dispatcher（#9）は source_type を問わず pending を送る（20260912100000）

export const LEGACY_KABUMORI_BRAND_ID = "kabumori";

export type PublishMode = "live" | "dry_run" | "disabled";
export type Brand = { id: string; is_active: boolean; publish_mode: PublishMode; x_publish_enabled: boolean };
export type PostStatus = "pending" | "running" | "succeeded" | "failed";
export type ScheduledRow = {
  id: string;
  brand_id: string | null;
  post_type: string;
  /** epoch minutes */
  scheduled_for: number;
  status: PostStatus;
  attempt_count: number;
};

export type BrandTable = { ok: true; brands: readonly Brand[] } | { ok: false };

export function resolveBrandId(row: Pick<ScheduledRow, "brand_id">): string {
  return typeof row.brand_id === "string" && row.brand_id.length > 0 ? row.brand_id : LEGACY_KABUMORI_BRAND_ID;
}

/** The X boundary. Unknown brand or an unreadable brand table is fail closed (no send). */
export function guardCode(table: BrandTable, brandId: string): string | null {
  if (!table.ok) return "BRAND_CONTEXT_UNAVAILABLE";
  const brand = table.brands.find((item) => item.id === brandId);
  if (!brand) return "BRAND_NOT_FOUND";
  if (!brand.is_active) return "BRAND_DISABLED";
  if (brand.publish_mode !== "live") return brand.publish_mode === "dry_run" ? "BRAND_PUBLISH_MODE_DRY_RUN" : "BRAND_PUBLISH_MODE_DISABLED";
  if (!brand.x_publish_enabled) return "BRAND_X_ACCOUNT_DISABLED";
  return null;
}

export type ConsumerPath = "blocked_by_brand" | "shared_report_post" | "shared_report_unavailable_fail" | "legacy_ai_generation_and_post";

/** Morning / close: what the dispatcher does with one claimed row (the guard comes first). */
export function marketReportPath(args: { guard: string | null; xEnabled: boolean; sharedCompleted: boolean }): ConsumerPath {
  if (args.guard !== null) return "blocked_by_brand";
  if (!args.xEnabled) return "legacy_ai_generation_and_post";
  return args.sharedCompleted ? "shared_report_post" : "shared_report_unavailable_fail";
}

export type DispatchEvent = {
  minute: number;
  rowId: string;
  brandId: string;
  outcome: "sent" | "failed_by_guard" | "failed_shared_unavailable";
  code: string | null;
  aiCall: boolean;
  /** minutes between due and claim */
  delay: number;
};

export type World = {
  rows: ScheduledRow[];
  brands: BrandTable;
  xEnabled: boolean;
  sharedCompleted: boolean;
};

/** One cron #1 tick: claim the oldest due pending row of any brand, then judge it. Mutates `world.rows`. */
export function dispatcherTick(world: World, minute: number): DispatchEvent | null {
  const due = world.rows
    .filter((row) => row.status === "pending" && row.scheduled_for <= minute && row.post_type !== "morning_greeting")
    .sort((a, b) => a.scheduled_for - b.scheduled_for || a.id.localeCompare(b.id));
  const row = due[0];
  if (!row) return null;
  row.status = "running";
  row.attempt_count += 1;
  const brandId = resolveBrandId(row);
  const code = guardCode(world.brands, brandId);
  const base = { minute, rowId: row.id, brandId, delay: minute - row.scheduled_for };
  if (code !== null) {
    row.status = "failed";
    return { ...base, outcome: "failed_by_guard", code, aiCall: false };
  }
  if (row.post_type === "morning_report" || row.post_type === "close_report") {
    const path = marketReportPath({ guard: null, xEnabled: world.xEnabled, sharedCompleted: world.sharedCompleted });
    if (path === "shared_report_unavailable_fail") {
      row.status = "failed";
      return { ...base, outcome: "failed_shared_unavailable", code: "SHARED_MARKET_REPORT_UNAVAILABLE", aiCall: false };
    }
    row.status = "succeeded";
    return { ...base, outcome: "sent", code: null, aiCall: path === "legacy_ai_generation_and_post" };
  }
  row.status = "succeeded";
  // Generated posts (tips, interaction, brand posts) call the model at send time.
  return { ...base, outcome: "sent", code: null, aiCall: true };
}

export function simulate(world: World, fromMinute: number, toMinute: number): DispatchEvent[] {
  const events: DispatchEvent[] = [];
  for (let minute = fromMinute; minute <= toMinute; minute += 1) {
    const event = dispatcherTick(world, minute);
    if (event) events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hold plan: what an operator may do with kabumori's scheduled rows, decided from a fresh snapshot.
// No "held" status exists (scheduled_posts.status is pending/running/succeeded/failed), no DELETE, no unbounded deferral.
// ---------------------------------------------------------------------------------------------------------------------

export type HoldExpectation = {
  /** The pending kabumori rows (by id) the operator approved from the snapshot taken just before. */
  approvedPendingIds: readonly string[];
  /** Per other brand, the pending count seen in that snapshot (read back unchanged afterwards). */
  otherBrandPending: Readonly<Record<string, number>>;
};

export type HoldDecision =
  | { action: "abort"; reasons: string[] }
  | {
    action: "proceed";
    /** kabumori (incl. NULL brand) pending rows: left pending; the closed guard fails each one when due (terminal, logged). */
    targetIds: string[];
    /** Read-back that must hold after the pause steps. */
    readBack: { otherBrandPending: Record<string, number>; kabumoriRunning: 0 };
  };

/**
 * Decide from a snapshot whether the pause may proceed past "X blocked". Aborts (changes nothing) when:
 *   - the brand table cannot be read, or the kabumori guard is not closed yet (block X first);
 *   - a kabumori row is running (in flight: drain first, then take a new snapshot);
 *   - the pending kabumori set differs from the approved one (added / removed / claimed since: drift);
 *   - another brand's pending count differs from the approved snapshot (concurrent change to watch, not to touch).
 */
export function planHold(snapshot: { rows: readonly ScheduledRow[]; brands: BrandTable }, expected: HoldExpectation): HoldDecision {
  const reasons: string[] = [];
  if (!snapshot.brands.ok) return { action: "abort", reasons: ["BRAND_TABLE_UNREADABLE"] };
  if (guardCode(snapshot.brands, LEGACY_KABUMORI_BRAND_ID) === null) reasons.push("KABUMORI_GUARD_STILL_OPEN");
  const kabumori = snapshot.rows.filter((row) => resolveBrandId(row) === LEGACY_KABUMORI_BRAND_ID);
  if (kabumori.some((row) => row.status === "running")) reasons.push("KABUMORI_IN_FLIGHT");
  const pending = kabumori.filter((row) => row.status === "pending").map((row) => row.id).sort();
  const approved = [...expected.approvedPendingIds].sort();
  if (pending.length !== approved.length || pending.some((id, index) => id !== approved[index])) {
    reasons.push(`KABUMORI_PENDING_DRIFT:${approved.length}->${pending.length}`);
  }
  const others: Record<string, number> = {};
  for (const row of snapshot.rows) {
    const brandId = resolveBrandId(row);
    if (brandId === LEGACY_KABUMORI_BRAND_ID || row.status !== "pending") continue;
    others[brandId] = (others[brandId] ?? 0) + 1;
  }
  for (const brandId of new Set([...Object.keys(others), ...Object.keys(expected.otherBrandPending)])) {
    if ((others[brandId] ?? 0) !== (expected.otherBrandPending[brandId] ?? 0)) reasons.push(`OTHER_BRAND_PENDING_CHANGED:${brandId}`);
  }
  if (reasons.length > 0) return { action: "abort", reasons };
  return { action: "proceed", targetIds: pending, readBack: { otherBrandPending: others, kabumoriRunning: 0 } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Push queue: stopping producers does not empty the queue; dispatcher #9 sends pending rows of any source_type.
// ---------------------------------------------------------------------------------------------------------------------

export type PushStatus = "pending" | "processing" | "sent" | "failed" | "skipped";
export type PushRow = { id: string; source_type: string; push_status: PushStatus; created_at: number };

/** What dispatcher #9 would still send after the producers stop (it has no source_type filter). */
export function pushStillSent(queue: readonly PushRow[]): string[] {
  return queue.filter((row) => row.push_status === "pending").map((row) => row.id);
}

/** In flight: processing rows may already be at Expo; they are observed, never re-sent or reset. */
export function pushInFlight(queue: readonly PushRow[]): string[] {
  return queue.filter((row) => row.push_status === "processing").map((row) => row.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Resume: gates stay closed; nothing old is sent in bulk. Stale items need re-review; fresh ones need a new approval.
// ---------------------------------------------------------------------------------------------------------------------

export type BacklogItem = { id: string; kind: "scheduled_post" | "news_ready" | "push"; created_at: number };

export function planResume(backlog: readonly BacklogItem[], now: number, freshnessMinutes: number): {
  autoSend: string[];
  reReview: string[];
  expire: string[];
} {
  const reReview: string[] = [];
  const expire: string[] = [];
  for (const item of backlog) {
    // Anything created before the pause is at least as old as the pause: never sent automatically.
    if (now - item.created_at > freshnessMinutes) expire.push(item.id);
    else reReview.push(item.id);
  }
  return { autoSend: [], reReview, expire };
}

// ---------------------------------------------------------------------------------------------------------------------
// Stop order: dependencies between steps (the design's order, checked offline).
// ---------------------------------------------------------------------------------------------------------------------

export type Step =
  | "snapshot"
  | "block_kabumori_x"
  | "confirm_x_in_flight_drained"
  | "hold_scheduled_posts"
  | "f8_news_gate_closed"
  | "stop_broadcast_sending"
  | "stop_broadcast_enqueue"
  | "stop_ondemand_requests"
  | "stop_market_report_crons"
  | "stop_mic_and_news_discovery_crons"
  | "decide_push_queue"
  | "readback_postona_and_ledger"
  // Never allowed while pausing kabumori:
  | "set_x_enabled_false"
  | "set_app_enabled_false"
  | "stop_dispatcher_1"
  | "stop_dispatcher_9"
  | "delete_api_keys"
  | "rotate_shared_cron_secret";

const FORBIDDEN: ReadonlySet<Step> = new Set([
  "set_x_enabled_false", "set_app_enabled_false", "stop_dispatcher_1", "stop_dispatcher_9", "delete_api_keys", "rotate_shared_cron_secret",
]);

const BEFORE: ReadonlyArray<[Step, Step]> = [
  ["snapshot", "block_kabumori_x"],
  ["block_kabumori_x", "confirm_x_in_flight_drained"],
  ["confirm_x_in_flight_drained", "hold_scheduled_posts"],
  ["block_kabumori_x", "f8_news_gate_closed"],
  ["stop_broadcast_sending", "stop_broadcast_enqueue"],
  ["stop_broadcast_enqueue", "stop_market_report_crons"],
  ["block_kabumori_x", "stop_market_report_crons"],
  ["stop_ondemand_requests", "decide_push_queue"],
  ["f8_news_gate_closed", "decide_push_queue"],
  ["stop_broadcast_sending", "decide_push_queue"],
  ["stop_market_report_crons", "stop_mic_and_news_discovery_crons"],
  ["decide_push_queue", "readback_postona_and_ledger"],
  ["hold_scheduled_posts", "readback_postona_and_ledger"],
];

export function stopOrderViolations(steps: readonly Step[]): string[] {
  const violations: string[] = [];
  for (const step of steps) if (FORBIDDEN.has(step)) violations.push(`FORBIDDEN:${step}`);
  const at = new Map(steps.map((step, index) => [step, index]));
  for (const [first, then] of BEFORE) {
    const a = at.get(first);
    const b = at.get(then);
    if (b !== undefined && (a === undefined || a > b)) violations.push(`ORDER:${first}<${then}`);
  }
  return violations;
}

export const DESIGN_STOP_ORDER: readonly Step[] = [
  "snapshot",
  "block_kabumori_x",
  "confirm_x_in_flight_drained",
  "hold_scheduled_posts",
  "f8_news_gate_closed",
  "stop_broadcast_sending",
  "stop_broadcast_enqueue",
  "stop_ondemand_requests",
  "stop_market_report_crons",
  "stop_mic_and_news_discovery_crons",
  "decide_push_queue",
  "readback_postona_and_ledger",
];
