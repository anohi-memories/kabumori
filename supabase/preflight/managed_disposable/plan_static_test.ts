// Static contract of the managed-disposable harness: the lock matches the bytes on disk, the chain is the Phase 7
// release order, the files it may send are clean, the pure modules stay pure, no production project is named here, and
// the default is a dry run. Pure file reads; no database, no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn, scanSqlForForeignTargets } from './guard.ts';
import { buildLock } from './lock.ts';
import type { Lock } from './runner.ts';
import { BASELINE, CHAIN, classifyLinking, INVENTORY_PATH, MODELLED, PROBE_PATH, STEPS } from './plan.ts';

const root = new URL('../../../', import.meta.url);
const here = new URL('./', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const readHere = (name: string) => Deno.readTextFileSync(new URL(name, here));
const SYNTHETIC = 'aaaaaaaaaaaaaaaaaaaa';

test('the lock pins exactly the bytes of the chain, the probe and the inventory query on disk', async () => {
  const lock = JSON.parse(readHere('plan.lock.json')) as Lock;
  const expectedPaths = [...CHAIN.map((file) => file.path), PROBE_PATH].sort();
  assert.deepEqual(Object.keys(lock.files).sort(), [...expectedPaths, INVENTORY_PATH].sort());
  const corpus: Record<string, string> = {};
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) {
    if (entry.isFile && entry.name.endsWith('.sql')) corpus[entry.name] = read(`supabase/migrations/${entry.name}`);
  }
  const fresh = await buildLock(expectedPaths, read, corpus, [INVENTORY_PATH]);
  assert.deepEqual(lock, fresh, 'a changed migration or probe needs a deliberate `cli.ts --write-lock` and a reviewed diff');
  assert.ok(!(BASELINE.path in lock.files), 'the baseline is operator-supplied: its digest comes from the environment, never from the repository');
});

test('the chain is the Phase 7 release order, and every file is clean to send', () => {
  const runner = read('supabase/tests/common_account_release_preflight_run.sh');
  const listed = [...runner.slice(runner.indexOf('CHAIN_FILES=('), runner.indexOf('CHAIN_NAMES=')).matchAll(/^\s+(\d{14}_[a-z0-9_]+\.sql)$/gmu)].map((m) => `supabase/migrations/${m[1]}`);
  assert.deepEqual(CHAIN.map((file) => file.path), listed);
  assert.equal(new Set(CHAIN.map((file) => file.id)).size, CHAIN.length);
  for (const file of CHAIN) {
    assert.deepEqual(scanSqlForForeignTargets(read(file.path), SYNTHETIC), [], `${file.path} must not name another project, schedule cron or call out over HTTP`);
  }
  assert.deepEqual(scanSqlForForeignTargets(read(PROBE_PATH), SYNTHETIC), []);
});

test('the repository migrations that name a production host or schedule cron are exactly the ones the guard would refuse', () => {
  const migrations = [...Deno.readDirSync(new URL('supabase/migrations/', root))].filter((entry) => entry.isFile && entry.name.endsWith('.sql')).map((entry) => entry.name).sort();
  const refused = migrations.filter((name) => scanSqlForForeignTargets(read(`supabase/migrations/${name}`), SYNTHETIC).length > 0);
  // none of the chain; the cron migrations of other products are refused (they would arm jobs that call production)
  assert.ok(refused.length >= 1, 'the baseline hazard this phase documents');
  for (const file of CHAIN) assert.ok(!refused.includes(file.path.split('/').pop() as string));
});

test('the plan: every gate and check M1-M12 exists once, in a sane order, with a teardown that always runs', () => {
  const ids = STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
  for (let i = 1; i <= 12; i++) assert.ok(ids.includes(`M${i}`), `M${i}`);
  for (const id of ['G1', 'G2', 'G3a', 'G3b', 'G3c', 'G4', 'T1']) assert.ok(ids.includes(id), id);
  assert.ok(ids.indexOf('G3-P10') < ids.indexOf('G3c') && ids.indexOf('G3c') < ids.indexOf('G4'), 'the silence is read back after the last chain file');
  assert.ok(ids.indexOf('G3a') < ids.indexOf('G3b') && ids.indexOf('G3b') < ids.indexOf('G3-P1'), 'the baseline is read back before the first chain file is sent');
  assert.ok(ids.indexOf('G1') < ids.indexOf('G3a') && ids.indexOf('G3a') < ids.indexOf('G3-P1') && ids.indexOf('G3-P10') < ids.indexOf('G4') && ids.indexOf('G4') < ids.indexOf('M1'));
  assert.equal(ids[ids.length - 1], 'T1');
  assert.equal(STEPS.find((step) => step.id === 'T1')?.always, true);
  assert.deepEqual(CHAIN.map((file) => `G3-${file.id}`), ids.filter((id) => id.startsWith('G3-')), 'the chain steps are in release order');
  for (const step of STEPS) {
    assert.ok(step.expected.length > 10 && step.stop.length > 10, `${step.id} states what it expects and when it STOPs`);
    if (step.access === 'read') assert.ok(!/applyFile/u.test(step.run.toString()), `${step.id}: a read step does not apply files`);
  }
  assert.equal(STEPS.find((step) => step.id === 'M3')?.mode, 'manual');
  assert.ok(MODELLED.includes('M4') && !MODELLED.includes('M12') && !MODELLED.includes('M3'));
});

test('linking observations are classified', () => {
  assert.equal(classifyLinking([]), 'none');
  assert.equal(classifyLinking([{ userId: 'u1', provider: 'email' }]), 'single_identity');
  assert.equal(classifyLinking([{ userId: 'u1', provider: 'email' }, { userId: 'u1', provider: 'apple' }]), 'linked_same_user');
  assert.equal(classifyLinking([{ userId: 'u1', provider: 'email' }, { userId: 'u2', provider: 'apple' }]), 'separate_users');
});

test('the pure modules stay pure; only the transports and the CLI touch the process, the network or a file', () => {
  for (const name of ['guard.ts', 'runner.ts', 'plan.ts', 'lock.ts']) {
    const code = readHere(name).split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
    assert.ok(!/\bDeno\./u.test(code), `${name} must not use Deno APIs`);
    assert.ok(!/\bfetch\s*\(/u.test(code), `${name} must not call fetch`);
    assert.ok(!/process\.env|Deno\.env/u.test(code), `${name} must not read the environment`);
  }
  const cli = readHere('cli.ts');
  assert.match(cli, /const execute = args\.has\('--execute'\);/u, 'the default is a dry run');
  assert.match(cli, /mode: 'dry-run'/u);
  assert.ok(!/KABUMORI_DISPOSABLE_[A-Z_]+\s*=\s*['"]/u.test(cli), 'no value is baked into the CLI');
});

test('no project named by the repository appears in the harness, and no key or password is in it', () => {
  const repositoryRefs = new Set<string>();
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) {
    if (entry.isFile && entry.name.endsWith('.sql')) for (const ref of projectRefsIn(read(`supabase/migrations/${entry.name}`))) repositoryRefs.add(ref);
  }
  assert.ok(repositoryRefs.size >= 1);
  for (const entry of Deno.readDirSync(here)) {
    if (!entry.isFile) continue;
    const text = readHere(entry.name);
    for (const ref of repositoryRefs) assert.ok(!text.includes(ref), `${entry.name} names a production project`);
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./u.test(text), `${entry.name} contains a JWT`);
    assert.ok(!/sb_(secret|publishable)_[A-Za-z0-9]{16,}/u.test(text.replace(/sb_(secret|publishable)_synthetic_key_value[_0-9]*/gu, '')), `${entry.name} contains a key`);
    assert.ok(!/postgres(ql)?:\/\/[^\s:'"]+:(?!synthetic|x@|pw@)[^@\s'"]+@/u.test(text), `${entry.name} contains a database URL with a password`);
  }
});
