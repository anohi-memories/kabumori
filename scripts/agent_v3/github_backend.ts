import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import type { Backend, PublishResult } from "./transaction.ts";
import { RefusedError, TransportError } from "./transaction.ts";

// GitHub backend over the Git Data API, the multi-file alternative to the Contents API (which makes one
// commit per file, the write pattern behind the partial TASK/ACTIVE updates). blobs -> one tree on the
// base tree -> one commit with the base as its only parent -> `PATCH git/refs` with force:false, which
// GitHub rejects with 422 unless it is a fast-forward of the current ref (the compare-and-swap).
// Requests go through `gh api`, so authentication stays inside gh and this module never sees a token.

export type Transport = (method: string, path: string, body?: unknown, accept?: string) => { status: number; text: string };

export function ghTransport(): Transport {
  return (method, path, body, accept) => {
    const args = ["api", "--method", method, "-i", path];
    if (accept) args.push("-H", `Accept: ${accept}`);
    if (body !== undefined) args.push("--input", "-");
    const r = spawnSync("gh", args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = r.stdout ?? "";
    const status = Number(out.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1] ?? (r.status === 0 ? 200 : 0));
    const split = out.search(/\r?\n\r?\n/);
    const text = split >= 0 ? out.slice(split).replace(/^\s+/, "") : out;
    return { status, text: status === 0 ? (r.stderr ?? "") : text };
  };
}

type Json = { [key: string]: unknown };

function field(value: unknown, ...keys: string[]): unknown {
  let v = value;
  for (const k of keys) v = v && typeof v === "object" ? (v as Json)[k] : undefined;
  return v;
}

function text(value: unknown, ...keys: string[]): string {
  const v = field(value, ...keys);
  if (typeof v !== "string") throw new Error(`GitHub response is missing ${keys.join(".")}`);
  return v;
}

const GET_ATTEMPTS = 3;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class GitHubBackend implements Backend {
  readonly name = "github";
  private readonly contents = new Map<string, string | null>(); // commit:path -> content (commits are immutable)

  constructor(private readonly repo: string, private readonly transport: Transport = ghTransport()) {}

  private call(method: string, path: string, body?: unknown, accept?: string): { status: number; json: unknown; text: string } {
    // No HTTP answer at all. Only an explicit policy/safety message is a refusal; anything else (for example
    // "unexpected EOF", seen live on 2026-10-16) is a transport failure. A read-only GET is re-sent up to
    // GET_ATTEMPTS times because sending it again writes nothing; a write (POST/PATCH) is never re-sent.
    let r = { status: 0, text: "" };
    for (let attempt = 1; attempt <= (method === "GET" ? GET_ATTEMPTS : 1); attempt++) {
      r = this.transport(method, `repos/${this.repo}/${path}`, body, accept);
      if (r.status !== 0 || /policy|safety|blocked|denied|refus/i.test(r.text)) break;
      if (attempt < GET_ATTEMPTS && method === "GET") pause(500 * attempt);
    }
    if (r.status === 0) {
      const detail = `${method} ${path}: no HTTP response: ${r.text.trim()}`;
      if (/policy|safety|blocked|denied|refus/i.test(r.text)) throw new RefusedError(detail);
      throw new TransportError(detail);
    }
    let json: unknown = null;
    try {
      json = JSON.parse(r.text);
    } catch {
      json = null;
    }
    return { status: r.status, json, text: r.text };
  }

  private message(r: { json: unknown; text: string }): string {
    const m = field(r.json, "message");
    return typeof m === "string" ? m : r.text.slice(0, 200);
  }

  private ok(method: string, path: string, body?: unknown): unknown {
    const r = this.call(method, path, body);
    if (r.status >= 200 && r.status < 300) return r.json;
    throw new Error(`${method} ${path} -> ${r.status}: ${this.message(r)}`);
  }

  head(ref: string): string {
    return text(this.ok("GET", `git/ref/${ref.replace(/^refs\//, "")}`), "object", "sha");
  }

  read(commit: string, path: string): string | null {
    const key = `${commit}:${path}`;
    if (this.contents.has(key)) return this.contents.get(key)!;
    const r = this.call("GET", `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`, undefined, "application/vnd.github.raw");
    if (r.status !== 200 && r.status !== 404) throw new Error(`read ${path}@${commit} -> ${r.status}`);
    const content = r.status === 404 ? null : r.text;
    if (/^[0-9a-f]{40}$/.test(commit)) this.contents.set(key, content); // only full SHAs are immutable
    return content;
  }

  commit(base: string, files: Map<string, string | null>, message: string): string {
    const baseTree = text(this.ok("GET", `git/commits/${base}`), "tree", "sha");
    const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const [path, content] of files) {
      if (content === null) {
        tree.push({ path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = this.ok("POST", "git/blobs", { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" });
      tree.push({ path, mode: "100644", type: "blob", sha: text(blob, "sha") });
    }
    const newTree = text(this.ok("POST", "git/trees", { base_tree: baseTree, tree }), "sha");
    return text(this.ok("POST", "git/commits", { message, tree: newTree, parents: [base] }), "sha");
  }

  // Verified live on 2026-10-16: for a ref outside refs/heads/ GitHub accepted a non-fast-forward update
  // with force:false, so the server-side check cannot be relied on there. The ref is therefore compared with
  // expectedOld first (a moved ref is reported stale without writing); for branches GitHub's own
  // fast-forward check then closes the remaining window between this read and the update.
  publish(ref: string, newCommit: string, expectedOld: string): PublishResult {
    const current = this.head(ref);
    if (current !== expectedOld) return { ok: false, kind: "stale", detail: `${ref} is ${current}, expected ${expectedOld}` };
    const r = this.call("PATCH", `git/refs/${ref.replace(/^refs\//, "")}`, { sha: newCommit, force: false });
    if (r.status === 200) return { ok: true };
    const detail = `${r.status}: ${this.message(r)}`;
    if (r.status === 422 && /fast forward/i.test(detail)) return { ok: false, kind: "stale", detail };
    if (r.status === 403 || r.status === 404) return { ok: false, kind: "permission", detail };
    return { ok: false, kind: "other", detail };
  }

  contains(head: string, commit: string): boolean {
    if (head === commit) return true;
    const r = this.call("GET", `compare/${commit}...${head}`);
    const status = field(r.json, "status");
    return r.status === 200 && (status === "ahead" || status === "identical");
  }

  createRef(ref: string, sha: string): void {
    if (!/^refs\/[^/]+\/.+/.test(ref)) throw new Error(`not a full ref: ${ref}`);
    this.ok("POST", "git/refs", { ref, sha });
  }
}
