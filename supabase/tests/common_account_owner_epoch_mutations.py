"""Mutation check for the brand OWNER EPOCH candidate (F5): ONE rule of the candidate SQL (the write events it records, the getter's refusals, the coverage check, the
history guard, the install reconciliation, the rollback, the ACL) is broken in a scratch COPY; the owner-epoch suite must fail. A control must pass first. Usage (needs the
socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_owner_epoch_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/functions', 'supabase/candidates/common_account_brand_owner_epoch']
RUNNER = 'supabase/tests/common_account_owner_epoch_run.sh'
C = 'supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql'
RB = 'supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch_rollback.sql'

M = [
    # ---- which writes are recorded
    ('an inserted owner is not recorded', C, "if tg_op = 'INSERT' then\n    if new.role = 'owner' then v_brands := array[new.brand_id]; end if;", "if tg_op = 'INSERT' then\n    if false then v_brands := array[new.brand_id]; end if;", RUNNER),
    ('a deleted owner is not recorded', C, "elsif tg_op = 'DELETE' then\n    if old.role = 'owner' then v_brands := array[old.brand_id]; end if;", "elsif tg_op = 'DELETE' then\n    if false then v_brands := array[old.brand_id]; end if;", RUNNER),
    ('owner -> admin is not recorded', C, "if old.role = 'owner' then v_brands := array[old.brand_id]; end if;\n    if new.role = 'owner' and", "if false then v_brands := array[old.brand_id]; end if;\n    if new.role = 'owner' and", RUNNER),
    ('admin -> owner is not recorded', C, "if new.role = 'owner' and not (new.brand_id = any (v_brands)) then", "if false then", RUNNER),
    ('a no-op update of an owner row is recorded', C, "elsif (old.brand_id, old.user_id, old.role) is distinct from (new.brand_id, new.user_id, new.role) then", "elsif true then", RUNNER),
    ('a change of the owner person on the same row is not recorded', C, "elsif (old.brand_id, old.user_id, old.role) is distinct from (new.brand_id, new.user_id, new.role) then", "elsif (old.brand_id, old.role) is distinct from (new.brand_id, new.role) then", RUNNER),
    ('one change on the same workspace is counted twice', C, "if new.role = 'owner' and not (new.brand_id = any (v_brands)) then", "if new.role = 'owner' then", RUNNER),
    ('a truncate is not recorded', C, "update private.account_lifecycle_brand_owner_epochs set epoch = epoch + 1, owner_user_id = null, owner_count = 0;", "null;", RUNNER),
    ('a bump does not move the number', C, "set epoch = e.epoch + 1, owner_user_id = excluded.owner_user_id", "set epoch = e.epoch, owner_user_id = excluded.owner_user_id", RUNNER),
    # ---- what the getter vouches for
    ('two or more owners (or none) have an epoch', C, "if pg_catalog.cardinality(v_owners) <> 1 or v_row.owner_count <> 1 or v_row.owner_user_id is distinct from v_owners[1] then\n    return null;", "if false then\n    return null;", RUNNER),
    ('a write that got past the trigger is not detected', C, "or v_row.owner_user_id is distinct from v_owners[1] then\n    return null;", " then\n    return null;", RUNNER),
    ('a broken coverage is not checked by the getter', C, "if p_brand_id is null or not private.account_lifecycle_brand_owner_epoch_covered() then", "if p_brand_id is null then", RUNNER),
    ('a session that skips triggers reads a number', C, "select pg_catalog.current_setting('session_replication_role') = 'origin'\n     and", "select true\n     and", RUNNER),
    ('a disabled trigger counts as covered', C, "t.tgenabled in ('O', 'A')", "true", RUNNER),
    ('one trigger is enough for the coverage', C, "or (t.tgname = 'account_lifecycle_owner_epoch_truncate' and t.tgtype & 1 = 0 and t.tgtype & 2 = 0 and t.tgtype & 32 = 32))) = 2", "or (t.tgname = 'account_lifecycle_owner_epoch_truncate' and t.tgtype & 1 = 0 and t.tgtype & 2 = 0 and t.tgtype & 32 = 32))) >= 1", RUNNER),
    ('the getter is not pinned to an empty search path', C, "create function private.account_lifecycle_brand_owner_epoch(p_brand_id text)\nreturns bigint language plpgsql stable security definer set search_path = '' as $$", "create function private.account_lifecycle_brand_owner_epoch(p_brand_id text)\nreturns bigint language plpgsql stable security definer as $$", RUNNER),
    # ---- the history
    ('the number may go down', C, "if new.brand_id = old.brand_id and new.epoch > old.epoch then", "if new.brand_id = old.brand_id then", RUNNER),
    ('the history may be deleted or truncated', C, "  raise exception 'OWNER_EPOCH_HISTORY_IS_APPEND_ONLY' using errcode = '42501';\nend $$;", "  return old;\nend $$;", RUNNER),
    ('the rollback drops the history', RB, "drop function if exists private.account_lifecycle_owner_epoch_bump(text);", "drop function if exists private.account_lifecycle_owner_epoch_bump(text);\ndrop table if exists private.account_lifecycle_brand_owner_epochs;", RUNNER),
    ('the install does not reconcile', C, "if not found\n       or v_row.owner_count <> pg_catalog.cardinality(v_owners)\n       or v_row.owner_user_id is distinct from (case when pg_catalog.cardinality(v_owners) = 1 then v_owners[1] end) then", "if false then", RUNNER),
    ('the install accepts a writer it does not cover', C, "and (pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'INSERT') or pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'UPDATE')\n                  or pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'DELETE'))) then", "and false) then", RUNNER),
    # ---- the resync and the ACL
    ('the resync works while the coverage is broken', C, "if not private.account_lifecycle_brand_owner_epoch_covered() then\n    raise exception 'OWNER_EPOCH_COVERAGE_BROKEN' using errcode = '42501';", "if false then\n    raise exception 'OWNER_EPOCH_COVERAGE_BROKEN' using errcode = '42501';", RUNNER),
    ('the resync does not move the number', C, "return private.account_lifecycle_owner_epoch_bump(p_brand_id);\nend $$;", "return 0;\nend $$;", RUNNER),
    ('the getter is reachable by a person\'s token', C, "private.account_lifecycle_brand_owner_epoch_resync(text) from public, anon, authenticated, service_role;", "private.account_lifecycle_brand_owner_epoch_resync(text) from public, anon, service_role;", RUNNER),
]


def run(root):
    env = dict(os.environ, OE_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', RUNNER], cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='oe-mut-', dir=os.environ.get('SCRATCH', None))
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
for label, target, old, new, _runner in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
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
