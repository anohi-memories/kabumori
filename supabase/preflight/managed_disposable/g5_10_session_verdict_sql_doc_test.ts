// Offline contract of docs/common-account/g5-10-session-verdict-sql-candidate.md and the SQL candidate it describes
// (supabase/candidates/common_account_authorization_verdict/003_session_verdict.sql): outside the migration path and wired nowhere, owner-only with no
// grant, no parameter, read-only, R1's claim lines verbatim, the G5-08 visibility rules, the codes of the reference model, the document names its tests
// with the real counts, and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_10_session_verdict_sql_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';
import { SESSION_VERDICTS } from '../../candidates/common_account_postona_authz/session_verdict.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/g5-10-session-verdict-sql-candidate.md';
const DIR = 'supabase/candidates/common_account_authorization_verdict';
const SQL = `${DIR}/003_session_verdict.sql`;
const RB = `${DIR}/003_session_verdict_rollback.sql`;
const PG = 'supabase/tests/common_account_session_verdict_pg_test.ts';
const MUT = 'supabase/tests/common_account_session_verdict_mutations.py';
const RUN = 'supabase/tests/common_account_session_verdict_pg_run.sh';
const doc = read(DOC);
const sql = read(SQL);
const strip = (s: string) => s.split('\n').map((l) => l.replace(/--.*$/u, '')).join('\n');
const code = strip(sql);
const walk = (dir: string): string[] => {
  let entries: Deno.DirEntry[] = [];
  try { entries = [...Deno.readDirSync(new URL(`${dir}/`, root))]; } catch { return []; }
  return entries.flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
};

test('the document has its sections, the invariant table and the gates', () => {
  for (let n = 1; n <= 8; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 9; n += 1) assert.ok(doc.includes(`| S-${n} `), `S-${n}`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', '#406', '1d032e1ee7d91848118abe8d20f847fb78c3250a', '#399', '6294869449', 'K5',
    'user / G1 decisions', 'POSTONA_RESV_AUTH_REQUIRED', 'edgeClaimsForDb', 'API delta vs PR #406']) {
    assert.ok(doc.includes(phrase), phrase);
  }
});

test('a candidate: outside the migration path, wired nowhere, one transaction, a rollback that drops this function only', () => {
  for (const path of [...walk('supabase/migrations'), ...walk('supabase/functions'), ...walk('apps')]) {
    if (!/\.(sql|ts|tsx|js|mjs)$/u.test(path)) continue;
    assert.ok(!read(path).includes('account_lifecycle_session_verdict'), `${path} names it`);
  }
  for (const path of walk('supabase/candidates')) {
    if (/\.sql$/u.test(path) && path !== SQL && path !== RB) assert.ok(!read(path).includes('account_lifecycle_session_verdict'), `${path} calls it`);
  }
  assert.match(code, /^begin;$/mu);
  assert.match(code, /^commit;$/mu);
  const rb = strip(read(RB));
  assert.equal((rb.match(/drop function if exists/gu) ?? []).length, 1);
  assert.ok(rb.includes('drop function if exists private.account_lifecycle_session_verdict();'));
});

test('the shape: owner-only (no grant), no parameter, STABLE definer with an empty search path and row_security off, no write, no lock', () => {
  assert.ok(code.includes("create function private.account_lifecycle_session_verdict()\nreturns text language plpgsql stable security definer set search_path = '' set row_security = off as $$"));
  assert.equal((code.match(/\bgrant\b/giu) ?? []).length, 0, 'no grant at all');
  assert.ok(code.includes('revoke all on function private.account_lifecycle_session_verdict() from public, anon, authenticated, service_role;'));
  assert.ok(code.includes("is distinct from format('%s=X/%s', v_owner, v_owner) then"), 'the exact owner-only ACL');
  for (const banned of ['for update', 'for share', 'insert into', 'update ', 'delete from', 'perform pg_', 'common_accounts', 'service_entitlements', 'brand', 'http']) {
    assert.ok(!code.toLowerCase().includes(banned), banned);
  }
});

test('R1\'s claim lines verbatim, the G5-08 visibility rule, and the reference\'s codes', () => {
  const r1 = strip(read(`${DIR}/001_authorization_verdict.sql`));
  for (const line of ["  v_sub := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '');",
    "    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');",
    "      v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');",
    "     and v_role = 'authenticated' and v_anonymous = 'false' then", "    if (select auth.uid()) is not distinct from v_sub::uuid then",
    "            from (select 1) x left join auth.sessions s on s.id = v_session_id and s.user_id = v_user)",
    "    if v_rls and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) and not pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE') then"]) {
    assert.ok(code.includes(line) && r1.includes(line), line);
  }
  const answers = new Set([...code.matchAll(/return '([A-Z_a-z]+)';|then '([A-Z_a-z]+)'/gu)].map((m) => m[1] ?? m[2]).filter((c) => /^(active|[A-Z_]+)$/u.test(c)));
  for (const c of SESSION_VERDICTS.filter((x) => x !== 'SESSION_UNKNOWN')) assert.ok(code.includes(`'${c}'`), c);
  assert.ok(answers.size > 0);
});

test('the document names its tests with the real counts and the files exist', () => {
  const pg = (read(PG).match(/^test_\(/gmu) ?? []).length;
  const mutants = (read(MUT).match(/^ {4}\(['"]/gmu) ?? []).length;
  assert.ok(doc.includes(`${pg} tests`), `the document should say ${pg} tests`);
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
  for (const path of [SQL, RB, PG, MUT, RUN]) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!), `${path} is named`);
  }
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  for (const [name, text] of [['doc', doc], ['sql', sql], ['pg', read(PG)]] as const) {
    assert.deepEqual(secretFindings(text.replace(/https:\/\/example\.invalid\//gu, '')), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z_]+@@/u.test(doc), 'nothing unfinished');
});
