#!/usr/bin/env python3
"""Mutation check for 20261012130000_common_account_core_service_fence (Phase 4, G5).

Each mutant changes ONE rule of the candidate in a scratch copy and the proof runner (behavior, races and
fail-closed sections) must fail. An unmutated control must pass first. Disposable local PostgreSQL only.

Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
       python3 supabase/tests/common_account_core_fence_mutations.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
CANDIDATE = HERE.parent / "migrations" / "20261012130000_common_account_core_service_fence.sql"
RUNNER = HERE / "common_account_core_fence_run.sh"
SECTIONS = "behavior,races,failclosed"
# Not mutated on purpose: the service entitlement's FOR UPDATE row lock. It follows the Phase 3b guard and the
# T13 contract, but every entitlement change also updates the account row (account_lifecycle_touch_entitlement),
# which the account FOR UPDATE already serializes, so no observable behavior depends on it: an equivalent mutant.

MUTANTS = [
    ("entitlement status check removed",
     "    if v_status <> 'active' then\n      return 'SERVICE_NOT_ACTIVE';\n    end if;\n", ""),
    ("account locked check removed",
     "    if v_account.status <> 'active' then\n      return 'ACCOUNT_LOCKED';\n    end if;\n", ""),
    ("deleting account not refused",
     "    if v_account.status = 'deleting'\n       or exists (select 1 from private.account_lifecycle_operations o\n"
     "                   where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then\n"
     "      return 'ACCOUNT_DELETION_IN_PROGRESS';\n    end if;\n", ""),
    ("open service deletion not seen when the entitlement row says active",
     "                     and o.service_key = p_service_key and o.status = 'in_progress') then\n      return 'SERVICE_DELETION_IN_PROGRESS';",
     "                     and o.service_key = p_service_key and o.status = 'never') then\n      return 'SERVICE_DELETION_IN_PROGRESS';"),
    ("account lock replaced by a plain read",
     "    v_account := private.account_lifecycle_lock(p_user_id, false);\n",
     "    select * into v_account from public.common_accounts where user_id = p_user_id;\n"),
    ("a refusal creates the account",
     "    v_account := private.account_lifecycle_lock(p_user_id, false);\n",
     "    v_account := private.account_lifecycle_lock(p_user_id, true);\n"),
    ("bounded wait handler removed",
     "  exception when lock_not_available then\n    -- A freeze (or another long lifecycle step) holds the locks: retryable, nothing was written.\n    return 'ACCOUNT_LIFECYCLE_BUSY';\n",
     "  exception when no_data_found then\n    return 'ACCOUNT_LIFECYCLE_BUSY';\n"),
    ("lock wait unbounded",
     " set lock_timeout = '3s'\nas $$\ndeclare\n  v_account public.common_accounts;", "\nas $$\ndeclare\n  v_account public.common_accounts;"),
    ("foreign id check before the lock removed",
     "  if v_actor is not null and v_actor <> v_user then\n    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';\n  end if;\n", ""),
    ("fence ignores its service argument",
     "  v_refusal := private.account_lifecycle_service_state_refusal(v_user, v_service);\n",
     "  v_refusal := private.account_lifecycle_service_state_refusal(v_user, 'kabumori');\n"),
    ("profile root trigger not created",
     "create trigger account_lifecycle_profile_root_fence\n  before insert on public.profiles\n  for each row execute function private.account_lifecycle_service_insert_fence('id', 'kabumori');\n", ""),
    ("ensure_my_profile still inserts directly",
     "  v_answer := private.account_lifecycle_start_service(v_user_id, 'kabumori');\n",
     "  insert into public.profiles (id) values (v_user_id) on conflict (id) do nothing;\n  v_answer := jsonb_build_object('status', 'active');\n"),
    ("ensure_my_profile restarts an ended service silently",
     "  if v_answer ->> 'status' = 'reenroll_required' then\n    raise exception 'SERVICE_REENROLL_REQUIRED' using errcode = '42501';\n  end if;\n",
     "  if v_answer ->> 'status' = 'reenroll_required' then\n    return v_user_id;\n  end if;\n"),
    ("insert fence accepts an update attachment",
     "  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op <> 'INSERT' or tg_nargs <> 2 then\n",
     "  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_nargs <> 2 then\n"),
]


def run(candidate: pathlib.Path, sections: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, LC_ALL="C", CAL_CORE_FENCE_CANDIDATE=str(candidate), CAL_CORE_FENCE_SECTIONS=sections)
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True, timeout=900)


def main() -> int:
    for var in ("CAL_PGHOST", "CAL_PGPORT", "CAL_PGSUPER"):
        if var not in os.environ:
            print(f"{var} is required", file=sys.stderr)
            return 2
    source = CANDIDATE.read_text()
    with tempfile.TemporaryDirectory(prefix="core-fence-mut.") as tmp:
        control = pathlib.Path(tmp) / "control.sql"
        control.write_text(source)
        result = run(control, SECTIONS)
        if result.returncode != 0 or "COMMON_ACCOUNT_CORE_FENCE_ALL_PASS" not in result.stdout:
            print("CONTROL FAILED (unmutated candidate does not pass):\n" + result.stdout[-1500:] + result.stderr[-1500:])
            return 1
        print("control: unmutated candidate passes")
        survivors = []
        for index, (name, find, replace) in enumerate(MUTANTS, 1):
            if source.count(find) != 1:
                print(f"mutant {index} '{name}': the pattern is not unique in the candidate ({source.count(find)})")
                return 1
            mutated = pathlib.Path(tmp) / f"mutant_{index}.sql"
            mutated.write_text(source.replace(find, replace))
            result = run(mutated, SECTIONS)
            killed = result.returncode != 0
            detail = ""
            if killed:
                lines = [l for l in (result.stderr + result.stdout).splitlines() if l.startswith("FAIL") or "COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT" in l]
                detail = (lines[0] if lines else "(failed while applying or running)")[:150]
            print(f"mutant {index:2d} {'KILLED  ' if killed else 'SURVIVED'} {name}: {detail}")
            if not killed:
                survivors.append(name)
        if survivors:
            print("SURVIVORS: " + "; ".join(survivors))
            return 1
        print(f"COMMON_ACCOUNT_CORE_FENCE_MUTATIONS_PASS ({len(MUTANTS)} mutants killed)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
