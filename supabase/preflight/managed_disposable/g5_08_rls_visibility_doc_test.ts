// Offline contract of docs/common-account/g5-08-r0-rls-visibility-fix.md and of the G5-08 guards it describes in the two SQL candidates
// (supabase/candidates/common_account_authorization_verdict/{001_authorization_verdict,002_bootstrap_verdict}.sql): every relation read must show the
// function owner every row (RLS off, BYPASSRLS, or the table owner's privileges with RLS not FORCED; no view), every verdict function runs with
// row_security = off, no grant / ownership / RLS change is added, the document names its tests with the real counts, and nothing is secret-shaped, a
// project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_08_rls_visibility_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const DOC = 'docs/common-account/g5-08-r0-rls-visibility-fix.md';
const DIR = 'supabase/candidates/common_account_authorization_verdict';
const PG = 'supabase/tests/common_account_bootstrap_verdict_pg_test.ts';
const MUT = 'supabase/tests/common_account_bootstrap_verdict_mutations.py';
const doc = read(DOC);
const strip = (s: string) => s.split('\n').map((l) => l.replace(/--.*$/u, '')).join('\n');
const r0 = strip(read(`${DIR}/002_bootstrap_verdict.sql`));
const r1 = strip(read(`${DIR}/001_authorization_verdict.sql`));
const RELATIONS = ['public.common_accounts', 'public.service_entitlements', 'public.brands', 'public.brand_memberships', 'private.account_lifecycle_operations', 'auth.users', 'auth.sessions'];

test('the document has its sections, the invariant table, the reproduction and the gates', () => {
  for (let n = 1; n <= 8; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 8; n += 1) assert.ok(doc.includes(`| V-${n} `), `V-${n}`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', '6289716702', '6289776973', '759b89fa376f5b3ba9286fa49d5295a6e4938459', '#383', '#303',
    'G4 / F3', 'second owner', 'allow:null', 'deny:OWN_WORKSPACE_CONFLICT', 'row_security = off', 'BYPASSRLS', 'K5']) {
    assert.ok(doc.includes(phrase), phrase);
  }
});

test('both installs require every row visible: the same relations, a table, SELECT, not FORCED, and BYPASSRLS or the table owner\'s privileges', () => {
  for (const [name, code, prefix] of [['002', r0, 'BOOTSTRAP_VERDICT'], ['001', r1, 'AUTH_VERDICT']] as const) {
    const list = code.match(/foreach v_rel in array array\[([^\]]*)\]/u)?.[1] ?? '';
    assert.deepEqual(list.split(',').map((s) => s.trim().replaceAll("'", '')), RELATIONS, `${name}: the relations`);
    for (const piece of ["select c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relowner into v_kind, v_rls, v_forced, v_relowner",
      "if not found or v_kind not in ('r', 'p') or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then",
      "if v_rls and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) and not pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE') then",
      `raise exception '${prefix}_PRECONDITION_RLS_HIDES_ROWS %', v_rel;`, `raise exception '${prefix}_PRECONDITION_RLS_FORCED %', v_rel;`]) {
      assert.ok(code.includes(piece), `${name}: ${piece}`);
    }
  }
});

test('every verdict function runs with row_security = off, and the postconditions require it', () => {
  const signatures = [...r0.matchAll(/^returns [a-z]+ language [a-z]+ stable security definer (set [^\n]*) as \$\$$/gmu), ...r1.matchAll(/^returns [a-z]+ language [a-z]+ stable security definer (set [^\n]*) as \$\$$/gmu)];
  assert.equal(signatures.length, 5, 'R0, R1, W1, W2, GC');
  for (const s of signatures) assert.equal(s[1], "set search_path = '' set row_security = off");
  for (const code of [r0, r1]) assert.ok(code.includes(`p.proconfig @> array['search_path=""', 'row_security=off']`));
});

test('no grant, ownership or RLS change was added: the candidates only read', () => {
  assert.equal((r0.match(/\bgrant\b/giu) ?? []).length, 1);
  assert.equal((r1.match(/\bgrant\b/giu) ?? []).length, 2);
  for (const code of [r0, r1]) {
    for (const banned of ['owner to', 'enable row level security', 'disable row level security', 'create policy', 'alter role', 'set role']) {
      assert.ok(!code.toLowerCase().includes(banned), banned);
    }
  }
});

test('the document names its tests with the real counts', () => {
  const pg = (read(PG).match(/^test_\(/gmu) ?? []).length;
  const mutants = (read(MUT).match(/^ {4}\(['"]/gmu) ?? []).length;
  assert.ok(doc.includes(`${pg} tests`), `the document should say ${pg} tests`);
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  assert.deepEqual(secretFindings(doc), []);
  assert.deepEqual(projectRefsIn(doc), []);
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z_]+@@/u.test(doc), 'nothing unfinished');
});
