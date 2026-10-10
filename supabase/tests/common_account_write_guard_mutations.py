"""Defect-detection proof for common_account_write_guard_run.sh (common account Phase 3b service-write guard).
Each mutation breaks exactly one property in a COPY of the candidate, runs the full runner against that copy
and requires it to fail with the named message that guards that property. The real file is never edited.
Disposable local PostgreSQL only; same environment variables as the runner (CAL_PGHOST, CAL_PGPORT,
CAL_PGSUPER). One mutation at a time (the runner creates cluster-wide roles).

Not listed on purpose (defense in depth, no observable defect alone): the entitlement row's FOR UPDATE
(every entitlement change also updates the account row through Phase 1's trigger, which the guard already
holds FOR UPDATE), the separate `v_session_id is null` test (an absent session id never matches a row) and
either one of the two equal subject comparisons (auth.uid() reads the same claim source). Removing both
subject comparisons is still refused later by the session's owner check; what it loses -- refusing before
the other person's rows are locked -- is what race 6g detects.
Usage: CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... python3 supabase/tests/common_account_write_guard_mutations.py"""
import os
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
candidate = os.path.join(here, '..', 'migrations', '20261010051938_common_account_service_write_guard.sql')
runner = os.path.join(here, 'common_account_write_guard_run.sh')
source = open(candidate, encoding='utf-8').read()

SECTION_2 = source[source.index('  -- 2. I1 lock order'):source.index('  -- 3. The session is still live')]
SECTION_3 = source[source.index('  -- 3. The session is still live'):source.index('end;\n$$;\n\nrevoke all')]
# Section 3 split into the read of the session and the decision on it.
SECTION_3_READ = SECTION_3[:SECTION_3.index('  if not v_live then')]
SECTION_3_DECIDE = SECTION_3[SECTION_3.index('  if not v_live then'):]

M = [
    # --- the caller is the person ---------------------------------------------------------------------
    ('a non-authenticated role claim is accepted', "or v_role is distinct from 'authenticated'\n", "\n",
     'FAIL B2: an anon role claim'),
    ('the guard trusts p_user_id', "\n     or v_subject <> p_user_id or (select auth.uid()) is distinct from p_user_id then", " then",
     'FAIL race foreign-id'),
    ('a revoked or foreign session is accepted', '  if not v_live then', '  if false then', "FAIL B6: another person's session"),
    ("another person's session is accepted", ' and s.user_id = p_user_id', '', "FAIL B6: another person's session"),
    ('a time-boxed session past its end is accepted',
     '\n                         and (s.not_after is null or s.not_after > clock_timestamp())', '',
     'FAIL B8: a time-boxed session past its end'),
    ('claim sources are mixed',
     "    v_session := nullif(current_setting('request.jwt.claim.session_id', true), '');",
     "    v_session := coalesce(nullif(current_setting('request.jwt.claim.session_id', true), ''),\n"
     "                          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id');",
     'FAIL B9: claim sources are not mixed'),
    # Same refusal codes and order, but the session snapshot is taken before the lock wait.
    ('the session is read before the lock wait', SECTION_2 + SECTION_3, SECTION_3_READ + SECTION_2 + SECTION_3_DECIDE,
     'FAIL race revoke-while-waiting'),
    # --- the common account -----------------------------------------------------------------------------
    ('no lifecycle lock (plain read of the account)', '  v_account := private.account_lifecycle_lock(p_user_id, false);',
     '  select * into v_account from public.common_accounts where user_id = p_user_id;',
     'FAIL race begin-then-write'),
    ('a missing account is created', 'private.account_lifecycle_lock(p_user_id, false)', 'private.account_lifecycle_lock(p_user_id, true)',
     'FAIL C2: no common account'),
    ('a deleting account is not reported as such',
     "    raise exception 'ACCOUNT_DELETION_IN_PROGRESS' using errcode = '42501';", '    null;',
     'FAIL C3: deleting (POSTONA)'),
    ('an open account deletion is ignored when the row says active',
     "\n     or exists (select 1 from private.account_lifecycle_operations o\n"
     "                 where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress')", '',
     'FAIL C4: open deletion with an active account row'),
    ('a locked account is accepted',
     "  if v_account.status <> 'active' then\n    raise exception 'ACCOUNT_LOCKED'",
     "  if false then\n    raise exception 'ACCOUNT_LOCKED'", 'FAIL C5: locked account'),
    # --- the service entitlement --------------------------------------------------------------------------
    ('an unknown service key is accepted',
     "  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then", '  if false then',
     'FAIL D1: unknown service key'),
    ('a missing entitlement is accepted', "    raise exception 'SERVICE_NOT_REGISTERED' using errcode = '42501';", '    null;',
     'FAIL A: ... but not POSTONA'),
    ('a service deletion is not reported as such',
     "    raise exception 'SERVICE_DELETION_IN_PROGRESS' using errcode = '42501';", '    null;',
     'FAIL D2: service deletion in progress'),
    ('an open service deletion is ignored when the row says active',
     "\n     or exists (select 1 from private.account_lifecycle_operations o\n"
     "                 where o.user_id = p_user_id and o.operation_type = 'service_deletion'\n"
     "                   and o.service_key = p_service_key and o.status = 'in_progress')", '',
     'FAIL D3: open service deletion with an active entitlement row'),
    ('an inactive entitlement is accepted',
     "  if v_status <> 'active' then\n    raise exception 'SERVICE_NOT_ACTIVE'",
     "  if false then\n    raise exception 'SERVICE_NOT_ACTIVE'", 'FAIL D4: ended'),
    # --- fail closed ------------------------------------------------------------------------------------
    ('another isolation level is not refused by the guard',
     "  if current_setting('transaction_isolation') <> 'read committed' then\n    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE'",
     "  if false then\n    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE'",
     'FAIL fail-closed: repeatable read accepted'),
    ('an unreadable session table is not reported as fence unavailable',
     '  exception when undefined_table or undefined_column or insufficient_privilege then\n'
     "    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';\n  end;\n  if not v_live",
     '  end;\n  if not v_live', 'FAIL fail-closed: unreadable sessions accepted'),
    # --- privileges -------------------------------------------------------------------------------------
    ('EXECUTE stays with PUBLIC and the API roles',
     'revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;',
     '', 'COMMON_ACCOUNT_WRITE_GUARD_POSTCONDITION_ACL'),
    ('EXECUTE granted to authenticated',
     'revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;',
     'revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;\n'
     'grant execute on function private.account_lifecycle_assert_active_service_write(uuid, text) to authenticated;',
     'COMMON_ACCOUNT_WRITE_GUARD_POSTCONDITION_ACL'),
    ('the postcondition is disabled and EXECUTE granted', "    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_POSTCONDITION_ACL';",
     "    null;\n  end if;\n  if false then\n    null;", 'FAIL change: unexpected additions'),
    ('the guard runs with the caller\'s rights', 'returns void language plpgsql volatile security definer set search_path = \'\'',
     'returns void language plpgsql volatile security invoker set search_path = \'\'',
     'FAIL the candidate creates, replaces, alters or drops something beyond its one function'),
    # --- preflight --------------------------------------------------------------------------------------
    ('preflight accepts a missing or reshaped auth.sessions',
     "    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_SHAPE';", '    null;', 'FAIL preflight'),
    ('preflight accepts unreadable sessions',
     "    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_UNREADABLE';", '    null;',
     'FAIL preflight accepted: expected COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_UNREADABLE'),
    ('preflight accepts an API role on the lifecycle lock',
     "    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_LOCK_ACL_CHANGED';", '    null;',
     'FAIL preflight accepted: expected COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_LOCK_ACL_CHANGED'),
    ('preflight accepts a missing foundation',
     "    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_FOUNDATION_MISSING';", '    null;', 'FAIL preflight'),
    ('the guard writes a row', "  if not v_live then",
     "  insert into public.fixture_service_footprint (user_id, service_key) values (p_user_id, 'probe');\n  if not v_live then",
     'FAIL the candidate writes rows'),
]

detected = 0
failures = []
with tempfile.TemporaryDirectory(prefix='kabumori-cal-write-guard-mutations.', dir='/private/tmp') as tmp:
    for i, (label, old, new, expect) in enumerate(M):
        if source.count(old) != 1:
            failures.append(f'INVALID ({source.count(old)} sites)  {label}')
            continue
        mutant = source.replace(old, new)
        # Disabling the postcondition alone is no defect; with a grant it is one the static rules must catch.
        if label == 'the postcondition is disabled and EXECUTE granted':
            mutant = mutant.replace(
                'revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;',
                'revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;\n'
                'grant execute on function private.account_lifecycle_assert_active_service_write(uuid, text) to authenticated;')
        path = os.path.join(tmp, f'm{i}.sql')
        open(path, 'w', encoding='utf-8').write(mutant)
        env = dict(os.environ, CAL_WRITE_GUARD_CANDIDATE=path)
        run = subprocess.run(['bash', runner], env=env, capture_output=True, text=True)
        out = run.stdout + run.stderr
        if run.returncode != 0 and expect in out:
            detected += 1
            print(f'DETECTED  {label}')
        else:
            reason = 'SURVIVED' if run.returncode == 0 else 'WRONG_REASON'
            lines = [l for l in out.splitlines() if 'FAIL' in l or 'ERROR' in l][:3]
            failures.append(f'{reason}  {label}: ' + ' | '.join(lines))

for failure in failures:
    print(failure, file=sys.stderr)
if failures:
    print(f'FAIL {len(failures)} of {len(M)} mutations were not detected as expected', file=sys.stderr)
    sys.exit(1)
print(f'COMMON_ACCOUNT_WRITE_GUARD_MUTATIONS_ALL_DETECTED {detected}/{len(M)}')
