// F2 かぶモリ休止: 合成データだけのオフライン検証。実 HTTP・DB・SDK・SNS・Push・課金なし。
//   deno test --no-config --deny-net --deny-env --deny-run --deny-write --allow-read tools/kabumori-pause/f2/pause_model_test.ts
// これはモデルの検証で、本番の runtime や配備版の挙動の証明ではない。
import assert from "node:assert/strict";
import test from "node:test";
import {
  type Brand,
  type BrandTable,
  DESIGN_STOP_ORDER,
  dispatcherTick,
  guardCode,
  marketReportPath,
  planHold,
  planResume,
  pushInFlight,
  pushStillSent,
  type PushRow,
  resolveBrandId,
  type ScheduledRow,
  simulate,
  stopOrderViolations,
  type World,
} from "./pause_model.ts";

// ---- synthetic fixtures (no real ids, counts or accounts) ------------------------------------------------------------

const live = (id: string): Brand => ({ id, is_active: true, publish_mode: "live", x_publish_enabled: true });
const KABUMORI_PAUSED: Brand = { id: "kabumori", is_active: true, publish_mode: "disabled", x_publish_enabled: true };
const brands = (...list: Brand[]): BrandTable => ({ ok: true, brands: list });

let seq = 0;
const row = (brand_id: string | null, post_type: string, scheduled_for: number, status: ScheduledRow["status"] = "pending"): ScheduledRow =>
  ({ id: `r${String(++seq).padStart(3, "0")}`, brand_id, post_type, scheduled_for, status, attempt_count: 0 });

/** The handover shape: kabumori tips ×4 + interaction ×1 (synthetic), mixed with other brands' brand posts. */
function mixedQueue(): ScheduledRow[] {
  seq = 0;
  return [
    row("kabumori", "useful_tip", 0),
    row(null, "useful_tip", 1), // pre-Phase-2 row: NULL brand resolves to kabumori
    row("kabumori", "useful_tip", 2),
    row("kabumori", "useful_tip", 3),
    row("kabumori", "interaction", 4),
    row("postona_user_a", "brand_post", 0),
    row("ai_salaryman_lab", "brand_post", 2),
    row("postona_user_b", "brand_post", 5),
  ];
}

// ---- brand resolution and the guard ---------------------------------------------------------------------------------

test("brand resolution: NULL / empty brand is kabumori; other ids are themselves", () => {
  assert.equal(resolveBrandId({ brand_id: null }), "kabumori");
  assert.equal(resolveBrandId({ brand_id: "" }), "kabumori");
  assert.equal(resolveBrandId({ brand_id: "postona_user_a" }), "postona_user_a");
});

test("guard: live sends; disabled / dry_run / inactive / account off / unknown brand / unreadable table never send", () => {
  const table = brands(live("postona_user_a"), KABUMORI_PAUSED);
  assert.equal(guardCode(table, "postona_user_a"), null);
  assert.equal(guardCode(table, "kabumori"), "BRAND_PUBLISH_MODE_DISABLED");
  assert.equal(guardCode(brands({ ...live("kabumori"), publish_mode: "dry_run" }), "kabumori"), "BRAND_PUBLISH_MODE_DRY_RUN");
  assert.equal(guardCode(brands({ ...live("kabumori"), is_active: false }), "kabumori"), "BRAND_DISABLED");
  assert.equal(guardCode(brands({ ...live("kabumori"), x_publish_enabled: false }), "kabumori"), "BRAND_X_ACCOUNT_DISABLED");
  assert.equal(guardCode(table, "no_such_brand"), "BRAND_NOT_FOUND", "an invalid brand is fail closed");
  assert.equal(guardCode({ ok: false }, "postona_user_a"), "BRAND_CONTEXT_UNAVAILABLE", "a read failure is fail closed for every brand");
});

// ---- shared dispatcher #1: kabumori blocked, other brands continue --------------------------------------------------

test("dispatcher: with kabumori disabled, every kabumori row (incl. NULL brand) fails at the guard and other brands still send", () => {
  const world: World = { rows: mixedQueue(), brands: brands(KABUMORI_PAUSED, live("postona_user_a"), live("postona_user_b"), live("ai_salaryman_lab")), xEnabled: true, sharedCompleted: true };
  const events = simulate(world, 0, 30);
  const kab = events.filter((e) => e.brandId === "kabumori");
  const others = events.filter((e) => e.brandId !== "kabumori");
  assert.equal(kab.length, 5);
  assert.ok(kab.every((e) => e.outcome === "failed_by_guard" && e.code === "BRAND_PUBLISH_MODE_DISABLED" && !e.aiCall), "no X send and no model call");
  assert.deepEqual(others.map((e) => [e.brandId, e.outcome]), [["postona_user_a", "sent"], ["ai_salaryman_lab", "sent"], ["postona_user_b", "sent"]]);
  // No starvation: each blocked row costs one tick, so another brand waits at most the number of blocked rows due before it.
  const maxDelay = Math.max(...others.map((e) => e.delay));
  assert.ok(maxDelay <= 5, `other brands' delay ${maxDelay} minutes`);
  // Blocked rows are terminal (failed), so they are never claimed again: no head-of-queue loop.
  assert.equal(world.rows.filter((r) => r.status === "pending").length, 0);
  assert.equal(new Set(events.map((e) => e.rowId)).size, events.length, "each row claimed once");
});

test("dispatcher: a brand table read failure blocks every brand (fail closed) — the pause must not depend on it", () => {
  const world: World = { rows: mixedQueue(), brands: { ok: false }, xEnabled: true, sharedCompleted: true };
  const events = simulate(world, 0, 30);
  assert.ok(events.every((e) => e.outcome === "failed_by_guard" && e.code === "BRAND_CONTEXT_UNAVAILABLE"));
});

test("dispatcher: rows added during the pause (planners still running) are also failed by the guard, one tick each", () => {
  const world: World = { rows: mixedQueue(), brands: brands(KABUMORI_PAUSED, live("postona_user_a"), live("postona_user_b"), live("ai_salaryman_lab")), xEnabled: true, sharedCompleted: true };
  simulate(world, 0, 10);
  world.rows.push(row("kabumori", "useful_tip", 20), row("postona_user_a", "brand_post", 20));
  const later = simulate(world, 11, 30);
  assert.deepEqual(later.map((e) => [e.brandId, e.outcome]), [["kabumori", "failed_by_guard"], ["postona_user_a", "sent"]]);
});

test("dispatcher: kabumori live again (resume) sends only rows still pending; failed rows are not re-run", () => {
  const world: World = { rows: mixedQueue(), brands: brands(KABUMORI_PAUSED, live("postona_user_a"), live("postona_user_b"), live("ai_salaryman_lab")), xEnabled: true, sharedCompleted: true };
  simulate(world, 0, 10);
  world.brands = brands(live("kabumori"), live("postona_user_a"), live("postona_user_b"), live("ai_salaryman_lab"));
  assert.deepEqual(simulate(world, 11, 30), [], "nothing old is posted in bulk on resume");
});

// ---- market report consumer fallback --------------------------------------------------------------------------------

test("market report: x_enabled=false with the brand still live restarts the legacy AI generator; the brand guard blocks it first", () => {
  assert.equal(marketReportPath({ guard: null, xEnabled: false, sharedCompleted: true }), "legacy_ai_generation_and_post");
  assert.equal(marketReportPath({ guard: "BRAND_PUBLISH_MODE_DISABLED", xEnabled: false, sharedCompleted: true }), "blocked_by_brand");
  assert.equal(marketReportPath({ guard: "BRAND_PUBLISH_MODE_DISABLED", xEnabled: true, sharedCompleted: false }), "blocked_by_brand");
  assert.equal(marketReportPath({ guard: null, xEnabled: true, sharedCompleted: false }), "shared_report_unavailable_fail");
  // Through the dispatcher: a live kabumori with x_enabled=false makes a model call; paused kabumori makes none.
  seq = 100;
  const liveWorld: World = { rows: [row("kabumori", "close_report", 0)], brands: brands(live("kabumori")), xEnabled: false, sharedCompleted: true };
  assert.equal(dispatcherTick(liveWorld, 0)?.aiCall, true);
  const pausedWorld: World = { rows: [row("kabumori", "close_report", 0)], brands: brands(KABUMORI_PAUSED), xEnabled: false, sharedCompleted: true };
  assert.deepEqual([dispatcherTick(pausedWorld, 0)?.outcome, dispatcherTick(pausedWorld, 1)], ["failed_by_guard", null]);
});

// ---- hold plan: snapshot, drift, in-flight, other brands ------------------------------------------------------------

function snapshotAfterBlock() {
  return { rows: mixedQueue(), brands: brands(KABUMORI_PAUSED, live("postona_user_a"), live("postona_user_b"), live("ai_salaryman_lab")) };
}
const APPROVED = { approvedPendingIds: ["r001", "r002", "r003", "r004", "r005"], otherBrandPending: { postona_user_a: 1, ai_salaryman_lab: 1, postona_user_b: 1 } };

test("hold: proceeds on the approved snapshot (5 kabumori incl. the NULL-brand row), other brands read back unchanged", () => {
  const decision = planHold(snapshotAfterBlock(), APPROVED);
  assert.equal(decision.action, "proceed");
  if (decision.action !== "proceed") return;
  assert.deepEqual(decision.targetIds, ["r001", "r002", "r003", "r004", "r005"]);
  assert.deepEqual(decision.readBack.otherBrandPending, { postona_user_a: 1, ai_salaryman_lab: 1, postona_user_b: 1 });
});

test("hold: aborts while the kabumori guard is still open (block X first)", () => {
  const snap = snapshotAfterBlock();
  const decision = planHold({ ...snap, brands: brands(live("kabumori"), live("postona_user_a"), live("postona_user_b"), live("ai_salaryman_lab")) }, APPROVED);
  assert.deepEqual(decision, { action: "abort", reasons: ["KABUMORI_GUARD_STILL_OPEN"] });
});

test("hold: aborts on an unreadable brand table", () => {
  assert.deepEqual(planHold({ rows: mixedQueue(), brands: { ok: false } }, APPROVED), { action: "abort", reasons: ["BRAND_TABLE_UNREADABLE"] });
});

test("hold: aborts when a kabumori row is in flight (claimed by a worker), and when the set drifted (added / claimed / removed)", () => {
  const inFlight = snapshotAfterBlock();
  inFlight.rows[0].status = "running"; // a worker claimed it after the snapshot was approved
  const decision = planHold(inFlight, APPROVED);
  assert.equal(decision.action, "abort");
  assert.ok(decision.action === "abort" && decision.reasons.includes("KABUMORI_IN_FLIGHT"));
  assert.ok(decision.action === "abort" && decision.reasons.includes("KABUMORI_PENDING_DRIFT:5->4"));

  const added = snapshotAfterBlock();
  added.rows.push(row("kabumori", "useful_tip", 9));
  assert.deepEqual(planHold(added, APPROVED), { action: "abort", reasons: ["KABUMORI_PENDING_DRIFT:5->6"] });

  const swapped = snapshotAfterBlock();
  swapped.rows[4] = { ...swapped.rows[4], id: "r999" }; // same count, different row
  assert.deepEqual(planHold(swapped, APPROVED), { action: "abort", reasons: ["KABUMORI_PENDING_DRIFT:5->5"] });
});

test("hold: a concurrent change to another brand's queue aborts (watch it, never touch it)", () => {
  const snap = snapshotAfterBlock();
  snap.rows.push(row("postona_user_a", "brand_post", 7));
  assert.deepEqual(planHold(snap, APPROVED), { action: "abort", reasons: ["OTHER_BRAND_PENDING_CHANGED:postona_user_a"] });
});

test("hold: repeating the same decision on an unchanged snapshot is stable (idempotent); after a partial run it aborts and re-snapshots", () => {
  const a = planHold(snapshotAfterBlock(), APPROVED);
  const b = planHold(snapshotAfterBlock(), APPROVED);
  assert.deepEqual(a, b);
  // Partial: two kabumori rows already failed by the guard since the snapshot -> the approved set no longer matches.
  const partial = snapshotAfterBlock();
  partial.rows[0].status = "failed";
  partial.rows[1].status = "failed";
  const decision = planHold(partial, APPROVED);
  assert.deepEqual(decision, { action: "abort", reasons: ["KABUMORI_PENDING_DRIFT:5->3"] });
});

// ---- push queue --------------------------------------------------------------------------------------------------------

test("push: stopping producers leaves pending rows that dispatcher #9 still sends; processing rows are in flight", () => {
  const queue: PushRow[] = [
    { id: "n1", source_type: "important_news", push_status: "pending", created_at: 0 },
    { id: "n2", source_type: "personalized_analysis", push_status: "pending", created_at: 1 },
    { id: "n3", source_type: "important_news", push_status: "processing", created_at: 2 },
    { id: "n4", source_type: "important_news", push_status: "sent", created_at: 3 },
  ];
  assert.deepEqual(pushStillSent(queue), ["n1", "n2"], "producer stop alone is not a full stop");
  assert.deepEqual(pushInFlight(queue), ["n3"]);
});

// ---- resume ------------------------------------------------------------------------------------------------------------

test("resume: nothing is sent automatically; old backlog expires, recent items need re-review", () => {
  const plan = planResume([
    { id: "post-old", kind: "scheduled_post", created_at: 0 },
    { id: "news-old", kind: "news_ready", created_at: 10 },
    { id: "news-recent", kind: "news_ready", created_at: 990 },
  ], 1000, 60);
  assert.deepEqual(plan, { autoSend: [], reReview: ["news-recent"], expire: ["post-old", "news-old"] });
});

// ---- stop order ----------------------------------------------------------------------------------------------------------

test("stop order: the design order has no violations; forbidden or out-of-order steps are named", () => {
  assert.deepEqual(stopOrderViolations(DESIGN_STOP_ORDER), []);
  assert.deepEqual(stopOrderViolations(["snapshot", "set_x_enabled_false"]), ["FORBIDDEN:set_x_enabled_false"]);
  for (const step of ["stop_dispatcher_1", "stop_dispatcher_9", "delete_api_keys", "rotate_shared_cron_secret", "set_app_enabled_false"] as const) {
    assert.ok(stopOrderViolations([step]).includes(`FORBIDDEN:${step}`), step);
  }
  assert.ok(stopOrderViolations(["snapshot", "hold_scheduled_posts", "block_kabumori_x", "confirm_x_in_flight_drained"]).includes("ORDER:confirm_x_in_flight_drained<hold_scheduled_posts"));
  assert.ok(stopOrderViolations(["snapshot", "block_kabumori_x", "stop_broadcast_enqueue", "stop_broadcast_sending"]).includes("ORDER:stop_broadcast_sending<stop_broadcast_enqueue"));
  assert.ok(stopOrderViolations(["snapshot", "block_kabumori_x", "decide_push_queue"]).includes("ORDER:f8_news_gate_closed<decide_push_queue"), "news gate first");
});
