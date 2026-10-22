// Offline contract of docs/common-account/g5-17-threads-owner-transport-r0-r1.md: the three answers to G4 (Issue #320 comment 6329602523, PR #428),
// the transport contract T-1..T-7, the proofs table, the follow-ups with their review gates, the NOT_VERIFIED list and the Data API note; the
// function names / features it cites exist in G5's SQL; no G5 SQL is changed by this task. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_17_owner_transport_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const doc = read('docs/common-account/g5-17-threads-owner-transport-r0-r1.md');
const r1 = read('supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql');
const r0 = read('supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql');
const t13 = read('supabase/migrations/20261010051938_common_account_service_write_guard.sql');

test('the document has its sections, the source of the question and the task id', () => {
  for (let n = 1; n <= 7; n += 1) assert.match(doc, new RegExp(`^## ${n}\\. `, 'mu'), `section ${n}`);
  for (const p of ['common-account-g5-g4-threads-r0-r1-owner-transport-interface-readonly-20261022', '6329602523', '#428', 'c305152dcc355c9f6fd5d5699b15c03ec36cf67b',
    'postona-g4-pr124-pr405-complete-owner-only-activation-contract-design-20261022', 'NO_GO', 'K5']) assert.ok(doc.includes(p), p);
});

test('the three answers are there and Q3 states its condition', () => {
  for (const q of ['| Q1 |', '| Q2 |', '| Q3 |']) assert.ok(doc.includes(q), q);
  const q3 = doc.split('\n').find((l) => l.startsWith('| Q3 |')) ?? '';
  assert.ok(q3.includes('provided the transport\'s database role is the role that owns R0 / R1 / T13') && q3.includes('[U]'));
  const q2 = doc.split('\n').find((l) => l.startsWith('| Q2 |')) ?? '';
  assert.ok(q2.includes('first statement of the same begin transaction') && q2.includes('no authenticated grant needed'));
});

test('the cited names and features exist in G5\'s SQL', () => {
  assert.ok(r1.includes('create function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text)'));
  assert.ok(/p_feature not in \([^)]*'threads_connect'/u.test(r1), 'R1 answers threads_connect');
  assert.ok(r1.includes("'owner_epoch', 'g5oe:' || f_epoch::text || ':' || f_lifecycle::text"), 'the token shape');
  assert.ok(r0.includes('create function public.common_account_bootstrap_verdict(p_app text, p_feature text)') && r0.includes("'threads_connect_bootstrap'"));
  assert.ok(t13.includes('create function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text)'));
  assert.ok(t13.includes('if v_legacy_sub is not null then'), 'T13 reads the per-claim settings first (T-3)');
});

test('the transport contract T-1..T-7, the proofs, and the follow-ups with their gates', () => {
  for (let n = 1; n <= 7; n += 1) assert.ok(doc.includes(`| T-${n} |`), `T-${n}`);
  for (const p of ['SERVICE_GENERATION_CHANGED', 'OWN_WORKSPACE_CONFLICT', 'WORKSPACE_OWNER_UNKNOWN', 'SERVICE_NOT_ACTIVE', 'AUTH_REQUIRED']) assert.ok(doc.includes(p), p);
  const s4 = doc.slice(doc.indexOf('## 4.'), doc.indexOf('## 5.'));
  assert.ok(s4.includes('Codex Sol (high)') && s4.includes('no other slot\'s TASK is changed'));
  const pg = read('supabase/tests/common_account_owner_transport_pg_test.ts');
  for (const name of ['Q1 + Q2:', 'Q1: the pair is stable to COMMIT', 'refusals inside the transaction leave nothing', 'Q3: the owner runs R0 / R1 / T13', 'claims the transport must set']) {
    assert.ok(pg.includes(`test_('${name}`), name);
  }
});

test('NOT_VERIFIED and the Data API note; nothing unfinished', () => {
  assert.ok(doc.includes('## 5. NOT_VERIFIED') && doc.includes('G3 and G6 still have no assigned Data API inventory TASK'));
  assert.ok(!/https?:\/\//u.test(doc) && !/\bTODO\b|\bFIXME\b|\bTBD\b|@@[A-Z0-9_]+@@/u.test(doc), 'no URL, nothing unfinished');
});
