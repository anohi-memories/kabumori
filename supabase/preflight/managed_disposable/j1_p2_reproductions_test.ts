// J1 V1 reproductions of the four P2 findings against the Phase 12 harness (F5). Synthetic data only; no database, no
// network, no process: the child-process and file-read ports are replaced inside the test.
//
// These cases were run FAIL-BEFORE against the exact PR #226 source (3d87a845) and PASS-AFTER against the fix:
//   R1  the probe bytes that are executed are the bytes that were verified
//   R2  a partial step selection cannot reach a chain mutation without a passed baseline read-back (G3b)
//   R3  network / cron capability reaches a caller through multi-hop helpers across the corpus
//   R4  `inventory_cli diff` checks both raw inputs before it parses or prints anything
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Requirements } from './baseline_requirements.ts';
import { ENV, resolveTarget } from './guard.ts';
import { canonicalize, contractSubset, type Line } from './inventory.ts';
import { runInventoryCli } from './inventory_cli.ts';
import { syntheticInventory } from './inventory_fixtures.ts';
import { buildLock, sha256Hex } from './lock.ts';
import { INVENTORY_PATH, STEPS } from './plan.ts';
import { refusalsFor, run, type Step, type Transport } from './runner.ts';
import { createRealTransport } from './transports.ts';

const REF = 'aaaaaaaaaaaaaaaaaaaa';
const provenance = JSON.parse(Deno.readTextFileSync(new URL('./baseline_provenance.json', import.meta.url))) as {
  requirements: Requirements;
  unknown: { relations: string[]; columns: string[]; foreignKeys: string[]; functions: string[] };
};
const requirements = provenance.requirements;
const repoRoot = new URL('../../../', import.meta.url);
const readRepo = (path: string) => Deno.readTextFileSync(new URL(path, repoRoot));
const planLock = JSON.parse(Deno.readTextFileSync(new URL('./plan.lock.json', import.meta.url))) as Parameters<typeof run>[1]['lock'];
const decision = resolveTarget({
  [ENV.projectRef]: REF, [ENV.allowlist]: REF, [ENV.denylist]: 'cccccccccccccccccccc', [ENV.apiUrl]: `https://${REF}.supabase.co`, [ENV.confirm]: REF,
  [ENV.publishableKey]: 'sb_publishable_synthetic_key_value', [ENV.serviceKey]: 'sb_secret_synthetic_key_value_1234',
  [ENV.dbUrl]: `postgres://postgres:synthetic@db.${REF}.supabase.co:5432/postgres`, [ENV.baselineSha256]: 'f'.repeat(64),
  [ENV.baselinePath]: '/tmp/b.sql', [ENV.inventorySha256]: 'e'.repeat(64), [ENV.emailDomain]: 'accept.example.test',
}, { execute: true });
assert.equal(decision.ok, true);

const asText = (lines: Line[]) => lines.map((line) => JSON.stringify(line)).join('\n');

// ---- R1 --------------------------------------------------------------------------------------------------------------

test('R1: the probe bytes that reach psql are the verified pinned bytes, not a second read of the path', async () => {
  const PINNED = 'select 1; -- the pinned inventory query';
  const REPLACEMENT = 'select 2; -- a replacement written after the check';
  const lock = { files: { [INVENTORY_PATH]: await sha256Hex(PINNED) } };
  let reads = 0;
  const reader = { read: (path: string) => (path === INVENTORY_PATH ? (++reads === 1 ? PINNED : REPLACEMENT) : '') };

  // the two ports are replaced for the duration of the call: the file system read and the child process
  const patch = Deno as unknown as { readTextFile: unknown; Command: unknown };
  const originalRead = patch.readTextFile;
  const originalCommand = patch.Command;
  const sentToPsql: string[] = [];
  let fileReadsByTransport = 0;
  patch.readTextFile = (path: string) => {
    fileReadsByTransport++;
    return Promise.resolve(path === INVENTORY_PATH || String(path).endsWith('schema_inventory.sql') ? REPLACEMENT : '');
  };
  patch.Command = class {
    spawn() {
      return {
        stdin: { getWriter: () => ({ write: (bytes: Uint8Array) => { sentToPsql.push(new TextDecoder().decode(bytes)); return Promise.resolve(); }, close: () => Promise.resolve() }) },
        output: () => Promise.resolve({ success: true, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      };
    }
  };
  try {
    const transport = createRealTransport({ baseUrl: `https://${REF}.supabase.co`, publishableKey: 'p', serviceKey: 's', dbUrl: `postgres://postgres:x@db.${REF}.supabase.co:5432/postgres` });
    const probeStep: Step = {
      id: 'P', title: 'probe', access: 'read', mode: 'automated', modelled: false, expected: 'the pinned query is sent', stop: 'anything else',
      run: async (ctx) => { await ctx.probe(INVENTORY_PATH); return { status: 'PASS', detail: 'sent' }; },
    };
    const report = await run([probeStep], { mode: 'execute', decision, transport, lock, reader });
    assert.equal(report.results[0].status, 'PASS', report.results[0].detail);
  } finally {
    patch.readTextFile = originalRead;
    patch.Command = originalCommand;
  }
  assert.deepEqual(sentToPsql, [PINNED], 'psql received exactly the verified bytes');
  assert.equal(fileReadsByTransport, 0, 'the transport never reads the path itself');
  assert.equal(reads, 1, 'the path is read once, by the runner, before the check');
});

// ---- R2 --------------------------------------------------------------------------------------------------------------

function recordingTransport(inventory: string) {
  const calls: string[] = [];
  const transport: Transport = {
    http: () => { calls.push('http'); return Promise.resolve({ status: 200, body: {} }); },
    sqlRead: (query) => { calls.push('read'); return Promise.resolve(query.includes('kabumori_disposable_marker') ? REF : ''); },
    sqlApplyFile: (path) => { calls.push(`apply ${path}`); return Promise.resolve(''); },
    sqlProbe: (path) => { calls.push(`probe ${path}`); return Promise.resolve(inventory); },
    sqlHoldLock: () => Promise.resolve({ release: () => Promise.resolve() }),
  };
  return { calls, transport };
}

test('R2: a valid-shaped but unapproved digest with only=[G3-P1] applies nothing', async () => {
  const lines = syntheticInventory(requirements);
  const { calls, transport } = recordingTransport(asText(lines));
  const lock = { ...planLock, approvedInventory: 'e'.repeat(64) };
  const report = await run(STEPS, { mode: 'execute', decision, transport, lock, reader: { read: readRepo }, only: ['G3-P1'] });
  assert.equal(calls.filter((c) => c.startsWith('apply')).length, 0, `calls: ${calls.join(' | ')}`);
  assert.equal(report.results.some((r) => r.id === 'G3-P1' && r.status === 'PASS'), false);
  assert.equal(report.complete, false);
});

test('R2 positive control: with G3b selected and the approved contract the chain file is applied exactly once', async () => {
  const lines = syntheticInventory(requirements);
  const approved = (await canonicalize(contractSubset(lines, requirements))).digest;
  const { calls, transport } = recordingTransport(asText(lines));
  const lock = { ...planLock, approvedInventory: approved };
  const report = await run(STEPS, { mode: 'execute', decision, transport, lock, reader: { read: readRepo }, only: ['G1', 'G3b', 'G3-P1'] });
  const byId = new Map(report.results.map((r) => [r.id, r]));
  assert.equal(byId.get('G3b')?.status, 'PASS', byId.get('G3b')?.detail);
  assert.equal(calls.filter((c) => c.startsWith('apply')).length, 1);
});

// ---- R3 --------------------------------------------------------------------------------------------------------------

const LEAF = "create function public.audit_leaf() returns void language plpgsql as $$ begin perform net.http_post('https://hooks.example.test/x', '{}'::jsonb); end $$;";
const MIDDLE = 'create function public.audit_middle() returns void language plpgsql as $$ begin perform public.audit_leaf(); end $$;';
const TOP = 'select public.audit_middle();';

test('R3: leaf (net.http_post) -> middle -> top SELECT is refused even though the SELECT fingerprint is pinned', async () => {
  const corpus = { '20260101000000_leaf.sql': LEAF, '20260102000000_middle.sql': MIDDLE };
  const lock = await buildLock(['top.sql'], (path) => (path === 'top.sql' ? TOP : ''), corpus);
  assert.ok(Object.values(lock.reviewed?.['top.sql']?.selects ?? []).length === 1, 'the top-level SELECT is accepted by its fingerprint');
  const refusals = await refusalsFor(TOP, lock.reviewed?.['top.sql'], lock.networkFunctions ?? [], REF);
  assert.ok(refusals.includes('INDIRECT_NETWORK_CALL'), `refusals: ${refusals.join(',') || '(none)'}`);

  // through the actual runner, with a baseline read-back that passed: the file is still not sent
  const sent: string[] = [];
  const transport: Transport = {
    http: () => Promise.resolve({ status: 200, body: {} }),
    sqlRead: () => Promise.resolve(REF),
    sqlApplyFile: (path) => { sent.push(path); return Promise.resolve(''); },
    sqlProbe: () => Promise.resolve(''),
    sqlHoldLock: () => Promise.resolve({ release: () => Promise.resolve() }),
  };
  const GATE = 'gate.sql';
  const APPROVED = 'e'.repeat(64);
  const gate: Step = {
    id: 'G3b', title: 'gate', access: 'read', mode: 'automated', modelled: false, expected: 'passes', stop: 'never',
    run: async (ctx) => {
      await ctx.probe(GATE);
      return { status: 'PASS', detail: 'ok', evidence: { kind: 'baseline_contract', digest: APPROVED, probePath: GATE } } as never;
    },
  };
  const apply: Step = {
    id: 'A', title: 'apply', access: 'mutate', mode: 'automated', modelled: false, expected: 'refused', stop: 'sent',
    run: async (ctx) => { await ctx.applyFile({ id: 'A', path: 'top.sql', kind: 'chain' }); return { status: 'PASS', detail: 'applied' }; },
  };
  const files = { 'top.sql': await sha256Hex(TOP), [GATE]: await sha256Hex('select 1;') };
  const report = await run([gate, apply], {
    mode: 'execute', decision, transport, lock: { ...lock, files, approvedInventory: APPROVED } as never,
    reader: { read: (path) => (path === GATE ? 'select 1;' : TOP) },
  });
  assert.deepEqual(sent, []);
  assert.match(report.results[1].detail, /INDIRECT_NETWORK_CALL/u);
});

test('R3: a direct call, a cycle and a helper split over three files are all reached; a harmless helper is not', async () => {
  const corpus = {
    '01_leaf.sql': "create function public.leaf_a() returns void language sql as 'select net.http_post(''x'', ''{}''::jsonb)';",
    '02_cycle_1.sql': 'create function public.ping() returns void language plpgsql as $$ begin perform public.pong(); perform public.leaf_a(); end $$;',
    '03_cycle_2.sql': 'create function public.pong() returns void language plpgsql as $$ begin perform public.ping(); end $$;',
    '04_harmless.sql': 'create function public.harmless() returns int language sql as $$ select 1 $$;',
    '05_other.sql': 'create function public.uses_harmless() returns int language sql as $$ select public.harmless() $$;',
  };
  const lock = await buildLock([], () => '', corpus);
  const refuses = (sql: string) => refusalsFor(sql, { dynamic: [], writes: [], selects: [] }, lock.networkFunctions ?? [], REF);
  assert.ok((await refuses('select public.leaf_a();')).includes('INDIRECT_NETWORK_CALL'), 'single-quoted body leaf, direct call');
  assert.ok((await refuses('select public.ping();')).includes('INDIRECT_NETWORK_CALL'), 'cycle member that reaches the leaf');
  assert.ok((await refuses('select public.pong();')).includes('INDIRECT_NETWORK_CALL'), 'the other cycle member');
  assert.ok((await refuses('select ping();')).includes('INDIRECT_NETWORK_CALL'), 'unqualified spelling');
  assert.ok(!(await refuses('select public.uses_harmless();')).includes('INDIRECT_NETWORK_CALL'), 'a helper that reaches nothing is not refused');
});

// ---- R4 --------------------------------------------------------------------------------------------------------------

const SENTINEL = ['sb_secret_', 'R4SyntheticSentinel0123456789'].join('');

test('R4: diff stops on a contaminated manifest, equal or different, and prints neither the value nor the path', async () => {
  const clean = syntheticInventory(requirements);
  const dirty = syntheticInventory(requirements);
  dirty.push({ k: 'schema', key: `s_${SENTINEL}`, a: { scope: 'app', owner: 'postgres', acl: null } });
  const secretPath = `/tmp/${SENTINEL}/approved.ndjson`;
  const files: Record<string, string> = { [secretPath]: asText(clean), '/tmp/unsafe-a.ndjson': asText(dirty), '/tmp/unsafe-b.ndjson': asText(dirty), '/tmp/clean-b.ndjson': asText(clean) };
  const read = (path: string) => {
    if (!(path in files)) throw new Error(`ENOENT ${path}`);
    return files[path];
  };
  const different = await runInventoryCli(['diff', secretPath, '/tmp/unsafe-a.ndjson'], read, provenance);
  const equal = await runInventoryCli(['diff', '/tmp/unsafe-a.ndjson', '/tmp/unsafe-b.ndjson'], read, provenance);
  for (const [name, result] of [['different', different], ['equal', equal]] as const) {
    assert.equal(result.code, 1, `${name}: ${result.output}`);
    assert.ok(!result.output.includes(SENTINEL), `${name} output must not carry the value`);
    assert.ok(!result.output.includes('/tmp/'), `${name} output must not carry a path`);
    assert.ok(!/no drift/u.test(result.output), `${name} must not report "no drift"`);
  }
  // a missing file does not echo its path either
  const missing = await runInventoryCli(['diff', '/tmp/nope-' + SENTINEL, '/tmp/clean-b.ndjson'], read, provenance);
  assert.equal(missing.code, 1);
  assert.ok(!missing.output.includes(SENTINEL));
  // positive control: two clean manifests still diff
  const ok = await runInventoryCli(['diff', secretPath, '/tmp/clean-b.ndjson'], read, provenance);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /no drift/u);
});
