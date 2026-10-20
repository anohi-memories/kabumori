"""Mutation check for the G5 bootstrap verdict SQL candidate R0 (supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql):
ONE rule (the features, the subject from the claims, nothing read first, the server-derived workspace, the person checks, the own-workspace rule, the
allow's bootstrap-only shape, the install's preconditions / postconditions) is broken in a scratch COPY; the PG17 suite must fail. A control must pass
first. Usage (needs the socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> python3 supabase/tests/common_account_bootstrap_verdict_mutations.py <root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch', 'supabase/candidates/common_account_postona_authz',
         'supabase/candidates/common_account_authorization_verdict']
RUNNER = 'supabase/tests/common_account_bootstrap_verdict_pg_run.sh'
C = 'supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql'

M = [
    # ---- the question
    ('an R1 feature is a bootstrap feature', C, "p_feature not in ('x_connect_bootstrap', 'threads_connect_bootstrap') then", "p_feature not in ('x_connect_bootstrap', 'threads_connect_bootstrap', 'x_connect') then"),
    ('another app is answered', C, "  if p_app is distinct from 'postona' or p_feature is null or", "  if p_feature is null or"),
    ('a row is read before the question is checked', C, "  -- 1. the question, before anything else", "  perform 1 from public.service_entitlements limit 1;\n  -- 1. the question, before anything else"),
    # ---- the subject (R1's rules)
    ('the JSON claims win over the per-claim settings', C, "  v_sub := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '');\n  if v_sub is not null then", "  v_sub := null;\n  if v_sub is not null then"),
    ('a per-claim anonymous login is a person', C, "    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');", "    v_anonymous := 'false';"),
    ('a JSON anonymous login is a person', C, "      v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');", "      v_anonymous := 'false';"),
    ('a JSON null is_anonymous is refused (differs from the reference)', C, "coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');", "coalesce((v_claims -> 'is_anonymous')::text, 'false');"),
    ('any role claim is a person', C, "     and v_role = 'authenticated' and v_anonymous = 'false' then", "     and v_anonymous = 'false' then"),
    ('the session id is not checked', C, " and v_session ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'\n", "\n"),
    ('the subject need not equal auth.uid()', C, "    if (select auth.uid()) is not distinct from v_sub::uuid then", "    if true then"),
    ('a refused caller is not refused', C, "  if v_user is null then\n    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED'",
     "  if v_user is null and false then\n    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED'"),
    # ---- the server-derived workspace and the facts
    ('the workspace id is not the subject\'s', C, "  v_workspace := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);", "  v_workspace := 'u_' || pg_catalog.substr(pg_catalog.md5(v_session_id::text), 1, 24);"),
    ('an expired session is active', C, "when s.not_after is null or s.not_after > pg_catalog.clock_timestamp() then 'active'", "when true then 'active'"),
    ('the caller role of anyone', C, "(select m.role from public.brand_memberships m where m.brand_id = b.id and m.user_id = v_user),", "(select m.role from public.brand_memberships m where m.brand_id = b.id order by m.role desc limit 1),"),
    # ---- the person checks
    ('a locked account is not told apart', C, "    when f_account_status = 'locked' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'ACCOUNT_LOCKED')\n", ''),
    ('provisioning is not pending', C, "    when f_ent_status = 'provisioning' then pg_catalog.jsonb_build_object('decision', 'pending', 'reason', 'SERVICE_PROVISIONING')\n", ''),
    ('suspended is not told apart', C, "    when f_ent_status = 'suspended' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'SERVICE_SUSPENDED')\n", ''),
    ('ended is not told apart', C, "    when f_ent_status = 'ended' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'SERVICE_NOT_ACTIVE')\n", ''),
    ('no x_autopost entitlement is allowed', C, "    when f_ent_status is null then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'SERVICE_NOT_REGISTERED')\n", ''),
    # ---- the own-workspace rule
    ('another workspace kind is joined', C, "    when f_ws_kind is distinct from 'social_mobile_user_v1' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'OWN_WORKSPACE_CONFLICT')\n", ''),
    ('two owners or none are allowed', C, "    when f_owner_count <> 1 or f_owner is null then pg_catalog.jsonb_build_object('decision', 'unknown', 'reason', 'WORKSPACE_OWNER_UNKNOWN')\n", ''),
    ('a workspace owned by someone else is joined (hijack)', C, "    when f_owner <> v_user or f_caller_role is distinct from 'owner' then pg_catalog.jsonb_build_object('decision', 'deny', 'reason', 'OWN_WORKSPACE_CONFLICT')\n", ''),
    # ---- the allow's bootstrap-only shape
    ('the allow carries an owner epoch', C, "    'session', pg_catalog.jsonb_build_object('state', 'active', 'ref', v_session_ref), 'owner_epoch', null,", "    'session', pg_catalog.jsonb_build_object('state', 'active', 'ref', v_session_ref), 'owner_epoch', 'g5oe:1:1',"),
    ('the answer names the workspace', C, "  v_scope jsonb := pg_catalog.jsonb_build_object('app', p_app, 'feature', p_feature, 'brand_slug', null);", "  v_scope jsonb := pg_catalog.jsonb_build_object('app', p_app, 'feature', p_feature, 'brand_slug', 'u_bootstrap');"),
    ('the raw session id travels', C, "  v_session_ref := 's:' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('g5-session:' || v_session_id::text, 'UTF8')), 'hex'), 32);",
     "  v_session_ref := 's:' || v_session_id::text;"),
    ('another app\'s entitlement is listed', C, "'owner_epoch', null, 'entitlements', '[\"postona:x_autopost\"]'::jsonb);", "'owner_epoch', null, 'entitlements', '[\"kabumori:kabumori\", \"postona:x_autopost\"]'::jsonb);"),
    # ---- the install
    ('forced RLS is accepted', C, "    if (select c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = to_regclass(v_rel)) then", "    if false then"),
    ('another workspace derivation is accepted', C, "     or public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-000000000001'::uuid)\n        is distinct from 'u_' || pg_catalog.substr(pg_catalog.md5('00000000-0000-4000-8000-000000000001'), 1, 24) then",
     " then"),
    ('the exposure precondition is skipped', C, "  if private.account_lifecycle_owner_epoch_exposure() is not null then\n    raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_%'", "  if false then\n    raise exception 'BOOTSTRAP_VERDICT_PRECONDITION_%'"),
    ('an API role reaching authenticated is accepted', C, "              where a.rolname in ('anon', 'service_role') and pg_catalog.has_function_privilege(r.oid, v_r0, 'EXECUTE'))",
     "              where false)"),
]


def run(root):
    env = dict(os.environ, BV_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', RUNNER], cwd=root, capture_output=True, text=True, timeout=900, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='bv-mut-', dir=os.environ.get('SCRATCH', None))
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
