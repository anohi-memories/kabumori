import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, digest, fields, SLOTS, type Snapshot } from "./model.ts";
const now = Date.parse("2026-10-26T00:00:00Z");
function snap(status = "ready"): Snapshot {
  return {
    slot: "H1",
    issue: {
      number: 306,
      body: `# TASK\n- task_id: test-task\n- slot: H1\n- status: ${status}\n- next_owner: codex\n`,
      comments: 0,
      updated_at: new Date(now).toISOString(),
      state: "open",
    },
    comments: [],
    complete: true,
    observed_at: new Date(now).toISOString(),
  };
}
function add(s: Snapshot, type: string, extras = "", offset = -10000) {
  const id = s.comments.length + 1, time = new Date(now + offset).toISOString();
  s.comments.push({
    id,
    body: `type: ${type}\ntask_id: test-task\nslot: H1\nrun_id: run-a\ntask_sha256: ${
      digest(s.issue.body)
    }\nstarted_at: ${time}\nheartbeat_at: ${time}\n${extras}`,
    created_at: time,
    updated_at: time,
  });
  s.issue.comments++;
  return id;
}
const state = (s: Snapshot) => classify(s, now).state;
test("raw ready/in_progress/done never prove activity or acceptance", () => {
  for (const v of ["ready", "in_progress", "done", "review_required"]) assert.equal(state(snap(v)), "unknown");
});
test("full comment scan plus instrumented queue distinguishes before", () => {
  const s = snap();
  add(s, "QUEUED");
  assert.equal(state(s), "before");
  s.complete = false;
  assert.equal(state(s), "unknown");
});
test("ready + same-run STARTED heartbeat is running with delayed status", () => {
  const s = snap();
  add(s, "STARTED");
  assert.equal(state(s), "running");
  assert.equal(classify(s, now).delayed, true);
  s.issue.body = s.issue.body.replace("status: ready", "status: in_progress");
  assert.equal(state(s), "running");
});
test("heartbeat expires; later fresh pulse restores observation", () => {
  const s = snap();
  add(s, "STARTED", "", -200000);
  assert.equal(state(s), "unknown");
  add(s, "HEARTBEAT");
  assert.equal(state(s), "running");
});
test("legacy STARTED establishes a start, never indefinite running", () => {
  const s = snap();
  s.comments = [{
    id: 1,
    body: "type: STARTED\ntask_id: test-task\nslot: H1",
    created_at: new Date(now - 5000).toISOString(),
  }];
  assert.equal(state(s), "unknown");
});
test("REPORT wins over heartbeat, is C1 wait rather than accepted", () => {
  const s = snap();
  add(s, "STARTED", "", -20000);
  add(s, "REPORT", "verdict: PASS_SOURCE_ONLY", -5000);
  assert.equal(state(s), "waiting");
  add(s, "HEARTBEAT", "", -1000);
  assert.equal(state(s), "waiting");
});
test("only ordered same-task REPORT HISTORY ACCEPT proves done", () => {
  const s = snap();
  add(s, "REPORT", "verdict: PASS_SOURCE_ONLY", -20000);
  add(s, "HISTORY", "", -10000);
  assert.equal(state(s), "waiting");
  add(s, "ACCEPT", "verdict: PASS_SOURCE_ONLY", -1000);
  assert.equal(state(s), "done");
});
test("rejected/cancelled/stopped acceptance or REPORT cannot become Done", () => {
  for (
    const verdict of [
      "CHANGES_REQUIRED",
      "STOPPED_SAFETY_CHECK",
      "ACCEPT_STOP_REPORT_ONLY",
      "CANCELLED",
      "NOT_VERIFIED",
    ]
  ) {
    const s = snap();
    add(s, "REPORT", `verdict: ${verdict}`);
    add(s, "HISTORY");
    add(s, "ACCEPT", `verdict: ${verdict}`);
    assert.equal(state(s), "stopped");
  }
});
test("source candidate pending further review remains wait", () => {
  const s = snap();
  add(s, "REPORT", "", -20000);
  add(s, "HISTORY", "", -10000);
  add(s, "ACCEPT", "verdict: ACCEPT_SOURCE_FIX_CANDIDATE / FOCUSED_REVIEW_REQUIRED", -1000);
  assert.equal(state(s), "waiting");
});
test("old task evidence never affects a new task", () => {
  const s = snap();
  add(s, "STARTED");
  s.comments[0].body = s.comments[0].body.replace("task_id: test-task", "task_id: old-task");
  assert.equal(state(s), "unknown");
});
test("future/malformed heartbeat, edited TASK, multiple starts are unknown", () => {
  for (const kind of ["future", "invalid", "edited", "overlap"]) {
    const s = snap();
    add(s, "STARTED");
    if (kind === "future") {
      s.comments[0].body = s.comments[0].body.replace(
        /heartbeat_at:.*/,
        `heartbeat_at: ${new Date(now + 60000).toISOString()}`,
      );
    }
    if (kind === "invalid") s.comments[0].body = s.comments[0].body.replace(/heartbeat_at:.*/, "heartbeat_at: bad");
    if (kind === "edited") s.issue.body += "changed scope";
    if (kind === "overlap") {
      add(s, "STARTED", "", -1000);
      s.comments[1].body = s.comments[1].body.replace("run-a", "run-b");
    }
    assert.equal(state(s), "unknown", kind);
  }
});
test("EXITED is not REPORT, nonzero stop is stopped", () => {
  const s = snap();
  add(s, "STARTED", "", -20000);
  add(s, "EXITED");
  assert.equal(state(s), "unknown");
  s.comments.at(-1)!.body = s.comments.at(-1)!.body.replace("EXITED", "STOPPED");
  assert.equal(state(s), "stopped");
});
test("pilot and idle have separate counts", () => {
  const s = snap("idle");
  s.issue.body = s.issue.body.replace("test-task", "none");
  assert.equal(state(s), "idle");
  s.issue.body = s.issue.body.replace("H1", "H1-PILOT");
  assert.equal(state(s), "pilot");
  assert.equal(Object.keys(SLOTS).length, 15);
});
test("incomplete coverage, stale snapshot, wrong Issue, malformed metadata fail closed", () => {
  for (const kind of ["coverage", "stale", "issue", "duplicate"]) {
    const s = snap();
    add(s, "STARTED");
    if (kind === "coverage") s.complete = false;
    if (kind === "stale") s.observed_at = new Date(now - 200000).toISOString();
    if (kind === "issue") s.issue.number = 329;
    if (kind === "duplicate") s.issue.body += "- task_id: other-task\n";
    assert.equal(state(s), "unknown", kind);
  }
});
test("HISTORY embedded TASK/REPORT and narrative do not masquerade as current events", () => {
  assert.deepEqual(
    fields("type: HISTORY\ntask_id: current\noriginal_TASK_full_text_BEGIN\n- type: TASK\n- task_id: old"),
    { type: "HISTORY", task_id: "current" },
  );
  assert.equal(fields("type: REPORT\ntask_id: current\n\n## Old\ntype: STARTED").type, "REPORT");
});
test("wrong-slot evidence and missing REPORT cannot mark done", () => {
  const s = snap("done");
  add(s, "HISTORY");
  add(s, "ACCEPT", "verdict: PASS");
  assert.equal(state(s), "unknown");
  s.comments[0].body = s.comments[0].body.replace("slot: H1", "slot: H2");
  assert.equal(state(s), "unknown");
});
test("explanations about prior rejection or unverified devices do not invert primary verdict", () => {
  const s = snap();
  add(s, "REPORT", "result: P2_F1_FIX_IMPLEMENTED_APPROVED_SCOPE（old CHANGES_REQUIRED is not PASS）", -20000);
  assert.equal(state(s), "waiting");
  add(s, "HISTORY", "", -10000);
  add(
    s,
    "ACCEPT",
    "verdict: ACCEPT_SOURCE_LIMITED_UI / G2_QA_REQUIRED / PRODUCTION_NO_GO\ndecision: Devices remain NOT_VERIFIED; old STOP was protected",
    -1000,
  );
  assert.equal(state(s), "done");
});
test("verified tail permits positive current evidence but never negative inference across missing pages", () => {
  const s = snap();
  add(s, "STARTED");
  s.complete = false;
  s.tail_from_id = 1;
  assert.equal(state(s), "running");
  s.tail_from_id = 2;
  assert.equal(state(s), "unknown");
  s.tail_from_id = 1;
  add(s, "REPORT", "verdict: PASS", -1000);
  assert.equal(state(s), "waiting");
});
test("ACCEPT links must not point at another report/history", () => {
  const s = snap();
  add(s, "REPORT", "", -20000);
  add(s, "HISTORY", "", -10000);
  add(
    s,
    "ACCEPT",
    "verdict: PASS\nREPORT: https://github.com/anohi-memories/kabumori/issues/306#issuecomment-999",
    -1000,
  );
  assert.equal(state(s), "unknown");
});
