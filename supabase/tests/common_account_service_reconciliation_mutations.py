#!/usr/bin/env python3
"""Mutation check for 20261013140000_common_account_service_reconciliation_facts (Phase 8, F5).

Each mutant changes ONE rule of the candidate in a scratch copy; the proof runner (preflight, static, behavior) must
fail. An unmutated control must pass first. Disposable local PostgreSQL only.

Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
       python3 supabase/tests/common_account_service_reconciliation_mutations.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
CANDIDATE = HERE.parent / "migrations" / "20261013140000_common_account_service_reconciliation_facts.sql"
RUNNER = HERE / "common_account_service_reconciliation_run.sh"
SECTIONS = "preflight,exact,static,behavior,rollback"

MUTANTS = [
    ("a later, smaller count overwrites the maximum",
     "greatest(v_existing, p_count)), updated_at = now()", "p_count), updated_at = now()"),
    ("the owner's lease is not checked",
     "  if v_operation.id is null or v_account.user_id is null then\n    return jsonb_build_object('status', 'lease_lost');\n  end if;\n  v_existing",
     "  v_operation := (select o from private.account_lifecycle_operations o where o.id = p_operation_id);\n  v_existing"),
    ("the count is not bounded",
     "  if p_fact is distinct from 'x_posts_unconfirmed' or p_count is null or p_count < 1 or p_count > 100000 then",
     "  if p_fact is distinct from 'x_posts_unconfirmed' then"),
    ("an unknown fact name is accepted",
     "  if p_fact is distinct from 'x_posts_unconfirmed' or p_count is null",
     "  if p_count is null"),
    ("another service may record",
     "  if p_service_key is distinct from 'x_autopost' then\n    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';\n  end if;\n  if p_fact",
     "  if p_fact"),
    ("an acknowledged provider that only says not connected is not reported as unverified",
     "          or (r.v = 'not_connected' and r.k = any (coalesce(v_operation.remote_unverified_ack_providers, '{}'::text[])))), '[]'::jsonb),",
     "          ), '[]'::jsonb),"),
    ("the read-back reports the person's other service operation",
     "  if p_service_key is distinct from 'x_autopost' then\n    return jsonb_build_object('status', 'none');\n  end if;\n  select",
     "  select"),
    ("the record function is open to authenticated",
     "grant execute on function public.record_owned_service_deletion_reconciliation(uuid, text, uuid, uuid, text, integer) to service_role;",
     "grant execute on function public.record_owned_service_deletion_reconciliation(uuid, text, uuid, uuid, text, integer) to service_role, authenticated;"),
    ("the read-back is open to authenticated",
     "grant execute on function public.common_account_service_end_result(uuid, text) to service_role;",
     "grant execute on function public.common_account_service_end_result(uuid, text) to service_role, authenticated;"),
    ("the shape constraint accepts any key",
     "    and (reconciliation - 'x_posts_unconfirmed') = '{}'::jsonb\n", ""),
    ("the preflight no longer requires Phase 6",
     "  if to_regprocedure('public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)') is null\n     or to_regprocedure('public.finish_owned_service_deletion(uuid,text,uuid,uuid)') is null\n",
     "  if false\n     or to_regprocedure('public.finish_owned_service_deletion(uuid,text,uuid,uuid)') is null\n"),
    ("a same-named column of another shape is adopted",
     "     and not (exists (select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum",
     "     and false and not (exists (select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum"),
    ("a re-apply over existing functions is not refused up front",
     "                and p.proname in ('record_owned_service_deletion_reconciliation', 'common_account_service_end_result')) then\n    raise exception 'COMMON_ACCOUNT_RECONCILIATION_ALREADY_APPLIED';",
     "                and p.proname in ('record_owned_service_deletion_reconciliation', 'common_account_service_end_result')) then\n    raise exception 'COMMON_ACCOUNT_RECONCILIATION_SOMETHING_ELSE';"),
    ("the column is added again even when it is there",
     "  if not exists (select 1 from pg_attribute a where a.attrelid = 'private.account_lifecycle_operations'::regclass\n                   and a.attname = 'reconciliation' and not a.attisdropped) then\n    alter table",
     "  if true then\n    alter table"),
]


def run(candidate: pathlib.Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, LC_ALL="C", CAL_RECON_CANDIDATE=str(candidate), CAL_RECON_SECTIONS=SECTIONS)
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True, timeout=900)


def main() -> int:
    for var in ("CAL_PGHOST", "CAL_PGPORT", "CAL_PGSUPER"):
        if var not in os.environ:
            print(f"{var} is required", file=sys.stderr)
            return 2
    source = CANDIDATE.read_text()
    with tempfile.TemporaryDirectory(prefix="recon-mut.") as tmp:
        control = pathlib.Path(tmp) / "control.sql"
        control.write_text(source)
        result = run(control)
        if result.returncode != 0 or "COMMON_ACCOUNT_RECONCILIATION_ALL_PASS" not in result.stdout:
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
                lines = [l for l in (result.stderr + result.stdout).splitlines() if l.startswith("FAIL") or "POSTCONDITION" in l or "ERROR" in l]
                detail = (lines[0] if lines else "(failed while applying or running)")[:140]
            print(f"mutant {index:2d} {'KILLED  ' if killed else 'SURVIVED'} {name}: {detail}")
            if not killed:
                survivors.append(name)
        if survivors:
            print("SURVIVORS: " + "; ".join(survivors))
            return 1
        print(f"COMMON_ACCOUNT_RECONCILIATION_MUTATIONS_PASS ({len(MUTANTS)} mutants killed)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
