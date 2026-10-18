"""Mutation check for the M2 AI-consult authorization findings (F5): ONE rule of F5's real Phase 1 table grants / RLS, of the real membership RLS, of
F5's owner and state functions or of the T13 guard is broken in a scratch COPY; the M2 suite must fail. A control must pass first. Usage (needs the
local PostgreSQL socket variables of a THROW-AWAY cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_m2_ai_consult_authz_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/functions']
RUNNER = 'supabase/tests/common_account_m2_ai_consult_authz_run.sh'
P1 = 'supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql'
P3B = 'supabase/migrations/20261010051938_common_account_service_write_guard.sql'
P5 = 'supabase/migrations/20261012230000_common_account_service_brand_state.sql'
MEMBERS = 'supabase/migrations/20260918120000_social_mobile_brand_memberships.sql'
FIX = 'supabase/tests/common_account_m2_ai_consult_authz_fixture.sql'
GRANT_ENT = "grant select (user_id, service_key, status, activated_at, ended_at, updated_at)\n  on table public.service_entitlements to authenticated;"

M = [
    # ---- F5's Phase 1 tables: what the person's role may read
    ('another person\'s entitlement row is readable', P1, "  on public.service_entitlements\n  for select\n  to authenticated\n  using ((select auth.uid()) = user_id);", "  on public.service_entitlements\n  for select\n  to authenticated\n  using (true);"),
    ('another person\'s common account row is readable', P1, "  on public.common_accounts\n  for select\n  to authenticated\n  using ((select auth.uid()) = user_id);", "  on public.common_accounts\n  for select\n  to authenticated\n  using (true);"),
    ('every column of the entitlement is readable', P1, GRANT_ENT, "grant select on table public.service_entitlements to authenticated;"),
    ('service_role reads the entitlement table directly', P1, GRANT_ENT, "grant select (user_id, service_key, status, activated_at, ended_at, updated_at)\n  on table public.service_entitlements to authenticated, service_role;"),
    ('anon reads the entitlement table', P1, GRANT_ENT, "grant select (user_id, service_key, status, activated_at, ended_at, updated_at)\n  on table public.service_entitlements to authenticated, anon;"),
    ('a person may update the entitlement status', P1, GRANT_ENT, GRANT_ENT + "\ngrant update (status) on table public.service_entitlements to authenticated;"),
    ('the freeze does not make the status visible', P1, "  update public.service_entitlements set status = 'deleting', updated_at = now()", "  update public.service_entitlements set updated_at = now()"),
    # ---- the real membership RLS the live handler relies on
    ('a person sees every membership', MEMBERS, "  using ((select auth.uid()) = user_id);", "  using (true);"),
    # ---- F5's owner rule, state decision and ACLs (P5) and the T13 guard (P3b)
    ('a workspace with two owners has an owner', P5, "     and (select count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner') = 1\n", ""),
    ('an ended service reads as active', P5, "  if v_status <> 'active' then\n    return 'SERVICE_NOT_ACTIVE';\n  end if;\n  return null;\nend;\n$$;\n\n-- 3.", "  return null;\nend;\n$$;\n\n-- 3."),
    ('a locked account reads as active', P5, "  if v_account_status <> 'active' then\n    return 'ACCOUNT_LOCKED';\n  end if;", ""),
    ('a person\'s token may read any workspace\'s state', P5, "grant execute on function public.common_account_brand_service_state(text, text) to service_role;", "grant execute on function public.common_account_brand_service_state(text, text) to service_role, authenticated;"),
    ('the T13 guard accepts a session that is gone', P3B, "  if not v_live then\n    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\nend;", "  if false then\n    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\nend;"),
    ('the T13 guard does not report busy', FIX, "  when lock_not_available then return 'ACCOUNT_LIFECYCLE_BUSY';\n", ""),
]


def run(root):
    env = dict(os.environ, M2_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', RUNNER], cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='m2-mut-', dir=os.environ.get('SCRATCH', None))
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
