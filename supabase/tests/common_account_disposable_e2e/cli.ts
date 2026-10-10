// Phase 3c offline CLI: prints the dry-run plan and validates a FUTURE run request against the deny-by-default
// guard. It has no execute command and no network code; run it with read permission only:
//   deno run --no-config --allow-read supabase/tests/common_account_disposable_e2e/cli.ts plan
//   deno run --no-config --allow-read supabase/tests/common_account_disposable_e2e/cli.ts validate \
//     --request /abs/path/run-request.json --ledger /abs/path/used-projects.json
// Exit codes: 0 plan printed / request valid (dry run only), 2 usage refused, 3 request denied.
import { validateRunRequest } from './guard.ts';
import { renderPlan } from './plan.ts';

export interface CliDeps {
  readText(path: string): Promise<string>;
  realPath(path: string): Promise<string>;
  repoRoot: string;
  now: Date;
}
export interface CliResult {
  code: 0 | 2 | 3;
  out: string;
}

const OVERRIDE_FLAG = /^-(-?)(force|f|y|yes|skip|skip-guard|no-guard|override|unsafe|i-know|allow-production|execute|run|apply)(=.*)?$/iu;

async function readJson(deps: CliDeps, path: string | undefined): Promise<unknown> {
  if (!path) return undefined;
  try {
    return JSON.parse(await deps.readText(path));
  } catch {
    return undefined;
  }
}

export async function run(args: readonly string[], deps: CliDeps): Promise<CliResult> {
  const [command, ...rest] = args;
  for (const arg of args) {
    if (OVERRIDE_FLAG.test(arg)) return { code: 2, out: `OVERRIDE_NOT_SUPPORTED: ${arg.replace(/=.*$/u, '')}\n` };
  }
  if (command === 'plan' && rest.length === 0) return { code: 0, out: renderPlan() };
  if (command !== 'validate') return { code: 2, out: 'USAGE: plan | validate --request <abs path> --ledger <abs path>\n' };
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if ((flag !== '--request' && flag !== '--ledger') || value === undefined || value.startsWith('-') || options.has(flag)) {
      return { code: 2, out: `UNKNOWN_OR_REPEATED_ARGUMENT: ${flag ?? ''}\n` };
    }
    options.set(flag, value);
  }
  if (!options.has('--request') || !options.has('--ledger')) return { code: 2, out: 'USAGE: validate needs --request and --ledger\n' };
  const request = await readJson(deps, options.get('--request'));
  const ledger = await readJson(deps, options.get('--ledger'));
  const requested = (typeof request === 'object' && request !== null) ? (request as Record<string, unknown>).project_marker_path : undefined;
  let markerPath: string | null = null;
  let marker: unknown;
  if (typeof requested === 'string' && requested.startsWith('/')) {
    try {
      // A symlink resolves elsewhere and is refused as a path mismatch: the marker must be the file named.
      markerPath = await deps.realPath(requested);
      marker = await readJson(deps, markerPath);
    } catch {
      markerPath = requested;
      marker = undefined;
    }
  } else if (typeof requested === 'string') {
    markerPath = requested;
  }
  const guard = validateRunRequest({ request, marker, markerPath, ledger, repoRoot: deps.repoRoot, now: deps.now });
  return { code: guard.allowed ? 0 : 3, out: renderPlan(guard) };
}

if (import.meta.main) {
  const repoRoot = decodeURIComponent(new URL('../../../', import.meta.url).pathname).replace(/\/+$/u, '');
  const result = await run(Deno.args, {
    readText: (path) => Deno.readTextFile(path),
    realPath: (path) => Deno.realPath(path),
    repoRoot: await Deno.realPath(repoRoot),
    now: new Date(),
  });
  await Deno.stdout.write(new TextEncoder().encode(result.out));
  Deno.exit(result.code);
}
