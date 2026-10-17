import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main as cli } from "../../scripts/agent_v3/cli.ts";
import { GitBackend } from "../../scripts/agent_v3/git_backend.ts";
import { GitHubBackend } from "../../scripts/agent_v3/github_backend.ts";
import { deriveIndex, gitBlobId, indexPath, initRoot, planArchive, planTaskWrite, slotState, verifyRoot } from "../../scripts/agent_v3/registry.ts";
import { type Backend, MAIN_REF, type Outcome, runTransaction } from "../../scripts/agent_v3/transaction.ts";
import { DEFS, def, expectAt, FakeGitHub, freshRead, headAt, OPTS, readAt, report, ROOT, sh, staleFirstHead, task, type World, world, wrap, write } from "./helpers.ts";

// The derived index is updated per slot (changed rows only) when the base index can be trusted, and is
// re-derived from every TASK header otherwise. These tests pin both halves: the incremental result is byte
// for byte the full derivation, ordinary writes read only the target slot, and every way the base index can
// be wrong leads to a full re-derivation with a reason (never a partial patch over a broken index).

const IDX = indexPath(ROOT);

function derivedAtHead(w: World): string {
  const read = freshRead(w);
  assert.equal(read(IDX), deriveIndex(DEFS, read), "the published index is exactly the full derivation");
  assert.deepEqual(verifyRoot(DEFS, read, ROOT, true), []);
  return headAt(w);
}

function incremental(out: Outcome, what: string): void {
  assert.equal(out.code, "REGISTERED_ON_MAIN", `${what}: ${out.detail}`);
  assert.equal(out.index?.mode, "incremental", `${what}: ${out.index?.reason ?? ""}`);
}

function fullBecause(out: Outcome, pattern: RegExp, what: string): void {
  assert.equal(out.code, "REGISTERED_ON_MAIN", `${what}: ${out.detail}`);
  assert.equal(out.index?.mode, "full", what);
  assert.match(out.index?.reason ?? "", pattern, what);
}

function archive(g: Backend, w: World, slot: string): Outcome {
  const expect = expectAt(w, slot);
  return runTransaction(g, DEFS, MAIN_REF, (read, base, list, blobs) => planArchive(DEFS, ROOT, read, list, slot, expect, base, "2026-10-17", blobs), OPTS);
}

// Another writer that bypasses the transaction (one plain commit of the given files on the current head).
function rawCommit(w: World, files: Map<string, string | null>, message: string): void {
  const g = new GitBackend(w.a);
  const base = headAt(w);
  const c = g.commit(base, files, message);
  assert.deepEqual(g.publish(MAIN_REF, c, base), { ok: true });
}

test("the incremental index equals the full derivation through a whole Claude and Codex lifecycle (git)", () => {
  const w = world();
  try {
    const g = new GitBackend(w.b);
    const id = "fixture-f3-incremental-life-20261017";
    for (const [status, next, result] of [["ready", "claude", "not_started"], ["in_progress", "claude", "not_started"], ["review_required", "chatgpt", "done"], ["done", "none", "accepted"]]) {
      incremental(write(g, "F3", task("F3", { id, status, next, result }), expectAt(w, "F3")), `F3 ${status}`);
      derivedAtHead(w);
    }
    incremental(archive(g, w, "F3"), "F3 archive");
    derivedAtHead(w);

    const jid = "fixture-j2-incremental-life-20261017";
    incremental(write(g, "J2", task("J2", { id: jid, status: "ready", next: "codex" }), expectAt(w, "J2")), "J2 ready");
    incremental(write(g, "J2", task("J2", { id: jid, status: "in_progress", next: "codex" }), expectAt(w, "J2")), "J2 start");
    incremental(write(g, "J2", task("J2", { id: jid, status: "review_required", next: "chatgpt" }), expectAt(w, "J2"), MAIN_REF, report("J2", jid)), "J2 report");
    incremental(write(g, "J2", task("J2", { id: jid, status: "done", next: "none" }), expectAt(w, "J2")), "J2 accept");
    incremental(archive(g, w, "J2"), "J2 archive");
    derivedAtHead(w);
    assert.equal(slotState(DEFS, freshRead(w), "J2").status, "idle");
  } finally {
    w.cleanup();
  }
});

test("an ordinary write reads only the target TASK (and Report) and the index, plus one tasks/ listing (git)", () => {
  const w = world();
  try {
    const reads: string[] = [];
    const listings: string[] = [];
    const inner = new GitBackend(w.b);
    const g: Backend = { ...wrap(inner), read: (c, p) => (reads.push(p), inner.read(c, p)), blobIds: (c, p) => (listings.push(p), inner.blobIds(c, p)) };
    incremental(write(g, "F5", task("F5", { id: "fixture-f5-narrow-read-20261017", status: "ready", next: "claude" }), expectAt(w, "F5")), "F5");
    assert.deepEqual([...new Set(reads)].sort(), [def("F5").taskPath, IDX].sort());
    assert.deepEqual(listings, [`${ROOT}/tasks/`]);

    reads.length = 0;
    listings.length = 0;
    const jid = "fixture-j1-narrow-read-20261017";
    incremental(write(g, "J1", task("J1", { id: jid, status: "ready", next: "codex" }), expectAt(w, "J1")), "J1 ready");
    incremental(write(g, "J1", task("J1", { id: jid, status: "in_progress", next: "codex" }), expectAt(w, "J1")), "J1 start");
    reads.length = 0;
    incremental(write(g, "J1", task("J1", { id: jid, status: "review_required", next: "chatgpt" }), expectAt(w, "J1"), MAIN_REF, report("J1", jid)), "J1 report");
    assert.deepEqual([...new Set(reads)].sort(), [def("J1").taskPath, def("J1").reportPath!, IDX].sort());
  } finally {
    w.cleanup();
  }
});

test("on the GitHub backend an ordinary write fetches 5 contents and never another slot's TASK; a full re-derivation fetches all", () => {
  const fake = new FakeGitHub(initRoot(DEFS, ROOT));
  const fresh = () => new GitHubBackend("o/r", fake.transport, ["o/r"]);
  const expectNow = (slot: string) => {
    const s = slotState(DEFS, (p) => fresh().read(fake.refs.get("heads/main")!, p), slot);
    return { task_id: s.task_id, status: s.status, task_sha256: s.task_sha256 };
  };
  const contents = () => fake.calls.filter((c) => c.startsWith("GET contents/"));
  const otherTasks = (slot: string) => contents().filter((c) => /\/tasks\/[FJ]\d+\.md\?/.test(c) && !c.includes(`/tasks/${slot}.md?`));

  const e5 = expectNow("F5");
  fake.calls.length = 0;
  const out = write(fresh(), "F5", task("F5", { id: "fixture-f5-gh-narrow-20261017", status: "ready", next: "claude" }), e5);
  incremental(out, "F5 on GitHub");
  // target TASK, index and the tasks/ listing at the base, then the two planned files in the new commit
  assert.equal(contents().length, 5, contents().join("\n"));
  assert.deepEqual(otherTasks("F5"), []);
  assert.equal(fake.calls.length, 15, fake.calls.join("\n"));

  const e6 = expectNow("F6");
  fake.calls.length = 0;
  const full = runTransaction(fresh(), DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "F6", task("F6", { id: "fixture-f6-gh-full-20261017", status: "ready", next: "claude" }), e6, null, "m"), OPTS);
  assert.equal(full.code, "REGISTERED_ON_MAIN", full.detail);
  assert.equal(full.index?.mode, "full");
  assert.equal(otherTasks("F6").length, 14, "the full derivation reads every other TASK");
});

test("a TASK changed by another writer without the index is detected by its blob and the index is fully re-derived", () => {
  const w = world();
  try {
    const g = new GitBackend(w.b);
    rawCommit(w, new Map([[def("F7").taskPath, task("F7", { id: "fixture-f7-task-only-20261017", status: "ready", next: "claude" })]]), "one-file writer: TASK only");
    const out = write(g, "F2", task("F2", { id: "fixture-f2-after-task-only-20261017", status: "ready", next: "claude" }), expectAt(w, "F2"));
    fullBecause(out, /F7 TASK changed without the index/, "F2 after a TASK-only write");
    derivedAtHead(w);
    assert.equal(slotState(DEFS, freshRead(w), "F7").status, "ready", "the other writer's TASK is kept and now indexed");
    incremental(write(g, "F2", task("F2", { id: "fixture-f2-after-task-only-20261017", status: "in_progress", next: "claude" }), expectAt(w, "F2")), "the next write");
  } finally {
    w.cleanup();
  }
});

test("a hand-edited, old-format or missing index is never patched: the index is re-derived in full", () => {
  const w = world();
  try {
    const g = new GitBackend(w.b);
    const cases: [string, (idx: string) => string | null, RegExp][] = [
      ["status edited by hand", (idx) => idx.replace(/(## F3\n- task_id: none\n)- status: idle/, "$1- status: done"), /not in derived form/],
      ["digest edited by hand", (idx) => idx.replace(/source_digest: [0-9a-f]{64}/, `source_digest: ${"0".repeat(64)}`), /not in derived form/],
      ["old format without task_blob", (idx) => idx.replace(/^- task_blob: .*\n/gm, ""), /missing or incomplete/],
      ["index deleted", () => null, /index missing/],
    ];
    let n = 0;
    for (const [name, edit, reason] of cases) {
      const idx = freshRead(w)(IDX)!;
      const edited = edit(idx);
      assert.notEqual(edited, idx, name);
      rawCommit(w, new Map([[IDX, edited]]), `hand edit: ${name}`);
      const slot = `F${4 + n++}`;
      fullBecause(write(g, slot, task(slot, { id: `fixture-${slot.toLowerCase()}-index-repair-20261017`, status: "ready", next: "claude" }), expectAt(w, slot)), reason, name);
      derivedAtHead(w);
    }
  } finally {
    w.cleanup();
  }
});

test("a forged row for the target slot is caught; a forged row elsewhere is not hidden from verify", () => {
  const w = world();
  try {
    const g = new GitBackend(w.b);
    const read = freshRead(w);
    // Rows that keep the real task_blob (so the listing matches) and a consistent digest, but claim a state
    // the TASK does not have.
    const forge = (slot: string) => {
      const real = read(def(slot).taskPath)!;
      const fake = task(slot, { id: `fixture-${slot.toLowerCase()}-forged-20261017`, status: "ready", next: "claude" });
      const forged = deriveIndex(DEFS, (p) => (p === def(slot).taskPath ? fake : freshRead(w)(p)));
      return forged.replace(`- task_blob: ${gitBlobId(fake)}`, `- task_blob: ${gitBlobId(real)}`);
    };
    rawCommit(w, new Map([[IDX, forge("F6")]]), "forged F6 row");
    fullBecause(write(g, "F6", task("F6", { id: "fixture-f6-real-20261017", status: "ready", next: "claude" }), expectAt(w, "F6")), /index row F6 does not match its TASK/, "target row forged");
    derivedAtHead(w);

    rawCommit(w, new Map([[IDX, forge("F8")]]), "forged F8 row");
    incremental(write(g, "F9", task("F9", { id: "fixture-f9-after-forge-20261017", status: "ready", next: "claude" }), expectAt(w, "F9")), "a write to another slot");
    const findings = verifyRoot(DEFS, freshRead(w), ROOT, true);
    assert.ok(findings.some((f) => f.slot === "F8" && f.kind === "INDEX_MISMATCH"), JSON.stringify(findings));
    // ...and the next write to F8 itself, or a full verify, repairs it.
    fullBecause(write(g, "F8", task("F8", { id: "fixture-f8-real-20261017", status: "ready", next: "claude" }), expectAt(w, "F8")), /index row F8 does not match its TASK/, "F8 itself");
    derivedAtHead(w);
  } finally {
    w.cleanup();
  }
});

test("a tasks/ listing that disagrees with the verified TASK read falls back to a full re-derivation; a bad listing entry stops", () => {
  const fake = new FakeGitHub(initRoot(DEFS, ROOT));
  const fresh = () => new GitHubBackend("o/r", fake.transport, ["o/r"]);
  const head0 = fake.refs.get("heads/main")!;
  const idleBlob = gitBlobId(fresh().read(head0, def("F5").taskPath));
  fake.advance(new Map([[def("F5").taskPath, task("F5", { id: "fixture-f5-stale-listing-20261017", status: "ready", next: "claude" })]])); // TASK-only write
  const head = fake.refs.get("heads/main")!;
  const s = slotState(DEFS, (p) => fresh().read(head, p), "F5");
  // The listing still reports the old (indexed) blob for F5: index and listing agree, the verified read does not.
  fake.fault = (method, path) => {
    if (method !== "GET" || !path.startsWith(`contents/${ROOT}/tasks?ref=`)) return null;
    const r = fake.serve(method, path);
    const entries = JSON.parse(r.text) as { path: string; sha: string }[];
    return { status: 200, text: JSON.stringify(entries.map((e) => (e.path === def("F5").taskPath ? { ...e, sha: idleBlob } : e))) };
  };
  const text = task("F5", { id: "fixture-f5-stale-listing-20261017", status: "in_progress", next: "claude" });
  const out = write(fresh(), "F5", text, { task_id: s.task_id, status: s.status, task_sha256: s.task_sha256 });
  fullBecause(out, /listing disagrees with the verified read/, "stale listing");

  fake.fault = (method, path) => {
    if (method !== "GET" || !path.startsWith(`contents/${ROOT}/tasks?ref=`)) return null;
    return { status: 200, text: JSON.stringify([{ path: def("F1").taskPath, type: "file", sha: "not-a-sha" }]) };
  };
  const s2 = slotState(DEFS, (p) => fresh().read(fake.refs.get("heads/main")!, p), "F2");
  const before = fake.refs.get("heads/main");
  const bad = write(fresh(), "F2", task("F2", { id: "fixture-f2-bad-listing-20261017", status: "ready", next: "claude" }), { task_id: s2.task_id, status: s2.status, task_sha256: s2.task_sha256 });
  assert.equal(bad.code, "INTEGRITY_FAILED_STOPPED", bad.detail);
  assert.equal(fake.refs.get("heads/main"), before, "nothing was published");
});

test("a different-slot race re-plans incrementally on the new head and keeps both changes; a same-slot race or a stale SHA writes nothing", () => {
  const w = world();
  try {
    const base = headAt(w);
    const eF3 = expectAt(w, "F3", base);
    incremental(write(new GitBackend(w.a), "F2", task("F2", { id: "fixture-f2-race-first-20261017", status: "ready", next: "claude" }), expectAt(w, "F2")), "first writer");
    const second = write(staleFirstHead(new GitBackend(w.b), base), "F3", task("F3", { id: "fixture-f3-race-second-20261017", status: "ready", next: "claude" }), eF3);
    incremental(second, "second writer, re-planned");
    assert.equal(second.attempts, 2);
    derivedAtHead(w);
    const read = freshRead(w);
    assert.equal(slotState(DEFS, read, "F2").status, "ready", "the first writer's row survived");
    assert.equal(slotState(DEFS, read, "F3").status, "ready");

    const head = headAt(w);
    const stale = { ...expectAt(w, "F2"), task_sha256: "0".repeat(64) };
    const conflict = write(new GitBackend(w.b), "F2", task("F2", { id: "fixture-f2-race-first-20261017", status: "in_progress", next: "claude" }), stale);
    assert.equal(conflict.code, "CONFLICT_SAME_SLOT", conflict.detail);
    const eF2old = expectAt(w, "F2", base); // the idle F2 the second writer once saw
    const sameSlot = write(staleFirstHead(new GitBackend(w.b), base), "F2", task("F2", { id: "fixture-f2-race-other-20261017", status: "ready", next: "claude" }), eF2old);
    assert.equal(sameSlot.code, "CONFLICT_SAME_SLOT", sameSlot.detail);
    assert.equal(headAt(w), head, "neither refused write moved main");
  } finally {
    w.cleanup();
  }
});

test("a BOM + CRLF TASK is indexed with the blob of its exact bytes and the next write stays incremental", () => {
  const w = world();
  try {
    const g = new GitBackend(w.b);
    const id = "fixture-f4-bom-index-20261017";
    const bom = "﻿" + task("F4", { id, status: "ready", next: "claude" }).replace(/\n/g, "\r\n");
    incremental(write(g, "F4", bom, expectAt(w, "F4")), "BOM write");
    const head = derivedAtHead(w);
    const lsTree = sh(w.a, "ls-tree", head, "--", def("F4").taskPath).split(/\s+/)[2];
    assert.match(readAt(w, head)(IDX)!, new RegExp(`## F4\\n(?:- .*\\n)*?- task_blob: ${lsTree}\\n`));
    incremental(write(g, "F4", "﻿" + task("F4", { id, status: "in_progress", next: "claude" }).replace(/\n/g, "\r\n"), expectAt(w, "F4")), "next write");
  } finally {
    w.cleanup();
  }
});

test("the CLI write takes the incremental path through a pinned, allowed remote; a pushurl detour is still refused before any push", () => {
  const w = world();
  try {
    const file = join(w.dir, "F9.md");
    writeFileSync(file, task("F9", { id: "fixture-f9-cli-incremental-20261017", status: "ready", next: "claude" }));
    const e = expectAt(w, "F9");
    const args = ["write", "--root", ROOT, "--slot", "F9", "--task-file", file, "--expect-task-id", e.task_id, "--expect-status", e.status, "--expect-sha256", e.task_sha256, "--message", "m", "--repo", w.b, "--allow-local-remote", "--allow-main"];
    const logged: string[] = [];
    const log = console.log;
    console.log = (s: string) => logged.push(s);
    let code: number;
    try {
      code = cli(args);
    } finally {
      console.log = log;
    }
    assert.equal(code, 0, logged.join("\n"));
    assert.equal(JSON.parse(logged.at(-1)!).index.mode, "incremental");
    derivedAtHead(w);

    const other = join(w.dir, "other.git");
    spawnSync("git", ["init", "--bare", "--initial-branch=main", other]);
    sh(w.b, "config", "remote.origin.pushurl", other);
    writeFileSync(file, task("F9", { id: "fixture-f9-cli-incremental-20261017", status: "in_progress", next: "claude" }));
    const e2 = expectAt(w, "F9");
    const before = headAt(w);
    assert.throws(() => cli(["write", "--root", ROOT, "--slot", "F9", "--task-file", file, "--expect-task-id", e2.task_id, "--expect-status", e2.status, "--expect-sha256", e2.task_sha256, "--message", "m", "--repo", w.b, "--allow-local-remote", "--allow-main"]), /not an allowed destination/);
    assert.equal(spawnSync("git", ["-C", other, "for-each-ref"], { encoding: "utf8" }).stdout.trim(), "");
    assert.equal(headAt(w), before);
  } finally {
    w.cleanup();
  }
});
