// G5-16: D-2 -- G4's minimal-grant proposal (column-level SELECT for `authenticated`, the Vault references and oauth_client_ref excluded) against
// the table / column ACL precondition of G4's own 20261007150000 (Phase 2a-2), taken VERBATIM from the migration file and run on a stand-in
// public.social_accounts with the contract's 14 columns. A local fact about the SQL TEXT; nothing about production, no G4 file changed.
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE / D2_REPO (the runner sets them).
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const repo = Deno.env.get('D2_REPO') ?? '';
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-16 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

async function psql(statement: string): Promise<{ ok: boolean; out: string; error: string }> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}

// the ACL precondition block, verbatim: from the "Table and column ACL" comment to the end if; after POSTONA_ACCOUNTS_PRECONDITION_ACL
function aclPrecondition(): string {
  const text = enabled ? Deno.readTextFileSync(`${repo}/supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql`) : '';
  const start = text.indexOf('  -- Table and column ACL: the owner; authenticated SELECT');
  const raise = text.indexOf("raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ACL';", start);
  const end = text.indexOf('end if;', raise) + 'end if;'.length;
  assert.ok(start > 0 && raise > start && end > raise, 'the block is found in the migration');
  return text.slice(start, end);
}
const check = (block: string) => `do $chk$ declare
  v_table oid := 'public.social_accounts'::regclass;
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass);
begin
${block}
end $chk$`;

// the 14 columns of the contract (20261007150000, the columns precondition)
const TABLE = `create table public.social_accounts (
  id text primary key, brand_id text not null, platform text not null default 'x', handle text not null default 'pending', platform_user_id text,
  connection_status text not null default 'unconnected', publish_enabled boolean not null default false, oauth_client_ref text not null default 'default',
  vault_access_token_secret_id uuid, vault_refresh_token_secret_id uuid, last_connection_error_code text, verified_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
insert into public.social_accounts (id, brand_id, vault_access_token_secret_id) values ('sa_one', 'b_one', '00000000-0000-4000-8000-0000000000aa')`;
const REVOKE = 'revoke all on table public.social_accounts from public, anon, authenticated, service_role';
const LAYOUTS: Record<string, string> = {
  contract: `${REVOKE}; grant select on table public.social_accounts to authenticated; grant select, insert, update, delete on table public.social_accounts to service_role`,
  g4_column_proposal: `${REVOKE}; grant select (id, brand_id, platform, handle, connection_status, publish_enabled, last_connection_error_code, platform_user_id)
    on table public.social_accounts to authenticated; grant select (id, brand_id, platform, handle, platform_user_id, connection_status, publish_enabled, oauth_client_ref,
    vault_access_token_secret_id, vault_refresh_token_secret_id) on table public.social_accounts to service_role`,
  r7_violation_allowed: `${REVOKE}; grant select on table public.social_accounts to authenticated; grant select, truncate, references on table public.social_accounts to service_role`,
};
async function layout(name: string) {
  const r = await psql(`drop table if exists public.social_accounts; ${TABLE}; ${LAYOUTS[name]}`);
  assert.ok(r.ok, `${name}: ${r.error}`);
}
const asAuthenticated = (select: string) => psql(`begin; set local role authenticated; select ${select} from public.social_accounts; commit`);

// the app's real select lists on social_accounts (supabase-repository.ts, onboarding-repository.ts)
function appSelects(): string[] {
  const out: string[] = [];
  for (const f of ['apps/social-mobile/src/data/supabase-repository.ts', 'apps/social-mobile/src/data/onboarding-repository.ts']) {
    const text = Deno.readTextFileSync(`${repo}/${f}`);
    for (const m of text.matchAll(/\.from\('social_accounts'\)\s*\.select\('([^']+)'\)/gu)) out.push(m[1]);
  }
  return out;
}

test_('D-2: the 20261007150000 ACL precondition (verbatim) accepts the contract layout and REFUSES G4\'s column-level proposal; it also accepts the R-7-violating service_role grants', async () => {
  const block = aclPrecondition();
  const results: string[] = [];
  for (const name of Object.keys(LAYOUTS)) {
    await layout(name);
    const r = await psql(check(block));
    const verdict = r.ok ? 'accepted' : (/POSTONA_ACCOUNTS_PRECONDITION_ACL/u.test(r.error) ? 'POSTONA_ACCOUNTS_PRECONDITION_ACL' : r.error);
    results.push(`${name}=${verdict}`);
  }
  console.log(`D2_PRECONDITION ${results.join(' ')}`);
  assert.deepEqual(results, ['contract=accepted', 'g4_column_proposal=POSTONA_ACCOUNTS_PRECONDITION_ACL', 'r7_violation_allowed=accepted']);
});

test_('D-2 / D-3: the contract lets a member read the Vault references; G4\'s column proposal refuses them and `select *`, and still serves the app\'s real select lists', async () => {
  const selects = appSelects();
  assert.equal(selects.length, 2, `the two app select lists are found: ${JSON.stringify(selects)}`);
  await layout('contract');
  assert.equal((await asAuthenticated('vault_access_token_secret_id::text')).out, '00000000-0000-4000-8000-0000000000aa', 'the contract exposes the Vault reference to authenticated');
  await layout('g4_column_proposal');
  for (const denied of ['vault_access_token_secret_id', 'vault_refresh_token_secret_id', 'oauth_client_ref', '*']) {
    const r = await asAuthenticated(denied);
    assert.ok(!r.ok && /permission denied/u.test(r.error), `${denied} is denied (${r.out})`);
  }
  for (const s of selects) {
    const r = await asAuthenticated(s);
    assert.ok(r.ok, `the app's select "${s}" works under the column proposal: ${r.error}`);
  }
  const svc = await psql(`begin; set local role service_role; select vault_access_token_secret_id::text from public.social_accounts; commit`);
  assert.ok(svc.ok && svc.out.endsWith('aa'), 'service_role keeps the Vault reference its Edge reader needs');
});

test_('only 20261007150000 asserts a table / column ACL on social_accounts (a file read of every migration)', () => {
  const dir = `${repo}/supabase/migrations`;
  const hits: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (!e.name.endsWith('.sql')) continue;
    const t = Deno.readTextFileSync(`${dir}/${e.name}`);
    if (/social_accounts/u.test(t) && /(attrelid = v_table and a\.attnum > 0 and a\.attacl is not null|'public\.social_accounts'::regclass and a\.attacl is not null)/u.test(t)) hits.push(e.name);
  }
  assert.deepEqual(hits, ['20261007150000_postona_social_accounts_multi_provider.sql']);
});

test_('no network', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
