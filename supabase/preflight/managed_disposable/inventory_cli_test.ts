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
