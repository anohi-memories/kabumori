// Offline contract of the G5-13 integration in docs/security/supabase-data-api-explicit-grants-20261030.md: section 4 separates CONFIRMED facts
// (C-1..C-7) from ESTIMATES (E-1..E-5); the owners' table records only what arrived (G3 / G4 / G6 still 未回答, due 2026-10-27) and never a filled-in
// answer; the next-TASK proposals and the dated risk draft exist; the scanner reports objects created by no migration and does not count
// `grant option` text as a GRANT. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_13_data_api_integration_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const doc = read('docs/security/supabase-data-api-explicit-grants-20261030.md');
const section = (n: number) => {
  const start = doc.search(new RegExp(`^## ${n}\\. `, 'mu'));
  const next = doc.slice(start + 4).search(/^## \d+\. /mu);
  return next < 0 ? doc.slice(start) : doc.slice(start, start + 4 + next);
};

test('the document keeps sections 1..11 and the G5-13 task id', () => {
  for (let n = 1; n <= 11; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  assert.ok(doc.includes('common-account-g5-data-api-cross-slot-inventory-integration-20261021'));
});

test('section 4 separates confirmed facts from estimates; the four base tables are named as confirmed', () => {
  const s4 = section(4);
  const confirmed = s4.slice(s4.indexOf('### 4.1 Confirmed'), s4.indexOf('### 4.2 Estimated'));
  const estimated = s4.slice(s4.indexOf('### 4.2 Estimated'));
  assert.ok(confirmed.length > 0 && estimated.length > 0);
  for (let n = 1; n <= 7; n += 1) assert.ok(confirmed.includes(`| C-${n} `), `C-${n} under confirmed`);
  for (let n = 1; n <= 5; n += 1) assert.ok(estimated.includes(`| E-${n} `), `E-${n} under estimated`);
  for (const t of ['public.brands', 'public.social_accounts', 'public.social_account_oauth_states', 'public.published_content_fingerprints']) assert.ok(confirmed.includes(t), t);
  assert.ok(!/\| C-\d /u.test(estimated) && !/\| E-\d /u.test(confirmed), 'no row in the wrong half');
  assert.ok(estimated.includes('NOT_VERIFIED') || s4.includes('NOT_VERIFIED'));
});

test('the owners table records only what arrived: G3 / G4 / G6 未回答 with the 2026-10-27 date; nothing filled in for them', () => {
  const s5 = section(5);
  for (const owner of ['G3', 'G4', 'G6']) {
    const row = s5.split('\n').find((l) => l.startsWith(`| ${owner} |`)) ?? '';
    assert.ok(row.includes('未回答') && row.includes('2026-10-27') && row.includes('not yet'), `${owner}: ${row}`);
    assert.ok(!/done|no impact/iu.test(row), `${owner}: no answer is invented`);
  }
  for (const id of ['6315180962', '6315181585', '6315182189']) assert.ok(s5.includes(id), id);
});

test('the proposals, the integration log and the dated risk draft exist; production stays NO_GO', () => {
  assert.ok(section(9).includes('no impact list from G3, G4 or G6 yet'));
  const s10 = section(10);
  for (const owner of ['G3 / G4 (POSTONA)', '| G6 |', 'Kabumori report / AI Lab / MIC owners', '| G5 |']) assert.ok(s10.includes(owner), owner);
  assert.ok(s10.includes('Codex Sol (high)') && s10.includes('approval'));
  const s11 = section(11);
  for (const phrase of ['2026-10-21 JST', '2026-10-27', '10/30', '42501', 'NOT_VERIFIED']) assert.ok(s11.includes(phrase), phrase);
  assert.ok(doc.includes('NO_GO'));
});

test('the scanner reports objects created by no migration and ignores `grant option` text', () => {
  const scan = read('supabase/tests/common_account_data_api_grants_scan.py');
  assert.ok(scan.includes("'not_created_by_any_migration'"));
  assert.ok(scan.includes('(?!option\\b)'));
  const t = read('supabase/tests/common_account_data_api_grants_scan_test.py');
  assert.ok(t.includes("SCAN_TEST_PASS 10 checks") && t.includes("['legacy_base', 'legacy_other']"));
});

test('quiet: no URL and nothing unfinished', () => {
  assert.ok(!/https?:\/\//u.test(doc));
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z0-9_]+@@/u.test(doc), 'nothing unfinished');
});
