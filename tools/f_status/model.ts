import { createHash } from "node:crypto";
import { parseHeader } from "../../scripts/agent_v3/registry.ts";

export const REPO = "anohi-memories/kabumori";
export const SLOTS = Object.freeze({
  G1: 316,
  G2: 317,
  G3: 318,
  G4: 319,
  G5: 320,
  G6: 321,
  G7: 322,
  G8: 304,
  G9: 298,
  G10: 323,
  H1: 306,
  H2: 329,
  H3: 330,
  H4: 331,
  H5: 332,
});
export type Slot = keyof typeof SLOTS;
export type Comment = {
  id: number | string;
  body: string;
  created_at: string;
  updated_at?: string;
  html_url?: string;
  issue_url?: string;
};
export type Snapshot = {
  slot: Slot;
  issue: { number: number; body: string; comments: number; updated_at: string; state: string };
  comments: Comment[];
  complete: boolean;
  observed_at: string;
  error?: string;
  generation_chain?: number[];
  tail_from_id?: number;
};
export type State = "running" | "before" | "waiting" | "done" | "stopped" | "unknown" | "idle" | "pilot";
export const LABELS: Record<State, string> = {
  running: "実行中",
  before: "実行前",
  waiting: "K/C待ち",
  done: "Done",
  stopped: "停止・要修正",
  unknown: "不明",
  idle: "idle",
  pilot: "pilot（正式稼働外）",
};

// Reuse V3's leading TASK metadata; comments also allow bare keys and mixed-case HEAD.
// Stop at the first section/fence: a HISTORY's embedded original TASK must not become its event.
export function fields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let begun = false;
  for (const line of body.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*```|^##\s|^original_TASK_full_text_BEGIN/.test(line)) break;
    const m = line.match(/^\s*(?:- )?([A-Za-z_][A-Za-z_0-9]*):\s*(.*)$/);
    if (!m) {
      if (begun && line.trim()) break;
      continue;
    }
    begun = true;
    const key = m[1].toLowerCase();
    if (key in out && out[key] !== m[2].replace(/[`*]/g, "").trim()) throw new Error(`duplicate field: ${key}`);
    out[key] = m[2].replace(/[`*]/g, "").trim();
  }
  return out;
}
export function task(body: string) {
  return { ...parseHeader(body), ...fields(body) };
}
// The coordinator owns these two lifecycle fields; their update must not invalidate a running lease.
export function digest(body: string) {
  return createHash("sha256").update(body.replace(/^\s*- (?:status|next_owner):[^\n]*$/gm, "")).digest("hex");
}
const ms = (v: string | undefined) => v ? Date.parse(v) : NaN;
// Only the primary machine verdict is authoritative. Explanatory text may mention old
// CHANGES_REQUIRED or future NOT_VERIFIED checks and must not invert the current result.
const primary = (f: Record<string, string>) =>
  (f.verdict || f.result || f.decision || f.status || "").toUpperCase().split(/[\s/（(]/)[0];
const stopped = (f: Record<string, string>) =>
  /CHANGES_REQUIRED|STOP|BLOCKED|CANCEL|NOT_VERIFIED|NOT_COMPLETED|NO_GO_REVIEW/.test(primary(f));
const accepted = (f: Record<string, string>) =>
  /^(?:PASS(?:\b|_)|ACCEPTED(?:\b|_)|ACCEPT(?:\b|_))/.test(primary(f)) && !stopped(f) &&
  !/REVIEW_REQUIRED|PENDING|CANDIDATE/.test(primary(f));
export function classify(s: Snapshot, now = Date.now(), ttlSeconds = 180) {
  const base = {
    slot: s.slot,
    issue: s.issue.number,
    task_id: "",
    status: "",
    state: "unknown" as State,
    label: LABELS.unknown,
    reason: "",
    delayed: false,
    evidence: [] as (string | number)[],
    observed_at: s.observed_at,
    comments_checked: s.comments.length,
    comments_expected: s.issue.comments,
    comment_types: s.comments.reduce((counts, c) => {
      let type = "AMBIGUOUS";
      try {
        type = fields(c.body).type || "UNTYPED";
      } catch { /* counted for audit */ }
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {} as Record<string, number>),
  };
  const answer = (state: State, reason: string, ids: (string | number)[] = [], delayed = false) => ({
    ...base,
    state,
    label: LABELS[state],
    reason,
    evidence: ids,
    delayed,
  });
  if (!Number.isFinite(now) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return answer("unknown", "invalid clock/TTL");
  }
  if (
    s.error || !Number.isFinite(ms(s.observed_at)) || now - ms(s.observed_at) > ttlSeconds * 1000 ||
    ms(s.observed_at) > now + 5000
  ) {
    return answer("unknown", s.error || "snapshot stale/invalid");
  }
  let h: Record<string, string>;
  try {
    h = task(s.issue.body);
  } catch {
    return answer("unknown", "ambiguous TASK metadata");
  }
  base.task_id = h.task_id;
  base.status = h.status;
  if (/PILOT/i.test(h.slot || "") || /^3\b/.test(h.generation_limit || "")) return answer("pilot", "pilot protected");
  if (
    (s.issue.number !== SLOTS[s.slot] &&
      !(s.generation_chain?.[0] === SLOTS[s.slot] && s.generation_chain.at(-1) === s.issue.number)) || h.slot !== s.slot
  ) {
    return answer("unknown", "slot/Issue mismatch; inspect successor generation");
  }
  if (h.task_id === "none" && h.status === "idle") return answer("idle", "unassigned; prior verdict is not a new TASK");
  if (!h.task_id || h.task_id === "none" || !["ready", "in_progress", "review_required", "done"].includes(h.status)) {
    return answer("unknown", "invalid TASK/status");
  }
  if (s.issue.state !== "open") return answer("unknown", "closed Issue; resolve successor before counting");

  const events: { c: Comment; f: Record<string, string>; t: number }[] = [];
  for (const c of s.comments) {
    let f: Record<string, string>;
    try {
      f = fields(c.body);
    } catch {
      return answer("unknown", `ambiguous comment ${c.id}`);
    }
    if (f.task_id !== h.task_id) continue;
    // A missing slot is tolerated for legacy REPORT/HISTORY/ACCEPT on this fixed Issue.
    if (f.slot && f.slot !== s.slot) return answer("unknown", `same task_id / wrong slot ${c.id}`);
    const type = (f.type || "").toUpperCase();
    if (
      !["STARTED", "HEARTBEAT", "EXITED", "STOPPED", "REPORT", "STOP REPORT", "HISTORY", "ACCEPT", "QUEUED"].includes(
        type,
      )
    ) continue;
    f.type = type;
    const t = ms(c.created_at);
    if (!Number.isFinite(t) || t > now + 5000) return answer("unknown", `invalid/future event time ${c.id}`);
    if (["STARTED", "HEARTBEAT", "EXITED", "STOPPED", "QUEUED"].includes(type)) {
      if (!f.run_id || !f.task_sha256 || f.task_sha256 !== digest(s.issue.body)) {
        // Legacy STARTED is still useful evidence of a start, but cannot prove a fresh lease.
        if (type !== "STARTED") return answer("unknown", `unbound runtime event ${c.id}`);
      }
    }
    events.push({ c, f, t });
  }
  events.sort((a, b) => a.t - b.t || String(a.c.id).localeCompare(String(b.c.id), undefined, { numeric: true }));
  const covered = (e: typeof events[number]) =>
    s.complete || (s.tail_from_id !== undefined && Number(e.c.id) >= s.tail_from_id);
  const reports = events.filter((e) => ["REPORT", "STOP REPORT"].includes(e.f.type));
  const report = reports.at(-1);
  const start = events.filter((e) => e.f.type === "STARTED").at(-1);
  const end = events.filter((e) => ["EXITED", "STOPPED"].includes(e.f.type)).at(-1);
  if (report && (!start || report.t >= start.t)) {
    if (!covered(report)) {
      return answer("unknown", "current REPORT predates verified comment tail; audit needed", [report.c.id]);
    }
    if (stopped(report.f) || report.f.type === "STOP REPORT") {
      return answer(
        "stopped",
        "REPORT stopped/changes required",
        [report.c.id],
        h.status === "ready" || h.status === "in_progress",
      );
    }
    const history = events.filter((e) => e.f.type === "HISTORY" && e.t >= report.t).at(-1);
    const accept = events.filter((e) => e.f.type === "ACCEPT" && e.t >= report.t).at(-1);
    if (accept && stopped(accept.f)) return answer("stopped", "ACCEPT rejects completion", [report.c.id, accept.c.id]);
    if (
      history && accept &&
      ((accept.f.report && !accept.f.report.endsWith(`#issuecomment-${report.c.id}`)) ||
        (accept.f.history && !accept.f.history.endsWith(`#issuecomment-${history.c.id}`)))
    ) return answer("unknown", "ACCEPT links disagree with same-task evidence", [accept.c.id]);
    if (history && accept && accept.t >= history.t && accepted(accept.f)) {
      return answer(
        "done",
        "same-task REPORT → HISTORY → ACCEPT",
        [report.c.id, history.c.id, accept.c.id],
        h.status !== "done",
      );
    }
    return answer("waiting", `${s.slot.startsWith("G") ? "K" : "C"}${s.slot.slice(1)}待ち; acceptance not proven`, [
      report.c.id,
    ], h.status !== "review_required");
  }
  if (h.status === "done") return answer("unknown", "done lacks same-task acceptance chain");
  if (end && (!start || end.t >= start.t)) {
    if (!covered(end)) return answer("unknown", "runtime end predates verified tail; audit needed");
    return answer(
      end.f.type === "STOPPED" ? "stopped" : "unknown",
      end.f.type === "STOPPED" ? "runtime stopped" : "runtime exited; REPORT unconfirmed",
      [end.c.id],
    );
  }
  if (start) {
    if (!covered(start)) return answer("unknown", "STARTED predates verified comment tail; audit needed", [start.c.id]);
    if (!["ready", "in_progress"].includes(h.status)) {
      return answer("unknown", "runtime start conflicts with TASK status", [start.c.id]);
    }
    const runs = new Set(
      events.filter((e) => e.f.type === "STARTED" && e.t > (end?.t || 0)).map((e) => e.f.run_id || String(e.c.id)),
    );
    if (runs.size > 1) return answer("unknown", "overlapping runtime sessions");
    const pulses = events.filter((e) =>
      ["STARTED", "HEARTBEAT"].includes(e.f.type) && e.f.run_id === start.f.run_id && e.t >= start.t
    );
    const pulse = pulses.at(-1)!;
    const beat = ms(pulse.f.heartbeat_at || pulse.f.started_at);
    const serverTime = ms(pulse.c.updated_at || pulse.c.created_at);
    if (
      !start.f.run_id || start.f.task_sha256 !== digest(s.issue.body) || !Number.isFinite(beat) ||
      !Number.isFinite(serverTime) || beat > now + 5000 ||
      serverTime > now + 5000 || Math.abs(beat - serverTime) > 30000 || now - beat > ttlSeconds * 1000
    ) {
      return answer("unknown", "STARTED seen; heartbeat expired/invalid or TASK changed", [start.c.id, pulse.c.id]);
    }
    return answer(
      "running",
      "STARTED + fresh same-run heartbeat",
      [start.c.id, pulse.c.id],
      h.status !== "in_progress",
    );
  }
  const queued = events.filter((e) => e.f.type === "QUEUED").at(-1);
  if (h.status === "ready" && queued && covered(queued)) {
    return answer("before", "instrumented queue; no STARTED after queue", [queued.c.id]);
  }
  if (!s.complete) return answer("unknown", "comment coverage incomplete; no negative inference");
  return answer(
    "unknown",
    h.status === "ready" ? "ready only; runtime instrumentation/start unconfirmed" : "no matching lifecycle evidence",
  );
}
