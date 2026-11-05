// G5-02 task 8: G3 PR #644's notify() (FOR SHARE: account -> brand -> owner row, then the INSERT that checks G5's eligibility) against every
// kind of write that changes a person's personal-workspace eligibility, in two real PostgreSQL sessions, BEFORE and AFTER this tree's
// candidate (supabase/candidates/postona_workspace_ownership_lock). Run by postona_workspace_ownership_lock_run.sh on G4's personal world
// with G3 PR #644's own 17-step rollout. No network.
//   notify first : a test-only barrier (BEFORE INSERT on postona_x_resv.notifications, waiting on an advisory lock) holds notify() after its
//                  locks and its eligibility check; the write must WAIT until the notification commits
//   change first : the write's transaction is open; notify() must wait for it and then write NOTHING (the workspace is not the person's
//                  own personal one any more)
import assert from 'node:assert/strict';

const env = (k: string) => Deno.env.get(k) ?? '';
const HOST = env('G5WO_HOST'), PORT = env('G5WO_PORT'), DB = env('G5WO_DB'), OWNER = env('G5WO_OWNER'), SUPER = env('G5WO_SUPER');
const CANDIDATE = env('G5WO_CANDIDATE');
const enabled = HOST !== '' && DB !== '' && OWNER !== '' && SUPER !== '' && CANDIDATE !== '';
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const INSTALL = '001_workspace_ownership_lock.sql';
const ROLLBACK = '001_workspace_ownership_lock_rollback.sql';
const decoder = new TextDecoder();
const BARRIER = 424242;

type Result = { ok: boolean; out: string; error: string };
const args = (user: string) => ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', HOST, '-p', PORT, '-U', user, '-d', DB];
async function psql(user: string, extra: string[], stdin?: string): Promise<Result> {
  const child = new Deno.Command('psql', { args: [...args(user), ...extra], env: { LC_ALL: 'C' }, stdin: stdin === undefined ? 'null' : 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const o = await child.output();
  return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
}
async function sql(user: string, text: string): Promise<string> {
  const r = await psql(user, ['-c', text]);
  assert.ok(r.ok, `${text}\n${r.error}`);
  return r.out;
}
const ok = async (name: string, text?: string) => { const r = text === undefined ? await psql(OWNER, ['-f', `${CANDIDATE}/${name}`]) : await psql(OWNER, ['-f', '-'], text); assert.ok(r.ok, `${name}\n${r.error}`); };

// a session that stays open: statements are sent one by one, as a client would
class Session {
  #child: Deno.ChildProcess;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  constructor(readonly user: string, readonly name: string) {
    this.#child = new Deno.Command('psql', { args: args(user), env: { LC_ALL: 'C', PGAPPNAME: name }, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
    this.#writer = this.#child.stdin.getWriter();
  }
  async send(text: string) { await this.#writer.write(new TextEncoder().encode(`${text}\n`)); }
  async close(): Promise<Result> {
    await this.#writer.close();
    const o = await this.#child.output();
    return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
  }
}
const activity = (name: string) => sql(SUPER, `select coalesce(string_agg(state || ':' || coalesce(wait_event_type, '-') || ':' || coalesce(wait_event, '-'), ','), 'gone') from pg_stat_activity where application_name = '${name}'`);
async function until(name: string, pred: (a: string) => boolean, ms = 10_000): Promise<string> {
  const end = Date.now() + ms;
  let a = await activity(name);
  while (!pred(a) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    a = await activity(name);
  }
  return a;
}
// did <name> wait on a row / transaction lock within ms (not the test barrier)?
async function waitsOnRowLock(name: string, ms = 1500): Promise<boolean> {
  const a = await until(name, (x) => /^active:Lock:(tuple|transactionid)/u.test(x) || /^idle/u.test(x), ms);
  return /^active:Lock:(tuple|transactionid)/u.test(a);
}

// ---- people: G4's world helpers, as a person signs up and starts POSTONA, and G4's personal provisioner -------------------------------
type Person = { id: string; ws: string };
let n = 0;
async function person(): Promise<Person> {
  const id = crypto.randomUUID();
  const session = crypto.randomUUID();
  await sql(SUPER, `select public.fixture_login('${id}'); insert into auth.sessions (id, user_id) values ('${session}', '${id}')`);
  const claims = JSON.stringify({ sub: id, role: 'authenticated', session_id: session, is_anonymous: false });
  await sql(OWNER, `begin;
    select set_config('request.jwt.claims', '${claims}', true), set_config('request.jwt.claim.sub', '${id}', true), set_config('request.jwt.claim.role', 'authenticated', true),
           set_config('request.jwt.claim.session_id', '${session}', true), set_config('request.jwt.claim.is_anonymous', 'false', true);
    select public.start_x_autopost_service();
    select private.social_mobile_ensure_personal_workspace('${id}');
    commit;`);
  const ws = await sql(SUPER, `select 'u_' || substr(md5('${id}'), 1, 24)`);
  assert.equal(await sql(OWNER, `select private.postona_personal_workspace_eligibility('${id}')`), 'own');
  return { id, ws };
}
// <notifications>/<outbox rows> of one event key
const noted = async (key: string) => (await sql(SUPER, `select count(*) || '/' || count(o.notification_id) from postona_x_resv.notifications n left join postona_x_resv.push_outbox o on o.notification_id = n.id where n.event_key = '${key}'`)).split('/').map(Number);
const notifySql = (p: Person, key: string) => `select postona_x_resv.notify('${p.id}', '${p.ws}', '${key}', 'approval_requested', null, null, 1, 'pending', null);`;
const newKey = () => `approval_requested:${crypto.randomUUID()}`;

// ---- the writes that change the person's eligibility (and their undo) -----------------------------------------------------------------
// cascades: the write deletes the workspace, and with it a notification written before it (G3's foreign key)
type Write = { label: string; user: string; sql: string; reset: string; covered: 'g3' | 'g5'; cascades?: boolean };
function writes(P: Person, Q: Person): Write[] {
  const k = ++n;
  return [
    { label: 'another member joins (INSERT)', user: OWNER, covered: 'g5', sql: `insert into public.brand_memberships (brand_id, user_id, role) values ('${P.ws}', '${Q.id}', 'member');`,
      reset: `delete from public.brand_memberships where brand_id = '${P.ws}' and user_id = '${Q.id}'` },
    { label: 'a second owner joins (INSERT)', user: OWNER, covered: 'g5', sql: `insert into public.brand_memberships (brand_id, user_id, role) values ('${P.ws}', '${Q.id}', 'owner');`,
      reset: `delete from public.brand_memberships where brand_id = '${P.ws}' and user_id = '${Q.id}'` },
    { label: 'the person becomes the owner of another brand (INSERT)', user: OWNER, covered: 'g5',
      sql: `insert into public.brands (id, display_name, code_profile_key) values ('g5wo_b_${k}', 'Other', 'other_v1'); insert into public.brand_memberships (brand_id, user_id, role) values ('g5wo_b_${k}', '${P.id}', 'owner');`,
      reset: `delete from public.brands where id = 'g5wo_b_${k}'` },
    { label: 'a member moves in (UPDATE)', user: OWNER, covered: 'g5',
      sql: `update public.brand_memberships set brand_id = '${P.ws}' where brand_id = 'g5wo_z_${k}' and user_id = '${Q.id}';`,
      reset: `delete from public.brand_memberships where brand_id = '${P.ws}' and user_id = '${Q.id}'; delete from public.brands where id = 'g5wo_z_${k}'` },
    { label: 'service_role inserts a member directly (Data API path)', user: SUPER, covered: 'g5',
      sql: `set role service_role; insert into public.brand_memberships (brand_id, user_id, role) values ('${P.ws}', '${Q.id}', 'member');`,
      reset: `delete from public.brand_memberships where brand_id = '${P.ws}' and user_id = '${Q.id}'` },
    // controls: G3's own FOR SHARE locks already serialize these (before and after)
    { label: 'control: the owner row is deleted', user: OWNER, covered: 'g3', sql: `delete from public.brand_memberships where brand_id = '${P.ws}' and user_id = '${P.id}';`,
      reset: `insert into public.brand_memberships (brand_id, user_id, role) values ('${P.ws}', '${P.id}', 'owner') on conflict do nothing` },
    { label: 'control: the workspace is deleted', user: OWNER, covered: 'g3', cascades: true, sql: `delete from public.brands where id = '${P.ws}';`,
      reset: `insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key) values ('${P.ws}', 'My Workspace', false, 'disabled', 'social_mobile_user_v1');
              insert into public.brand_memberships (brand_id, user_id, role) values ('${P.ws}', '${P.id}', 'owner')` },
  ];
}
async function prepare(w: Write, P: Person, Q: Person) {
  const m = w.sql.match(/g5wo_z_(\d+)/u);
  if (m) {
    await sql(SUPER, `insert into public.brands (id, display_name, code_profile_key) values ('g5wo_z_${m[1]}', 'Z', 'z_v1') on conflict do nothing;
      insert into public.brand_memberships (brand_id, user_id, role) values ('g5wo_z_${m[1]}', '${Q.id}', 'member') on conflict do nothing`);
  }
  assert.equal(await sql(OWNER, `select private.postona_personal_workspace_eligibility('${P.id}')`), 'own', `${w.label}: own before`);
}

// one race; the answer: did the second party wait on a row lock, and how many notifications / outbox rows were added
async function race(order: 'notify_first' | 'change_first', w: Write, P: Person, Q: Person) {
  await prepare(w, P, Q);
  const key = newKey();
  let waited: boolean;
  let results: Result[];
  if (order === 'notify_first') {
    const bar = new Session(SUPER, 'g5wo_bar');
    await bar.send(`select pg_advisory_lock(${BARRIER});`);
    await until('g5wo_bar', (a) => /^idle:/u.test(a));
    const N = new Session(OWNER, 'g5wo_n');
    await N.send('begin;');
    await N.send(notifySql(P, key));
    await N.send('commit;');
    assert.match(await until('g5wo_n', (a) => /^active:Lock:advisory/u.test(a)), /^active:Lock:advisory/u, `${w.label}: notify held at the barrier`);
    const W = new Session(w.user, 'g5wo_w');
    await W.send('begin;');
    await W.send(w.sql);
    await W.send('commit;');
    waited = await waitsOnRowLock('g5wo_w');
    await bar.send(`select pg_advisory_unlock(${BARRIER});`);
    results = [await bar.close(), await N.close(), await W.close()];
  } else {
    const W = new Session(w.user, 'g5wo_w');
    await W.send('begin;');
    await W.send(w.sql);
    await until('g5wo_w', (a) => /^idle in transaction:/u.test(a));
    const N = new Session(OWNER, 'g5wo_n');
    await N.send('begin;');
    await N.send(notifySql(P, key));
    await N.send('commit;');
    waited = await waitsOnRowLock('g5wo_n');
    await W.send('commit;');
    results = [await W.close(), await N.close()];
  }
  for (const r of results) assert.ok(r.ok, r.error);
  const [delta, outbox] = await noted(key);
  await sql(SUPER, w.reset);
  assert.equal(await sql(OWNER, `select private.postona_personal_workspace_eligibility('${P.id}')`), 'own', `${w.label}: own again after the reset`);
  return { waited, delta, outbox };
}

const STATE = { P: null as Person | null, Q: null as Person | null };
const FOUND: Record<string, string> = {};
Deno.test({ name: 'setup: two people with their personal workspaces (G4\'s provisioner), the test barrier on G3\'s notifications; the world has no ownership lock yet', ...opts }, async () => {
  STATE.P = await person();
  STATE.Q = await person();
  await sql(SUPER, `create function public.g5wo_barrier() returns trigger language plpgsql as $f$ begin perform pg_advisory_lock(${BARRIER}); perform pg_advisory_unlock(${BARRIER}); return new; end $f$;
    create trigger g5wo_barrier before insert on postona_x_resv.notifications for each row execute function public.g5wo_barrier();
    -- TEST WORLD: G4's world logs every brands / brand_memberships write into its mock schema (zz_postona_mock_log); let the service_role
    -- writer below log too, as the owner's writes do (nothing else of this world is changed)
    grant usage on schema postona_mock to service_role; grant insert on all tables in schema postona_mock to service_role;
    grant usage on all sequences in schema postona_mock to service_role`);
  assert.equal(await sql(SUPER, `select count(*) from pg_trigger where tgname = 'postona_workspace_ownership_lock'`), '0');
  // what can write memberships here (measured): the owner and service_role, directly
  assert.equal(await sql(SUPER, `select string_agg(r.rolname || ':' || k, ' ' order by r.rolname, k) from pg_roles r, unnest(array['INSERT','UPDATE']) k where r.rolname in ('anon', 'authenticated', 'service_role') and has_table_privilege(r.oid, 'public.brand_memberships', k)`),
    'service_role:INSERT service_role:UPDATE');
});

Deno.test({ name: 'BEFORE (G3 PR #644 alone): an INSERT / UPDATE that makes the workspace not personal does not wait for a notification being written, and a notification is written while such a change is in flight (each FAIL reproduced); the DELETE / account controls already serialize', ...opts }, async () => {
  const { P, Q } = STATE as { P: Person; Q: Person };
  for (const w of writes(P, Q)) {
    const nf = await race('notify_first', w, P, Q);
    const cf = await race('change_first', w, P, Q);
    FOUND[`before ${w.label}`] = `notify-first: writer waited=${nf.waited} (+${nf.delta}); change-first: notify waited=${cf.waited}, +${cf.delta}/${cf.outbox}`;
    if (w.covered === 'g5') {
      assert.equal(nf.waited, false, `${w.label}: FAIL reproduced (the change commits while the notification checked before it is still being written)`);
      assert.deepEqual([cf.waited, cf.delta, cf.outbox], [false, 1, 1], `${w.label}: FAIL reproduced (a notification for a workspace no longer personal)`);
    } else {
      assert.deepEqual([nf.waited, nf.delta], [true, w.cascades ? 0 : 1], `${w.label}: G3 already waits`);
      assert.deepEqual([cf.waited, cf.delta], [true, 0], `${w.label}: G3 already writes nothing`);
    }
  }
  console.log(`G5-02 #8 BEFORE ${JSON.stringify(FOUND, null, 0)}`);
});

Deno.test({ name: 'install: refuses a superuser, changing nothing; installs as the table owner; a re-run changes nothing', ...opts }, async () => {
  const fp = () => sql(SUPER, `select md5(coalesce(string_agg(x, '|' order by x), '')) from (select tgname || ':' || tgtype || ':' || tgfoid::regprocedure::text x from pg_trigger where tgrelid = 'public.brand_memberships'::regclass and not tgisinternal
    union all select p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '-') from pg_proc p where p.proname = 'postona_workspace_ownership_lock') s`);
  const none = await fp();
  const r = await psql(SUPER, ['-f', `${CANDIDATE}/${INSTALL}`]);
  assert.ok(!r.ok && /WO_SUPERUSER/u.test(r.error), r.error);
  assert.equal(await fp(), none);
  await ok(INSTALL);
  const one = await fp();
  await ok(INSTALL);
  assert.equal(await fp(), one, 'a re-run changes nothing');
});

Deno.test({ name: 'AFTER: each such INSERT / UPDATE waits until the notification being written commits, and a notification waits for such a change and then writes nothing (0 notifications, 0 outbox rows); the controls still serialize', ...opts }, async () => {
  const { P, Q } = STATE as { P: Person; Q: Person };
  const after: Record<string, string> = {};
  for (const w of writes(P, Q)) {
    const nf = await race('notify_first', w, P, Q);
    const cf = await race('change_first', w, P, Q);
    after[w.label] = `notify-first: writer waited=${nf.waited} (+${nf.delta}); change-first: notify waited=${cf.waited}, +${cf.delta}/${cf.outbox}`;
    assert.deepEqual([nf.waited, nf.delta], [true, w.cascades ? 0 : 1], `${w.label}: PASS (the change waits for the notification's commit)`);
    assert.deepEqual([cf.waited, cf.delta, cf.outbox], [true, 0, 0], `${w.label}: PASS (nothing written for a workspace that stopped being personal)`);
  }
  console.log(`G5-02 #8 AFTER ${JSON.stringify(after, null, 0)}`);
});

Deno.test({ name: 'regressions: G4\'s provisioner still makes a personal workspace; one notification per event key; a writer that takes the brand row before the account deadlocks against a notification and PostgreSQL aborts one (nothing inconsistent committed); the rollback reopens the race (re-detected) and a re-install closes it', ...opts }, async () => {
  const { P, Q } = STATE as { P: Person; Q: Person };
  const R = await person();
  assert.equal(await sql(SUPER, `select count(*) from public.brand_memberships where brand_id = '${R.ws}'`), '1');
  const key = newKey();
  for (let i = 0; i < 2; i++) await sql(OWNER, `select postona_x_resv.notify('${P.id}', '${P.ws}', '${key}', 'approval_requested', null, null, 1, 'pending', null)`);
  assert.equal(await sql(SUPER, `select count(*) from postona_x_resv.notifications where event_key = '${key}'`), '1');
  // a writer against the lock order (brands row first, then the membership) while a notification holds the account: a deadlock, one aborted
  const bar = new Session(SUPER, 'g5wo_bar');
  await bar.send(`select pg_advisory_lock(${BARRIER});`);
  await until('g5wo_bar', (a) => /^idle:/u.test(a));
  const W = new Session(OWNER, 'g5wo_w');
  await W.send('begin;');
  await W.send(`select 1 from public.brands where id = '${P.ws}' for update;`);
  await until('g5wo_w', (a) => /^idle in transaction:/u.test(a));
  const dkey = newKey();
  const N = new Session(OWNER, 'g5wo_n');
  await N.send('begin;');
  await N.send(notifySql(P, dkey));
  await N.send('commit;');
  await until('g5wo_n', (a) => /^active:Lock:/u.test(a));
  await W.send(`insert into public.brand_memberships (brand_id, user_id, role) values ('${P.ws}', '${Q.id}', 'member');`);
  await W.send('commit;');
  await new Promise((r) => setTimeout(r, 1500));
  await bar.send(`select pg_advisory_unlock(${BARRIER});`);
  const rs = [await bar.close(), await W.close(), await N.close()];
  const aborted = rs.filter((r) => /deadlock detected/u.test(r.error)).length;
  const member = await sql(SUPER, `select count(*) from public.brand_memberships where brand_id = '${P.ws}' and user_id = '${Q.id}'`);
  const [delta] = await noted(dkey);
  console.log(`G5-02 #8 lock-order deadlock: aborted ${aborted}, member committed ${member}, notifications +${delta}`);
  assert.equal(aborted, 1, 'PostgreSQL aborted one of the two');
  assert.ok((member === '1' && delta === 0) || (member === '0' && delta === 1), 'never both');
  await sql(SUPER, `delete from public.brand_memberships where brand_id = '${P.ws}' and user_id = '${Q.id}'`);
  // the rollback reopens the race; a re-install closes it again
  await ok(ROLLBACK);
  await ok(ROLLBACK);
  const open = await race('change_first', writes(P, Q)[0], P, Q);
  assert.deepEqual([open.waited, open.delta], [false, 1], 'rolled back: re-detected');
  await ok(INSTALL);
  const closed = await race('change_first', writes(P, Q)[0], P, Q);
  assert.deepEqual([closed.waited, closed.delta], [true, 0], 're-installed: closed');
});

Deno.test({ name: 'mutants: the workspace owners\' lock, the row person\'s lock, the UPDATE event and the lock itself are each load-bearing (each mutant reopens its own race; the reviewed file is restored)', ...opts }, async () => {
  const { P, Q } = STATE as { P: Person; Q: Person };
  const text = await Deno.readTextFile(`${CANDIDATE}/${INSTALL}`);
  const ws = writes(P, Q);
  const cases: Array<[string, Array<[string, string]>, Write]> = [
    ['MW1 the workspace owners are locked', [["\n          union all select m.user_id from public.brand_memberships m where m.brand_id in (new.brand_id, v_old_brand) and m.role = 'owner') x", ') x']], ws[0]],
    ['MW2 the row\'s person is locked', [['    from (select new.user_id as u\n          union all select v_old_user\n', '    from (select v_old_user as u\n']], ws[2]],
    ['MW3 UPDATE fires it', [['before insert or update on public.brand_memberships', 'before insert on public.brand_memberships'], ['and t.tgtype = 23', 'and t.tgtype = 7']], ws[3]],
    ['MW4 the accounts are locked', [['  perform 1 from public.common_accounts a where a.user_id = any (v_users) order by a.user_id for update;', '  perform 1;']], ws[0]],
  ];
  const killed: string[] = [];
  try {
    for (const [label, sites, w] of cases) {
      let m = text;
      for (const [from, to] of sites) {
        assert.equal(m.split(from).length, 2, `${label}: site`);
        m = m.replace(from, () => to);
      }
      const original = await race('change_first', w, P, Q);
      assert.deepEqual([original.waited, original.delta], [true, 0], `${label}: the original holds`);
      await ok(`${label} mutant`, m);
      try {
        const r = await race('change_first', w, P, Q);
        assert.deepEqual([r.waited, r.delta], [false, 1], `${label}: survived`);
        killed.push(label.split(' ')[0]);
      } finally {
        await ok(ROLLBACK);
        await ok(INSTALL);
      }
    }
  } finally {
    await ok(INSTALL);
  }
  console.log(`G5-02 #8 mutants killed ${killed.length} / ${cases.length}: ${killed.join(' ')}`);
  assert.equal(killed.length, cases.length);
});
