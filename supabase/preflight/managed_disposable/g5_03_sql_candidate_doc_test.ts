// Offline contract of docs/common-account/g5-03-authorization-verdict-sql-candidate.md and of the SQL candidate it describes
// (supabase/candidates/common_account_authorization_verdict/): the candidate is outside the migration path and wired nowhere, its shape and ACL are the
// ones the document and G5-02 state, it never names a person parameter, it agrees with the reference's feature list and codes, the document names its
// tests with the real counts, and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_03_sql_candidate_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';
import { POSTONA_FEATURES } from '../../candidates/common_account_postona_authz/verdict.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/common-account/g5-03-authorization-verdict-sql-candidate.md';
const SQL = 'supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql';
const RB = 'supabase/candidates/common_account_authorization_verdict/001_authorization_verdict_rollback.sql';
const PG = 'supabase/tests/common_account_authorization_verdict_pg_test.ts';
const MUT = 'supabase/tests/common_account_authorization_verdict_mutations.py';
const doc = read(DOC);
const sql = read(SQL);
const code = sql.split('\n').map((l) => l.replace(/--.*$/u, '')).join('\n');
const walk = (dir: string): string[] => {
  let entries: Deno.DirEntry[] = [];
  try { entries = [...Deno.readDirSync(new URL(`${dir}/`, root))]; } catch { return []; }
  return entries.flatMap((e) => e.name === 'node_modules' ? [] : e.isDirectory ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
};

test('the document has its sections, the gates and the invariant table', () => {
  for (let n = 1; n <= 9; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 10; n += 1) assert.ok(doc.includes(`| I-${n} `), `I-${n} has a proof row`);
  for (const phrase of ['NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', '#303', '#340', '#344', '#345', '6267736897', '6267545726', 'never `db push`', 'K5']) {
    assert.ok(doc.includes(phrase), phrase);
  }
});

test('the candidate is a candidate: outside the migration path, wired nowhere, one transaction, a rollback that drops only its four functions', () => {
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) {
    assert.ok(!read(`supabase/migrations/${entry.name}`).includes('common_account_authorization_verdict'), `${entry.name} names the RPC`);
  }
  for (const path of [...walk('supabase/functions'), ...walk('apps/social-mobile/src'), ...walk('src')]) {
    if (!/\.(ts|tsx|mjs|js|sql)$/u.test(path)) continue;
    assert.ok(!/common_account_authorization_verdict|worker_brand_verdict/u.test(read(path)), `${path} calls the candidate`);
  }
  assert.ok(sql.includes('NOT in supabase/migrations/'));
  assert.match(code, /^begin;$/mu);
  assert.match(code, /^commit;$/mu);
  const rb = read(RB).split('\n').map((l) => l.replace(/--.*$/u, '')).join('\n');
  assert.equal((rb.match(/drop function if exists/gu) ?? []).length, 4);
  assert.ok(!/drop table|delete from|truncate|grant |revoke /iu.test(rb), 'the rollback drops functions only');
});

test('the shape: three STABLE definer functions with an empty search path; R1 to authenticated, W2 to service_role, nothing else granted; no identity parameter', () => {
  for (const sig of ['create function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text)\nreturns jsonb language plpgsql stable security definer set search_path = \'\' as $$',
    'create function private.account_lifecycle_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint)\nreturns text language plpgsql stable security definer set search_path = \'\' as $$',
    'create function public.common_account_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint)\nreturns text language sql stable security definer set search_path = \'\' as $$']) {
    assert.ok(code.includes(sig), sig.split('(')[0]);
  }
  const grants = [...code.matchAll(/grant execute on function ([a-z_.]+)\([^)]*\) to ([a-z_]+);/gu)].map((m) => `${m[1]}->${m[2]}`);
  assert.deepEqual(grants, ['public.common_account_authorization_verdict->authenticated', 'public.common_account_worker_brand_verdict->service_role']);
  assert.equal((code.match(/\bgrant\b/giu) ?? []).length, 2, 'no other grant');
  assert.ok(!/p_user_id|p_session|p_principal/u.test(code), 'no identity parameter');
  for (const banned of ['for update', 'for share', 'insert into', 'update public', 'delete from', 'perform pg_', 'dblink', 'http']) assert.ok(!code.toLowerCase().includes(banned), banned);
  // the worker generation is a counter compared for equality; no clock (H1 C1 P2)
  const w1 = code.slice(code.indexOf('create function private.account_lifecycle_worker_brand_verdict'), code.indexOf('create function public.common_account_worker_brand_verdict'));
  assert.ok(!/timestamp|activated_at|now\(|clock_/iu.test(w1), 'W1 compares no time');
  assert.ok(w1.includes('if v_lifecycle is distinct from p_expected_lifecycle_version then') && w1.includes('if v_epoch <> p_expected_owner_epoch then'));
  // G5-05: the generation is checked for exact P1 triggers before / after the install and on every W1 call
  assert.ok(code.includes('create function private.account_lifecycle_generation_covered()\nreturns boolean language sql stable security definer set search_path = \'\' as $$'));
  for (const piece of ['t.tgqual is null', 'pg_catalog.cardinality(t.tgattr::int2[]) = 0', 't.tgconstraint = 0', 'not t.tgdeferrable', 'not t.tginitdeferred', 't.tgnargs = 0',
    't.tgoldtable is null', 't.tgnewtable is null', "t.tgtype = 29", "t.tgtype = 19", 'pg_catalog.pg_rewrite', "t.tgname <> 'account_lifecycle_touch_account'"]) assert.ok(code.includes(piece), piece);
  assert.ok(w1.includes('private.account_lifecycle_generation_covered()') && w1.includes("return 'SERVICE_GENERATION_UNAVAILABLE';"));
  assert.ok(code.includes("raise exception 'AUTH_VERDICT_PRECONDITION_LIFECYCLE_TRIGGERS';") && code.includes("raise exception 'AUTH_VERDICT_POSTCONDITION_LIFECYCLE_TRIGGERS';"));
});

test('the SQL agrees with the reference on the feature list, the codes and the token', () => {
  const list = code.match(/p_feature not in \(([^)]*)\)/u)?.[1] ?? '';
  assert.deepEqual(list.split(',').map((s) => s.trim().replaceAll("'", '')).sort(), Object.keys(POSTONA_FEATURES).sort());
  for (const reason of ['FEATURE_NOT_ENABLED', 'BRAND_REQUIRED', 'AUTH_REQUIRED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'ACCOUNT_NOT_FOUND', 'ACCOUNT_UNREADABLE',
    'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED', 'ACCOUNT_STATE_UNKNOWN', 'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_PROVISIONING',
    'SERVICE_SUSPENDED', 'SERVICE_NOT_ACTIVE', 'SERVICE_STATE_UNKNOWN', 'BRAND_ACCESS_DENIED', 'ROLE_NOT_ALLOWED', 'WORKSPACE_KIND_UNSUPPORTED',
    'WORKSPACE_OWNER_UNKNOWN', 'OWNER_EPOCH_UNAVAILABLE', 'EXPECTED_OWNER_EPOCH_REQUIRED', 'EXPECTED_LIFECYCLE_VERSION_REQUIRED', 'OWNER_EPOCH_CHANGED', 'SERVICE_GENERATION_CHANGED', 'SERVICE_GENERATION_UNAVAILABLE']) {
    assert.ok(code.includes(`'${reason}'`), reason);
  }
  assert.ok(code.includes("'g5oe:' || f_epoch::text || ':' || f_lifecycle::text"));
  assert.ok(code.includes("'g5-session:' || v_session_id::text"), 'the same session reference as the reference model');
});

test('the document names its tests with the real counts and the files exist', () => {
  const pg = (read(PG).match(/^test_\(/gmu) ?? []).length;
  const mutants = (read(MUT).match(/^ {4}\('/gmu) ?? []).length;
  assert.ok(doc.includes(`${pg} tests`), `the document should say ${pg} tests`);
  assert.ok(doc.includes(`${mutants}/${mutants} detected`), `the document should say ${mutants}/${mutants} detected`);
  for (const path of [SQL, RB, PG, MUT, 'supabase/tests/common_account_authorization_verdict_pg_run.sh']) {
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
