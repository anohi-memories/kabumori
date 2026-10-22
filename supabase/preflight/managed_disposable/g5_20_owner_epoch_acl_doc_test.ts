// Offline contract of the G5-20 revision of the owner-epoch candidate (supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql)
// and of section 12 of docs/common-account/brand-owner-epoch.md: the three new exposure codes exist in the candidate, the document, the deny-net
// suite and the mutation script; the earlier codes keep their order; the history check covers every privilege; the document keeps the review gate,
// NO_GO and the G3 boundary. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_20_owner_epoch_acl_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const candidate = read('supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql');
const doc = read('docs/common-account/brand-owner-epoch.md');
const section = doc.slice(doc.indexOf('## 12. G5-20 revision'));
const suite = read('supabase/tests/common_account_owner_epoch_acl_pg_test.ts');
const runner = read('supabase/tests/common_account_owner_epoch_acl_pg_run.sh');
const mutations = read('supabase/tests/common_account_owner_epoch_acl_mutations.py');
const exposure = candidate.slice(candidate.indexOf('create function private.account_lifecycle_owner_epoch_exposure()'),
  candidate.indexOf('revoke all on function private.account_lifecycle_owner_epoch_exposure()'));
const NEW = ['API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN', 'API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL', 'API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY'];
const OLD = ['API_ROLE_CAN_BECOME_SUPERUSER', 'API_ROLE_CAN_BECOME_OWNER', 'API_ROLE_CAN_SKIP_TRIGGERS', 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS', "'API_ROLE_CAN_WRITE_MEMBERSHIPS'"];

test('the exposure check has the three new codes after the earlier ones, in order', () => {
  assert.ok(exposure.length > 0);
  const order = [...OLD, ...NEW.map((c) => `'${c}'`)].map((c) => exposure.indexOf(`then ${c.startsWith("'") ? c : `'${c}'`}`));
  for (const [i, at] of order.entries()) assert.ok(at > 0, `code ${i} present`);
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i] > order[i - 1], `code ${i} after code ${i - 1}`);
});

test('the new rules: column write paths, the empty column-ACL allowlist incl. system columns and PUBLIC, every privilege on the history', () => {
  for (const p of ['INSERT', 'UPDATE', 'REFERENCES']) assert.ok(exposure.includes(`has_any_column_privilege(x.role_oid, 'public.brand_memberships', '${p}')`), p);
  assert.ok(exposure.includes("where a.attrelid = 'public.brand_memberships'::regclass and a.attacl is not null"), 'every column, system columns included (no attnum filter)');
  assert.ok(!/attnum\s*>\s*0/u.test(exposure), 'no attnum filter');
  assert.equal((exposure.match(/e\.grantee = 0 or e\.grantee in \(select x\.role_oid from reach x\)/gu) ?? []).length, 2, 'PUBLIC and the reach, on both tables');
  assert.ok(exposure.includes("'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'"), 'every table privilege of the history');
  assert.ok(exposure.includes("pg_catalog.to_regclass('private.account_lifecycle_brand_owner_epochs')"), 'the history may not exist yet');
  assert.ok(candidate.includes('G5-20 REVISION (2026-10-22, Issue #320 task 20'), 'the header says what changed');
});

test('the deny-net suite, its runner and the mutation script cover the new codes; nothing leaves the local socket', () => {
  for (const c of NEW) {
    assert.ok(suite.includes(c), `suite: ${c}`);
    assert.ok(section.includes(c), `doc: ${c}`);
  }
  assert.ok(runner.includes('case "$host" in /private/tmp/*|/tmp/*)') && suite.includes('the G5-20 tests make no network request'));
  assert.ok(mutations.includes("RUNNER = 'supabase/tests/common_account_owner_epoch_acl_pg_run.sh'"));
  assert.equal((mutations.match(/^    \('/gmu) ?? []).length, 16, '16 mutants');
});

test('section 12 keeps the gates: source only, Sol (high) before it counts, NO_GO, G3 race and A1 / A2 / B not decided', () => {
  assert.ok(section.length > 0);
  for (const p of ['common-account-g5-l1-brand-memberships-column-acl-exposure-source-candidate-20261022', 'Source candidate only', 'Codex Sol (high)', 'NO_GO',
    'not** part of this', 'not treated as decided', 'NOT_VERIFIED', 'MAINTAIN on `public.brand_memberships`', 'every read', '#441']) assert.ok(section.includes(p), p);
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b/u.test(section));
  for (const [name, text] of [['section', section], ['suite', suite], ['runner', runner], ['mutations', mutations]] as const) {
    assert.deepEqual(secretFindings(text), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
});
