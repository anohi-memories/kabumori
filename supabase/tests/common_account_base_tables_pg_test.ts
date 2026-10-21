// G5-14: on an EMPTY database (API roles + a minimal auth.users / auth.uid() only), every main migration that needs one of the four POSTONA base tables
// refuses, names the missing table, and leaves nothing behind. The base tables are created by no migration, so a db reset / preview branch built from
// migrations alone cannot pass these files. A PASS is a local fact about the migration TEXT, not a statement about production.
// Needs CAL_E2E=1, PGHOST / PGPORT / PGUSER / PGDATABASE / BT_MIGRATIONS (the runner sets them).
import assert from 'node:assert/strict';
import test from 'node:test';

const enabled = Deno.env.get('CAL_E2E') === '1';
const dir = Deno.env.get('BT_MIGRATIONS') ?? '';
const decoder = new TextDecoder();
globalThis.fetch = (() => { throw new Error('the G5-14 tests make no network request'); }) as typeof fetch;
const test_ = enabled ? test : test.skip;

async function psql(args: string[]): Promise<{ ok: boolean; out: string; error: string }> {
  const out = await new Deno.Command('psql', { args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], stdout: 'piped', stderr: 'piped' }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), error: decoder.decode(out.stderr).trim() };
}
const objects = async () => (await psql(['-c', `select count(*) || '/' || coalesce(string_agg(n.nspname || '.' || c.relname, ',' order by 1), '')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')`])).out;

// Main migrations that need a base table. `names` = the refusal must name a base table (the file reaches that check first); null = the file
// refuses on an EARLIER prerequisite (its message is recorded, not claimed to be about the base tables).
const CASES: [string, RegExp | null][] = [
  ['20260918120000_social_mobile_brand_memberships.sql', /PHASE4_PREFLIGHT_MISSING_TABLE:brands/u],
  ['20260919120000_social_mobile_x_oauth_onboarding.sql', /relation "public\.social_accounts" does not exist/u],
  ['20260928160000_social_mobile_account_deletion_candidate.sql', null],
  ['20261006160000_vault_account_brand_post_completion.sql', null],
  ['20261007150000_postona_social_accounts_multi_provider.sql', /relation "public\.social_accounts" does not exist/u],
];

test_('on an empty database each base-table migration refuses (three of them by naming the base table) and leaves nothing', async () => {
  const before = await objects();
  for (const [file, names] of CASES) {
    const r = await psql(['-f', `${dir}/${file}`]);
    assert.ok(!r.ok, `${file} must not apply on an empty database`);
    const first = r.error.split('\n').find((l) => /ERROR/u.test(l)) ?? r.error;
    if (names) assert.match(first, names, `${file}: ${first}`);
    console.log(`BT_REFUSAL ${file} :: ${first.replace(/^psql:[^:]*:\d+: /u, '')}`);
    assert.equal(await objects(), before, `${file}: nothing left behind`);
  }
});

test_('the migrations never CREATE the four base tables (a file read of every migration)', () => {
  const create = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(brands|social_accounts|social_account_oauth_states|published_content_fingerprints)\s*\(/iu;
  let files = 0;
  for (const e of Deno.readDirSync(dir)) {
    if (!e.name.endsWith('.sql')) continue;
    files += 1;
    const text = Deno.readTextFileSync(`${dir}/${e.name}`).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.ok(!create.test(text), `${e.name} creates a base table`);
  }
  assert.ok(files > 100, `${files} migration files read`);
});

test_('no network', () => {
  assert.throws(() => globalThis.fetch('https://example.invalid/'), /no network request/u);
});
