"""Mutation check for the brand OWNER EPOCH candidate (F5): ONE rule of the candidate SQL (the write events it records, the getter's refusals, the coverage check, the
history guard, the install / rollback re-start fence, the exact-trigger coverage, the API-role exposure through any membership, the ACL) is broken in a scratch COPY; the owner-epoch suite must fail. A control must pass first. Usage (needs the
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
    ('a bump does not move the number', C, "set epoch = v_epoch + 1, owner_user_id = case", "set epoch = v_epoch, owner_user_id = case", RUNNER),
    ('a bump records the owners it read BEFORE the row lock (J1 V1 lock order)', C, "for update;\n  select coalesce(pg_catalog.array_agg(m.user_id order by m.user_id), '{}'::uuid[]) into v_owners\n    from public.brand_memberships m where m.brand_id = p_brand_id and m.role = 'owner';\n  update", "for update;\n  update", RUNNER),
    # ---- what the getter vouches for
    ('two or more owners (or none) have an epoch', C, "if pg_catalog.cardinality(v_owners) <> 1 or v_row.owner_count <> 1 or v_row.owner_user_id is distinct from v_owners[1] then\n    return null;", "if false then\n    return null;", RUNNER),
    ('a write that got past the trigger is not detected', C, "or v_row.owner_user_id is distinct from v_owners[1] then\n    return null;", " then\n    return null;", RUNNER),
    ('a broken coverage is not checked by the getter', C, "if p_brand_id is null or not private.account_lifecycle_brand_owner_epoch_covered() then", "if p_brand_id is null then", RUNNER),
    ('a session that skips triggers reads a number', C, "select pg_catalog.current_setting('session_replication_role') = 'origin'\n     and", "select true\n     and", RUNNER),
    ('a disabled trigger counts as covered', C, "t.tgenabled in ('O', 'A')", "true", RUNNER),
    ('one trigger is enough for the coverage', C, "'private.account_lifecycle_owner_epoch_truncated()'::regprocedure))) = 2", "'private.account_lifecycle_owner_epoch_truncated()'::regprocedure))) >= 1", RUNNER),
    ('the getter is not pinned to an empty search path', C, "create function private.account_lifecycle_brand_owner_epoch(p_brand_id text)\nreturns bigint language plpgsql stable security definer set search_path = '' as $$", "create function private.account_lifecycle_brand_owner_epoch(p_brand_id text)\nreturns bigint language plpgsql stable security definer as $$", RUNNER),
    # ---- J1 V1 R2: a same-named trigger must be exactly the candidate's
    ('R2: the row trigger function is not checked', C, "\n                   and t.tgfoid = 'private.account_lifecycle_owner_epoch_record()'::regprocedure)", ")", RUNNER),
    ('R2: the truncate trigger function is not checked', C, "\n                   and t.tgfoid = 'private.account_lifecycle_owner_epoch_truncated()'::regprocedure)", ")", RUNNER),
    ('R2: a WHEN clause is accepted', C, "and t.tgqual is null and", "and", RUNNER),
    ('R2: a column list is accepted', C, "and pg_catalog.cardinality(t.tgattr::int2[]) = 0 and", "and", RUNNER),
    ('R2: a constraint trigger is accepted', C, "and t.tgconstraint = 0 and", "and", RUNNER),
    ('R2: trigger arguments are accepted', C, "and t.tgnargs = 0\n", "\n", RUNNER),
    ('R2: the row trigger timing is checked by bits only', C, "t.tgtype = 29", "t.tgtype & 29 = 29", RUNNER),
    ('R2: the truncate trigger timing is checked by bits only', C, "t.tgtype = 32", "t.tgtype & 32 = 32", RUNNER),
    ('R2: the coverage ignores what API roles can reach', C, "\n     and private.account_lifecycle_owner_epoch_exposure() is null\n", "\n", RUNNER),
    ('R2: TRIGGER of an API role is accepted', C, "when exists (select 1 from reach x where pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'TRIGGER')) then", "when false then", RUNNER),
    ('R2: TRUNCATE of anon / authenticated is accepted', C, "\n                      or pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'TRUNCATE')", "", RUNNER),
    ('R2: REFERENCES of anon / authenticated is accepted', C, "\n                      or pg_catalog.has_table_privilege(x.role_oid, 'public.brand_memberships', 'REFERENCES')", "", RUNNER),
    ('R2: SET session_replication_role of an API role is accepted', C, "when exists (select 1 from reach x where pg_catalog.has_parameter_privilege(x.role_oid, 'session_replication_role', 'SET')) then", "when false then", RUNNER),
    # ---- J1 V1 R3: NOINHERIT / SET-only / admin paths
    ('R3: only INHERIT paths are followed (USAGE)', C, "on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')\n  ), owner_role as", "on pg_catalog.pg_has_role(a.oid, r.oid, 'USAGE')\n  ), owner_role as", RUNNER),
    ('R3: only SET paths are followed (SET)', C, "on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')\n  ), owner_role as", "on pg_catalog.pg_has_role(a.oid, r.oid, 'SET')\n  ), owner_role as", RUNNER),
    ('R3: an API role that can become the owner is accepted', C, "when exists (select 1 from reach x, owner_role o where x.role_oid = o.oid) then", "when false then", RUNNER),
    ('R3: an API role that can become a superuser is accepted', C, "when exists (select 1 from reach x where x.super) then", "when false then", RUNNER),
    # ---- the history and the re-start fence (J1 V1 R1)
    ('the number may go down', C, "if new.brand_id = old.brand_id and new.epoch > old.epoch then", "if new.brand_id = old.brand_id then", RUNNER),
    ('the history may be deleted or truncated', C, "  raise exception 'OWNER_EPOCH_HISTORY_IS_APPEND_ONLY' using errcode = '42501';\nend $$;", "  return old;\nend $$;", RUNNER),
    ('the rollback drops the history', RB, "drop function if exists private.account_lifecycle_owner_epoch_bump(text);", "drop function if exists private.account_lifecycle_owner_epoch_bump(text);\ndrop table if exists private.account_lifecycle_brand_owner_epochs;", RUNNER),
    ('R1: the rollback does not move the numbers', RB, "    update private.account_lifecycle_brand_owner_epochs set epoch = epoch + 1;\n", "", RUNNER),
    ('R1: the install only reconciles a CHANGED owner (the PR #285 head behaviour)', C,
     "  loop\n    perform private.account_lifecycle_owner_epoch_bump(v_brand);\n  end loop;",
     "  loop\n    if not exists (select 1 from private.account_lifecycle_brand_owner_epochs e, lateral (select coalesce(pg_catalog.array_agg(m.user_id), '{}'::uuid[]) o from public.brand_memberships m where m.brand_id = v_brand and m.role = 'owner') x\n"
     "                    where e.brand_id = v_brand and e.owner_count = pg_catalog.cardinality(x.o) and e.owner_user_id is not distinct from (case when pg_catalog.cardinality(x.o) = 1 then x.o[1] end)) then\n"
     "      perform private.account_lifecycle_owner_epoch_bump(v_brand);\n    end if;\n  end loop;", RUNNER),
    ('R1: the install skips recorded workspaces', C, "    union\n    select e.brand_id from private.account_lifecycle_brand_owner_epochs e\n    order by 1", "    except\n    select e.brand_id from private.account_lifecycle_brand_owner_epochs e\n    order by 1", RUNNER),
    ('the install accepts a writer it does not cover', C, "  if v_code is not null then\n    raise exception 'OWNER_EPOCH_PRECONDITION_%', v_code;", "  if false then\n    raise exception 'OWNER_EPOCH_PRECONDITION_%', v_code;", RUNNER),
    # ---- the resync and the ACL
    ('the resync works while the coverage is broken', C, "if not private.account_lifecycle_brand_owner_epoch_covered() then\n    raise exception 'OWNER_EPOCH_COVERAGE_BROKEN' using errcode = '42501';", "if false then\n    raise exception 'OWNER_EPOCH_COVERAGE_BROKEN' using errcode = '42501';", RUNNER),
    ('the resync does not move the number', C, "return private.account_lifecycle_owner_epoch_bump(p_brand_id);\nend $$;", "return 0;\nend $$;", RUNNER),
    ('the getter is reachable by a person\'s token', C, "private.account_lifecycle_owner_epoch_exposure() from public, anon, authenticated, service_role;\n\n-- Postconditions", "private.account_lifecycle_owner_epoch_exposure() from public, anon, service_role;\n\n-- Postconditions", RUNNER),
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
