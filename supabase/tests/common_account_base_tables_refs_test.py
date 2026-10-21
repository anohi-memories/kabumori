"""Offline test of the G5-14 read-only reference extractor (common_account_base_tables_refs.py) on a synthetic tree: a CREATE of the table counts as a
create only for that table (an FK inside another table's CREATE is a foreign key), grants, policies, catalog assertions, writes, a Data API call in app
code and a commented-out line. No database, no network. Usage: python3 -B supabase/tests/common_account_base_tables_refs_test.py"""
import json
import os
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(here, 'common_account_base_tables_refs.py')
FILES = {
    'supabase/migrations/001_child.sql': """create table public.brand_memberships (brand_id text not null references public.brands(id), user_id uuid);
grant select on table public.brands, public.social_accounts to authenticated;
create policy p on public.brands for select to authenticated using (true);
-- create table public.brands (id text);
do $$ begin if to_regclass('public.social_account_oauth_states') is null then raise exception 'missing'; end if; end $$;
insert into public.published_content_fingerprints (id) values (1);
""",
    'supabase/tests/fixture.sql': """create table public.brands (id text primary key, display_name text);
""",
    'apps/x/src/repo.ts': """const { data } = await client.from('social_accounts').select('id,brand_id');
const other = client.from('brand_memberships');
""",
    'supabase/functions/f/live.ts': """const rows = await userRead(tableUrl("brands", { select: "id" }), bearer);
""",
}

with tempfile.TemporaryDirectory() as d:
    for rel, text in FILES.items():
        os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
        with open(os.path.join(d, rel), 'w', encoding='utf-8') as f:
            f.write(text)
    refs = json.loads(subprocess.run([sys.executable, '-B', TOOL, d, '--json'], capture_output=True, text=True, check=True).stdout)
    by = {}
    for r in refs:
        by.setdefault((r['table'], r['area']), []).append(r['kind'])
    failures = []

    def check(cond, label):
        if not cond:
            failures.append(label)

    mig_brands = by.get(('brands', 'migration'), [])
    check('create table' not in mig_brands and 'foreign key' in mig_brands, f'an FK inside another CREATE is not a create of brands: {mig_brands}')
    check('grant / revoke' in mig_brands and 'policy' in mig_brands, f'grant and policy on brands: {mig_brands}')
    check(by.get(('social_accounts', 'migration')) == ['grant / revoke'], f'a multi-table grant names social_accounts: {by.get(("social_accounts", "migration"))}')
    check(by.get(('social_account_oauth_states', 'migration')) == ['catalog assertion'], 'a to_regclass check is a catalog assertion')
    check(by.get(('published_content_fingerprints', 'migration')) == ['write (insert / update / delete)'], 'an insert is a write')
    check(by.get(('brands', 'test fixture / test')) == ['create table'], 'the fixture CREATE counts as a create (in tests only)')
    check(by.get(('social_accounts', 'app')) == ['data api .from()'], 'a Data API call in app code')
    check(len(mig_brands) == 3 + 0, f'the commented-out CREATE is ignored: {mig_brands}')
    check(by.get(('brands', 'edge function')) == ['data api rest'], f'a REST Data API read in an Edge function: {by.get(("brands", "edge function"))}')
    if failures:
        print('FAIL\n  ' + '\n  '.join(failures))
        sys.exit(1)
    print('REFS_TEST_PASS 9 checks')
