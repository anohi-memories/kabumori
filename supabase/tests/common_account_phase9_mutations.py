#!/usr/bin/env python3
"""Mutation check for 20261015090000_common_account_enrollment_session_fence (Phase 9, F5).

Each mutant changes ONE rule of the migration in a scratch copy; the proof runner (sections fence + e2e: preflight,
exact change, static, behavior, rollback, and the real apps' modules over the fake GoTrue / PostgREST seams) must
fail. An unmutated control must pass first. Disposable local PostgreSQL only.

Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
       python3 supabase/tests/common_account_phase9_mutations.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
CANDIDATE = HERE.parent / "migrations" / "20261015090000_common_account_enrollment_session_fence.sql"
RUNNER = HERE / "common_account_phase9_shared_login_run.sh"

MUTANTS = [
    ("a guest (anonymous) session is not refused",
     "  if lower(coalesce(v_anonymous, '')) in ('true', 't', '1') then",
     "  if false then"),
    ("the explicit restart does not require a live session (the fence is a no-op for it)",
     "  if not p_require_live_session then\n    return;\n  end if;",
     "  if true then\n    return;\n  end if;"),
    ("a session of ANOTHER login counts as live",
     "                       where s.id = v_session_id and s.user_id = p_user_id\n",
     "                       where s.id = v_session_id\n"),
    ("an expired session (not_after in the past) counts as live",
     "                         and (s.not_after is null or s.not_after > clock_timestamp()));",
     "                         );"),
    ("an unreadable session table is treated as live (fails open)",
     "    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';\n  end;\n  if not v_live then",
     "    v_live := true;\n  end;\n  if not v_live then"),
    ("the automatic start of POSTONA also needs a live session (sign-up gains a new dependency)",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, false);\n  return private.account_lifecycle_start_service(v_user_id, 'x_autopost');",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, true);\n  return private.account_lifecycle_start_service(v_user_id, 'x_autopost');"),
    ("the automatic start of POSTONA skips the fence",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, false);\n  return private.account_lifecycle_start_service(v_user_id, 'x_autopost');",
     "  return private.account_lifecycle_start_service(v_user_id, 'x_autopost');"),
    ("ensure_my_profile skips the fence",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, false);\n  v_answer := private.account_lifecycle_start_service(v_user_id, 'kabumori');",
     "  v_answer := private.account_lifecycle_start_service(v_user_id, 'kabumori');"),
    ("the Kabumori restart skips the live-session requirement",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, true);\n  return private.account_lifecycle_reactivate_service(v_user_id, 'kabumori', p_expected_lifecycle_version);",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, false);\n  return private.account_lifecycle_reactivate_service(v_user_id, 'kabumori', p_expected_lifecycle_version);"),
    ("the POSTONA restart skips the live-session requirement",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, true);\n  return private.account_lifecycle_reactivate_service(v_user_id, 'x_autopost', p_expected_lifecycle_version);",
     "  perform private.account_lifecycle_enrollment_fence(v_user_id, false);\n  return private.account_lifecycle_reactivate_service(v_user_id, 'x_autopost', p_expected_lifecycle_version);"),
    ("the internal check is granted to the person's role",
     "revoke all on function private.account_lifecycle_enrollment_fence(uuid, boolean) from public, anon, authenticated, service_role;",
     "revoke all on function private.account_lifecycle_enrollment_fence(uuid, boolean) from public, anon, service_role;"),
    ("the preflight no longer pins the bodies it replaces",
     "      raise exception 'COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_DRIFT:%', v_expected[v_i][1];",
     "      null;"),
    ("the preflight no longer requires the Phase 2 restart function",
     "     or to_regprocedure('private.account_lifecycle_reactivate_service(uuid,text,bigint)') is null\n",
     "     or false\n"),
    ("a public wrapper loses SECURITY DEFINER (runs with the caller's rights)",
     "create or replace function public.start_x_autopost_service()\nreturns jsonb language plpgsql volatile security definer set search_path = ''",
     "create or replace function public.start_x_autopost_service()\nreturns jsonb language plpgsql volatile set search_path = ''"),
]


def run(candidate: pathlib.Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, LC_ALL="C", CAL_P9_FENCE=str(candidate), CAL_P9_SECTIONS="world,fence,e2e")
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True, timeout=1500)


def main() -> int:
    original = CANDIDATE.read_text(encoding="utf-8")
    only = {int(x) for x in os.environ.get("CAL_P9_MUTANTS", "").split(",") if x.strip()}
    with tempfile.TemporaryDirectory(prefix="p9-mut-") as tmp:
        if not only:
            control = run(CANDIDATE)
            ok = control.returncode == 0 and "PHASE9_ALL_PASS" in control.stdout
            print("control: unmutated candidate " + ("passes" if ok else "FAILS"))
            if not ok:
                print(control.stdout[-1500:], control.stderr[-1500:])
                return 1
        survivors = []
        for i, (label, old, new) in enumerate(MUTANTS, 1):
            if only and i not in only:
                continue
            if original.count(old) != 1:
                print(f"mutant {i:2d} INVALID  {label}: site matched {original.count(old)} times")
                survivors.append(label)
                continue
            mutant = pathlib.Path(tmp) / f"mutant_{i}.sql"
            mutant.write_text(original.replace(old, new), encoding="utf-8")
            result = run(mutant)
            if result.returncode != 0:
                text = (result.stderr or result.stdout).strip().splitlines()
                print(f"mutant {i:2d} KILLED   {label}: {text[-1][:110] if text else ''}")
            else:
                print(f"mutant {i:2d} SURVIVED {label}")
                survivors.append(label)
    if survivors:
        print("SURVIVORS: " + "; ".join(survivors))
        return 1
    print(f"COMMON_ACCOUNT_PHASE9_MUTATIONS_PASS ({len(only) or len(MUTANTS)} mutants killed)")
    return 0


sys.exit(main())
