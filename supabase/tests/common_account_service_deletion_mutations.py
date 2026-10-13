#!/usr/bin/env python3
"""Mutation check for 20261013120000_common_account_service_deletion_ownership (Phase 6, F5).

Each mutant changes ONE rule of the candidate in a scratch copy; the proof runner (behavior, races) must fail.
An unmutated control must pass first. Disposable local PostgreSQL only.

Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
       python3 supabase/tests/common_account_service_deletion_mutations.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
CANDIDATE = HERE.parent / "migrations" / "20261013120000_common_account_service_deletion_ownership.sql"
RUNNER = HERE / "common_account_service_deletion_run.sh"
SECTIONS = "behavior,races"

MUTANTS = [
    ("the lease is judged at the transaction start (now()), not the wall clock",
     "     or v_operation.owner_lease_expires_at <= clock_timestamp() then\n    return null;",
     "     or v_operation.owner_lease_expires_at <= now() then\n    return null;"),
    ("the owner check ignores which lease is presented",
     "  if not found or p_lease is null or v_operation.owner_lease is distinct from p_lease\n     or v_operation.owner_lease_expires_at",
     "  if not found or p_lease is null\n     or v_operation.owner_lease_expires_at"),
    ("a live lease of another owner does not stop a claim",
     "  if v_operation.owner_lease is not null and v_operation.owner_lease_expires_at > clock_timestamp() then\n    return jsonb_build_object('status', 'in_progress');\n  end if;\n",
     ""),
    ("a claim inside an account deletion does not check that deletion's lease",
     "    if private.account_lifecycle_owned_operation(p_user_id, p_account_operation_id, p_account_lease) is null then\n      return jsonb_build_object('status', 'lease_lost');\n    end if;\n",
     "    null;\n"),
    ("a service-only claim is allowed during an account deletion",
     "  elsif v_account.status <> 'active'\n        or exists (select 1 from private.account_lifecycle_operations o\n                    where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then\n    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS');\n  end if;",
     "  end if;"),
    ("the claim does not record the providers as pending",
     "         provider_results = v_pending || provider_results,   -- what was already answered wins\n",
     ""),
    ("a settled fact can be overwritten by a later answer",
     "  if v_existing in ('local_removed_remote_unverified', 'confirmed_remote_revoked')\n     and p_result is distinct from 'confirmed_remote_revoked' then\n    return jsonb_build_object('status', 'recorded', 'kept', v_existing);\n  end if;",
     "  null;"),
    ("an unsettled provider does not block the end",
     "  if cardinality(v_unsettled) > 0 then\n    return jsonb_build_object('status', 'not_ready', 'reason', 'PROVIDER_RESULTS_UNSETTLED', 'providers', to_jsonb(v_unsettled));\n  end if;",
     "  null;"),
    ("X need not be accounted for",
     "  if not (v_operation.provider_results ? 'x') then\n    return jsonb_build_object('status', 'not_ready', 'reason', 'PROVIDER_RESULTS_UNSETTLED', 'providers', jsonb_build_array('x'));\n  end if;\n",
     ""),
    ("an unverified remote grant needs no acknowledgement",
     "  if cardinality(v_unverified) > 0\n     and (v_operation.remote_unverified_ack_at is null\n          or not (v_unverified <@ coalesce(v_operation.remote_unverified_ack_providers, '{}'::text[]))) then",
     "  if false then"),
    ("the finished operation keeps its lease",
     "    update private.account_lifecycle_operations\n       set owner_lease = null, owner_lease_expires_at = null, updated_at = now()\n     where id = p_operation_id;\n    return v_answer || jsonb_build_object('provider_results'",
     "    return v_answer || jsonb_build_object('provider_results'"),
    ("the legacy finish still ends POSTONA",
     "  if p_service_key = 'x_autopost' then\n    return jsonb_build_object('status', 'blocked', 'reason', 'OWNED_FINISH_REQUIRED');\n  end if;\n",
     ""),
    ("the legacy abort still aborts POSTONA",
     "  if p_service_key = 'x_autopost' then\n    return jsonb_build_object('status', 'blocked', 'reason', 'OWNED_ABORT_REQUIRED');\n  end if;\n",
     ""),
    ("the cleanup predicate does not need a lease",
     "       and o.owner_lease is not null and o.owner_lease_expires_at > clock_timestamp()\n",
     ""),
    ("the cleanup predicate is judged at the transaction start",
     "       and o.owner_lease is not null and o.owner_lease_expires_at > clock_timestamp()\n",
     "       and o.owner_lease is not null and o.owner_lease_expires_at > now()\n"),
    ("the provider snapshot is open to authenticated",
     "grant execute on function public.common_account_provider_snapshot(uuid) to service_role;",
     "grant execute on function public.common_account_provider_snapshot(uuid) to service_role, authenticated;"),
]


def run(candidate: pathlib.Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, LC_ALL="C", CAL_SERVICE_DELETION_CANDIDATE=str(candidate), CAL_SERVICE_DELETION_SECTIONS=SECTIONS)
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True, timeout=900)


def main() -> int:
    for var in ("CAL_PGHOST", "CAL_PGPORT", "CAL_PGSUPER"):
        if var not in os.environ:
            print(f"{var} is required", file=sys.stderr)
            return 2
    source = CANDIDATE.read_text()
    with tempfile.TemporaryDirectory(prefix="svc-del-mut.") as tmp:
        control = pathlib.Path(tmp) / "control.sql"
        control.write_text(source)
        result = run(control)
        if result.returncode != 0 or "COMMON_ACCOUNT_SERVICE_DELETION_ALL_PASS" not in result.stdout:
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
                lines = [l for l in (result.stderr + result.stdout).splitlines() if l.startswith("FAIL") or "POSTCONDITION" in l]
                detail = (lines[0] if lines else "(failed while applying or running)")[:140]
            print(f"mutant {index:2d} {'KILLED  ' if killed else 'SURVIVED'} {name}: {detail}")
            if not killed:
                survivors.append(name)
        if survivors:
            print("SURVIVORS: " + "; ".join(survivors))
            return 1
        print(f"COMMON_ACCOUNT_SERVICE_DELETION_MUTATIONS_PASS ({len(MUTANTS)} mutants killed)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
