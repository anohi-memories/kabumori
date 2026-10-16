// The operator tool prints counts, codes and digests only, and its exit code is the decision (F5 Phase 12).
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Requirements } from './baseline_requirements.ts';
import { canonicalize, contractSubset, type Line } from './inventory.ts';
import { runInventoryCli } from './inventory_cli.ts';
import { syntheticInventory } from './inventory_fixtures.ts';

const provenance = JSON.parse(Deno.readTextFileSync(new URL('./baseline_provenance.json', import.meta.url))) as {
  requirements: Requirements;
  unknown: { relations: string[]; columns: string[]; foreignKeys: string[]; functions: string[] };
};
const toText = (lines: Line[]) => lines.map((line) => JSON.stringify(line)).join('\n');
const files = (map: Record<string, string>) => (path: string) => {
  if (!(path in map)) throw new Error(`no such file ${path}`);
  return map[path];
};

test('check: a complete manifest is READY_FOR_OWNER_REVIEW (exit 0), prints no manifest line, and compares with an approved digest', async () => {
  const lines = syntheticInventory(provenance.requirements);
  const digest = (await canonicalize(contractSubset(lines, provenance.requirements))).digest;
  const read = files({ m: toText(lines) });
  const ok = await runInventoryCli(['check', 'm'], read, provenance);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, /readiness: READY_FOR_OWNER_REVIEW/u);
  assert.match(ok.output, new RegExp(`contract digest: ${digest}`, 'u'));
  assert.ok(!ok.output.includes('"k"') && !ok.output.includes('public.brands.id'), 'no manifest content is printed');
  const same = await runInventoryCli(['check', 'm', '--approved', digest], read, provenance);
  assert.equal(same.code, 0);
  assert.match(same.output, /approved digest: EQUAL/u);
  const other = await runInventoryCli(['check', 'm', '--approved', '0'.repeat(64)], read, provenance);
  assert.equal(other.code, 1);
  assert.match(other.output, /approved digest: DIFFERENT/u);
});

test('check: an incomplete, secret-bearing or unreadable manifest is a STOP with the reason, never a pass', async () => {
  const missing = syntheticInventory(provenance.requirements, { skip: (line) => line.k === 'relation' && line.key === 'public.brands' });
  const incomplete = await runInventoryCli(['check', 'm'], files({ m: toText(missing) }), provenance);
  assert.equal(incomplete.code, 1);
  assert.match(incomplete.output, /readiness: NOT_READY/u);
  assert.match(incomplete.output, /RELATION_MISSING/u);
  const leaky = await runInventoryCli(['check', 'm'], files({ m: `${toText(syntheticInventory(provenance.requirements))}\n${['postgres', '://u:p@h/db'].join('')}` }), provenance);
  assert.equal(leaky.code, 1);
  assert.match(leaky.output, /secret-shaped text present/u);
  assert.ok(!leaky.output.includes('u:p@h'));
  const garbage = await runInventoryCli(['check', 'm'], files({ m: 'ERROR: permission denied' }), provenance);
  assert.equal(garbage.code, 1);
  assert.match(garbage.output, /STOP unreadable/u);
  assert.equal((await runInventoryCli(['check', 'm', '--approved', 'nope'], files({ m: '' }), provenance)).code, 2);
  assert.equal((await runInventoryCli([], files({}), provenance)).code, 2);
});

test('diff: drift is exit 1 and names objects and attributes; identical inventories are exit 0', async () => {
  const base = syntheticInventory(provenance.requirements);
  const changed = syntheticInventory(provenance.requirements, { tweak: (line) => { if (line.k === 'relation' && line.key === 'public.profiles') line.a.rls = false; } });
  const read = files({ a: toText(base), b: toText(changed), c: toText(base) });
  const drift = await runInventoryCli(['diff', 'a', 'b'], read, provenance);
  assert.equal(drift.code, 1);
  assert.match(drift.output, /~ relation public\.profiles: rls/u);
  assert.match(drift.output, /DRIFT: STOP/u);
  const none = await runInventoryCli(['diff', 'a', 'c'], read, provenance);
  assert.equal(none.code, 0);
  assert.match(none.output, /no drift/u);
});

test('an unreadable or unusual path is never echoed, by check or by diff (J1 V1 R4)', async () => {
  const sentinel = ['sb_secret_', 'PathSentinel0123456789'].join('');
  const throwing = () => { throw new Error(`ENOENT ${sentinel}`); };
  const checked = await runInventoryCli(['check', `/tmp/${sentinel}/m.ndjson`], throwing, provenance);
  const diffed = await runInventoryCli(['diff', `/tmp/${sentinel}/a.ndjson`, `/tmp/${sentinel}/b.ndjson`], throwing, provenance);
  for (const result of [checked, diffed]) {
    assert.equal(result.code, 1);
    assert.ok(!result.output.includes(sentinel), result.output);
    assert.ok(!result.output.includes('/tmp/'), result.output);
  }
  // a clean `check` no longer prints the manifest path at all
  const clean = await runInventoryCli(['check', `/tmp/${sentinel}/m.ndjson`], () => toText(syntheticInventory(provenance.requirements)), provenance);
  assert.equal(clean.code, 0);
  assert.ok(!clean.output.includes(sentinel) && !clean.output.includes('/tmp/'));
});

test('diff stops on a manifest that is outside the closed shape contract, with codes and counts only', async () => {
  const odd = syntheticInventory(provenance.requirements);
  odd.push({ k: 'relation', key: 'public.extra_table', a: { relkind: 'r', row_sample: 'leak' } } as unknown as Line);
  const read = files({ a: toText(syntheticInventory(provenance.requirements)), b: toText(odd) });
  const result = await runInventoryCli(['diff', 'a', 'b'], read, provenance);
  assert.equal(result.code, 1);
  assert.match(result.output, /STOP the observed manifest violates the inventory contract \(.*UNEXPECTED_ATTRIBUTE=1/u);
  assert.ok(!result.output.includes('extra_table') && !result.output.includes('row_sample'));
});
