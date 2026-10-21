"""Offline test of the G5-12 / G5-13 read-only scanner (common_account_data_api_grants_scan.py) on synthetic migrations: an explicit table, an implicit one, a
dropped one, an unqualified name, a serial and an identity key, a view, another schema (skipped), a schema-wide grant and a GRANT inside a function
body (reported apart). No database, no network. Usage: python3 -B supabase/tests/common_account_data_api_grants_scan_test.py"""
import json
import os
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
SCAN = os.path.join(here, 'common_account_data_api_grants_scan.py')
FILES = {
    '001_explicit.sql': """
create table public.good (id uuid primary key, user_id uuid not null);
alter table public.good enable row level security;
create policy good_own on public.good for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.good from public, anon, authenticated, service_role;
grant select (id, user_id) on table public.good to authenticated;
-- create table public.commented_out (id int);
""",
    '002_implicit.sql': """
create table bare (id bigserial primary key, note text);
create table "public"."quoted" (id bigint generated always as identity primary key);
create table private.hidden (id int);
create view public.v_good as select id from public.good;
create table public.gone (id int);
""",
    '004_base.sql': """
alter table public.legacy_base add column note text;
grant select on table public.legacy_base, public.legacy_other to authenticated;
create table public.child (id int primary key, base_id int references public.legacy_base (id));
do $$ begin if not has_table_privilege('anon', 'public.child', 'SELECT WITH GRANT OPTION') then raise notice 'no grant option'; end if; end $$;
""",
    '003_more.sql': """
drop table if exists public.gone;
grant select on all tables in schema public to anon;
create function public.f() returns void language plpgsql as $$ begin execute 'grant select on public.bare to anon'; end $$;
""",
}

with tempfile.TemporaryDirectory() as d:
    for name, text in FILES.items():
        with open(os.path.join(d, name), 'w', encoding='utf-8') as f:
            f.write(text)
    out = subprocess.run([sys.executable, '-B', SCAN, d, '--json'], capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    rows = {r['object']: r for r in data['objects']}
    failures = []

    def check(cond, label):
        if not cond:
            failures.append(label)

    check(sorted(rows) == ['bare', 'child', 'gone', 'good', 'quoted', 'v_good'], f'the public objects, another schema skipped, comments ignored: {sorted(rows)}')
    check(rows['good']['verdict'] == 'explicit' and rows['good']['rls'] and rows['good']['policies'] == 1, 'an explicit table')
    check(rows['good']['grants'].get('authenticated') and 'anon' not in rows['good']['grants'], 'the grant is recorded per role')
    check(rows['bare']['verdict'].startswith('IMPLICIT') and rows['bare']['serial'], 'an unqualified implicit table with a serial key')
    check(rows['quoted']['verdict'].startswith('IMPLICIT') and rows['quoted']['identity'] and not rows['quoted']['serial'], 'a quoted name with an identity key')
    check(rows['v_good']['verdict'].startswith('VIEW'), 'a view is reported apart')
    check(rows['gone']['verdict'].startswith('DROPPED'), 'a dropped table is not a lead')
    check(len(data['schema_wide']) == 1 and 'all tables in schema public' in data['schema_wide'][0][1], 'a schema-wide grant is reported')
    check(data['dynamic_grant_files'] == ['003_more.sql'], f'a GRANT inside a function body is reported apart; "grant option" text is not: {data["dynamic_grant_files"]}')
    check(data['not_created_by_any_migration'] == ['legacy_base', 'legacy_other'], f'objects changed / granted / referenced but never created: {data["not_created_by_any_migration"]}')
    if failures:
        print('FAIL\n  ' + '\n  '.join(failures))
        sys.exit(1)
    print('SCAN_TEST_PASS 10 checks')
