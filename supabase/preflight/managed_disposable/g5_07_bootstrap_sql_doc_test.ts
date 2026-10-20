// Offline contract of docs/common-account/g5-07-bootstrap-verdict-sql-candidate.md and of the SQL candidate R0 it describes
// (supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql): outside the migration path and wired nowhere, the shape and ACL
// the document states, no brand / person parameter, no write, the bootstrap features and codes of the reference, the same claim rules and derivation as
// R1 / main's begin, the document names its tests with the real counts, and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_07_bootstrap_sql_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';
import { BOOTSTRAP_FEATURES } from '../../candidates/common_account_postona_authz/bootstrap.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/g5-07-bootstrap-verdict-sql-candidate.md';
const SQL = 'supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql';
const RB = 'supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict_rollback.sql';
const R1 = 'supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql';
const PG = 'supabase/tests/common_account_bootstrap_verdict_pg_test.ts';
const MUT = 'supabase/tests/common_account_bootstrap_verdict_mutations.py';
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
  for (let n = 1; n <= 9; n += 1) assert.ok(doc.includes(`| B-${n} `), `B-${n}`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', '#375', '#371', '#345', '6287813812', 'G4 / F3', 'second owner', 'K5']) assert.ok(doc.includes(phrase), phrase);
});

test('the candidate is a candidate: outside the migration path, wired nowhere, one transaction, a rollback that drops R0 only', () => {
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) assert.ok(!read(`supabase/migrations/${entry.name}`).includes('common_account_bootstrap_verdict'), entry.name);
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src'), ...walk('src')]) {
    if (!/\.(ts|tsx|mjs|js|sql)$/u.test(path)) continue;
    assert.ok(!read(path).includes('common_account_bootstrap_verdict'), `${path} calls R0`);
  }
  assert.match(code, /^begin;$/mu);
  assert.match(code, /^commit;$/mu);
  const rb = strip(read(RB));
  assert.equal((rb.match(/drop function if exists/gu) ?? []).length, 1);
  assert.ok(rb.includes('drop function if exists public.common_account_bootstrap_verdict(text, text);'));
});

test('the shape: one STABLE definer function, two parameters, EXECUTE to authenticated only, no write, no lock, no brand, no person', () => {
  assert.ok(code.includes("create function public.common_account_bootstrap_verdict(p_app text, p_feature text)\nreturns jsonb language plpgsql stable security definer set search_path = '' set row_security = off as $$"));
  const grants = [...code.matchAll(/grant execute on function ([a-z_.]+)\([^)]*\) to ([a-z_]+);/gu)].map((m) => `${m[1]}->${m[2]}`);
  assert.deepEqual(grants, ['public.common_account_bootstrap_verdict->authenticated']);
  assert.equal((code.match(/\bgrant\b/giu) ?? []).length, 1);
  for (const banned of ['p_brand', 'p_user', 'p_session', 'for update', 'for share', 'insert into', 'update public', 'delete from', 'perform pg_', 'social_account_oauth_states', 'http']) {
    assert.ok(!code.toLowerCase().includes(banned), banned);
  }
  assert.ok(code.includes("'brand_slug', null") && code.includes("'owner_epoch', null, 'entitlements', '[\"postona:x_autopost\"]'::jsonb"), 'bootstrap-only answer');
});

test('the SQL keeps R1\'s claim rules, the begin\'s derivation and the reference\'s features and codes', () => {
  const r1 = strip(read(R1));
  for (const line of ["v_sub := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '');",
    "v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');",
    "v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');",
    "and v_role = 'authenticated' and v_anonymous = 'false' then", "if (select auth.uid()) is not distinct from v_sub::uuid then",
    "v_session_ref := 's:' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g5-session:' || v_session_id::text, 'UTF8')), 'hex'), 32);"]) {
    assert.ok(code.includes(line) && r1.includes(line), line);
  }
  assert.ok(code.includes("v_workspace := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);"), 'the begin RPC\'s derivation, from the verified subject');
  const list = code.match(/p_feature not in \(([^)]*)\)/u)?.[1] ?? '';
  assert.deepEqual(list.split(',').map((s) => s.trim().replaceAll("'", '')).sort(), [...BOOTSTRAP_FEATURES].sort());
  for (const reason of ['FEATURE_NOT_ENABLED', 'AUTH_REQUIRED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
    'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_PROVISIONING', 'SERVICE_SUSPENDED', 'SERVICE_NOT_ACTIVE', 'OWN_WORKSPACE_CONFLICT', 'WORKSPACE_OWNER_UNKNOWN']) {
    assert.ok(code.includes(`'${reason}'`), reason);
  }
});

test('the document names its tests with the counts as of G5-07 (the current counts are in the G5-08 document) and the files exist', () => {
  assert.ok(doc.includes('11 tests') && doc.includes('30/30 detected'), 'the G5-07 counts');
  assert.ok(doc.includes('G5-08 update') && doc.includes('g5-08-r0-rls-visibility-fix.md'), 'points to G5-08');
  for (const path of [SQL, RB, PG, MUT, 'supabase/tests/common_account_bootstrap_verdict_pg_run.sh']) {
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
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@RESULTS@@/u.test(doc), 'nothing unfinished');
});
