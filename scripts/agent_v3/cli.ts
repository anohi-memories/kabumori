import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { GitBackend } from "./git_backend.ts";
import { GitHubBackend } from "./github_backend.ts";
import { catalog, indexPath, initRoot, type Naming, planArchive, PlanError, planTaskWrite, verifyRoot } from "./registry.ts";
import { type Backend, MAIN_REF, type Outcome, runTransaction } from "./transaction.ts";

// Usage (deno run --allow-run --allow-read --allow-env --allow-write=<tmp> scripts/agent_v3/cli.ts ...):
//   verify  --root .agent_v3 [--legacy-v2] [--naming FJ|GH]           read-only consistency check
//   init    --root .agent_v3_x                                          create an idle root (one commit)
//   write   --slot F3 --task-file f.md [--report-file r.md] --expect-task-id X --expect-status S --message M
//   archive --slot F3 --expect-task-id X --date YYYY-MM-DD
// Common: --backend git|github  --repo <dir | owner/name>  [--remote origin]  [--ref refs/heads/main]
// Exit: 0 registered on main; 3 written to a non-main branch only; 2 verify findings; 1 anything else.

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

function backendFor(args: Record<string, string | true>): Backend {
  const kind = typeof args.backend === "string" ? args.backend : "git";
  if (kind === "git") return new GitBackend(need(args, "repo"), typeof args.remote === "string" ? args.remote : "origin");
  if (kind === "github") return new GitHubBackend(need(args, "repo"));
  throw new Error(`unknown backend ${kind}`);
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  const root = need(args, "root");
  const naming = (typeof args.naming === "string" ? args.naming : "FJ") as Naming;
  const defs = catalog(root, naming);
  const ref = typeof args.ref === "string" ? args.ref : MAIN_REF;
  const backend = backendFor(args);
  const maxAttempts = typeof args["max-attempts"] === "string" ? Number(args["max-attempts"]) : 3;

  if (args._ === "verify") {
    const head = backend.head(ref);
    const findings = verifyRoot(defs, (p) => backend.read(head, p), root, args["legacy-v2"] !== true);
    console.log(JSON.stringify({ ref, head, root, findings }, null, 2));
    return findings.length ? 2 : 0;
  }

  let outcome: Outcome;
  if (args._ === "init") {
    outcome = runTransaction(backend, defs, ref, (read) => {
      if (read(indexPath(root)) !== null) throw new PlanError("invalid", `${root} already exists`);
      return { files: initRoot(defs, root), expectations: new Map(), message: `agent_v3: initialise ${root}` };
    }, { maxAttempts });
  } else if (args._ === "write") {
    const slot = need(args, "slot");
    const task = readFileSync(need(args, "task-file"), "utf8");
    const report = typeof args["report-file"] === "string" ? readFileSync(args["report-file"], "utf8") : null;
    const expect = { task_id: need(args, "expect-task-id"), status: need(args, "expect-status") };
    const message = need(args, "message");
    outcome = runTransaction(backend, defs, ref, (read) => planTaskWrite(defs, root, read, slot, task, expect, report, message), { maxAttempts });
  } else if (args._ === "archive") {
    const slot = need(args, "slot");
    const id = need(args, "expect-task-id");
    const date = need(args, "date");
    outcome = runTransaction(backend, defs, ref, (read, base) => planArchive(defs, root, read, slot, id, base, date), { maxAttempts });
  } else {
    throw new Error(`unknown command ${String(args._)}`);
  }
  console.log(JSON.stringify(outcome, null, 2));
  return outcome.registered ? 0 : outcome.code === "WRITTEN_TO_BRANCH_NOT_REGISTERED" ? 3 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
