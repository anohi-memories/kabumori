"""Mutation check for the G5 session-only verdict SQL candidate (supabase/candidates/common_account_authorization_verdict/003_session_verdict.sql):
ONE rule (the subject from the claims, the login, the session row by id AND user, not_after, the guard, the install's preconditions / postconditions)
is broken in a scratch COPY; the PG17 suite must fail. A control must pass first. Usage (needs the socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> python3 supabase/tests/common_account_session_verdict_mutations.py <root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_brand_owner_epoch', 'supabase/candidates/common_account_postona_authz',
         'supabase/candidates/common_account_authorization_verdict']
RUNNER = 'supabase/tests/common_account_session_verdict_pg_run.sh'
C = 'supabase/candidates/common_account_authorization_verdict/003_session_verdict.sql'

M = [
    # ---- the subject (R1's rules)
    ('the JSON claims win over the per-claim settings', C, "  v_sub := nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '');\n  if v_sub is not null then", "  v_sub := null;\n  if v_sub is not null then"),
    ('a per-claim anonymous login is a person', C, "    v_anonymous := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.is_anonymous', true), ''), 'false');", "    v_anonymous := 'false';"),
    ('a JSON anonymous login is a person', C, "      v_anonymous := coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');", "      v_anonymous := 'false';"),
    ('a JSON string "false" is not anonymous', C, "coalesce(nullif((v_claims -> 'is_anonymous')::text, 'null'), 'false');", "coalesce(v_claims ->> 'is_anonymous', 'false');"),
    ('any role claim is a person', C, "     and v_role = 'authenticated' and v_anonymous = 'false' then", "     and v_anonymous = 'false' then"),
    ('the session claim is not checked', C, " and v_session ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'\n", "\n"),
    ('the subject need not equal auth.uid()', C, "    if (select auth.uid()) is not distinct from v_sub::uuid then", "    if true then"),
    ('a refused caller is not refused', C, "  if v_user is null then\n    return 'AUTH_REQUIRED';", "  if v_user is null and false then\n    return 'AUTH_REQUIRED';"),
    # ---- the login and the session
    ('a deleted login is a person', C, "  if not f_user_exists then\n    return 'AUTH_REQUIRED';", "  if false then\n    return 'AUTH_REQUIRED';"),
    ('another person\'s session is accepted', C, "left join auth.sessions s on s.id = v_session_id and s.user_id = v_user)", "left join auth.sessions s on s.id = v_session_id)"),
    ('the session row is not looked up (signed out = active)', C, "(select case when s.id is null then 'revoked'", "(select case when false then 'revoked'"),
    ('an expired session is active', C, "when s.not_after is null or s.not_after > pg_catalog.clock_timestamp() then 'active'", "when true then 'active'"),
    ('not_after = now is active', C, "s.not_after > pg_catalog.clock_timestamp()", "s.not_after >= pg_catalog.clock_timestamp() - interval '1 hour'"),
    ('revoked and expired are one code', C, "when 'expired' then 'SESSION_EXPIRED' end;", "when 'expired' then 'SESSION_REVOKED' end;"),
    ('the verdict runs with ordinary row security', C, "returns text language plpgsql stable security definer set search_path = '' set row_security = off as $$",
     "returns text language plpgsql stable security definer set search_path = '' as $$"),
    # ---- the install
    ('RLS that hides rows is accepted', C, "    if v_rls and not (select r.rolbypassrls", "    if false and v_rls and not (select r.rolbypassrls"),
    ('a SET-only membership counts as the table owner', C, "pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE')", "pg_catalog.pg_has_role(v_owner, v_relowner, 'MEMBER')"),
    ('BYPASSRLS is not honoured', C, "    if v_rls and not (select r.rolbypassrls from pg_catalog.pg_roles r where r.oid = v_owner) and not", "    if v_rls and not"),
    ('the table owner by inheritance is not honoured', C, "and not pg_catalog.pg_has_role(v_owner, v_relowner, 'USAGE') then", "and v_owner <> v_relowner then"),
    ('forced RLS is accepted', C, "    if v_forced then\n      raise exception 'SESSION_VERDICT_PRECONDITION_RLS_FORCED %'", "    if false then\n      raise exception 'SESSION_VERDICT_PRECONDITION_RLS_FORCED %'"),
    ('a view stands in for a table', C, "    if not found or v_kind not in ('r', 'p') or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then",
     "    if not found or not pg_catalog.has_table_privilege(v_owner, v_rel, 'SELECT') then"),
    ('the sessions shape is not checked', C, "         or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::regtype))) <> 3 then", "         or (a.attname = 'not_after' and a.atttypid = 'timestamptz'::regtype))) < 0 then"),
    ('the exposure precondition is skipped', C, "  if private.account_lifecycle_owner_epoch_exposure() is not null then\n    raise exception 'SESSION_VERDICT_PRECONDITION_%'",
     "  if false then\n    raise exception 'SESSION_VERDICT_PRECONDITION_%'"),
    ('EXECUTE stays with PUBLIC', C, "revoke all on function private.account_lifecycle_session_verdict() from public, anon, authenticated, service_role;",
     "revoke all on function private.account_lifecycle_session_verdict() from anon, authenticated, service_role;"),
    ('the exact ACL is not checked', C, "is distinct from format('%s=X/%s', v_owner, v_owner) then\n    raise exception 'SESSION_VERDICT_POSTCONDITION_ACL';",
     "is distinct from format('%s=X/%s', v_owner, v_owner) and false then\n    raise exception 'SESSION_VERDICT_POSTCONDITION_ACL';"),
]


def run(root):
    env = dict(os.environ, SV_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', RUNNER], cwd=root, capture_output=True, text=True, timeout=900, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='sv-mut-', dir=os.environ.get('SCRATCH', None))
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
