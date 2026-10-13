#!/usr/bin/env python3
"""Mutation checks for the release preflight itself (common_account_release_preflight_run.sh).

Each mutant is ONE deliberate regression in a COPY of the chain (migrations, rollbacks, probe, runner inputs); the
runner's sections chain / probe / rollback must FAIL on it, and must pass on the unmutated copy first. The checkout is
never edited. Disposable local PostgreSQL only (CAL_PGHOST / CAL_PGPORT / CAL_PGSUPER, as the runner).

Usage: python3 supabase/tests/common_account_release_preflight_mutations.py
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
TREES = ["supabase/migrations", "supabase/tests", "supabase/preflight"]
RUNNER = "supabase/tests/common_account_release_preflight_run.sh"
SECTIONS = "chain,probe,rollback"

MIG = "supabase/migrations/"
P3A = MIG + "20261009120000_common_account_deletion_completion.sql"
P4 = MIG + "20261012130000_common_account_core_service_fence.sql"
P5 = MIG + "20261012230000_common_account_service_brand_state.sql"
P6 = MIG + "20261013120000_common_account_service_deletion_ownership.sql"
PROBE = "supabase/preflight/common_account_release_probe.sql"
RB1 = "supabase/tests/common_account_lifecycle_rollback.sql"
RB6 = "supabase/tests/common_account_service_deletion_rollback.sql"
RB3B = "supabase/tests/common_account_write_guard_rollback.sql"

# (label, file, find, replace, expected failing stage label fragment)
MUTANTS = [
    ("Phase 6 no longer requires the Phase 4 state decision", P6,
     "  if to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is null then\n"
     "    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_CORE_FENCE_MISSING';\n  end if;\n",
     "", "chain"),
    ("Phase 5 no longer refuses an application without the Phase 4 fence", P5,
     "COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_FOUNDATION_MISSING", "COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_SOMETHING_ELSE", "chain"),
    ("Phase 3a refuses a second application with another code", P3A,
     "COMMON_ACCOUNT_DELETION_COMPLETION_ALREADY_APPLIED", "COMMON_ACCOUNT_DELETION_COMPLETION_APPLIED_TWICE", "chain"),
    ("a migration of the chain is not one transaction", P4,
     "\ncommit;\n", "\n-- commit;\n", "chain"),
    ("the probe's gate fails open", PROBE,
     "  select coalesce(current_setting('kabumori.disposable_probe', true) = 'yes', false) as setting_ok,",
     "  select true as setting_ok,", "probe"),
    ("the probe no longer looks at PUBLIC execute", PROBE,
     "select 202, 'B3_function_public_execute',\n         case when (select count(*) from exp_fn e join cat_fn c on c.sig = e.sig where c.public_exec) = 0 then 'PASS' else 'FAIL' end,",
     "select 202, 'B3_function_public_execute',\n         case when true then 'PASS' else 'FAIL' end,", "probe"),
    ("the probe no longer checks RLS", PROBE,
     "case when (select count(*) from exp_rel e join cat_rel c on c.rel = e.rel where e.kind = 'r' and not c.rls) = 0 then 'PASS' else 'FAIL' end,",
     "case when true then 'PASS' else 'FAIL' end,", "probe"),
    ("the probe no longer checks the managed delete gate", PROBE,
     "              when (select gate_blocked from dyn) = 1 and (select gate_rows from dyn) = 1 then 'PASS'\n              else 'FAIL' end,",
     "              else 'PASS' end,", "probe"),
    ("the probe writes (a DML statement appears)", PROBE,
     "rollback;\n", "update public.service_entitlements set status = status;\nrollback;\n", "probe"),
    ("the Phase 6 rollback forgets a function", RB6,
     "drop function public.common_account_provider_snapshot(uuid);\n", "", "rollback"),
    ("the Phase 3b rollback leaves the guard", RB3B,
     "drop function private.account_lifecycle_assert_active_service_write(uuid, text);\n", "", "rollback"),
    ("the Phase 1 rollback no longer refuses while a later phase is present", RB1,
     "    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_LATER_PHASE_PRESENT';\n", "    null;\n", "rollback"),
]


def stage(tmp: pathlib.Path) -> pathlib.Path:
    for tree in TREES:
        shutil.copytree(ROOT / tree, tmp / tree)
    return tmp


def run(root: pathlib.Path, sections: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, CAL_PREFLIGHT_SECTIONS=sections)
    return subprocess.run(["bash", str(root / RUNNER)], env=env, capture_output=True, text=True, timeout=1200)


def main() -> int:
    for var in ("CAL_PGHOST", "CAL_PGPORT", "CAL_PGSUPER"):
        if var not in os.environ:
            print(f"{var} is required", file=sys.stderr)
            return 2
    survivors = 0
    with tempfile.TemporaryDirectory(prefix="kabumori-release-preflight-mut-") as tmp_name:
        tmp = pathlib.Path(tmp_name)
        control = run(stage(tmp / "control"), SECTIONS)
        if control.returncode != 0 or "COMMON_ACCOUNT_RELEASE_PREFLIGHT_ALL_PASS" not in control.stdout:
            print("control run failed:\n" + control.stdout[-2500:] + control.stderr[-2500:])
            return 1
        print("control: the unmutated copy passes chain, probe and rollback")
        for index, (label, rel, find, replace, expect) in enumerate(MUTANTS, 1):
            root = stage(tmp / f"m{index}")
            path = root / rel
            source = path.read_text()
            if source.count(find) < 1:
                print(f"mutant {index:2d} INVALID  {label}: anchor not found")
                survivors += 1
                continue
            path.write_text(source.replace(find, replace, 1))
            result = run(root, SECTIONS)
            if result.returncode == 0:
                print(f"mutant {index:2d} SURVIVED {label}")
                survivors += 1
                continue
            lines = [line for line in (result.stdout + result.stderr).splitlines() if line.startswith("FAIL")]
            print(f"mutant {index:2d} KILLED   {label}: {lines[-1][:150] if lines else 'failed'}")
    if survivors:
        print(f"{survivors} mutant(s) survived or were invalid")
        return 1
    print(f"COMMON_ACCOUNT_RELEASE_PREFLIGHT_MUTATIONS_PASS ({len(MUTANTS)} mutants killed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
