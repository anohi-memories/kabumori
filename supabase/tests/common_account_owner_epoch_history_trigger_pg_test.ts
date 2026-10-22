// G5-21: a trigger left on the owner-epoch history (H3 proxy review R1 on PR #446). H3's Q0-Q4 FAIL on PR #446's head (the "before" database, when the
// runner could read it) and are refused on this branch's candidate ("after"); then the guard variants, the races a pre-check cannot see, the
// re-install, the internal (foreign-key) triggers that must not count, and -- unchanged here -- what a stale trigger on public.brand_memberships still
// does. Needs CAL_E2E=1 and the runner's environment. A local fact about the candidate SQL; nothing about managed / production.
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const env = (name: string) => Deno.env.get(name) ?? '';
const [owner, mid, superUser] = ['HT_OWNER', 'HT_MID', 'PGSUPER'].map(env);
const AFTER = env('HT_DB_AFTER');
const BEFORE = env('HT_DB_BEFORE');
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-21 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;
const testBefore = enabled && BEFORE !== '' ? test : test.skip;

type Result = { ok: boolean; out: string; error: string };
const args = (db: string, user: string, extra: string[]) => ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-d', db, '-U', user, ...extra];
async function run(db: string, extra: string[], user = owner): Promise<Result> {
  const out = await new Deno.Command('psql', { args: args(db, user, extra), stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const psql = (db: string, statement: string, user = owner) => run(db, ['-c', statement], user);
async function sql(db: string, statement: string, user = owner): Promise<string> {
  const r = await psql(db, statement, user);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const asSuper = (db: string, statement: string) => sql(db, statement, superUser);
async function refused(db: string, statement: string, code: string, user = owner) {
  const r = await psql(db, statement, user);
  assert.ok(!r.ok && r.error.includes(code), `expected ${code}: ${statement}\n${r.error}`);
}
const spawn = (db: string, statement: string, user = owner) =>
  new Deno.Command('psql', { args: args(db, user, ['-c', statement]), stdout: 'piped', stderr: 'piped' }).spawn();
async function waitSleeping(db: string, marker: string) {
  for (let i = 0; i < 200; i += 1) {
    if ((await asSuper(db, `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('${marker}' in query) > 0`)) === '1') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${marker} never slept`);
}

const T = 'public.brand_memberships';
const H = 'private.account_lifecycle_brand_owner_epochs';
const GUARD = 'private.account_lifecycle_owner_epoch_history_guard()';
const ROW = 'account_lifecycle_owner_epoch_history_row';
const TRUNC = 'account_lifecycle_owner_epoch_history_truncate';
const P = 'b_p';
const UP = '00000000-0000-4000-8000-0000000000c1';
const exposure = (db: string) => sql(db, `select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE')`);
const historyCode = (db: string) => sql(db, `select coalesce(private.account_lifecycle_owner_epoch_history_triggers(), 'EXACT')`);
const epoch = (db: string, brand = P) => sql(db, `select coalesce(private.account_lifecycle_brand_owner_epoch('${brand}')::text, 'NULL')`);
const restoreGuards = `drop trigger if exists ${ROW} on ${H}; drop trigger if exists ${TRUNC} on ${H};
  create trigger ${ROW} before update or delete on ${H} for each row execute function ${GUARD};
  create trigger ${TRUNC} before truncate on ${H} for each statement execute function ${GUARD}`;

// Q0..Q2 of H3's report: a reached role makes a BEFORE UPDATE trigger on the history while it holds TRIGGER, then everything is revoked
async function q0to2(db: string) {
  await sql(db, `insert into auth.users values ('${UP}'); insert into public.brands (id) values ('${P}'); insert into ${T} (brand_id, user_id, role) values ('${P}', '${UP}', 'owner')`);
  assert.equal(await exposure(db), 'NONE', 'Q0');
  assert.equal(await epoch(db), '1', 'Q0');
  await asSuper(db, `grant ${mid} to authenticated`);
  await sql(db, `grant trigger on ${H} to ${mid}`);
  assert.equal(await exposure(db), 'API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY', 'Q1');
  assert.equal(await epoch(db), 'NULL', 'Q1');
  await asSuper(db, `set role ${mid}; create table att.log (who text); grant insert on att.log to public;
    create function att.freeze() returns trigger language plpgsql as $f$ begin insert into att.log values (current_user); new.epoch := old.epoch; return new; end $f$;
    create trigger zz_freeze before update on ${H} for each row execute function att.freeze()`);
  await sql(db, `revoke trigger on ${H} from ${mid}`);
  await asSuper(db, `revoke ${mid} from authenticated`);
  assert.equal(await exposure(db), 'NONE', 'Q2: every privilege is gone');
}
const ownerAdminOwner = `update ${T} set role = 'admin' where brand_id = '${P}'; update ${T} set role = 'owner' where brand_id = '${P}'`;
const dropFreeze = `drop trigger zz_freeze on ${H}; drop function att.freeze(); drop table att.log`;

testBefore('FAIL before (PR #446 head 32b258ba): the left trigger is unseen, holds the number still, runs as the owner, and survives rollback + re-install', async () => {
  await q0to2(BEFORE);
  assert.equal(await epoch(BEFORE), '1', 'Q2: the getter answers again');
  await sql(BEFORE, ownerAdminOwner);
  assert.equal(await epoch(BEFORE), '1', 'Q3: owner -> admin -> owner left the number at 1 (should be 3)');
  assert.equal(await asSuper(BEFORE, 'select string_agg(distinct who, \',\') from att.log'), owner, 'Q3: it ran as the owner');
  let r = await run(BEFORE, ['-f', env('HT_BEFORE_ROLLBACK')]);
  assert.ok(r.ok, r.error);
  r = await run(BEFORE, ['-f', env('HT_BEFORE_CANDIDATE')]);
  assert.ok(r.ok, `Q4: the re-install succeeded\n${r.error}`);
  assert.equal(await exposure(BEFORE), 'NONE', 'Q4');
  assert.equal(await epoch(BEFORE), '1', 'Q4: even the re-start fence was held still');
});

test_('PASS after: the left trigger makes the getter refuse, refuses the owner write before any foreign code runs, and refuses the rollback', async () => {
  await q0to2(AFTER);
  assert.equal(await historyCode(AFTER), 'HISTORY_FOREIGN_TRIGGER', 'Q2');
  assert.equal(await sql(AFTER, 'select private.account_lifecycle_brand_owner_epoch_covered()'), 'f');
  assert.equal(await epoch(AFTER), 'NULL', 'Q2: the getter refuses');
  await refused(AFTER, `select private.account_lifecycle_brand_owner_epoch_resync('${P}')`, 'OWNER_EPOCH_COVERAGE_BROKEN');
  await refused(AFTER, ownerAdminOwner, 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT');
  assert.equal(await sql(AFTER, `select role from ${T} where brand_id = '${P}'`), 'owner', 'Q3: the owner change was refused as a whole');
  assert.equal(await asSuper(AFTER, 'select count(*) from att.log'), '0', 'Q3: the foreign code never ran');
  const rb = await run(AFTER, ['-f', env('HT_ROLLBACK')]);
  assert.ok(!rb.ok && rb.error.includes('OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER'), `Q4: the rollback refuses\n${rb.error}`);
  assert.equal(await sql(AFTER, `select (to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is not null)::text`), 'true', 'Q4: nothing was rolled back');
  assert.ok(await sql(AFTER, `select count(*) from pg_trigger where tgrelid = '${H}'::regclass and tgname = 'zz_freeze'`) === '1', 'the foreign trigger is not dropped by the file');
  // the owner's decision (here the test world) removes it; no owner change happened meanwhile, so 1 is still right and the next ones move
  await asSuper(AFTER, dropFreeze);
  assert.equal(await historyCode(AFTER), 'EXACT');
  assert.equal(await epoch(AFTER), '1');
  await sql(AFTER, ownerAdminOwner);
  assert.equal(await epoch(AFTER), '3', 'owner -> admin -> owner moves the number twice');
});

test_('guard variants: a disabled, re-timed, re-evented, conditioned, column-listed, argument, constraint, other-function or altered-function guard is not exact', async () => {
  const before = await epoch(AFTER);
  const cases: Array<[string, string, string]> = [
    ['row guard disabled', `alter table ${H} disable trigger ${ROW}`, ''],
    ['truncate guard disabled', `alter table ${H} disable trigger ${TRUNC}`, ''],
    ['truncate guard dropped', `drop trigger ${TRUNC} on ${H}`, ''],
    ['row guard BEFORE UPDATE only', `drop trigger ${ROW} on ${H}; create trigger ${ROW} before update on ${H} for each row execute function ${GUARD}`, ''],
    ['row guard AFTER', `drop trigger ${ROW} on ${H}; create trigger ${ROW} after update or delete on ${H} for each row execute function ${GUARD}`, ''],
    ['row guard with WHEN', `drop trigger ${ROW} on ${H}; create trigger ${ROW} before update or delete on ${H} for each row when (old.epoch > 0) execute function ${GUARD}`, ''],
    ['row guard with INSERT added (extra event bits)', `drop trigger ${ROW} on ${H}; create trigger ${ROW} before insert or update or delete on ${H} for each row execute function ${GUARD}`, ''],
    ['row guard UPDATE OF epoch',`drop trigger ${ROW} on ${H}; create trigger ${ROW} before update of epoch or delete on ${H} for each row execute function ${GUARD}`, ''],
    ['row guard with an argument', `drop trigger ${ROW} on ${H}; create trigger ${ROW} before update or delete on ${H} for each row execute function ${GUARD.replace('()', '')}('x')`, ''],
    ['truncate guard AFTER', `drop trigger ${TRUNC} on ${H}; create trigger ${TRUNC} after truncate on ${H} for each statement execute function ${GUARD}`, ''],
    ['row guard as a constraint trigger', `drop trigger ${ROW} on ${H}; create constraint trigger ${ROW} after update or delete on ${H} for each row execute function ${GUARD}`, ''],
    ['row guard with another function', `create function private.g521_other_guard() returns trigger language plpgsql security definer set search_path = '' as $f$ begin return new; end $f$;
      drop trigger ${ROW} on ${H}; create trigger ${ROW} before update or delete on ${H} for each row execute function private.g521_other_guard()`, 'drop function private.g521_other_guard()'],
    ['guard function not SECURITY DEFINER', `alter function ${GUARD} security invoker`, `alter function ${GUARD} security definer`],
    ['guard function search_path changed', `alter function ${GUARD} set search_path = public`, `alter function ${GUARD} set search_path = ''`],
  ];
  for (const [label, change, undo] of cases) {
    await sql(AFTER, change);
    assert.equal(await historyCode(AFTER), 'HISTORY_GUARD_TRIGGER_NOT_EXACT', label);
    assert.equal(await epoch(AFTER), 'NULL', `${label}: the getter refuses`);
    await refused(AFTER, `update ${T} set role = 'admin' where brand_id = '${P}'`, 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT');
    await sql(AFTER, `${restoreGuards}${undo ? `; ${undo}` : ''}`);
    assert.equal(await historyCode(AFTER), 'EXACT', `${label}: restored`);
  }
  // the guard function owned by another role (only a superuser can hand it over)
  await asSuper(AFTER, `alter function ${GUARD} owner to ${mid}`);
  assert.equal(await historyCode(AFTER), 'HISTORY_GUARD_TRIGGER_NOT_EXACT', 'guard function owner');
  await asSuper(AFTER, `alter function ${GUARD} owner to ${owner}`);
  // a trigger with any other name is foreign, even the owner's own and even a harmless one
  await sql(AFTER, `create trigger ${ROW}_extra before update on ${H} for each row execute function ${GUARD}`);
  assert.equal(await historyCode(AFTER), 'HISTORY_FOREIGN_TRIGGER');
  await sql(AFTER, `drop trigger ${ROW}_extra on ${H}`);
  assert.equal(await historyCode(AFTER), 'EXACT');
  assert.equal(await epoch(AFTER), before, 'nothing moved while it was refused');
});

test_('internal (foreign-key) triggers are not counted; a truncate is refused while a foreign trigger is there', async () => {
  await sql(AFTER, `create table private.g521_ref (brand_id text references ${H} (brand_id))`);
  assert.ok(Number(await sql(AFTER, `select count(*) from pg_trigger where tgrelid = '${H}'::regclass and tgisinternal`)) > 0, 'the FK made internal triggers');
  assert.equal(await historyCode(AFTER), 'EXACT');
  assert.notEqual(await epoch(AFTER), 'NULL');
  await sql(AFTER, 'drop table private.g521_ref');
  await asSuper(AFTER, `create function att.noop() returns trigger language plpgsql as $f$ begin return null; end $f$;
    create trigger zz_noop after update on ${H} for each statement execute function att.noop()`);
  await refused(AFTER, `truncate ${T}`, 'OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT');
  assert.equal(await sql(AFTER, `select count(*) from ${T}`), '1', 'nothing was truncated');
  await asSuper(AFTER, `drop trigger zz_noop on ${H}; drop function att.noop()`);
});

test_('races the pre-check cannot see: a trigger committed while the bump (or the rollback) waits for the history lock is caught by the written-row check', async () => {
  const before = await epoch(AFTER);
  // update path: a BEFORE UPDATE trigger that holds the number still
  let holder = spawn(AFTER, `begin; create function att.freeze2() returns trigger language plpgsql as $f$ begin new.epoch := old.epoch; return new; end $f$;
    create trigger zz_freeze2 before update on ${H} for each row execute function att.freeze2(); select pg_sleep(2) /* g521-race-a */; commit`, superUser);
  await waitSleeping(AFTER, 'g521-race-a');
  await refused(AFTER, `update ${T} set role = 'admin' where brand_id = '${P}'`, 'OWNER_EPOCH_BUMP_NOT_RECORDED');
  assert.ok((await holder.output()).success);
  await asSuper(AFTER, 'drop trigger zz_freeze2 on private.account_lifecycle_brand_owner_epochs; drop function att.freeze2()');
  assert.equal(await epoch(AFTER), before, 'the owner change was refused as a whole');
  // insert path: a BEFORE INSERT trigger that drops the new workspace's row
  holder = spawn(AFTER, `begin; create function att.skip() returns trigger language plpgsql as $f$ begin return null; end $f$;
    create trigger zz_skip before insert on ${H} for each row execute function att.skip(); select pg_sleep(2) /* g521-race-b */; commit`, superUser);
  await waitSleeping(AFTER, 'g521-race-b');
  await refused(AFTER, `insert into public.brands (id) values ('b_q'); insert into ${T} (brand_id, user_id, role) values ('b_q', '${UP}', 'owner')`, 'OWNER_EPOCH_BUMP_NOT_RECORDED');
  assert.ok((await holder.output()).success);
  await asSuper(AFTER, 'drop trigger zz_skip on private.account_lifecycle_brand_owner_epochs; drop function att.skip()');
  assert.equal(await sql(AFTER, `select count(*) from public.brands where id = 'b_q'`), '0');
  // the rollback file's own update
  holder = spawn(AFTER, `begin; create function att.freeze3() returns trigger language plpgsql as $f$ begin new.epoch := old.epoch; return new; end $f$;
    create trigger zz_freeze3 before update on ${H} for each row execute function att.freeze3(); select pg_sleep(2) /* g521-race-c */; commit`, superUser);
  await waitSleeping(AFTER, 'g521-race-c');
  const rb = await run(AFTER, ['-f', env('HT_ROLLBACK')]);
  assert.ok(!rb.ok && rb.error.includes('OWNER_EPOCH_ROLLBACK_BUMP_NOT_RECORDED'), rb.error);
  assert.ok((await holder.output()).success);
  await asSuper(AFTER, 'drop trigger zz_freeze3 on private.account_lifecycle_brand_owner_epochs; drop function att.freeze3()');
  assert.equal(await epoch(AFTER), before, 'installed and unchanged');
});

test_('re-install over a kept history: a left foreign trigger or an inexact guard refuses it and leaves nothing; once clean it moves every number on', async () => {
  const e = BigInt(await epoch(AFTER));
  let r = await run(AFTER, ['-f', env('HT_ROLLBACK')]);
  assert.ok(r.ok, r.error);
  // a reached role makes a harmless-looking trigger while uninstalled, then loses every privilege
  await asSuper(AFTER, `grant ${mid} to authenticated`);
  await sql(AFTER, `grant trigger on ${H} to ${mid}`);
  await asSuper(AFTER, `set role ${mid}; create table att.log2 (who text); grant insert on att.log2 to public;
    create function att.spy2() returns trigger language plpgsql as $f$ begin insert into att.log2 values (current_user); return null; end $f$;
    create trigger zz_spy2 after insert or update on ${H} for each row execute function att.spy2()`);
  await sql(AFTER, `revoke trigger on ${H} from ${mid}`);
  await asSuper(AFTER, `revoke ${mid} from authenticated`);
  r = await run(AFTER, ['-f', env('HT_CANDIDATE')]);
  assert.ok(!r.ok && r.error.includes('OWNER_EPOCH_PRECONDITION_HISTORY_FOREIGN_TRIGGER'), r.error);
  assert.equal(await sql(AFTER, `select (to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null and to_regprocedure('private.account_lifecycle_owner_epoch_history_triggers()') is null)::text`), 'true', 'nothing left');
  assert.equal(await asSuper(AFTER, 'select count(*) from att.log2'), '0', 'the fence never ran the foreign code');
  await asSuper(AFTER, `drop trigger zz_spy2 on ${H}; drop function att.spy2(); drop table att.log2`);
  // an inexact guard (here: disabled while uninstalled) refuses too
  await sql(AFTER, `alter table ${H} disable trigger ${ROW}`);
  r = await run(AFTER, ['-f', env('HT_CANDIDATE')]);
  assert.ok(!r.ok && r.error.includes('OWNER_EPOCH_PRECONDITION_HISTORY_GUARD_TRIGGER_NOT_EXACT'), r.error);
  await sql(AFTER, `alter table ${H} enable trigger ${ROW}`);
  r = await run(AFTER, ['-f', env('HT_CANDIDATE')]);
  assert.ok(r.ok, r.error);
  assert.equal(BigInt(await epoch(AFTER)), e + 2n, 'the rollback and the re-install each moved the number once');
  assert.equal(await historyCode(AFTER), 'EXACT');
});

test_('observation, NOT changed here (PR #303 scope): a stale foreign trigger on brand_memberships keeps the coverage and the numbers right, but runs as the writer', async () => {
  const e = BigInt(await epoch(AFTER));
  await asSuper(AFTER, `grant ${mid} to authenticated`);
  await sql(AFTER, `grant trigger on ${T} to ${mid}`);
  assert.equal(await exposure(AFTER), 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS');
  await asSuper(AFTER, `set role ${mid}; create table att.log3 (who text); grant insert on att.log3 to public;
    create function att.spy3() returns trigger language plpgsql as $f$ begin insert into att.log3 values (current_user); return new; end $f$;
    create trigger aa_spy3 before update on ${T} for each row execute function att.spy3()`);
  await sql(AFTER, `revoke trigger on ${T} from ${mid}`);
  await asSuper(AFTER, `revoke ${mid} from authenticated`);
  assert.equal(await exposure(AFTER), 'NONE');
  assert.equal(await sql(AFTER, 'select private.account_lifecycle_brand_owner_epoch_covered()'), 't', 'still covered (only the two epoch triggers are matched there)');
  await sql(AFTER, ownerAdminOwner);
  assert.equal(BigInt(await epoch(AFTER)), e + 2n, 'the numbers stay right (the AFTER trigger sees the final row)');
  assert.equal(await asSuper(AFTER, 'select string_agg(distinct who, \',\') from att.log3'), owner, 'the foreign code ran as the writer');
  await asSuper(AFTER, `drop trigger aa_spy3 on ${T}; drop function att.spy3(); drop table att.log3`);
});
