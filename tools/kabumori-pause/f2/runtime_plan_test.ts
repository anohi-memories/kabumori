// F2 かぶモリ休止: planner の可逆停止・再開、たまった通知、再開の前の審査の合成検証（実 DB・Cron・Push なし）。
//   deno test --no-config --deny-net --deny-env --deny-run --deny-write --allow-read tools/kabumori-pause/f2/runtime_plan_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  type NotificationRow,
  planPlannerRestore,
  planPlannerStop,
  planPushHold,
  resumeReadiness,
  type SettingRow,
} from "./runtime_plan.ts";

const singletons = (active = true): SettingRow[] => [
  { table: "morning_report_settings", id: "true", key: "singleton", brand_id: null, is_active: active },
  { table: "close_report_settings", id: "true", key: "singleton", brand_id: null, is_active: active },
  { table: "us_premarket_report_settings", id: "true", key: "singleton", brand_id: null, is_active: false }, // off before the pause
  { table: "useful_tip_schedule_settings", id: "true", key: "singleton", brand_id: null, is_active: active },
];
const windows = (): SettingRow[] => [
  { table: "posting_windows", id: "w-int1", key: "interaction:1", brand_id: "kabumori", is_active: true },
  { table: "posting_windows", id: "w-tip1", key: "tip:1", brand_id: null, is_active: true }, // legacy row → Kabumori
  { table: "posting_windows", id: "w-tip2", key: "tip:2", brand_id: "kabumori", is_active: false }, // off before the pause
  { table: "posting_windows", id: "w-bp1", key: "brand_post:1", brand_id: "postona_user_a", is_active: true },
];
const KNOWN = ["postona_user_a", "postona_user_b"];

function stopPlan() {
  const plan = planPlannerStop({ read: { ok: true, rows: [...singletons(), ...windows()] }, knownOtherBrands: KNOWN });
  assert.equal(plan.action, "proceed");
  if (plan.action !== "proceed") throw new Error("unreachable");
  return plan;
}

/** The state right after the approved stop: changed rows off, everything else as it was. */
function pausedState(): SettingRow[] {
  const changed = new Set(stopPlan().changes.map((c) => `${c.table}#${c.id}`));
  return [...singletons(), ...windows()].map((row) => changed.has(`${row.table}#${row.id}`) ? { ...row, is_active: false } : row);
}

// ---- stop ------------------------------------------------------------------------------------------------------------

test("stop: only active Kabumori rows (incl. legacy NULL) change; rows already off are left alone; other brands are watched", () => {
  const plan = stopPlan();
  assert.deepEqual(plan.changes.map((c) => `${c.table}#${c.id}:${c.owner}`), [
    "morning_report_settings#true:(legacy)", "close_report_settings#true:(legacy)", "useful_tip_schedule_settings#true:(legacy)",
    "posting_windows#w-int1:kabumori", "posting_windows#w-tip1:(legacy)",
  ]);
  assert.deepEqual(plan.preexistingOff.map((c) => `${c.table}#${c.id}`), ["us_premarket_report_settings#true", "posting_windows#w-tip2"]);
  assert.deepEqual(plan.untouched, [{ table: "posting_windows", id: "w-bp1", key: "brand_post:1", owner: "postona_user_a", is_active: true }]);
});

test("stop aborts: unreadable, singleton missing / duplicated, duplicate id, key collision, unknown brand, unexpected table", () => {
  assert.deepEqual(planPlannerStop({ read: { ok: false }, knownOtherBrands: KNOWN }), { action: "abort", reasons: ["SETTINGS_UNREADABLE"] });
  const missing = planPlannerStop({ read: { ok: true, rows: singletons().slice(1) }, knownOtherBrands: KNOWN });
  assert.deepEqual(missing, { action: "abort", reasons: ["SINGLETON_ROW_COUNT:morning_report_settings:0"] });
  const dupId = planPlannerStop({ read: { ok: true, rows: [...singletons(), ...windows(), { ...windows()[0], key: "interaction:9" }] }, knownOtherBrands: KNOWN });
  assert.ok(dupId.action === "abort" && dupId.reasons.includes("DUPLICATE_ID:posting_windows#w-int1"));
  const collision = planPlannerStop({ read: { ok: true, rows: [...singletons(), ...windows(), { ...windows()[0], id: "w-new" }] }, knownOtherBrands: KNOWN });
  assert.ok(collision.action === "abort" && collision.reasons.includes("KEY_COLLISION:posting_windows:interaction:1"));
  const unknown = planPlannerStop({ read: { ok: true, rows: [...singletons(), ...windows()] }, knownOtherBrands: [] });
  assert.deepEqual(unknown, { action: "abort", reasons: ["UNKNOWN_BRAND_WINDOW:postona_user_a"] });
  const odd = planPlannerStop({ read: { ok: true, rows: [...singletons(), { table: "brands", id: "kabumori", key: "kabumori", brand_id: "kabumori", is_active: true }] }, knownOtherBrands: KNOWN });
  assert.deepEqual(odd, { action: "abort", reasons: ["UNEXPECTED_TABLE:brands"] });
});

// ---- restore (J2-R3) ---------------------------------------------------------------------------------------------------

test("restore: exactly the rows the stop switched off, back on; pre-existing-off rows stay off", () => {
  const restore = planPlannerRestore(stopPlan(), pausedState());
  assert.equal(restore.action, "proceed");
  if (restore.action !== "proceed") return;
  assert.deepEqual(restore.restore.map((r) => `${r.table}#${r.id}`), [
    "morning_report_settings#true", "close_report_settings#true", "useful_tip_schedule_settings#true",
    "posting_windows#w-int1", "posting_windows#w-tip1",
  ]);
});

/** Every adverse case aborts the WHOLE plan: nothing is restored, not even the unaffected rows. */
function assertAbort(current: SettingRow[], expected: string) {
  const restore = planPlannerRestore(stopPlan(), current);
  assert.equal(restore.action, "abort", expected);
  assert.ok(restore.action === "abort" && restore.reasons.some((reason) => reason.startsWith(expected)), `${expected} in ${JSON.stringify(restore)}`);
  assert.equal("restore" in restore, false, "no partial restore");
}

test("restore aborts when a paused Kabumori window now belongs to another brand (J2 reproduction: was drift=[])", () => {
  const current = pausedState().map((row) => row.id === "w-tip1" ? { ...row, brand_id: "postona_user_b" } : row);
  assertAbort(current, "OWNER_CHANGED:change:posting_windows#w-tip1:(legacy)->postona_user_b");
});

test("restore aborts when another brand's watched window now belongs to Kabumori", () => {
  const current = pausedState().map((row) => row.id === "w-bp1" ? { ...row, brand_id: "kabumori" } : row);
  assertAbort(current, "OWNER_CHANGED:other_brand:posting_windows#w-bp1:postona_user_a->kabumori");
});

test("restore aborts on key reassignment and on a key collision with a new row", () => {
  assertAbort(pausedState().map((row) => row.id === "w-int1" ? { ...row, key: "interaction:2" } : row), "KEY_CHANGED:change:posting_windows#w-int1");
  assertAbort([...pausedState(), { table: "posting_windows", id: "w-int1b", key: "interaction:1", brand_id: "postona_user_a", is_active: true }], "KEY_COLLISION:posting_windows:interaction:1");
});

test("restore aborts on a missing row, a row switched back on by hand, a pre-existing-off row now on, an other-brand state change", () => {
  assertAbort(pausedState().filter((row) => row.id !== "w-int1"), "MISSING_ROW:change:posting_windows#w-int1");
  assertAbort(pausedState().map((row) => row.table === "close_report_settings" ? { ...row, is_active: true } : row), "STATE_DRIFT:change:close_report_settings#true");
  assertAbort(pausedState().map((row) => row.id === "w-tip2" ? { ...row, is_active: true } : row), "STATE_DRIFT:preexisting_off:posting_windows#w-tip2");
  assertAbort(pausedState().map((row) => row.id === "w-bp1" ? { ...row, is_active: false } : row), "STATE_DRIFT:other_brand:posting_windows#w-bp1");
});

test("restore never plans a row of another brand, even when all checks pass", () => {
  const restore = planPlannerRestore(stopPlan(), pausedState());
  assert.ok(restore.action === "proceed" && restore.restore.every((row) => row.owner === "kabumori" || row.owner === "(legacy)"));
});

// ---- pending notifications -----------------------------------------------------------------------------------------------

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

test("push aborts: an approved row already in flight, a new pending row, an unknown source, a vanished row", () => {
  assert.deepEqual(planPushHold({ decision: "skip_approved", approvedIds: ["n1", "n2", "n3"], snapshot: queue }), { action: "abort", reasons: ["APPROVED_ROW_NOT_PENDING:n3:processing"] });
  assert.deepEqual(planPushHold({ decision: "skip_approved", approvedIds: ["n1"], snapshot: queue }), { action: "abort", reasons: ["UNAPPROVED_PENDING:n2"] });
  const foreign = planPushHold({ decision: "skip_approved", approvedIds: ["n1", "n2", "x9"], snapshot: [...queue, { id: "x9", source_type: "postona_reminder", push_status: "pending" }] });
  assert.deepEqual(foreign, { action: "abort", reasons: ["UNKNOWN_SOURCE:postona_reminder"] });
  assert.deepEqual(planPushHold({ decision: "skip_approved", approvedIds: ["n1", "n2", "n9"], snapshot: queue }), { action: "abort", reasons: ["APPROVED_ROW_MISSING:n9"] });
});

// ---- resume readiness (read-only, while still paused) ----------------------------------------------------------------

test("resume readiness: an old pending Kabumori row (J2's 2026-01-01 tip), in-flight, X-unknown runs and queued pushes each block", () => {
  const blocked = resumeReadiness({
    scheduled: [
      { id: "s1", brand_id: null, status: "pending" }, // old legacy row: would be posted on resume however old
      { id: "s2", brand_id: "kabumori", status: "running" },
      { id: "s3", brand_id: "kabumori", status: "failed" },
      { id: "s4", brand_id: "postona_user_a", status: "pending" }, // another brand's queue is not Kabumori's to judge
    ],
    runs: [{ id: "r1", post_type: "useful_tip", status: "generated", has_x_post_id: false }, { id: "r2", post_type: "useful_tip", status: "succeeded", has_x_post_id: true }],
    notifications: [...queue, { id: "x9", source_type: "postona_reminder", push_status: "pending" }],
  });
  assert.deepEqual(blocked, { ready: false, blockers: ["KABUMORI_PENDING_ROWS:1", "KABUMORI_IN_FLIGHT:1", "X_OUTCOME_UNKNOWN_RUNS:1", "KABUMORI_PUSH_QUEUED:3"] });
  const ready = resumeReadiness({
    scheduled: [{ id: "s3", brand_id: "kabumori", status: "failed" }, { id: "s4", brand_id: "postona_user_a", status: "pending" }],
    runs: [{ id: "r2", post_type: "useful_tip", status: "succeeded", has_x_post_id: true }],
    notifications: [{ id: "n4", source_type: "important_news", push_status: "sent" }, { id: "n5", source_type: "important_news", push_status: "skipped" }],
  });
  assert.deepEqual(ready, { ready: true });
});
