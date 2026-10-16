import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Backend, PublishResult } from "./transaction.ts";
import { IntegrityError, RefusedError, TransportError } from "./transaction.ts";

// Local-git backend. Commits are built with plumbing on a private index file, so the caller's working tree
// and index are never touched. Publishing is a plain `git push <commit>:<ref>`: git refuses anything that is
// not a fast-forward of the remote ref, which is the compare-and-swap. Credentials stay with git's own
// credential helper; this module never reads or prints them.

type Run = { status: number; stdout: Uint8Array; stderr: string };

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Explicit wording only: a bare "denied" or "blocked" also appears in ordinary auth and network errors.
const REFUSAL = /\b(denied|blocked|refused) by (policy|safety)|safety (block|filter)|content policy/i;
const TRANSPORT = /could not resolve host|connection (reset|refused|timed out)|unexpected EOF|early EOF|operation timed out/i;

// Classify a failed `git push --porcelain` from its output. Only a per-ref rejection line ("!") with a known
// reason is trusted to mean "not applied"; a concurrent-update race is stale; anything else (hang-up after
// the pack was sent, RPC failure, no status line at all) is unknown, because the update may have happened.
export function classifyPushFailure(text: string): Exclude<PublishResult, { ok: true }>["kind"] {
  const rejected = text.split("\n").find((l) => l.startsWith("!"));
  if (REFUSAL.test(text)) return "refused";
  if (rejected) {
    if (/non-fast-forward|fetch first|stale info|incorrect old value|cannot lock ref|failed to update ref|failed to lock/i.test(rejected)) return "stale";
    if (/permission|denied|protected branch|hook declined|pre-receive|shallow update not allowed|rejected/i.test(rejected)) return "rejected";
    return "unknown";
  }
  if (/permission to .* denied|the requested URL returned error: 40[13]|authentication failed|could not read username/i.test(text)) return "permission";
  return "unknown";
}

export class GitBackend implements Backend {
  readonly name = "git";
  private readonly fetched = new Set<string>();

  constructor(private readonly repo: string, private readonly remote = "origin") {}

  private git(args: string[], input?: string, env?: Record<string, string>): Run {
    const r = spawnSync("git", ["-C", this.repo, ...args], {
      input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? new Uint8Array(), stderr: r.stderr?.toString() ?? "" };
  }

  private must(args: string[], input?: string, env?: Record<string, string>): string {
    const r = this.git(args, input, env);
    if (r.status !== 0) {
      if (REFUSAL.test(r.stderr)) throw new RefusedError(r.stderr.trim());
      if (TRANSPORT.test(r.stderr)) throw new TransportError(`git ${args[0]}: ${r.stderr.trim()}`);
      throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
    }
    return new TextDecoder().decode(r.stdout);
  }

  remoteUrl(): string {
    return this.must(["remote", "get-url", this.remote]).trim();
  }

  head(ref: string): string {
    const out = this.must(["ls-remote", this.remote, ref]).trim();
    const line = out.split("\n").find((l) => l.endsWith(`\t${ref}`));
    const sha = line?.split("\t")[0];
    if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`ref ${ref} not found on ${this.remote}`);
    this.ensure(sha!, ref);
    return sha!;
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
  // never an empty file (otherwise a missing object would read as an idle slot). Content must be valid UTF-8.
  read(commit: string, path: string): string | null {
    const r = this.git(["cat-file", "blob", `${commit}:${path}`]);
    if (r.status === 0) {
      try {
        return UTF8.decode(r.stdout);
      } catch {
        throw new IntegrityError(`${path}@${commit} is not valid UTF-8`);
      }
    }
    if (this.git(["cat-file", "-e", `${commit}^{commit}`]).status !== 0) throw new Error(`commit ${commit} is not available locally`);
    return null;
  }

  list(commit: string, prefix: string): string[] {
    return this.must(["ls-tree", "-r", "--name-only", commit, "--", prefix]).split("\n").filter((p) => p.startsWith(prefix));
  }

  changedPaths(base: string, commit: string): string[] {
    return this.must(["diff-tree", "--no-commit-id", "--name-only", "-r", base, commit]).split("\n").filter(Boolean);
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
    const text = `${new TextDecoder().decode(r.stdout)}\n${r.stderr}`.trim();
    return { ok: false, kind: classifyPushFailure(text), detail: text };
  }

  contains(head: string, commit: string): boolean {
    const r = this.git(["merge-base", "--is-ancestor", commit, head]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw new Error(`git merge-base failed: ${r.stderr.trim()}`);
  }
}
