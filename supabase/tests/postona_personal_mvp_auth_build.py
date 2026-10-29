"""G5-46: build (or --check) the PERSONAL MVP auth profile (supabase/candidates/postona_personal_mvp_auth/) -- the G5 gates a 1 user / 1 workspace
POSTONA needs, WITHOUT the brand owner epoch (PR #285 / #303 / #457) -- deterministically from reviewed text:
  MVP_INSTALL.sql   ONE transaction:
                      the MVP prerequisites (P1 lifecycle chain, P3 G3's L-1 revoke, P4 auth, not a superuser; NO owner epoch);
                      bundle part 60 (S2-2) and part 70 (S2-1, T13's anonymous refusal), each with only its own begin; / commit; removed;
                      from bundle part 50 (S2-3) ONLY the predicate: its relation / derivation preconditions and its create + revoke, verbatim
                        (part 50's R0 checks and R0 body are left out: the MVP has no R0);
                      from bundle part 10 (R1) ONLY the generation coverage GC: its comment, create, revoke and install check, verbatim;
                      parts/M10 (the new personal worker verdict MV), its own begin; / commit; removed;
                      parts/M20 (G5-47: R1-MVP, the R1 v1 verdict with the personal generation token g5pv), its own begin; / commit; removed;
                      the MVP postcondition (every gate owner-only, no API role reaches it).
  MVP_ROLLBACK.sql  ONE transaction: RM20 (R1-MVP), RM10 (MV), the S2-3 predicate and GC drops (each refuses while another function names it or a dependency is
                      recorded), bundle R60 (S2-2) and R70 (T13 back to its reviewed body), each part's own begin; / commit; removed.
  MVP_R1_EXECUTE_GRANT.sql / MVP_R1_EXECUTE_REVOKE.sql (G5-48, hand-written): R1-MVP's one EXECUTE to authenticated and its idempotent stop;
                    this script checks the grant's md5(prosrc) pin is exactly the M20 body.
Every source is checked by git blob id first. Nothing else ships here but parts/ and README.md.
Usage: python3 supabase/tests/postona_personal_mvp_auth_build.py <repository root> [--check]"""
import hashlib
import os
import subprocess
import sys

repo = sys.argv[1]
check = '--check' in sys.argv[2:]
BUNDLE = os.path.join(repo, 'supabase/candidates/postona_personal_auth_bundle')
OUT = os.path.join(repo, 'supabase/candidates/postona_personal_mvp_auth')
BLOB = {'10_r1_authorization_verdict.sql': '6e4ebfc4eb19807b8b0a493c8169313d66c9a1fc',
        '50_s2_3_workspace_eligibility.sql': '84a9ad79484b68b5b05691c6b17ce4b3f32a13a6',
        '60_s2_2_personal_session.sql': '0790ad69e99f10bc57965aad88831b4baa143895',
        '70_s2_1_t13_anonymous_refusal.sql': '8cbba51c631c9b99fd5cee11ef66bd3e46e70086',
        'R60_s2_2_personal_session_rollback.sql': '852a51537b1d422d14b9ef362a0c5648bd441d0c',
        'R70_s2_1_t13_anonymous_refusal_rollback.sql': '9fd0a07b73cc04f2d64101c027decf236e395285'}


def read(path, blob=None):
    text = open(path, encoding='utf-8').read()
    if blob is not None:
        got = subprocess.run(['git', 'hash-object', path], capture_output=True, text=True, check=True).stdout.strip()
        if got != blob:
            sys.exit(f'{os.path.basename(path)}: blob {got}, expected {blob}')
    return text


def strip_tx(name, text):
    lines = text.split('\n')
    if lines.count('begin;') != 1 or lines.count('commit;') != 1 or text.rstrip('\n').split('\n')[-1] != 'commit;':
        sys.exit(f'{name}: expected exactly one `begin;` line and one final `commit;` line')
    lines.remove('begin;')
    lines.remove('commit;')
    return '\n'.join(lines)


def bundle(name):
    return read(os.path.join(BUNDLE, name), BLOB[name])


def whole(name, text):
    return f'-- ==== {name}: its own begin; / commit; removed, nothing else changed ====\n' + strip_tx(name, text)


def lines_of(name, text, first, last, starts, ends):
    """lines first..last (1-based, inclusive) of a pinned part; the first and last line must be the expected ones"""
    got = text.split('\n')[first - 1:last]
    if not got[0].startswith(starts) or not got[-1].startswith(ends):
        sys.exit(f'{name} lines {first}-{last}: boundaries moved')
    return '\n'.join(got)


p10, p50 = bundle('10_r1_authorization_verdict.sql'), bundle('50_s2_3_workspace_eligibility.sql')
S23 = ('-- ==== from part 50_s2_3_workspace_eligibility.sql: the S2-3 PREDICATE only -- its relation / derivation preconditions (lines 64-95)\n'
       '-- inside this wrapper, then lines 98-143 (create + revoke), verbatim. Part 50\'s R0 checks and R0 body are not part of the MVP. ====\n'
       'do $$\ndeclare\n  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);\n  v_rel text;\n  v_kind "char";\n'
       '  v_rls boolean;\n  v_forced boolean;\n  v_relowner oid;\nbegin\n'
       + lines_of('50', p50, 64, 95, '  -- the predicate is new', '  end if;') + '\nend $$;\n\n'
       + lines_of('50', p50, 98, 143, '-- S2-3: the personal-workspace eligibility', 'revoke all on function private.postona_personal_workspace_eligibility'))
GC = ('-- ==== from part 10_r1_authorization_verdict.sql: the generation coverage GC only (lines 98-130), verbatim. R1 / W1 / W2 are not part of\n'
      '-- the MVP (they read the owner epoch). ====\n'
      + lines_of('10', p10, 98, 130, '-- The service generation W1 compares', 'end $$;'))

# P1 as the G5-42 migration candidate names it (one function per migration of the G5 lifecycle chain)
P1 = [('private', 'account_lifecycle_lock', '20261001150000'), ('private', 'account_lifecycle_start_service', '20261006230000'),
      ('private', 'account_lifecycle_gate_open', '20261009120000'), ('private', 'account_lifecycle_assert_active_service_write', '20261010051938'),
      ('private', 'account_lifecycle_service_state_refusal', '20261012130000'), ('private', 'account_lifecycle_brand_owner', '20261012230000'),
      ('private', 'account_lifecycle_finish_service_deletion', '20261013120000'), ('public', 'common_account_service_end_result', '20261013140000'),
      ('private', 'account_lifecycle_enrollment_fence', '20261015090000'), ('public', 'record_owned_service_deletion_x_unconfirmed', '20261015120000')]
P1_SQL = '\n'.join(
    f"""  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = '{s}' and p.proname = '{f}') then
    raise exception 'MVP_PREREQ_P1_LIFECYCLE_CHAIN %', '{m} ({s}.{f})';
  end if;""" for s, f, m in P1)
PREREQ = f"""-- ==== G5-46 MVP PREREQUISITES (read-only) ====
-- P1 the G5 lifecycle chain 20261001150000 .. 20261015120000; P3 G3's L-1 revoke on public.brand_memberships; P4 auth.uid() (STABLE), auth.users,
-- auth.sessions. NOT required: the brand owner epoch (PR #285 / #303 / #457) -- nothing in this profile reads it.
do $$
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'MVP_PREREQ_OWNER_IS_SUPERUSER';
  end if;
{P1_SQL}
  if pg_catalog.to_regclass('public.brand_memberships') is null
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
                 and pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'TRIGGER'))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
                 and (pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'TRUNCATE')
                      or pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'REFERENCES')
                      or pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'INSERT')
                      or pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'UPDATE')
                      or pg_catalog.has_table_privilege(r.oid, 'public.brand_memberships', 'DELETE'))) then
    raise exception 'MVP_PREREQ_P3_MEMBERSHIP_WRITE';
  end if;
  if pg_catalog.to_regprocedure('auth.uid()') is null
     or (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'auth.uid()'::pg_catalog.regprocedure) is distinct from 's'
     or pg_catalog.to_regclass('auth.users') is null or pg_catalog.to_regclass('auth.sessions') is null then
    raise exception 'MVP_PREREQ_P4_AUTH';
  end if;
end $$;
"""
GATES = ['private.postona_personal_session()', 'private.postona_personal_workspace_eligibility(uuid)',
         'private.account_lifecycle_assert_active_service_write(uuid,text)', 'private.account_lifecycle_generation_covered()',
         'private.postona_personal_worker_verdict(uuid,text,text,bigint)', 'public.common_account_authorization_verdict(text,text,text)']
POST = """-- ==== G5-46 MVP POSTCONDITION: every gate is the lifecycle owner's, owner-only, unreachable by any API role ====
do $$
declare v_sig text;
begin
  foreach v_sig in array array[%s] loop
    if pg_catalog.to_regprocedure(v_sig) is null
       or (select pg_catalog.array_to_string(p.proacl::text[], ',') from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(v_sig))
          is distinct from pg_catalog.format('%%s=X/%%s', current_user, current_user)
       or (select p.proowner from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(v_sig))
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
       or exists (select 1 from pg_catalog.pg_roles a join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.oid, r.oid, 'MEMBER')
                   where a.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                     and pg_catalog.has_function_privilege(r.oid, pg_catalog.to_regprocedure(v_sig), 'EXECUTE')) then
      raise exception 'MVP_POSTCONDITION_ACL %%', v_sig;
    end if;
  end loop;
end $$;
""" % ', '.join(f"'{g}'" for g in GATES)


def drop_fenced(code, sig, needle):
    return f"""-- ==== drop {sig}: refuses while another function names it (lower-cased source) or a dependency is recorded ====
do $$
declare v_fn regprocedure := pg_catalog.to_regprocedure('{sig}');
begin
  if v_fn is null or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'MVP_ROLLBACK_{code}_NOT_INSTALLED';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.oid <> v_fn and pg_catalog.strpos(pg_catalog.lower(p.prosrc), '{needle}') > 0) then
    raise exception 'MVP_ROLLBACK_{code}_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = v_fn and d.deptype in ('n', 'a')) then
    raise exception 'MVP_ROLLBACK_{code}_DEPENDENTS';
  end if;
end $$;

drop function {sig.replace(',', ', ')};
"""


HEAD = """-- G5 PERSONAL MVP AUTH PROFILE (G5-46, Issue #320 task 46) -- NOT in supabase/migrations/, NOT applied anywhere. GENERATED by
-- supabase/tests/postona_personal_mvp_auth_build.py (`--check` re-derives it byte for byte). An ALTERNATIVE to the G5-42 migration candidate for a
-- 1 user / 1 workspace POSTONA: it needs no brand owner epoch (PR #457); no R0 / SV / W1 / W2, and R1 only as R1-MVP (personal generation token
-- g5pv, owner-only here: the reviewed authenticated grant is the bundled review's decision). The two profiles exclude each other
-- (the second one refuses on a taken name). Production NO_GO: one independent review of this profile, the managed read-only audit and the
-- owner's explicit approval first. Run as the lifecycle owner (never a superuser) with ON_ERROR_STOP.
"""
m10 = read(os.path.join(OUT, 'parts/M10_personal_worker_verdict.sql'))
rm10 = read(os.path.join(OUT, 'parts/RM10_personal_worker_verdict_rollback.sql'))
m20 = read(os.path.join(OUT, 'parts/M20_personal_authorization_verdict.sql'))
rm20 = read(os.path.join(OUT, 'parts/RM20_personal_authorization_verdict_rollback.sql'))
install = (HEAD + "begin;\n\nset local lock_timeout = '5s';\n\n" + PREREQ + '\n'
           + whole('part 60_s2_2_personal_session.sql', bundle('60_s2_2_personal_session.sql')) + '\n'
           + whole('part 70_s2_1_t13_anonymous_refusal.sql', bundle('70_s2_1_t13_anonymous_refusal.sql')) + '\n'
           + S23 + '\n\n' + GC + '\n\n' + whole('parts/M10_personal_worker_verdict.sql', m10) + '\n'
           + whole('parts/M20_personal_authorization_verdict.sql', m20) + '\n' + POST + '\ncommit;\n')
rollback = (HEAD + "begin;\n\nset local lock_timeout = '5s';\n\n" + whole('parts/RM20_personal_authorization_verdict_rollback.sql', rm20) + '\n'
            + whole('parts/RM10_personal_worker_verdict_rollback.sql', rm10) + '\n'
            + drop_fenced('S23', 'private.postona_personal_workspace_eligibility(uuid)', 'postona_personal_workspace_eligibility') + '\n'
            + drop_fenced('GC', 'private.account_lifecycle_generation_covered()', 'account_lifecycle_generation_covered') + '\n'
            + whole('part R60_s2_2_personal_session_rollback.sql', bundle('R60_s2_2_personal_session_rollback.sql')) + '\n'
            + whole('part R70_s2_1_t13_anonymous_refusal_rollback.sql', bundle('R70_s2_1_t13_anonymous_refusal_rollback.sql')) + '\ncommit;\n')
bad = 0
for name, text in (('MVP_INSTALL.sql', install), ('MVP_ROLLBACK.sql', rollback)):
    path = os.path.join(OUT, name)
    if check:
        same = os.path.isfile(path) and open(path, encoding='utf-8').read() == text
        print(f'{"PASS" if same else "FAIL"}  {name} re-derives byte for byte', flush=True)
        bad += 0 if same else 1
    else:
        open(path, 'w', encoding='utf-8').write(text)
        print(f'wrote {name}', flush=True)
# G5-48: the EXECUTE grant (hand-written) grants only on EXACTLY the M20 body: its md5(prosrc) pin must be the body between M20's dollar quotes
start = m20.index('create function public.common_account_authorization_verdict(')
body_from = m20.index('$$', start) + 2
body_md5 = hashlib.md5(m20[body_from:m20.index('$$', body_from)].encode('utf-8')).hexdigest()
grant = read(os.path.join(OUT, 'MVP_R1_EXECUTE_GRANT.sql'))
pinned = grant.count(f"pg_catalog.md5(p.prosrc) = '{body_md5}'") == 1
print(f'{"PASS" if pinned else "FAIL"}  MVP_R1_EXECUTE_GRANT.sql pins the M20 body (md5 {body_md5})', flush=True)
bad += 0 if pinned else 1
if check:
    extra = sorted(set(os.listdir(OUT)) - {'MVP_INSTALL.sql', 'MVP_ROLLBACK.sql', 'MVP_R1_EXECUTE_GRANT.sql', 'MVP_R1_EXECUTE_REVOKE.sql', 'README.md', 'parts'})
    print(f'{"PASS" if not extra else "FAIL"}  only the four entrypoints, parts/ and README.md{": " + ", ".join(extra) if extra else ""}', flush=True)
    bad += 1 if extra else 0
sys.exit(1 if bad else 0)
