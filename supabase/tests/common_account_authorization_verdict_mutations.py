"""Mutation check for the G5 authorization verdict SQL candidate (supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql):
ONE rule (the subject from the claims, the refusals before any read, the one-statement facts, the decision order, the token, the worker answer, the install
preconditions and postconditions) is broken in a scratch COPY; the PG17 suite must fail. A control must pass first. Usage (needs the socket variables of a
THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> python3 supabase/tests/common_account_authorization_verdict_mutations.py <root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch', 'supabase/candidates/common_account_postona_authz',
         'supabase/candidates/common_account_authorization_verdict']
RUNNER = 'supabase/tests/common_account_authorization_verdict_pg_run.sh'
C = 'supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql'

M = [
    # ---- the subject (I-1)
    ('the JSON claims win over the per-claim settings', C, "  v_sub := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '');\n  if v_sub is not null then",
     "  v_sub := null;\n  if v_sub is not null then"),
    ('a per-claim anonymous login is a person', C, "    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');", "    v_anonymous := 'false';"),
    ('a JSON anonymous login is a person', C, "      v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');", "      v_anonymous := 'false';"),
    ('a JSON null is_anonymous is refused (differs from the reference)', C, "coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');", "coalesce((v_claims -> 'is_anonymous')::text, 'false');"),
    ('any role claim is a person', C, "     and v_role = 'authenticated' and v_anonymous = 'false' then", "     and v_anonymous = 'false' then"),
    ('the session id is not checked', C, " and v_session ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'\n", "\n"),
    ('the subject need not equal auth.uid()', C, "    if (select auth.uid()) is not distinct from v_sub::uuid then", "    if true then"),
    # ---- the question, before any read (I-2)
    ('another app is answered', C, "  if p_app is distinct from 'postona'\n     or p_feature is null", "  if p_feature is null"),
    ('an unknown feature is answered', C, "     or p_feature is null or p_feature not in ('read_workspace', 'x_connect', 'x_publish', 'threads_connect', 'threads_publish', 'consult', 'post_generation') then",
     "     or p_feature is null then"),
    ('a malformed brand id is read', C, "  if p_brand_id is null or p_brand_id !~ '^[a-z][a-z0-9_-]{0,63}$' then", "  if p_brand_id is null then"),
    ('a row is read before the question is checked', C, "  -- 1. the subject: the request's JWT only", "  perform 1 from public.service_entitlements limit 1;\n  -- 1. the subject: the request's JWT only"),
    ('a refused caller is not refused', C, "  if v_user is null then\n    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED'",
     "  if v_user is null and false then\n    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED'"),
    # ---- the facts (I-4) and the decision (I-8)
    ('an expired session is active', C, "when s.not_after is null or s.not_after > pg_catalog.clock_timestamp() then 'active'", "when true then 'active'"),
    ('the caller role of any member', C, "(select m.role from public.brand_memberships m where m.brand_id = b.id and m.user_id = v_user),", "(select m.role from public.brand_memberships m where m.brand_id = b.id),"),
    ('a constant owner epoch', C, "         private.account_lifecycle_brand_owner_epoch(b.id)\n    into", "         1::bigint\n    into"),
    ('a locked account is not told apart', C, "    when f_account_status = 'locked' then\n      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'ACCOUNT_LOCKED')\n", ''),
    ('provisioning is not pending', C, "    when f_ent_status = 'provisioning' then\n      pg_catalog.jsonb_build_object('v', 1, 'decision', 'pending', 'reason', 'SERVICE_PROVISIONING')\n", ''),
    ('suspended is not told apart', C, "    when f_ent_status = 'suspended' then\n      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'SERVICE_SUSPENDED')\n", ''),
    ('ended is not told apart', C, "    when f_ent_status = 'ended' then\n      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'SERVICE_NOT_ACTIVE')\n", ''),
    ('a non-member learns the brand state (enumeration)', C, "    when not f_brand_found or f_caller_role is null then", "    when not f_brand_found then"),
    ('a non-owner role is allowed', C, "    when f_caller_role <> 'owner' then\n      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'ROLE_NOT_ALLOWED')\n", ''),
    ('another workspace kind is not told apart', C, "    when f_brand_kind is distinct from 'social_mobile_user_v1' then\n      pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'WORKSPACE_KIND_UNSUPPORTED')\n", ''),
    ('a NULL owner epoch is not unknown', C, "    when f_epoch is null or f_epoch < 1 then\n      pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'OWNER_EPOCH_UNAVAILABLE')\n", ''),
    ('the token ignores the lifecycle version', C, "'owner_epoch', 'g5oe:' || f_epoch::text || ':' || f_lifecycle::text,", "'owner_epoch', 'g5oe:' || f_epoch::text || ':1',"),
    ('the raw session id travels', C, "  v_session_ref := 's:' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g5-session:' || v_session_id::text, 'UTF8')), 'hex'), 32);",
     "  v_session_ref := 's:' || v_session_id::text;"),
    ('another app\'s entitlement is listed', C, "'entitlements', '[\"postona:x_autopost\"]'::jsonb)", "'entitlements', '[\"kabumori:kabumori\", \"postona:x_autopost\"]'::jsonb)"),
    # ---- the worker form (the generation pair; H1 C1 P2)
    ('the worker accepts another service key', C, "  if p_service_key is distinct from 'x_autopost' then\n    return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';", "  if p_service_key not in ('x_autopost', 'kabumori') then\n    return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';"),
    ('the worker accepts the stand-in 0', C, "  if p_expected_owner_epoch is null or p_expected_owner_epoch < 1 then\n    return 'EXPECTED_OWNER_EPOCH_REQUIRED';", "  if p_expected_owner_epoch is null then\n    return 'EXPECTED_OWNER_EPOCH_REQUIRED';"),
    ('the worker accepts no generation', C, "  if p_expected_lifecycle_version is null or p_expected_lifecycle_version < 1 then\n    return 'EXPECTED_LIFECYCLE_VERSION_REQUIRED';\n  end if;", ''),
    ('the worker accepts a NULL epoch', C, "  if v_epoch is null or v_epoch < 1 then\n    return 'OWNER_EPOCH_UNAVAILABLE';\n  end if;", ''),
    ('the worker ignores an owner change', C, "  if v_epoch <> p_expected_owner_epoch then\n    return 'OWNER_EPOCH_CHANGED';\n  end if;", ''),
    ('the worker ignores a new service generation (stop -> restart ABA)', C, "  if v_lifecycle is distinct from p_expected_lifecycle_version then\n    return 'SERVICE_GENERATION_CHANGED';\n  end if;", ''),
    ('the worker only refuses a LATER generation', C, "  if v_lifecycle is distinct from p_expected_lifecycle_version then", "  if v_lifecycle > p_expected_lifecycle_version then"),
    ('the worker reads the generation of another account', C, "(select a.lifecycle_version from public.common_accounts a where a.user_id = private.account_lifecycle_brand_owner(p_brand_id))",
     "(select pg_catalog.min(a.lifecycle_version) from public.common_accounts a)"),
    # ---- the install
    ('forced RLS is accepted', C, "    if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = to_regclass(v_rel)) then", "    if false then"),
    ('a VOLATILE helper is accepted', C, "                    and p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=\"\"'] and p.proowner = v_owner) then",
     "                    and p.prosecdef and p.proconfig @> array['search_path=\"\"'] and p.proowner = v_owner) then"),
    ('the exposure precondition is skipped', C, "  if private.account_lifecycle_owner_epoch_exposure() is not null then\n    raise exception 'AUTH_VERDICT_PRECONDITION_%', private.account_lifecycle_owner_epoch_exposure();",
     "  if false then\n    raise exception 'AUTH_VERDICT_PRECONDITION_%', private.account_lifecycle_owner_epoch_exposure();"),
    ('the lifecycle triggers are not checked', C, "                  and g.tgenabled in ('O', 'A') and g.tgtype = 29 and g.tgfoid = 'private.account_lifecycle_touch_entitlement()'::regprocedure)",
     "                  )"),
    ('an API role reaching an allowed role is accepted', C, "                where a.rolname in ('anon', 'authenticated', 'service_role')\n                  and a.rolname is distinct from v_allowed",
     "                where a.rolname in ('anon', 'authenticated', 'service_role')\n                  and false"),
]


def run(root):
    env = dict(os.environ, AV_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', RUNNER], cwd=root, capture_output=True, text=True, timeout=900, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='av-mut-', dir=os.environ.get('SCRATCH', None))
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
