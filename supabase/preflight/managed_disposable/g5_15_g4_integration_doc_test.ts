// Offline contract of section 13 of docs/security/supabase-data-api-explicit-grants-20261030.md (G5-15): G4's impact list integrated with G4's facts,
// hypotheses and proposals kept apart and G5's re-check per row; the dangerous ACL assumptions / ordering conflicts (incl. D-2: G4's column-grant
// proposal vs the 20261007150000 precondition); the extended object set with every owner still a candidate or open; G3 / G6 not filled in; and the
// PG17 brand_id proof in the base-tables suite. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_15_g4_integration_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const doc = read('docs/security/supabase-data-api-explicit-grants-20261030.md');
const s13 = doc.slice(doc.search(/^## 13\. /mu));
const sub = (a: string, b: string | null) => s13.slice(s13.indexOf(a), b ? s13.indexOf(b) : undefined);

test('section 13 names its source and the G5-15 task; G3 / G6 are 未着', () => {
  for (const p of ['6317104735', '#420', '8bca839a8aae50169c72eb43393497e38740fd90', 'postona-g4-data-api-20261030-social-account-schema-acl-impact-20261021', '6317113668', '未着', '2026-10-27']) {
    assert.ok(s13.includes(p), p);
  }
  assert.ok(doc.includes('common-account-g5-data-api-g4-impact-integration-owner-boundaries-20261021'));
  for (let n = 1; n <= 4; n += 1) assert.match(s13, new RegExp(`^### 13\\.${n} `, 'mu'), `13.${n}`);
});

test('13.1 keeps G4 facts, hypotheses and proposals apart, each with G5\'s re-check', () => {
  const t = sub('### 13.1', '### 13.2');
  for (const id of ['G4-F1', 'G4-F2', 'G4-F3', 'G4-F4', 'G4-F5', 'G4-F6', 'G4-H1', 'G4-H2', 'G4-H3', 'G4-P']) assert.ok(t.includes(`| ${id} |`), id);
  for (const h of ['G4-H1', 'G4-H3']) assert.match(t.split('\n').find((l) => l.startsWith(`| ${h} |`)) ?? '', /hypothesis/u, h);
  assert.match(t.split('\n').find((l) => l.startsWith('| G4-F4 |')) ?? '', /PHASE4_PREFLIGHT_MISSING_COLUMN:scheduled_posts\.brand_id/u);
});

test('13.2 states the dangerous assumptions, including D-2 (column grants vs the 20261007150000 precondition)', () => {
  const t = sub('### 13.2', '### 13.3');
  for (let n = 1; n <= 6; n += 1) assert.ok(t.includes(`| D-${n} |`), `D-${n}`);
  const d2 = t.split('\n').find((l) => l.startsWith('| D-2 |')) ?? '';
  assert.ok(d2.includes('no column ACL') && d2.includes('POSTONA_ACCOUNTS_PRECONDITION_ACL') && d2.includes('20261007150000'), d2);
  const sql = read('supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql');
  assert.ok(sql.includes("a.attnum > 0 and a.attacl is not null) then\n    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ACL';"), 'the precondition really forbids column ACLs');
});

test('13.3 lists the extended object set; no owner is recorded as decided', () => {
  const t = sub('### 13.3', '### 13.4');
  for (const o of ['`social_accounts`', '`social_account_oauth_states`', '`published_content_fingerprints`', '`brands`', '`brand_settings`', '`daily_content_plans`', '`brand_id` on']) {
    assert.ok(t.includes(`| ${o}`), o);
  }
  for (const line of t.split('\n').filter((l) => /^\| `/u.test(l))) assert.match(line, /candidate|open/u, line);
  assert.ok(!/\b(decided|agreed)\b/iu.test(t));
});

test('13.4 proposals carry their review gates; the PG17 suite holds the brand_id proof; nothing unfinished', () => {
  const t = sub('### 13.4', null);
  assert.ok(t.includes('Codex Sol (high)') && t.includes('explicit approval') && t.includes('NO_GO'));
  const pg = read('supabase/tests/common_account_base_tables_pg_test.ts');
  assert.ok(pg.includes('PHASE4_PREFLIGHT_MISSING_COLUMN:scheduled_posts') && pg.includes('brand_settings and daily_content_plans are created by no migration'));
  assert.ok(!/https?:\/\//u.test(doc) && !/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z0-9_]+@@/u.test(doc), 'no URL, nothing unfinished');
});
