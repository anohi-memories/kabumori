// F2 かぶモリ休止の停止候補（2026-10-15）: planner の可逆停止と、たまった通知の扱いの「計画」だけを作る純粋関数。
// 実 DB・Cron・Push には触れない。出力は、操作の直前の snapshot と照合するための計画と読み戻しの期待値で、実行は別承認。
//
// 根拠（main ded9daa7）:
//   - claim_due_post は毎回5つの planner を実行する（migrations/20260901044548）。planner はブランドを見ず、各設定の
//     is_active だけを見る: morning_report_settings / close_report_settings / us_premarket_report_settings /
//     useful_tip_schedule_settings（1行の、かぶモリ専用の設定）と posting_windows（毎日の投稿の時間帯）。
//   - posting_windows は本番で brand_id を持つ（migrations/20260918120000 の事前確認が列の存在を要求）。他ブランドの行が
//     混ざりうるので、かぶモリ（と旧来の NULL）の行だけを止め、他ブランドの行は対象にしない。
//   - notifications.push_status は pending/processing/sent/failed/skipped だけ（20260912100000）。保留の状態は無い。

/**
 * One planner setting row as read from a snapshot. `id` is the row's stable identity (the singleton tables' boolean id
 * "true", posting_windows' uuid); `key` is the business key (post_type:slot_no); `brand_id` is the owner (NULL / "" is
 * the legacy Kabumori owner).
 */
export type SettingRow = { table: string; id: string; key: string; brand_id: string | null; is_active: boolean };

/** One-row Kabumori-only planner settings (no brand column). */
export const KABUMORI_SINGLETON_SETTINGS = [
  "morning_report_settings",
  "close_report_settings",
  "us_premarket_report_settings",
  "useful_tip_schedule_settings",
] as const;

/** The owner as compared everywhere: NULL and "" are the legacy Kabumori owner, written "(legacy)". */
export function ownerOf(row: Pick<SettingRow, "brand_id">): string {
  return row.brand_id === null || row.brand_id === "" ? "(legacy)" : row.brand_id;
}

const isKabumoriOwner = (row: Pick<SettingRow, "brand_id">) => ["(legacy)", "kabumori"].includes(ownerOf(row));

/** A row this plan switches off and may later switch back on: exact identity, owner and the state it must be in. */
export type PlannedRow = { table: string; id: string; key: string; owner: string };
export type WatchedRow = PlannedRow & { is_active: boolean };

export type PlannerStopPlan =
  | { action: "abort"; reasons: string[] }
  | {
    action: "proceed";
    /** Active Kabumori rows to switch off (CAS: id + owner + key + is_active=true). Restore turns exactly these back on. */
    changes: PlannedRow[];
    /** Kabumori rows already off before the pause: never touched, never restored. */
    preexistingOff: PlannedRow[];
    /** Other brands' rows: never touched, read back unchanged (owner, key and state). */
    untouched: WatchedRow[];
  };

function identityProblems(rows: readonly SettingRow[]): string[] {
  const reasons: string[] = [];
  const ids = new Map<string, number>();
  const keys = new Map<string, number>();
  for (const row of rows) {
    const id = `${row.table}#${row.id}`;
    const key = `${row.table}:${row.key}`;
    ids.set(id, (ids.get(id) ?? 0) + 1);
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  for (const [id, count] of ids) if (count > 1) reasons.push(`DUPLICATE_ID:${id}`);
  for (const [key, count] of keys) if (count > 1) reasons.push(`KEY_COLLISION:${key}`);
  return reasons;
}

/**
 * From a fresh snapshot: which Kabumori rows to switch off, which were already off, and which other-brand rows must stay
 * as they are. Aborts (changes nothing) when settings could not be read, a singleton table is missing or duplicated, an
 * id or a business key appears twice, a window belongs to a brand that is neither Kabumori / legacy nor a known other
 * brand, or an unexpected table appears.
 */
export function planPlannerStop(args: {
  read: { ok: true; rows: readonly SettingRow[] } | { ok: false };
  knownOtherBrands: readonly string[];
}): PlannerStopPlan {
  if (!args.read.ok) return { action: "abort", reasons: ["SETTINGS_UNREADABLE"] };
  const rows = args.read.rows;
  const reasons: string[] = [...identityProblems(rows)];
  for (const table of KABUMORI_SINGLETON_SETTINGS) {
    const count = rows.filter((row) => row.table === table).length;
    if (count !== 1) reasons.push(`SINGLETON_ROW_COUNT:${table}:${count}`);
  }
  const changes: PlannedRow[] = [];
  const preexistingOff: PlannedRow[] = [];
  const untouched: WatchedRow[] = [];
  for (const row of rows) {
    const planned = { table: row.table, id: row.id, key: row.key, owner: ownerOf(row) };
    const singleton = (KABUMORI_SINGLETON_SETTINGS as readonly string[]).includes(row.table);
    if (!singleton && row.table !== "posting_windows") {
      reasons.push(`UNEXPECTED_TABLE:${row.table}`);
      continue;
    }
    if (singleton || isKabumoriOwner(row)) {
      (row.is_active ? changes : preexistingOff).push(planned);
    } else if (args.knownOtherBrands.includes(row.brand_id!)) {
      untouched.push({ ...planned, is_active: row.is_active });
    } else {
      reasons.push(`UNKNOWN_BRAND_WINDOW:${row.brand_id}`);
    }
  }
  if (reasons.length > 0) return { action: "abort", reasons };
  return { action: "proceed", changes, preexistingOff, untouched };
}

export type PlannerRestorePlan =
  | { action: "abort"; reasons: string[] }
  | { action: "proceed"; restore: PlannedRow[] };

/**
 * Resume: switch back on exactly the rows the stop plan switched off — and only if every one of them is still the same
 * row (id), with the same owner and key, and still off; and every other-brand row is unchanged. Any difference aborts the
 * whole plan (no partial restore): owner change (Kabumori → other, other → Kabumori), key reassignment or collision,
 * missing row, a row switched back on by hand, a pre-existing-off row now on, an other-brand row changed.
 */
export function planPlannerRestore(plan: Extract<PlannerStopPlan, { action: "proceed" }>, current: readonly SettingRow[]): PlannerRestorePlan {
  const reasons: string[] = [...identityProblems(current)];
  const byId = new Map(current.map((row) => [`${row.table}#${row.id}`, row]));
  const same = (planned: PlannedRow, label: string): SettingRow | null => {
    const row = byId.get(`${planned.table}#${planned.id}`);
    if (!row) {
      reasons.push(`MISSING_ROW:${label}:${planned.table}#${planned.id}`);
      return null;
    }
    if (ownerOf(row) !== planned.owner) reasons.push(`OWNER_CHANGED:${label}:${planned.table}#${planned.id}:${planned.owner}->${ownerOf(row)}`);
    if (row.key !== planned.key) reasons.push(`KEY_CHANGED:${label}:${planned.table}#${planned.id}:${planned.key}->${row.key}`);
    return row;
  };
  for (const planned of plan.changes) {
    const row = same(planned, "change");
    if (row && row.is_active) reasons.push(`STATE_DRIFT:change:${planned.table}#${planned.id}:already_active`);
  }
  for (const planned of plan.preexistingOff) {
    const row = same(planned, "preexisting_off");
    if (row && row.is_active) reasons.push(`STATE_DRIFT:preexisting_off:${planned.table}#${planned.id}:now_active`);
  }
  for (const watched of plan.untouched) {
    const row = same(watched, "other_brand");
    if (row && row.is_active !== watched.is_active) reasons.push(`STATE_DRIFT:other_brand:${watched.table}#${watched.id}`);
  }
  if (reasons.length > 0) return { action: "abort", reasons };
  return { action: "proceed", restore: [...plan.changes] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pending notifications (dispatcher #9 sends any pending row; producers stopped does not mean the queue is empty).
// ---------------------------------------------------------------------------------------------------------------------

export type NotificationRow = { id: string; source_type: string; push_status: "pending" | "processing" | "sent" | "failed" | "skipped" };

/** Every source_type the repo's producers write; all are Kabumori. Anything else is unknown and stops the plan. */
export const KABUMORI_NOTIFICATION_SOURCES = ["important_news", "personalized_report", "personalized_analysis", "market_critical_news"] as const;

export type PushHoldPlan =
  | { action: "none"; reason: "OPERATOR_CHOSE_TO_LET_THEM_SEND" | "QUEUE_EMPTY" }
  | { action: "abort"; reasons: string[] }
  | { action: "skip"; ids: string[]; marker: "KABUMORI_PAUSED" };

/**
 * Never automatic: without an explicit operator decision nothing is changed (the dispatcher sends them). With it, only
 * the approved pending ids, all of known Kabumori sources, are planned to become `skipped` with a marker in
 * push_last_error_code. Aborts on drift, on any approved row no longer pending (processing = in flight to Expo: never
 * touched, never re-sent), and on an unknown source.
 */
export function planPushHold(args: {
  decision: "let_send" | "skip_approved";
  approvedIds: readonly string[];
  snapshot: readonly NotificationRow[];
}): PushHoldPlan {
  const pending = args.snapshot.filter((row) => row.push_status === "pending");
  if (args.decision === "let_send") return { action: "none", reason: "OPERATOR_CHOSE_TO_LET_THEM_SEND" };
  if (pending.length === 0 && args.approvedIds.length === 0) return { action: "none", reason: "QUEUE_EMPTY" };
  const reasons: string[] = [];
  const byId = new Map(args.snapshot.map((row) => [row.id, row]));
  for (const id of args.approvedIds) {
    const row = byId.get(id);
    if (!row) reasons.push(`APPROVED_ROW_MISSING:${id}`);
    else if (row.push_status !== "pending") reasons.push(`APPROVED_ROW_NOT_PENDING:${id}:${row.push_status}`);
  }
  const approved = new Set(args.approvedIds);
  for (const row of pending) {
    if (!approved.has(row.id)) reasons.push(`UNAPPROVED_PENDING:${row.id}`);
    if (!(KABUMORI_NOTIFICATION_SOURCES as readonly string[]).includes(row.source_type)) reasons.push(`UNKNOWN_SOURCE:${row.source_type}`);
  }
  if (reasons.length > 0) return { action: "abort", reasons };
  return { action: "skip", ids: [...args.approvedIds].sort(), marker: "KABUMORI_PAUSED" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Resume readiness: reviewed read-only WHILE Kabumori stays disabled. Restoring the planners is not a licence to resend.
// claim_due_post takes the oldest due pending row with no freshness bound (migrations/20260901044548), so any Kabumori
// pending row left at resume would be posted however old it is (J2 reproduced a 2026-01-01 row being sent).
// ---------------------------------------------------------------------------------------------------------------------

export type ScheduledSnapshotRow = { id: string; brand_id: string | null; status: "pending" | "running" | "succeeded" | "failed" };
export type RunSnapshotRow = { id: string; post_type: string; status: string; has_x_post_id: boolean };

export type ResumeReadiness = { ready: true } | { ready: false; blockers: string[] };

/**
 * Ready only when, read while still paused: no Kabumori row is pending (every one was either failed by the closed gate
 * when due or explicitly reviewed — never bulk reset), none is running (in flight), no run ended with an unknown X
 * outcome (generated but no post id: reconcile against the account's posts first, never replay), and no Kabumori
 * notification is pending or processing (decided per planPushHold). Then a separate approval may reopen the gate.
 */
export function resumeReadiness(args: {
  scheduled: readonly ScheduledSnapshotRow[];
  runs: readonly RunSnapshotRow[];
  notifications: readonly NotificationRow[];
}): ResumeReadiness {
  const blockers: string[] = [];
  const kabumori = args.scheduled.filter((row) => isKabumoriOwner(row));
  const pending = kabumori.filter((row) => row.status === "pending").length;
  const running = kabumori.filter((row) => row.status === "running").length;
  if (pending > 0) blockers.push(`KABUMORI_PENDING_ROWS:${pending}`);
  if (running > 0) blockers.push(`KABUMORI_IN_FLIGHT:${running}`);
  const unknownX = args.runs.filter((run) => run.status === "generated" && !run.has_x_post_id).length;
  if (unknownX > 0) blockers.push(`X_OUTCOME_UNKNOWN_RUNS:${unknownX}`);
  const queued = args.notifications.filter((row) =>
    (KABUMORI_NOTIFICATION_SOURCES as readonly string[]).includes(row.source_type) &&
    (row.push_status === "pending" || row.push_status === "processing")
  ).length;
  if (queued > 0) blockers.push(`KABUMORI_PUSH_QUEUED:${queued}`);
  return blockers.length === 0 ? { ready: true } : { ready: false, blockers };
}
