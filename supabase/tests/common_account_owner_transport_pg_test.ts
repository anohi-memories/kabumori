// G5-17: G4's three questions (Issue #320 comment 6329602523) on a local PostgreSQL 17 with fake data. An owner-only transport -- connected as the
// owner role, READ COMMITTED, the verified person's claims set transaction-locally, no SET ROLE to an API role -- runs, in ONE begin transaction:
// R0 (bootstrap verdict) -> T13 (P3b's private.account_lifecycle_assert_active_service_write) -> begin (main's X begin RPC stands in for the Threads
// begin of PR #124, which is not in this tree) -> R1 (threads_connect on the new workspace) -> COMMIT. A PASS is a local fact about the candidate
// SQL; the real owner transport (H5 / PR #139), G4's Threads RPCs and the managed roles are NOT_VERIFIED here.
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE / PGSUPER / OT_OTHER (the runner sets them).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const owner = Deno.env.get('PGUSER') ?? '';
const superUser = Deno.env.get('PGSUPER') ?? '';
const other = Deno.env.get('OT_OTHER') ?? '';
const decoder = new TextDecoder();
const encoder = new TextEncoder();
globalThis.fetch = (() => { throw new Error('the G5-17 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

type Psql = { ok: boolean; out: string; error: string };
const env = (user: string) => ({ PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: user, PGDATABASE: db, LC_ALL: 'C' });
async function run(user: string, args: string[], stdin?: string): Promise<Psql> {
  const cmd = new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], env: env(user), clearEnv: true, stdin: stdin ? 'piped' : 'null', stdout: 'piped', stderr: 'piped' });
  const child = cmd.spawn();
  if (stdin) {
    const w = child.stdin.getWriter();
    await w.write(encoder.encode(stdin));
    await w.close();
  }
  const out = await child.output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
async function sql(statement: string): Promise<string> {
  const r = await run(owner, ['-c', statement]);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const superSql = async (statement: string) => {
  const r = await run(superUser, ['-c', statement]);
  if (!r.ok) throw new Error(r.error);
  return r.out;
};
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function untilSleeping(marker: string) {
  for (let i = 0; i < 100; i += 1) {
    if ((await superSql(`select count(*) from pg_stat_activity where wait_event = 'PgSleep' and position('${marker}' in query) > 0`)) === '1') return;
    await sleep(50);
  }
  throw new Error(`${marker} never slept`);
}

type Person = { user: string; session: string };
async function person(): Promise<Person> {
  const user = randomUUID();
  await sql(`select public.fixture_login('${user}'::uuid)`);
  await sql(`begin; set local request.jwt.claim.sub = '${user}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated;
    select public.start_x_autopost_service(); commit`);
  const session = randomUUID();
  await sql(`insert into auth.sessions (id, user_id, not_after) values ('${session}', '${user}', null)`);
  return { user, session };
}
const claimsOf = (p: Person, extra: Record<string, unknown> = {}) => JSON.stringify({ sub: p.user, role: 'authenticated', session_id: p.session, is_anonymous: false, ...extra });
const derived = (user: string) => sql(`select public.social_mobile_account_deletion_workspace('${user}'::uuid)`);
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');

/** The owner transport's begin transaction, as the owner role; `end` is commit or rollback; each step prints `LABEL|value`. */
function beginScript(p: Person, opts: { claims?: string; r0?: boolean; end?: 'commit' | 'rollback'; pause?: string } = {}): string {
  return `begin isolation level read committed;
select set_config('request.jwt.claims', ${lit(opts.claims ?? claimsOf(p))}, true) \\g /dev/null
${opts.r0 === false ? '' : `select 'R0|' || public.common_account_bootstrap_verdict('postona', 'threads_connect_bootstrap')::text;`}
select 'T13|' || private.account_lifecycle_assert_active_service_write('${p.user}'::uuid, 'x_autopost')::text;
select brand_id as ws from public.begin_social_mobile_x_oauth_connection('${hash()}', 'kabumori-social://oauth-callback', now() + interval '10 minutes') \\gset
select 'WS|' || :'ws';
select 'R1|' || public.common_account_authorization_verdict('postona', 'threads_connect', :'ws')::text;
select 'NUM|' || private.account_lifecycle_brand_owner_epoch(:'ws') || ':' || (select a.lifecycle_version from public.common_accounts a where a.user_id = '${p.user}');
${opts.pause ? `select pg_sleep(3) /* ${opts.pause} */;` : ''}
${opts.end ?? 'commit'};
`;
}
const lines = (out: string) => Object.fromEntries(out.split('\n').filter((l) => l.includes('|')).map((l) => [l.slice(0, l.indexOf('|')), l.slice(l.indexOf('|') + 1)]));

// =============================================================================================================================================
test_('Q1 + Q2: in ONE owner-transport transaction R0 allows, T13 passes, begin creates the workspace, R1 allows on it and returns g5oe:<epoch>:<lifecycle_version> equal to the numbers in the same snapshot; W1 accepts the pair after COMMIT', async () => {
  const p = await person();
  const r = await run(owner, [], beginScript(p));
  assert.ok(r.ok, r.error);
  const v = lines(r.out);
  assert.equal(JSON.parse(v.R0).decision, 'allow', 'R0 (bootstrap) allows before any write');
  assert.equal(v.T13, '', 'T13 returns void (passes)');
  assert.equal(v.WS, await derived(p.user), 'begin created the server-derived workspace');
  const r1 = JSON.parse(v.R1);
  assert.equal(r1.decision, 'allow', `R1 allows on the workspace created in the same transaction: ${v.R1}`);
  assert.deepEqual(r1.scope, { app: 'postona', feature: 'threads_connect', brand_slug: v.WS });
  assert.equal(r1.owner_epoch, `g5oe:${v.NUM}`, 'the token carries exactly the epoch and lifecycle_version of the same snapshot');
  const [epoch, lv] = v.NUM.split(':');
  assert.equal(await sql(`select private.account_lifecycle_worker_brand_verdict(${lit(v.WS)}, 'x_autopost', ${epoch}, ${lv})`), 'active', 'W1 accepts the bound pair');
});

test_('Q1: the pair is stable to COMMIT -- T13\'s row locks hold a lifecycle change back until the begin transaction ends; after it, W1 sees the new generation', async () => {
  const p = await person();
  const child = new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], env: env(owner), clearEnv: true, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
  const w = child.stdin.getWriter();
  await w.write(encoder.encode(beginScript(p, { pause: 'ot-hold' })));
  await w.close();
  await untilSleeping('ot-hold');
  // starting Kabumori changes the owner's entitlements (a new generation): it must wait for the begin transaction's locks
  const start = `begin; set local request.jwt.claim.sub = '${p.user}'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated;
    set local statement_timeout = '1000ms'; select public.start_kabumori_service(); commit`;
  const blocked = await run(owner, ['-c', start]);
  assert.ok(!blocked.ok && /statement timeout/u.test(blocked.error), `a lifecycle change waits behind T13's locks (${blocked.error})`);
  const out = await child.output();
  assert.ok(out.success, decoder.decode(out.stderr));
  const v = lines(decoder.decode(out.stdout).trim());
  const [epoch, lv] = v.NUM.split(':');
  assert.equal(await sql(`select private.account_lifecycle_worker_brand_verdict(${lit(v.WS)}, 'x_autopost', ${epoch}, ${lv})`), 'active');
  assert.ok((await run(owner, ['-c', start.replace(`set local statement_timeout = '1000ms'; `, '')])).ok, 'after COMMIT the change goes through');
  assert.equal(await sql(`select private.account_lifecycle_worker_brand_verdict(${lit(v.WS)}, 'x_autopost', ${epoch}, ${lv})`), 'SERVICE_GENERATION_CHANGED', 'and W1 refuses the old pair');
});

test_('refusals inside the transaction leave nothing: an ended service (R0 and T13 refuse), and a pre-claimed workspace (R0 refuses; without R0, R1 is unknown and the ROLLBACK removes the second owner begin added)', async () => {
  const ended = await person();
  await sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${ended.user}'`);
  const r0only = await run(owner, [], `begin isolation level read committed;
select set_config('request.jwt.claims', ${lit(claimsOf(ended))}, true) \\g /dev/null
select 'R0|' || public.common_account_bootstrap_verdict('postona', 'threads_connect_bootstrap')::text;
rollback;`);
  assert.equal(`${JSON.parse(lines(r0only.out).R0).decision}:${JSON.parse(lines(r0only.out).R0).reason}`, 'deny:SERVICE_NOT_ACTIVE');
  const t13 = await run(owner, [], beginScript(ended, { r0: false }));
  assert.ok(!t13.ok && /SERVICE_NOT_ACTIVE/u.test(t13.error), `T13 refuses too: ${t13.error}`);
  assert.equal(await sql(`select count(*) from public.brands where id = ${lit(await derived(ended.user))}`), '0', 'no workspace was written');

  const victim = await person();
  const someone = randomUUID();
  const ws = await derived(victim.user);
  await sql(`insert into auth.users (id) values ('${someone}'); insert into public.brands (id, code_profile_key) values (${lit(ws)}, 'social_mobile_user_v1');
    insert into public.brand_memberships values (${lit(ws)}, '${someone}', 'owner')`);
  const withR0 = await run(owner, [], beginScript(victim, { end: 'rollback' }));
  assert.ok(withR0.ok, withR0.error);
  assert.equal(`${JSON.parse(lines(withR0.out).R0).decision}:${JSON.parse(lines(withR0.out).R0).reason}`, 'deny:OWN_WORKSPACE_CONFLICT', 'R0 refuses before any write');
  const noR0 = await run(owner, [], beginScript(victim, { r0: false, end: 'rollback' }));
  assert.ok(noR0.ok, noR0.error);
  const r1 = JSON.parse(lines(noR0.out).R1);
  assert.equal(`${r1.decision}:${r1.reason}`, 'unknown:WORKSPACE_OWNER_UNKNOWN', 'without R0, main\'s begin adds a second owner and R1 refuses it');
  assert.equal(await sql(`select string_agg(user_id::text || ':' || role, ',') from public.brand_memberships where brand_id = ${lit(ws)}`), `${someone}:owner`, 'the ROLLBACK removed the second owner');
});

test_('Q3: the owner runs R0 / R1 / T13 without any API grant; any OTHER role needs a reviewed grant; authenticated keeps only R0 / R1 (the PostgREST path); anon / service_role reach none', async () => {
  const fns: [string, string][] = [['R0', 'public.common_account_bootstrap_verdict(text,text)'], ['R1', 'public.common_account_authorization_verdict(text,text,text)'],
    ['T13', 'private.account_lifecycle_assert_active_service_write(uuid,text)']];
  const expect: Record<string, string> = { [owner]: 'true,true,true', authenticated: 'true,true,false', anon: 'false,false,false', service_role: 'false,false,false', [other]: 'false,false,false' };
  for (const [role, want] of Object.entries(expect)) {
    const got = (await Promise.all(fns.map(([, f]) => sql(`select has_function_privilege('${role}', '${f}', 'EXECUTE')::text`)))).join(',');
    assert.equal(got, want, role);
  }
  assert.equal(await sql(`select (select rolsuper from pg_roles where rolname = current_user)::text || ',' ||
    (select count(*) from pg_roles a where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator') and pg_has_role(a.oid, current_user, 'MEMBER'))`), 'false,0',
    'the transport\'s owner is not a superuser and no API role is a member of it (H5\'s own check)');
});

test_('claims the transport must set: JSON claims with role authenticated and the session id; without session_id R1 refuses and T13 raises; mixing a per-claim sub with JSON claims is refused', async () => {
  const p = await person();
  const noSession = await run(owner, [], `begin isolation level read committed;
select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: p.user, role: 'authenticated' }))}, true) \\g /dev/null
select 'R0|' || public.common_account_bootstrap_verdict('postona', 'threads_connect_bootstrap')::text;
rollback;`);
  assert.equal(JSON.parse(lines(noSession.out).R0).reason, 'AUTH_REQUIRED');
  const t13 = await run(owner, [], beginScript(p, { claims: JSON.stringify({ sub: p.user, role: 'authenticated' }), r0: false }));
  assert.ok(!t13.ok && /AUTH_REQUIRED/u.test(t13.error), `T13 needs the session too: ${t13.error}`);
  const mixed = await run(owner, [], `begin isolation level read committed;
select set_config('request.jwt.claim.sub', '${p.user}', true) \\g /dev/null
select set_config('request.jwt.claims', ${lit(claimsOf(p))}, true) \\g /dev/null
select 'R0|' || public.common_account_bootstrap_verdict('postona', 'threads_connect_bootstrap')::text;
rollback;`);
  assert.equal(JSON.parse(lines(mixed.out).R0).reason, 'AUTH_REQUIRED', 'a per-claim sub without the per-claim role / session wins and is refused');
});

test_('no network', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
