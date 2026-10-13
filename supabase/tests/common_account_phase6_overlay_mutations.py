#!/usr/bin/env python3
"""Mutation checks for the Phase 6 source overlay (common_account_phase6_overlay_run.sh, section e2e).

Each mutant changes ONE integration rule in a COPY of G5's files (never in the checkout) and runs the overlay's
end-to-end section against F4's real adapter and SQL; the section must FAIL. A control run must pass first.
Disposable local PostgreSQL only (CAL_PGHOST / CAL_PGPORT / CAL_PGSUPER, as the runner).
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNNER = ROOT / "supabase/tests/common_account_phase6_overlay_run.sh"
FILES = [
    "supabase/migrations/20261010051938_common_account_service_write_guard.sql",
    "supabase/migrations/20261012130000_common_account_core_service_fence.sql",
    "supabase/migrations/20261012230000_common_account_service_brand_state.sql",
    "supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql",
    "supabase/tests/common_account_write_guard_fixture.sql",
    "supabase/tests/common_account_phase6_overlay_e2e_test.ts",
    "supabase/tests/common_account_phase6_overlay_probe.sql",
]
DIRS = ["supabase/functions/account-delete", "supabase/candidates/common_account_provider_registration"]

REGISTRY = "supabase/candidates/common_account_provider_registration/provider_registry.threads.candidate.ts"
GRANT = "supabase/candidates/common_account_provider_registration/threads_cleanup_execute_grant_candidate.sql"
LOGIC = "supabase/functions/account-delete/lifecycle_logic.ts"
MIGRATION = "supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql"

MUTANTS = [
    ("Threads is registered as able to confirm a remote revoke (no acknowledgement, a lie to the person)",
     REGISTRY, "remoteRevoke: { threads: 'unsupported' }", "remoteRevoke: { threads: 'supported' }"),
    ("the acknowledgement is never recorded before the removal",
     LOGIC,
     "      const ack = await call(deps, 'acknowledge_unverified', { ...own, p_providers: needsAck });\n"
     "      if (ack?.status === 'lease_lost') return { ok: false, response: args.lost() };\n"
     "      if (ack?.status !== 'recorded') return refuse(fail(500, 'FAILED'));\n",
     ""),
    ("an acknowledged provider that only says not connected is no longer reported as remote-unverified",
     MIGRATION,
     "   where v = 'local_removed_remote_unverified'\n      or (v = 'not_connected' and k = any (coalesce(v_operation.remote_unverified_ack_providers, '{}'::text[])));\n",
     "   where v = 'local_removed_remote_unverified';\n"),
    ("the removal function is not granted to the deletion role",
     GRANT, "grant execute on function public.cleanup_threads_provider_footprint(uuid) to service_role;\n", ""),
    ("the registry registers no adapter",
     REGISTRY, "adapters: [createThreadsProviderCleanupAdapter(store)],", "adapters: [],"),
    ("the claim does not put the connected providers on the record before they are touched",
     MIGRATION,
     "         provider_results = v_pending || provider_results,   -- what was already answered wins\n",
     ""),
]


def run(root: pathlib.Path, sections: str, extra=None) -> subprocess.CompletedProcess:
    env = dict(os.environ, CAL_OVERLAY_G5_ROOT=str(root), CAL_OVERLAY_SECTIONS=sections, **(extra or {}))
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True)


# One edit of F4's guards candidate, in the runner's throw-away tree; the section named must FAIL.
F4_MUTANTS = [
    ("F4's writer takes the workspace row lock BEFORE the owner's lifecycle decision",
     "order",
     "  v_code := public.threads_manual_publish_owner_fence(v_brand_id);\n  if v_code is not null then return v_code; end if;\n"
     "  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;\n",
     "  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;\n"
     "  v_code := public.threads_manual_publish_owner_fence(v_brand_id);\n  if v_code is not null then return v_code; end if;\n"),
]


def stage(tmp: pathlib.Path) -> pathlib.Path:
    root = tmp / "g5"
    for rel in FILES:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, root / rel)
    for rel in DIRS:
        shutil.copytree(ROOT / rel, root / rel)
    return root


def killed_line(result: subprocess.CompletedProcess) -> str:
    last = [line for line in (result.stdout + result.stderr).splitlines() if line.startswith("FAIL")]
    return last[-1] if last else "failed"


def main() -> int:
    for var in ("CAL_PGHOST", "CAL_PGPORT", "CAL_PGSUPER"):
        if var not in os.environ:
            print(f"{var} is required", file=sys.stderr)
            return 2
    sections = os.environ.get("CAL_OVERLAY_SECTIONS", "grant,e2e")
    with tempfile.TemporaryDirectory(prefix="kabumori-p6-overlay-mut-") as tmp_name:
        tmp = pathlib.Path(tmp_name)
        control = run(stage(tmp / "control"), sections + ",order")
        if control.returncode != 0 or "PHASE6_OVERLAY_ALL_PASS" not in control.stdout:
            print("control run failed:\n" + control.stdout[-2000:] + control.stderr[-2000:])
            return 1
        print("control: unmutated overlay passes")
        survivors = 0
        for index, (label, rel, find, replace) in enumerate(MUTANTS, 1):
            root = stage(tmp / f"m{index}")
            path = root / rel
            source = path.read_text()
            if source.count(find) != 1:
                print(f"mutant {index:2d} INVALID  {label}: anchor found {source.count(find)} times")
                survivors += 1
                continue
            path.write_text(source.replace(find, replace))
            result = run(root, sections)
            if result.returncode == 0:
                print(f"mutant {index:2d} SURVIVED {label}")
                survivors += 1
            else:
                print(f"mutant {index:2d} KILLED   {label}: {killed_line(result)}")
        for index, (label, section, find, replace) in enumerate(F4_MUTANTS, 1):
            result = run(stage(tmp / f"f{index}"), section,
                         {"CAL_OVERLAY_GUARDS_FIND": find, "CAL_OVERLAY_GUARDS_REPLACE": replace})
            if result.returncode == 0:
                print(f"F4 mutant {index} SURVIVED {label}")
                survivors += 1
            else:
                print(f"F4 mutant {index} KILLED   {label}: {killed_line(result)}")
        if survivors:
            print(f"{survivors} mutant(s) survived or were invalid")
            return 1
        print(f"PHASE6_OVERLAY_MUTATIONS_PASS ({len(MUTANTS)} G5 + {len(F4_MUTANTS)} F4-overlay mutants killed)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
