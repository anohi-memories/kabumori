import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { GitBackend } from "./git_backend.ts";
import { DEFAULT_ALLOWED_REPOS, GitHubBackend } from "./github_backend.ts";
import { assertSafeRoot, catalog, type Expect, type Naming, planArchive, planInit, planTaskWrite, slotState, verifyRoot } from "./registry.ts";
import { type Backend, checkMaxAttempts, MAIN_REF, type Outcome, redact, runTransaction, type TransactionOptions } from "./transaction.ts";

// Usage (deno run --no-config --allow-run --allow-read --allow-env scripts/agent_v3/cli.ts ...):
//   verify  --root <root> [--legacy-v2] [--naming FJ|GH]       read-only consistency check (any root)
//   show    --root <root> --slot F3                             read-only: task_id / status / SHA256s to expect
//   init    --root .agent_v3_x                                  create an idle V3 root (one commit)
//   write   --slot F3 --task-file f.md [--report-file r.md] --expect-task-id X --expect-status S
//           --expect-sha256 <task sha> [--expect-report-sha256 <sha|missing>] --message M
//   archive --slot F3 --expect-task-id X --expect-sha256 <task sha> [--expect-report-sha256 <sha>] --date YYYY-MM-DD
// Common: --backend git|github  --repo <dir | owner/name>  [--remote origin]  [--ref <ref>]  [--max-attempts 1-5]
// Writes go only to a V3 root (.agent_v3*), only to refs/agent-v3-live-test/* unless --allow-main is given,
// and only to the allowed GitHub repository (a local-path remote needs --allow-local-remote).
// Exit: 0 registered on main; 3 written to a non-main ref only; 2 verify findings; 1 anything else.

const GITHUB_REMOTE = /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(\.git)?$/;

export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = { _: argv[0] ?? "" };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

function need(args: Record<string, string | true>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") throw new Error(`--${key} is required`);
  return v;
}

function backendFor(args: Record<string, string | true>, writing: boolean): Backend {
  const kind = typeof args.backend === "string" ? args.backend : "git";
  if (kind === "github") return new GitHubBackend(need(args, "repo"));
  if (kind !== "git") throw new Error(`unknown backend ${kind}`);
  const git = new GitBackend(need(args, "repo"), typeof args.remote === "string" ? args.remote : "origin");
  if (writing) {
    const url = git.remoteUrl();
    const m = url.match(GITHUB_REMOTE);
    const local = !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.includes("@");
    if (m ? !DEFAULT_ALLOWED_REPOS.includes(m[2]) : !(local && args["allow-local-remote"] === true)) {
      throw new Error(`remote ${redact(url)} is not an allowed destination`);
    }
  }
  return git;
}

function expectFrom(args: Record<string, string | true>): Expect {
  const e: Expect = { task_id: need(args, "expect-task-id"), status: need(args, "expect-status"), task_sha256: need(args, "expect-sha256") };
  if (typeof args["expect-report-sha256"] === "string") e.report_sha256 = args["expect-report-sha256"];
  return e;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const command = String(args._);
  const root = need(args, "root");
  const naming = (typeof args.naming === "string" ? args.naming : "FJ") as Naming;
  const defs = catalog(root, naming);
  const ref = typeof args.ref === "string" ? args.ref : MAIN_REF;
  const writing = ["init", "write", "archive"].includes(command);
  if (writing) assertSafeRoot(root);
  const maxAttempts = checkMaxAttempts(typeof args["max-attempts"] === "string" ? Number(args["max-attempts"]) : 3);
  const backend = backendFor(args, writing);
  const options: TransactionOptions = { root, allowMain: args["allow-main"] === true, maxAttempts };

  if (command === "verify" || command === "show") {
    const head = backend.head(ref);
    const read = (p: string) => backend.read(head, p);
    if (command === "show") {
      console.log(JSON.stringify({ ref, head, ...slotState(defs, read, need(args, "slot")) }, null, 2));
      return 0;
    }
    const findings = verifyRoot(defs, read, root, args["legacy-v2"] !== true);
    console.log(JSON.stringify({ ref, head, root, findings }, null, 2));
    return findings.length ? 2 : 0;
  }

  let outcome: Outcome;
  if (command === "init") {
    outcome = runTransaction(backend, defs, ref, (_read, _base, list) => planInit(defs, root, list), options);
  } else if (command === "write") {
    const slot = need(args, "slot");
    const task = readFileSync(need(args, "task-file"), "utf8");
    const report = typeof args["report-file"] === "string" ? readFileSync(args["report-file"], "utf8") : null;
    const expect = expectFrom(args);
    const message = need(args, "message");
    outcome = runTransaction(backend, defs, ref, (read) => planTaskWrite(defs, root, read, slot, task, expect, report, message), options);
  } else if (command === "archive") {
    const slot = need(args, "slot");
    const expect = { ...expectFrom({ ...args, "expect-status": "done" }) };
    const date = need(args, "date");
    outcome = runTransaction(backend, defs, ref, (read, base, list) => planArchive(defs, root, read, list, slot, expect, base, date), options);
  } else {
    throw new Error(`unknown command ${command}`);
  }
  console.log(JSON.stringify(outcome, null, 2));
  return outcome.registered ? 0 : outcome.code === "WRITTEN_TO_BRANCH_NOT_REGISTERED" ? 3 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(redact(String(e instanceof Error ? e.message : e)));
    process.exit(1);
  }
}
