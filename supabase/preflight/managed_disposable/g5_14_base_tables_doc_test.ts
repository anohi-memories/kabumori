// Offline contract of section 12 of docs/security/supabase-data-api-explicit-grants-20261030.md (G5-14): the four POSTONA base tables -- provenance
// with the empty-database PG17 refusals, the authenticated / service_role Data API paths, the shape each rebuild must reproduce (social_accounts from
// the 20261007150000 contract), an evidence-only owner table (no owner decided by G5), apply order / conflicts, follow-up proposals, the honest 10/30
// link; and the read-only tools it names. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_14_base_tables_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const exists = (path: string) => { try { Deno.statSync(new URL(path, root)); return true; } catch { return false; } };
const doc = read('docs/security/supabase-data-api-explicit-grants-20261030.md');
const s12 = doc.slice(doc.search(/^## 12\. /mu));
const TABLES = ['brands', 'social_accounts', 'social_account_oauth_states', 'published_content_fingerprints'];

test('section 12 has its subsections and names the four tables and the G5-14 task', () => {
  assert.ok(s12.length > 2000);
  for (let n = 1; n <= 7; n += 1) assert.match(s12, new RegExp(`^### 12\\.${n} `, 'mu'), `12.${n}`);
  for (const t of TABLES) assert.ok(s12.includes(`\`public.${t}\``) || s12.includes(`\`${t}\``), t);
  assert.ok(doc.includes('common-account-g5-postona-base-tables-rebuild-risk-readonly-evidence-20261021'));
});

test('provenance: the empty-database refusals are recorded exactly, two of them as EARLIER prerequisites', () => {
  for (const msg of ['PHASE4_PREFLIGHT_MISSING_TABLE:brands', 'relation "public.social_accounts" does not exist', 'SOCIAL_MOBILE_DELETION_PREREQUISITE_MISSING',
    'STAGE3B_PRECONDITION_MISSING', 'EARLIER prerequisite']) assert.ok(s12.includes(msg), msg);
  const pg = read('supabase/tests/common_account_base_tables_pg_test.ts');
  assert.ok(pg.includes('PHASE4_PREFLIGHT_MISSING_TABLE:brands') && pg.includes("'20260928160000_social_mobile_account_deletion_candidate.sql', null"), 'the test claims a name only where the file reaches it');
});

test('the Data API paths separate authenticated from service_role and draw the R-5 / R-6 consequence', () => {
  const s122 = s12.slice(s12.indexOf('### 12.2'), s12.indexOf('### 12.3'));
  for (const f of ['supabase-repository.ts', 'onboarding-repository.ts', 'live_dependencies.ts', 'brand_context.ts', 'ai_lab_vault_token_source.ts', 'ai_lab_brand_post_store.ts']) assert.ok(s122.includes(f), f);
  assert.ok(s122.includes('as `authenticated`') && s122.includes('as `service_role`') && s122.includes('R-5 / R-6'));
});

test('the shape: social_accounts is the 20261007150000 contract; the other three are partial with their unknowns', () => {
  const s123 = s12.slice(s12.indexOf('### 12.3'), s12.indexOf('### 12.4'));
  assert.ok(s123.includes('20261007150000') && s123.includes('14 columns') && s123.includes('RLS on and not forced'));
  for (const c of ['brand_id', 'connection_status', 'vault_access_token_secret_id', 'vault_refresh_token_secret_id', 'verified_at', 'oauth_client_ref']) assert.ok(s123.includes(`\`${c}\``), c);
  assert.ok((s123.match(/\| — \|/gu) ?? []).length >= 3, 'three tables have nothing known exactly');
});

test('the owner table is evidence only: G3 / G4 decide, G5 is a dependant; no decision is recorded', () => {
  const s124 = s12.slice(s12.indexOf('### 12.4'), s12.indexOf('### 12.5'));
  assert.ok(s124.includes('evidence only') && s124.includes('G3 / G4 decide') && s124.includes('G5 is a dependant'));
  assert.ok(!/\b(decided|agreed|confirmed owner)\b/iu.test(s124), 'no decision is claimed');
  for (const t of TABLES) assert.ok(s124.includes(`| \`${t}\` |`), t);
});

test('apply order, follow-ups and the 10/30 link are stated; the tools exist; nothing unfinished', () => {
  assert.ok(s12.includes('out-of-order') && s12.includes('strict no-op'));
  assert.ok(s12.includes('does not touch these existing tables') && s12.includes('42501'));
  for (const p of ['supabase/tests/common_account_base_tables_refs.py', 'supabase/tests/common_account_base_tables_refs_test.py', 'supabase/tests/common_account_base_tables_pg_run.sh',
    'supabase/tests/common_account_base_tables_pg_test.ts']) assert.ok(exists(p), p);
  assert.ok(!/https?:\/\//u.test(doc) && !/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z0-9_]+@@/u.test(doc), 'no URL, nothing unfinished');
});
