// Runner of the managed-disposable harness, over a recording transport: a dry run touches nothing; execution is refused
// without a resolved target; the project's identity is re-read before EVERY mutating call; files are sent only when
// pinned, unchanged and clean; the first FAIL / STOP ends the run (teardown still runs); nothing leaks.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ENV, resolveTarget } from './guard.ts';
import { sha256Hex } from './lock.ts';
import { type HttpRequest, type HttpResponse, render, run, type Step, type Transport } from './runner.ts';

const REF = 'aaaaaaaaaaaaaaaaaaaa';
const PRODUCTION_REF = 'cccccccccccccccccccc';
const SECRET = 'sb_secret_synthetic_key_value_1234';

const env = {
  [ENV.projectRef]: REF, [ENV.allowlist]: REF, [ENV.denylist]: PRODUCTION_REF, [ENV.apiUrl]: `https://${REF}.supabase.co`, [ENV.confirm]: REF,
  [ENV.publishableKey]: 'sb_publishable_synthetic_key_value', [ENV.serviceKey]: SECRET,
  [ENV.dbUrl]: `postgres://postgres:synthetic@db.${REF}.supabase.co:5432/postgres`, [ENV.baselineSha256]: 'f'.repeat(64),
  [ENV.baselinePath]: '/tmp/b.sql', [ENV.emailDomain]: 'accept.example.test',
};
const decision = resolveTarget(env, { execute: true });
assert.equal(decision.ok, true);

type Call = { kind: 'identity' | 'read' | 'http' | 'apply' | 'probe' | 'hold'; detail: string };
function recording(options: { marker?: () => string } = {}) {
  const calls: Call[] = [];
  const transport: Transport = {
    http: (request: HttpRequest): Promise<HttpResponse> => { calls.push({ kind: 'http', detail: `${request.method} ${request.path}` }); return Promise.resolve({ status: 200, body: {} }); },
    sqlRead: (query) => {
      if (query.includes('kabumori_disposable_marker')) { calls.push({ kind: 'identity', detail: '' }); return Promise.resolve(options.marker?.() ?? REF); }
      calls.push({ kind: 'read', detail: query.slice(0, 40) });
      return Promise.resolve('');
    },
    sqlApplyFile: (path, bytes) => { calls.push({ kind: 'apply', detail: `${path} ${bytes.length}` }); return Promise.resolve(''); },
    sqlProbe: (path) => { calls.push({ kind: 'probe', detail: path }); return Promise.resolve('RELEASE_PREFLIGHT|PASS|fail=0 warn=0 stop=0'); },
    sqlHoldLock: () => { calls.push({ kind: 'hold', detail: '' }); return Promise.resolve({ release: () => Promise.resolve() }); },
  };
  return { calls, transport };
}
const reader = { read: (path: string) => (path === 'ok.sql' ? 'select 1;' : path === 'evil.sql' ? `select cron.schedule('j','* * * * *','select 1'); -- ${PRODUCTION_REF}.supabase.co\nselect 'https://${PRODUCTION_REF}.supabase.co';` : '') };
const step = (id: string, access: 'read' | 'mutate', body: Step['run'], extra: Partial<Step> = {}): Step => ({
  id, title: id, access, mode: 'automated', modelled: false, expected: 'x', stop: 'y', run: body, ...extra,
});
const ok = () => Promise.resolve({ status: 'PASS' as const, detail: 'fine' });

test('a dry run touches no transport at all and reports nothing as passed', async () => {
  const { calls, transport } = recording();
  const report = await run([step('A', 'read', ok), step('B', 'mutate', ok)], { mode: 'dry-run', decision, transport, lock: { files: {} }, reader });
  assert.deepEqual(calls, []);
  assert.deepEqual(report.results.map((r) => r.status), ['NOT_RUN', 'NOT_RUN']);
  assert.equal(report.complete, false);
});

test('execute is refused, with every reason, when the target did not resolve; nothing is called', async () => {
  const { calls, transport } = recording();
  const refused = resolveTarget({}, { execute: true });
  const report = await run([step('A', 'mutate', ok)], { mode: 'execute', decision: refused, transport, lock: { files: {} }, reader });
  assert.deepEqual(calls, []);
  assert.ok((report.refused?.length ?? 0) > 3);
  assert.equal(report.complete, false);
  assert.equal(report.results.length, 0);
});

test('the identity is re-read before every mutating call, and a changed marker stops the next one', async () => {
  let reads = 0;
  const { calls, transport } = recording({ marker: () => (++reads <= 3 ? REF : PRODUCTION_REF) });
  const mutating = step('M', 'mutate', async (ctx) => {
    for (let i = 0; i < 4; i++) await ctx.http({ method: 'POST', path: `/x/${i}`, key: 'publishable' });
    return { status: 'PASS', detail: 'sent four' };
  });
  const report = await run([mutating], { mode: 'execute', decision, transport, lock: { files: {} }, reader });
  const sent = calls.filter((c) => c.kind === 'http').map((c) => c.detail);
  assert.deepEqual(sent, ['POST /x/0', 'POST /x/1'], 'the third and fourth requests were never sent');
  // each sent request is immediately preceded by an identity read
  calls.forEach((call, index) => { if (call.kind === 'http') assert.equal(calls[index - 1].kind, 'identity'); });
  assert.equal(report.results[0].status, 'STOP');
  assert.equal(report.stoppedAt, 'M');
});

test('a read-only step may not mutate; a GET is fine', async () => {
  const { calls, transport } = recording();
  const reading = step('R', 'read', async (ctx) => {
    await ctx.http({ method: 'GET', path: '/auth/v1/settings', key: 'publishable' });
    await ctx.http({ method: 'POST', path: '/auth/v1/signup', key: 'publishable' });
    return { status: 'PASS', detail: 'x' };
  });
  const report = await run([reading], { mode: 'execute', decision, transport, lock: { files: {} }, reader });
  assert.deepEqual(calls.filter((c) => c.kind === 'http').map((c) => c.detail), ['GET /auth/v1/settings']);
  assert.equal(report.results[0].status, 'FAIL');
  assert.match(report.results[0].detail, /read-only/u);
});

test('a file is sent only when pinned, unchanged and clean', async () => {
  const digest = await sha256Hex('select 1;');
  const apply = (path: string) => step(`F:${path}`, 'mutate', async (ctx) => {
    await ctx.applyFile({ id: path, path, kind: 'chain' });
    return { status: 'PASS', detail: 'applied' };
  });
  const cases: [string, Record<string, string>, string, RegExp | null][] = [
    ['ok.sql', { 'ok.sql': digest }, 'PASS', null],
    ['ok.sql', {}, 'FAIL', /not pinned/u],
    ['ok.sql', { 'ok.sql': 'e'.repeat(64) }, 'FAIL', /differs from its pinned digest/u],
    ['evil.sql', { 'evil.sql': await sha256Hex(reader.read('evil.sql')) }, 'FAIL', /FOREIGN_PROJECT_HOST,CRON_SCHEDULE|CRON_SCHEDULE/u],
  ];
  for (const [path, files, status, pattern] of cases) {
    const { calls, transport } = recording();
    const report = await run([apply(path)], { mode: 'execute', decision, transport, lock: { files }, reader });
    assert.equal(report.results[0].status, status, `${path}: ${report.results[0].detail}`);
    if (pattern) assert.match(report.results[0].detail, pattern);
    const applied = calls.filter((c) => c.kind === 'apply');
    assert.equal(applied.length, status === 'PASS' ? 1 : 0, `${path} applied ${applied.length} time(s)`);
    if (status === 'PASS') assert.equal(calls[calls.findIndex((c) => c.kind === 'apply') - 1].kind, 'identity');
  }
});

test('the first FAIL ends the run; a teardown step still runs; the run is never "complete"', async () => {
  const { calls, transport } = recording();
  const steps = [
    step('S1', 'read', ok),
    step('S2', 'mutate', () => Promise.resolve({ status: 'FAIL' as const, detail: 'broke' })),
    step('S3', 'mutate', async (ctx) => { await ctx.http({ method: 'POST', path: '/never', key: 'publishable' }); return { status: 'PASS' as const, detail: '' }; }),
    step('T', 'mutate', async (ctx) => { await ctx.http({ method: 'DELETE', path: '/cleanup', key: 'service' }); return { status: 'PASS' as const, detail: 'cleaned' }; }, { always: true }),
  ];
  const report = await run(steps, { mode: 'execute', decision, transport, lock: { files: {} }, reader });
  assert.deepEqual(report.results.map((r) => r.status), ['PASS', 'FAIL', 'NOT_RUN', 'PASS']);
  assert.equal(report.stoppedAt, 'S2');
  assert.deepEqual(calls.filter((c) => c.kind === 'http').map((c) => c.detail), ['DELETE /cleanup']);
  assert.equal(report.complete, false);
});

test('complete only when every step passed and no manual item is open', async () => {
  const { transport } = recording();
  const all = await run([step('A', 'read', ok), step('B', 'read', ok)], { mode: 'execute', decision, transport, lock: { files: {} }, reader });
  assert.equal(all.complete, true);
  const withManual = await run([step('A', 'read', ok), step('B', 'read', () => Promise.resolve({ status: 'PASS' as const, detail: 'x', manual: ['expired token by hand'] }))], { mode: 'execute', decision, transport, lock: { files: {} }, reader });
  assert.equal(withManual.complete, false);
  const manualStatus = await run([step('A', 'read', () => Promise.resolve({ status: 'MANUAL' as const, detail: 'operator' }))], { mode: 'execute', decision, transport, lock: { files: {} }, reader });
  assert.equal(manualStatus.complete, false);
  assert.equal(manualStatus.summary.manual, 1);
});

test('an error that carries a secret is redacted in the result and in the rendered report', async () => {
  const { transport } = recording();
  const leaky = step('L', 'read', () => Promise.reject(new Error(`boom with ${SECRET} and postgres://postgres:synthetic@db.${REF}.supabase.co:5432/postgres`)));
  const report = await run([leaky], { mode: 'execute', decision, transport, lock: { files: {} }, reader, secrets: [SECRET] });
  const text = render(report, [SECRET]);
  assert.ok(!text.includes(SECRET) && !text.includes('synthetic@'), text);
  assert.match(report.results[0].detail, /\[REDACTED\]|postgres:\/\/\[REDACTED\]/u);
});
