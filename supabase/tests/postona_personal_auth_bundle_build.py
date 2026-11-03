"""G5-41: build (or --check) the bundle's two ENTRYPOINTS from its verbatim parts, deterministically:
  INSTALL_ALL.sql   ONE transaction: parts 10..70 with only each part's own top-level `begin;` / `commit;` line removed, then a bundle
                    postcondition. Nothing is visible to another session before the final commit, and any failure or interruption leaves
                    nothing (H2 F2 on PR #531: the per-file commits exposed the loose R1 / R0 before D1).
  ROLLBACK_ALL.sql  ONE transaction: a mandatory bundle preflight (the exact installed state; no outside caller or dependent of any bundle
                    function), then R70, R60, R50, R40, the guard RG, R30, R20, R10 (each part's own `begin;` / `commit;` removed), then a
                    postcondition (H2 F1: R10 / R20 / R30 alone are unguarded drops).
Each part must hold exactly one line `begin;` and one line `commit;` (its last line); nothing else of a part is changed.
Usage: python3 supabase/tests/postona_personal_auth_bundle_build.py <repository root> [--check]"""
import hashlib
import os
import sys

repo = sys.argv[1]
check = '--check' in sys.argv[2:]
B = os.path.join(repo, 'supabase/candidates/postona_personal_auth_bundle')
INSTALL = ['10_r1_authorization_verdict.sql', '20_r0_bootstrap_verdict.sql', '30_sv_session_verdict.sql', '40_d1_verdicts_anonymous_strict.sql',
           '50_s2_3_workspace_eligibility.sql', '60_s2_2_personal_session.sql', '70_s2_1_t13_anonymous_refusal.sql']
ROLLBACK = ['R70_s2_1_t13_anonymous_refusal_rollback.sql', 'R60_s2_2_personal_session_rollback.sql', 'R50_s2_3_workspace_eligibility_rollback.sql',
            'R40_d1_verdicts_anonymous_strict_rollback.sql', 'RG_base_rollback_guard.sql', 'R30_sv_session_verdict_rollback.sql',
            'R20_r0_bootstrap_verdict_rollback.sql', 'R10_r1_authorization_verdict_rollback.sql']


def part(name):
    text = open(os.path.join(B, name), encoding='utf-8').read()
    digest = hashlib.sha1(b'blob %d\0' % len(text.encode()) + text.encode()).hexdigest()
    if name.startswith('RG_'):
        if any(line in ('begin;', 'commit;') for line in text.splitlines()):
            sys.exit(f'{name}: the guard must not open or close a transaction')
        return f'-- ==== part {name} (blob {digest}) ====\n{text}'
    lines = text.split('\n')
    if lines.count('begin;') != 1 or lines.count('commit;') != 1 or text.rstrip('\n').split('\n')[-1] != 'commit;':
        sys.exit(f'{name}: expected exactly one `begin;` line and one final `commit;` line')
    lines.remove('begin;')
    lines.remove('commit;')
    return f'-- ==== part {name} (blob {digest}): its own begin; / commit; removed, nothing else changed ====\n' + '\n'.join(lines)


FINAL = {  # the bodies after the whole bundle (as the parts state them)
    'public.common_account_authorization_verdict(text,text,text)': '7e84d9a2ecc53923d0c7846a4514dfdd',
    'public.common_account_bootstrap_verdict(text,text)': '3e89fcff1a3232ef794cdf0483a75130',
    'private.account_lifecycle_session_verdict()': 'a5d4d71c532847a8573e86a4bd0c791d',
    'private.account_lifecycle_assert_active_service_write(uuid,text)': '1f8cd9c764c251f3232c61b7a77ff597',
    'private.postona_personal_workspace_eligibility(uuid)': 'fa4623601fe2ef6efc38478c9f65105e',
    'private.postona_personal_session()': 'a5d4d71c532847a8573e86a4bd0c791d',
}
# every function the bundle creates (dropped by ROLLBACK_ALL), with its exact ACL; T13 is only re-bodied (kept, owner-only)
ACL = {
    'public.common_account_authorization_verdict(text,text,text)': 'authenticated',
    'public.common_account_bootstrap_verdict(text,text)': 'authenticated',
    'public.common_account_worker_brand_verdict(text,text,bigint,bigint)': 'service_role',
    'private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)': None,
    'private.account_lifecycle_generation_covered()': None,
    'private.account_lifecycle_session_verdict()': None,
    'private.postona_personal_workspace_eligibility(uuid)': None,
    'private.postona_personal_session()': None,
}
T13 = 'private.account_lifecycle_assert_active_service_write(uuid,text)'
NAMES = '|'.join(sorted({sig.split('.', 1)[1].split('(')[0] for sig in ACL}))


def acl_checks(prefix):
    out = []
    for sig, role in list(ACL.items()) + [(T13, None)]:
        want = "pg_catalog.format('%s=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))" if role is None else \
            f"pg_catalog.format('%s=X/%s,{role}=X/%s', pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user), pg_catalog.quote_ident(current_user))"
        out.append(f"""  if (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('{sig}'))
       is distinct from {want} then
    raise exception '{prefix}_ACL %', '{sig}';
  end if;""")
    return '\n'.join(out)


BODY_CHECKS = lambda prefix: '\n'.join(
    f"""  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('{sig}')) is distinct from '{md5}' then
    raise exception '{prefix} %', '{sig}';
  end if;""" for sig, md5 in FINAL.items())
EXIST_CHECKS = lambda prefix: '\n'.join(
    f"""  if pg_catalog.to_regprocedure('{sig}') is null then
    raise exception '{prefix} %', '{sig}';
  end if;""" for sig in ACL)
BUNDLE_SET = "array[" + ', '.join(f"pg_catalog.to_regprocedure('{sig}')::oid" for sig in list(ACL) + [T13]) + "]"
API = "('anon', 'authenticated', 'service_role', 'authenticator')"

POST_INSTALL = f"""-- ==== bundle postcondition (G5-41): the whole final state, or nothing is committed ====
do $$
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'BUNDLE_INSTALL_OWNER_IS_SUPERUSER';
  end if;
{BODY_CHECKS('BUNDLE_INSTALL_POSTCONDITION_BODY')}
{EXIST_CHECKS('BUNDLE_INSTALL_POSTCONDITION_MISSING')}
{acl_checks('BUNDLE_INSTALL_POSTCONDITION')}
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname in {API}
              and pg_catalog.pg_has_role(r.oid, (select o.oid from pg_catalog.pg_roles o where o.rolname = current_user), 'MEMBER')) then
    raise exception 'BUNDLE_INSTALL_POSTCONDITION_API_ROLE_IN_OWNER';
  end if;
end $$;
"""

PRE_ROLLBACK = f"""-- ==== bundle preflight (G5-41): MANDATORY, in the same transaction as every drop below ====
-- It refuses (and nothing is dropped) unless the database is in exactly the state INSTALL_ALL leaves -- a partial state (a part rolled back or
-- applied by hand, an interrupted manual run) is NOT resumed automatically: it is left for a reviewed manual decision -- and unless no function
-- outside the bundle names a bundle function (lower-cased source text; PL/pgSQL calls are not recorded dependencies) and no recorded dependency
-- (a view, a BEGIN ATOMIC body, ...) points at one. It cannot see dynamic SQL, another database or callers outside the database.
do $$
declare
  v_set oid[] := {BUNDLE_SET};
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'BUNDLE_ROLLBACK_OWNER_IS_SUPERUSER';
  end if;
{BODY_CHECKS('BUNDLE_ROLLBACK_STATE_NOT_INSTALLED')}
{EXIST_CHECKS('BUNDLE_ROLLBACK_STATE_NOT_INSTALLED')}
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid <> all (v_set) and pg_catalog.lower(p.prosrc) ~ '({NAMES})') then
    raise exception 'BUNDLE_ROLLBACK_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d
              where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = any (v_set)
                and d.refobjid <> pg_catalog.to_regprocedure('{T13}')::oid) then
    raise exception 'BUNDLE_ROLLBACK_DEPENDENTS';
  end if;
end $$;
"""

POST_ROLLBACK = f"""-- ==== bundle postcondition (G5-41): every bundle function gone, T13 back to its reviewed body ====
do $$
begin
{chr(10).join(f"  if pg_catalog.to_regprocedure('{sig}') is not null then{chr(10)}    raise exception 'BUNDLE_ROLLBACK_POSTCONDITION_LEFT %', '{sig}';{chr(10)}  end if;" for sig in ACL)}
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('{T13}')) is distinct from '08840016794a973225be767952265e79' then
    raise exception 'BUNDLE_ROLLBACK_POSTCONDITION_T13';
  end if;
end $$;
"""

HEAD = """-- G5 SOURCE CANDIDATE ENTRYPOINT (G5-41, Issue #320 task 41) -- GENERATED by supabase/tests/postona_personal_auth_bundle_build.py from the bundle's
-- verbatim parts (MANIFEST.tsv); `--check` re-derives it byte for byte. NOT a migration; never apply to a managed or production database without
-- the bundle's one independent review, a migration-ised version, the managed read-only audit and the owner's explicit approval (README.md).
-- Run as the lifecycle owner (never a superuser), with psql -v ON_ERROR_STOP=1, in ONE session: the whole file is ONE transaction.
"""
install = HEAD + '-- INSTALL_ALL: parts 10..70 and the bundle postcondition in one transaction (H2 F2 on PR #531).\nbegin;\n\n' + \
    '\n'.join(part(n) for n in INSTALL) + '\n' + POST_INSTALL + '\ncommit;\n'
rollback = HEAD + '-- ROLLBACK_ALL: the mandatory preflight, R70..R40, RG, R30..R10 and the postcondition in one transaction (H2 F1 on PR #531).\n' + \
    "begin;\n\nset local lock_timeout = '5s';\n\n" + PRE_ROLLBACK + '\n' + '\n'.join(part(n) for n in ROLLBACK) + '\n' + POST_ROLLBACK + '\ncommit;\n'
bad = 0
for name, text in (('INSTALL_ALL.sql', install), ('ROLLBACK_ALL.sql', rollback)):
    path = os.path.join(B, name)
    if check:
        same = os.path.isfile(path) and open(path, encoding='utf-8').read() == text
        print(f'{"PASS" if same else "FAIL"}  {name} re-derives byte for byte from the parts', flush=True)
        bad += 0 if same else 1
    else:
        open(path, 'w', encoding='utf-8').write(text)
        print(f'wrote {name}', flush=True)
sys.exit(1 if bad else 0)
