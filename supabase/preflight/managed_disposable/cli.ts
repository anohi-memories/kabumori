// Entry point of the managed-disposable acceptance harness (F5 Phase 11). SOURCE ONLY.
//
//   deno run --no-config --allow-read --allow-env=KABUMORI_DISPOSABLE_PROJECT_REF,... cli.ts      # DRY RUN (default)
//   ... cli.ts --execute --only=G1,G2     # NOT to be run in this phase: needs a separately approved, exact disposable project
//
// A dry run prints the plan, which gate would refuse an execution and why, and calls nothing. `--execute` refuses
// unless guard.ts resolved a target; this phase's TASK forbids using any credential, so it must not be run.
import { ENV, projectRefsIn, resolveTarget } from './guard.ts';
import { buildLock } from './lock.ts';
import { BASELINE, CHAIN, INVENTORY_PATH, PROBE_PATH, STEPS } from './plan.ts';
import { type Lock, render, run } from './runner.ts';
import { createRealTransport } from './transports.ts';

const here = new URL('.', import.meta.url);
const repoRoot = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, repoRoot));

function repositoryRefs(): string[] {
  const found = new Set<string>();
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', repoRoot))) {
    if (entry.isFile && entry.name.endsWith('.sql')) for (const ref of projectRefsIn(read(`supabase/migrations/${entry.name}`))) found.add(ref);
  }
  return [...found].sort();
}

const args = new Set(Deno.args);
const only = Deno.args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);
const execute = args.has('--execute');
const lockPath = new URL('plan.lock.json', here);
const lockedPaths = [...CHAIN.map((file) => file.path), PROBE_PATH];

if (args.has('--write-lock')) {
  const corpus: Record<string, string> = {};
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', repoRoot))) {
    if (entry.isFile && entry.name.endsWith('.sql')) corpus[entry.name] = read(`supabase/migrations/${entry.name}`);
  }
  const lock = await buildLock(lockedPaths, read, corpus, [INVENTORY_PATH]);
  Deno.writeTextFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`wrote ${lockPath.pathname} (${Object.keys(lock.files).length} files)`);
  Deno.exit(0);
}

// Only the harness's own variables are read (run with --allow-env=<exactly these names>).
const env: Record<string, string | undefined> = Object.fromEntries(Object.values(ENV).map((name) => [name, Deno.env.get(name)]));
const decision = resolveTarget(env, { execute, repositoryRefs: repositoryRefs() });
const lock = JSON.parse(Deno.readTextFileSync(lockPath)) as Lock;
// The baseline is the one file that is not in the repository: its digest and path come from the operator.
const baselineDigest = (env[ENV.baselineSha256] ?? '').trim();
if (baselineDigest !== '') lock.files[BASELINE.path] = baselineDigest;
// ... and so is the digest of the baseline CONTRACT the owner approved from a production inventory (Phase 12): it is never in the lock file
const approvedInventory = (env[ENV.inventorySha256] ?? '').trim();
if (approvedInventory !== '') lock.approvedInventory = approvedInventory;
const reader = { read: (path: string) => (path === BASELINE.path ? Deno.readTextFileSync(env[ENV.baselinePath] ?? '') : read(path)) };
const secrets = [env[ENV.publishableKey], env[ENV.serviceKey], env[ENV.dbUrl]];

if (!execute) {
  const report = await run(STEPS, { mode: 'dry-run', decision, lock, reader });
  console.log(render(report, secrets));
  const readiness = resolveTarget(env, { execute: true, repositoryRefs: repositoryRefs() });
  console.log(readiness.ok ? 'an execution would pass the target guard' : `an execution would be REFUSED: ${readiness.failures.map((f) => f.code).join(', ')}`);
  Deno.exit(0);
}

if (!decision.ok) {
  console.log(render(await run(STEPS, { mode: 'execute', decision, lock, reader }), secrets));
  Deno.exit(2);
}
const transport = createRealTransport({
  baseUrl: decision.target.baseUrl, publishableKey: env[ENV.publishableKey] ?? '', serviceKey: env[ENV.serviceKey] ?? '', dbUrl: env[ENV.dbUrl] ?? '',
});
const report = await run(STEPS, { mode: 'execute', decision, transport, lock, reader, secrets, only });
console.log(render(report, secrets));
Deno.exit(report.summary.fail + report.summary.stop > 0 ? 1 : 0);
