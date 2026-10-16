import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Backend, PublishResult } from "./transaction.ts";
import { RefusedError, TransportError } from "./transaction.ts";

// Local-git backend. Commits are built with plumbing on a private index file, so the caller's working tree
// and index are never touched. Publishing is a plain `git push <commit>:<ref>`: git refuses anything that is
// not a fast-forward of the remote ref, which is the compare-and-swap. Credentials stay with git's own
// credential helper; this module never reads or prints them.

type Run = { status: number; stdout: string; stderr: string };

export class GitBackend implements Backend {
  readonly name = "git";
  private readonly fetched = new Set<string>();

  constructor(private readonly repo: string, private readonly remote = "origin") {}

  private git(args: string[], input?: string, env?: Record<string, string>): Run {
    const r = spawnSync("git", ["-C", this.repo, ...args], {
      input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  private must(args: string[], input?: string, env?: Record<string, string>): string {
    const r = this.git(args, input, env);
    if (r.status !== 0) {
      if (/denied by policy|blocked by (safety|policy)|refused by policy/i.test(r.stderr)) throw new RefusedError(r.stderr.trim());
      if (/could not resolve host|connection (reset|refused|timed out)|unexpected EOF|early EOF|timed out/i.test(r.stderr)) {
        throw new TransportError(`git ${args[0]}: ${r.stderr.trim()}`);
      }
      throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  head(ref: string): string {
    const out = this.must(["ls-remote", this.remote, ref]).trim();
    const sha = out.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`ref ${ref} not found on ${this.remote}`);
    this.ensure(sha, ref);
    return sha;
  }

  private ensure(sha: string, ref: string): void {
    if (this.fetched.has(sha) || this.git(["cat-file", "-e", `${sha}^{commit}`]).status === 0) {
      this.fetched.add(sha);
      return;
    }
    this.must(["fetch", "--quiet", "--no-tags", this.remote, ref]);
    this.fetched.add(sha);
  }

  // null means "the path does not exist in that commit"; a commit that is not available locally is an error,
  // never an empty file (otherwise a missing object would read as an idle slot).
  read(commit: string, path: string): string | null {
    const r = this.git(["cat-file", "blob", `${commit}:${path}`]);
    if (r.status === 0) return r.stdout;
    if (this.git(["cat-file", "-e", `${commit}^{commit}`]).status !== 0) throw new Error(`commit ${commit} is not available locally`);
    return null;
  }

  commit(base: string, files: Map<string, string | null>, message: string): string {
    const dir = mkdtempSync(join(tmpdir(), "agent-v3-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      this.must(["read-tree", base], undefined, env);
      for (const [path, content] of files) {
        if (content === null) {
          this.must(["update-index", "--force-remove", "--", path], undefined, env);
        } else {
          const blob = this.must(["hash-object", "-w", "--stdin"], content).trim();
          this.must(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, env);
        }
      }
      const tree = this.must(["write-tree"], undefined, env).trim();
      return this.must(["commit-tree", tree, "-p", base, "-F", "-"], message).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  publish(ref: string, newCommit: string, _expectedOld: string): PublishResult {
    // The new commit's only parent is expectedOld, so a fast-forward push succeeds only while the remote
    // ref still equals expectedOld. No --force, no --force-with-lease.
    const r = this.git(["push", "--porcelain", this.remote, `${newCommit}:${ref}`]);
    if (r.status === 0) return { ok: true };
    const text = `${r.stdout}\n${r.stderr}`;
    if (/non-fast-forward|fetch first|\[rejected\]|stale info/i.test(text)) return { ok: false, kind: "stale", detail: text.trim() };
    if (/permission|denied|403|authentication|protected branch/i.test(text)) {
      return { ok: false, kind: /policy|safety/i.test(text) ? "refused" : "permission", detail: text.trim() };
    }
    return { ok: false, kind: "other", detail: text.trim() };
  }

  contains(head: string, commit: string): boolean {
    return this.git(["merge-base", "--is-ancestor", commit, head]).status === 0;
  }
}
