// Phase 11 (F5): the managed-disposable acceptance PLAN (supabase/preflight/managed_disposable), executed by its real
// runner over a MODEL of the managed services: the Phase 9 fake GoTrue / PostgREST seams in front of a local database
// that holds the production-shaped baseline. The harness applies the ten chain files and runs the probe and the checks
// itself; only the transports are stand-ins. Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER, PGDATABASE (harness world),
// PGDATABASE_WRONG_MARKER, PGDATABASE_TAMPER, PGDATABASE_NOFENCE, P11_REF, P11_PRODUCTION_LIKE
// (common_account_phase11_model_run.sh builds them).
//
// What a PASS here means: the plan's steps, assertions, ordering, identity checks, refusals and teardown work as
// designed against a model, and the assertions can fail. It says nothing about the real GoTrue / PostgREST / RLS.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ENV, resolveTarget } from '../preflight/managed_disposable/guard.ts';
import { MODELLED, STEPS } from '../preflight/managed_disposable/plan.ts';
import { type HttpRequest, type HttpResponse, render, run, type Transport } from '../preflight/managed_disposable/runner.ts';
import { APIKEY, ENROLLMENT_RPCS, type Seams, SERVICE_KEY, sql, startSeams } from './common_account_phase9_seams.ts';

const enabled = Deno.env.get('CAL_E2E') === '1';
const HARNESS = Deno.env.get('PGDATABASE') ?? '';
const WRONG_MARKER = Deno.env.get('PGDATABASE_WRONG_MARKER') ?? '';
const TAMPER = Deno.env.get('PGDATABASE_TAMPER') ?? '';
const NOFENCE = Deno.env.get('PGDATABASE_NOFENCE') ?? '';
const REF = Deno.env.get('P11_REF') ?? '';
const PRODUCTION_LIKE = Deno.env.get('P11_PRODUCTION_LIKE') ?? '';
if (enabled && (!HARNESS || !WRONG_MARKER || !TAMPER || !NOFENCE || !REF || !PRODUCTION_LIKE)) throw new Error('the model run needs its worlds (common_account_phase11_model_run.sh)');

const repoRoot = new URL('../../', import.meta.url);
const readRepo = (path: string) => Deno.readTextFileSync(new URL(path, repoRoot));
const lock = enabled ? JSON.parse(readRepo('supabase/preflight/managed_disposable/plan.lock.json')) as { files: Record<string, string> } : { files: {} };

const EXPOSED = [...ENROLLMENT_RPCS, 'begin_service_deletion', 'claim_service_deletion', 'record_owned_service_deletion_provider_result', 'finish_owned_service_deletion'];
const decoder = new TextDecoder();

const environment = (ref = REF, denied = PRODUCTION_LIKE) => ({
  [ENV.projectRef]: ref, [ENV.allowlist]: ref, [ENV.denylist]: denied, [ENV.apiUrl]: `https://${ref}.supabase.co`, [ENV.confirm]: ref,
  [ENV.publishableKey]: APIKEY, [ENV.serviceKey]: SERVICE_KEY,
  [ENV.dbUrl]: `postgresql://postgres:synthetic@db.${ref}.supabase.co:5432/postgres`,
  [ENV.baselineSha256]: 'f'.repeat(64), [ENV.baselinePath]: '/synthetic/baseline.sql', [ENV.emailDomain]: 'accept.example.test',
});

async function psqlChild(database: string, args: string[], options: { stdin?: string; probe?: boolean } = {}) {
  const child = new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args],
    env: {
      PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '', PGDATABASE: database, LC_ALL: 'C',
      ...(options.probe ? { PGOPTIONS: '-c kabumori.disposable_probe=yes' } : {}),
    },
    stdin: options.stdin === undefined ? 'null' : 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn();
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  return child.output();
}

type Counters = { http: number; sql: number; apply: number };
function modelTransport(seams: Seams, database: string, counters: Counters): Transport {
  const keys = { publishable: APIKEY, service: SERVICE_KEY };
  return {
    async http(request: HttpRequest): Promise<HttpResponse> {
      counters.http += 1;
      const url = new URL(`${seams.baseUrl}${request.path}`);
      for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
      const headers: Record<string, string> = {};
      if (request.key !== 'none') {
        headers.apikey = keys[request.key];
        headers.Authorization = `Bearer ${request.bearer ?? keys[request.key]}`;
      }
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(url, { method: request.method, headers, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async sqlRead(query) {
      counters.sql += 1;
      return await sql(query, database);
    },
    async sqlApplyFile(path, bytes) {
      counters.apply += 1;
      // MODEL ONLY: the Phase 3b suite's writer stand-ins (and their auth.sessions) go in right before the guard file,
      // exactly where the preflight runner puts them; a managed project has the real thing
      if (path.includes('20261010051938_common_account_service_write_guard')) {
        const fixture = await psqlChild(database, ['-f', '-'], { stdin: readRepo('supabase/tests/common_account_write_guard_fixture.sql') });
        if (!fixture.success) throw new Error(`stand-in fixture: ${decoder.decode(fixture.stderr).slice(0, 200)}`);
      }
      const out = await psqlChild(database, ['-f', '-'], { stdin: bytes });
      if (!out.success) throw new Error(decoder.decode(out.stderr).split('\n').find((line) => /ERROR/u.test(line)) ?? 'psql failed');
      return decoder.decode(out.stdout).trim();
    },
    async sqlProbe(path) {
      counters.sql += 1;
      const out = await psqlChild(database, ['-f', '-'], { stdin: readRepo(path), probe: true });
      if (!out.success) throw new Error(decoder.decode(out.stderr).slice(0, 300));
      return decoder.decode(out.stdout).trim();
    },
    sqlHoldLock(query, seconds) {
      counters.sql += 1;
      const done = psqlChild(database, ['-c', `begin; ${query}; select pg_sleep(${seconds}); commit;`]);
      return new Promise((resolve) => setTimeout(() => resolve({ release: async () => { await done; } }), 600));
    },
  };
}

const reader = (override: Record<string, (text: string) => string> = {}) => ({
  read: (path: string) => (override[path] ?? ((text: string) => text))(readRepo(path)),
});

test('the model run: the plan applies the ten chain files and passes the probe and every modelled check, then tears down', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: HARNESS, autoconfirm: true, exposed: EXPOSED });
  try {
    const decision = resolveTarget(environment(), { execute: true });
    assert.equal(decision.ok, true, JSON.stringify(decision));
    const counters: Counters = { http: 0, sql: 0, apply: 0 };
    const report = await run(STEPS, { mode: 'execute', decision, transport: modelTransport(seams, HARNESS, counters), lock, reader: reader(), secrets: [APIKEY, SERVICE_KEY], only: MODELLED });
    console.log(`model observed:\n${render(report, [APIKEY, SERVICE_KEY])}`);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    for (const id of MODELLED) {
      const result = byId.get(id);
      assert.ok(result && (result.status === 'PASS' || result.status === 'INFO'), `${id}: ${result?.status} ${result?.detail}`);
    }
    for (const step of STEPS.filter((s) => !s.modelled)) assert.equal(byId.get(step.id)?.status, 'NOT_RUN', `${step.id} is not modelled and must not claim a result`);
    assert.equal(report.summary.fail + report.summary.stop, 0);
    assert.equal(report.stoppedAt, undefined);
    assert.equal(counters.apply, 10, 'exactly the ten chain files were sent');
    assert.equal(await sql(`select to_regprocedure('public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)') is not null`, HARNESS), 't');
    // teardown removed every login the run created
    assert.equal(await sql('select count(*) from auth.users', HARNESS), '0');
    // M7 left an item for the operator: the run is not "complete"
    assert.ok((byId.get('M7')?.manual?.length ?? 0) >= 1);
    assert.equal(report.complete, false);
  } finally {
    await seams.stop();
  }
});

test('a project whose own marker names another project: STOP at the first step, nothing mutated, nothing sent', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: WRONG_MARKER, autoconfirm: true, exposed: EXPOSED });
  try {
    const decision = resolveTarget(environment(), { execute: true });
    assert.equal(decision.ok, true);
    const counters: Counters = { http: 0, sql: 0, apply: 0 };
    const report = await run(STEPS, { mode: 'execute', decision, transport: modelTransport(seams, WRONG_MARKER, counters), lock, reader: reader(), only: MODELLED });
    assert.equal(report.results[0].id, 'G1');
    assert.equal(report.results[0].status, 'STOP');
    assert.equal(report.stoppedAt, 'G1');
    assert.equal(counters.apply, 0);
    assert.equal(await sql(`select to_regclass('public.common_accounts') is null`, WRONG_MARKER), 't', 'no chain file was applied');
    assert.equal(seams.hits.length, 0, 'no request reached the project');
  } finally {
    await seams.stop();
  }
});

test('a chain file whose bytes differ from its pin is never sent; the files before it stay applied, the ones after it are not touched', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: TAMPER, autoconfirm: true, exposed: EXPOSED });
  try {
    const decision = resolveTarget(environment(), { execute: true });
    assert.equal(decision.ok, true);
    const counters: Counters = { http: 0, sql: 0, apply: 0 };
    const tampered = reader({ 'supabase/migrations/20261006230000_common_account_service_start_intent.sql': (text) => `${text}\n-- edited after review\n` });
    const report = await run(STEPS, { mode: 'execute', decision, transport: modelTransport(seams, TAMPER, counters), lock, reader: tampered, only: MODELLED });
    const byId = new Map(report.results.map((r) => [r.id, r]));
    assert.equal(byId.get('G3-P1')?.status, 'PASS');
    assert.equal(byId.get('G3-P2')?.status, 'FAIL');
    assert.match(byId.get('G3-P2')?.detail ?? '', /differs from its pinned digest/u);
    assert.equal(byId.get('G3-P3a')?.status, 'NOT_RUN');
    assert.equal(counters.apply, 1, 'only P1 was sent');
    assert.equal(await sql(`select to_regprocedure('public.reactivate_kabumori_service(bigint)') is null`, TAMPER), 't');
    assert.equal(byId.get('T1')?.status, 'PASS', 'teardown still runs');
  } finally {
    await seams.stop();
  }
});

test('fail-before: in a world without the Phase 9 fence the plan\'s M5 detects that a signed-out token restarts an ended service', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: NOFENCE, autoconfirm: true, exposed: EXPOSED });
  try {
    const decision = resolveTarget(environment(), { execute: true });
    assert.equal(decision.ok, true);
    const report = await run(STEPS, { mode: 'execute', decision, transport: modelTransport(seams, NOFENCE, { http: 0, sql: 0, apply: 0 }), lock, reader: reader(), only: ['G1', 'M5'] });
    const byId = new Map(report.results.map((r) => [r.id, r]));
    assert.equal(byId.get('G1')?.status, 'PASS');
    assert.equal(byId.get('M5')?.status, 'STOP', JSON.stringify(byId.get('M5')));
    assert.match(byId.get('M5')?.detail ?? '', /restarted the ended service/u);
  } finally {
    await seams.stop();
  }
});

test('a dry run, and an execution against a production-named project, send nothing', { skip: !enabled }, async () => {
  const seams = await startSeams({ database: HARNESS, autoconfirm: true, exposed: EXPOSED });
  try {
    const counters: Counters = { http: 0, sql: 0, apply: 0 };
    const transport = modelTransport(seams, HARNESS, counters);
    const decision = resolveTarget(environment(), { execute: true });
    const dry = await run(STEPS, { mode: 'dry-run', decision, transport, lock, reader: reader() });
    assert.equal(dry.results.every((r) => r.status === 'NOT_RUN'), true);
    const production = resolveTarget(environment(PRODUCTION_LIKE, PRODUCTION_LIKE), { execute: true });
    assert.equal(production.ok, false);
    const refused = await run(STEPS, { mode: 'execute', decision: production, transport, lock, reader: reader() });
    assert.ok((refused.refused ?? []).some((r) => r.code === 'TARGET_IS_PRODUCTION'));
    assert.deepEqual(counters, { http: 0, sql: 0, apply: 0 });
    assert.equal(seams.hits.length, 0);
  } finally {
    await seams.stop();
  }
});
