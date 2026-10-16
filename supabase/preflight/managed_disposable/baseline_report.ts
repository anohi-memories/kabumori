// Generates the baseline provenance report (F5 Phase 12) from two LOCAL databases built by
// supabase/tests/common_account_phase12_baseline_report_run.sh:
//   fixture world   the reviewed proof baseline (social-mobile fixture + the real prerequisite migrations + lifecycle fixtures)
//   replay world    a bare platform stand-in on which EVERY repository migration is replayed, in order, best effort
// and the repository's migration texts. No production schema, no managed project, no credential is an input.
//
//   deno run --allow-read --allow-write --allow-run=psql --allow-env baseline_report.ts --write <file>
//   deno run ...                                                               baseline_report.ts --check <file>
import { extractRequirements, PREFLIGHT_MIGRATION } from './baseline_requirements.ts';
import { canonicalize, checkRequirements, contractSubset, type Line, parseInventory, validateShape } from './inventory.ts';
import { buildProvenance, type InventoryEvidence, type ReplayResult, type WorldColumn, type WorldFacts } from './provenance.ts';
import { sha256Hex } from './lock.ts';

const root = new URL('../../../', import.meta.url);
const decoder = new TextDecoder();

async function psql(database: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', ...args],
    env: { PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '', PGDATABASE: database, LC_ALL: 'C' },
    stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), err: decoder.decode(out.stderr).trim() };
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

async function worldFacts(database: string): Promise<WorldFacts> {
  const scoped = `n.nspname in ('public', 'private', 'auth', 'storage')`;
  const relations = await psql(database, ['-c', `select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p','v','m') and ${scoped} order by 1`]);
  const columns = await psql(database, ['-c', `select n.nspname || '.' || c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped and ${scoped} order by 1, 2`]);
  const keys = await psql(database, ['-c', `select cn.nspname || '.' || cc.relname,
        (select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum),
        rn.nspname || '.' || rc.relname,
        (select string_agg(a.attname, ',' order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum),
        c.confdeltype
      from pg_constraint c join pg_class cc on cc.oid = c.conrelid join pg_namespace cn on cn.oid = cc.relnamespace
      join pg_class rc on rc.oid = c.confrelid join pg_namespace rn on rn.oid = rc.relnamespace where c.contype = 'f' order by 1, 2`]);
  const functions = await psql(database, ['-c', `select n.nspname || '.' || p.proname || '(' || array_to_string(p.proargtypes::regtype[], ',') || ')'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') order by 1`]);
  for (const result of [relations, columns, keys, functions]) if (!result.ok) throw new Error(result.err.slice(0, 200));
  return {
    relations: lines(relations.out),
    columns: lines(columns.out).map((line): WorldColumn => { const [relation, column, type] = line.split('|'); return { relation, column, type }; }),
    foreignKeys: lines(keys.out).map((line) => { const [rel, cols, ref, refCols, del] = line.split('|'); return `${rel}(${cols})->${ref}(${refCols}) on delete ${del === 'c' ? 'c' : del === 'a' ? 'a' : del}`; }),
    functions: lines(functions.out),
  };
}

async function replay(database: string, migrations: [string, string][]): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  for (const [file] of migrations) {
    const run = await psql(database, ['-f', new URL(`supabase/migrations/${file}`, root).pathname]);
    let error: string | null = null;
    if (!run.ok) {
      const line = run.err.split('\n').find((l) => /ERROR:/u.test(l)) ?? run.err.split('\n')[0] ?? 'failed';
      error = line.replace(/^.*ERROR:\s*/u, '').replace(/\s+/gu, ' ').slice(0, 140);
    }
    results.push({ file, applied: run.ok, error });
  }
  return results;
}

const args = Deno.args;
const mode = args[0];
const target = args[1];
if (!['--write', '--check'].includes(mode) || !target) throw new Error('usage: baseline_report.ts --write|--check <file>');
const fixtureDb = Deno.env.get('P12_FIXTURE_DB') ?? '';
const replayDb = Deno.env.get('P12_REPLAY_DB') ?? '';
if (!fixtureDb || !replayDb) throw new Error('P12_FIXTURE_DB and P12_REPLAY_DB are required (common_account_phase12_baseline_report_run.sh)');

const migrationFiles = [...Deno.readDirSync(new URL('supabase/migrations/', root))].filter((e) => e.isFile && e.name.endsWith('.sql')).map((e) => e.name).sort();
const migrations: [string, string][] = migrationFiles.map((name) => [name, Deno.readTextFileSync(new URL(`supabase/migrations/${name}`, root))]);
const requirements = extractRequirements(Deno.readTextFileSync(new URL(PREFLIGHT_MIGRATION, root)));

const INVENTORY_QUERY = new URL('supabase/preflight/managed_disposable/inventory/schema_inventory.sql', root);

async function inventoryEvidence(): Promise<InventoryEvidence> {
  const query = Deno.readTextFileSync(INVENTORY_QUERY);
  const worlds = {} as InventoryEvidence['worlds'];
  for (const [name, database] of [['fixture', fixtureDb], ['replay', replayDb]] as const) {
    const run = await psql(database, ['-f', INVENTORY_QUERY.pathname]);
    if (!run.ok) throw new Error(`the inventory query failed on the ${name} world: ${run.err.slice(0, 200)}`);
    // the local owner role carries the process id in its name: a report must not depend on it
    const owner = Deno.env.get('PGUSER') ?? '';
    const lines: Line[] = parseInventory(owner === '' ? run.out : run.out.replaceAll(owner, 'db_owner'));
    const shape = validateShape(lines);
    if (shape.length > 0) throw new Error(`the ${name} inventory violates its own contract: ${shape[0].code} ${shape[0].subject}`);
    const subset = contractSubset(lines, requirements);
    const byKind: Record<string, number> = {};
    for (const line of lines) byKind[line.k] = (byKind[line.k] ?? 0) + 1;
    worlds[name] = {
      lines: lines.length,
      byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))),
      findings: checkRequirements(lines, requirements).map((f) => ({ code: f.code, subject: f.subject })).sort((a, b) => `${a.code} ${a.subject}`.localeCompare(`${b.code} ${b.subject}`)),
      contractItems: subset.length,
      contractDigest: (await canonicalize(subset)).digest,
    };
  }
  return { querySha256: await sha256Hex(query), worlds };
}

const replayResults = await replay(replayDb, migrations);
const provenance = {
  ...buildProvenance(requirements, Object.fromEntries(migrations), await worldFacts(fixtureDb), await worldFacts(replayDb), replayResults),
  inventory: await inventoryEvidence(),
};
const text = `${JSON.stringify(provenance, null, 2)}\n`;
if (mode === '--write') {
  Deno.writeTextFileSync(target, text);
  console.log(`wrote ${target}: unknown relations=${provenance.unknown.relations.length} columns=${provenance.unknown.columns.length} replay applied=${replayResults.filter((r) => r.applied).length}/${replayResults.length}`);
} else {
  const committed = Deno.readTextFileSync(target);
  if (committed !== text) {
    console.error('the committed provenance report differs from a fresh generation (regenerate with --write and review the diff)');
    Deno.exit(1);
  }
  console.log(`provenance report is current: unknown relations=${provenance.unknown.relations.length} columns=${provenance.unknown.columns.length}`);
}
