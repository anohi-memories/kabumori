import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Backend, PublishResult } from "./transaction.ts";
import { decodeUtf8Exact, IntegrityError, RefusedError, TransportError } from "./transaction.ts";

// GitHub backend over the Git Data API, the multi-file alternative to the Contents API (which makes one
// commit per file, the write pattern behind the partial TASK/ACTIVE updates). blobs -> one tree on the
// base tree -> one commit with the base as its only parent -> `PATCH git/refs` with force:false, which
// GitHub rejects with 422 unless it is a fast-forward of the current ref (the compare-and-swap).
// Requests go through `gh api`, so authentication stays inside gh and this module never sees a token.

export type Transport = (method: string, path: string, body?: unknown, accept?: string) => { status: number; text: string };

// status 0 = no complete HTTP answer. gh must report an HTTP status line, and its exit code must agree with
// it (0 for 2xx): a 2xx with a non-zero exit means the body did not arrive completely.
export function ghTransport(bin = "gh"): Transport {
  return (method, path, body, accept) => {
    const args = ["api", "--method", method, "-i", path];
    if (accept) args.push("-H", `Accept: ${accept}`);
    if (body !== undefined) args.push("--input", "-");
    const r = spawnSync(bin, args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = r.stdout ?? "";
    const status = Number(out.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1] ?? 0);
    const split = out.search(/\r?\n\r?\n/);
    const text = split >= 0 ? out.slice(split).replace(/^\s+/, "") : "";
    if (status === 0) return { status: 0, text: (r.stderr ?? "") || "no HTTP status line" };
    if (status >= 200 && status < 300 && r.status !== 0) {
      return { status: 0, text: `gh exited ${r.status} after HTTP ${status}: incomplete response ${(r.stderr ?? "").trim()}` };
    }
    return { status, text };
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
  if (typeof v !== "string") throw new IntegrityError(`GitHub response is missing ${keys.join(".")}`);
  return v;
}

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const REFUSAL = /\b(denied|blocked|refused) by (policy|safety)|safety (block|filter)|content policy/i;
const GET_ATTEMPTS = 3;
export const DEFAULT_ALLOWED_REPOS = ["anohi-memories/kabumori"];

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class GitHubBackend implements Backend {
  readonly name = "github";
  private readonly contents = new Map<string, string | null>(); // commit:path -> content (commits are immutable)

  constructor(private readonly repo: string, private readonly transport: Transport = ghTransport(), allowedRepos = DEFAULT_ALLOWED_REPOS) {
    if (!allowedRepos.includes(repo)) throw new Error(`repo ${repo} is not an allowed destination`);
  }

  private call(method: string, path: string, body?: unknown, accept?: string): { status: number; json: unknown; text: string } {
    // No complete HTTP answer. Only an explicit policy/safety message is a refusal; anything else (for example
    // "unexpected EOF", seen live on 2026-10-16) is a transport failure. A read-only GET is re-sent up to
    // GET_ATTEMPTS times because sending it again writes nothing; a write (POST/PATCH) is never re-sent.
    let r = { status: 0, text: "" };
    for (let attempt = 1; attempt <= (method === "GET" ? GET_ATTEMPTS : 1); attempt++) {
      r = this.transport(method, `repos/${this.repo}/${path}`, body, accept);
      if (r.status !== 0 || REFUSAL.test(r.text)) break;
      if (attempt < GET_ATTEMPTS && method === "GET") pause(500 * attempt);
    }
    if (r.status === 0) {
      const detail = `${method} ${path}: no complete HTTP response: ${r.text.trim()}`;
      if (REFUSAL.test(r.text)) throw new RefusedError(detail);
      throw new TransportError(detail);
    }
    let json: unknown = null;
    try {
      json = JSON.parse(r.text);
    } catch {
      if (r.status >= 200 && r.status < 300 && !accept) throw new IntegrityError(`${method} ${path}: HTTP ${r.status} with an incomplete JSON body`);
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

  // Reads use the JSON form (blob sha + size + base64) and are verified locally: the decoded bytes must have
  // the reported size and hash to the reported git blob SHA, and must be valid UTF-8. A truncated or altered
  // body therefore fails instead of being archived as if it were the original.
  read(commit: string, path: string): string | null {
    const key = `${commit}:${path}`;
    if (this.contents.has(key)) return this.contents.get(key)!;
    const r = this.call("GET", `contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`);
    let content: string | null;
    if (r.status === 404) {
      content = null;
    } else if (r.status === 200 && field(r.json, "type") === "file") {
      const sha = text(r.json, "sha");
      const size = field(r.json, "size");
      let b64 = field(r.json, "content");
      if (field(r.json, "encoding") !== "base64" || (typeof b64 === "string" && b64 === "" && size !== 0)) {
        b64 = text(this.ok("GET", `git/blobs/${sha}`), "content"); // large files: content comes from the blob
      }
      const bytes = Buffer.from(String(b64).replace(/\n/g, ""), "base64");
      if (bytes.length !== size || gitBlobSha(bytes) !== sha) {
        throw new IntegrityError(`${path}@${commit}: got ${bytes.length} bytes / ${gitBlobSha(bytes)}, GitHub reports ${String(size)} / ${sha}`);
      }
      content = decodeUtf8Exact(bytes, `${path}@${commit}`); // keeps a BOM; no silent conversion
    } else {
      throw new Error(`read ${path}@${commit} -> ${r.status}${r.status === 200 ? " (not a file)" : ""}`);
    }
    if (/^[0-9a-f]{40}$/.test(commit)) this.contents.set(key, content); // only full SHAs are immutable
    return content;
  }

  // Entries directly under a directory prefix (files or sub-directories); empty means nothing exists there.
  list(commit: string, prefix: string): string[] {
    const dir = prefix.replace(/\/$/, "");
    const r = this.call("GET", `contents/${dir.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`);
    if (r.status === 404) return [];
    if (r.status !== 200) throw new Error(`list ${dir}@${commit} -> ${r.status}`);
    if (!Array.isArray(r.json)) return [dir]; // the prefix is itself a file: occupied
    return r.json.map((e) => String(field(e, "path")));
  }

  changedPaths(base: string, commit: string): string[] {
    const cmp = this.ok("GET", `compare/${base}...${commit}`);
    const files = field(cmp, "files");
    if (!Array.isArray(files)) throw new IntegrityError(`compare ${base}...${commit} has no file list`);
    if (files.length >= 300) throw new IntegrityError(`compare ${base}...${commit} lists ${files.length} files (API limit); cannot verify`);
    return files.map((f) => String(field(f, "filename")));
  }

  commit(base: string, files: Map<string, string | null>, message: string): string {
    const baseTree = text(this.ok("GET", `git/commits/${base}`), "tree", "sha");
    const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const [path, content] of files) {
      if (content === null) {
        tree.push({ path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const bytes = Buffer.from(content, "utf8");
      const blob = text(this.ok("POST", "git/blobs", { content: bytes.toString("base64"), encoding: "base64" }), "sha");
      if (blob !== gitBlobSha(bytes)) throw new IntegrityError(`blob for ${path}: GitHub returned ${blob}, expected ${gitBlobSha(bytes)}`);
      tree.push({ path, mode: "100644", type: "blob", sha: blob });
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
    let r: { status: number; json: unknown; text: string };
    try {
      r = this.call("PATCH", `git/refs/${ref.replace(/^refs\//, "")}`, { sha: newCommit, force: false });
    } catch (e) {
      // The request may have been applied before the answer was lost.
      return { ok: false, kind: "unknown", detail: (e as Error).message };
    }
    const detail = `${r.status}: ${this.message(r)}`;
    if (r.status === 200) {
      return field(r.json, "object", "sha") === newCommit ? { ok: true } : { ok: false, kind: "unknown", detail: `200 without the new sha: ${r.text.slice(0, 120)}` };
    }
    if (r.status === 422 && /fast forward|reference update failed/i.test(detail)) return { ok: false, kind: "stale", detail };
    if (r.status === 403 || r.status === 404) return { ok: false, kind: "permission", detail };
    if (r.status === 422) return { ok: false, kind: "rejected", detail };
    return { ok: false, kind: "unknown", detail }; // 5xx, 409 and anything else: may or may not have applied
  }

  contains(head: string, commit: string): boolean {
    if (head === commit) return true;
    const r = this.call("GET", `compare/${commit}...${head}`);
    if (r.status === 404) return false;
    if (r.status !== 200) throw new Error(`compare ${commit}...${head} -> ${r.status}: ${this.message(r)}`);
    const status = field(r.json, "status");
    return status === "ahead" || status === "identical";
  }

  createRef(ref: string, sha: string): void {
    if (!/^refs\/[^/]+\/.+/.test(ref)) throw new Error(`not a full ref: ${ref}`);
    this.ok("POST", "git/refs", { ref, sha });
  }
}
