// F5 brand OWNER EPOCH (source candidate supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql), proven on a local PostgreSQL 17 with fake data.
//
// What is asserted: the number moves on EVERY committed write that touches an owner membership row (insert, update, delete, cascade, truncate) and never goes back, so
// an owner A -> B -> A, owner -> admin -> owner or a delete + insert can never look like "nothing changed"; a rolled-back or failed write moves nothing; two concurrent owner
// changes serialize; zero / two owners, a disabled trigger and a write that got past the trigger make the getter answer NULL (refuse); the helpers are owner-only; the real X
// onboarding RPC keeps working; and a stale attestation sends nothing. J1 V1 R1-R3: a rollback + re-install moves EVERY number (an A -> B -> A or a re-created workspace
// made while uninstalled never re-validates an earlier attestation); a same-named trigger that is not exactly the candidate's does not count; and an API role that can
// reach the owner, a superuser, SET session_replication_role, TRIGGER, or (anon / authenticated) a write / TRUNCATE / REFERENCES -- through any membership, NOINHERIT and
// SET-only included -- breaks the coverage and stops the install. A PASS is not a managed Supabase result, not G4's / F3's code and not an approval to apply.
// Needs CAL_E2E=1 and PGHOST / PGPORT / PGUSER / PGDATABASE / PGSUPER / OE_CANDIDATE / OE_ROLLBACK (common_account_owner_epoch_run.sh sets them).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const decoder = new TextDecoder();
if (enabled && !db) throw new Error('PGDATABASE is required');
globalThis.fetch = (() => { throw new Error('the owner-epoch tests make no network request'); }) as typeof fetch;

type Psql = { ok: boolean; out: string; error: string };
const baseEnv = (user: string): Record<string, string> => ({ PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: user, PGDATABASE: db, LC_ALL: 'C' });
async function run(user: string, args: string[]): Promise<Psql> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], env: baseEnv(user), clearEnv: true, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const owner = Deno.env.get('PGUSER') ?? '';
const superUser = Deno.env.get('PGSUPER') ?? '';
const psql = (statement: string) => run(owner, ['-c', statement]);
const psqlSuper = (statement: string) => run(superUser, ['-c', statement]);
async function sql(statement: string): Promise<string> {
  const r = await psql(statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
const spawnHolder = (statement: string) => new Deno.Command('psql', {
  args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], env: baseEnv(owner), clearEnv: true, stdout: 'piped', stderr: 'piped',
}).spawn();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// waits until a spawned holder is inside its pg_sleep (so its locks are held), instead of guessing a start-up delay
async function untilSleeping(marker: string) {
  for (let i = 0; i < 100; i += 1) {
    const n = await run(owner, ['-c', `select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position(${q(marker)} in query) > 0`]);
    if (n.ok && n.out === '1') return;
    await sleep(50);
  }
  throw new Error(`the holder ${marker} never reached its sleep`);
}

// ---- the model world -------------------------------------------------------------------------------------------------------------------------------
async function user(): Promise<string> {
  const id = randomUUID();
  await sql(`insert into auth.users (id) values ('${id}'::uuid)`);
  return id;
}
let counter = 0;
async function workspace(owners: string[] = []): Promise<string> {
  counter += 1;
  const id = `u_oe${Date.now().toString(36)}${counter}`;
  await sql(`insert into public.brands (id) values (${q(id)})`);
  for (const u of owners) await sql(`insert into public.brand_memberships (brand_id, user_id, role) values (${q(id)}, '${u}'::uuid, 'owner')`);
  return id;
}
const epoch = (brand: string | null) => sql(`select coalesce(private.account_lifecycle_brand_owner_epoch(${brand === null ? 'null' : q(brand)})::text, 'NULL')`);
async function num(brand: string): Promise<number> {
  const value = await epoch(brand);
  assert.notEqual(value, 'NULL', `${brand} has an epoch`);
  return Number(value);
}
const stored = (brand: string) => sql(`select coalesce((select epoch::text from private.account_lifecycle_brand_owner_epochs where brand_id = ${q(brand)}), 'NONE')`);
const ownerOf = (brand: string) => sql(`select coalesce(private.account_lifecycle_brand_owner(${q(brand)})::text, 'NULL')`);
const member = (brand: string, u: string, role: string) => sql(`insert into public.brand_memberships (brand_id, user_id, role) values (${q(brand)}, '${u}'::uuid, ${q(role)})`);
const setRole = (brand: string, u: string, role: string) => sql(`update public.brand_memberships set role = ${q(role)} where brand_id = ${q(brand)} and user_id = '${u}'::uuid`);
const dropMember = (brand: string, u: string) => sql(`delete from public.brand_memberships where brand_id = ${q(brand)} and user_id = '${u}'::uuid`);
const test_ = enabled ? test : test.skip;
const denied = (r: Psql) => !r.ok && /permission denied|must be owner|does not exist/u.test(r.error);
const covered = () => sql(`select private.account_lifecycle_brand_owner_epoch_covered()::text`);
const exposure = () => sql(`select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE')`);
const candidateFile = () => Deno.env.get('OE_CANDIDATE') ?? '';
const rollbackFile = () => Deno.env.get('OE_ROLLBACK') ?? '';
const fenceTriggers = () => sql(`select count(*) from pg_trigger where tgname like 'account_lifecycle_owner_epoch%' and tgrelid = 'public.brand_memberships'::regclass`);
const tag = () => `oe_t_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
// the exact triggers of the candidate, re-created after a test replaced them
async function restoreTriggers() {
  await sql(`drop trigger if exists account_lifecycle_owner_epoch_row on public.brand_memberships; drop trigger if exists account_lifecycle_owner_epoch_truncate on public.brand_memberships; `
    + `create trigger account_lifecycle_owner_epoch_row after insert or update or delete on public.brand_memberships for each row execute function private.account_lifecycle_owner_epoch_record(); `
    + `create trigger account_lifecycle_owner_epoch_truncate after truncate on public.brand_memberships for each statement execute function private.account_lifecycle_owner_epoch_truncated()`);
}
// a stale-attestation send gate (a model of G4 / F3 that uses only the getter) with a mock transport that counts what it sends
function sendGate(brand: string) {
  const state = { sends: 0 };
  const attest = async () => ({ owner: await ownerOf(brand), epoch: await num(brand) });
  const send = async (att: { owner: string; epoch: number }): Promise<string> => {
    const current = await epoch(brand);
    if (current === 'NULL') return 'refused:unknown';
    if ((await ownerOf(brand)) !== att.owner) return 'refused:owner';
    if (Number(current) !== att.epoch) return 'refused:stale';
    state.sends += 1;
    return 'sent (SIMULATED)';
  };
  return { state, attest, send };
}

// =============================================================================================================================================
test_('install: a first install gives an owner workspace 1; the rollback and a RE-install each move EVERY retained number (no number survives a re-install)', async () => {
  const a = await user();
  const one = await workspace([a]);
  assert.equal(await epoch(one), '1', 'a single owner inserted after the install starts at 1');
  assert.equal(await epoch(null), 'NULL', 'a NULL argument');
  assert.equal(await epoch('u_does_not_exist'), 'NULL', 'an unknown workspace');
  const none = await workspace([]);
  assert.equal(await epoch(none), 'NULL', 'a workspace with no owner row');
  await member(none, await user(), 'member');
  assert.equal(await epoch(none), 'NULL', 'a member is not an owner');
  assert.equal(await stored(none), 'NONE', 'a non-owner insert records nothing');
  // uninstall (the rollback file), write while no trigger exists, install again
  const before = await workspace([await user()]);
  const beforeEpoch = await num(before);
  const rollback = rollbackFile();
  const candidate = candidateFile();
  const oneEpoch = await num(one);
  assert.ok((await run(owner, ['-f', rollback])).ok, 'the rollback file runs');
  assert.ok(!(await psql(`select private.account_lifecycle_brand_owner_epoch(${q(before)})`)).ok, 'after the rollback the getter does not exist: a caller that needs it refuses');
  assert.equal(await stored(before), String(beforeEpoch + 1), 'the retained history is still there, moved on by the rollback');
  assert.equal(await stored(one), String(oneEpoch + 1), 'every recorded workspace moved on, changed or not');
  const later = await workspace([await user()]);              // an owner the triggers never saw
  await sql(`delete from public.brand_memberships where brand_id = ${q(before)}`);   // an owner change while uninstalled ...
  await member(before, await user(), 'owner');
  assert.equal(await stored(later), 'NONE');
  assert.equal(await stored(before), String(beforeEpoch + 1), 'nothing was recorded while uninstalled');
  assert.ok((await run(owner, ['-f', candidate])).ok, 'the candidate installs again');
  assert.equal(await epoch(later), '1', 'an owner the triggers never saw gets 1');
  assert.equal(await num(before), beforeEpoch + 2, 'the re-install moved it again, above the rollback number');
  assert.equal(await num(one), oneEpoch + 2, 'an UNCHANGED recorded workspace moves too: no number issued before the rollback is valid after the re-install');
  assert.equal(await covered(), 'true');
  // a second install on top is refused
  assert.ok(/OWNER_EPOCH_ALREADY_APPLIED/u.test((await run(owner, ['-f', candidate])).error));
  // an end-user role that could write memberships is a writer this file does not cover: the install refuses, and nothing is half-installed
  assert.ok((await run(owner, ['-f', rollback])).ok);
  await sql(`grant insert on public.brand_memberships to authenticated`);
  const refused = await run(owner, ['-f', candidate]);
  assert.ok(!refused.ok && /OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_WRITE_MEMBERSHIPS/u.test(refused.error), 'the install refuses');
  assert.equal(await fenceTriggers(), '0', 'no trigger was left behind');
  assert.equal(await sql(`select (to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null)::text`), 'true', 'no function was left behind');
  await sql(`revoke insert on public.brand_memberships from authenticated`);
  assert.ok((await run(owner, ['-f', candidate])).ok, 'the install works again once the grant is gone');
  assert.equal(await covered(), 'true');
});

test_('who may call what: the getter, the resync and every helper are owner-only; the table has no grant; no API role reaches them through a membership', async () => {
  const a = await user();
  const brand = await workspace([a]);
  const fns = [`private.account_lifecycle_brand_owner_epoch(${q(brand)})`, `private.account_lifecycle_brand_owner_epoch_covered()`, `private.account_lifecycle_brand_owner_epoch_resync(${q(brand)})`,
    `private.account_lifecycle_owner_epoch_bump(${q(brand)})`, `private.account_lifecycle_owner_epoch_exposure()`];
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const fn of fns) {
      const r = await psql(`begin; set local role ${role}; select ${fn}; commit`);
      assert.ok(denied(r), `${role} cannot call ${fn.split('(')[0]}`);
    }
    for (const stmt of [`select * from private.account_lifecycle_brand_owner_epochs`, `update private.account_lifecycle_brand_owner_epochs set epoch = 99`, `delete from private.account_lifecycle_brand_owner_epochs`]) {
      assert.ok(denied(await psql(`begin; set local role ${role}; ${stmt}; commit`)), `${role}: ${stmt}`);
    }
  }
  assert.equal(await sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'account_lifecycle%owner_epoch%' and not (p.prosecdef and p.proconfig @> array['search_path=""'])`), '0', 'every helper is definer with an empty search path');
  assert.equal(await sql(`select relrowsecurity::text from pg_class where oid = 'private.account_lifecycle_brand_owner_epochs'::regclass`), 'true');
  const b = await user();
  assert.ok(denied(await psql(`begin; set local role authenticated; insert into public.brand_memberships (brand_id, user_id, role) values (${q(brand)}, '${b}'::uuid, 'owner'); commit`)), 'an end user cannot write memberships (the premise of the install check)');
  for (const [role, privilege] of [['anon', 'TRIGGER'], ['authenticated', 'TRIGGER'], ['service_role', 'TRIGGER'], ['anon', 'TRUNCATE'], ['authenticated', 'TRUNCATE'], ['authenticated', 'REFERENCES']]) {
    assert.equal(await sql(`select has_table_privilege(${q(role)}, 'public.brand_memberships', ${q(privilege)})::text`), 'false', `${role} has no ${privilege} (the dependency the runner stands in for)`);
  }
  assert.equal(await exposure(), 'NONE');
  assert.equal(await epoch(brand), '1');
});

test_('every write that touches an OWNER row moves the number by the right amount; writes that do not, move nothing', async () => {
  const a = await user();
  const b = await user();
  const c = await user();
  const brand = await workspace([a]);
  const base = await num(brand);
  await member(brand, b, 'member');
  await setRole(brand, b, 'viewer');
  await setRole(brand, b, 'admin');
  await dropMember(brand, b);
  assert.equal(await num(brand), base, 'member / viewer / admin rows never move the number');
  await setRole(brand, a, 'owner');
  await sql(`update public.brand_memberships set role = role where brand_id = ${q(brand)} and user_id = '${a}'::uuid`);
  assert.equal(await num(brand), base, 'an update that changes neither brand, user nor role moves nothing');
  await member(brand, b, 'owner');
  assert.equal(await epoch(brand), 'NULL', 'two owners are unknown');
  assert.equal(await stored(brand), String(base + 1), 'the insert of an owner moved it by one');
  await setRole(brand, a, 'admin');
  assert.equal(await stored(brand), String(base + 2), 'owner -> admin');
  assert.equal(await num(brand), base + 2);
  await setRole(brand, a, 'owner');
  assert.equal(await stored(brand), String(base + 3), 'admin -> owner');
  await dropMember(brand, b);
  assert.equal(await num(brand), base + 4, 'the delete of an owner row');
  await sql(`update public.brand_memberships set user_id = '${c}'::uuid where brand_id = ${q(brand)} and user_id = '${a}'::uuid`);
  assert.equal(await num(brand), base + 5, 'the owner row moved to another person (one change, not two)');
  const other = await workspace([await user()]);
  const otherBase = await num(other);
  await sql(`delete from public.brand_memberships where brand_id = ${q(other)}`);
  await sql(`update public.brand_memberships set brand_id = ${q(other)} where brand_id = ${q(brand)} and user_id = '${c}'::uuid`);
  assert.equal(await stored(brand), String(base + 6), 'the workspace the owner left');
  assert.equal(await num(other), otherBase + 2, 'the workspace the owner joined (its own delete once, the arrival once)');
});

test_('A -> B -> A, owner -> admin -> owner and delete + insert are different numbers; an attestation made at the first is stale at the last', async () => {
  const a = await user();
  const b = await user();
  const viaInsert = await workspace([a]);
  const e1 = await num(viaInsert);
  await dropMember(viaInsert, a);
  await member(viaInsert, b, 'owner');
  const e2 = await num(viaInsert);
  await dropMember(viaInsert, b);
  await member(viaInsert, a, 'owner');
  const e3 = await num(viaInsert);
  assert.deepEqual([e1 < e2, e2 < e3], [true, true], 'A -> B -> A through delete + insert');
  assert.equal(await ownerOf(viaInsert), a, 'the owner is A again');
  await setRole(viaInsert, a, 'admin');
  assert.equal(await epoch(viaInsert), 'NULL', 'no owner');
  await setRole(viaInsert, a, 'owner');
  assert.equal(await num(viaInsert), e3 + 2, 'owner -> admin -> owner moved the number twice');
  const swap = await workspace([a]);
  await member(swap, b, 'admin');
  const s1 = await num(swap);
  await setRole(swap, a, 'admin');
  await setRole(swap, b, 'owner');
  const s2 = await num(swap);
  await setRole(swap, b, 'admin');
  await setRole(swap, a, 'owner');
  const s3 = await num(swap);
  assert.deepEqual([s1 < s2, s2 < s3], [true, true], 'A -> B -> A through role swaps');
  assert.equal(await ownerOf(swap), a);
  assert.notEqual(s1, s3, 'the same owner, a different epoch: an attestation made at the first is stale at the last');
});

test_('two or more owners, then one again: the getter refuses, and the number after recovery is greater than every earlier one', async () => {
  const a = await user();
  const b = await user();
  const brand = await workspace([a]);
  const e1 = await num(brand);
  await member(brand, b, 'owner');
  assert.equal(await epoch(brand), 'NULL');
  await dropMember(brand, a);
  const e2 = await num(brand);
  assert.ok(e2 > e1 + 1, 'it moved twice since the first number');
  await dropMember(brand, b);
  assert.equal(await epoch(brand), 'NULL', 'zero owners');
  await member(brand, a, 'owner');
  assert.ok((await num(brand)) > e2, 'back to one owner: still greater');
});

test_('rollback: a rolled-back transaction, a rolled-back savepoint, a handled exception and a failing statement move nothing; the next committed change moves by exactly one', async () => {
  const a = await user();
  const b = await user();
  const d = await user();
  const brand = await workspace([a]);
  const base = await num(brand);
  assert.ok((await psql(`begin; update public.brand_memberships set role = 'admin' where brand_id = ${q(brand)}; insert into public.brand_memberships values (${q(brand)}, '${b}'::uuid, 'owner'); rollback`)).ok);
  assert.equal(await num(brand), base, 'the whole transaction rolled back');
  assert.ok((await psql(`begin; savepoint s; insert into public.brand_memberships values (${q(brand)}, '${b}'::uuid, 'owner'); rollback to s; commit`)).ok);
  assert.equal(await num(brand), base, 'the savepoint rolled back');
  const failing = await psql(`begin; insert into public.brand_memberships values (${q(brand)}, '${b}'::uuid, 'owner'); insert into public.brand_memberships values (${q(brand)}, '${b}'::uuid, 'owner'); commit`);
  assert.ok(!failing.ok, 'a duplicate key fails the transaction');
  assert.equal(await num(brand), base, 'the failed transaction moved nothing');
  assert.ok((await psql(`do $$ begin begin insert into public.brand_memberships values (${q(brand)}, '${d}'::uuid, 'owner'); raise exception 'x'; exception when others then null; end; end $$`)).ok);
  assert.equal(await num(brand), base, 'a handled exception takes its bump back');
  await member(brand, b, 'admin');
  await setRole(brand, b, 'owner');
  await setRole(brand, b, 'admin');
  assert.equal(await num(brand), base + 2, 'two committed owner changes moved it by two');
});

test_('concurrency: an owner change that has not committed is invisible; a second owner change on the same workspace waits and then moves the number again; an abort moves nothing', async () => {
  const a = await user();
  const b = await user();
  const c = await user();
  const brand = await workspace([a]);
  await member(brand, b, 'admin');
  await member(brand, c, 'admin');
  const base = await num(brand);
  const t1 = spawnHolder(`begin; update public.brand_memberships set role = 'admin' where brand_id = ${q(brand)} and user_id = '${a}'::uuid; update public.brand_memberships set role = 'owner' where brand_id = ${q(brand)} and user_id = '${b}'::uuid; select pg_sleep(3) /* oe-hold-t1 */; commit;`);
  await untilSleeping('oe-hold-t1');
  assert.equal(await num(brand), base, 'the uncommitted change is invisible to a reader');
  const started = Date.now();
  const second = await psql(`begin; update public.brand_memberships set role = 'admin' where brand_id = ${q(brand)} and user_id = '${b}'::uuid; update public.brand_memberships set role = 'owner' where brand_id = ${q(brand)} and user_id = '${c}'::uuid; commit`);
  assert.ok(second.ok, second.error);
  assert.ok(Date.now() - started >= 1500, 'T2 waited for T1');
  await t1.output();
  assert.equal(await ownerOf(brand), c, 'the last committed owner is c');
  assert.equal(await num(brand), base + 4, 'four owner-row changes, none lost, none repeated');
  const holder = spawnHolder(`begin; update public.brand_memberships set role = 'admin' where brand_id = ${q(brand)} and user_id = '${c}'::uuid; select pg_sleep(2) /* oe-hold-abort */; rollback;`);
  await untilSleeping('oe-hold-abort');
  assert.equal(await num(brand), base + 4, 'while the holder is open nothing changed');
  await holder.output();
  assert.equal(await num(brand), base + 4, 'the aborted transaction moved nothing');
});

test_('the history only goes up: a decrease, a re-key, a delete and a truncate of the epoch table are refused (even for its owner); a deleted workspace keeps its number and a re-created one continues', async () => {
  const a = await user();
  const brand = await workspace([a]);
  await setRole(brand, a, 'admin');
  await setRole(brand, a, 'owner');
  const e = await num(brand);
  for (const stmt of [`update private.account_lifecycle_brand_owner_epochs set epoch = epoch - 1 where brand_id = ${q(brand)}`, `update private.account_lifecycle_brand_owner_epochs set epoch = epoch where brand_id = ${q(brand)}`,
    `update private.account_lifecycle_brand_owner_epochs set brand_id = ${q(brand + 'x')} where brand_id = ${q(brand)}`, `delete from private.account_lifecycle_brand_owner_epochs where brand_id = ${q(brand)}`, `truncate private.account_lifecycle_brand_owner_epochs`]) {
    const r = await psql(stmt);
    assert.ok(!r.ok && /OWNER_EPOCH_HISTORY_IS_APPEND_ONLY/u.test(r.error), stmt);
  }
  assert.equal(await num(brand), e);
  await sql(`delete from public.brands where id = ${q(brand)}`);       // the deletion saga's final statement: the memberships go by cascade
  assert.equal(await epoch(brand), 'NULL', 'a deleted workspace is unknown');
  assert.equal(await stored(brand), String(e + 1), 'the cascade delete of the owner row moved the number, and the row stays');
  await sql(`insert into public.brands (id) values (${q(brand)})`);
  await member(brand, a, 'owner');
  assert.equal(await num(brand), e + 2, 'a re-created workspace never repeats an earlier number');
  const b = await user();
  const other = await workspace([b]);
  const eo = await num(other);
  await sql(`delete from auth.users where id = '${b}'::uuid`);       // deleting the PERSON cascades the owner row
  assert.equal(await stored(other), String(eo + 1));
  assert.equal(await epoch(other), 'NULL');
});

test_('a write that got past the trigger is detected: a disabled trigger, a session that does not honour triggers and a changed owner all make the getter refuse, and the resync is the way out', async () => {
  const a = await user();
  const b = await user();
  const brand = await workspace([a]);
  await member(brand, b, 'admin');
  const e = await num(brand);
  await sql(`alter table public.brand_memberships disable trigger account_lifecycle_owner_epoch_row`);
  assert.equal(await sql(`select private.account_lifecycle_brand_owner_epoch_covered()::text`), 'false');
  assert.equal(await epoch(brand), 'NULL', 'a disabled trigger makes every number unknown');
  await setRole(brand, a, 'admin');
  await setRole(brand, b, 'owner');
  assert.equal(await stored(brand), String(e), 'the number did not move');
  await sql(`alter table public.brand_memberships enable trigger account_lifecycle_owner_epoch_row`);
  assert.equal(await sql(`select private.account_lifecycle_brand_owner_epoch_covered()::text`), 'true');
  assert.equal(await epoch(brand), 'NULL', 'the recorded owner is not the actual owner: the unrecorded change is detected');
  assert.ok(!(await psql(`select private.account_lifecycle_brand_owner_epoch_resync('')`)).ok, 'an empty workspace id is refused');
  assert.equal(Number(await sql(`select private.account_lifecycle_brand_owner_epoch_resync(${q(brand)})`)), e + 1, 'the resync treats the unknown as a change');
  assert.equal(await num(brand), e + 1);
  const replica = await psqlSuper(`begin; set local session_replication_role = replica; update public.brand_memberships set role = 'admin' where brand_id = ${q(brand)} and user_id = '${b}'::uuid; update public.brand_memberships set role = 'owner' where brand_id = ${q(brand)} and user_id = '${a}'::uuid; commit`);
  assert.ok(replica.ok, replica.error);
  assert.equal(await epoch(brand), 'NULL', 'a swap made without triggers is detected through the recorded owner');
  assert.equal(Number(await sql(`select private.account_lifecycle_brand_owner_epoch_resync(${q(brand)})`)), e + 2);
  assert.equal(await num(brand), e + 2, 'consistent again');
  const inReplica = await psqlSuper(`begin; set local session_replication_role = replica; select coalesce(private.account_lifecycle_brand_owner_epoch(${q(brand)})::text, 'NULL'); rollback`);
  assert.equal(inReplica.out, 'NULL', 'the same consistent state: a session that does not honour triggers still reads no number');
  assert.equal(await num(brand), e + 2, 'an ordinary session reads it');
  await sql(`drop trigger account_lifecycle_owner_epoch_truncate on public.brand_memberships`);
  assert.equal(await epoch(brand), 'NULL', 'a missing truncate trigger also breaks the coverage');
  assert.ok(!(await psql(`select private.account_lifecycle_brand_owner_epoch_resync(${q(brand)})`)).ok, 'the resync refuses while the coverage is broken');
  await sql(`create trigger account_lifecycle_owner_epoch_truncate after truncate on public.brand_memberships for each statement execute function private.account_lifecycle_owner_epoch_truncated()`);
  assert.equal(await sql(`select private.account_lifecycle_brand_owner_epoch_covered()::text`), 'true');
  assert.equal(await num(brand), e + 2);
});

test_('isolation: changes of one workspace never move another; entitlements, the common account, Vault and the X account rows are untouched', async () => {
  const a = await user();
  const b = await user();
  const one = await workspace([a]);
  const two = await workspace([b]);
  const twoBefore = await stored(two);
  const snapshot = () => sql(`select md5(concat_ws('|',
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.service_entitlements x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.common_accounts x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from vault.secrets x),
    (select coalesce(string_agg(x::text, ',' order by x::text), '') from public.social_accounts x)))`);
  const before = await snapshot();
  await setRole(one, a, 'admin');
  await setRole(one, a, 'owner');
  assert.equal(await stored(two), twoBefore, 'the other workspace did not move');
  assert.equal(await snapshot(), before, 'no entitlement, account, secret or X row changed');
  assert.equal(await epoch(a), 'NULL', 'a person id is not a workspace id');
});

test_('the real X onboarding RPC keeps working: it creates the workspace and its owner, and the epoch is there', async () => {
  const u = await user();
  const rpc = await psql(`begin; set local request.jwt.claim.sub = '${u}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; `
    + `select brand_id from public.begin_social_mobile_x_oauth_connection(${q(createHash('sha256').update(randomUUID()).digest('hex'))}, ${q('kabumori-social://oauth-callback')}, now() + interval '10 minutes'); commit`);
  assert.ok(rpc.ok, `the live RPC runs with the triggers installed: ${rpc.error}`);
  const brand = rpc.out.split('\n')[0];
  assert.equal(await sql(`select count(*) from public.brand_memberships where brand_id = ${q(brand)} and user_id = '${u}'::uuid and role = 'owner'`), '1');
  assert.equal(await epoch(brand), '1', 'the owner the RPC wrote is epoch 1');
});

test_('J1 V1 R1: rollback + re-install is a re-start fence -- an A -> B -> A made while uninstalled, a workspace re-created with the same id, and an untouched workspace all refuse every earlier attestation; nothing is sent', async () => {
  const a = await user();
  const b = await user();
  const c = await user();
  const aba = await workspace([a]);
  const recreated = await workspace([c]);
  const quiet = await workspace([await user()]);
  const gates = [sendGate(aba), sendGate(recreated), sendGate(quiet)];
  const atts = [];
  for (const g of gates) atts.push(await g.attest());
  for (let i = 0; i < gates.length; i += 1) assert.equal(await gates[i].send(atts[i]), 'sent (SIMULATED)', 'fresh before the rollback');
  const was = [await stored(aba), await stored(recreated), await stored(quiet)].map(Number);
  assert.ok((await run(owner, ['-f', rollbackFile()])).ok, 'the rollback runs');
  // while uninstalled: A -> B -> A through delete + insert; the second workspace is deleted (cascade) and re-created under the same id with the same owner
  await dropMember(aba, a);
  await member(aba, b, 'owner');
  await dropMember(aba, b);
  await member(aba, a, 'owner');
  await sql(`delete from public.brands where id = ${q(recreated)}`);
  await sql(`insert into public.brands (id) values (${q(recreated)})`);
  await member(recreated, c, 'owner');
  assert.equal(await stored(aba), String(was[0] + 1), 'the rollback moved the recorded number once; the writes while uninstalled moved nothing');
  assert.ok((await run(owner, ['-f', candidateFile()])).ok, 'the re-install');
  assert.equal(await ownerOf(aba), a, 'the owner is A again, exactly as recorded before the rollback');
  assert.equal(await num(aba), was[0] + 2, 'A -> B -> A while uninstalled: a new number');
  assert.equal(await num(recreated), was[1] + 2, 'the re-created workspace: a new number');
  assert.equal(await num(quiet), was[2] + 2, 'the untouched workspace: a new number as well');
  for (let i = 0; i < gates.length; i += 1) {
    assert.equal(await gates[i].send(atts[i]), 'refused:stale', 'an attestation from before the rollback is stale after the re-install');
    assert.equal(gates[i].state.sends, 1, 'the mock transport was not called again');
  }
  // a second cycle keeps moving: the generation is durable, not a one-off
  const second = await num(aba);
  assert.ok((await run(owner, ['-f', rollbackFile()])).ok);
  assert.ok((await run(owner, ['-f', rollbackFile()])).ok, 'a rollback without an install is harmless');
  assert.ok((await run(owner, ['-f', candidateFile()])).ok);
  assert.equal(await num(aba), second + 3, 'two rollbacks and one install: three moves, never back');
  assert.equal(await covered(), 'true');
});

test_('J1 V1 R2: a same-named trigger that is not exactly the candidate\'s (another function, a WHEN clause, a column list, other events / timing / level, a constraint trigger, arguments, replica-only) does not count', async () => {
  const a = await user();
  const brand = await workspace([a]);
  const e = await num(brand);
  const decoy = `private.${tag()}_decoy`;
  // the decoy has everything but the identity: same owner, definer, empty search path
  await sql(`create function ${decoy}() returns trigger language plpgsql security definer set search_path = '' as $f$ begin return null; end $f$`);
  const R = 'account_lifecycle_owner_epoch_row';
  const T = 'account_lifecycle_owner_epoch_truncate';
  const bm = 'public.brand_memberships';
  const rec = 'private.account_lifecycle_owner_epoch_record()';
  const fakes: [string, string][] = [
    ['another function', `create or replace trigger ${R} after insert or update or delete on ${bm} for each row execute function ${decoy}()`],
    ['a WHEN clause', `create or replace trigger ${R} after insert or update or delete on ${bm} for each row when (current_setting('application_name') <> 'skip') execute function ${rec}`],
    ['a column list', `create or replace trigger ${R} after insert or update of role or delete on ${bm} for each row execute function ${rec}`],
    ['no UPDATE event', `create or replace trigger ${R} after insert or delete on ${bm} for each row execute function ${rec}`],
    ['BEFORE timing', `create or replace trigger ${R} before insert or update or delete on ${bm} for each row execute function ${rec}`],
    ['statement level', `create or replace trigger ${R} after insert or update or delete on ${bm} for each statement execute function ${rec}`],
    ['a constraint trigger', `drop trigger ${R} on ${bm}; create constraint trigger ${R} after insert or update or delete on ${bm} deferrable initially deferred for each row execute function ${rec}`],
    ['trigger arguments', `create or replace trigger ${R} after insert or update or delete on ${bm} for each row execute function private.account_lifecycle_owner_epoch_record('x')`],
    ['replica-only firing', `alter table ${bm} enable replica trigger ${R}`],
    ['a truncate trigger with another function', `create or replace trigger ${T} after truncate on ${bm} for each statement execute function ${decoy}()`],
    ['a BEFORE truncate trigger', `create or replace trigger ${T} before truncate on ${bm} for each statement execute function private.account_lifecycle_owner_epoch_truncated()`],
  ];
  try {
    for (const [label, ddl] of fakes) {
      await sql(ddl);
      assert.equal(await sql(`select count(*) from pg_trigger where tgrelid = '${bm}'::regclass and tgname in ('${R}', '${T}')`), '2', `${label}: both names are still there`);
      assert.equal(await covered(), 'false', `${label}: not covered`);
      assert.equal(await epoch(brand), 'NULL', `${label}: the getter refuses`);
      assert.ok(!(await psql(`select private.account_lifecycle_brand_owner_epoch_resync(${q(brand)})`)).ok, `${label}: the resync refuses`);
      await restoreTriggers();
      assert.equal(await covered(), 'true', `${label}: the exact triggers count again`);
    }
  } finally {
    await restoreTriggers();
    await sql(`drop function if exists ${decoy}()`);
  }
  assert.equal(await num(brand), e, 'nothing was written meanwhile');
});

test_('J1 V1 R2: effective privileges -- an API role with TRIGGER can really replace the fence, so TRIGGER (direct or through a NOINHERIT role), TRUNCATE, REFERENCES and SET session_replication_role break the coverage and stop the install', async () => {
  const a = await user();
  const brand = await workspace([a]);
  const e = await num(brand);
  const mid = tag();
  await psqlSuper(`create role ${mid} nologin noinherit`);
  try {
    // why it matters: with TRIGGER alone, an end user replaces the fence trigger by name (inside a rolled-back transaction here)
    await sql(`grant trigger on public.brand_memberships to authenticated`);
    const replaced = await psql(`begin; set local role authenticated; create or replace trigger account_lifecycle_owner_epoch_row before update on public.brand_memberships for each row execute function suppress_redundant_updates_trigger(); `
      + `select tgfoid::regprocedure::text from pg_trigger where tgname = 'account_lifecycle_owner_epoch_row'; rollback`);
    assert.ok(replaced.ok && replaced.out.endsWith('suppress_redundant_updates_trigger()'), `TRIGGER alone replaces the fence trigger: ${replaced.error}`);
    assert.equal(await exposure(), 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS');
    assert.equal(await epoch(brand), 'NULL', 'the getter refuses while an end user holds TRIGGER');
    assert.ok((await run(owner, ['-f', rollbackFile()])).ok);
    const refused = await run(owner, ['-f', candidateFile()]);
    assert.ok(!refused.ok && /OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS/u.test(refused.error), `the install refuses: ${refused.error}`);
    assert.equal(await fenceTriggers(), '0', 'nothing half-installed');
    await sql(`revoke trigger on public.brand_memberships from authenticated`);
    assert.ok((await run(owner, ['-f', candidateFile()])).ok, 'the install works once the grant is gone');
    const fresh = await num(brand);
    assert.ok(fresh > e, 'the re-install moved the number');
    const cases: [string, string, string, string][] = [
      ['TRIGGER through a NOINHERIT role (anon cannot use it without SET ROLE)', `grant trigger on public.brand_memberships to ${mid}; grant ${mid} to anon with inherit false, set true`,
        `revoke ${mid} from anon; revoke trigger on public.brand_memberships from ${mid}`, 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS'],
      ['TRIGGER for the service key', `grant trigger on public.brand_memberships to service_role`, `revoke trigger on public.brand_memberships from service_role`, 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS'],
      ['TRUNCATE for anon', `grant truncate on public.brand_memberships to anon`, `revoke truncate on public.brand_memberships from anon`, 'API_ROLE_CAN_WRITE_MEMBERSHIPS'],
      ['REFERENCES for authenticated', `grant references on public.brand_memberships to authenticated`, `revoke references on public.brand_memberships from authenticated`, 'API_ROLE_CAN_WRITE_MEMBERSHIPS'],
      ['DELETE through a NOINHERIT role', `grant delete on public.brand_memberships to ${mid}; grant ${mid} to authenticated with inherit false, set true`,
        `revoke ${mid} from authenticated; revoke delete on public.brand_memberships from ${mid}`, 'API_ROLE_CAN_WRITE_MEMBERSHIPS'],
    ];
    for (const [label, grant, revoke, code] of cases) {
      const g = await psqlSuper(grant);
      assert.ok(g.ok, g.error);
      if (label.includes('NOINHERIT')) {
        const api = label.startsWith('TRIGGER') ? 'anon' : 'authenticated';
        const priv = label.startsWith('TRIGGER') ? 'TRIGGER' : 'DELETE';
        assert.equal(await sql(`select has_table_privilege(${q(api)}, 'public.brand_memberships', ${q(priv)})::text`), 'false', `${label}: a direct privilege check misses it`);
      }
      assert.equal(await exposure(), code, label);
      assert.equal(await epoch(brand), 'NULL', `${label}: the getter refuses`);
      assert.ok((await psqlSuper(revoke)).ok);
      assert.equal(await num(brand), fresh, `${label}: covered again once it is gone`);
    }
    // a role that may SET session_replication_role silences both triggers for its own session
    assert.ok((await psqlSuper(`grant set on parameter session_replication_role to ${mid}; grant ${mid} to authenticated with inherit false, set true`)).ok);
    assert.equal(await sql(`select has_parameter_privilege('authenticated', 'session_replication_role', 'SET')::text`), 'false', 'a direct parameter check misses it');
    assert.equal(await exposure(), 'API_ROLE_CAN_SKIP_TRIGGERS');
    assert.equal(await epoch(brand), 'NULL');
    assert.ok((await psqlSuper(`revoke ${mid} from authenticated; revoke set on parameter session_replication_role from ${mid}`)).ok);
    assert.equal(await num(brand), fresh);
  } finally {
    await sql(`revoke trigger on public.brand_memberships from authenticated, service_role, anon`);
    await psqlSuper(`revoke set on parameter session_replication_role from ${mid}`);
    await psqlSuper(`drop owned by ${mid}`);
    await psqlSuper(`drop role if exists ${mid}`);
  }
  assert.equal(await exposure(), 'NONE');
});

test_('J1 V1 R3: a NOINHERIT path that can still SET ROLE (directly, through an intermediate role, or an ADMIN-only edge) to the owner or a superuser breaks the coverage and stops the install, although USAGE says no', async () => {
  const a = await user();
  const brand = await workspace([a]);
  const e = await num(brand);
  const mid = tag();
  const su = tag();
  const adm = tag();
  // the runner made the owner a member of the API roles (to SET ROLE in tests); an API role -> owner edge would be a cycle, so it is taken away for this test
  assert.ok((await psqlSuper(`revoke anon, service_role, kb_cal_svc_child from ${owner}`)).ok);
  try {
    const usage = (api: string, target: string) => sql(`select pg_has_role(${q(api)}, ${q(target)}, 'USAGE')::text || ',' || pg_has_role(${q(api)}, ${q(target)}, 'SET')::text || ',' || pg_has_role(${q(api)}, ${q(target)}, 'MEMBER')::text`);
    // 1) direct: anon may SET ROLE to the owner but inherits nothing
    assert.ok((await psqlSuper(`grant ${owner} to anon with inherit false, set true`)).ok);
    assert.equal(await usage('anon', owner), 'false,true,true', 'USAGE says no, SET says yes');
    assert.equal(await exposure(), 'API_ROLE_CAN_BECOME_OWNER');
    assert.equal(await epoch(brand), 'NULL', 'direct: the getter refuses');
    assert.ok((await run(owner, ['-f', rollbackFile()])).ok);
    const refused = await run(owner, ['-f', candidateFile()]);
    assert.ok(!refused.ok && /OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_BECOME_OWNER/u.test(refused.error), `the install refuses: ${refused.error}`);
    assert.equal(await fenceTriggers(), '0');
    assert.ok((await psqlSuper(`revoke ${owner} from anon`)).ok);
    assert.ok((await run(owner, ['-f', candidateFile()])).ok, 'the install works once the edge is gone');
    const fresh = await num(brand);
    assert.ok(fresh > e);
    // 2) indirect: authenticated -> (no inherit, SET) mid -> (no inherit, SET) a superuser role: SET ROLE works hop by hop, nothing is inherited
    assert.ok((await psqlSuper(`create role ${su} nologin superuser; create role ${mid} nologin noinherit; grant ${su} to ${mid} with inherit false, set true; grant ${mid} to authenticated with inherit false, set true`)).ok);
    assert.equal(await usage('authenticated', su), 'false,true,true', 'indirect: USAGE says no');
    assert.equal(await exposure(), 'API_ROLE_CAN_BECOME_SUPERUSER');
    assert.equal(await epoch(brand), 'NULL', 'indirect: the getter refuses');
    assert.ok((await psqlSuper(`revoke ${mid} from authenticated`)).ok);
    assert.equal(await num(brand), fresh);
    // 3) an ADMIN-only edge (no inherit, no SET): the service key could grant itself the owner
    assert.ok((await psqlSuper(`create role ${adm} nologin noinherit; grant ${owner} to ${adm} with admin true, inherit false, set false; grant ${adm} to service_role with inherit false, set false`)).ok);
    assert.equal(await usage('service_role', owner), 'false,false,true', 'neither USAGE nor SET, still a member path');
    assert.equal(await exposure(), 'API_ROLE_CAN_BECOME_OWNER');
    assert.equal(await epoch(brand), 'NULL', 'admin edge: the getter refuses');
    assert.ok((await psqlSuper(`revoke ${adm} from service_role`)).ok);
    assert.equal(await num(brand), fresh);
  } finally {
    await psqlSuper(`revoke ${owner} from anon`);
    for (const r of [adm, mid, su]) await psqlSuper(`drop role if exists ${r}`);
    assert.ok((await psqlSuper(`grant anon, service_role, kb_cal_svc_child to ${owner}`)).ok, 'the runner\'s memberships are back');
  }
  assert.equal(await exposure(), 'NONE');
  assert.equal(await covered(), 'true');
});

test_('concurrency (lock before read): a bump that waited for the epoch row records the owners committed meanwhile by ANOTHER membership row', async () => {
  const a = await user();
  const c = await user();
  const brand = await workspace([a]);
  await member(brand, c, 'admin');
  const base = await num(brand);
  // T1: a -> admin, then holds the epoch row; T2 (another row): c -> owner, its bump waits for T1's epoch row
  const t1 = spawnHolder(`begin; update public.brand_memberships set role = 'admin' where brand_id = ${q(brand)} and user_id = '${a}'::uuid; select pg_sleep(2) /* oe-hold-lbr */; commit;`);
  await untilSleeping('oe-hold-lbr');
  const started = Date.now();
  const t2 = await psql(`update public.brand_memberships set role = 'owner' where brand_id = ${q(brand)} and user_id = '${c}'::uuid`);
  assert.ok(t2.ok, t2.error);
  assert.ok(Date.now() - started >= 1000, 'T2 (another membership row) waited for T1 on the epoch row');
  assert.ok((await t1.output()).success, 'T1 committed');
  assert.equal(await ownerOf(brand), c);
  assert.equal(await num(brand), base + 2, 'T2 recorded c as the single owner (it read the owners after the lock, seeing T1\'s commit)');
});

test_('a STALE attestation sends nothing: the send gate (a model of G4 / F3 using only the getter) refuses after every owner change, and the mock transport is never called', async () => {
  const a = await user();
  const b = await user();
  const brand = await workspace([a]);
  type Attestation = { owner: string; epoch: number };
  const attest = async (): Promise<Attestation> => ({ owner: await ownerOf(brand), epoch: await num(brand) });
  let sends = 0;
  const send = async (att: Attestation): Promise<string> => {
    const current = await epoch(brand);
    if (current === 'NULL') return 'refused:unknown';
    if ((await ownerOf(brand)) !== att.owner) return 'refused:owner';
    if (Number(current) !== att.epoch) return 'refused:stale';
    sends += 1;
    return 'sent (SIMULATED)';
  };
  const att = await attest();
  assert.equal(await send(att), 'sent (SIMULATED)');
  assert.equal(sends, 1);
  await sql(`delete from public.brand_memberships where brand_id = ${q(brand)}`);
  await member(brand, b, 'owner');
  assert.equal(await send(att), 'refused:owner');
  await sql(`delete from public.brand_memberships where brand_id = ${q(brand)}`);
  await member(brand, a, 'owner');
  assert.equal(await send(att), 'refused:stale', 'same owner, different epoch');
  const att2 = await attest();
  await setRole(brand, a, 'admin');
  assert.equal(await send(att2), 'refused:unknown');
  await setRole(brand, a, 'owner');
  assert.equal(await send(att2), 'refused:stale');
  await member(brand, b, 'owner');
  assert.equal(await send(att2), 'refused:unknown', 'two owners');
  assert.equal(sends, 1, 'only the first, fresh attestation sent');
  await dropMember(brand, b);
  assert.equal(await send(await attest()), 'sent (SIMULATED)');
  assert.equal(sends, 2);
});

// LAST: it empties public.brand_memberships of the whole (throw-away) database.
test_('TRUNCATE is a change of every workspace: the service key truncates, every number moves up and every getter answers NULL', async () => {
  const a = await user();
  const brand = await workspace([a]);
  const e = await num(brand);
  const others = (await sql(`select brand_id from private.account_lifecycle_brand_owner_epochs order by brand_id`)).split('\n').filter(Boolean);
  const before = new Map<string, number>();
  for (const id of others) before.set(id, Number(await stored(id)));
  assert.ok(denied(await psql(`begin; set local role authenticated; truncate public.brand_memberships; commit`)), 'an end user cannot truncate (the install refuses otherwise)');
  const r = await psql(`begin; set local role service_role; truncate public.brand_memberships; commit`);
  assert.ok(r.ok, r.error);
  for (const [id, was] of before) assert.equal(await stored(id), String(was + 1), `${id} moved by one`);
  assert.equal(await epoch(brand), 'NULL', 'no owner is known any more');
  await member(brand, a, 'owner');
  assert.ok((await num(brand)) > e + 1, 'the next owner continues above the truncate bump');
});

test_('no network, no side effect: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
