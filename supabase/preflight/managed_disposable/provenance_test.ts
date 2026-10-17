import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRequirements } from './baseline_requirements.ts';
import { classify, compareColumns, functionProvenance, type Provenance, relationProvenance } from './provenance.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));

test('relations are classified by what the migrations do to them, never by a fixture', () => {
  const migrations = {
    '20260101000000_a.sql': 'create table public.made (id int);\n-- create table public.hidden (id int);\n/* create table public.hidden2 (id int); */',
    '20260102000000_b.sql': 'alter table public.made add column x int;\nalter table only public.grown add column y int;\ncreate table if not exists public.guarded (id int);',
  };
  assert.deepEqual(relationProvenance('public.made', migrations), { name: 'public.made', class: 'repository_created', createdBy: ['20260101000000'], alteredBy: ['20260102000000'] }.class === 'repository_created' ? relationProvenance('public.made', migrations) : null);
  assert.equal(relationProvenance('public.made', migrations).class, 'repository_created');
  assert.deepEqual(relationProvenance('public.made', migrations).alteredBy, ['20260102000000']);
  assert.equal(relationProvenance('public.guarded', migrations).class, 'repository_created');
  assert.equal(relationProvenance('public.grown', migrations).class, 'repository_altered_only');
  assert.equal(relationProvenance('public.hidden', migrations).class, 'absent_from_repository', 'a commented-out CREATE creates nothing');
  assert.equal(relationProvenance('public.hidden2', migrations).class, 'absent_from_repository');
  assert.equal(relationProvenance('auth.users', migrations).class, 'platform_managed');
  assert.equal(relationProvenance('storage.objects', {}).class, 'platform_managed');
  assert.equal(functionProvenance('public.f(uuid)', { 'x.sql': 'create or replace function public.f(p uuid) returns int language sql as $$ select 1 $$;' }).class, 'repository_created');
  assert.equal(functionProvenance('public.g(uuid)', {}).class, 'absent_from_repository');
});

test('columns: a fixture-only column is UNKNOWN, a relation the replay could not build is "blocked", nothing is promoted', () => {
  const requirements = {
    schemas: [], roles: [], functions: [], foreignKeys: [], relations: ['public.a', 'public.b', 'public.c', 'auth.users'],
    columns: [
      { relation: 'public.a', column: 'id', type: 'text' }, { relation: 'public.b', column: 'x', type: 'integer' },
      { relation: 'public.c', column: 'y', type: 'uuid' }, { relation: 'auth.users', column: 'id', type: 'uuid' },
    ],
  };
  const fixture = { relations: ['public.a', 'public.b', 'public.c', 'auth.users'], foreignKeys: [], functions: [], columns: [
    { relation: 'public.a', column: 'id', type: 'text' }, { relation: 'public.b', column: 'x', type: 'integer' }, { relation: 'public.c', column: 'y', type: 'uuid' }, { relation: 'auth.users', column: 'id', type: 'uuid' },
  ] };
  const replay = { relations: ['public.c', 'auth.users'], foreignKeys: [], functions: [], columns: [{ relation: 'public.c', column: 'y', type: 'text' }, { relation: 'auth.users', column: 'id', type: 'uuid' }] };
  const sources = Object.fromEntries(compareColumns(requirements, fixture, replay, new Set(['public.b', 'public.c'])).map((c) => [`${c.relation}.${c.column}`, c]));
  assert.equal(sources['public.a.id'].source, 'fixture_only');
  assert.equal(sources['public.b.x'].source, 'blocked_replay');
  assert.equal(sources['public.c.y'].source, 'fixture_only', 'a type that differs between fixture and replay is not "from migrations"');
  assert.equal(sources['public.c.y'].typeDiffers, true);
  assert.equal(sources['auth.users.id'].source, 'platform_assumed');
});

test('the committed provenance report is current: requirements, classes and the migration list match the repository', () => {
  const committed = JSON.parse(read('supabase/preflight/managed_disposable/baseline_provenance.json')) as Provenance;
  const migrations: Record<string, string> = {};
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) {
    if (entry.isFile && entry.name.endsWith('.sql')) migrations[entry.name] = read(`supabase/migrations/${entry.name}`);
  }
  const requirements = buildRequirements(read);
  assert.deepEqual(committed.requirements, requirements, 'regenerate: common_account_phase12_baseline_report_run.sh --write');
  const fresh = classify(requirements, migrations);
  assert.deepEqual(committed.relations.map((r) => ({ name: r.name, class: r.class, createdBy: r.createdBy, alteredBy: r.alteredBy })), fresh.relations);
  assert.deepEqual(committed.functions.map((f) => ({ signature: f.signature, class: f.class, createdBy: f.createdBy })), fresh.functions);
  assert.deepEqual(committed.replay.map((r) => r.file), Object.keys(migrations).sort(), 'a migration was added or removed since the report was generated');
  // the unknown baseline is exactly what the classification says, and it is not empty
  assert.deepEqual(committed.unknown.relations, fresh.relations.filter((r) => r.class === 'absent_from_repository' || r.class === 'repository_altered_only').map((r) => r.name).sort());
  assert.ok(committed.unknown.relations.length >= 3);
  assert.deepEqual(committed.unknown.relations, ['public.brands', 'public.social_account_oauth_states', 'public.social_accounts']);
});

test('the inventory evidence in the report: bound to the query bytes, the fixture world satisfies the requirements, the replay world lacks exactly the unknown baseline', async () => {
  const committed = JSON.parse(read('supabase/preflight/managed_disposable/baseline_provenance.json')) as Provenance;
  const evidence = committed.inventory;
  assert.ok(evidence, 'regenerate: common_account_phase12_baseline_report_run.sh --write');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(read('supabase/preflight/managed_disposable/inventory/schema_inventory.sql')));
  assert.equal(evidence.querySha256, [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''), 'the inventory query changed: regenerate the report');
  assert.deepEqual(evidence.worlds.fixture.findings, [], 'the reviewed fixture world must satisfy every requirement the preflight states');
  const missing = evidence.worlds.replay.findings.filter((f) => f.code === 'RELATION_MISSING').map((f) => f.subject).sort();
  assert.deepEqual(missing, [...committed.unknown.relations, ...committed.createdButNotReplayable].sort(), 'what the replay lacks is the unknown baseline plus what depends on it');
  assert.ok(evidence.worlds.replay.findings.every((f) => ['COLUMN_MISSING', 'FOREIGN_KEY_MISSING', 'FUNCTION_MISSING', 'RELATION_MISSING'].includes(f.code)));
  assert.notEqual(evidence.worlds.fixture.contractDigest, evidence.worlds.replay.contractDigest, 'the two worlds are different baselines, and the digest says so');
});
