// E1-E12 coverage (Phase 3c offline readiness): the catalog is PR121 section 8 verbatim, no experiment is missing
// or silently dropped, and the runbook covers every one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPERIMENT_IDS, EXPERIMENTS, PR121_ROWS_SHA256, REQUIRED_FOR } from './catalog.ts';

const here = new URL('./', import.meta.url);
const repo = new URL('../../../', import.meta.url);

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

test('the pinned PR121 rows are byte-identical to the recorded hash', async () => {
  const bytes = await Deno.readFile(new URL('pr121_e1_e12_rows.md', here));
  assert.equal(await sha256(bytes), PR121_ROWS_SHA256);
});

test('what / pass are the PR121 table cells verbatim, in order, all twelve', async () => {
  const rows = (await Deno.readTextFile(new URL('pr121_e1_e12_rows.md', here))).trimEnd().split('\n');
  assert.equal(rows.length, 12);
  const cells = rows.map((row) => row.replace(/^\| /u, '').replace(/ \|$/u, '').split(' | '));
  assert.deepEqual(cells.map((c) => c[0]), [...EXPERIMENT_IDS]);
  assert.deepEqual(EXPERIMENTS.map((e) => e.id), [...EXPERIMENT_IDS]);
  for (const [i, e] of EXPERIMENTS.entries()) {
    assert.equal(cells[i].length, 3, `${e.id}: three cells`);
    assert.equal(e.what, cells[i][1], `${e.id}: what`);
    assert.equal(e.pass, cells[i][2], `${e.id}: pass condition`);
  }
});

test('classification: only E1 is a pure observation; every destructive one says what it destroys', () => {
  for (const e of EXPERIMENTS) {
    assert.equal(e.kind, e.id === 'E1' ? 'observation' : 'destructive', e.id);
    assert.equal(e.destructiveOperations.length > 0, e.kind === 'destructive', `${e.id}: operations listed`);
    assert.ok(e.observables.length > 0, `${e.id}: observables`);
    assert.ok(e.unknownWhen.length > 0, `${e.id}: unknown conditions`);
    assert.ok(e.inputs.length > 0, `${e.id}: inputs`);
  }
  assert.deepEqual(EXPERIMENTS.find((e) => e.id === 'E11')!.extraApprovals, ['option_d_security_approval']);
  assert.deepEqual(EXPERIMENTS.find((e) => e.id === 'E7')!.extraApprovals, ['project_auth_config_change']);
  assert.equal(EXPERIMENTS.filter((e) => e.extraApprovals.length > 0).length, 2);
  assert.equal(EXPERIMENTS.find((e) => e.id === 'E6')!.forcing, 'statistical_only', 'E6 cannot be forced: its absence of a race is never a PASS by itself');
  assert.equal(EXPERIMENTS.find((e) => e.id === 'E4')!.forcing, 'operator_paced_barrier');
});

test('both candidates need the shared base; each needs its own decisive experiment', () => {
  for (const candidate of ['A+B', 'D'] as const) {
    for (const id of ['E1', 'E8', 'E9', 'E10', 'E12'] as const) assert.ok(REQUIRED_FOR[candidate].includes(id), `${candidate} needs ${id}`);
  }
  assert.ok(REQUIRED_FOR['A+B'].includes('E4') && !REQUIRED_FOR['A+B'].includes('E11'));
  assert.ok(REQUIRED_FOR.D.includes('E11') && !REQUIRED_FOR.D.includes('E4'));
  const covered = new Set([...REQUIRED_FOR['A+B'], ...REQUIRED_FOR.D]);
  assert.deepEqual([...EXPERIMENT_IDS].filter((id) => !covered.has(id)), [], 'every experiment informs a candidate');
});

test('the runbook has a section for every experiment and pins PR121 exactly', async () => {
  const runbook = await Deno.readTextFile(new URL('docs/common-account/phase3c-disposable-supabase-proof-runbook.md', repo));
  for (const id of EXPERIMENT_IDS) assert.match(runbook, new RegExp(`^### ${id} `, 'mu'), `runbook section ${id}`);
  assert.ok(runbook.includes(PR121_ROWS_SHA256));
  assert.ok(runbook.includes('76b50e1e03f82faaa3460bab1603afa8fef3ce44'));
  assert.ok(runbook.includes('OFFLINE_READY_NOT_EXECUTED'));
});
