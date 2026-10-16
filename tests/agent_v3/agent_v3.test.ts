import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitBackend } from "../../scripts/agent_v3/git_backend.ts";
import { GitHubBackend, type Transport } from "../../scripts/agent_v3/github_backend.ts";
import {
  catalog,
  deriveIndex,
  indexPath,
  initRoot,
  parseHeader,
  planArchive,
  PlanError,
  planTaskWrite,
  type SlotDef,
  verifyRoot,
} from "../../scripts/agent_v3/registry.ts";
import { type Backend, MAIN_REF, redact, RefusedError, runTransaction, TransportError } from "../../scripts/agent_v3/transaction.ts";

// Every scenario runs against throwaway repositories in a temp directory: a bare "remote" and clones of it.
// Nothing here touches the real repository, GitHub, or any slot.

const ROOT = ".agent_v3_fixture";
const DEFS = catalog(ROOT, "FJ");

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

type World = { dir: string; remote: string; a: string; b: string; cleanup: () => void };

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "agent-v3-test-"));
  const remote = join(dir, "remote.git");
  spawnSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  const clone = (name: string) => {
    const p = join(dir, name);
    spawnSync("git", ["clone", "--quiet", remote, p]);
    sh(p, "config", "user.name", "agent-v3-test");
    sh(p, "config", "user.email", "agent-v3-test@example.invalid");
    sh(p, "config", "commit.gpgsign", "false");
    return p;
  };
  const a = clone("a");
  spawnSync("sh", ["-c", "echo seed > README.md"], { cwd: a });
  sh(a, "add", "README.md");
  sh(a, "commit", "--quiet", "-m", "seed");
  sh(a, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const b = clone("b");
  const out: World = { dir, remote, a, b, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  const init = runTransaction(new GitBackend(a), DEFS, MAIN_REF, () => ({
    files: initRoot(DEFS, ROOT),
    expectations: new Map(),
    message: "init fixture root",
  }));
  assert.equal(init.code, "REGISTERED_ON_MAIN");
  sh(b, "fetch", "--quiet", "origin"); // the second writer has seen the initialised base, as a real one would
  return out;
}

function def(slot: string): SlotDef {
  return DEFS.find((d) => d.slot === slot)!;
}

function task(slot: string, f: { id: string; status: string; next: string; returnTo?: string; result?: string; extra?: string }): string {
  const d = def(slot);
  return [
    `# ${slot} — fixture task`,
    "",
    `- task_id: ${f.id}`,
    `- owner: ${d.owner}`,
    `- slot: ${slot}`,
    `- status: ${f.status}`,
    `- next_owner: ${f.next}`,
    `- start_code: ${slot}`,
    `- completion_code: ${d.completionCode}`,
    `- return_to: ${f.returnTo ?? "fixture-room"}`,
    "- recommended_model: Opus5.5（高）",
    "",
    "## 目的",
    "",
    f.extra ?? "fixture",
    "",
    "## Report",
    "",
    `- result: ${f.result ?? "not_started"}`,
    "",
  ].join("\n");
}

function headAt(w: World): string {
  return sh(w.a, "ls-remote", w.remote, MAIN_REF).split(/\s+/)[0];
}

function readAt(w: World, commit: string): (p: string) => string | null {
  return (p) => {
    const r = spawnSync("git", ["-C", w.a, "cat-file", "blob", `${commit}:${p}`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  };
}

function freshRead(w: World): (p: string) => string | null {
  sh(w.a, "fetch", "--quiet", "origin");
  return readAt(w, headAt(w));
}

function write(backend: Backend, slot: string, text: string, expect: { task_id: string; status: string }, ref = MAIN_REF) {
  return runTransaction(backend, DEFS, ref, (read) => planTaskWrite(DEFS, ROOT, read, slot, text, expect, null, `fixture ${slot}`));
}

function changedFiles(w: World, commit: string): string[] {
  return sh(w.a, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean);
}

// Wraps a backend so its first head() answer is an older commit: the caller plans on a stale base exactly as
// a second writer would if another writer published in between.
function staleFirstHead(inner: Backend, stale: string): Backend {
  let first = true;
  return {
    name: "stale-first",
    head: (ref) => (first ? ((first = false), stale) : inner.head(ref)),
    read: (c, p) => inner.read(c, p),
    commit: (b, f, m) => inner.commit(b, f, m),
    publish: (r, n, e) => inner.publish(r, n, e),
    contains: (h, c) => inner.contains(h, c),
  };
}

test("normal lifecycle: assign -> start -> report -> accept -> archive, each one atomic commit", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const id = "fixture-f1-normal-lifecycle-20261016";
    const steps: [string, { task_id: string; status: string }][] = [
      [task("F1", { id, status: "ready", next: "claude" }), { task_id: "none", status: "idle" }],
      [task("F1", { id, status: "in_progress", next: "claude" }), { task_id: id, status: "ready" }],
      [task("F1", { id, status: "review_required", next: "chatgpt", result: "PASS fixture" }), { task_id: id, status: "in_progress" }],
      [task("F1", { id, status: "done", next: "none", result: "PASS fixture" }), { task_id: id, status: "review_required" }],
    ];
    for (const [text, expect] of steps) {
      const before = headAt(w);
      const out = write(g, "F1", text, expect);
      assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
      assert.equal(out.registered, true);
      assert.equal(sh(w.a, "rev-list", "--count", `${before}..${out.commit}`), "1");
      assert.deepEqual(changedFiles(w, out.commit!).sort(), [indexPath(ROOT), def("F1").taskPath].sort());
      assert.deepEqual(verifyRoot(DEFS, freshRead(w), ROOT, true), []);
    }
    const doneCommit = headAt(w);
    const doneTask = readAt(w, doneCommit)(def("F1").taskPath)!;
    const out = runTransaction(g, DEFS, MAIN_REF, (read, base) => planArchive(DEFS, ROOT, read, "F1", id, base, "2026-10-16"));
    assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
    const read = freshRead(w);
    const dir = `${ROOT}/archive/2026-10-16-F1-${id}`;
    const archived = read(`${dir}/files/${def("F1").taskPath}`)!;
    assert.equal(archived, doneTask, "archive is a byte copy of the done TASK");
    const sums = read(`${dir}/SHA256SUMS`)!;
    assert.equal(sums, `${createHash("sha256").update(doneTask).digest("hex")}  files/${def("F1").taskPath}\n`);
    const manifest = JSON.parse(read(`${dir}/MANIFEST.json`)!);
    assert.equal(manifest.snapshot_commit, doneCommit);
    assert.match(read(`${ROOT}/HISTORY_INDEX.md`)!, new RegExp(`\\| F1 \\| ${id} \\| PASS fixture \\|`));
    assert.equal(parseHeader(read(def("F1").taskPath)).status, "idle");
    assert.deepEqual(verifyRoot(DEFS, read, ROOT, true), []);
    // Restore: the archived bytes reproduce the original file at its snapshot commit.
    assert.equal(archived, readAt(w, manifest.snapshot_commit)(def("F1").taskPath));
    assert.equal(sh(w.a, "rev-list", "--count", `${doneCommit}..${out.commit}`), "1");
  } finally {
    w.cleanup();
  }
});

test("parallel writers on different slots: the stale one re-plans on the new head and both land", () => {
  const w = world();
  try {
    const base = headAt(w);
    const a = write(new GitBackend(w.a), "F2", task("F2", { id: "fixture-f2-parallel-a-20261016", status: "ready", next: "claude" }), { task_id: "none", status: "idle" });
    assert.equal(a.code, "REGISTERED_ON_MAIN");
    const b = write(staleFirstHead(new GitBackend(w.b), base), "F3", task("F3", { id: "fixture-f3-parallel-b-20261016", status: "ready", next: "claude" }), { task_id: "none", status: "idle" });
    assert.equal(b.code, "REGISTERED_ON_MAIN", b.detail);
    assert.equal(b.attempts, 2);
    const read = freshRead(w);
    assert.equal(parseHeader(read(def("F2").taskPath)).task_id, "fixture-f2-parallel-a-20261016");
    assert.equal(parseHeader(read(def("F3").taskPath)).task_id, "fixture-f3-parallel-b-20261016");
    assert.deepEqual(verifyRoot(DEFS, read, ROOT, true), []);
  } finally {
    w.cleanup();
  }
});

test("same-slot race: the second writer is refused as a conflict and writes nothing", () => {
  const w = world();
  try {
    const base = headAt(w);
    const first = write(new GitBackend(w.a), "F4", task("F4", { id: "fixture-f4-first-writer-20261016", status: "ready", next: "claude" }), { task_id: "none", status: "idle" });
    assert.equal(first.code, "REGISTERED_ON_MAIN");
    const after = headAt(w);
    const second = write(staleFirstHead(new GitBackend(w.b), base), "F4", task("F4", { id: "fixture-f4-second-writer-20261016", status: "ready", next: "claude" }), { task_id: "none", status: "idle" });
    assert.equal(second.code, "CONFLICT_SAME_SLOT");
    assert.equal(second.attempts, 2, "planned fine on the stale base, refused after re-reading the new head");
    assert.equal(second.registered, false);
    assert.equal(headAt(w), after, "main unchanged by the refused writer");
    assert.equal(parseHeader(freshRead(w)(def("F4").taskPath)).task_id, "fixture-f4-first-writer-20261016");
  } finally {
    w.cleanup();
  }
});

test("a ref that keeps moving exhausts the bounded retries without writing", () => {
  const w = world();
  try {
    const inner = new GitBackend(w.a);
    const before = headAt(w);
    let publishes = 0;
    const moving: Backend = { ...wrap(inner), publish: () => ((publishes++), { ok: false, kind: "stale", detail: "non-fast-forward" }) };
    const out = write(moving, "F5", task("F5", { id: "fixture-f5-moving-ref-20261016", status: "ready", next: "claude" }), { task_id: "none", status: "idle" });
    assert.equal(out.code, "STALE_BASE_RETRY_EXHAUSTED");
    assert.equal(out.attempts, 3);
    assert.equal(publishes, 3);
    assert.equal(headAt(w), before);
  } finally {
    w.cleanup();
  }
});

function wrap(inner: Backend): Backend {
  return {
    name: inner.name,
    head: (r) => inner.head(r),
    read: (c, p) => inner.read(c, p),
    commit: (b, f, m) => inner.commit(b, f, m),
    publish: (r, n, e) => inner.publish(r, n, e),
    contains: (h, c) => inner.contains(h, c),
  };
}

test("a commit missing a planned file is detected before publishing (no partial registration)", () => {
  const w = world();
  try {
    const inner = new GitBackend(w.a);
    const before = headAt(w);
    let published = false;
    const dropping: Backend = {
      ...wrap(inner),
      commit: (b, files, m) => inner.commit(b, new Map([...files].filter(([p]) => !p.endsWith("ACTIVE_TASK.md"))), m),
      publish: (r, n, e) => ((published = true), inner.publish(r, n, e)),
    };
    const out = write(dropping, "F6", task("F6", { id: "fixture-f6-dropped-index-20261016", status: "ready", next: "claude" }), { task_id: "none", status: "idle" });
    assert.equal(out.code, "PARTIAL_DETECTED");
    assert.equal(published, false);
    assert.equal(headAt(w), before);
  } finally {
    w.cleanup();
  }
});

test("a legacy one-file write (TASK only) is detected, and the next V3 write re-derives the index", () => {
  const w = world();
  try {
    // Reproduce the Contents-API pattern: one commit that changes only the TASK file.
    const legacy = task("F7", { id: "fixture-f7-legacy-single-file-20261016", status: "ready", next: "claude" });
    const g = new GitBackend(w.a);
    const base = headAt(w);
    const c = g.commit(base, new Map([[def("F7").taskPath, legacy]]), "legacy: task only");
    assert.deepEqual(g.publish(MAIN_REF, c, base), { ok: true });
    const findings = verifyRoot(DEFS, freshRead(w), ROOT, true);
    assert.ok(findings.some((f) => f.slot === "F7" && f.kind === "INDEX_MISMATCH"), JSON.stringify(findings));
    assert.ok(findings.some((f) => f.kind === "INDEX_STALE"));
    // The TASK header is canonical, so any later V3 transaction rewrites the derived index from it.
    const out = write(g, "F8", task("F8", { id: "fixture-f8-after-legacy-20261016", status: "ready", next: "claude" }), { task_id: "none", status: "idle" });
    assert.equal(out.code, "REGISTERED_ON_MAIN");
    assert.deepEqual(verifyRoot(DEFS, freshRead(w), ROOT, true), []);
  } finally {
    w.cleanup();
  }
});

test("a platform refusal stops the run: no publish, no retry, no re-encoded content", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const id = "fixture-f9-refused-archive-20261016";
    for (const [text, expect] of [
      [task("F9", { id, status: "ready", next: "claude" }), { task_id: "none", status: "idle" }],
      [task("F9", { id, status: "in_progress", next: "claude" }), { task_id: id, status: "ready" }],
      [task("F9", { id, status: "review_required", next: "chatgpt" }), { task_id: id, status: "in_progress" }],
      [task("F9", { id, status: "done", next: "none" }), { task_id: id, status: "review_required" }],
    ] as const) assert.equal(write(g, "F9", text, expect).code, "REGISTERED_ON_MAIN");
    const before = headAt(w);
    let commits = 0;
    let published = false;
    const refusing: Backend = {
      ...wrap(g),
      commit: (b, files, m) => {
        commits++;
        if ([...files.keys()].some((p) => p.endsWith("SHA256SUMS"))) throw new RefusedError("simulated platform safety block on SHA256SUMS");
        return g.commit(b, files, m);
      },
      publish: (r, n, e) => ((published = true), g.publish(r, n, e)),
    };
    const out = runTransaction(refusing, DEFS, MAIN_REF, (read, base) => planArchive(DEFS, ROOT, read, "F9", id, base, "2026-10-16"));
    assert.equal(out.code, "REFUSED_STOPPED");
    assert.equal(out.attempts, 1);
    assert.equal(commits, 1);
    assert.equal(published, false);
    assert.match(out.detail, /SHA256SUMS/);
    assert.equal(headAt(w), before, "nothing of the archive reached main (no 3-of-4 files state)");
  } finally {
    w.cleanup();
  }
});

test("read-back mismatch: an overwrite right after publishing is not reported as registered", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const other = new GitBackend(w.b);
    const interloping: Backend = {
      ...wrap(g),
      publish: (r, n, e) => {
        const res = g.publish(r, n, e);
        const head = other.head(r);
        const c = other.commit(head, new Map([[def("J1").taskPath, task("J1", { id: "fixture-j1-interloper-20261016", status: "ready", next: "codex" })]]), "interloper");
        other.publish(r, c, head);
        return res;
      },
    };
    const out = write(interloping, "J1", task("J1", { id: "fixture-j1-intended-20261016", status: "ready", next: "codex" }), { task_id: "none", status: "idle" });
    assert.equal(out.code, "READBACK_MISMATCH");
    assert.equal(out.registered, false);
    assert.equal(out.readback!.J1.expected.task_id, "fixture-j1-intended-20261016");
    assert.equal(out.readback!.J1.actual.task_id, "fixture-j1-interloper-20261016");
  } finally {
    w.cleanup();
  }
});

test("writing to a branch other than main is never reported as registered", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const main = headAt(w);
    sh(w.a, "push", "--quiet", "origin", `${main}:refs/heads/fixture-branch`);
    const out = write(g, "J2", task("J2", { id: "fixture-j2-branch-only-20261016", status: "ready", next: "codex" }), { task_id: "none", status: "idle" }, "refs/heads/fixture-branch");
    assert.equal(out.code, "WRITTEN_TO_BRANCH_NOT_REGISTERED");
    assert.equal(out.registered, false);
    assert.equal(headAt(w), main, "main unchanged");
  } finally {
    w.cleanup();
  }
});

test("non-overwrite and validation rules refuse unsafe plans", () => {
  const files = initRoot(DEFS, ROOT);
  const read = (p: string) => files.get(p) ?? null;
  const set = (slot: string, text: string) => {
    files.set(def(slot).taskPath, text);
    files.set(indexPath(ROOT), deriveIndex(DEFS, read));
  };
  const kind = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof PlanError ? e.kind : String(e);
    }
    return "no-error";
  };
  set("F1", task("F1", { id: "fixture-f1-in-progress-20261016", status: "in_progress", next: "claude" }));
  assert.equal(kind(() => planTaskWrite(DEFS, ROOT, read, "F1", task("F1", { id: "fixture-f1-other-20261016", status: "ready", next: "claude" }), { task_id: "fixture-f1-in-progress-20261016", status: "in_progress" }, null, "m")), "occupied");
  set("F2", task("F2", { id: "fixture-f2-done-20261016", status: "done", next: "none" }));
  assert.equal(kind(() => planTaskWrite(DEFS, ROOT, read, "F2", task("F2", { id: "fixture-f2-next-20261016", status: "ready", next: "claude" }), { task_id: "fixture-f2-done-20261016", status: "done" }, null, "m")), "not_archived");
  const wrongCode = task("F3", { id: "fixture-f3-wrong-code-20261016", status: "ready", next: "claude" }).replace("completion_code: L3", "completion_code: L4");
  assert.equal(kind(() => planTaskWrite(DEFS, ROOT, read, "F3", wrongCode, { task_id: "none", status: "idle" }, null, "m")), "invalid");
  assert.equal(kind(() => planTaskWrite(DEFS, ROOT, read, "J3", task("J3", { id: "fixture-j3-no-return-20261016", status: "ready", next: "codex", returnTo: "none" }), { task_id: "none", status: "idle" }, null, "m")), "invalid");
  set("F4", task("F4", { id: "fixture-f4-ready-20261016", status: "ready", next: "claude" }));
  assert.equal(kind(() => planTaskWrite(DEFS, ROOT, read, "F4", task("F4", { id: "fixture-f4-ready-20261016", status: "done", next: "none" }), { task_id: "fixture-f4-ready-20261016", status: "ready" }, null, "m")), "invalid");
  assert.equal(kind(() => planTaskWrite(DEFS, ROOT, read, "F4", task("F4", { id: "fixture-f4-ready-20261016", status: "in_progress", next: "claude" }), { task_id: "fixture-f4-ready-20261016", status: "idle" }, null, "m")), "same_slot_conflict");
  assert.equal(kind(() => planArchive(DEFS, ROOT, read, "F4", "fixture-f4-ready-20261016", "0".repeat(40), "2026-10-16")), "same_slot_conflict");
});

test("verify flags a hand-edited derived index even when the key fields still match", () => {
  const files = initRoot(DEFS, ROOT);
  const read = (p: string) => files.get(p) ?? null;
  assert.deepEqual(verifyRoot(DEFS, read, ROOT, true), []);
  files.set(indexPath(ROOT), files.get(indexPath(ROOT))!.replace("## F1\n", "## F1\n- note: hand edit\n"));
  assert.deepEqual(verifyRoot(DEFS, read, ROOT, true).map((f) => f.kind), ["INDEX_HAND_EDITED"]);
});

test("GitHub backend maps a non-fast-forward ref update to a stale result and builds one commit", () => {
  const calls: string[] = [];
  let mainSha = "base";
  const transport: Transport = (method, path, body) => {
    calls.push(`${method} ${path.replace(/^repos\/o\/r\//, "")}`);
    if (method === "GET" && path.endsWith("git/ref/heads/main")) return { status: 200, text: JSON.stringify({ object: { sha: mainSha } }) };
    if (method === "GET" && path.endsWith("git/commits/base")) return { status: 200, text: JSON.stringify({ tree: { sha: "basetree" } }) };
    if (method === "POST" && path.endsWith("git/blobs")) return { status: 201, text: JSON.stringify({ sha: `blob${calls.length}` }) };
    if (method === "POST" && path.endsWith("git/trees")) {
      assert.equal((body as Record<string, unknown>).base_tree, "basetree");
      assert.equal((body as { tree: unknown[] }).tree.length, 2);
      return { status: 201, text: JSON.stringify({ sha: "tree1" }) };
    }
    if (method === "POST" && path.endsWith("git/commits")) {
      assert.deepEqual((body as Record<string, unknown>).parents, ["base"]);
      return { status: 201, text: JSON.stringify({ sha: "commit1" }) };
    }
    if (method === "PATCH") {
      assert.equal((body as Record<string, unknown>).force, false);
      return { status: 422, text: JSON.stringify({ message: "Update is not a fast forward" }) };
    }
    return { status: 500, text: "{}" };
  };
  const gh = new GitHubBackend("o/r", transport);
  const sha = gh.commit("base", new Map([["a.md", "A"], ["b.md", "B"]]), "m");
  assert.equal(sha, "commit1");
  assert.deepEqual(calls.filter((c) => c.startsWith("POST git/commits")).length, 1, "exactly one commit for two files");
  const res = gh.publish(MAIN_REF, sha, "base");
  assert.equal(res.ok, false);
  assert.equal(res.ok ? "ok" : res.kind, "stale", "server-side non-fast-forward (422) is stale");
  mainSha = "moved";
  const patches = calls.filter((c) => c.startsWith("PATCH")).length;
  const moved = gh.publish(MAIN_REF, sha, "base");
  assert.equal(moved.ok ? "ok" : moved.kind, "stale", "a ref that already moved is stale before any write");
  assert.equal(calls.filter((c) => c.startsWith("PATCH")).length, patches, "no PATCH when the pre-check fails");
  const refused = new GitHubBackend("o/r", () => ({ status: 0, text: "request blocked by policy" }));
  assert.throws(() => refused.head(MAIN_REF), RefusedError);
  const dropped = new GitHubBackend("o/r", () => ({ status: 0, text: 'Post "https://api.github.com/repos/o/r/git/blobs": unexpected EOF' }));
  assert.throws(() => dropped.head(MAIN_REF), TransportError, "a dropped connection is not reported as a refusal");
});

test("incident details never keep credential-like strings", () => {
  const text = redact("push failed: Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123 and github_pat_ABCDEFGHIJKLMNOPQRSTUV_xyz");
  assert.doesNotMatch(text, /ghp_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(text, /github_pat_[A-Za-z0-9_]{20,}/);
  assert.match(text, /\[REDACTED\]/);
});

test("a dropped connection before publishing stops without writing; after the publish request it is unverified", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const before = headAt(w);
    let published = false;
    const dropsOnCommit: Backend = {
      ...wrap(g),
      commit: () => {
        throw new TransportError("POST git/blobs: no HTTP response: unexpected EOF");
      },
      publish: (r, n, e) => ((published = true), g.publish(r, n, e)),
    };
    const text = task("J4", { id: "fixture-j4-transport-20261016", status: "ready", next: "codex" });
    const early = write(dropsOnCommit, "J4", text, { task_id: "none", status: "idle" });
    assert.equal(early.code, "TRANSPORT_FAILED_STOPPED");
    assert.equal(early.attempts, 1, "not retried");
    assert.equal(published, false);
    assert.equal(headAt(w), before);
    const dropsAfterSend: Backend = {
      ...wrap(g),
      publish: (r, n, e) => {
        g.publish(r, n, e); // the update reaches the remote, but the answer is lost
        throw new TransportError("PATCH git/refs: no HTTP response: unexpected EOF");
      },
    };
    const late = write(dropsAfterSend, "J4", text, { task_id: "none", status: "idle" });
    assert.equal(late.code, "PUBLISHED_UNVERIFIED");
    assert.equal(late.registered, false, "never claimed as registered without a read-back");
    assert.notEqual(headAt(w), before, "the ref did move, which is exactly why the result must say unverified");
  } finally {
    w.cleanup();
  }
});

test("GitHub reads are re-sent after a dropped connection, writes are not", () => {
  let refGets = 0;
  let blobPosts = 0;
  const flaky: Transport = (method, path) => {
    if (method === "GET" && path.includes("git/ref/")) {
      refGets++;
      return refGets < 3 ? { status: 0, text: "unexpected EOF" } : { status: 200, text: JSON.stringify({ object: { sha: "a".repeat(40) } }) };
    }
    if (method === "GET" && path.includes("git/commits/")) return { status: 200, text: JSON.stringify({ tree: { sha: "t".repeat(40) } }) };
    if (method === "POST" && path.endsWith("git/blobs")) {
      blobPosts++;
      return { status: 0, text: "unexpected EOF" };
    }
    return { status: 500, text: "{}" };
  };
  const gh = new GitHubBackend("o/r", flaky);
  assert.equal(gh.head(MAIN_REF), "a".repeat(40));
  assert.equal(refGets, 3, "a read-only GET is re-sent until it answers (at most 3 sends)");
  assert.throws(() => gh.commit("b".repeat(40), new Map([["x.md", "x"]]), "m"), TransportError);
  assert.equal(blobPosts, 1, "a write is sent once and never re-sent");
});
