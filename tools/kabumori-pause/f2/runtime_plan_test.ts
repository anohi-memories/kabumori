// F2 かぶモリ休止: planner の可逆停止と、たまった通知の計画の合成検証（実 DB・Cron・Push なし）。
//   deno test --no-config --deny-net --deny-env --deny-run --deny-write --allow-read tools/kabumori-pause/f2/runtime_plan_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { type NotificationRow, planPlannerRestore, planPlannerStop, planPushHold, type SettingRow } from "./runtime_plan.ts";

const singletons = (active = true): SettingRow[] => [
  { table: "morning_report_settings", key: "true", brand_id: null, is_active: active },
  { table: "close_report_settings", key: "true", brand_id: null, is_active: active },
  { table: "us_premarket_report_settings", key: "true", brand_id: null, is_active: false }, // already off before the pause
  { table: "useful_tip_schedule_settings", key: "true", brand_id: null, is_active: active },
];
const windows: SettingRow[] = [
  { table: "posting_windows", key: "interaction:1", brand_id: "kabumori", is_active: true },
  { table: "posting_windows", key: "tip:1", brand_id: null, is_active: true }, // legacy row → Kabumori
  { table: "posting_windows", key: "brand_post:1", brand_id: "postona_user_a", is_active: true },
];

test("planner stop: only Kabumori settings and Kabumori / NULL windows change; other brands' windows are left as they are", () => {
  const plan = planPlannerStop({ read: { ok: true, rows: [...singletons(), ...windows] }, knownOtherBrands: ["postona_user_a"] });
  assert.equal(plan.action, "proceed");
  if (plan.action !== "proceed") return;
  assert.deepEqual(plan.changes.map((c) => `${c.table}:${c.key}:${c.restore}`), [
    "morning_report_settings:true:true", "close_report_settings:true:true", "us_premarket_report_settings:true:false",
    "useful_tip_schedule_settings:true:true", "posting_windows:interaction:1:true", "posting_windows:tip:1:true",
  ]);
  assert.deepEqual(plan.untouched, [{ table: "posting_windows", key: "brand_post:1", brand_id: "postona_user_a", is_active: true }]);
});

test("planner stop aborts: unreadable settings, a missing / duplicated singleton, an unknown brand window, an unexpected table", () => {
  assert.deepEqual(planPlannerStop({ read: { ok: false }, knownOtherBrands: [] }), { action: "abort", reasons: ["SETTINGS_UNREADABLE"] });
  const missing = planPlannerStop({ read: { ok: true, rows: singletons().slice(1) }, knownOtherBrands: [] });
  assert.deepEqual(missing, { action: "abort", reasons: ["SINGLETON_ROW_COUNT:morning_report_settings:0"] });
  const dup = planPlannerStop({ read: { ok: true, rows: [...singletons(), singletons()[1]] }, knownOtherBrands: [] });
  assert.deepEqual(dup, { action: "abort", reasons: ["SINGLETON_ROW_COUNT:close_report_settings:2"] });
  const unknown = planPlannerStop({ read: { ok: true, rows: [...singletons(), ...windows] }, knownOtherBrands: [] });
  assert.deepEqual(unknown, { action: "abort", reasons: ["UNKNOWN_BRAND_WINDOW:postona_user_a"] });
  const odd = planPlannerStop({ read: { ok: true, rows: [...singletons(), { table: "brands", key: "kabumori", brand_id: "kabumori", is_active: true }] }, knownOtherBrands: [] });
  assert.deepEqual(odd, { action: "abort", reasons: ["UNEXPECTED_TABLE:brands"] });
});

test("planner restore: back to the snapshot values only (a setting that was already off stays off); drift is reported", () => {
  const plan = planPlannerStop({ read: { ok: true, rows: [...singletons(), ...windows] }, knownOtherBrands: ["postona_user_a"] });
  assert.equal(plan.action, "proceed");
  if (plan.action !== "proceed") return;
  const paused: SettingRow[] = [...singletons(false), ...windows.map((w) => w.brand_id === "postona_user_a" ? w : { ...w, is_active: false })];
  const restore = planPlannerRestore(plan, paused);
  assert.deepEqual(restore.drift, []);
  assert.deepEqual(restore.restore.map((r) => `${r.table}:${r.key}`), [
    "morning_report_settings:true", "close_report_settings:true", "useful_tip_schedule_settings:true",
    "posting_windows:interaction:1", "posting_windows:tip:1",
  ], "us_premarket was off before the pause and stays off");
  // Someone switched a Kabumori setting back on by hand, and another brand's window changed: both are drift.
  const touched = paused.map((row) =>
    row.table === "morning_report_settings" ? { ...row, is_active: true } : row.brand_id === "postona_user_a" ? { ...row, is_active: false } : row
  );
  assert.deepEqual(planPlannerRestore(plan, touched).drift, ["ALREADY_ACTIVE:morning_report_settings:true", "OTHER_BRAND_CHANGED:postona_user_a:brand_post:1"]);
});

const queue: NotificationRow[] = [
  { id: "n1", source_type: "important_news", push_status: "pending" },
  { id: "n2", source_type: "personalized_analysis", push_status: "pending" },
  { id: "n3", source_type: "important_news", push_status: "processing" },
  { id: "n4", source_type: "important_news", push_status: "sent" },
];

test("push: nothing is skipped without an explicit decision; letting them send changes nothing", () => {
  assert.deepEqual(planPushHold({ decision: "let_send", approvedIds: ["n1", "n2"], snapshot: queue }), { action: "none", reason: "OPERATOR_CHOSE_TO_LET_THEM_SEND" });
  assert.deepEqual(planPushHold({ decision: "skip_approved", approvedIds: [], snapshot: [] }), { action: "none", reason: "QUEUE_EMPTY" });
});

test("push: skips exactly the approved pending ids with a marker; processing (in flight) is never touched", () => {
  assert.deepEqual(planPushHold({ decision: "skip_approved", approvedIds: ["n2", "n1"], snapshot: queue }), { action: "skip", ids: ["n1", "n2"], marker: "KABUMORI_PAUSED" });
});

test("push aborts: an approved row already in flight or sent, a new pending row, an unknown source", () => {
  const inFlight = planPushHold({ decision: "skip_approved", approvedIds: ["n1", "n2", "n3"], snapshot: queue });
  assert.deepEqual(inFlight, { action: "abort", reasons: ["APPROVED_ROW_NOT_PENDING:n3:processing"] });
  const added = planPushHold({ decision: "skip_approved", approvedIds: ["n1"], snapshot: queue });
  assert.deepEqual(added, { action: "abort", reasons: ["UNAPPROVED_PENDING:n2"] });
  const foreign = planPushHold({
    decision: "skip_approved",
    approvedIds: ["n1", "n2", "x9"],
    snapshot: [...queue, { id: "x9", source_type: "postona_reminder", push_status: "pending" }],
  });
  assert.deepEqual(foreign, { action: "abort", reasons: ["UNKNOWN_SOURCE:postona_reminder"] });
  const gone = planPushHold({ decision: "skip_approved", approvedIds: ["n1", "n2", "n9"], snapshot: queue });
  assert.deepEqual(gone, { action: "abort", reasons: ["APPROVED_ROW_MISSING:n9"] });
});
