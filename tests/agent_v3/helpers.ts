import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitBackend } from "../../scripts/agent_v3/git_backend.ts";
import { gitBlobSha, type Transport } from "../../scripts/agent_v3/github_backend.ts";
import { catalog, type Expect, initRoot, planTaskWrite, type SlotDef, slotState } from "../../scripts/agent_v3/registry.ts";
import { type Backend, MAIN_REF, type Outcome, runTransaction, type TransactionOptions } from "../../scripts/agent_v3/transaction.ts";

// Shared fixtures for the agent_v3 tests. Everything lives in a temp directory (git worlds) or in memory (the
// GitHub fake); nothing touches the real repository, GitHub, or any slot.

export const ROOT = ".agent_v3_fixture";
export const DEFS = catalog(ROOT, "FJ");
export const OPTS: TransactionOptions = { root: ROOT, allowMain: true };

export function def(slot: string): SlotDef {
  return DEFS.find((d) => d.slot === slot)!;
}

export function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export type World = { dir: string; remote: string; a: string; b: string; cleanup: () => void };

export function world(): World {
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
  const init = runTransaction(new GitBackend(a), DEFS, MAIN_REF, () => ({ files: initRoot(DEFS, ROOT), expectations: new Map(), message: "init fixture root" }), OPTS);
  assert.equal(init.code, "REGISTERED_ON_MAIN", init.detail);
  sh(b, "fetch", "--quiet", "origin"); // the second writer has seen the initialised base, as a real one would
  return out;
}

export function task(slot: string, f: { id: string; status: string; next: string; returnTo?: string; result?: string; extra?: string }): string {
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

export function report(slot: string, id: string, result = "fixture"): string {
  return [`# ${slot} Report`, "", `- task_id: ${id}`, `- result: ${result}`, ""].join("\n");
}

export function headAt(w: World): string {
  return sh(w.a, "ls-remote", w.remote, MAIN_REF).split(/\s+/)[0];
}

export function readAt(w: World, commit: string): (p: string) => string | null {
  return (p) => {
    const r = spawnSync("git", ["-C", w.a, "cat-file", "blob", `${commit}:${p}`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  };
}

export function freshRead(w: World): (p: string) => string | null {
  sh(w.a, "fetch", "--quiet", "origin");
  return readAt(w, headAt(w));
}

// What a careful caller would pass: the slot's state (including the content SHA256s) at a given commit.
export function expectAt(w: World, slot: string, commit = headAt(w)): Expect {
  sh(w.a, "fetch", "--quiet", "origin");
  const s = slotState(DEFS, readAt(w, commit), slot);
  return { task_id: s.task_id, status: s.status, task_sha256: s.task_sha256, ...(s.report_sha256 ? { report_sha256: s.report_sha256 } : {}) };
}

export function write(backend: Backend, slot: string, text: string, expect: Expect, ref = MAIN_REF, reportText: string | null = null, options = OPTS): Outcome {
  return runTransaction(backend, DEFS, ref, (read, _base, _list, blobs) => planTaskWrite(DEFS, ROOT, read, slot, text, expect, reportText, `fixture ${slot}`, blobs), options);
}

export function changedFiles(w: World, commit: string): string[] {
  return sh(w.a, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean);
}

export function wrap(inner: Backend): Backend {
  return {
    name: inner.name,
    head: (r) => inner.head(r),
    read: (c, p) => inner.read(c, p),
    list: (c, p) => inner.list(c, p),
    blobIds: (c, p) => inner.blobIds(c, p),
    changedPaths: (b, c) => inner.changedPaths(b, c),
    commit: (b, f, m) => inner.commit(b, f, m),
    publish: (r, n, e) => inner.publish(r, n, e),
    contains: (h, c) => inner.contains(h, c),
  };
}

// The first head() answer is an older commit: the caller plans on a stale base exactly as a second writer
// would if another writer published in between.
export function staleFirstHead(inner: Backend, stale: string): Backend {
  let first = true;
  return { ...wrap(inner), name: "stale-first", head: (ref) => (first ? ((first = false), stale) : inner.head(ref)) };
}

// ---- In-memory GitHub (Git Data API + contents) with fault injection ----------------------------------

type Commit = { tree: Map<string, string>; parents: string[] };
export type Fault = (method: string, path: string, body: unknown) => { status: number; text: string } | null;

export class FakeGitHub {
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  readonly calls: string[] = [];
  fault: Fault = () => null;

  constructor(files: Map<string, string>) {
    const tree = new Map<string, string>();
    for (const [p, c] of files) tree.set(p, this.putBlob(Buffer.from(c, "utf8")));
    const t = this.putTree(tree);
    const c = this.putCommit({ tree: this.trees.get(t)!, parents: [] });
    this.refs.set("heads/main", c);
  }

  putBlob(bytes: Uint8Array): string {
    const sha = gitBlobSha(bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }

  putTree(tree: Map<string, string>): string {
    const sha = createHash("sha1").update(JSON.stringify([...tree].sort())).digest("hex");
    this.trees.set(sha, tree);
    return sha;
  }

  putCommit(c: Commit): string {
    const sha = createHash("sha1").update(JSON.stringify([[...c.tree].sort(), c.parents, Math.random()])).digest("hex");
    this.commits.set(sha, c);
    return sha;
  }

  ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return seen;
  }

  // Advance main with another writer's commit (a concurrent registration).
  advance(files: Map<string, string>): string {
    const head = this.refs.get("heads/main")!;
    const tree = new Map(this.commits.get(head)!.tree);
    for (const [p, c] of files) tree.set(p, this.putBlob(Buffer.from(c, "utf8")));
    const sha = this.putCommit({ tree, parents: [head] });
    this.refs.set("heads/main", sha);
    return sha;
  }

  readonly transport: Transport = (method, fullPath, body) => {
    const path = fullPath.replace(/^repos\/o\/r\//, "");
    this.calls.push(`${method} ${path}`);
    return this.fault(method, path, body) ?? this.serve(method, path, body);
  };

  // The fault-free handler (fault callbacks may call it to build a modified answer).
  serve(method: string, path: string, body?: unknown): { status: number; text: string } {
    const json = (status: number, v: unknown) => ({ status, text: JSON.stringify(v) });
    const b = body as Record<string, unknown>;
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = path.match(/^git\/ref\/(.+)$/))) {
      const sha = this.refs.get(m[1]);
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }
    if (method === "PATCH" && (m = path.match(/^git\/refs\/(.+)$/))) {
      const cur = this.refs.get(m[1]);
      if (!cur) return json(422, { message: "Reference does not exist" });
      if (b.force !== true && !this.ancestors(String(b.sha)).has(cur)) return json(422, { message: "Update is not a fast forward" });
      this.refs.set(m[1], String(b.sha));
      return json(200, { object: { sha: b.sha } });
    }
    if (method === "GET" && (m = path.match(/^contents\/(.+)\?ref=([0-9a-f]+)$/))) {
      const target = decodeURIComponent(m[1]);
      const tree = this.commits.get(m[2])?.tree;
      if (!tree) return json(404, { message: "No commit found" });
      const sha = tree.get(target);
      if (sha) {
        const bytes = this.blobs.get(sha)!;
        return json(200, { type: "file", path: target, sha, size: bytes.length, encoding: "base64", content: Buffer.from(bytes).toString("base64") });
      }
      const under = [...tree.keys()].filter((p) => p.startsWith(`${target}/`));
      return under.length ? json(200, under.map((p) => ({ path: p, type: "file", sha: tree.get(p) }))) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = path.match(/^git\/commits\/([0-9a-f]+)$/))) {
      const c = this.commits.get(m[1]);
      if (!c) return json(404, { message: "Not Found" });
      const tree = this.putTree(c.tree);
      return json(200, { tree: { sha: tree } });
    }
    if (method === "POST" && path === "git/blobs") return json(201, { sha: this.putBlob(Buffer.from(String(b.content), "base64")) });
    if (method === "GET" && (m = path.match(/^git\/blobs\/([0-9a-f]+)$/))) {
      const bytes = this.blobs.get(m[1]);
      return bytes ? json(200, { content: Buffer.from(bytes).toString("base64"), encoding: "base64" }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && path === "git/trees") {
      const base = this.trees.get(String(b.base_tree));
      if (!base) return json(422, { message: "bad base tree" });
      const tree = new Map(base);
      for (const e of b.tree as { path: string; sha: string | null }[]) {
        if (e.sha === null) tree.delete(e.path);
        else tree.set(e.path, e.sha);
      }
      return json(201, { sha: this.putTree(tree) });
    }
    if (method === "POST" && path === "git/commits") {
      const tree = this.trees.get(String(b.tree));
      if (!tree) return json(422, { message: "bad tree" });
      return json(201, { sha: this.putCommit({ tree, parents: b.parents as string[] }) });
    }
    if (method === "GET" && (m = path.match(/^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
      const [x, y] = [m[1], m[2]];
      if (!this.commits.has(x) || !this.commits.has(y)) return json(404, { message: "Not Found" });
      const status = x === y ? "identical" : this.ancestors(y).has(x) ? "ahead" : this.ancestors(x).has(y) ? "behind" : "diverged";
      const tx = this.commits.get(x)!.tree;
      const ty = this.commits.get(y)!.tree;
      const files = [...new Set([...tx.keys(), ...ty.keys()])].filter((p) => tx.get(p) !== ty.get(p)).map((filename) => ({ filename }));
      return json(200, { status, files });
    }
    return json(500, { message: `fake: unhandled ${method} ${path}` });
  }

  head(): string {
    return this.refs.get("heads/main")!;
  }
}
