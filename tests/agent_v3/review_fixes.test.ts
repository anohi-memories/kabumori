import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main as cli } from "../../scripts/agent_v3/cli.ts";
import { classifyPushFailure, DestinationError, GitBackend } from "../../scripts/agent_v3/git_backend.ts";
import { ghTransport, GitHubBackend } from "../../scripts/agent_v3/github_backend.ts";
import { assertWithinRoot, contentSha256, initRoot, parseHeader, planArchive, planInit, PlanError, planTaskWrite, slotState, validateTaskText } from "../../scripts/agent_v3/registry.ts";
import { type Backend, checkMaxAttempts, MAIN_REF, redact, runTransaction } from "../../scripts/agent_v3/transaction.ts";
import { def, DEFS, expectAt, FakeGitHub, freshRead, headAt, OPTS, readAt, report, ROOT, sh, staleFirstHead, task, world, wrap, write } from "./helpers.ts";

// Regressions for the independent review of PR #229 (H1-H3, M1-M4, L1-L7). Each test pins one failure mode.

function fakeGh(): { gh: GitHubBackend; fake: FakeGitHub } {
  const fake = new FakeGitHub(initRoot(DEFS, ROOT));
  return { gh: new GitHubBackend("o/r", fake.transport, ["o/r"]), fake };
}

function ghExpect(fake: FakeGitHub, gh: GitHubBackend, slot: string) {
  const s = slotState(DEFS, (p) => gh.read(fake.head(), p), slot);
  return { task_id: s.task_id, status: s.status, task_sha256: s.task_sha256, ...(s.report_sha256 ? { report_sha256: s.report_sha256 } : {}) };
}

// ---- H1: lost update when task_id/status stay the same -------------------------------------------------

test("H1: a body edit that keeps task_id/status is a same-slot conflict, never overwritten on re-plan", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const id = "fixture-f1-lost-update-20261016";
    assert.equal(write(g, "F1", task("F1", { id, status: "ready", next: "claude" }), expectAt(w, "F1")).code, "REGISTERED_ON_MAIN");
    const base = headAt(w);
    const seenByB = expectAt(w, "F1", base);
    sh(w.b, "fetch", "--quiet", "origin"); // B has read this base
    // A edits the body (same task_id and status) and lands first.
    const aEdit = task("F1", { id, status: "ready", next: "claude", extra: "A changed the scope" });
    assert.equal(write(g, "F1", aEdit, expectAt(w, "F1")).code, "REGISTERED_ON_MAIN");
    // B planned from the older base; its re-plan must not overwrite A's body.
    const b = write(staleFirstHead(new GitBackend(w.b), base), "F1", task("F1", { id, status: "in_progress", next: "claude" }), seenByB);
    assert.equal(b.code, "CONFLICT_SAME_SLOT", b.detail);
    assert.equal(freshRead(w)(def("F1").taskPath), aEdit, "A's edit survives");
  } finally {
    w.cleanup();
  }
});

test("H1: a caller without an expected content SHA256 is refused (fail-closed)", () => {
  const w = world();
  try {
    const before = headAt(w);
    const old = { task_id: "none", status: "idle" } as unknown as Parameters<typeof write>[3];
    const out = write(new GitBackend(w.a), "F2", task("F2", { id: "fixture-f2-old-client-20261016", status: "ready", next: "claude" }), old);
    assert.equal(out.code, "PLAN_REFUSED");
    assert.match(out.detail, /task_sha256 is required/);
    assert.equal(headAt(w), before);
  } finally {
    w.cleanup();
  }
});

test("H1: a Codex Report changed by someone else is a conflict for a Report write", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const id = "fixture-j1-report-race-20261016";
    assert.equal(write(g, "J1", task("J1", { id, status: "ready", next: "codex" }), expectAt(w, "J1")).code, "REGISTERED_ON_MAIN");
    const stale = expectAt(w, "J1");
    assert.equal(write(g, "J1", task("J1", { id, status: "in_progress", next: "codex" }), expectAt(w, "J1"), MAIN_REF, report("J1", id, "first draft")).code, "REGISTERED_ON_MAIN");
    const out = write(g, "J1", task("J1", { id, status: "in_progress", next: "codex" }), { ...stale, status: "in_progress", task_sha256: expectAt(w, "J1").task_sha256 }, MAIN_REF, report("J1", id, "overwrites"));
    assert.equal(out.code, "CONFLICT_SAME_SLOT");
    assert.match(out.detail, /Report changed/);
  } finally {
    w.cleanup();
  }
});

// ---- H2: publish answer lost or unclear -----------------------------------------------------------------

test("H2: a git push that dies after sending is classified unknown, explicit rejections are not", () => {
  assert.equal(classifyPushFailure("fatal: the remote end hung up unexpectedly"), "unknown");
  assert.equal(classifyPushFailure("error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"), "unknown");
  assert.equal(classifyPushFailure("send-pack: unexpected disconnect while reading sideband packet"), "unknown");
  assert.equal(classifyPushFailure("To x\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (hook declined)\nDone"), "rejected");
  assert.equal(classifyPushFailure("To x\n!\tc:refs/heads/main\t[rejected] (non-fast-forward)\nDone"), "stale");
});

test("H2: an unknown publish result is resolved by reading the ref, never by re-sending", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    let pushes = 0;
    const landsButAnswerLost: Backend = {
      ...wrap(g),
      publish: (r, n, e) => {
        pushes++;
        g.publish(r, n, e);
        return { ok: false, kind: "unknown", detail: "fatal: the remote end hung up unexpectedly" };
      },
    };
    const landed = write(landsButAnswerLost, "F3", task("F3", { id: "fixture-f3-landed-20261016", status: "ready", next: "claude" }), expectAt(w, "F3"));
    assert.equal(landed.code, "REGISTERED_ON_MAIN", "the ref read shows our commit, so the normal read-back decides");
    assert.equal(pushes, 1);
    const before = headAt(w);
    const lostBeforeApply: Backend = { ...wrap(g), publish: () => ((pushes++), { ok: false, kind: "unknown", detail: "error: RPC failed; HTTP 502" }) };
    const unclear = write(lostBeforeApply, "F4", task("F4", { id: "fixture-f4-unclear-20261016", status: "ready", next: "claude" }), expectAt(w, "F4"));
    assert.equal(unclear.code, "PUBLISHED_UNVERIFIED");
    assert.equal(unclear.attempts, 1, "not re-planned or re-sent");
    assert.equal(pushes, 2);
    assert.equal(headAt(w), before);
  } finally {
    w.cleanup();
  }
});

test("H2: GitHub ref update 502, dropped answer and a 200 without the sha are unknown, not failures", () => {
  for (const injected of [
    { status: 502, text: JSON.stringify({ message: "Bad Gateway" }) },
    { status: 0, text: "unexpected EOF" },
    { status: 200, text: JSON.stringify({ ref: "refs/heads/main" }) },
  ]) {
    const { gh, fake } = fakeGh();
    let patches = 0;
    fake.fault = (method) => (method === "PATCH" ? ((patches++), injected) : null);
    const before = fake.head();
    const out = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "J2", task("J2", { id: "fixture-j2-gh-unknown-20261016", status: "ready", next: "codex" }), ghExpect(fake, gh, "J2"), null, "m"), OPTS);
    assert.equal(out.code, "PUBLISHED_UNVERIFIED", `${injected.status}: ${out.detail}`);
    assert.equal(patches, 1, "the ref update is never re-sent");
    assert.equal(fake.head(), before);
  }
});

// ---- H3: concurrent ref-update races are stale, not hard failures ----------------------------------------

test("H3: git lock / old-value races and GitHub 422 'Reference update failed' are stale", () => {
  assert.equal(classifyPushFailure("To x\n!\tc:refs/heads/main\t[remote rejected] (incorrect old value provided)\nDone"), "stale");
  assert.equal(classifyPushFailure("To x\n!\tc:refs/heads/main\t[remote rejected] (cannot lock ref 'refs/heads/main': is at 1 but expected 2)\nDone"), "stale");
  assert.equal(classifyPushFailure("To x\n!\tc:refs/heads/main\t[remote rejected] (failed to update ref)\nDone"), "stale");
  const { gh, fake } = fakeGh();
  let patched = 0;
  fake.fault = (method) => (method === "PATCH" && patched++ === 0 ? { status: 422, text: JSON.stringify({ message: "Reference update failed" }) } : null);
  const out = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "J3", task("J3", { id: "fixture-j3-gh-race-20261016", status: "ready", next: "codex" }), ghExpect(fake, gh, "J3"), null, "m"), OPTS);
  assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
  assert.equal(out.attempts, 2, "re-planned on the latest base after the race");
});

test("H3: a race on another slot re-plans and lands; a race on the same slot stops", () => {
  const { gh, fake } = fakeGh();
  const f5 = ghExpect(fake, gh, "F5");
  let raced = false;
  fake.fault = (method) => {
    if (method === "PATCH" && !raced) {
      raced = true;
      fake.advance(new Map([[def("F6").taskPath, task("F6", { id: "fixture-f6-other-writer-20261016", status: "ready", next: "claude" })]]));
    }
    return null;
  };
  const other = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "F5", task("F5", { id: "fixture-f5-race-20261016", status: "ready", next: "claude" }), f5, null, "m"), OPTS);
  assert.equal(other.code, "REGISTERED_ON_MAIN", other.detail);
  assert.equal(other.attempts, 2);
  raced = false;
  const f7 = ghExpect(fake, gh, "F7");
  fake.fault = (method) => {
    if (method === "PATCH" && !raced) {
      raced = true;
      fake.advance(new Map([[def("F7").taskPath, task("F7", { id: "fixture-f7-winner-20261016", status: "ready", next: "claude" })]]));
    }
    return null;
  };
  const same = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "F7", task("F7", { id: "fixture-f7-loser-20261016", status: "ready", next: "claude" }), f7, null, "m"), OPTS);
  assert.equal(same.code, "CONFLICT_SAME_SLOT");
});

// ---- M1: archive completeness ---------------------------------------------------------------------------

function doneJ4(fake: FakeGitHub, gh: GitHubBackend, id: string): void {
  for (const [status, next] of [["ready", "codex"], ["in_progress", "codex"], ["review_required", "chatgpt"], ["done", "none"]]) {
    const rep = status === "review_required" ? report("J4", id) : null;
    const out = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "J4", task("J4", { id, status, next }), ghExpect(fake, gh, "J4"), rep, "m"), OPTS);
    assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
  }
}

test("M1: a truncated read is detected by size/blob SHA and the archive is not created", () => {
  const { gh, fake } = fakeGh();
  const id = "fixture-j4-truncated-read-20261016";
  doneJ4(fake, gh, id);
  const before = fake.head();
  let patches = 0;
  fake.fault = (method, path) => {
    if (method === "PATCH") patches++;
    if (method !== "GET" || !path.startsWith(`contents/${encodeURIComponent(".agent_v3_fixture")}/tasks/J4.md`)) return null;
    const real = fake.serve(method, path);
    const j = JSON.parse(real.text);
    j.content = Buffer.from(Buffer.from(j.content, "base64").subarray(0, 40)).toString("base64"); // body cut short
    return { status: 200, text: JSON.stringify(j) };
  };
  const fresh = new GitHubBackend("o/r", fake.transport, ["o/r"]); // no cached reads
  const expect = { task_id: id, status: "done", task_sha256: "0".repeat(64), report_sha256: "0".repeat(64) };
  const out = runTransaction(fresh, DEFS, MAIN_REF, (read, base, list) => planArchive(DEFS, ROOT, read, list, "J4", expect, base, "2026-10-16"), OPTS);
  assert.equal(out.code, "INTEGRITY_FAILED_STOPPED", out.detail);
  assert.equal(patches, 0);
  assert.equal(fake.head(), before, "no archive, slot not reset to idle");
});

test("M1: a blob SHA mismatch from GitHub stops before the tree and the ref are touched", () => {
  const { gh, fake } = fakeGh();
  let trees = 0;
  fake.fault = (method, path) => {
    if (method === "POST" && path === "git/trees") trees++;
    return method === "POST" && path === "git/blobs" ? { status: 201, text: JSON.stringify({ sha: "f".repeat(40) }) } : null;
  };
  const before = fake.head();
  const out = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "J5", task("J5", { id: "fixture-j5-blob-mismatch-20261016", status: "ready", next: "codex" }), ghExpect(fake, gh, "J5"), null, "m"), OPTS);
  assert.equal(out.code, "INTEGRITY_FAILED_STOPPED");
  assert.equal(trees, 0);
  assert.equal(fake.head(), before);
});

test("M1: gh exiting non-zero after HTTP 200 is an incomplete answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-v3-fakegh-"));
  try {
    const bin = join(dir, "gh");
    writeFileSync(bin, '#!/bin/sh\nprintf \'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"object":{"sha":"ab\'\nexit 1\n');
    chmodSync(bin, 0o755);
    const r = ghTransport(bin)("GET", "repos/o/r/git/ref/heads/main");
    assert.equal(r.status, 0);
    assert.match(r.text, /incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- M2: destination allowlist --------------------------------------------------------------------------

test("M2: plans that touch .github, the live roots or paths outside the root are refused", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const before = headAt(w);
    const sneaky = runTransaction(g, DEFS, MAIN_REF, () => ({ files: new Map([[".github/workflows/x.yml", "on: push"]]), expectations: new Map(), message: "m" }), OPTS);
    assert.equal(sneaky.code, "DESTINATION_REFUSED");
    for (const root of [".agent", ".agent_v2", "../.agent_v3", ".agent_v3/../x"]) {
      const out = runTransaction(g, DEFS, MAIN_REF, () => ({ files: new Map(), expectations: new Map(), message: "m" }), { ...OPTS, root });
      assert.equal(out.code, "DESTINATION_REFUSED", root);
    }
    const noMain = runTransaction(g, DEFS, MAIN_REF, () => ({ files: new Map(), expectations: new Map(), message: "m" }), { root: ROOT });
    assert.equal(noMain.code, "DESTINATION_REFUSED", "main needs allowMain");
    const otherRef = runTransaction(g, DEFS, "refs/heads/feature", () => ({ files: new Map(), expectations: new Map(), message: "m" }), OPTS);
    assert.equal(otherRef.code, "DESTINATION_REFUSED");
    assert.equal(headAt(w), before);
    assert.throws(() => new GitHubBackend("someone/else", () => ({ status: 200, text: "{}" })), /not an allowed destination/);
  } finally {
    w.cleanup();
  }
});

test("M2: the CLI refuses a remote that is not the allowed GitHub repository", () => {
  const w = world();
  try {
    sh(w.b, "remote", "set-url", "origin", "https://github.com/someone/else.git");
    assert.throws(() => cli(["init", "--root", ".agent_v3_cli", "--repo", w.b, "--ref", "refs/agent-v3-live-test/x"]), /not an allowed destination/);
    sh(w.b, "remote", "set-url", "origin", w.remote);
    assert.throws(() => cli(["init", "--root", ".agent_v3_cli", "--repo", w.b, "--ref", "refs/agent-v3-live-test/x"]), /not an allowed destination/, "a local remote needs --allow-local-remote");
    assert.throws(() => cli(["init", "--root", ".agent_v2", "--repo", w.b, "--allow-local-remote"]), /not an allowed V3 root/);
  } finally {
    w.cleanup();
  }
});

// ---- M3: non-overwrite and Report completeness ----------------------------------------------------------

test("M3: init refuses a root that already has any file; archive refuses any existing file in its directory", () => {
  const files = initRoot(DEFS, ROOT);
  const list = (prefix: string) => [...files.keys()].filter((p) => p.startsWith(prefix));
  assert.throws(() => planInit(DEFS, ROOT, (p) => (p === `${ROOT}/` ? ["x/notes.md"] : [])), (e) => e instanceof PlanError && e.kind === "occupied");
  assert.throws(() => planInit(DEFS, ROOT, list), (e) => e instanceof PlanError && e.kind === "occupied", "an initialised root is occupied");
  const id = "fixture-f1-archive-dir-taken-20261016";
  files.set(def("F1").taskPath, task("F1", { id, status: "done", next: "none" }));
  files.set(`${ROOT}/archive/2026-10-16-F1-${id}/notes.txt`, "someone else's file");
  const read = (p: string) => files.get(p) ?? null;
  const s = slotState(DEFS, read, "F1");
  assert.throws(() => planArchive(DEFS, ROOT, read, list, "F1", { task_id: id, status: "done", task_sha256: s.task_sha256 }, "0".repeat(40), "2026-10-16"), (e) => e instanceof PlanError && e.kind === "occupied");
});

test("M3: a Codex slot with a missing or foreign Report is not archived or reset", () => {
  const files = initRoot(DEFS, ROOT);
  const read = (p: string) => files.get(p) ?? null;
  const list = (prefix: string) => [...files.keys()].filter((p) => p.startsWith(prefix));
  const id = "fixture-j2-report-check-20261016";
  files.set(def("J2").taskPath, task("J2", { id, status: "done", next: "none" }));
  for (const rep of [null, report("J2", "fixture-j2-some-other-task-20261016")]) {
    if (rep === null) files.delete(def("J2").reportPath!);
    else files.set(def("J2").reportPath!, rep);
    const s = slotState(DEFS, read, "J2");
    assert.throws(
      () => planArchive(DEFS, ROOT, read, list, "J2", { task_id: id, status: "done", task_sha256: s.task_sha256, report_sha256: s.report_sha256! }, "0".repeat(40), "2026-10-16"),
      (e) => e instanceof PlanError && e.kind === "report_mismatch",
    );
  }
});

// ---- M4: read-back uncertainty ----------------------------------------------------------------------------

test("M4: a failed compare/GET during read-back is unverified, not a mismatch", () => {
  const { gh, fake } = fakeGh();
  fake.fault = (method, path, body) => {
    if (method === "PATCH") {
      // Our update lands, then another writer moves main, so the read-back has to ask GitHub (compare).
      const r = fake.serve(method, path, body);
      fake.advance(new Map([[def("F6").taskPath, task("F6", { id: "fixture-f6-after-us-20261016", status: "ready", next: "claude" })]]));
      return r;
    }
    return method === "GET" && path.startsWith("compare/") && fake.calls.some((c) => c.startsWith("PATCH")) ? { status: 502, text: "{}" } : null;
  };
  const out = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "F8", task("F8", { id: "fixture-f8-readback-502-20261016", status: "ready", next: "claude" }), ghExpect(fake, gh, "F8"), null, "m"), OPTS);
  assert.equal(out.code, "PUBLISHED_UNVERIFIED", out.detail);
});

test("M4: a later legitimate change to the slot is superseded, distinguished from a broken write", () => {
  const { gh, fake } = fakeGh();
  const id = "fixture-f9-quick-start-20261016";
  let advanced = false;
  fake.fault = (method, path) => {
    if (method === "GET" && path === "git/ref/heads/main" && fake.calls.some((c) => c.startsWith("PATCH")) && !advanced) {
      advanced = true;
      fake.advance(new Map([[def("F9").taskPath, task("F9", { id, status: "in_progress", next: "claude" })]]));
    }
    return null;
  };
  const out = runTransaction(gh, DEFS, MAIN_REF, (read) => planTaskWrite(DEFS, ROOT, read, "F9", task("F9", { id, status: "ready", next: "claude" }), ghExpect(fake, gh, "F9"), null, "m"), OPTS);
  assert.equal(out.code, "SUPERSEDED_AFTER_PUBLISH");
  assert.equal(out.readback!.F9.expected.status, "ready");
  assert.equal(out.readback!.F9.actual.status, "in_progress");
});

// ---- L1-L7 -----------------------------------------------------------------------------------------------

test("L1/L4: explicit refusal wording only; ordinary auth/network words are not refusals", () => {
  assert.equal(classifyPushFailure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), "unknown");
  assert.equal(classifyPushFailure("remote: Permission to o/r.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403"), "permission");
  assert.equal(classifyPushFailure("remote: push blocked by policy"), "refused");
  assert.equal(classifyPushFailure("connection blocked by firewall"), "unknown", "'blocked' alone is not a policy refusal");
});

test("L2: BOM and CRLF headers parse; an indented header field is refused; invalid UTF-8 is an integrity error", () => {
  const crlf = "﻿" + task("F1", { id: "fixture-f1-crlf-20261016", status: "ready", next: "claude" }).replace(/\n/g, "\r\n");
  assert.equal(parseHeader(crlf).status, "ready");
  assert.equal(parseHeader(crlf).task_id, "fixture-f1-crlf-20261016");
  const indented = task("F1", { id: "fixture-f1-indent-20261016", status: "ready", next: "claude" }).replace("- recommended_model:", "  - blocker: hidden\n- recommended_model:");
  assert.equal(validateTaskText(indented).length, 1);
  const files = initRoot(DEFS, ROOT);
  const read = (p: string) => files.get(p) ?? null;
  const s = slotState(DEFS, read, "F1");
  assert.throws(() => planTaskWrite(DEFS, ROOT, read, "F1", indented, { task_id: s.task_id, status: s.status, task_sha256: s.task_sha256 }, null, "m"), /indented header field/);
  const w = world();
  try {
    const base = headAt(w);
    const blob = spawnSync("git", ["-C", w.a, "hash-object", "-w", "--stdin"], { input: Buffer.from([0x66, 0xff, 0xfe, 0x0a]) }).stdout.toString().trim();
    sh(w.a, "update-index", "--add", "--cacheinfo", `100644,${blob},${ROOT}/bad.txt`);
    const tree = sh(w.a, "write-tree");
    const commit = sh(w.a, "commit-tree", tree, "-p", base, "-m", "bad utf8");
    assert.throws(() => new GitBackend(w.a).read(commit, `${ROOT}/bad.txt`), /not valid UTF-8/);
  } finally {
    w.cleanup();
  }
});

test("L3: max attempts must be an integer from 1 to 5", () => {
  for (const bad of [0, -1, 2.5, Number.NaN, 9]) assert.throws(() => checkMaxAttempts(bad), RangeError, String(bad));
  assert.equal(checkMaxAttempts(1), 1);
  assert.equal(checkMaxAttempts(5), 5);
});

test("L5: redaction covers URL credentials, x-access-token and two-part Authorization headers", () => {
  const out = redact("fatal: https://x-access-token:ghs_abcdefghijklmnopqrstuv@github.com/o/r.git; Authorization: token abc123secret; Bearer eyJhbGciOi");
  assert.doesNotMatch(out, /ghs_[A-Za-z0-9]{10,}/);
  assert.doesNotMatch(out, /abc123secret/);
  assert.doesNotMatch(out, /eyJhbGciOi/);
});

test("L6: a commit that changes anything beyond the plan is detected before publishing", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    let published = false;
    const extra: Backend = {
      ...wrap(g),
      commit: (b, files, m) => g.commit(b, new Map([...files, [`${ROOT}/unplanned.md`, "surprise"]]), m),
      publish: (r, n, e) => ((published = true), g.publish(r, n, e)),
    };
    const out = write(extra, "J3", task("J3", { id: "fixture-j3-extra-file-20261016", status: "ready", next: "codex" }), expectAt(w, "J3"));
    assert.equal(out.code, "UNPLANNED_CHANGE_DETECTED");
    assert.match(out.detail, /unplanned\.md/);
    assert.equal(published, false);
  } finally {
    w.cleanup();
  }
});

test("L7: paths with '..', absolute paths and unusual characters are refused", () => {
  for (const p of [`${ROOT}/../x.md`, `/${ROOT}/x.md`, `${ROOT}//x.md`, `${ROOT}/a b.md`, `${ROOT}`, "x/y.md"]) {
    assert.throws(() => assertWithinRoot([p], ROOT), (e) => e instanceof PlanError && e.kind === "destination", p);
  }
  assert.doesNotThrow(() => assertWithinRoot([`${ROOT}/archive/2026-10-16-F1-fixture-f1-ok-20261016/files/${ROOT}/tasks/F1.md`], ROOT));
  assert.equal(contentSha256(null), "missing");
});

// ---- N1: the effective push destination ------------------------------------------------------------------

function otherBare(w: { dir: string }): string {
  const other = join(w.dir, "other.git");
  spawnSync("git", ["init", "--bare", "--initial-branch=main", other]);
  return other;
}

function refsOf(bare: string): string {
  return spawnSync("git", ["-C", bare, "for-each-ref"], { encoding: "utf8" }).stdout.trim();
}

test("N1: a pushurl, pushInsteadOf or insteadOf detour to another repository is refused before any push", () => {
  const w = world();
  try {
    const other = otherBare(w);
    const allowOnlyRemote = (url: string) => url === w.remote;
    const before = headAt(w);
    const detours: [string, string[]][] = [
      ["pushurl", ["config", "remote.origin.pushurl", other]],
      ["pushurl set to the same URL", ["config", "remote.origin.pushurl", w.remote]], // a separate pushurl is never implicit
      ["pushInsteadOf", ["config", `url.${other}.pushInsteadOf`, w.remote]],
      ["insteadOf", ["config", `url.${other}.insteadOf`, w.remote]],
      ["two push URLs", ["remote", "set-url", "--add", "--push", "origin", w.remote]],
    ];
    for (const [name, cfg] of detours) {
      if (name === "two push URLs") sh(w.b, "remote", "set-url", "--add", "--push", "origin", w.remote);
      sh(w.b, ...cfg);
      assert.throws(() => new GitBackend(w.b, "origin", allowOnlyRemote), DestinationError, name);
      assert.throws(() => cli(["init", "--root", ".agent_v3_n1", "--repo", w.b, "--allow-local-remote", "--allow-main"]), /not an allowed destination/, name);
      // undo for the next case
      for (const key of ["remote.origin.pushurl", `url.${other}.pushinsteadof`, `url.${other}.insteadof`]) spawnSync("git", ["-C", w.b, "config", "--unset-all", key]);
    }
    assert.equal(refsOf(other), "", "nothing was ever pushed to the unverified repository");
    assert.equal(headAt(w), before, "and nothing to the allowed one either");
  } finally {
    w.cleanup();
  }
});

test("N1: a destination that changes after verification stops before pushing", () => {
  const w = world();
  try {
    const other = otherBare(w);
    const allowOnlyRemote = (url: string) => url === w.remote;
    const changes: string[][] = [
      ["config", "remote.origin.pushurl", other],
      ["config", `url.${other}.pushInsteadOf`, w.remote],
      ["remote", "set-url", "origin", other],
    ];
    for (const change of changes) {
      const g = new GitBackend(w.b, "origin", allowOnlyRemote); // verified and pinned
      const before = headAt(w);
      const text = task("F1", { id: "fixture-f1-toctou-20261017", status: "ready", next: "claude" });
      const out = runTransaction(g, DEFS, MAIN_REF, (read) => {
        sh(w.b, ...change); // the config moves between verification and the push
        return planTaskWrite(DEFS, ROOT, read, "F1", text, expectAt(w, "F1"), null, "m");
      }, OPTS);
      assert.equal(out.code, "DESTINATION_REFUSED", `${change.join(" ")}: ${out.detail}`);
      assert.equal(refsOf(other), "");
      assert.equal(headAt(w), before);
      spawnSync("git", ["-C", w.b, "config", "--unset-all", "remote.origin.pushurl"]);
      spawnSync("git", ["-C", w.b, "config", "--unset-all", `url.${other}.pushinsteadof`]);
      sh(w.b, "remote", "set-url", "origin", w.remote);
    }
  } finally {
    w.cleanup();
  }
});

test("N1: the push goes to the pinned URL even if the remote name changed in the last moment", () => {
  const w = world();
  try {
    const other = otherBare(w);
    const g = new GitBackend(w.b, "origin", (url) => url === w.remote);
    const pinned = g.verifiedUrl();
    sh(w.b, "remote", "set-url", "origin", other);
    // Simulate the race window: the pre-push re-check still saw the old configuration.
    (g as unknown as { verifiedUrl: () => string }).verifiedUrl = () => pinned;
    const out = write(g, "F5", task("F5", { id: "fixture-f5-pinned-push-20261017", status: "ready", next: "claude" }), expectAt(w, "F5"));
    assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
    assert.equal(refsOf(other), "", "the remote name now points elsewhere, but the write went to the verified URL");
  } finally {
    w.cleanup();
  }
});

test("N1: an allowed, consistent remote still registers (library and CLI)", () => {
  const w = world();
  try {
    const g = new GitBackend(w.b, "origin", (url) => url === w.remote);
    const out = write(g, "F2", task("F2", { id: "fixture-f2-allowed-remote-20261017", status: "ready", next: "claude" }), expectAt(w, "F2"));
    assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
    assert.equal(cli(["init", "--root", ".agent_v3_n1ok", "--repo", w.b, "--allow-local-remote", "--allow-main"]), 0);
    assert.notEqual(freshRead(w)(".agent_v3_n1ok/ACTIVE_TASK.md"), null);
  } finally {
    w.cleanup();
  }
});

// ---- N2: BOM / CRLF bytes survive the archive --------------------------------------------------------------

function rawBlob(w: { a: string }, commit: string, path: string): Buffer {
  return spawnSync("git", ["-C", w.a, "cat-file", "blob", `${commit}:${path}`]).stdout;
}

test("N2: a BOM + CRLF TASK is archived byte for byte (git backend)", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const id = "fixture-f3-bom-archive-20261017";
    const bom = (status: string, next: string) => "﻿" + task("F3", { id, status, next }).replace(/\n/g, "\r\n");
    for (const [status, next] of [["ready", "claude"], ["in_progress", "claude"], ["review_required", "chatgpt"], ["done", "none"]]) {
      assert.equal(write(g, "F3", bom(status, next), expectAt(w, "F3")).code, "REGISTERED_ON_MAIN");
    }
    const doneCommit = headAt(w);
    const original = rawBlob(w, doneCommit, def("F3").taskPath);
    assert.deepEqual([...original.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the source really starts with a BOM");
    const expect = expectAt(w, "F3");
    const out = runTransaction(g, DEFS, MAIN_REF, (read, base, list) => planArchive(DEFS, ROOT, read, list, "F3", expect, base, "2026-10-17"), OPTS);
    assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
    const dir = `${ROOT}/archive/2026-10-17-F3-${id}`;
    const archived = rawBlob(w, out.commit!, `${dir}/files/${def("F3").taskPath}`);
    assert.ok(archived.equals(original), "archive bytes equal the source bytes (BOM and CRLF kept)");
    const sums = readAt(w, out.commit!)(`${dir}/SHA256SUMS`)!;
    assert.equal(sums.split(" ")[0], createHash("sha256").update(original).digest("hex"));
    const manifest = JSON.parse(readAt(w, out.commit!)(`${dir}/MANIFEST.json`)!);
    assert.equal(manifest.files[0].size, original.length);
  } finally {
    w.cleanup();
  }
});

test("N2: a BOM done TASK placed by another writer is archived byte for byte (reviewer's case)", () => {
  const w = world();
  try {
    const g = new GitBackend(w.a);
    const id = "fixture-f4-legacy-bom-20261017";
    const base = headAt(w);
    const c = g.commit(base, new Map([[def("F4").taskPath, "\uFEFF" + task("F4", { id, status: "done", next: "none" })]]), "legacy writer: BOM done task");
    assert.deepEqual(g.publish(MAIN_REF, c, base), { ok: true });
    const head = headAt(w);
    const original = rawBlob(w, head, def("F4").taskPath);
    assert.equal(original.subarray(0, 3).toString("hex"), "efbbbf");
    const s = slotState(DEFS, (p) => g.read(head, p), "F4");
    assert.equal(s.task_sha256, createHash("sha256").update(original).digest("hex"), "the backend's view hashes the real bytes");
    const out = runTransaction(g, DEFS, MAIN_REF, (read, b, list) => planArchive(DEFS, ROOT, read, list, "F4", { task_id: id, status: "done", task_sha256: s.task_sha256 }, b, "2026-10-17"), OPTS);
    assert.equal(out.code, "REGISTERED_ON_MAIN", out.detail);
    const archived = rawBlob(w, out.commit!, `${ROOT}/archive/2026-10-17-F4-${id}/files/${def("F4").taskPath}`);
    assert.equal(archived.subarray(0, 3).toString("hex"), "efbbbf");
    assert.ok(archived.equals(original));
  } finally {
    w.cleanup();
  }
});

test("N2: the GitHub backend keeps a BOM and CRLF, and still refuses invalid UTF-8", () => {
  const files = initRoot(DEFS, ROOT);
  const bomText = "﻿# x\r\n- task_id: none\r\n";
  files.set(`${ROOT}/bom.md`, bomText);
  const fake = new FakeGitHub(files);
  const gh = new GitHubBackend("o/r", fake.transport, ["o/r"]);
  const got = gh.read(fake.head(), `${ROOT}/bom.md`)!;
  assert.equal(got, bomText, "BOM and CRLF are returned unchanged");
  assert.ok(Buffer.from(got, "utf8").equals(Buffer.from(bomText, "utf8")));
  fake.fault = (method, path) => {
    if (method !== "GET" || !path.startsWith(`contents/${ROOT}/bad.md`)) return null;
    const bytes = Buffer.from([0x66, 0xff, 0xfe]);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return { status: 200, text: JSON.stringify({ type: "file", sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") }) };
  };
  assert.throws(() => gh.read(fake.head(), `${ROOT}/bad.md`), /not valid UTF-8/);
});
