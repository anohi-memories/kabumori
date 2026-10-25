import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest, fields, type Slot } from "./model.ts";
import { type API, collect, publish, startGate } from "./github.ts";

export function eventBody(
  type: string,
  slot: Slot,
  taskId: string,
  run: string,
  body: string,
  extra: Record<string, string> = {},
) {
  const now = new Date().toISOString();
  return Object.entries({
    type,
    slot,
    task_id: taskId,
    run_id: run,
    task_sha256: digest(body),
    ...(type === "STARTED" ? { started_at: now } : {}),
    heartbeat_at: now,
    ...extra,
  }).map(([k, v]) => `${k}: ${v}`).join("\n");
}
// Explicit invocation around an ALREADY AUTHORIZED agent command. No scheduler or auto-dispatch.
// G10 uses its own supervisor; this wrapper cannot launch it or touch its runtime state.
export async function runSession(
  opts: {
    slot: Slot;
    taskId: string;
    directory: string;
    command: string[];
    call: API;
    live: boolean;
    gatePassed: boolean;
    intervalMs?: number;
    worktreeEvidence?: (directory: string) => { head: string; branch: string };
  },
) {
  if (opts.slot === "G10") throw new Error("G10 launch belongs to its existing supervisor; use event integration only");
  if (!opts.gatePassed || !opts.command.length) {
    throw new Error("explicit start-gate acknowledgement and command required");
  }
  const interval = opts.intervalMs ?? 60000;
  if (!Number.isFinite(interval) || interval < 50 || (opts.live && interval < 60000)) {
    throw new Error("invalid heartbeat interval");
  }
  const i = startGate(opts.slot, opts.taskId, opts.call);
  const dir = realpathSync(opts.directory);
  const evidence = (opts.worktreeEvidence ?? verifyWorktree)(dir);
  // Caller confirms ownership; the tool verifies a clean dedicated worktree before touching its own records.
  mkdirSync(join(dir, ".f-status"), { recursive: true, mode: 0o700 });
  if (lstatSync(join(dir, ".f-status")).isSymbolicLink()) {
    throw new Error("runtime record directory must not be a symlink");
  }
  const ignore = join(dir, ".f-status", ".gitignore");
  try {
    writeFileSync(ignore, "*\n", { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const lock = join(dir, ".f-status", "session.lock");
  const fd = openSync(lock, "wx", 0o600);
  closeSync(fd);
  // Do not silently remove stale locks: operator reconciles uncertain previous sessions first.
  const run = randomUUID(), path = join(dir, ".f-status", `${run}.jsonl`);
  writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  writeFileSync(lock, JSON.stringify({ slot: opts.slot, task_id: opts.taskId, run_id: run }) + "\n", { mode: 0o600 });
  let heartbeatId: number | undefined;
  let stopped = false;
  const emit = (type: string, extra: Record<string, string> = {}) => {
    const body = eventBody(type, opts.slot, opts.taskId, run, i.body, extra);
    appendFileSync(path, JSON.stringify({ body, created_at: new Date().toISOString(), id: randomUUID() }) + "\n");
    if (opts.live) {
      const fresh = startGate(opts.slot, opts.taskId, opts.call);
      if (digest(fresh.body) !== digest(i.body)) throw new Error("TASK changed during session");
      const c = publish(opts.slot, body, opts.call, type === "HEARTBEAT" ? heartbeatId : undefined);
      if (type === "HEARTBEAT") heartbeatId = Number(c.id);
    }
  };
  const child = spawn(opts.command[0], opts.command.slice(1), { cwd: dir, stdio: "inherit", shell: false });
  // spawn event proves the executable actually started, not merely that a start code was sent.
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  let recordingError: unknown;
  const guarded = (type: string, extra?: Record<string, string>) => {
    try {
      emit(type, extra);
    } catch (e) {
      recordingError = e;
      stopped = true;
    }
  };
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal }))
  );
  guarded("STARTED", {
    executor: opts.slot.startsWith("G") ? "claude" : "codex",
    worktree: dir,
    head: evidence.head,
    branch: evidence.branch,
    independence: "dedicated-worktree / owner-confirmed",
    pid: String(child.pid),
  });
  const timer = setInterval(() => {
    if (!stopped) guarded("HEARTBEAT");
  }, interval);
  // A telemetry failure stops publishing, never kills/restarts the user's agent or fabricates REPORT.
  const relay = (signal: NodeJS.Signals) => child.kill(signal);
  const onInt = () => relay("SIGINT"), onTerm = () => relay("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let result;
  try {
    result = await exit;
  } finally {
    clearInterval(timer);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  if (!recordingError) {
    guarded(result.code === 0 ? "EXITED" : "STOPPED", {
      exit_code: String(result.code),
      signal: result.signal || "none",
    });
  }
  // Lock intentionally records completion too. Explicit reconcile prevents accidental duplicate sessions.
  writeFileSync(
    lock,
    JSON.stringify({
      slot: opts.slot,
      task_id: opts.taskId,
      run_id: run,
      ended_at: new Date().toISOString(),
      recording_error: !!recordingError,
    }) + "\n",
    { mode: 0o600 },
  );
  if (recordingError) throw new Error("lifecycle publish uncertain/failed; inspect outbox and GitHub before retry");
  return { run_id: run, path, ...result };
}

export function verifyWorktree(dir: string) {
  dir = realpathSync(dir);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("cannot verify worktree");
    return r.stdout.trim();
  };
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== dir) throw new Error("worktree root required");
  // A linked worktree has its own git dir, unlike the main checkout (the shared clean base).
  if (
    realpathSync(git("rev-parse", "--absolute-git-dir")) ===
      realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"))
  ) throw new Error("dedicated linked worktree required; never run in shared main checkout");
  if (git("status", "--porcelain")) throw new Error("clean worktree required");
  const head = git("rev-parse", "HEAD"), branch = git("symbolic-ref", "--short", "HEAD");
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("invalid HEAD");
  return { head, branch };
}

// Called at registration/dispatch preparation, never starts an agent. An absent STARTED
// without this explicit protocol adoption is NOT proof that a legacy session is unstarted.
export function queueSession(slot: Slot, taskId: string, call: API, live = false) {
  const s = collect(slot, call, true);
  const h = fields(s.issue.body);
  if (s.error || !s.complete || h.status !== "ready" || h.task_id !== taskId || h.slot !== slot) {
    throw new Error("queue requires a fresh ready TASK with complete comment coverage");
  }
  if (
    s.comments.some((c) => {
      const f = fields(c.body);
      return f.task_id === taskId && ["STARTED", "REPORT", "STOP REPORT", "QUEUED"].includes(f.type);
    })
  ) throw new Error("existing lifecycle; reconcile instead of queuing");
  const body = eventBody("QUEUED", slot, taskId, randomUUID(), s.issue.body, {
    executor: "chatgpt",
    protocol: "explicit-opt-in-all-starts-instrumented",
  });
  return live ? publish(slot, body, call) : body;
}
