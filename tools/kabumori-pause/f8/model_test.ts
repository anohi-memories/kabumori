import assert from "node:assert/strict";
import test from "node:test";
import {
  allRequests, baseWorld, BASELINE, ENTRY_ONLY, FULL_GATE, handle, KNOWN_MODES, OUTWARD, outwardTotal,
  type ActiveValue, type Gate, type World,
} from "./model.ts";

const NOT_RUNNING: Array<{ name: string; world: World }> = [
  { name: "is_active=false", world: baseWorld({ isActive: false }) },
  { name: "is_active missing", world: baseWorld({ isActive: undefined }) },
  { name: "is_active malformed ('true')", world: baseWorld({ isActive: "true" as ActiveValue }) },
  { name: "is_active malformed (1)", world: baseWorld({ isActive: 1 as ActiveValue }) },
  { name: "is_active null", world: baseWorld({ isActive: null }) },
  { name: "settings read fails", world: baseWorld({ settingsReadFails: true }) },
];

test("baseline (today's code): a paused setting does NOT stop most paths — the bypasses are real", () => {
  const paused = baseWorld({ isActive: false });
  const bypass = allRequests().filter(({ req }) => outwardTotal(handle(req, paused, BASELINE)) > 0).map(({ name }) => name);
  // every AI mode, the independent X publish, the generation path and any manual collection are reachable
  for (const must of ["judge_pending", "generate_ready", "publish_ready", "judgement_dry_run", "generation_dry_run", "app_copy_dry_run",
    "collect:manual+fetchSources", "unknown_mode+fetchSources", "unpdf_edge_verification"]) {
    assert.ok(bypass.includes(must), `${must} should be reachable while paused in the baseline`);
  }
  // only the scheduled collection branch honours is_active (and it writes a skipped_inactive run row)
  assert.deepEqual(handle({ trigger: "scheduled", fetchSources: true }, paused, BASELINE).ai, 0);
});

test("baseline: luna_enabled=false already stops judge_pending's AI, and nothing else (generation / app copy / X are not covered)", () => {
  const world = baseWorld({ isActive: false, lunaEnabled: false });
  assert.equal(handle({ mode: "judge_pending" }, world, BASELINE).ai, 0);
  assert.ok(handle({ mode: "generate_ready" }, world, BASELINE).ai > 0);
  assert.equal(handle({ mode: "publish_ready" }, world, BASELINE).x_post, 1);
});

test("baseline: an empty generate_ready still runs app-copy AI and enqueues notifications", () => {
  const c = handle({ mode: "generate_ready" }, baseWorld({ isActive: false, readyForGeneration: 0, appCopyTargets: 3 }), BASELINE);
  assert.equal(c.ai, 3);
  assert.equal(c.push_enqueue, 1);
});

test("full gate: every request shape x every non-running state performs ZERO outward effects", () => {
  for (const { name: state, world } of NOT_RUNNING) {
    for (const { name, req } of allRequests()) {
      const c = handle(req, world, FULL_GATE);
      assert.equal(outwardTotal(c), 0, `${name} under ${state}: ${JSON.stringify(c)}`);
      assert.ok(c.db_read <= 1, `${name} under ${state}: only the single settings read is allowed, got ${c.db_read}`);
      assert.ok([...c.touched].every((resource) => resource === "news_settings"), `${name}: touched ${[...c.touched]}`);
    }
  }
});

test("entry gate alone is enough for a paused-from-the-start state (no in-flight)", () => {
  for (const { world } of NOT_RUNNING) {
    for (const { req } of allRequests()) assert.equal(outwardTotal(handle(req, world, ENTRY_ONLY)), 0);
  }
});

test("running state: the gate does not change what a normal request does", () => {
  const running = baseWorld();
  for (const { name, req } of allRequests()) {
    const a = handle(req, running, BASELINE);
    const b = handle(req, running, FULL_GATE);
    for (const kind of OUTWARD) assert.equal(b[kind], a[kind], `${name}: ${kind} differs between baseline and gate when running`);
  }
  assert.ok(handle({ mode: "judge_pending" }, running, FULL_GATE).ai > 0, "judge_pending still reaches AI when running");
  assert.equal(handle({ mode: "publish_ready" }, running, FULL_GATE).x_post, 1);
});

test("body fields (is_active / force / dry_run / trigger / mode case) cannot unlock a paused handler", () => {
  const paused = baseWorld({ isActive: false });
  for (const req of [
    { mode: "judge_pending", extra: { is_active: true } },
    { mode: "generate_ready", extra: { force: true, bypass_pause: true } },
    { mode: "publish_ready", trigger: "manual", extra: { auto_publish: true } },
    { mode: "judgement_dry_run", extra: { dry_run: false } },
    { fetchSources: true, trigger: "manual" },
    { mode: "JUDGE_PENDING", fetchSources: true },
  ]) assert.equal(outwardTotal(handle(req, paused, FULL_GATE)), 0, JSON.stringify(req));
});

test("manual trigger bypass of the scheduled-only check is closed: omitted trigger, any mode, same result as scheduled", () => {
  const paused = baseWorld({ isActive: false });
  assert.ok(outwardTotal(handle({ fetchSources: true }, paused, BASELINE)) > 0);
  assert.equal(outwardTotal(handle({ fetchSources: true }, paused, FULL_GATE)), 0);
});

test("retries: repeated cron / HTTP retries while paused add no AI, X, push or write", () => {
  const paused = baseWorld({ isActive: false });
  const total = { ai: 0, x_post: 0, push_enqueue: 0, db_write: 0, db_claim: 0, http_external: 0 };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    for (const { req } of allRequests()) {
      const c = handle(req, paused, FULL_GATE);
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += c[key];
    }
  }
  assert.deepEqual(total, { ai: 0, x_post: 0, push_enqueue: 0, db_write: 0, db_claim: 0, http_external: 0 });
});

test("in-flight: a pause flipped mid-request is honoured only with per-effect rechecks", () => {
  const flipAfter = (n: number): World => baseWorld({ flip: { afterOutward: n, to: false } });
  for (const mode of ["generate_ready", "judge_pending"]) {
    const noRecheck = handle({ mode }, flipAfter(1), ENTRY_ONLY);
    const rechecked = handle({ mode }, flipAfter(1), FULL_GATE);
    assert.ok(outwardTotal(noRecheck) > outwardTotal(rechecked), `${mode}: entry-only keeps working after the flip`);
    // exactly the effects performed before the flip remain (bounded), everything later is refused
    assert.equal(rechecked.status, "paused_recheck");
    assert.ok(outwardTotal(rechecked) <= 2, `${mode}: ${outwardTotal(rechecked)} outward effects after a flip at 1`);
  }
  // flip before the X post: the post is not made
  const x = handle({ mode: "publish_ready" }, baseWorld({ flip: { afterOutward: 0, to: false } }), FULL_GATE);
  assert.equal(x.x_post, 0);
  assert.equal(x.push_enqueue, 0);
});

test("a gate read failure mid-request refuses the effect (fail closed)", () => {
  // modelled by an unreadable setting from the start: covered above; here the entry read itself fails
  const c = handle({ mode: "judge_pending" }, baseWorld({ settingsReadFails: true }), FULL_GATE);
  assert.equal(c.status, "paused_read_failed");
  assert.equal(outwardTotal(c), 0);
});

test("scope: the gate only touches the news settings row; shared platform resources are never read or written by the gate", () => {
  const c = handle({ mode: "judge_pending" }, baseWorld({ isActive: false }), FULL_GATE);
  assert.deepEqual([...c.touched], ["news_settings"]);
  for (const forbidden of ["common_ai_provider", "ai_provider_ledger", "postona", "x_test_post", "brand_guard", "mic"]) {
    for (const { req } of allRequests()) {
      for (const { world } of NOT_RUNNING) assert.equal(handle(req, world, FULL_GATE).touched.has(forbidden), false);
    }
  }
});

// ----------------------------- negative controls: the checks above must FAIL when the design is weakened -----------------------------

function violations(gate: Gate): string[] {
  const out: string[] = [];
  for (const { name: state, world } of NOT_RUNNING) {
    for (const { name, req } of allRequests()) {
      const c = handle(req, world, gate);
      if (outwardTotal(c) > 0) out.push(`${name} under ${state}`);
    }
  }
  return out;
}

test("negative control: removing the entry gate is detected", () => {
  assert.ok(violations({ entry: "none", recheck: false }).length > 0);
});

test("negative control: gating only the scheduled collection branch (today) is detected", () => {
  assert.ok(violations(BASELINE).length > 0);
});

test("negative control: a gate that skips dry-run modes is detected (dry runs spend AI)", () => {
  const v = violations({ entry: "non-dry", recheck: false });
  assert.ok(v.some((entry) => entry.startsWith("judgement_dry_run") || entry.startsWith("generation_dry_run") || entry.startsWith("app_copy_dry_run")));
});

test("negative control: exempting the empty-candidate app-copy path (generate_ready) is detected", () => {
  const v = violations({ entry: "all", recheck: false, bypassModes: ["generate_ready"] });
  assert.ok(v.some((entry) => entry.startsWith("generate_ready")));
});

test("negative control: exempting the direct X publish path is detected", () => {
  const v = violations({ entry: "all", recheck: false, bypassModes: ["publish_ready"] });
  assert.ok(v.some((entry) => entry.startsWith("publish_ready")));
});

test("negative control: removing the pre-send re-check lets an in-flight X post through", () => {
  const world = baseWorld({ flip: { afterOutward: 0, to: false } });
  assert.equal(handle({ mode: "publish_ready" }, world, { entry: "all", recheck: true, recheckX: false }).x_post, 1);
  assert.equal(handle({ mode: "publish_ready" }, world, FULL_GATE).x_post, 0);
});

test("negative control: removing the per-effect re-check leaves AI calls running after the flip", () => {
  const world = baseWorld({ flip: { afterOutward: 1, to: false } });
  assert.ok(handle({ mode: "judge_pending" }, world, ENTRY_ONLY).ai > handle({ mode: "judge_pending" }, world, FULL_GATE).ai);
});

test("all known modes are covered by the request table", () => {
  const names = new Set(allRequests().map(({ name }) => name));
  for (const mode of KNOWN_MODES) assert.ok(names.has(mode), mode);
});
