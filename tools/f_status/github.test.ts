import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { type API, api, collect, publish } from "./github.ts";
import { eventBody, queueSession, runSession, verifyWorktree } from "./record.ts";
import { classify, type Comment } from "./model.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function world() {
  const issue = {
    number: 306,
    body: "# TASK\n- slot: H1\n- task_id: task-a\n- status: ready\n",
    comments: 0,
    state: "open",
    updated_at: new Date().toISOString(),
  };
  const cs: Comment[] = [], calls: { method: string; path: string }[] = [];
  const call: API = (method, path, data: unknown) => {
    calls.push({ method, path });
    if (path === "issues/306") return { ...issue };
    if (method === "GET" && path.startsWith("issues/306/comments?")) {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      return cs.slice((page - 1) * 100, page * 100).map((c) => ({ ...c }));
    }
    if (method === "POST") {
      const c = {
        id: cs.length + 1,
        body: (data as { body: string }).body,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        issue_url: "https://api.github.com/repos/anohi-memories/kabumori/issues/306",
      };
      cs.push(c);
      issue.comments++;
      return { ...c };
    }
    const c = cs.find((c) => path === `issues/comments/${c.id}`);
    if (!c) throw new Error("missing mock resource");
    if (method === "PATCH") {
      c.body = (data as { body: string }).body;
      c.updated_at = new Date().toISOString();
    }
    return { ...c };
  };
  return { issue, cs, calls, call };
}
test("tail does not claim completeness; explicit audit includes every page once", () => {
  const w = world();
  w.cs.push(
    ...Array.from({ length: 164 }, (_, n) => ({ id: n + 1, body: "note", created_at: new Date().toISOString() })),
  );
  w.issue.comments = 164;
  const tail = collect("H1", w.call);
  assert.equal(tail.complete, false);
  assert.equal(tail.comments.length, 64);
  const full = collect("H1", w.call, true);
  assert.equal(full.complete, true);
  assert.equal(full.comments.length, 164);
  assert.ok(w.calls.every((c) => c.method === "GET"));
});
test("collection invalidates concurrent TASK/count change and retrieval failure", () => {
  const w = world();
  let reads = 0;
  const changed: API = (m, p, b) => {
    const r = w.call(m, p, b) as typeof w.issue;
    if (p === "issues/306" && ++reads === 2) r.body += "different";
    return r;
  };
  assert.match(collect("H1", changed).error!, /changed/);
  assert.match(
    collect("H1", () => {
      throw new Error("offline");
    }).error!,
    /offline/,
  );
});
test("known comment ID is direct GET and mismatched provenance refuses", () => {
  const w = world();
  w.issue.body += "\n## Evidence\nhttps://github.com/anohi-memories/kabumori/issues/306#issuecomment-5";
  w.cs.push({
    id: 5,
    body: "note",
    created_at: new Date().toISOString(),
    issue_url: "https://api.github.com/repos/anohi-memories/kabumori/issues/329",
  });
  w.issue.comments = 1;
  assert.match(collect("H1", w.call).error!, /provenance/);
  assert.ok(w.calls.some((c) => c.path === "issues/comments/5"));
});
test("lifecycle write rereads gate, readback, one mutable owned heartbeat only", () => {
  const w = world();
  const start = eventBody("STARTED", "H1", "task-a", "run-a", w.issue.body);
  publish("H1", start, w.call);
  const beat = eventBody("HEARTBEAT", "H1", "task-a", "run-a", w.issue.body);
  const c = publish("H1", beat, w.call);
  publish("H1", beat, w.call, Number(c.id));
  assert.equal(w.cs.length, 2);
  assert.throws(() => publish("H1", beat.replace("run-a", "run-b"), w.call, Number(c.id)), /ownership/);
  assert.throws(() => publish("H1", start.replace("task-a", "wrong"), w.call), /gate/);
  assert.ok(
    w.calls.filter((c) => c.method !== "GET").every((c) =>
      c.path === "issues/306/comments" || c.path === "issues/comments/2"
    ),
  );
});
test("uncertain write is never automatically retried", () => {
  const w = world();
  let posts = 0;
  const uncertain: API = (m, p, b) => {
    if (m === "POST") {
      posts++;
      throw new Error("uncertain");
    }
    return w.call(m, p, b);
  };
  assert.throws(() => publish("H1", eventBody("STARTED", "H1", "task-a", "run-a", w.issue.body), uncertain));
  assert.equal(posts, 1);
  assert.throws(() => api(() => ({ status: 0, text: "timeout" }))("GET", "issues/306"), /HTTP 0/);
});
test("real fake-process lifecycle emits STARTED, automatic heartbeat, EXITED; REPORT remains separate", async () => {
  const w = world(), dir = mkdtempSync(join(tmpdir(), "f15-session-"));
  try {
    const r = await runSession({
      slot: "H1",
      taskId: "task-a",
      directory: dir,
      command: [process.execPath, "-e", "setTimeout(()=>{},220)"],
      call: w.call,
      live: false,
      gatePassed: true,
      worktreeEvidence: () => ({ head: "a".repeat(40), branch: "fixture" }),
      intervalMs: 50,
    });
    const events = readFileSync(r.path, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    assert.equal(events[0].body.split("\n")[0], "type: STARTED");
    assert.ok(events.some((e) => e.body.startsWith("type: HEARTBEAT")));
    assert.ok(events.at(-1).body.startsWith("type: EXITED"));
    assert.ok(!events.some((e) => e.body.startsWith("type: REPORT")));
    const s = collect("H1", w.call);
    s.comments = events;
    s.complete = true;
    assert.equal(classify(s).state, "unknown");
    assert.ok(w.calls.every((c) => c.method === "GET"));
    await assert.rejects(
      runSession({
        slot: "H1",
        taskId: "task-a",
        directory: dir,
        command: [process.execPath, "-e", ""],
        call: w.call,
        live: false,
        gatePassed: true,
        worktreeEvidence: () => ({ head: "a".repeat(40), branch: "fixture" }),
      }),
      /EEXIST/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("launch failure cannot emit STARTED; G10 autostart and missing gates rejected", async () => {
  const w = world(), dir = mkdtempSync(join(tmpdir(), "f15-no-spawn-"));
  const opts = {
    slot: "H1" as const,
    taskId: "task-a",
    directory: dir,
    command: ["/nonexistent/f15-agent"],
    call: w.call,
    live: false,
    gatePassed: true,
    worktreeEvidence: () => ({ head: "a".repeat(40), branch: "fixture" }),
  };
  try {
    await assert.rejects(runSession({ ...opts, slot: "G10" }), /G10/);
    await assert.rejects(runSession({ ...opts, gatePassed: false }), /acknowledgement/);
    await assert.rejects(runSession(opts), /ENOENT/);
    assert.ok(w.calls.every((c) => c.method === "GET"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("nonzero fake agent exit emits STOPPED", async () => {
  const w = world(), dir = mkdtempSync(join(tmpdir(), "f15-stop-"));
  try {
    const r = await runSession({
      slot: "H1",
      taskId: "task-a",
      directory: dir,
      command: [process.execPath, "-e", "process.exit(2)"],
      call: w.call,
      live: false,
      gatePassed: true,
      worktreeEvidence: () => ({ head: "a".repeat(40), branch: "fixture" }),
    });
    assert.equal(r.code, 2);
    assert.match(readFileSync(r.path, "utf8"), /type: STOPPED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("closed generations follow explicit reciprocal successor, failures stay unknown", () => {
  const old = {
    number: 317,
    body:
      "# G2-01\n- slot: G2\n- issue_generation: G2-01\n- completed_tasks_in_generation: 50\n- generation_limit: 50\n\n## Closed\n- successor_issue: https://github.com/anohi-memories/kabumori/issues/532\n",
    state: "closed",
    comments: 0,
    updated_at: new Date().toISOString(),
  };
  const next = {
    ...old,
    number: 532,
    state: "open",
    body:
      "# G2-02\n- slot: G2\n- issue_generation: G2-02\n- task_id: none\n- status: idle\n- predecessor_issue: https://github.com/anohi-memories/kabumori/issues/317\n",
  };
  const call: API = (m, p) => {
    assert.equal(m, "GET");
    if (p === "issues/317") return { ...old };
    if (p === "issues/532") return { ...next };
    if (p.includes("/comments?")) return [];
    throw new Error("unexpected request");
  };
  const s = collect("G2", call);
  assert.equal(s.issue.number, 532);
  assert.deepEqual(s.generation_chain, [317, 532]);
  assert.equal(classify(s).state, "idle");
  next.body = next.body.replace("issues/317", "issues/999");
  assert.match(collect("G2", call).error!, /reciprocal/);
});
test("queue is explicit rollout only, never starts an agent, duplicate lifecycle refused", () => {
  const w = world();
  const body = queueSession("H1", "task-a", w.call);
  assert.match(String(body), /type: QUEUED/);
  assert.ok(w.calls.every((c) => c.method === "GET"));
  queueSession("H1", "task-a", w.call, true);
  assert.equal(classify(collect("H1", w.call)).state, "before");
  assert.throws(() => queueSession("H1", "task-a", w.call), /existing lifecycle/);
});
test("runtime verifies clean dedicated worktree, refusing shared main and dirty files", () => {
  const dir = mkdtempSync(join(tmpdir(), "f15-git-")), repo = join(dir, "base"), wt = join(dir, "session");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", repo);
    git(
      "-C",
      repo,
      "-c",
      "user.name=F15 Fixture",
      "-c",
      "user.email=f15@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    assert.throws(() => verifyWorktree(repo), /dedicated linked/);
    git("-C", repo, "worktree", "add", "-b", "fixture-session", wt);
    assert.equal(verifyWorktree(wt).branch, "fixture-session");
    writeFileSync(join(wt, "dirty.txt"), "fixture");
    assert.throws(() => verifyWorktree(wt), /clean worktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
