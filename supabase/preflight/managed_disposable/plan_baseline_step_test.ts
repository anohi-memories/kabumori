// The plan's baseline read-back step G3b (F5 Phase 12) through the real runner and a recording transport: no database.
// The inventory text is synthetic (inventory_fixtures.ts). What it pins: the chain is never sent unless the project's own
// inventory provides what the chain requires AND its contract digest equals the one the owner approved; the inventory
// query is only sent when its bytes are the pinned bytes; and the run needs the approval to even start.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Requirements } from './baseline_requirements.ts';
import { ENV, resolveTarget } from './guard.ts';
import { canonicalize, contractSubset, type Line } from './inventory.ts';
import { syntheticInventory } from './inventory_fixtures.ts';
import { sha256Hex } from './lock.ts';
import { INVENTORY_PATH, STEPS } from './plan.ts';
import { run, type Transport } from './runner.ts';

const REF = 'aaaaaaaaaaaaaaaaaaaa';
const requirements = (JSON.parse(Deno.readTextFileSync(new URL('./baseline_provenance.json', import.meta.url))) as { requirements: Requirements }).requirements;
const env = {
  [ENV.projectRef]: REF, [ENV.allowlist]: REF, [ENV.denylist]: 'cccccccccccccccccccc', [ENV.apiUrl]: `https://${REF}.supabase.co`, [ENV.confirm]: REF,
  [ENV.publishableKey]: 'sb_publishable_synthetic_key_value', [ENV.serviceKey]: 'sb_secret_synthetic_key_value_1234',
  [ENV.dbUrl]: `postgres://postgres:synthetic@db.${REF}.supabase.co:5432/postgres`, [ENV.baselineSha256]: 'f'.repeat(64),
  [ENV.baselinePath]: '/tmp/b.sql', [ENV.inventorySha256]: 'e'.repeat(64), [ENV.emailDomain]: 'accept.example.test',
};
const decision = resolveTarget(env, { execute: true });
assert.equal(decision.ok, true);

const textOf = (lines: Line[]) => lines.map((line) => JSON.stringify(line)).join('\n');
const QUERY_BYTES = 'select 1; -- the pinned inventory query';
const reader = { read: (path: string) => (path === INVENTORY_PATH ? QUERY_BYTES : '') };

function recording(inventory: string) {
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
const approvedFor = async (lines: Line[]) => (await canonicalize(contractSubset(lines, requirements))).digest;
const lockWith = async (over: Record<string, unknown> = {}) => ({
  files: { [INVENTORY_PATH]: await sha256Hex(QUERY_BYTES) }, requirements, ...over,
}) as Parameters<typeof run>[1]['lock'];
const g3b = STEPS.filter((s) => s.id === 'G3b');

test('G3b passes only on the approved contract, and says what it compared', async () => {
  const lines = syntheticInventory(requirements);
  const { calls, transport } = recording(textOf(lines));
  const report = await run(g3b, { mode: 'execute', decision, transport, lock: await lockWith({ approvedInventory: await approvedFor(lines) }), reader });
  assert.equal(report.results[0].status, 'PASS', report.results[0].detail);
  assert.match(report.results[0].detail, /equals the approved digest/u);
  assert.equal(calls[0], `probe ${INVENTORY_PATH}`);
  assert.ok(calls.slice(1).every((call) => call === 'read'), 'after the probe only read-only SQL is sent (the cron / network footprint)');
});

test('G3b STOPs without an approval, with a different contract, without requirements, or on an unreadable inventory', async () => {
  const lines = syntheticInventory(requirements);
  const approved = await approvedFor(lines);
  const drifted = syntheticInventory(requirements, { tweak: (line) => { if (line.k === 'column' && line.key === 'public.brands.id') line.a.notnull = true; } });
  const missing = syntheticInventory(requirements, { skip: (line) => line.k === 'relation' && line.key === 'public.social_accounts' });
  const cases: [string, string, Record<string, unknown>, RegExp][] = [
    ['no approval', textOf(lines), {}, /no approved baseline-contract digest/u],
    ['another contract', textOf(drifted), { approvedInventory: approved }, /differs from the approved one/u],
    ['a required object missing', textOf(missing), { approvedInventory: approved }, /RELATION_MISSING/u],
    ['no requirements in the lock', textOf(lines), { approvedInventory: approved, requirements: undefined }, /carries no baseline requirements/u],
    ['not an inventory', 'ERROR: permission denied', { approvedInventory: approved }, /unreadable/u],
  ];
  for (const [name, inventory, over, pattern] of cases) {
    const { transport } = recording(inventory);
    const report = await run(g3b, { mode: 'execute', decision, transport, lock: await lockWith(over), reader });
    assert.equal(report.results[0].status, 'STOP', name);
    assert.match(report.results[0].detail, pattern, name);
  }
});

test('a failing G3b stops the run before any chain file: nothing is applied', async () => {
  const lines = syntheticInventory(requirements);
  const { calls, transport } = recording(textOf(lines));
  const report = await run(STEPS, {
    mode: 'execute', decision, transport, lock: await lockWith({ approvedInventory: '0'.repeat(64) }), reader, only: ['G1', 'G3b', 'G3-P1', 'G4'],
  });
  const byId = new Map(report.results.map((r) => [r.id, r]));
  assert.equal(byId.get('G1')?.status, 'PASS');
  assert.equal(byId.get('G3b')?.status, 'STOP');
  assert.equal(byId.get('G3-P1')?.status, 'NOT_RUN');
  assert.equal(byId.get('G4')?.status, 'NOT_RUN');
  assert.equal(report.stoppedAt, 'G3b');
  assert.equal(calls.some((c) => c.startsWith('apply')), false, 'no chain file was sent');
});

test('the inventory query is sent only when its bytes are the pinned bytes', async () => {
  const lines = syntheticInventory(requirements);
  const approved = await approvedFor(lines);
  for (const [name, lock] of [
    ['not pinned', { files: {}, requirements, approvedInventory: approved }],
    ['another digest', { files: { [INVENTORY_PATH]: '0'.repeat(64) }, requirements, approvedInventory: approved }],
  ] as const) {
    const { calls, transport } = recording(textOf(lines));
    const report = await run(g3b, { mode: 'execute', decision, transport, lock: lock as Parameters<typeof run>[1]['lock'], reader });
    assert.equal(report.results[0].status, 'FAIL', name);
    assert.match(report.results[0].detail, name === 'not pinned' ? /is not pinned in the plan lock/u : /differs from its pinned digest/u, name);
    assert.deepEqual(calls, [], 'the query was never sent');
  }
});

test('G3b is read-only, declared modelled, and sits between the baseline and the first chain file', () => {
  const step = STEPS.find((s) => s.id === 'G3b');
  assert.equal(step?.access, 'read');
  assert.equal(step?.modelled, true);
  const ids = STEPS.map((s) => s.id);
  assert.ok(ids.indexOf('G3a') < ids.indexOf('G3b') && ids.indexOf('G3b') < ids.indexOf('G3-P1'));
});

test('G3c compares the cron / network footprint with what G3b recorded: equal passes, any change STOPs, no record STOPs', async () => {
  const lines = syntheticInventory(requirements);
  const approved = await approvedFor(lines);
  const make = (jobsAfter: string, triggersAfter: string) => {
    let jobReads = 0;
    let triggerReads = 0;
    const calls: string[] = [];
    const transport: Transport = {
      http: () => Promise.resolve({ status: 200, body: {} }),
      sqlRead: (query) => {
        calls.push(query.slice(0, 50));
        if (query.includes('kabumori_disposable_marker')) return Promise.resolve(REF);
        if (query.includes("to_regclass('cron.job')")) return Promise.resolve('t');
        if (query.includes('from cron.job')) return Promise.resolve(++jobReads === 1 ? '2' : jobsAfter);
        if (query.includes('from pg_trigger')) return Promise.resolve(++triggerReads === 1 ? '1' : triggersAfter);
        return Promise.resolve('');
      },
      sqlApplyFile: () => Promise.resolve(''),
      sqlProbe: () => Promise.resolve(textOf(lines)),
      sqlHoldLock: () => Promise.resolve({ release: () => Promise.resolve() }),
    };
    return { transport, calls };
  };
  const steps = STEPS.filter((s) => s.id === 'G3b' || s.id === 'G3c');
  const options = async () => ({ mode: 'execute' as const, decision, lock: await lockWith({ approvedInventory: approved }), reader });
  const same = await run(steps, { ...(await options()), transport: make('2', '1').transport });
  assert.deepEqual(same.results.map((r) => r.status), ['PASS', 'PASS']);
  assert.match(same.results[0].detail, /cron_jobs=2 network_triggers=1/u);
  const moreJobs = await run(steps, { ...(await options()), transport: make('3', '1').transport });
  assert.equal(moreJobs.results[1].status, 'STOP');
  assert.match(moreJobs.results[1].detail, /before cron_jobs=2 network_triggers=1, after cron_jobs=3 network_triggers=1/u);
  const moreTriggers = await run(steps, { ...(await options()), transport: make('2', '2').transport });
  assert.equal(moreTriggers.results[1].status, 'STOP');
  const fewer = await run(steps, { ...(await options()), transport: make('1', '1').transport });
  assert.equal(fewer.results[1].status, 'STOP', 'a removed job is also a change the plan did not expect');
  const alone = await run(STEPS.filter((s) => s.id === 'G3c'), { ...(await options()), transport: make('2', '1').transport });
  assert.equal(alone.results[0].status, 'STOP');
  assert.match(alone.results[0].detail, /nothing to compare with/u);
});
