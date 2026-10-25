import { ghTransport, type Transport } from "../../scripts/agent_v3/github_backend.ts";
import { type Comment, digest, REPO, type Slot, SLOTS, type Snapshot, task } from "./model.ts";
export type API = (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => unknown;
// V3 transport keeps credentials in gh. Fixed repository only, no token handling here.
export function api(transport: Transport = ghTransport()): API {
  return (method, path, body) => {
    const r = transport(method, `repos/${REPO}/${path}`, body);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`GitHub ${method} ${path}: HTTP ${r.status}; no automatic write retry`);
    }
    return JSON.parse(r.text);
  };
}
function validateIssue(raw: unknown, n: number): Snapshot["issue"] {
  const i = raw as Snapshot["issue"];
  if (
    i.number !== n || typeof i.body !== "string" || !Number.isSafeInteger(i.comments) || i.comments < 0 ||
    typeof i.updated_at !== "string"
  ) throw new Error("invalid Issue response");
  return i;
}
function validateComment(raw: unknown): Comment {
  const c = raw as Comment;
  if (!Number.isSafeInteger(c.id) || typeof c.body !== "string" || typeof c.created_at !== "string") {
    throw new Error("invalid comment response");
  }
  return c;
}
// Follow only an explicit CLOSED predecessor -> successor link with a reciprocal
// predecessor link and matching slot / next generation. Never guess an Issue number.
export function resolveIssue(slot: Slot, call: API) {
  const chain: number[] = [SLOTS[slot]];
  let issue = validateIssue(call("GET", `issues/${chain[0]}`), chain[0]);
  while (issue.state === "closed") {
    const h = task(issue.body);
    const links = [
      ...issue.body.matchAll(
        new RegExp(`^- (?:successor_issue|next_issue_url): https://github\\.com/${REPO}/issues/(\\d+)\\s*$`, "gm"),
      ),
    ];
    if (links.length !== 1 || h.completed_tasks_in_generation !== "50" || h.generation_limit !== "50") {
      throw new Error("closed generation lacks one verified successor link");
    }
    const n = Number(links[0][1]);
    if (chain.includes(n) || chain.length >= 10) throw new Error("successor cycle/depth limit");
    const next = validateIssue(call("GET", `issues/${n}`), n), nh = task(next.body);
    const generation = Number(h.issue_generation?.match(/-(\d+)$/)?.[1]);
    if (
      h.slot !== slot || nh.slot !== slot ||
      nh.predecessor_issue !== `https://github.com/${REPO}/issues/${issue.number}` ||
      nh.issue_generation !== `${slot}-${String(generation + 1).padStart(2, "0")}`
    ) throw new Error("successor reciprocal slot/generation mismatch");
    const reread = validateIssue(call("GET", `issues/${issue.number}`), issue.number);
    if (reread.body !== issue.body || reread.state !== "closed" || reread.updated_at !== issue.updated_at) {
      throw new Error("predecessor changed during successor read-back");
    }
    chain.push(n);
    issue = next;
  }
  return { issue, chain };
}
// Bounded tail by default. --audit explicitly requests completeness. Never infer absence from a tail.
// Known IDs referenced by this Issue are refreshed individually, so edited ACCEPT/REPORTs are not cached.
export function collect(slot: Slot, call: API, audit = false): Snapshot {
  const n = SLOTS[slot];
  const fallback: Snapshot = {
    slot,
    issue: { number: n, body: "", comments: 0, updated_at: "", state: "open" },
    comments: [],
    complete: false,
    observed_at: new Date().toISOString(),
  };
  try {
    const resolved = resolveIssue(slot, call);
    const first = resolved.issue;
    const n = first.number;
    const pages = Math.max(1, Math.ceil(first.comments / 100));
    if (pages > 20) throw new Error("comment audit limit exceeded; inspect generation");
    const comments = new Map<number, Comment>();
    let tailFrom: number | undefined;
    for (let p = audit ? 1 : pages; p <= pages; p++) {
      const cs = call("GET", `issues/${n}/comments?per_page=100&page=${p}`);
      if (!Array.isArray(cs)) throw new Error("invalid comment page");
      for (const c of cs) comments.set(validateComment(c).id as number, c);
      if (p === pages && cs.length) tailFrom = Math.min(...cs.map((c) => Number(c.id)));
    }
    const ids = new Set(
      [...first.body.matchAll(new RegExp(`https://github\\.com/${REPO}/issues/${n}#issuecomment-(\\d+)`, "g"))].map(
        (m) => Number(m[1]),
      ),
    );
    for (const id of ids) {
      const c = validateComment(call("GET", `issues/comments/${id}`));
      if (c.id !== id || c.issue_url !== `https://api.github.com/repos/${REPO}/issues/${n}`) {
        throw new Error("comment provenance mismatch");
      }
      comments.set(id, c);
    }
    const last = validateIssue(call("GET", `issues/${n}`), n);
    if (first.body !== last.body || first.updated_at !== last.updated_at || first.comments !== last.comments) {
      throw new Error("Issue changed during collection; fresh read required");
    }
    return {
      slot,
      issue: last,
      generation_chain: resolved.chain,
      tail_from_id: tailFrom,
      comments: [...comments.values()],
      complete: comments.size === last.comments,
      observed_at: new Date().toISOString(),
    };
  } catch (e) {
    return { ...fallback, error: (e as Error).message };
  }
}
export function startGate(slot: Slot, taskId: string, call: API) {
  const i = resolveIssue(slot, call).issue;
  const h = task(i.body);
  if (h.slot !== slot || h.task_id !== taskId || !["ready", "in_progress"].includes(h.status) || i.state !== "open") {
    throw new Error("start gate: TASK/slot/status mismatch");
  }
  return i;
}
export function publish(slot: Slot, body: string, call: API, heartbeatId?: number): Comment {
  // Writes are limited to this session's lifecycle comments, never Issue bodies or another slot.
  const f = task(body);
  if (!["STARTED", "HEARTBEAT", "EXITED", "STOPPED", "QUEUED"].includes(f.type)) {
    throw new Error("unsupported event write");
  }
  const issue = startGate(slot, f.task_id, call);
  if (f.slot !== slot || f.task_sha256 !== digest(issue.body)) throw new Error("event TASK binding mismatch");
  if (heartbeatId) {
    const old = validateComment(call("GET", `issues/comments/${heartbeatId}`));
    const of = task(old.body);
    if (
      old.issue_url !== `https://api.github.com/repos/${REPO}/issues/${issue.number}` || of.type !== "HEARTBEAT" ||
      of.run_id !== f.run_id || of.task_id !== f.task_id || of.slot !== slot
    ) throw new Error("heartbeat ownership mismatch");
  }
  const c = validateComment(
    call(
      heartbeatId ? "PATCH" : "POST",
      heartbeatId ? `issues/comments/${heartbeatId}` : `issues/${issue.number}/comments`,
      { body },
    ),
  );
  const back = validateComment(call("GET", `issues/comments/${c.id}`));
  if (
    back.id !== c.id || back.body !== body ||
    back.issue_url !== `https://api.github.com/repos/${REPO}/issues/${issue.number}`
  ) throw new Error("event read-back mismatch; STOP and reconcile before retry");
  return back;
}
