"""Mutation check for the M1 authorization chain (F5): ONE rule of F5's real SQL (the T13 write guard, the brand-owner rule, the workspace
state, their ACLs) or of the M1 test model is broken in a scratch COPY; the chain test must fail. A control must pass first. Usage (needs the
local PostgreSQL socket variables of a THROW-AWAY cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_m1_manual_x_publish_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/functions']
RUNNER = 'supabase/tests/common_account_m1_manual_x_publish_run.sh'
P3B = 'supabase/migrations/20261010051938_common_account_service_write_guard.sql'
P4 = 'supabase/migrations/20261012130000_common_account_core_service_fence.sql'
P5 = 'supabase/migrations/20261012230000_common_account_service_brand_state.sql'
FIX = 'supabase/tests/common_account_m1_manual_x_publish_fixture.sql'

M = [
    # ---- F5's real T13 guard (P3b). Two checks are deliberately doubled in the guard (subject == asked person AND auth.uid() == asked person;
    # a missing session id AND a session that is not live): a mutant that removes only one of a pair is equivalent, so the pair is removed together or not at all.
    ('a logged-out or expired session is accepted', P3B, "  if not v_live then\n    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\nend;", "  if false then\n    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\nend;"),
    ('another subject than the asked person is accepted (both independent checks removed)', P3B, "or v_subject <> p_user_id or (select auth.uid()) is distinct from p_user_id then", "then"),
    ('a role other than authenticated is accepted', P3B, "or v_role is distinct from 'authenticated'", "or false"),
    ('an ended or suspended entitlement is accepted', P3B, "  if v_status <> 'active' then\n    raise exception 'SERVICE_NOT_ACTIVE' using errcode = '42501';", "  if false then\n    raise exception 'SERVICE_NOT_ACTIVE' using errcode = '42501';"),
    ('a locked common account is accepted', P3B, "  if v_account.status <> 'active' then\n    raise exception 'ACCOUNT_LOCKED' using errcode = '42501';", "  if false then\n    raise exception 'ACCOUNT_LOCKED' using errcode = '42501';"),
    ('a common account being deleted is accepted', P3B, "  if v_account.status = 'deleting'\n     or exists (select 1 from private.account_lifecycle_operations o\n                 where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then\n    raise exception 'ACCOUNT_DELETION_IN_PROGRESS'", "  if false then\n    raise exception 'ACCOUNT_DELETION_IN_PROGRESS'"),
    ('a service being deleted is accepted', P3B, "  if v_status = 'deleting'\n     or exists (select 1 from private.account_lifecycle_operations o\n                 where o.user_id = p_user_id and o.operation_type = 'service_deletion'\n                   and o.service_key = p_service_key and o.status = 'in_progress') then\n    raise exception 'SERVICE_DELETION_IN_PROGRESS'", "  if false then\n    raise exception 'SERVICE_DELETION_IN_PROGRESS'"),
    ('a person with no entitlement is accepted', P3B, "  if not found then\n    raise exception 'SERVICE_NOT_REGISTERED' using errcode = '42501';", "  if false then\n    raise exception 'SERVICE_NOT_REGISTERED' using errcode = '42501';"),
    ('any service key is accepted', P3B, "if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then\n    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID'", "if p_service_key is null then\n    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID'"),
    ('the guard is callable by a person\'s token', P3B, "revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;", "revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, service_role;"),
    # ---- the owner rule and the workspace state (P5), the locking decision (P4)
    ('a workspace with two owners has an owner', P5, "     and (select count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner') = 1\n", ""),
    ('a non-user workspace has an owner', P5, "     and b.code_profile_key = 'social_mobile_user_v1'\n", ""),
    ('an ended service reads as active in the workspace state', P5, "  if v_status <> 'active' then\n    return 'SERVICE_NOT_ACTIVE';\n  end if;\n  return null;\nend;\n$$;\n\n-- 3.", "  return null;\nend;\n$$;\n\n-- 3."),
    ('a service being deleted reads as active in the workspace state', P5, "  if v_status = 'deleting'\n     or exists (select 1 from private.account_lifecycle_operations o\n                 where o.user_id = p_user_id and o.operation_type = 'service_deletion'\n                   and o.service_key = p_service_key and o.status = 'in_progress') then\n    return 'SERVICE_DELETION_IN_PROGRESS';", "  if false then\n    return 'SERVICE_DELETION_IN_PROGRESS';"),
    ('the workspace state is readable by a person\'s token', P5, "grant execute on function public.common_account_brand_service_state(text, text) to service_role;", "grant execute on function public.common_account_brand_service_state(text, text) to service_role, authenticated;"),
    ('the locking state decision is readable by the worker role', P4, "revoke all on function private.account_lifecycle_service_state_refusal(uuid, text) from public, anon, authenticated, service_role;", "revoke all on function private.account_lifecycle_service_state_refusal(uuid, text) from public, anon, authenticated;"),
    # ---- the M1 model (the order and the checks F3's wrappers must have)
    ('authorize does not ask T13', FIX, "    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');", "    perform 1;"),
    ('authorize does not check the workspace owner', FIX, "  if private.account_lifecycle_brand_owner(v_brand) is distinct from v_user then\n    return m1_fixture.refused('NOT_WORKSPACE_OWNER');\n  end if;\n  select * into v_g4", "  select * into v_g4"),
    ('authorize does not check the verified X owner', FIX, "  if not found or v_g4.verified_user_id is distinct from v_user then\n    return m1_fixture.refused('CONNECTION_NOT_VERIFIED');\n  end if;\n  if v_g4.credential_owner_id is distinct from v_user then\n    return m1_fixture.refused('CREDENTIAL_OWNER_MISMATCH');", "  if false then\n    return m1_fixture.refused('CONNECTION_NOT_VERIFIED');\n  end if;\n  if v_g4.credential_owner_id is distinct from v_user then\n    return m1_fixture.refused('CREDENTIAL_OWNER_MISMATCH');"),
    ('authorize does not check the credential owner', FIX, "  if v_g4.credential_owner_id is distinct from v_user then\n    return m1_fixture.refused('CREDENTIAL_OWNER_MISMATCH');\n  end if;\n  if v_enabled", "  if v_enabled"),
    ('authorize does not check the publish switch', FIX, "  if v_enabled is distinct from true then\n    return m1_fixture.refused('X_ACCOUNT_PUBLISH_DISABLED');\n  end if;\n  select * into v_intent", "  select * into v_intent"),
    ('authorize cannot be replayed safely', FIX, "  if found then\n    -- a replay of the same request: the same intent, never a second one\n    return pg_catalog.jsonb_build_object('status', 'authorized', 'intent_id', v_intent.intent_id, 'replay', true, 'state', v_intent.state);\n  end if;", "  if false then\n    return null;\n  end if;"),
    ('a busy lifecycle is not retryable', FIX, "    when lock_not_available then\n      return pg_catalog.jsonb_build_object('status', 'busy', 'code', 'ACCOUNT_LIFECYCLE_BUSY');\n", ""),
    ('pre-send does not read the workspace service state', FIX, "  if v_state is distinct from 'active' then\n    return m1_fixture.refused(v_state);\n  end if;", "  null;"),
    ('pre-send does not re-check the owner', FIX, "  if private.account_lifecycle_brand_owner(v_intent.brand_id) is distinct from v_intent.user_id then\n    return m1_fixture.refused('OWNER_CHANGED');\n  end if;", "  null;"),
    ('pre-send does not compare the credential generation', FIX, "  if v_g4.credential_generation is distinct from v_intent.credential_generation then\n    return m1_fixture.refused('CREDENTIAL_CHANGED');\n  end if;", "  null;"),
    ('pre-send does not re-check the verified X owner', FIX, "  if not found or v_g4.verified_user_id is distinct from v_intent.user_id then\n    return m1_fixture.refused('CONNECTION_NOT_VERIFIED');\n  end if;\n  if v_g4.credential_owner_id is distinct from v_intent.user_id then", "  if v_g4.credential_owner_id is distinct from v_intent.user_id then"),
    ('a result can be recorded twice', FIX, "  if not found or v_intent.state <> 'authorized' then\n    return m1_fixture.refused('INTENT_NOT_AUTHORIZED');\n  end if;\n  v_after_freeze", "  v_after_freeze"),
    ('the freeze flag is never set', FIX, "  v_after_freeze := public.common_account_brand_service_state(v_intent.brand_id, 'x_autopost') is distinct from 'active';", "  v_after_freeze := false;"),
    ('a stored result is not marked simulated', FIX, "  simulated boolean not null default true check (simulated),", "  simulated boolean not null default false,"),
    ('the person path is open to the worker role', FIX, "grant execute on function m1_fixture.authorize_manual_post(text, text, text) to authenticated;", "grant execute on function m1_fixture.authorize_manual_post(text, text, text) to authenticated, service_role;"),
]


def run(root):
    env = dict(os.environ, M1_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', RUNNER], cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='m1-mut-', dir=os.environ.get('SCRATCH', None))
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
for label, target, old, new in M:
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
