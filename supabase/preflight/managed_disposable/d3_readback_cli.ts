// Checks a settings read-back sheet (see d3_readback.ts). OFFLINE: it reads the sheet file and the repository's own migrations (to learn
// which project is production, as cli.ts does) and nothing else; no network, no project, no environment variable. It prints finding
// codes and short details only -- never a value of the sheet.
//
//   deno run --no-config --allow-read supabase/preflight/managed_disposable/d3_readback_cli.ts \
//     --sheet=<path to the sheet, kept outside git> --stage=created|deployed --redirects=both-exact|auth-only [--function=<name>:<sha256>]...
//
// Exit 0 = no STOP finding; 1 = at least one STOP (or unreadable input); 2 = wrong usage.
import { checkReadbackSheet, type ReadbackOptions } from './d3_readback.ts';
import { projectRefsIn } from './guard.ts';
import { sha256Hex } from './lock.ts';

const root = new URL('../../../', import.meta.url);
const args = Deno.args;
const value = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sheetPath = value('sheet');
const stage = value('stage');
const redirects = value('redirects');
if (!sheetPath || (stage !== 'created' && stage !== 'deployed') || (redirects !== 'both-exact' && redirects !== 'auth-only')) {
  console.log('usage: --sheet=<file> --stage=created|deployed --redirects=both-exact|auth-only [--function=<name>:<sha256>]...');
  Deno.exit(2);
}
const expectedFunctions: Record<string, string> = {};
for (const arg of args.filter((item) => item.startsWith('--function='))) {
  const [name, digest] = arg.slice('--function='.length).split(':');
  if (!name || !/^[0-9a-f]{64}$/u.test(digest ?? '')) {
    console.log('--function must be <name>:<64 hex>');
    Deno.exit(2);
  }
  expectedFunctions[name] = digest;
}

const refs = new Set<string>();
for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) {
  if (entry.isFile && entry.name.endsWith('.sql')) for (const ref of projectRefsIn(Deno.readTextFileSync(new URL(`supabase/migrations/${entry.name}`, root)))) refs.add(ref);
}
const options: ReadbackOptions = {
  stage, redirectPolicy: redirects, expectedFunctions, productionRefSha256: await Promise.all([...refs].map((ref) => sha256Hex(ref))),
};
let sheet: unknown;
try {
  sheet = JSON.parse(Deno.readTextFileSync(sheetPath));
} catch {
  console.log('READBACK|STOP|SHEET_SHAPE|the sheet cannot be read as JSON');
  Deno.exit(1);
}
const report = checkReadbackSheet(sheet, options);
for (const finding of report.findings) console.log(`READBACK|${finding.severity === 'stop' ? 'STOP' : 'WARN'}|${finding.code}|${finding.detail}`);
console.log(report.ok ? 'READBACK|OK|no STOP finding (this is not a sign-off)' : 'READBACK|REFUSED|at least one STOP finding');
Deno.exit(report.ok ? 0 : 1);
