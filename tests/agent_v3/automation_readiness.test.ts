import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { catalog, contentSha256, type Header, parseHeader } from "../../scripts/agent_v3/registry.ts";

// Offline schema / refusal tests for `.agent_v3/AUTOMATION_READINESS.md`. The evaluator below is a reference
// for the spec only: it lives in this test file, nothing in scripts/agent_v3 calls it, and nothing runs
// automatically. Everything that is missing, unknown or inconsistent is refused (DEFAULT_DENY).

const ROOT = ".agent_v3_gh";
const DEFS = catalog(ROOT, "GH");
const FIELDS = ["automation_mode", "automation_executor", "automation_allowed_paths", "automation_approval_class", "automation_max_runs", "automation_budget_usd", "automation_depends_on"] as const;
const REQUIRED_FOR_OFFLINE = FIELDS.filter((f) => f !== "automation_depends_on");
const PROTECTED = [".agent/", ".agent_v2/", ".agent_v3_gh/", ".github/", "supabase/", "PROJECT_RULES.md", "AGENTS.md", "CLAUDE.md", "HANDOFF.md", ".env"];
const REASONS = ["MANUAL", "UNKNOWN_VALUE", "MISSING_FIELD", "NOT_CUT_OVER", "BAD_STATUS", "EXECUTOR_MISMATCH", "HUMAN_APPROVAL_REQUIRED", "BUDGET_NOT_ZERO", "BAD_PATH", "STALE_SHA", "RUN_LIMIT", "DEPENDENCY_NOT_DONE", "CHAIN_TOO_LONG", "STOP_CONDITION"] as const;
type Reason = typeof REASONS[number];

type Request = { task_id: string; task_sha256: string; run: number };
type Dependency = { accepted: boolean; archived: boolean; chain: number }; // chain: automated steps already linked before it
type World = {
  cutOver: Set<string>;
  dependencies: Map<string, Dependency>; // "slot:task_id" -> state
  stop: boolean; // CHANGES_REQUIRED, P1/P2, unknown publish, unarchived done, double assignment, conflicts, read-back mismatch
};

function badPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.split("/").some((s) => s === "..")) return true;
  if (p.split("/").slice(0, -1).some((s) => s === "") ) return true;
  return PROTECTED.some((x) => (x.endsWith("/") ? p === x.slice(0, -1) || p.startsWith(x) || x.startsWith(p.endsWith("/") ? p : `${p}/`) : p === x || x.startsWith(p.endsWith("/") ? p : `${p}/`) || p.startsWith(x)));
}

function evaluate(slot: string, taskText: string, req: Request, w: World): { eligible: boolean; reasons: Reason[] } {
  const h: Header = parseHeader(taskText);
  const reasons: Reason[] = [];
  const add = (r: Reason) => reasons.includes(r) || reasons.push(r);
  const mode = h.automation_mode ?? "manual";
  if (mode === "manual") return { eligible: false, reasons: ["MANUAL"] };
  if (mode !== "offline_source_only") return { eligible: false, reasons: ["UNKNOWN_VALUE"] };
  for (const f of REQUIRED_FOR_OFFLINE) if (!(f in h) || h[f] === "") add("MISSING_FIELD");
  if (!w.cutOver.has(slot)) add("NOT_CUT_OVER");
  if (!["ready", "in_progress"].includes(h.status ?? "")) add("BAD_STATUS");
  const def = DEFS.find((d) => d.slot === slot);
  const wantExecutor = def?.owner === "claude" ? "claude_code" : def?.owner === "codex" ? "codex" : null;
  if (h.automation_executor !== undefined) {
    if (!["claude_code", "codex"].includes(h.automation_executor)) add("UNKNOWN_VALUE");
    else if (h.automation_executor !== wantExecutor) add("EXECUTOR_MISMATCH");
  }
  if (h.automation_approval_class !== undefined) {
    if (h.automation_approval_class === "human_required") add("HUMAN_APPROVAL_REQUIRED");
    else if (h.automation_approval_class !== "offline_no_human") add("UNKNOWN_VALUE");
  }
  if (h.automation_budget_usd !== undefined && h.automation_budget_usd !== "0") add("BUDGET_NOT_ZERO");
  if (h.automation_allowed_paths !== undefined) {
    const paths = h.automation_allowed_paths.split(",").map((s) => s.trim());
    if (paths.some(badPath)) add("BAD_PATH");
  }
  if (req.task_id !== h.task_id || req.task_sha256 !== contentSha256(taskText)) add("STALE_SHA");
  if (h.automation_max_runs !== undefined) {
    const max = Number(h.automation_max_runs);
    if (!/^[1-3]$/.test(h.automation_max_runs) || !Number.isInteger(req.run) || req.run < 1 || req.run > max) add("RUN_LIMIT");
  }
  const deps = (h.automation_depends_on ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (deps.length > 2) add("CHAIN_TOO_LONG");
  for (const d of deps) {
    const s = w.dependencies.get(d);
    if (!/^[GH]\d+:[a-z0-9][a-z0-9-]{8,}[a-z0-9]$/.test(d)) add("UNKNOWN_VALUE");
    else if (!s || !s.accepted || !s.archived) add("DEPENDENCY_NOT_DONE");
    else if (s.chain + 1 >= 3) add("CHAIN_TOO_LONG");
  }
  if (w.stop) add("STOP_CONDITION");
  return { eligible: reasons.length === 0, reasons };
}

const ID = "fixture-g7-automation-readiness-20261018";
function taskWith(extra: Record<string, string | null>, status = "ready"): string {
  const base: Record<string, string> = {
    automation_mode: "offline_source_only",
    automation_executor: "claude_code",
    automation_allowed_paths: "docs/automation-fixture/,tests/agent_v3/",
    automation_approval_class: "offline_no_human",
    automation_max_runs: "2",
    automation_budget_usd: "0",
  };
  const fields = { ...base, ...extra };
  return [
    "# G7 — automation fixture",
    "",
    `- task_id: ${ID}`,
    "- owner: claude",
    "- slot: G7",
    `- status: ${status}`,
    "- next_owner: claude",
    "- start_code: G7",
    "- completion_code: K7",
    "- return_to: fixture-room",
    "- recommended_model: Sonnet5（高）",
    ...Object.entries(fields).filter(([, v]) => v !== null).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Report",
    "",
    "- result: not_started",
    "",
  ].join("\n");
}
const okWorld = (): World => ({ cutOver: new Set(["G7"]), dependencies: new Map(), stop: false });
const req = (text: string, run = 1): Request => ({ task_id: ID, task_sha256: contentSha256(text), run });

test("automation: a complete offline_source_only TASK is eligible (future use only; nothing executes it)", () => {
  const t = taskWith({});
  assert.deepEqual(evaluate("G7", t, req(t), okWorld()), { eligible: true, reasons: [] });
});

test("automation: absent metadata, manual or an unknown mode never runs", () => {
  const legacy = taskWith({ automation_mode: null, automation_executor: null, automation_allowed_paths: null, automation_approval_class: null, automation_max_runs: null, automation_budget_usd: null });
  assert.deepEqual(evaluate("G7", legacy, req(legacy), okWorld()).reasons, ["MANUAL"]);
  const manual = taskWith({ automation_mode: "manual" });
  assert.deepEqual(evaluate("G7", manual, req(manual), okWorld()).reasons, ["MANUAL"]);
  const odd = taskWith({ automation_mode: "auto" });
  assert.deepEqual(evaluate("G7", odd, req(odd), okWorld()).reasons, ["UNKNOWN_VALUE"]);
});

test("automation: each required field missing, unknown values and a non-matching executor are refused", () => {
  for (const f of REQUIRED_FOR_OFFLINE.filter((x) => x !== "automation_mode")) {
    const t = taskWith({ [f]: null });
    assert.ok(evaluate("G7", t, req(t), okWorld()).reasons.includes("MISSING_FIELD"), f);
  }
  const t1 = taskWith({ automation_executor: "codex" });
  assert.ok(evaluate("G7", t1, req(t1), okWorld()).reasons.includes("EXECUTOR_MISMATCH"));
  const t2 = taskWith({ automation_executor: "robot" });
  assert.ok(evaluate("G7", t2, req(t2), okWorld()).reasons.includes("UNKNOWN_VALUE"));
  const t3 = taskWith({ automation_approval_class: "maybe" });
  assert.ok(evaluate("G7", t3, req(t3), okWorld()).reasons.includes("UNKNOWN_VALUE"));
});

test("automation: human approval classes, a non-zero budget and run limits are refused", () => {
  const h = taskWith({ automation_approval_class: "human_required" });
  assert.ok(evaluate("G7", h, req(h), okWorld()).reasons.includes("HUMAN_APPROVAL_REQUIRED"));
  for (const b of ["1", "0.01", "-1", "free"]) {
    const t = taskWith({ automation_budget_usd: b });
    assert.ok(evaluate("G7", t, req(t), okWorld()).reasons.includes("BUDGET_NOT_ZERO"), b);
  }
  for (const m of ["0", "4", "1.5", "x"]) {
    const t = taskWith({ automation_max_runs: m });
    assert.ok(evaluate("G7", t, req(t), okWorld()).reasons.includes("RUN_LIMIT"), m);
  }
  const t = taskWith({ automation_max_runs: "2" });
  assert.ok(evaluate("G7", t, req(t, 3), okWorld()).reasons.includes("RUN_LIMIT"), "the third run of a max-2 task");
});

test("automation: traversal, absolute, empty-segment and protected paths are refused", () => {
  for (const p of ["../x", "docs/../.agent/", "/etc", "docs//x", ".agent/", ".agent_v2/tasks/", ".agent_v3_gh/", ".github/workflows/", "supabase/migrations/", "PROJECT_RULES.md", "AGENTS.md", "CLAUDE.md", ".env", ".agent", "docs/x,.github/"]) {
    const t = taskWith({ automation_allowed_paths: p });
    assert.ok(evaluate("G7", t, req(t), okWorld()).reasons.includes("BAD_PATH"), p);
  }
});

test("automation: a stale TASK SHA or a different task_id is refused", () => {
  const t = taskWith({});
  assert.ok(evaluate("G7", t, { ...req(t), task_sha256: "0".repeat(64) }, okWorld()).reasons.includes("STALE_SHA"));
  assert.ok(evaluate("G7", t, { ...req(t), task_id: "fixture-g7-other-task-20261018" }, okWorld()).reasons.includes("STALE_SHA"));
  const edited = t.replace("fixture", "fixture (edited after approval)");
  assert.ok(evaluate("G7", edited, req(t), okWorld()).reasons.includes("STALE_SHA"), "body edited after approval");
});

test("automation: a slot not cut over or a non-active status is refused", () => {
  const t = taskWith({});
  assert.ok(evaluate("G7", t, req(t), { ...okWorld(), cutOver: new Set() }).reasons.includes("NOT_CUT_OVER"));
  for (const s of ["idle", "review_required", "done"]) {
    const x = taskWith({}, s);
    assert.ok(evaluate("G7", x, req(x), okWorld()).reasons.includes("BAD_STATUS"), s);
  }
});

test("automation: dependencies must be accepted and archived, and chains stop at 3 steps", () => {
  const dep = "G6:fixture-g6-previous-step-20261018";
  const t = taskWith({ automation_depends_on: dep });
  const world = (d: Dependency | undefined) => ({ ...okWorld(), dependencies: d ? new Map([[dep, d]]) : new Map() });
  assert.deepEqual(evaluate("G7", t, req(t), world({ accepted: true, archived: true, chain: 0 })).reasons, []);
  assert.ok(evaluate("G7", t, req(t), world({ accepted: true, archived: true, chain: 1 })).eligible, "step 3 of 3");
  assert.ok(evaluate("G7", t, req(t), world({ accepted: true, archived: true, chain: 2 })).reasons.includes("CHAIN_TOO_LONG"), "step 4");
  assert.ok(evaluate("G7", t, req(t), world({ accepted: true, archived: false, chain: 0 })).reasons.includes("DEPENDENCY_NOT_DONE"));
  assert.ok(evaluate("G7", t, req(t), world({ accepted: false, archived: true, chain: 0 })).reasons.includes("DEPENDENCY_NOT_DONE"));
  assert.ok(evaluate("G7", t, req(t), world(undefined)).reasons.includes("DEPENDENCY_NOT_DONE"));
  const three = taskWith({ automation_depends_on: `${dep},G5:fixture-g5-a-step-20261018,G4:fixture-g4-b-step-20261018` });
  assert.ok(evaluate("G7", three, req(three), okWorld()).reasons.includes("CHAIN_TOO_LONG"));
  const odd = taskWith({ automation_depends_on: "F7:not a task" });
  assert.ok(evaluate("G7", odd, req(odd), okWorld()).reasons.includes("UNKNOWN_VALUE"));
});

test("automation: any stop condition refuses an otherwise eligible TASK", () => {
  const t = taskWith({});
  assert.deepEqual(evaluate("G7", t, req(t), { ...okWorld(), stop: true }).reasons, ["STOP_CONDITION"]);
});

test("automation: the spec lists exactly the fields, protected paths and reason codes this reference uses", () => {
  const doc = readFileSync(new URL("../../.agent_v3/AUTOMATION_READINESS.md", import.meta.url), "utf8");
  const section = (title: string) => doc.split(`## ${title}`)[1].split("\n## ")[0];
  const fieldsInDoc = [...section("2. 自動実行の許可情報（任意・既定は拒否）").matchAll(/^\| `(automation_[a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(fieldsInDoc, [...FIELDS]);
  const reasonsInDoc = [...section("6. 拒否の理由コード（テストの参照実装と同じ）").matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(reasonsInDoc, [...REASONS]);
  const protectedLine = section("2. 自動実行の許可情報（任意・既定は拒否）").split("保護されたパス（")[1].split("\n\n")[1];
  assert.deepEqual([...protectedLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]), PROTECTED);
  // The header parser keeps unknown automation_* keys as-is, so no parser change is needed.
  assert.equal(parseHeader(taskWith({})).automation_mode, "offline_source_only");
});
