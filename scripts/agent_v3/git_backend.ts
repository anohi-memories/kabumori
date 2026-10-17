import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Backend, PublishResult } from "./transaction.ts";
import { decodeUtf8Exact, RefusedError, TransportError } from "./transaction.ts";

// Local-git backend. Commits are built with plumbing on a private index file, so the caller's working tree
// and index are never touched. Publishing is a plain `git push <commit>:<ref>`: git refuses anything that is
// not a fast-forward of the remote ref, which is the compare-and-swap. Credentials stay with git's own
// credential helper; this module never reads or prints them.

type Run = { status: number; stdout: Uint8Array; stderr: string };

export type RemoteCheck = (url: string) => boolean;

export class DestinationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DestinationError";
  }
}

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
  private readonly target: string; // what ls-remote / fetch / push talk to
  private readonly pinned: string | null = null;

  // With `allow`, the remote's effective destination is verified once (see verifiedUrl) and every network
  // command then uses that exact URL instead of the remote name, so a pushurl, a push/insteadOf rewrite or a
  // later `git remote set-url` cannot send the write elsewhere. Without `allow` (tests, read-only callers) the
  // remote name is used as given.
  constructor(private readonly repo: string, private readonly remote = "origin", private readonly allow?: RemoteCheck) {
    this.target = remote;
    if (allow) this.pinned = this.target = this.verifiedUrl();
  }

  // The fetch and push destinations exactly as git will use them (`get-url` expands insteadOf and
  // pushInsteadOf) must both equal the one URL configured for the remote: no pushurl, no rewrite of any kind,
  // even towards another allowed repository (a deliberate detour is not allowed implicitly either). That URL
  // must be allowed and must not be rewritten again by a url.*.insteadOf / pushInsteadOf rule when used directly.
  verifiedUrl(): string {
    if (!this.allow) throw new DestinationError("no destination check configured");
    const lines = (args: string[]) => this.must(args).split("\n").map((l) => l.trim()).filter(Boolean);
    const configLines = (key: string) => new TextDecoder().decode(this.git(["config", "--get-all", key]).stdout).split("\n").map((l) => l.trim()).filter(Boolean);
    const configured = configLines(`remote.${this.remote}.url`);
    if (configured.length !== 1) throw new DestinationError(`${this.remote} must have exactly one configured url, found ${configured.length}`);
    if (configLines(`remote.${this.remote}.pushurl`).length) throw new DestinationError(`${this.remote} has a separate pushurl`);
    const fetch = lines(["remote", "get-url", "--all", this.remote]);
    const push = lines(["remote", "get-url", "--push", "--all", this.remote]);
    if (fetch.length !== 1 || push.length !== 1) {
      throw new DestinationError(`${this.remote} has ${fetch.length} fetch and ${push.length} push URLs; exactly one of each is required`);
    }
    if (fetch[0] !== configured[0] || push[0] !== configured[0]) throw new DestinationError(`${this.remote} is rewritten by insteadOf / pushInsteadOf`);
    if (!this.allow(push[0])) throw new DestinationError(`push destination of ${this.remote} is not allowed`);
    const rules = this.git(["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"]);
    const rewritten = new TextDecoder().decode(rules.stdout).split("\n").map((l) => l.slice(l.indexOf(" ") + 1)).filter((v) => v && push[0].startsWith(v));
    if (rewritten.length) throw new DestinationError(`a url.*.insteadOf / pushInsteadOf rule would rewrite the verified URL`);
    return push[0];
  }

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

  head(ref: string): string {
    const out = this.must(["ls-remote", this.target, ref]).trim();
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
    this.must(["fetch", "--quiet", "--no-tags", this.target, ref]);
    this.fetched.add(sha);
  }

  // null means "the path does not exist in that commit"; a commit that is not available locally is an error,
  // never an empty file (otherwise a missing object would read as an idle slot). Content must be valid UTF-8.
  read(commit: string, path: string): string | null {
    const r = this.git(["cat-file", "blob", `${commit}:${path}`]);
    if (r.status === 0) return decodeUtf8Exact(r.stdout, `${path}@${commit}`);
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
    // ref still equals expectedOld. No --force, no --force-with-lease. A pinned destination is verified again
    // right before pushing; if anything about it changed, nothing is pushed.
    if (this.pinned) {
      let now: string;
      try {
        now = this.verifiedUrl();
      } catch (e) {
        return { ok: false, kind: "destination", detail: `push destination no longer verifies: ${(e as Error).message}` };
      }
      if (now !== this.pinned) return { ok: false, kind: "destination", detail: "push destination changed after it was verified" };
    }
    const r = this.git(["push", "--porcelain", this.target, `${newCommit}:${ref}`]);
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
