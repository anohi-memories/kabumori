// G5-18: a local dry run of the managed read-only audit (supabase/preflight/managed_readonly_audit/audit.sql) on the full G5 test world. It must
// (1) print every section and END, inside a read-only transaction, changing nothing; (2) never print a planted canary -- a data row, a function body,
// a secret-bearing role setting, a table comment, a migration statement -- while printing the allowlisted setting and the md5; (3) refuse an injected
// write; (4) STOP at S0 when the transaction is not read-only. A local fact about the file; the managed run needs the user's approval (gate G0).
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE / PGSUPER / MA_AUDIT_DIR (the runner sets them).
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const db = Deno.env.get('PGDATABASE') ?? '';
const owner = Deno.env.get('PGUSER') ?? '';
const superUser = Deno.env.get('PGSUPER') ?? '';
const dir = Deno.env.get('MA_AUDIT_DIR') ?? '';
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-18 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

type Psql = { ok: boolean; out: string; error: string };
const env = (user: string) => ({ PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: user, PGDATABASE: db, LC_ALL: 'C' });
async function psqlAs(user: string, args: string[], cwd?: string): Promise<Psql> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], env: env(user), clearEnv: true, cwd, stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const sql = async (s: string) => { const r = await psqlAs(owner, ['-c', s]); if (!r.ok) throw new Error(r.error); return r.out; };
const superSql = async (s: string) => { const r = await psqlAs(superUser, ['-c', s]); if (!r.ok) throw new Error(r.error); return r.out; };
/** Run the audit file (or a variant of it written next to it) the way the operator would: psql -A -F '|' -f, from its own directory. */
async function audit(variant?: (text: string) => string): Promise<Psql> {
  let file = 'audit.sql';
  if (variant) {
    file = `audit_variant_${crypto.randomUUID()}.sql`;
    Deno.writeTextFileSync(`${dir}/${file}`, variant(Deno.readTextFileSync(`${dir}/audit.sql`)));
  }
  try {
    return await psqlAs(owner, ['-F', '|', '-f', file], dir);
  } finally {
    if (variant) Deno.removeSync(`${dir}/${file}`);
  }
}
const fingerprint = () => sql(`select (select count(*) from pg_class) || '/' || (select count(*) from public.brands) || '/' || (select count(*) from pg_proc)`);
const SECTIONS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S8b', 'S9', 'S10', 'S11', 'S12', 'END'];

test_('the audit prints every section inside a READ ONLY transaction and changes nothing', async () => {
  const before = await fingerprint();
  const r = await audit();
  assert.ok(r.ok, r.error);
  for (const s of SECTIONS) assert.ok(r.out.includes(`## ${s} `), `section ${s}`);
  assert.ok(r.out.includes('read_only=on|isolation='), 'S0 reports a read-only transaction');
  assert.match(r.out, /\npublic\|common_accounts\|r\|[^|]+\|t\|f\|/u, 'S1 lists the G5 tables with RLS');
  assert.ok(r.out.includes('private.account_lifecycle_session_verdict()') && r.out.includes('row_security=off'), 'S4 lists G5 functions with their config');
  assert.ok(r.out.includes('## S10 migration history (versions and names only)\nabsent'), 'no migration history in the test world: absent');
  assert.equal(await fingerprint(), before, 'nothing changed');
});

test_('no canary leaks: data rows, function bodies, secret-bearing role settings, comments and migration statements are never printed; the allowlisted setting and the md5 are', async () => {
  await sql(`insert into public.brands (id, display_name) values ('g5_audit_canary', 'CANARY-ROW-SECRET-1');
    create function public.g5_audit_canary() returns text language sql as $$ select 'CANARY-FN-SECRET-3' $$;
    comment on table public.brands is 'CANARY-COMMENT-5'`);
  await superSql(`alter role authenticator set pgrst.jwt_secret = 'CANARY-ROLE-SECRET-4'; alter role authenticator set pgrst.db_schemas = 'public, graphql_public';
    create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);
    insert into supabase_migrations.schema_migrations values ('20990101000000', 'g5_canary_migration', array['select ''CANARY-STMT-6''']);
    grant usage on schema supabase_migrations to ${owner}; grant select on supabase_migrations.schema_migrations to ${owner}`);
  try {
    const r = await audit();
    assert.ok(r.ok, r.error);
    for (const canary of ['CANARY-ROW-SECRET-1', 'CANARY-FN-SECRET-3', 'CANARY-ROLE-SECRET-4', 'CANARY-COMMENT-5', 'CANARY-STMT-6', 'jwt_secret']) {
      assert.ok(!r.out.includes(canary), `${canary} must not be printed`);
    }
    assert.ok(r.out.includes('pgrst.db_schemas=public, graphql_public'), 'the allowlisted exposure setting is printed');
    const md5 = await sql(`select md5(prosrc) from pg_proc where proname = 'g5_audit_canary'`);
    assert.ok(r.out.includes(`public.g5_audit_canary()|`) && r.out.includes(md5), 'the canary function is listed by signature and md5 only');
    assert.ok(r.out.includes('20990101000000|g5_canary_migration'), 'the migration version and name are printed');
  } finally {
    await superSql(`alter role authenticator reset pgrst.jwt_secret; alter role authenticator reset pgrst.db_schemas; drop schema supabase_migrations cascade`);
    await sql(`delete from public.brands where id = 'g5_audit_canary'; drop function public.g5_audit_canary(); comment on table public.brands is null`);
  }
});

test_('an injected write fails inside the read-only transaction and leaves nothing', async () => {
  for (const write of [`insert into public.brands (id) values ('g5_audit_write');`, 'create table public.g5_audit_write (id int);', 'grant select on public.brands to anon;']) {
    const before = await fingerprint();
    const r = await audit((t) => t.replace('\nrollback;\n', `\n${write}\nrollback;\n`));
    assert.ok(!r.ok && /read-only transaction/u.test(r.error), `${write} -> ${r.error.split('\n').find((l) => l.includes('ERROR'))}`);
    assert.equal(await fingerprint(), before, `${write}: nothing written`);
  }
  assert.equal(await sql(`select has_table_privilege('anon', 'public.brands', 'SELECT')::text`), 'false');
});

test_('S0 STOPs a run whose transaction is not read-only, before any section is printed', async () => {
  const r = await audit((t) => t.replace('begin read only;', 'begin;'));
  assert.ok(!r.ok && /division by zero/u.test(r.error), r.error);
  assert.ok(!r.out.includes('## S1 '), 'nothing after S0 is printed');
});

test_('no network', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
