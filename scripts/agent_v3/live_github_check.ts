import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { GitHubBackend } from "./github_backend.ts";
import { catalog, indexPath, initRoot, parseHeader, planTaskWrite, verifyRoot } from "./registry.ts";
import { type Backend, MAIN_REF, runTransaction } from "./transaction.ts";

// Live check of the GitHub backend against a dedicated ref outside refs/heads/ (no branch, so no branch
// push and no preview deployment), using a fixture root that exists nowhere else. It never writes main or
// any branch: refs/heads/* is refused below.
//   deno run --no-config --allow-run --allow-env scripts/agent_v3/live_github_check.ts \
//     --repo anohi-memories/kabumori --ref refs/agent-v3-live-test/<unique-name>

const ROOT = ".agent_v3_live_fixture";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

function task(slot: string, owner: string, code: string, id: string, status: string, next: string): string {
  return [
    `# ${slot} — live fixture`,
    "",
    `- task_id: ${id}`,
    `- owner: ${owner}`,
    `- slot: ${slot}`,
    `- status: ${status}`,
    `- next_owner: ${next}`,
    `- start_code: ${slot}`,
    `- completion_code: ${code}`,
    "- return_to: agent-v3-live-fixture",
    "- recommended_model: Opus5.5（高）",
    "",
    "## Report",
    "",
    "- result: fixture",
    "",
  ].join("\n");
}

function staleFirstHead(inner: Backend, stale: string): Backend {
  let first = true;
  return {
    name: "stale-first",
    head: (ref) => (first ? ((first = false), stale) : inner.head(ref)),
    read: (c, p) => inner.read(c, p),
    commit: (b, f, m) => inner.commit(b, f, m),
    publish: (r, n, e) => inner.publish(r, n, e),
    contains: (h, c) => inner.contains(h, c),
  };
}

export function main(): void {
  const repo = arg("repo");
  const ref = arg("ref");
  if (!/^refs\/agent-v3-live-test\/[a-z0-9-]+$/.test(ref)) throw new Error("ref must be refs/agent-v3-live-test/<name> (never a branch)");
  const gh = new GitHubBackend(repo);
  const defs = catalog(ROOT, "FJ");
  const log: Record<string, unknown> = { repo, ref };

  const mainBefore = gh.head(MAIN_REF);
  assert.equal(gh.read(mainBefore, indexPath(ROOT)), null, "fixture root must not exist on main");
  gh.createRef(ref, mainBefore);
  log.created_from_main = mainBefore;

  const init = runTransaction(gh, defs, ref, () => ({ files: initRoot(defs, ROOT), expectations: new Map(), message: "agent_v3 live fixture: init" }));
  assert.equal(init.code, "WRITTEN_TO_BRANCH_NOT_REGISTERED", init.detail);
  log.init = { code: init.code, commit: init.commit, files: initRoot(defs, ROOT).size };

  const j1 = runTransaction(gh, defs, ref, (read) =>
    planTaskWrite(defs, ROOT, read, "J1", task("J1", "codex", "V1", "live-fixture-j1-assign-20261016", "ready", "codex"), { task_id: "none", status: "idle" }, null, "agent_v3 live fixture: assign J1"));
  assert.equal(j1.code, "WRITTEN_TO_BRANCH_NOT_REGISTERED", j1.detail);
  assert.equal(j1.readback!.J1.actual.task_id, "live-fixture-j1-assign-20261016");
  log.write_j1 = { code: j1.code, commit: j1.commit, readback: j1.readback };

  // Compare-and-swap on GitHub itself: two commits on the same base; the second ref update must be refused.
  const h = gh.head(ref);
  const c1 = gh.commit(h, new Map([[`${ROOT}/cas/a.md`, "a\n"]]), "agent_v3 live fixture: cas a");
  const c2 = gh.commit(h, new Map([[`${ROOT}/cas/b.md`, "b\n"]]), "agent_v3 live fixture: cas b");
  const p1 = gh.publish(ref, c1, h);
  const p2 = gh.publish(ref, c2, h);
  assert.equal(p1.ok, true);
  assert.equal(p2.ok, false);
  assert.equal((p2 as { kind: string }).kind, "stale");
  log.cas = { base: h, first: { commit: c1, result: p1 }, second: { commit: c2, result: p2 } };

  // Stale writer on a different slot re-plans and lands; stale writer on the same slot is refused.
  const old = h;
  const f2 = runTransaction(staleFirstHead(gh, old), defs, ref, (read) =>
    planTaskWrite(defs, ROOT, read, "F2", task("F2", "claude", "L2", "live-fixture-f2-parallel-20261016", "ready", "claude"), { task_id: "none", status: "idle" }, null, "agent_v3 live fixture: parallel F2"));
  assert.equal(f2.code, "WRITTEN_TO_BRANCH_NOT_REGISTERED", f2.detail);
  assert.equal(f2.attempts, 2);
  // Starts from the init commit, where J1 was still idle: plans fine, loses the CAS, then sees J1 taken.
  const j1b = runTransaction(staleFirstHead(gh, init.commit!), defs, ref, (read) =>
    planTaskWrite(defs, ROOT, read, "J1", task("J1", "codex", "V1", "live-fixture-j1-second-writer-20261016", "ready", "codex"), { task_id: "none", status: "idle" }, null, "agent_v3 live fixture: second J1"));
  assert.equal(j1b.code, "CONFLICT_SAME_SLOT");
  assert.equal(j1b.attempts, 2);
  log.parallel = { f2: { code: f2.code, attempts: f2.attempts, commit: f2.commit }, same_slot: { code: j1b.code, attempts: j1b.attempts, detail: j1b.detail } };

  const head = gh.head(ref);
  const findings = verifyRoot(defs, (p) => gh.read(head, p), ROOT, true);
  assert.deepEqual(findings, []);
  assert.equal(parseHeader(gh.read(head, defs.find((d) => d.slot === "J1")!.taskPath)).task_id, "live-fixture-j1-assign-20261016");
  log.final = { head, findings };

  const mainAfter = gh.head(MAIN_REF);
  assert.equal(gh.read(mainAfter, indexPath(ROOT)), null, "main never received the fixture");
  log.main = { before: mainBefore, after: mainAfter, fixture_on_main: false };
  console.log(JSON.stringify(log, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
