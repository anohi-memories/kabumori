// Offline contract of docs/security/supabase-data-api-explicit-grants-20261030.md (the canonical candidate of the shared Data API grant rule, G5)
// and of the read-only tools it names: the rule R-1..R-14, the G5 inventory, the owners' status with the 2026-10-27 / 2026-10-30 dates, the audit
// SQL is read-only and checks every API role / flag the rule names, the G5 migrations still revoke-then-grant their public tables, nothing in this PR
// is a migration or product SQL, and nothing is secret-shaped, a project host or unfinished. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_12_data_api_grants_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const DOC = 'docs/security/supabase-data-api-explicit-grants-20261030.md';
const AUDIT = 'supabase/tests/common_account_data_api_grants_audit.sql';
const doc = read(DOC);

test('the document has its sections, the rule R-1..R-14, the dates and the gates', () => {
  for (let n = 1; n <= 8; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let n = 1; n <= 14; n += 1) assert.ok(doc.includes(`| R-${n} `), `R-${n}`);
  for (const phrase of ['2026-10-27', '2026-10-30', '6303406473', '6303404723', '6303405548', '6303407251', 'NO_GO', 'NOT_VERIFIED', 'Codex Sol (high)', 'K5',
    'SUPABASE-DATA-API-20261030-CROSS-SLOT', 'changelog 45329', '未回答', 'forbidden', 'security_invoker', 'identity', 'serial', 'Miseiro', '#413']) {
    assert.ok(doc.includes(phrase), phrase);
  }
  for (const owner of ['| G3 |', '| G4 |', '| G6 |', '| G5 |']) assert.ok(doc.includes(owner), owner);
});

test('the audit is read-only and covers the three API roles, every relation kind and the flags of the rule', () => {
  const sql = read(AUDIT);
  const code = sql.toLowerCase().split('\n').map((l) => l.replace(/--.*$/u, '')).join('\n');
  for (const banned of ['insert ', 'update ', 'delete ', 'grant ', 'revoke ', 'alter ', 'create ', 'drop ', 'truncate ', 'set role', 'copy ']) assert.ok(!code.includes(banned), banned);
  for (const role of ["'anon'", "'authenticated'", "'service_role'"]) assert.ok(code.includes(role), role);
  assert.ok(code.includes("c.relkind in ('r', 'p', 'v', 'm', 'f', 's')"), 'tables, views, matviews, foreign tables, sequences');
  for (const fn of ['has_any_column_privilege', 'has_table_privilege', 'has_sequence_privilege']) assert.ok(code.includes(fn), fn);
  for (const flag of ['DANGEROUS_PRIVILEGE', 'GRANT_WITHOUT_RLS', 'ANON_PRIVILEGE', 'VIEW_PRIVILEGE', 'SEQUENCE_PRIVILEGE', 'REVIEW']) {
    assert.ok(sql.includes(`'${flag}'`), flag);
  }
});

test('the G5 public tables are still revoke-then-grant with RLS in ONE migration (the inventory of section 3)', () => {
  const m = read('supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql');
  for (const t of ['common_accounts', 'service_entitlements']) {
    const create = m.indexOf(`create table public.${t} (`);
    const rls = m.indexOf(`alter table public.${t} enable row level security;`);
    const revoke = m.indexOf(`revoke all on table public.${t} from public, anon, authenticated, service_role;`);
    const grant = m.search(new RegExp(`grant select \\([^)]*\\)\\s+on table public\\.${t} to authenticated;`, 'u'));
    const policy = m.indexOf(`create policy ${t}_select_own`);
    assert.ok(create > 0 && rls > create && revoke > rls && grant > revoke && policy > grant, `${t}: create -> RLS -> revoke -> column grant -> policy`);
    assert.ok(!new RegExp(`grant [^;]* on table public\\.${t} to (anon|service_role)`, 'u').test(m), `${t}: no anon / service_role grant`);
  }
});

test('the PR adds tools and docs only: the named files exist, and no migration or product SQL names the audit', () => {
  for (const path of ['supabase/tests/common_account_data_api_grants_scan.py', 'supabase/tests/common_account_data_api_grants_scan_test.py', AUDIT,
    'supabase/tests/common_account_data_api_grants_pg_run.sh', 'supabase/tests/common_account_data_api_grants_pg_test.ts']) {
    assert.ok(exists(path), path);
    assert.ok(doc.includes(path.split('/').pop()!.replace(/^common_account_data_api_grants_/u, '')) || doc.includes(path), `${path} is named`);
  }
  for (const entry of Deno.readDirSync(new URL('supabase/migrations/', root))) assert.ok(!read(`supabase/migrations/${entry.name}`).includes('data_api_grants'), entry.name);
});

test('quiet: nothing secret-shaped, no project host, no URL, nothing unfinished', () => {
  for (const [name, text] of [['doc', doc], ['audit', read(AUDIT)]] as const) {
    assert.deepEqual(secretFindings(text), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
  assert.ok(!/https?:\/\//u.test(doc), 'no URL in the document');
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z_]+@@/u.test(doc), 'nothing unfinished');
});
