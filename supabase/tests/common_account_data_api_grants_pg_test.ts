// G5-12: the Supabase Data API change of 2026-10-30 against the common-account objects -- two databases built by the same owner, one with the
// pre-change default privileges (`before`) and one with the 2026-10-30 behaviour (`after`). Proves: the G5 objects come out with the SAME privileges
// either way (a db reset / preview branch after the change reproduces them), the two public G5 tables answer the same to anon / authenticated / another
// person / service_role, the read-only audit flags them only for review, and -- on TEST-ONLY tables -- what the change does, that RLS alone does not
// replace a missing grant, that a bulk grant over-exposes, and the standard pattern (create + RLS + policy + minimal grant together).
// A PASS is not a managed result. Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGSUPER / DAPI_BEFORE / DAPI_AFTER / DAPI_AUDIT (the runner sets them).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const owner = Deno.env.get('PGUSER') ?? '';
const BEFORE = Deno.env.get('DAPI_BEFORE') ?? '';
const AFTER = Deno.env.get('DAPI_AFTER') ?? '';
const AUDIT = Deno.env.get('DAPI_AUDIT') ?? '';
const decoder = new TextDecoder();
if (enabled && (!BEFORE || !AFTER)) throw new Error('DAPI_BEFORE / DAPI_AFTER are required');
globalThis.fetch = (() => { throw new Error('the G5-12 tests make no network request'); }) as typeof fetch;

type Psql = { ok: boolean; out: string; error: string };
const env = (db: string) => ({ PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: owner, PGDATABASE: db, LC_ALL: 'C' });
async function run(db: string, args: string[]): Promise<Psql> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], env: env(db), clearEnv: true, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const psql = (db: string, statement: string) => run(db, ['-c', statement]);
async function sql(db: string, statement: string): Promise<string> {
  const r = await psql(db, statement);
  if (!r.ok) throw new Error(r.error);
  return r.out;
}
const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
const test_ = enabled ? test : test.skip;
const BOTH = [['before', () => BEFORE], ['after', () => AFTER]] as const;
const DENIED = /permission denied for (table|sequence|column)|permission denied for relation/u;
/** As an API role with a person's claims (the role switch PostgREST does). */
const as = (role: string, user: string | null, statement: string) =>
  `begin; ${user ? `set local request.jwt.claims = ${lit(JSON.stringify({ sub: user, role: 'authenticated', session_id: randomUUID() }))};` : ''} set local role ${role}; ${statement}; commit`;

// the G5 relations: the two public tables, every private.account_lifecycle_* relation (tables, the backfill view, the owner-epoch table)
const G5_RELATIONS = `(n.nspname = 'public' and c.relname in ('common_accounts', 'service_entitlements')) or (n.nspname = 'private' and c.relname like 'account_lifecycle%')`;
const FINGERPRINT = `select string_agg(line, E'\\n' order by line) from (
  select 'rel ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity || ' acl=' || coalesce(array_to_string(c.relacl::text[], ','), '-') as line
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${G5_RELATIONS}
  union all
  select 'col ' || n.nspname || '.' || c.relname || '.' || a.attname || ' acl=' || array_to_string(a.attacl::text[], ',')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where (${G5_RELATIONS}) and a.attacl is not null and not a.attisdropped
  union all
  select 'pol ' || n.nspname || '.' || c.relname || '.' || p.polname || ' ' || p.polcmd::text || ' to=' || array_to_string(p.polroles::regrole[]::text[], ',')
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where ${G5_RELATIONS}
  union all
  select 'fn ' || p.oid::regprocedure::text || ' acl=' || coalesce(array_to_string(p.proacl::text[], ','), '-')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'private' and p.proname like 'account_lifecycle%')
      or (n.nspname = 'public' and (p.proname like '%common_account%' or p.proname like '%_service' or p.proname like '%service_deletion%'
                                    or p.proname in ('ensure_my_profile', 'common_account_brand_service_state')))
) x`;

async function person(db: string): Promise<string> {
  const user = randomUUID();
  await sql(db, `select public.fixture_login('${user}'::uuid)`);
  const r = await sql(db, as('authenticated', user, "select public.start_x_autopost_service() ->> 'status'"));
  assert.equal(r, 'active');
  return user;
}

// =============================================================================================================================================
test_('reset reproducibility: every G5 relation, column grant, policy and function comes out with the SAME privileges under the pre- and the post-2026-10-30 defaults', async () => {
  const before = await sql(BEFORE, FINGERPRINT);
  const after = await sql(AFTER, FINGERPRINT);
  assert.ok(before.split('\n').length > 60, `the fingerprint covers the G5 objects (${before.split('\n').length} lines)`);
  assert.equal(after, before, 'identical');
  // the public G5 tables: RLS on, owner + column SELECT for authenticated only; no table-level API grant
  for (const t of ['common_accounts', 'service_entitlements']) {
    assert.ok(before.includes(`rel public.${t} r rls=true acl=${owner}=arwdDxtm/${owner}`), `${t}: owner-only table ACL`);
  }
  assert.ok(!/ (anon|service_role)=/u.test(before.split('\n').filter((l) => l.startsWith('rel ') || l.startsWith('col ')).join('\n')), 'no anon / service_role grant on any G5 relation or column');
});

test_('the two public G5 tables answer the same in both worlds: anon and service_role denied, authenticated sees its own row and only the granted columns, nobody writes', async () => {
  for (const [label, db] of BOTH) {
    const a = await person(db());
    const b = await person(db());
    for (const t of ['common_accounts', 'service_entitlements']) {
      for (const role of ['anon', 'service_role']) {
        const r = await psql(db(), as(role, role === 'anon' ? null : a, `select count(*) from public.${t}`));
        assert.ok(!r.ok && DENIED.test(r.error), `${label}: ${role} reads ${t} (${r.out})`);
      }
      assert.equal(await sql(db(), as('authenticated', a, `select string_agg(user_id::text, ',') from public.${t}`)), a, `${label}: ${t} shows A only its own row (not B ${b})`);
      for (const write of [`insert into public.${t} (user_id) values ('${randomUUID()}')`, `update public.${t} set updated_at = now()`, `delete from public.${t}`]) {
        const r = await psql(db(), as('authenticated', a, write));
        assert.ok(!r.ok && DENIED.test(r.error), `${label}: authenticated cannot write ${t} (${write})`);
      }
    }
    const col = await psql(db(), as('authenticated', a, `select source from public.service_entitlements`));
    assert.ok(!col.ok && DENIED.test(col.error), `${label}: a column outside the grant is denied`);
    assert.match(await sql(db(), as('authenticated', a, `select status || '/' || lifecycle_version from public.common_accounts`)), /^active\/[1-9][0-9]*$/u, `${label}: the granted columns read`);
  }
});

test_('the read-only audit: the G5 public tables are flagged only REVIEW (authenticated, SELECT, RLS on), the same in both worlds; nothing is written', async () => {
  for (const [label, db] of BOTH) {
    const rows = (await run(db(), ['-F', '|', '-f', AUDIT])).out.split('\n').filter((l) => /^public\.(common_accounts|service_entitlements)\|/u.test(l));
    assert.deepEqual(rows, ['public.common_accounts|table|authenticated|SELECT|t|1|REVIEW', 'public.service_entitlements|table|authenticated|SELECT|t|1|REVIEW'], label);
  }
  const audit = Deno.readTextFileSync(AUDIT).toLowerCase().replace(/--[^\n]*/gu, '');
  for (const banned of ['insert ', 'update ', 'delete ', 'grant ', 'revoke ', 'alter ', 'create ', 'drop ', 'truncate ']) assert.ok(!audit.includes(banned), `the audit is read-only (${banned})`);
});

test_('what the change does, on TEST-ONLY tables: an implicit table loses the API; RLS alone does not replace a grant; a bulk grant over-exposes; the standard pattern is the same in both worlds; serial needs a sequence grant, identity does not', async () => {
  const me = randomUUID();
  const other = randomUUID();
  try {
    for (const [label, db] of BOTH) {
      await sql(db(), `create table public.dapi_implicit (id uuid primary key default gen_random_uuid(), user_id uuid not null, note text);
        insert into public.dapi_implicit (user_id, note) values ('${me}', 'mine'), ('${other}', 'theirs')`);
      const anon = await psql(db(), as('anon', null, 'select count(*) from public.dapi_implicit'));
      if (label === 'before') assert.ok(anon.ok && anon.out === '2', 'before: the default grant hands anon EVERY row of a new table');
      else assert.ok(!anon.ok && DENIED.test(anon.error), `after: a new table without a grant is not reachable (42501) -- got ${anon.out} ${anon.error}`);
      // RLS + a policy but still no grant: denied after the change
      await sql(db(), `alter table public.dapi_implicit enable row level security;
        create policy dapi_own on public.dapi_implicit for select to authenticated using (user_id = (select auth.uid()))`);
      const rlsOnly = await psql(db(), as('authenticated', me, 'select count(*) from public.dapi_implicit'));
      if (label === 'before') assert.ok(rlsOnly.ok && rlsOnly.out === '1', 'before: the implicit grant + RLS shows the own row');
      else assert.ok(!rlsOnly.ok && DENIED.test(rlsOnly.error), 'after: RLS alone does not replace the missing grant');
    }
    // the anti-pattern: the changelog's bulk grant to all three roles on a table WITHOUT RLS -> anon reads everything; the audit says so
    await sql(AFTER, `create table public.dapi_bulk (id uuid primary key default gen_random_uuid(), user_id uuid not null, note text);
      insert into public.dapi_bulk (user_id, note) values ('${me}', 'mine'), ('${other}', 'theirs');
      grant select, insert, update, delete on public.dapi_bulk to anon, authenticated, service_role`);
    assert.equal(await sql(AFTER, as('anon', null, 'select count(*) from public.dapi_bulk')), '2', 'a bulk grant without RLS: anon reads every row');
    const flags = (await run(AFTER, ['-F', '|', '-f', AUDIT])).out.split('\n').filter((l) => l.startsWith('public.dapi_bulk|'));
    assert.deepEqual(flags.map((l) => `${l.split('|')[2]}:${l.split('|').pop()}`), ['anon:GRANT_WITHOUT_RLS', 'authenticated:GRANT_WITHOUT_RLS', 'service_role:GRANT_WITHOUT_RLS']);
    // the standard pattern, all in ONE migration: create + RLS + policy + revoke the defaults + the minimal grant (identity key: no sequence grant)
    const STANDARD = `create table public.dapi_standard (id bigint generated always as identity primary key, user_id uuid not null, note text, secret text);
      alter table public.dapi_standard enable row level security;
      create policy dapi_standard_own_select on public.dapi_standard for select to authenticated using (user_id = (select auth.uid()));
      create policy dapi_standard_own_insert on public.dapi_standard for insert to authenticated with check (user_id = (select auth.uid()));
      revoke all on table public.dapi_standard from public, anon, authenticated, service_role;
      grant select (id, user_id, note), insert (user_id, note) on table public.dapi_standard to authenticated;
      insert into public.dapi_standard (user_id, note, secret) values ('${me}', 'mine', 's1'), ('${other}', 'theirs', 's2')`;
    const acl: string[] = [];
    for (const [label, db] of BOTH) {
      await sql(db(), STANDARD);
      acl.push(await sql(db(), `select coalesce(array_to_string(relacl::text[], ','), '-') || ' ' || (select string_agg(attname || '=' || array_to_string(attacl::text[], ','), ' ' order by attnum)
        from pg_attribute where attrelid = 'public.dapi_standard'::regclass and attacl is not null) from pg_class where oid = 'public.dapi_standard'::regclass`));
      const anon = await psql(db(), as('anon', null, 'select count(*) from public.dapi_standard'));
      assert.ok(!anon.ok && DENIED.test(anon.error), `${label}: anon denied`);
      assert.equal(await sql(db(), as('authenticated', me, 'select string_agg(note, \',\') from public.dapi_standard')), 'mine', `${label}: own row only`);
      const secret = await psql(db(), as('authenticated', me, 'select secret from public.dapi_standard'));
      assert.ok(!secret.ok && DENIED.test(secret.error), `${label}: an ungranted column is denied`);
      assert.ok((await psql(db(), as('authenticated', me, `insert into public.dapi_standard (user_id, note) values ('${me}', 'new')`))).ok, `${label}: own insert works with an identity key and no sequence grant`);
      const forged = await psql(db(), as('authenticated', me, `insert into public.dapi_standard (user_id, note) values ('${other}', 'forged')`));
      assert.ok(!forged.ok && /row-level security/u.test(forged.error), `${label}: inserting for someone else is refused by RLS`);
      const svc = await psql(db(), as('service_role', null, 'select count(*) from public.dapi_standard'));
      assert.ok(!svc.ok && DENIED.test(svc.error), `${label}: service_role is not granted (server-only access goes through reviewed functions)`);
    }
    assert.equal(acl[1], acl[0], 'the standard pattern gives the same privileges before and after the change');
    // serial vs identity after the change: a serial key needs USAGE on its sequence to insert through the API
    await sql(AFTER, `create table public.dapi_serial (id bigserial primary key, user_id uuid not null);
      alter table public.dapi_serial enable row level security;
      create policy dapi_serial_ins on public.dapi_serial for insert to authenticated with check (user_id = (select auth.uid()));
      grant insert (user_id) on table public.dapi_serial to authenticated`);
    const serial = await psql(AFTER, as('authenticated', me, `insert into public.dapi_serial (user_id) values ('${me}')`));
    assert.ok(!serial.ok && /permission denied for sequence/u.test(serial.error), `after: a serial key without a sequence grant cannot insert (${serial.error})`);
  } finally {
    for (const [, db] of BOTH) await sql(db(), 'drop table if exists public.dapi_implicit, public.dapi_bulk, public.dapi_standard, public.dapi_serial');
  }
});

test_('leads for other owners: the public relations of this test world whose privileges DIFFER between the two worlds (they still lean on the old defaults); no G5 relation is among them', async () => {
  const ACLS = `select string_agg(c.relname || ' ' || coalesce(array_to_string(c.relacl::text[], ','), '-'), E'\\n' order by c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')`;
  const parse = (text: string) => new Map(text.split('\n').map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)] as const));
  const before = parse(await sql(BEFORE, ACLS));
  const after = parse(await sql(AFTER, ACLS));
  const differ = [...before.keys()].filter((k) => before.get(k) !== after.get(k)).sort();
  console.log(`DAPI_LEADS ${differ.join(' ')}`);
  for (const g5 of ['common_accounts', 'service_entitlements']) assert.ok(!differ.includes(g5), `${g5} does not depend on the defaults`);
  assert.ok(differ.length > 0, 'the test world has relations that do (the fixture and other owners\' migrations)');
});

test_('no network: the model made no request', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
