#!/usr/bin/env python3
"""Mutation check for 20261012230000_common_account_service_brand_state (Phase 5, F5).

Each mutant changes ONE rule of the candidate in a scratch copy; the proof runner (behavior, races) must fail.
An unmutated control must pass first. Disposable local PostgreSQL only.

Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
       python3 supabase/tests/common_account_brand_state_mutations.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
CANDIDATE = HERE.parent / "migrations" / "20261012230000_common_account_service_brand_state.sql"
RUNNER = HERE / "common_account_brand_state_run.sh"
SECTIONS = "behavior,races"

MUTANTS = [
    ("a workspace with several owners still resolves an owner",
     "     and (select count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner') = 1\n", ""),
    ("a workspace that is not a user workspace resolves an owner",
     "     and b.code_profile_key = 'social_mobile_user_v1'\n", ""),
    ("the readonly decision ignores the entitlement status",
     "  if v_status <> 'active' then\n    return 'SERVICE_NOT_ACTIVE';\n  end if;\n  return null;\nend;\n$$;\n\n-- 3.",
     "  return null;\nend;\n$$;\n\n-- 3."),
    ("the readonly decision ignores a deleting account",
     "  if v_account_status = 'deleting'\n     or exists (select 1 from private.account_lifecycle_operations o\n                 where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then\n    return 'ACCOUNT_DELETION_IN_PROGRESS';\n  end if;\n",
     ""),
    ("the readonly decision ignores an open service deletion beside an active row",
     "                   and o.service_key = p_service_key and o.status = 'in_progress') then\n    return 'SERVICE_DELETION_IN_PROGRESS';",
     "                   and o.service_key = p_service_key and o.status = 'never') then\n    return 'SERVICE_DELETION_IN_PROGRESS';"),
    ("an unknown workspace reads as active",
     "  if v_owner is null then\n    return 'WORKSPACE_OWNER_UNKNOWN';\n  end if;\n  v_refusal := private.account_lifecycle_service_state_readonly",
     "  if v_owner is null then\n    return 'active';\n  end if;\n  v_refusal := private.account_lifecycle_service_state_readonly"),
    ("the ordering variant never refuses",
     "  if v_refusal is not null then\n    raise exception '%', v_refusal using errcode = case when v_refusal = 'ACCOUNT_LIFECYCLE_BUSY' then '55P03' else '42501' end;\n  end if;\nend;",
     "  null;\nend;"),
    ("the ordering variant only reads (it takes no lock)",
     "  v_refusal := private.account_lifecycle_service_state_refusal(v_owner, p_service_key);\n  if v_refusal is not null then\n    raise exception '%', v_refusal using errcode = case",
     "  v_refusal := private.account_lifecycle_service_state_readonly(v_owner, p_service_key);\n  if v_refusal is not null then\n    raise exception '%', v_refusal using errcode = case"),
    ("the predicate is open to authenticated",
     "grant execute on function public.common_account_brand_service_state(text, text) to service_role;",
     "grant execute on function public.common_account_brand_service_state(text, text) to service_role, authenticated;"),
]


def run(candidate: pathlib.Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, LC_ALL="C", CAL_BRAND_STATE_CANDIDATE=str(candidate), CAL_BRAND_STATE_SECTIONS=SECTIONS)
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True, timeout=900)


def main() -> int:
    for var in ("CAL_PGHOST", "CAL_PGPORT", "CAL_PGSUPER"):
        if var not in os.environ:
            print(f"{var} is required", file=sys.stderr)
            return 2
    source = CANDIDATE.read_text()
    with tempfile.TemporaryDirectory(prefix="brand-state-mut.") as tmp:
        control = pathlib.Path(tmp) / "control.sql"
        control.write_text(source)
        result = run(control)
        if result.returncode != 0 or "COMMON_ACCOUNT_BRAND_STATE_ALL_PASS" not in result.stdout:
            print("CONTROL FAILED:\n" + result.stdout[-1500:] + result.stderr[-1500:])
            return 1
        print("control: unmutated candidate passes")
        survivors = []
        for index, (name, find, replace) in enumerate(MUTANTS, 1):
            if source.count(find) != 1:
                print(f"mutant {index} '{name}': the pattern is not unique ({source.count(find)})")
                return 1
            mutated = pathlib.Path(tmp) / f"mutant_{index}.sql"
            mutated.write_text(source.replace(find, replace))
            result = run(mutated)
            killed = result.returncode != 0
            detail = ""
            if killed:
                lines = [l for l in (result.stderr + result.stdout).splitlines() if l.startswith("FAIL") or "ERROR" in l or "POSTCONDITION" in l]
                detail = (lines[0] if lines else "(failed while applying or running)")[:150]
            print(f"mutant {index:2d} {'KILLED  ' if killed else 'SURVIVED'} {name}: {detail}")
            if not killed:
                survivors.append(name)
        if survivors:
            print("SURVIVORS: " + "; ".join(survivors))
            return 1
        print(f"COMMON_ACCOUNT_BRAND_STATE_MUTATIONS_PASS ({len(MUTANTS)} mutants killed)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
