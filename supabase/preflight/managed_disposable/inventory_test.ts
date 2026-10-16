// Pure tests of the schema-inventory logic (F5 Phase 12): parsing, structural validation, secret scan, canonical digest,
// drift, the contract subset, the requirement check, and the two verdicts. No database: the SQL itself is proved on a
// local database by supabase/tests/common_account_phase12_inventory_run.sh.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Requirements } from './baseline_requirements.ts';
import { H, syntheticInventory } from './inventory_fixtures.ts';
import {
  ATTRIBUTES, baselineReadiness, canonicalize, checkInventorySql, checkRequirements, contractSubset, diffInventories, hasDrift, KINDS, type Line,
  parseInventory, secretFindings, stableStringify, validateShape, verifyInventory,
} from './inventory.ts';

const provenance = JSON.parse(Deno.readTextFileSync(new URL('./baseline_provenance.json', import.meta.url))) as {
  requirements: Requirements;
  unknown: { relations: string[]; columns: string[]; foreignKeys: string[]; functions: string[] };
};
const requirements = provenance.requirements;

const synthetic = (options: { skip?: (line: Line) => boolean; tweak?: (line: Line) => void } = {}): Line[] => syntheticInventory(requirements, options);
const toText = (lines: Line[]) => lines.map((line) => JSON.stringify(line)).join('\n');
const approvedDigest = async (lines: Line[] = synthetic()) => (await canonicalize(contractSubset(lines, requirements))).digest;

test('every kind has a closed attribute list and the synthetic inventory is valid against it', () => {
  assert.deepEqual(Object.keys(ATTRIBUTES).sort(), [...KINDS].sort());
  assert.deepEqual(validateShape(synthetic()), []);
});

test('parsing: only one JSON object per line, a known kind, a unique key, and the meta line that proves the query finished', () => {
  const text = toText(synthetic());
  assert.equal(parseInventory(text).length, synthetic().length);
  assert.throws(() => parseInventory(`${text}\nNOTICE: something`), /not JSON/u);
  assert.throws(() => parseInventory(`${text}\n${JSON.stringify({ k: 'meta', key: 'inventory', a: {}, extra: 1 })}`), /not \{k, key, a\}/u);
  assert.throws(() => parseInventory(`${text}\n${JSON.stringify({ k: 'rows', key: 'x', a: {} })}`), /kind the inventory does not define/u);
  assert.throws(() => parseInventory(`${text}\n${JSON.stringify({ k: 'meta', key: 'inventory', a: {} })}`), /repeats/u);
  assert.throws(() => parseInventory(toText(synthetic().filter((line) => line.k !== 'meta'))), /no meta line/u);
  assert.throws(() => parseInventory(`${text}\n[]`), /not \{k, key, a\}/u);
});

test('validation refuses what could carry a value: a new attribute, an unmasked literal, a non-hash, an unredacted setting, an option value', () => {
  const lines = synthetic();
  const mutate = (fn: (line: Line) => void, pick: (line: Line) => boolean) => {
    const copy: Line[] = JSON.parse(JSON.stringify(lines));
    for (const line of copy) if (pick(line)) fn(line);
    return validateShape(copy).map((f) => f.code);
  };
  assert.deepEqual(mutate((l) => { l.a.row_sample = 'x'; }, (l) => l.k === 'relation' && l.key === 'public.profiles'), ['UNEXPECTED_ATTRIBUTE']);
  assert.deepEqual(mutate((l) => { delete l.a.type; }, (l) => l.key === 'public.profiles.unrelated_note'), ['MISSING_ATTRIBUTE']);
  assert.deepEqual(mutate((l) => { l.a.default_shape = "'sk-live-1234'::text"; }, (l) => l.key === 'public.profiles.unrelated_note'), ['UNMASKED_LITERAL']);
  assert.deepEqual(mutate((l) => { l.a.default_shape = '$tag$secret$tag$'; }, (l) => l.key === 'public.profiles.unrelated_note'), ['UNMASKED_LITERAL']);
  assert.deepEqual(mutate((l) => { l.a.default_sha256 = 'not-a-hash'; }, (l) => l.key === 'public.profiles.unrelated_note'), ['NOT_A_HASH']);
  assert.deepEqual(mutate((l) => { l.a.config = { search_path: 'public', 'app.settings.key': 'abc' }; }, (l) => l.key === 'public.noise()'), ['UNREDACTED_SETTING']);
  const withServer = [...lines, { k: 'foreign_server', key: 'remote', a: { wrapper: 'postgres_fdw', owner: 'postgres', option_keys: ['host', 'password=hunter2'] } } as Line];
  assert.deepEqual(validateShape(withServer).map((f) => f.code), ['SETTING_NAME_SHAPE']);
});

test('the secret scan sees keys, URLs, connection strings and Supabase hosts, and not the harmless words of a schema', () => {
  const secretValue = (parts: string[]) => parts.join('');
  const sample = (text: string) => secretFindings(text).map((f) => f.code);
  assert.deepEqual(sample(secretValue(['{"x":"eyJhbGciOiJIUzI1NiJ9', '.eyJyb2xlIjoic2VydmljZV9yb2xlIn0', '.c2lnbmF0dXJlMTIz"}'])), ['SECRET_JWT']);
  assert.deepEqual(sample(secretValue(['sb_secret_', 'abcdef1234567890'])), ['SECRET_SUPABASE_KEY']);
  assert.ok(sample(secretValue(['postgres', '://u:p@db.example.com:5432/postgres'])).includes('SECRET_CONNECTION_STRING'));
  assert.ok(sample(secretValue(['https', '://hooks.example.com/x'])).includes('SECRET_URL'));
  assert.ok(sample(secretValue(['abcdefghij0123456789', '.supabase.co'])).includes('SECRET_SUPABASE_HOST'));
  assert.deepEqual(sample('-----BEGIN RSA PRIVATE KEY-----'), ['SECRET_PRIVATE_KEY']);
  assert.deepEqual(sample(toText(synthetic())), [], 'the schema vocabulary (secret, token, supabase_host as a key name) is not a finding');
});

test('canonical form: key order and line order do not matter, the digest is a SHA-256, and a per-kind digest localises a change', async () => {
  const lines = synthetic();
  const first = await canonicalize(lines);
  const shuffled = [...lines].reverse().map((line) => ({ k: line.k, a: Object.fromEntries(Object.entries(line.a).reverse()), key: line.key }) as Line);
  const second = await canonicalize(shuffled);
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[0-9a-f]{64}$/u);
  assert.equal(stableStringify({ b: 1, a: { d: 1, c: [2, { z: 1, y: 2 }] } }), '{"a":{"c":[2,{"y":2,"z":1}],"d":1},"b":1}');
  const changed = synthetic({ tweak: (line) => { if (line.k === 'function' && line.key === 'public.noise()') line.a.body_sha256 = H(99); } });
  const third = await canonicalize(changed);
  assert.notEqual(third.digest, first.digest);
  const differing = Object.keys(first.kinds).filter((kind) => first.kinds[kind].digest !== third.kinds[kind].digest);
  assert.deepEqual(differing, ['function']);
});

test('drift: missing, extra and changed objects are each reported, with the attributes that differ', () => {
  const approved = synthetic();
  const observed = synthetic({
    skip: (line) => line.k === 'trigger',
    tweak: (line) => { if (line.k === 'relation' && line.key === 'public.profiles') line.a.rls = false; },
  });
  observed.push({ k: 'index', key: 'public.profiles.extra_idx', a: { rel: 'public.profiles', unique: false, primary: false, valid: true, ready: true, method: 'btree', def_shape: 'CREATE INDEX', def_sha256: H(8) } });
  const drift = diffInventories(approved, observed);
  assert.deepEqual(drift.missing, ['trigger public.profiles.t_noise']);
  assert.deepEqual(drift.extra, ['index public.profiles.extra_idx']);
  assert.deepEqual(drift.changed, [{ object: 'relation public.profiles', fields: ['rls'] }]);
  assert.equal(hasDrift(drift), true);
  assert.equal(hasDrift(diffInventories(approved, synthetic())), false);
});

test('the contract subset is the minimum the chain needs: required items stay, noise and column positions go', () => {
  const subset = contractSubset(synthetic(), requirements);
  const kinds = new Set(subset.map((line) => line.k));
  assert.ok(!kinds.has('trigger') && !kinds.has('policy') && !kinds.has('index') && !kinds.has('meta'));
  assert.ok(!subset.some((line) => line.key === 'public.profiles.unrelated_note'), 'an unrelated column is not part of the contract');
  assert.ok(!subset.some((line) => line.k === 'function' && line.key === 'public.noise()'));
  assert.ok(subset.every((line) => !('ord' in line.a)), 'the column position is not semantic');
  const platformColumn = subset.find((line) => line.k === 'column' && line.key === 'auth.sessions.not_after');
  assert.deepEqual(Object.keys(platformColumn?.a ?? {}).sort(), ['rel', 'type'], 'a platform column is compared by type only');
  const platformRelation = subset.find((line) => line.k === 'relation' && line.key === 'auth.users');
  assert.deepEqual(Object.keys(platformRelation?.a ?? {}), ['relkind']);
  const appRelation = subset.find((line) => line.k === 'relation' && line.key === 'public.brands');
  assert.ok(appRelation && 'rls' in appRelation.a && 'owner' in appRelation.a);
  assert.deepEqual(checkRequirements(subset, requirements), []);
});

test('requirements: every kind of absence is a finding with its own code', () => {
  const codes = (skip: (line: Line) => boolean, tweak?: (line: Line) => void) => checkRequirements(synthetic({ skip, tweak }), requirements).map((f) => f.code);
  assert.deepEqual(codes((l) => l.k === 'schema' && l.key === 'private'), ['SCHEMA_MISSING']);
  assert.deepEqual(codes((l) => l.k === 'role' && l.key === 'service_role'), ['ROLE_MISSING']);
  const relation = codes((l) => l.k === 'relation' && l.key === 'public.brands');
  assert.ok(relation.includes('RELATION_MISSING'));
  assert.deepEqual(codes(() => false, (l) => { if (l.k === 'relation' && l.key === 'public.brands') l.a.relkind = 'v'; }), ['RELATION_KIND']);
  assert.deepEqual(codes((l) => l.k === 'column' && l.key === 'public.brands.code_profile_key'), ['COLUMN_MISSING']);
  assert.deepEqual(codes(() => false, (l) => { if (l.k === 'column' && l.key === 'public.brands.code_profile_key') l.a.type = 'integer'; }), ['COLUMN_TYPE']);
  assert.deepEqual(codes((l) => l.k === 'constraint' && l.key === 'public.social_accounts.brand_id_fkey'), ['FOREIGN_KEY_MISSING']);
  assert.deepEqual(codes(() => false, (l) => { if (l.k === 'constraint' && l.key === 'public.social_accounts.brand_id_fkey') (l.a.fk as { on_delete: string }).on_delete = 'c'; }), ['FOREIGN_KEY_ON_DELETE']);
  assert.deepEqual(codes((l) => l.k === 'function' && l.key === requirements.functions[0]), ['FUNCTION_MISSING']);
  assert.deepEqual(codes((l) => l.k === 'column' && l.key === 'auth.sessions.not_after'), ['COLUMN_MISSING'], 'the later preflights need auth.sessions too');
});

test('verifyInventory: PASS on the approved contract, STOP on no approval / secret / unreadable / invalid / missing / drift', async () => {
  const lines = synthetic();
  const approved = await approvedDigest(lines);
  const good = await verifyInventory(toText(lines), requirements, approved);
  assert.equal(good.status, 'PASS');
  assert.equal(good.digest, approved);

  assert.match((await verifyInventory(toText(lines), requirements, undefined)).detail, /no approved baseline-contract digest/u);
  assert.match((await verifyInventory(toText(lines), requirements, 'not-a-digest')).detail, /no approved baseline-contract digest/u);
  const leaky = synthetic({ tweak: (l) => { if (l.k === 'column' && l.key === 'public.profiles.unrelated_note') l.a.default_shape = ['postgres', '://u:p@h/db'].join(''); } });
  const secret = await verifyInventory(toText(leaky), requirements, approved);
  assert.equal(secret.status, 'STOP');
  assert.match(secret.detail, /secret-shaped/u);
  assert.ok(!secret.detail.includes('u:p@h'), 'the value itself never reaches the verdict');
  assert.equal((await verifyInventory('psql: error: connection refused', requirements, approved)).status, 'STOP');
  const invalid = synthetic({ tweak: (l) => { if (l.k === 'relation' && l.key === 'public.profiles') l.a.rows = 3; } });
  assert.match((await verifyInventory(toText(invalid), requirements, approved)).detail, /violates its own contract/u);
  const absent = synthetic({ skip: (l) => l.k === 'relation' && l.key === 'public.brands' });
  assert.match((await verifyInventory(toText(absent), requirements, approved)).detail, /RELATION_MISSING/u);

  const drifted = synthetic({ tweak: (l) => { if (l.k === 'column' && l.key === 'public.brands.id') l.a.notnull = true; } });
  const drift = await verifyInventory(toText(drifted), requirements, approved);
  assert.equal(drift.status, 'STOP');
  assert.match(drift.detail, /differs from the approved one/u);
  assert.notEqual(drift.digest, approved);
});

test('the boundary of the contract is explicit: a change OUTSIDE it is not drift, a change INSIDE it always is', async () => {
  const approved = await approvedDigest();
  const outside = synthetic({ tweak: (l) => { if (l.k === 'trigger') l.a.def_sha256 = H(42); if (l.k === 'column' && l.key === 'public.profiles.unrelated_note') l.a.type = 'jsonb'; } });
  assert.equal((await verifyInventory(toText(outside), requirements, approved)).status, 'PASS');
  const inside: [string, (l: Line) => void][] = [
    ['owner of a required table', (l) => { if (l.k === 'relation' && l.key === 'public.profiles') l.a.owner = 'someone_else'; }],
    ['RLS of a required table', (l) => { if (l.k === 'relation' && l.key === 'public.profiles') l.a.rls = false; }],
    ['body of a required function', (l) => { if (l.k === 'function' && l.key === requirements.functions[0].replace(/\s+/gu, '')) l.a.body_sha256 = H(77); }],
    ['security mode of a required function', (l) => { if (l.k === 'function' && l.key === requirements.functions[0].replace(/\s+/gu, '')) l.a.security_definer = false; }],
    ['primary key of a required table', (l) => { if (l.k === 'constraint' && l.key === 'public.profiles.profiles_pkey') l.a.def_sha256 = H(78); }],
    ['default of a required column', (l) => { if (l.k === 'column' && l.key === 'public.brands.id') l.a.default_sha256 = H(79); }],
    ['ACL of a required table', (l) => { if (l.k === 'relation' && l.key === 'public.profiles') l.a.acl = ['PUBLIC:SELECT']; }],
    ['attributes of a required role', (l) => { if (l.k === 'role' && l.key === 'anon') l.a.bypassrls = true; }],
  ];
  for (const [name, tweak] of inside) {
    const verdict = await verifyInventory(toText(synthetic({ tweak })), requirements, approved);
    assert.equal(verdict.status, 'STOP', name);
  }
});

test('readiness: NOT_READY without an inventory, never better than READY_FOR_OWNER_REVIEW with one', async () => {
  const none = await baselineReadiness(provenance.unknown, requirements, null);
  assert.equal(none.state, 'NOT_READY');
  assert.match(none.reasons.join(' '), /no inventory has been supplied/u, 'the reason is the absence, not a parse error');
  assert.ok(none.unknownObjects.includes('relation public.brands'));
  assert.ok(none.unknownObjects.some((entry) => entry.startsWith('column public.brands.')));
  assert.ok(none.unknownObjects.some((entry) => entry.startsWith('foreign key ')));

  const complete = await baselineReadiness(provenance.unknown, requirements, toText(synthetic()));
  assert.equal(complete.state, 'READY_FOR_OWNER_REVIEW');
  assert.equal(complete.contractDigest, await approvedDigest());

  const partial = await baselineReadiness(provenance.unknown, requirements, toText(synthetic({ skip: (l) => l.k === 'relation' && l.key === 'public.social_accounts' })));
  assert.equal(partial.state, 'NOT_READY');
  assert.match(partial.reasons.join(' '), /RELATION_MISSING|unknown relation/u);

  const leaky = await baselineReadiness(provenance.unknown, requirements, `${toText(synthetic())}\n${['postgres', '://u:p@h/db'].join('')}`);
  assert.equal(leaky.state, 'NOT_READY');
  assert.match(leaky.reasons.join(' '), /secret-shaped/u);
  assert.equal((await baselineReadiness(provenance.unknown, requirements, 'garbage')).state, 'NOT_READY');
});

// ---- the query file itself ------------------------------------------------------------------------------------------

const queryText = Deno.readTextFileSync(new URL('./inventory/schema_inventory.sql', import.meta.url));

test('the committed inventory query is read-only, catalog-only and function-allowlisted', () => {
  assert.deepEqual(checkInventorySql(queryText), []);
  assert.match(queryText, /^begin transaction isolation level repeatable read read only;$/mu);
  assert.match(queryText, /^rollback;\s*$/mu);
});

test('the query check refuses the ways a reader could be turned into something else', () => {
  const base = queryText;
  const codes = (sql: string) => [...new Set(checkInventorySql(sql).map((f) => f.code))].sort();
  const withExtra = (statement: string) => base.replace(/\nrollback;\s*$/u, `\n${statement}\nrollback;\n`);
  assert.deepEqual(codes(withExtra("select * from public.profiles;")), ['FROM_TARGET', 'SCHEMA_QUALIFIED_OBJECT']);
  assert.deepEqual(codes(withExtra("select id from profiles;")), ['FROM_TARGET']);
  assert.ok(codes(withExtra("select id from pg_class c, profiles p;")).includes('COMMA_JOIN'));
  assert.deepEqual(codes(withExtra("select pg_read_file('/etc/passwd');")), ['FUNCTION_NOT_LISTED']);
  assert.deepEqual(codes(withExtra("select pg_sleep(100);")), ['FUNCTION_NOT_LISTED']);
  assert.deepEqual(codes(withExtra("select nextval('public.s');")), ['FUNCTION_NOT_LISTED']);
  assert.deepEqual(codes(withExtra("select set_config('role', 'postgres', true);")), ['FUNCTION_NOT_LISTED']);
  assert.deepEqual(codes(withExtra("select * from pg_authid;")), ['CATALOG_NAME', 'FROM_TARGET']);
  assert.deepEqual(codes(withExtra("select * from pg_stats;")), ['CATALOG_NAME', 'FROM_TARGET']);
  assert.ok(codes(withExtra("insert into public.t values (1);")).includes('STATEMENT_KIND'));
  assert.ok(codes(withExtra("create temp table x(a int);")).includes('STATEMENT_KIND'));
  assert.ok(codes(withExtra("set role postgres;")).includes('SET_NOT_ALLOWED'));
  assert.ok(codes(withExtra("set local statement_timeout = '1s'; commit;")).includes('STATEMENT_KIND'));
  assert.ok(codes(base.replace('read only;', ';')).includes('NOT_READ_ONLY_BEGIN'));
  assert.ok(codes(base.replace(/rollback;\s*$/u, 'commit;\n')).includes('NOT_ROLLBACK_END'));
  assert.ok(codes(base.replace('begin transaction isolation level repeatable read read only;', 'begin;')).includes('NOT_READ_ONLY_BEGIN'));
  assert.ok(codes(withExtra("select 1 /* from public.t */;")).length === 0, 'a comment is not a statement');
  assert.ok(codes(withExtra("select 'public.profiles';")).length === 0, 'a name inside a literal is just text');
  assert.ok(codes(withExtra("select q from (select 1) q;")).length === 0);
  assert.deepEqual(codes(withExtra("select \"public\".\"profiles\".id from pg_class;")), ['SCHEMA_QUALIFIED_OBJECT']);
  assert.ok(codes(base.replace('rollback;', "select 'unterminated;\nrollback;")).includes('UNLEXABLE'));
});
