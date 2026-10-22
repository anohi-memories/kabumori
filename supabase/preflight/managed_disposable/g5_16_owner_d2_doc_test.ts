// Offline contract of section 14 of docs/security/supabase-data-api-explicit-grants-20261030.md (G5-16): the owners' status on 2026-10-22 (G4 received
// once, G3 / G6 未回答 and without an assigned inventory TASK), D-2 proven with the verbatim 20261007150000 precondition, the three options with the
// migration order and denial tests for G4's own TASK, what each owner still owes, and no decision taken for another owner. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_16_owner_d2_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const doc = read('docs/security/supabase-data-api-explicit-grants-20261030.md');
const s14 = doc.slice(doc.search(/^## 14\. /mu));
const sub = (a: string, b: string | null) => s14.slice(s14.indexOf(a), b ? s14.indexOf(b) : undefined);

test('section 14 has its subsections and the G5-16 task id', () => {
  for (let n = 1; n <= 5; n += 1) assert.match(s14, new RegExp(`^### 14\\.${n} `, 'mu'), `14.${n}`);
  assert.ok(doc.includes('common-account-g5-data-api-owner-inventory-d2-readonly-gate-20261022'));
});

test('14.1: G4 received once (not counted twice); G3 / G6 未回答 with no assigned inventory TASK; G5 assigns nothing', () => {
  const t = sub('### 14.1', '### 14.2');
  const row = (o: string) => t.split('\n').find((l) => l.startsWith(`| ${o} |`)) ?? '';
  assert.ok(row('G4').includes('received') && row('G4').includes('not counted twice') && row('G4').includes('6328444274'));
  for (const o of ['G3', 'G6']) assert.ok(row(o).includes('未回答') && row(o).includes('2026-10-27') && row(o).includes(`no ${o} inventory TASK exists`), o);
  assert.ok(row('G3').includes('6328926559'));
  assert.ok(t.includes('G5 does not assign another slot\'s TASK'));
  const s5 = doc.slice(doc.search(/^## 5\. /mu), doc.search(/^## 6\. /mu));
  assert.equal((s5.match(/no inventory TASK assigned to this owner yet/gu) ?? []).length, 2, 'section 5 says the same for G3 and G6');
});

test('14.2: D-2 is proven with the verbatim precondition; the three layouts and their outcomes are stated', () => {
  const t = sub('### 14.2', '### 14.3');
  for (const p of ['verbatim', 'POSTONA_ACCOUNTS_PRECONDITION_ACL', '**accepted**', '**refused**', 'both of the app\'s real select lists still work', 'only** ordering dependency']) assert.ok(t.includes(p), p);
  const pg = read('supabase/tests/common_account_d2_column_acl_pg_test.ts');
  assert.ok(pg.includes("['contract=accepted', 'g4_column_proposal=POSTONA_ACCOUNTS_PRECONDITION_ACL', 'r7_violation_allowed=accepted']"));
  assert.ok(pg.includes("text.indexOf('  -- Table and column ACL: the owner; authenticated SELECT')"), 'the block is read from the migration, not retyped');
});

test('14.3 / 14.4: options, order and denial tests are G4\'s; the brands owner stays undecided; production needs approval', () => {
  const t3 = sub('### 14.3', '### 14.4');
  for (const p of ['A. keep the contract', 'B. amend the contract', 'C. move the Vault references', 'not applied', 'applied', 'Codex Sol (high)', 'G4-19 is not interrupted']) assert.ok(t3.includes(p), p);
  const t4 = sub('### 14.4', '### 14.5');
  assert.ok(t4.includes('**undecided**') && t4.includes('explicit approval'));
  assert.ok(!/\b(decided|agreed)\b/iu.test(t4.replace(/undecided/gu, '')), 'no decision is claimed');
});

test('14.5 keeps the rule for new public tables; nothing unfinished', () => {
  const t = sub('### 14.5', null);
  assert.ok(t.includes('R-1..R-14') && t.includes('pg_default_acl'));
  assert.ok(!/https?:\/\//u.test(doc) && !/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z0-9_]+@@/u.test(doc), 'no URL, nothing unfinished');
});
