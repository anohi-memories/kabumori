// Offline contract of docs/common-account/g5-19-brand-memberships-column-acl-answers.md: all six questions answered, the evidence labels kept
// apart, the pinned commits match the PG17 runner, the decision stays with the user, production stays NO_GO, and the PR #303 candidate this
// document reasons about still has the table-level-only exposure check (the gap the answers describe). Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_19_bm_column_acl_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const doc = read('docs/common-account/g5-19-brand-memberships-column-acl-answers.md');
const runner = read('supabase/tests/common_account_bm_column_acl_pg_run.sh');
const suite = read('supabase/tests/common_account_bm_column_acl_pg_test.ts');
const candidate = read('supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql');

test('the document answers Q1..Q6 and has its sections', () => {
  for (let n = 1; n <= 8; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (let q = 1; q <= 6; q += 1) {
    assert.ok(doc.includes(`| Q${q} |`), `Q${q} in the table`);
    assert.match(doc, new RegExp(`^### Q${q} — `, 'mu'), `Q${q} in detail`);
  }
  for (const label of ['**[S]**', '**[D]**', '**[P]**', '**[U]**']) assert.ok(doc.includes(label), label);
});

test('the pinned commits and identifiers match the runner and the Issue', () => {
  const sha = runner.match(/^g3_sha=([0-9a-f]{40})$/mu)?.[1];
  assert.ok(sha && doc.includes(sha), 'G3 PR #370 head pinned in both');
  for (const p of ['common-account-g5-brand-memberships-system-column-acl-six-questions-design-20261022', '6330443480', '472e9e8df7c7da60756f26bcffb722718f70cc0f',
    '6329700338', '#438', '#303', 'BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST', '2026-10-27', '6331091808']) assert.ok(doc.includes(p), p);
});

test('decisions stay with the user; production NO_GO; G5 takes on no G3 SQL; managed facts marked unverified', () => {
  for (const p of ['NO_GO', 'not a decision', 'does not take on G3\'s SQL', 'cannot accept it on anyone\'s behalf', 'Codex Sol (high)', 'NOT_VERIFIED',
    'model only', 'not a candidate']) assert.ok(doc.includes(p), p);
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b|https?:\/\//u.test(doc), 'nothing unfinished, no URL');
  for (const [name, text] of [['doc', doc], ['runner', runner], ['suite', suite]] as const) {
    assert.deepEqual(secretFindings(text), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
});

// flipped by G5-20 (the Q2 TASK): the gap G5-19 described is closed in the candidate, and the suite now asserts the finding
test('the gap described is closed by the G5-20 candidate: L-1 sees column and system-column ACLs; the suite asserts the findings', () => {
  const body = candidate.slice(candidate.indexOf('create function private.account_lifecycle_owner_epoch_exposure()'), candidate.indexOf('revoke all on function private.account_lifecycle_owner_epoch_exposure()'));
  assert.ok(body.length > 0);
  assert.ok(body.includes("has_table_privilege(x.role_oid, 'public.brand_memberships', 'REFERENCES')"));
  assert.ok(body.includes("has_any_column_privilege(x.role_oid, 'public.brand_memberships', 'REFERENCES')") && body.includes('aclexplode(a.attacl)'), 'column / system-column predicates');
  assert.ok(suite.includes('the column grant is seen') && !suite.includes('the column grant is not seen'), 'the suite asserts the finding');
});

test('the PG17 suite stays local: socket-only guard, no network, G3 file read from the pinned commit, never copied', () => {
  assert.ok(runner.includes('case "$host" in /private/tmp/*|/tmp/*)'));
  assert.ok(runner.includes('git -C "$repo" show "$g3_sha:$g3_path"'));
  assert.ok(suite.includes('the G5-19 tests make no network request'));
});
