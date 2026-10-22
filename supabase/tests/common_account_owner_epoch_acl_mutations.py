"""Mutation check for the G5-20 revision of the owner-epoch candidate's exposure check: ONE new rule (column write paths, the empty column-ACL
allowlist incl. system columns and PUBLIC, every privilege on the epoch history) is broken in a scratch COPY; the G5-20 deny-net suite
(common_account_owner_epoch_acl_pg_run.sh) must fail. A control must pass first. Usage (needs the socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_owner_epoch_acl_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch']
RUNNER = 'supabase/tests/common_account_owner_epoch_acl_pg_run.sh'
C = 'supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql'
BM = "'public.brand_memberships'"

M = [
    # ---- column-level write paths of anon / authenticated
    ('a column INSERT is accepted', f"\n                    and (pg_catalog.has_any_column_privilege(x.role_oid, {BM}, 'INSERT')\n                      or pg_catalog.has_any_column_privilege(x.role_oid, {BM}, 'UPDATE')",
     f"\n                    and (pg_catalog.has_any_column_privilege(x.role_oid, {BM}, 'UPDATE')"),
    ('a column UPDATE is accepted', f"\n                      or pg_catalog.has_any_column_privilege(x.role_oid, {BM}, 'UPDATE')\n                      or pg_catalog.has_any_column_privilege(x.role_oid, {BM}, 'REFERENCES'))) then 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'",
     f"\n                      or pg_catalog.has_any_column_privilege(x.role_oid, {BM}, 'REFERENCES'))) then 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'"),
    ('a column REFERENCES is accepted', f"\n                      or pg_catalog.has_any_column_privilege(x.role_oid, {BM}, 'REFERENCES'))) then 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'",
     ")) then 'API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN'"),
    ('the column write paths of anon are accepted', "                  where x.api in ('anon', 'authenticated')\n                    and (pg_catalog.has_any_column_privilege",
     "                  where x.api in ('authenticated')\n                    and (pg_catalog.has_any_column_privilege"),
    # ---- the empty column-ACL allowlist of the table
    ('system columns are ignored', f"where a.attrelid = {BM}::regclass and a.attacl is not null", f"where a.attrelid = {BM}::regclass and a.attnum > 0 and a.attacl is not null"),
    ('a PUBLIC column ACL is accepted', f"where a.attrelid = {BM}::regclass and a.attacl is not null\n                    and (e.grantee = 0 or e.grantee in",
     f"where a.attrelid = {BM}::regclass and a.attacl is not null\n                    and (e.grantee in"),
    ('only the API roles themselves are checked (no membership)', f"where a.attrelid = {BM}::regclass and a.attacl is not null\n                    and (e.grantee = 0 or e.grantee in (select x.role_oid from reach x)))",
     f"where a.attrelid = {BM}::regclass and a.attacl is not null\n                    and (e.grantee = 0 or e.grantee in (select x.role_oid from reach x where x.api = pg_catalog.pg_get_userbyid(x.role_oid))))"),
    ('the column-ACL allowlist rule is gone', "then 'API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL'", "and false then 'API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL'"),
    # ---- the epoch history
    ('TRIGGER on the history is accepted', "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'", "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, MAINTAIN'"),
    ('MAINTAIN on the history is accepted', "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'", "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'"),
    ('REFERENCES on the history is accepted', "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'", "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, MAINTAIN'"),
    ('the history table privileges are not checked', "                    and pg_catalog.has_table_privilege(x.role_oid, h.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'))",
     "                    and false)"),
    ('the history column ACLs are not checked', "      or exists (select 1 from history h, pg_catalog.pg_attribute a", "      or false and exists (select 1 from history h, pg_catalog.pg_attribute a"),
    ('a PUBLIC column ACL on the history is accepted', "where h.oid is not null and a.attrelid = h.oid and a.attacl is not null\n                    and (e.grantee = 0 or e.grantee in",
     "where h.oid is not null and a.attrelid = h.oid and a.attacl is not null\n                    and (e.grantee in"),
    # (G5-21 added a second `to_regclass` of the history in another function; the site names the exposure's own CTE)
    ('the history is never found', "  ), history as (\n    select pg_catalog.to_regclass('private.account_lifecycle_brand_owner_epochs') as oid",
     "  ), history as (\n    select pg_catalog.to_regclass('private.no_such_history') as oid"),
    ('only the API roles themselves are checked on the history', "    when exists (select 1 from reach x, history h\n                  where h.oid is not null\n",
     "    when exists (select 1 from reach x, history h\n                  where h.oid is not null and x.api = pg_catalog.pg_get_userbyid(x.role_oid)\n"),
]


def run(root):
    env = dict(os.environ, OA_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', os.path.join(root, RUNNER)], cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='oa-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
root = fresh_copy()
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
for label, old, new in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, C)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != 1:
            print(f'INVALID   {label}: the site occurs {text.count(old)} times', flush=True)
            invalid += 1
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        code = run(root)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
