import { createHash } from "node:crypto";

// Agent V3 registry: pure logic only (no git, no network).
//
// V3 keeps exactly one canonical record per slot: the metadata header at the top of that slot's TASK file.
// The ACTIVE index is *derived* from those headers and carries a digest of what it was derived from, so a
// stale or hand-edited index is detectable and never wins over a TASK header. Every change (assign, start,
// report, accept, archive) is planned here as one change set that a backend publishes as one commit.

export const STATUSES = ["idle", "ready", "in_progress", "review_required", "done"] as const;
export type Status = typeof STATUSES[number];
export const KEY_FIELDS = ["task_id", "status", "next_owner", "return_to", "completion_code"] as const;
const REQUIRED_FIELDS = [
  "task_id",
  "owner",
  "slot",
  "status",
  "next_owner",
  "start_code",
  "completion_code",
  "return_to",
  "recommended_model",
] as const;
const NEXT_OWNERS = new Set(["claude", "codex", "chatgpt", "user", "none"]);
const TASK_ID = /^[a-z0-9][a-z0-9-]{8,}[a-z0-9]$/;
export const INDEX_MARKER = "<!-- agent_v3: GENERATED from tasks/*.md headers by scripts/agent_v3. Do not edit by hand. -->";

export type Naming = "FJ" | "GH";

export interface SlotDef {
  slot: string;
  owner: "claude" | "codex";
  completionCode: string;
  taskPath: string;
  reportPath: string | null; // null: the Report is the `## Report` section at the end of the TASK file
}

export type Header = Record<string, string>;
export type ReadFile = (path: string) => string | null;
export type ChangeSet = {
  files: Map<string, string | null>;
  expectations: Map<string, Header>; // slot -> key fields that must read back from the published ref
  message: string;
};

export class PlanError extends Error {
  readonly kind: "same_slot_conflict" | "invalid" | "not_archived" | "occupied" | "not_found" | "destination" | "report_mismatch";
  constructor(kind: PlanError["kind"], message: string) {
    super(message);
    this.name = "PlanError";
    this.kind = kind;
  }
}

export function catalog(root: string, naming: Naming): SlotDef[] {
  const [claude, claudeDone, codex, codexDone] = naming === "FJ" ? ["F", "L", "J", "V"] : ["G", "K", "H", "C"];
  const defs: SlotDef[] = [];
  for (let n = 1; n <= 10; n++) {
    defs.push({
      slot: `${claude}${n}`,
      owner: "claude",
      completionCode: `${claudeDone}${n}`,
      taskPath: `${root}/tasks/${claude}${n}.md`,
      reportPath: null,
    });
  }
  for (let n = 1; n <= 5; n++) {
    defs.push({
      slot: `${codex}${n}`,
      owner: "codex",
      completionCode: `${codexDone}${n}`,
      taskPath: `${root}/tasks/${codex}${n}.md`,
      reportPath: `${root}/reports/${codex}${n}.md`,
    });
  }
  return defs;
}

export function indexPath(root: string): string {
  return `${root}/ACTIVE_TASK.md`;
}

export function historyIndexPath(root: string): string {
  return `${root}/HISTORY_INDEX.md`;
}

function clean(value: string): string {
  return value.replace(/[`*]/g, "").trim();
}

// The header is the leading run of `- key: value` lines (blank lines allowed) before the first `## ` heading.
// A UTF-8 BOM and CRLF line endings are tolerated so a file saved by another editor parses the same way.
function headerLines(text: string): string[] {
  const lines = text.replace(/^﻿/, "").split("\n").map((l) => l.replace(/\r$/, ""));
  const end = lines.findIndex((l) => l.startsWith("## "));
  return end < 0 ? lines : lines.slice(0, end);
}

export function parseHeader(text: string | null): Header {
  const header: Header = {};
  if (text === null) return header;
  for (const line of headerLines(text)) {
    const m = line.match(/^- ([a-z_]+): *(.*)$/);
    if (m && !(m[1] in header)) header[m[1]] = clean(m[2]);
  }
  return header;
}

// An indented `- key:` line in the header area is not read as a field, so it would silently be ignored;
// a TASK containing one is refused instead.
export function validateTaskText(text: string): string[] {
  return headerLines(text)
    .filter((l) => /^\s+- [a-z_]+:/.test(l))
    .map((l) => `indented header field ${JSON.stringify(l.trim().slice(0, 40))}`);
}

export function keyFields(h: Header): Header {
  const out: Header = {};
  for (const k of KEY_FIELDS) out[k] = h[k] ?? "";
  return out;
}

export function validateHeader(def: SlotDef, h: Header): string[] {
  const errors: string[] = [];
  for (const k of REQUIRED_FIELDS) if (!(k in h) || h[k] === "") errors.push(`missing ${k}`);
  if (h.slot && h.slot !== def.slot) errors.push(`slot ${h.slot} != ${def.slot}`);
  if (h.start_code && h.start_code !== def.slot) errors.push(`start_code ${h.start_code} != ${def.slot}`);
  if (h.completion_code && h.completion_code !== def.completionCode) {
    errors.push(`completion_code ${h.completion_code} != ${def.completionCode}`);
  }
  if (h.owner && h.owner !== def.owner) errors.push(`owner ${h.owner} != ${def.owner}`);
  if (h.status && !(STATUSES as readonly string[]).includes(h.status)) errors.push(`unknown status ${h.status}`);
  if (h.next_owner && !NEXT_OWNERS.has(h.next_owner)) errors.push(`unknown next_owner ${h.next_owner}`);
  const idle = h.status === "idle";
  if (idle && h.task_id && h.task_id !== "none") errors.push("idle slot must have task_id none");
  if (!idle) {
    if (!TASK_ID.test(h.task_id ?? "")) errors.push(`bad task_id ${h.task_id}`);
    if (!h.return_to || h.return_to.startsWith("none")) errors.push("return_to required for an assigned slot");
    if (!h.recommended_model || h.recommended_model === "none") errors.push("recommended_model required");
  }
  return errors;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export function headersDigest(defs: SlotDef[], read: ReadFile): string {
  return sha256(canonicalJson(defs.map((d) => [d.slot, keyFields(parseHeader(read(d.taskPath)))])));
}

export function deriveIndex(defs: SlotDef[], read: ReadFile): string {
  const lines = [
    "# Active Tasks Index (agent_v3, derived)",
    "",
    INDEX_MARKER,
    "",
    "This file is derived. The canonical state of each slot is the header of its TASK file. If this index",
    "disagrees with a TASK header, the TASK header wins and this index is stale.",
    "",
    `- source_digest: ${headersDigest(defs, read)}`,
    "",
  ];
  for (const d of defs) {
    const h = parseHeader(read(d.taskPath));
    lines.push(`## ${d.slot}`);
    for (const k of KEY_FIELDS) lines.push(`- ${k}: ${h[k] ?? ""}`);
    lines.push(`- owner: ${h.owner ?? d.owner}`);
    lines.push(`- recommended_model: ${h.recommended_model ?? ""}`);
    lines.push(`- task_path: ${d.taskPath}`);
    lines.push(`- report_path: ${d.reportPath ?? `${d.taskPath}#report`}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function parseIndex(text: string | null): Map<string, Header> {
  const out = new Map<string, Header>();
  let cur: string | null = null;
  for (const line of (text ?? "").split("\n")) {
    const m = line.match(/^## (?:Claude |Codex )?([FJGH]\d+)\s*$/);
    if (m) {
      cur = m[1];
      out.set(cur, {});
      continue;
    }
    if (line.startsWith("## ")) cur = null;
    const f = line.match(/^- ([a-z_]+): *(.*)$/);
    if (cur && f && !(f[1] in out.get(cur)!)) out.get(cur)![f[1]] = clean(f[2]);
  }
  return out;
}

export type Finding = { slot: string; kind: string; detail: string };

// Read-only consistency check. `derived` is true for V3 roots (index must carry the digest and match
// exactly); false lets the same check run against the hand-maintained .agent_v2 index.
export function verifyRoot(defs: SlotDef[], read: ReadFile, root: string, derived: boolean): Finding[] {
  const findings: Finding[] = [];
  const indexText = read(indexPath(root));
  if (indexText === null) return [{ slot: "*", kind: "INDEX_MISSING", detail: indexPath(root) }];
  const index = parseIndex(indexText);
  for (const d of defs) {
    const text = read(d.taskPath);
    if (text === null) {
      findings.push({ slot: d.slot, kind: "TASK_MISSING", detail: d.taskPath });
      continue;
    }
    const h = parseHeader(text);
    for (const e of validateHeader(d, h)) findings.push({ slot: d.slot, kind: "HEADER_INVALID", detail: e });
    const i = index.get(d.slot);
    if (!i) {
      findings.push({ slot: d.slot, kind: "INDEX_SLOT_MISSING", detail: d.slot });
      continue;
    }
    for (const k of KEY_FIELDS) {
      if ((h[k] ?? "") !== (i[k] ?? "")) {
        findings.push({ slot: d.slot, kind: "INDEX_MISMATCH", detail: `${k}: task=${h[k] ?? ""} index=${i[k] ?? ""}` });
      }
    }
  }
  if (derived) {
    const m = indexText.match(/^- source_digest: ([0-9a-f]{64})$/m);
    const want = headersDigest(defs, read);
    if (!indexText.includes(INDEX_MARKER) || !m) {
      findings.push({ slot: "*", kind: "INDEX_NOT_DERIVED", detail: "marker or source_digest missing" });
    } else if (m[1] !== want) {
      findings.push({ slot: "*", kind: "INDEX_STALE", detail: `digest ${m[1]} != ${want}` });
    } else if (indexText !== deriveIndex(defs, read)) {
      findings.push({ slot: "*", kind: "INDEX_HAND_EDITED", detail: "index differs from derived output" });
    }
  }
  return findings;
}

const ALLOWED: Record<Status, Status[]> = {
  idle: ["ready"],
  ready: ["in_progress", "ready"],
  in_progress: ["review_required", "in_progress"],
  review_required: ["done", "ready", "in_progress", "review_required"],
  done: [],
};

export function idleTemplate(def: SlotDef, root: string): string {
  return [
    `# ${def.slot} — UNASSIGNED (${root})`,
    "",
    "- task_id: none",
    `- owner: ${def.owner}`,
    `- slot: ${def.slot}`,
    "- status: idle",
    "- next_owner: none",
    `- start_code: ${def.slot}`,
    `- completion_code: ${def.completionCode}`,
    "- return_to: none",
    "- recommended_model: none",
    `- current_task_path: ${def.taskPath}`,
    `- current_report_path: ${def.reportPath ?? `${def.taskPath}#report`}`,
    "- dependencies: none",
    "- blocker: none",
    "",
    "## Report",
    "",
    "- result: not_started",
    "",
  ].join("\n");
}

export function idleReport(def: SlotDef): string {
  return [`# ${def.slot} Report (latest only)`, "", "- task_id: none", "- result: not_started", ""].join("\n");
}

export function initRoot(defs: SlotDef[], root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const d of defs) {
    files.set(d.taskPath, idleTemplate(d, root));
    if (d.reportPath) files.set(d.reportPath, idleReport(d));
  }
  files.set(historyIndexPath(root), "# HISTORY_INDEX (agent_v3)\n\n| date | slot | task_id | result | archive |\n| --- | --- | --- | --- | --- |\n");
  files.set(indexPath(root), deriveIndex(defs, (p) => files.get(p) ?? null));
  return files;
}

function overlay(read: ReadFile, files: Map<string, string | null>): ReadFile {
  return (p) => (files.has(p) ? files.get(p)! : read(p));
}

function slotDef(defs: SlotDef[], slot: string): SlotDef {
  const d = defs.find((x) => x.slot === slot);
  if (!d) throw new PlanError("not_found", `unknown slot ${slot}`);
  return d;
}

export type ListFiles = (prefix: string) => string[];

// What the caller saw when it decided to write. task_sha256 is the SHA256 of the whole TASK file (UTF-8
// bytes), so an edit that keeps task_id and status but changes the body is still detected as someone else's
// change. report_sha256 does the same for a Codex Report file ("missing" when the file does not exist).
export type Expect = { task_id: string; status: string; task_sha256: string; report_sha256?: string };

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ROOT = /^\.agent_v3[A-Za-z0-9_-]*$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._@-]+$/;

export function contentSha256(text: string | null): string {
  return text === null ? "missing" : sha256(new TextEncoder().encode(text));
}

export type SlotState = { slot: string; task_id: string; status: string; task_sha256: string; report_sha256: string | null };

export function slotState(defs: SlotDef[], read: ReadFile, slot: string): SlotState {
  const def = slotDef(defs, slot);
  const task = read(def.taskPath);
  const h = parseHeader(task);
  return {
    slot,
    task_id: h.task_id ?? "",
    status: h.status ?? "",
    task_sha256: contentSha256(task),
    report_sha256: def.reportPath ? contentSha256(read(def.reportPath)) : null,
  };
}

// Writes are confined to one V3 root. The live .agent/ and .agent_v2/ systems, .github/ and anything outside
// the root can never be part of a change set, whatever a planner produced.
export function assertSafeRoot(root: string): void {
  if (!SAFE_ROOT.test(root)) throw new PlanError("destination", `root ${root} is not an allowed V3 root (.agent_v3*)`);
}

export function assertWithinRoot(paths: Iterable<string>, root: string): void {
  assertSafeRoot(root);
  for (const path of paths) {
    const segments = path.split("/");
    if (segments[0] !== root || segments.length < 2 || segments.some((s) => s === "" || s === "." || s === ".." || !SAFE_SEGMENT.test(s))) {
      throw new PlanError("destination", `path ${JSON.stringify(path)} is outside ${root} or not a plain relative path`);
    }
  }
}

function checkExpect(def: SlotDef, read: ReadFile, expect: Expect, needReport: boolean): Header {
  if (!SHA256.test(expect.task_sha256 ?? "")) {
    throw new PlanError("invalid", `${def.slot}: expect.task_sha256 is required (64 hex); run \`show\` to read the current state`);
  }
  const task = read(def.taskPath);
  const before = parseHeader(task);
  const seen = `${before.task_id}/${before.status}/${contentSha256(task).slice(0, 12)}`;
  if ((before.task_id ?? "") !== expect.task_id || (before.status ?? "") !== expect.status || contentSha256(task) !== expect.task_sha256) {
    throw new PlanError("same_slot_conflict", `${def.slot} is ${seen}, caller expected ${expect.task_id}/${expect.status}/${expect.task_sha256.slice(0, 12)}`);
  }
  if (needReport && def.reportPath) {
    const want = expect.report_sha256 ?? "";
    if (want !== "missing" && !SHA256.test(want)) throw new PlanError("invalid", `${def.slot}: expect.report_sha256 is required`);
    if (contentSha256(read(def.reportPath)) !== want) {
      throw new PlanError("same_slot_conflict", `${def.slot} Report changed since the caller read it`);
    }
  }
  return before;
}

export function planInit(defs: SlotDef[], root: string, list: ListFiles): ChangeSet {
  assertSafeRoot(root);
  const existing = list(`${root}/`);
  if (existing.length) throw new PlanError("occupied", `${root} already has ${existing.length} file(s), e.g. ${existing[0]}`);
  return { files: initRoot(defs, root), expectations: new Map(), message: `agent_v3: initialise ${root}` };
}

// Plan a TASK-file write for one slot. `expect` is what the caller believed the slot held when it decided
// to write; if the base no longer matches (including the body), another writer got there first and the
// plan is refused instead of overwriting their change.
export function planTaskWrite(
  defs: SlotDef[],
  root: string,
  read: ReadFile,
  slot: string,
  newTaskText: string,
  expect: Expect,
  reportText: string | null,
  message: string,
): ChangeSet {
  assertSafeRoot(root);
  const def = slotDef(defs, slot);
  const before = checkExpect(def, read, expect, reportText !== null);
  const after = parseHeader(newTaskText);
  const errors = [...validateHeader(def, after), ...validateTaskText(newTaskText)];
  if (errors.length) throw new PlanError("invalid", `${slot}: ${errors.join("; ")}`);
  if (after.task_id !== before.task_id) {
    // A new task only ever lands on an idle slot. A done slot is archived first (which resets it to idle),
    // so a finished TASK can never be overwritten before its history is saved.
    if (before.status === "done") {
      throw new PlanError("not_archived", `${slot} still holds done ${before.task_id}; archive it first`);
    }
    if (before.status !== "idle") throw new PlanError("occupied", `${slot} holds ${before.task_id} (${before.status})`);
    if (after.status !== "ready") throw new PlanError("invalid", `${slot}: a new task must start as ready`);
  } else if (!ALLOWED[before.status as Status]?.includes(after.status as Status)) {
    throw new PlanError("invalid", `${slot}: transition ${before.status} -> ${after.status} not allowed`);
  }
  const files = new Map<string, string | null>([[def.taskPath, newTaskText]]);
  if (reportText !== null) {
    if (!def.reportPath) throw new PlanError("invalid", `${slot} keeps its Report inside the TASK file`);
    files.set(def.reportPath, reportText);
  }
  files.set(indexPath(root), deriveIndex(defs, overlay(read, files)));
  return { files, expectations: new Map([[slot, keyFields(after)]]), message };
}

// Plan the archive of a done slot and its reset to idle, as one change set: byte copies of the TASK (and
// Report), MANIFEST.json with SHA256 and the base commit, SHA256SUMS, one HISTORY_INDEX row, the idle
// template and the re-derived index. If any part cannot be written, nothing is.
export function planArchive(
  defs: SlotDef[],
  root: string,
  read: ReadFile,
  list: ListFiles,
  slot: string,
  expect: Expect,
  baseCommit: string,
  date: string,
): ChangeSet {
  assertSafeRoot(root);
  const def = slotDef(defs, slot);
  const h = checkExpect(def, read, expect, true);
  if (h.status !== "done") throw new PlanError("same_slot_conflict", `${slot} is ${h.status}, only a done slot is archived`);
  if (!TASK_ID.test(expect.task_id)) throw new PlanError("invalid", `bad task_id ${expect.task_id}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PlanError("invalid", `bad date ${date}`);
  const task = read(def.taskPath)!;
  const originals: [string, string][] = [[def.taskPath, task]];
  if (def.reportPath) {
    // A Codex slot is archived only together with the Report of the same task; otherwise the history would
    // lose the Report while the slot is reset to idle.
    const report = read(def.reportPath);
    const reportTask = parseHeader(report).task_id;
    if (report === null) throw new PlanError("report_mismatch", `${slot} Report is missing; not archiving`);
    if (reportTask !== expect.task_id) throw new PlanError("report_mismatch", `${slot} Report is for ${reportTask}, not ${expect.task_id}`);
    originals.push([def.reportPath, report]);
  }
  const dir = `${root}/archive/${date}-${slot}-${expect.task_id}`;
  const existing = list(`${dir}/`);
  if (existing.length) throw new PlanError("occupied", `${dir} already has ${existing.length} file(s) (append-only)`);
  const files = new Map<string, string | null>();
  const entries = originals.map(([path, text]) => {
    const archivePath = `${dir}/files/${path}`;
    files.set(archivePath, text);
    return {
      original_path: path,
      archive_path: archivePath,
      size: new TextEncoder().encode(text).length,
      sha256: contentSha256(text),
      snapshot_commit: baseCommit,
    };
  });
  files.set(`${dir}/MANIFEST.json`, JSON.stringify({ slot, task_id: expect.task_id, snapshot_commit: baseCommit, files: entries }, null, 2) + "\n");
  files.set(`${dir}/SHA256SUMS`, entries.map((e) => `${e.sha256}  files/${e.original_path}\n`).join(""));
  const result = (task.match(/^- result: *(.*)$/m)?.[1] ?? "").replace(/\|/g, "/").slice(0, 80);
  const history = read(historyIndexPath(root)) ?? "";
  files.set(historyIndexPath(root), `${history}| ${date} | ${slot} | ${expect.task_id} | ${clean(result)} | ${dir} |\n`);
  files.set(def.taskPath, idleTemplate(def, root));
  if (def.reportPath) files.set(def.reportPath, idleReport(def));
  files.set(indexPath(root), deriveIndex(defs, overlay(read, files)));
  const idle = keyFields(parseHeader(idleTemplate(def, root)));
  return { files, expectations: new Map([[slot, idle]]), message: `agent_v3(${slot}): archive ${expect.task_id} and reset to idle` };
}
