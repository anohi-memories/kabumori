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

export type SettingRow = { table: string; key: string; brand_id: string | null; is_active: boolean };

/** One-row Kabumori-only planner settings (no brand column). */
export const KABUMORI_SINGLETON_SETTINGS = [
  "morning_report_settings",
  "close_report_settings",
  "us_premarket_report_settings",
  "useful_tip_schedule_settings",
] as const;

export type PlannerStopPlan =
  | { action: "abort"; reasons: string[] }
  | {
    action: "proceed";
    /** Rows to set is_active=false, each with the value to restore on resume (the snapshot's own value). */
    changes: Array<{ table: string; key: string; restore: boolean }>;
    /** Rows of other brands: never touched, read back unchanged. */
    untouched: Array<{ table: string; key: string; brand_id: string; is_active: boolean }>;
  };

/**
 * From a fresh snapshot of the planner settings: which rows to switch off (Kabumori only), what to restore, and what
 * must stay unchanged. Aborts (changes nothing) when a setting could not be read, a singleton table is missing or has
 * more than one row, or a posting window has a brand id that is neither kabumori nor NULL nor a known other brand.
 */
export function planPlannerStop(args: {
  read: { ok: true; rows: readonly SettingRow[] } | { ok: false };
  knownOtherBrands: readonly string[];
}): PlannerStopPlan {
  if (!args.read.ok) return { action: "abort", reasons: ["SETTINGS_UNREADABLE"] };
  const rows = args.read.rows;
  const reasons: string[] = [];
  for (const table of KABUMORI_SINGLETON_SETTINGS) {
    const count = rows.filter((row) => row.table === table).length;
    if (count !== 1) reasons.push(`SINGLETON_ROW_COUNT:${table}:${count}`);
  }
  const changes: Array<{ table: string; key: string; restore: boolean }> = [];
  const untouched: Array<{ table: string; key: string; brand_id: string; is_active: boolean }> = [];
  for (const row of rows) {
    if ((KABUMORI_SINGLETON_SETTINGS as readonly string[]).includes(row.table)) {
      changes.push({ table: row.table, key: row.key, restore: row.is_active });
      continue;
    }
    if (row.table !== "posting_windows") {
      reasons.push(`UNEXPECTED_TABLE:${row.table}`);
      continue;
    }
    if (row.brand_id === null || row.brand_id === "" || row.brand_id === "kabumori") {
      changes.push({ table: row.table, key: row.key, restore: row.is_active });
    } else if (args.knownOtherBrands.includes(row.brand_id)) {
      untouched.push({ table: row.table, key: row.key, brand_id: row.brand_id, is_active: row.is_active });
    } else {
      reasons.push(`UNKNOWN_BRAND_WINDOW:${row.brand_id}`);
    }
  }
  if (reasons.length > 0) return { action: "abort", reasons };
  return { action: "proceed", changes, untouched };
}

/** Resume: restore exactly the snapshot values, and only for rows still switched off by the pause. */
export function planPlannerRestore(plan: Extract<PlannerStopPlan, { action: "proceed" }>, current: readonly SettingRow[]): {
  restore: Array<{ table: string; key: string; to: boolean }>;
  drift: string[];
} {
  const restore: Array<{ table: string; key: string; to: boolean }> = [];
  const drift: string[] = [];
  for (const change of plan.changes) {
    const row = current.find((item) => item.table === change.table && item.key === change.key);
    if (!row) drift.push(`MISSING:${change.table}:${change.key}`);
    else if (row.is_active) drift.push(`ALREADY_ACTIVE:${change.table}:${change.key}`);
    else if (change.restore) restore.push({ table: change.table, key: change.key, to: true });
  }
  for (const other of plan.untouched) {
    const row = current.find((item) => item.table === other.table && item.key === other.key);
    if (!row || row.is_active !== other.is_active) drift.push(`OTHER_BRAND_CHANGED:${other.brand_id}:${other.key}`);
  }
  return { restore, drift };
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
