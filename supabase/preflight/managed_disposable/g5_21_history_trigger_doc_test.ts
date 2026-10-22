// Offline contract of the G5-21 revision of the owner-epoch candidate (the history's triggers must be exactly its two guards) and of section 13 of
// docs/common-account/brand-owner-epoch.md: the new function and codes exist in the candidate, the rollback, the document, the suite and the
// mutation script; the check runs at read time, before every write and at install / rollback; nothing drops a trigger it did not create; the
// brand_memberships observation is not acted on; the review gate and NO_GO stay. Pure file reads.
//
//   deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_21_history_trigger_doc_test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectRefsIn } from './guard.ts';
import { secretFindings } from './inventory.ts';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const candidate = read('supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql');
const rollback = read('supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch_rollback.sql');
const doc = read('docs/common-account/brand-owner-epoch.md');
const section = doc.slice(doc.indexOf('## 13. G5-21 revision'));
const suite = read('supabase/tests/common_account_owner_epoch_history_trigger_pg_test.ts');
const runner = read('supabase/tests/common_account_owner_epoch_history_trigger_pg_run.sh');
const mutations = read('supabase/tests/common_account_owner_epoch_history_trigger_mutations.py');
const fn = (name: string) => candidate.slice(candidate.indexOf(`create function private.${name}`), candidate.indexOf('end $$;', candidate.indexOf(`create function private.${name}`)) + 7);
const CODES = ['HISTORY_FOREIGN_TRIGGER', 'HISTORY_GUARD_TRIGGER_NOT_EXACT', 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT', 'OWNER_EPOCH_BUMP_NOT_RECORDED',
  'OWNER_EPOCH_PRECONDITION_HISTORY_FOREIGN_TRIGGER', 'OWNER_EPOCH_PRECONDITION_HISTORY_GUARD_TRIGGER_NOT_EXACT', 'OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER',
  'OWNER_EPOCH_ROLLBACK_BUMP_NOT_RECORDED'];

test('the history-trigger check is wired into every read, every write, the install and the rollback', () => {
  assert.ok(candidate.includes('create function private.account_lifecycle_owner_epoch_history_triggers()'));
  assert.ok(candidate.includes("revoke all on function private.account_lifecycle_owner_epoch_history_triggers() from public, anon, authenticated, service_role;"));
  assert.ok(fn('account_lifecycle_brand_owner_epoch_covered()').includes('private.account_lifecycle_owner_epoch_history_triggers() is null'), 'read time');
  for (const name of ['account_lifecycle_owner_epoch_bump(p_brand_id text)', 'account_lifecycle_owner_epoch_truncated()']) {
    const body = fn(name);
    const check = body.indexOf('private.account_lifecycle_owner_epoch_history_triggers() is not null');
    const write = body.search(/\n\s*(insert into|update) private\.account_lifecycle_brand_owner_epochs/u);
    assert.ok(check > 0 && write > check, `${name}: checks before it writes`);
    assert.ok(body.includes("raise exception 'OWNER_EPOCH_BUMP_NOT_RECORDED'"), `${name}: checks the row it wrote`);
  }
  assert.ok(candidate.includes("'private.account_lifecycle_owner_epoch_history_triggers()'::regprocedure] loop"), 'owner-only ACL asserted');
  assert.ok(candidate.includes("raise exception 'OWNER_EPOCH_POSTCONDITION_HISTORY_TRIGGERS'"));
  assert.ok(rollback.includes("raise exception 'OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER'") && rollback.includes('drop function if exists private.account_lifecycle_owner_epoch_history_triggers();'));
});

test('nothing drops a trigger it did not create; internal triggers are not counted; the exact guard shapes', () => {
  for (const [name, text] of [['candidate', candidate], ['rollback', rollback]] as const) {
    const drops = [...text.matchAll(/drop trigger if exists (\w+) on/gu)].map((m) => m[1]);
    for (const d of drops) assert.ok(d.startsWith('account_lifecycle_owner_epoch_'), `${name} drops only its own triggers: ${d}`);
  }
  const body = fn('account_lifecycle_owner_epoch_history_triggers()');
  assert.ok(body.includes('and not t.tgisinternal'));
  assert.ok(body.includes("t.tgtype = 27") && body.includes("t.tgtype = 34"));
  assert.ok(body.includes("pg_catalog.to_regprocedure('private.account_lifecycle_owner_epoch_history_guard()')"));
});

test('the codes appear in the candidate / rollback, the document, the suite and the mutation script; 19 mutants', () => {
  for (const c of CODES) {
    // the two install preconditions are composed: 'OWNER_EPOCH_PRECONDITION_' || the function's code
    const literal = c.startsWith('OWNER_EPOCH_PRECONDITION_') ? c.slice('OWNER_EPOCH_PRECONDITION_'.length) : c;
    assert.ok(candidate.includes(literal) || rollback.includes(literal), `source: ${c}`);
    assert.ok(section.includes(c), `doc: ${c}`);
  }
  assert.ok(/v_code := private\.account_lifecycle_owner_epoch_history_triggers\(\);\n    if v_code is not null then\n      raise exception 'OWNER_EPOCH_PRECONDITION_%', v_code;/u.test(candidate), 'composed precondition');
  for (const c of ['HISTORY_FOREIGN_TRIGGER', 'HISTORY_GUARD_TRIGGER_NOT_EXACT', 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT', 'OWNER_EPOCH_BUMP_NOT_RECORDED',
    'OWNER_EPOCH_PRECONDITION_HISTORY_FOREIGN_TRIGGER', 'OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER', 'OWNER_EPOCH_ROLLBACK_BUMP_NOT_RECORDED']) assert.ok(suite.includes(c), `suite: ${c}`);
  assert.equal((mutations.match(/^    \('/gmu) ?? []).length, 19);
  assert.ok(runner.includes('pinned=32b258ba8b0c2c87068203baf71539a61f139e3d') && suite.includes('FAIL before (PR #446 head 32b258ba)'));
  assert.ok(runner.includes('case "$host" in /private/tmp/*|/tmp/*)') && suite.includes('the G5-21 tests make no network request'));
});

test('section 13 keeps the gates and the boundaries', () => {
  assert.ok(section.length > 0);
  for (const p of ['common-account-g5-owner-epoch-history-stale-trigger-p2-source-fix-20261022', '6332954454', 'not** the independent Codex review',
    'Source candidate only', 'Codex Sol (high)', 'NO_GO', 'No file here drops a trigger it did not create', 'not changed here', 'Nothing is decided or changed here',
    'social_mobile_account_deletion_guard', 'NOT_VERIFIED']) assert.ok(section.includes(p), p);
  assert.ok(!/\bTODO\b|\bFIXME\b|\bTBD\b/u.test(section));
  for (const [name, text] of [['section', section], ['suite', suite], ['runner', runner], ['mutations', mutations], ['rollback', rollback]] as const) {
    assert.deepEqual(secretFindings(text), [], `${name}: nothing secret-shaped`);
    assert.deepEqual(projectRefsIn(text), [], `${name}: no project host`);
  }
});
