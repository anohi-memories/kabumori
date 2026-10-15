#!/usr/bin/env python3
"""Mutation check for 20261015120000_common_account_x_unconfirmed_snapshot_record (Phase 10, F5).

Each mutant changes ONE rule of the migration (or of its rollback) in a scratch copy; the proof runner
(common_account_x_unconfirmed_snapshot_run.sh: preflight, exact change, static, behavior, race, rollback) must fail.
An unmutated control must pass first. Disposable local PostgreSQL only.

Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
       python3 supabase/tests/common_account_x_unconfirmed_snapshot_mutations.py
"""
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
MIGRATION = HERE.parent / "migrations" / "20261015120000_common_account_x_unconfirmed_snapshot_record.sql"
ROLLBACK = HERE / "common_account_x_unconfirmed_snapshot_rollback.sql"
RUNNER = HERE / "common_account_x_unconfirmed_snapshot_run.sh"

# (label, target, old, new)
MUTANTS = [
    ("a new evidence set is not appended (only the first ever lands)", "migration",
     "    v_snapshots := v_snapshots || to_jsonb(p_snapshot);\n",
     "    null;\n"),
    ("the count is overwritten, not kept at its maximum", "migration",
     "  v_count := greatest(coalesce((v_operation.reconciliation ->> 'x_posts_unconfirmed')::integer, 0), p_count);",
     "  v_count := p_count;"),
    ("an already recorded set is appended again (duplicates)", "migration",
     "  if not (v_snapshots ? p_snapshot) then\n",
     "  if true then\n"),
    ("the cap of sixteen sets is not enforced by the function", "migration",
     "    if jsonb_array_length(v_snapshots) >= 16 then",
     "    if jsonb_array_length(v_snapshots) >= 100 then"),
    ("the snapshot name is not validated", "migration",
     " or p_snapshot is null or p_snapshot !~ '^[0-9a-f]{64}$' then",
     " or p_snapshot is null then"),
    ("the count is not bounded below (zero is recorded)", "migration",
     "  if p_count is null or p_count < 1 or p_count > 100000",
     "  if p_count is null or p_count > 100000"),
    ("a lost lease is recorded anyway (the owner check result is ignored)", "migration",
     "  if v_operation.id is null or v_account.user_id is null then\n    return jsonb_build_object('status', 'lease_lost');\n  end if;\n  v_count",
     "  v_count"),
    ("the recorder serves any service key", "migration",
     "  if p_service_key is distinct from 'x_autopost' then\n    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';\n  end if;\n  if p_count",
     "  if p_count"),
    ("the shape check does not require the elements to be 64-hex strings", "migration",
     ' && !exists($.x_unconfirmed_snapshots[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{64}$")))',
     ""),
    ("the shape check allows 17 sets", "migration",
     '$.x_unconfirmed_snapshots.size() <= 16', '$.x_unconfirmed_snapshots.size() <= 17'),
    ("the shape check allows an empty set array", "migration",
     '$.x_unconfirmed_snapshots.size() >= 1 && ', ''),
    ("the shape check allows snapshots without a count", "migration",
     '$.x_posts_unconfirmed.type() == "number" && ', ''),
    ("the shape check lets a failed evaluation pass (NULL is accepted)", "migration",
     "'{}'::jsonb, true), false)));",
     "'{}'::jsonb, true), true)));"),
    ("the shape check allows another key next to the pair", "migration",
     "    and (reconciliation - 'x_posts_unconfirmed' - 'x_unconfirmed_snapshots') = '{}'::jsonb\n",
     ""),
    ("the recorder is callable by the person", "migration",
     "grant execute on function public.record_owned_service_deletion_x_unconfirmed(uuid, text, uuid, uuid, integer, text) to service_role;",
     "grant execute on function public.record_owned_service_deletion_x_unconfirmed(uuid, text, uuid, uuid, integer, text) to service_role, authenticated;"),
    ("the recorder runs with a caller search_path", "migration",
     "returns jsonb language plpgsql security definer set search_path = ''\nas $$\ndeclare\n  v_account public.common_accounts;",
     "returns jsonb language plpgsql security definer\nas $$\ndeclare\n  v_account public.common_accounts;"),
    ("the recorder skips the common lock order", "migration",
     "  v_account := private.account_lifecycle_lock(p_user_id, false);\n",
     "  select * into v_account from public.common_accounts where user_id = p_user_id;\n"),
    ("the preflight no longer refuses a reachable owner check", "migration",
     "    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_OWNER_CHECK_ACL';",
     "    null;"),
    ("the preflight no longer requires the Phase 8 read-back function", "migration",
     "     or to_regprocedure('public.common_account_service_end_result(uuid,text)') is null\n", ""),
    ("the preflight no longer requires the Phase 8 shape check", "migration",
     "                    and pg_get_constraintdef(c.oid) like '%x_posts_unconfirmed%') then\n    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_SHAPE';",
     "                    and pg_get_constraintdef(c.oid) like '%x_posts_unconfirmed%') and false then\n    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_SHAPE';"),
    ("the preflight adopts rows with a foreign key", "migration",
     "              where o.reconciliation - 'x_posts_unconfirmed' - 'x_unconfirmed_snapshots' <> '{}'::jsonb) then",
     "              where false) then"),
    ("the preflight lets a superuser apply it", "migration",
     "  if (select r.rolsuper from pg_roles r where r.rolname = current_user) is distinct from false\n     or (select c.relowner",
     "  if (select c.relowner"),
    ("the rollback narrows the constraint even when evidence is on record", "rollback",
     "  if exists (select 1 from private.account_lifecycle_operations o where o.reconciliation ? 'x_unconfirmed_snapshots') then",
     "  if false then"),
    ("the rollback leaves the recorder function in place", "rollback",
     "drop function public.record_owned_service_deletion_x_unconfirmed(uuid, text, uuid, uuid, integer, text);\n",
     ""),
    ("the rollback erases the recorded evidence before narrowing", "rollback",
     "    raise notice 'COMMON_ACCOUNT_X_UNCONFIRMED_ROLLBACK_KEPT_WIDER_SHAPE';",
     "    update private.account_lifecycle_operations set reconciliation = reconciliation - 'x_unconfirmed_snapshots';\n    raise notice 'COMMON_ACCOUNT_X_UNCONFIRMED_ROLLBACK_KEPT_WIDER_SHAPE';"),
]


def run(migration: pathlib.Path, rollback: pathlib.Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, LC_ALL="C", CAL_XU_CANDIDATE=str(migration), CAL_XU_ROLLBACK=str(rollback))
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True, timeout=900)


def main() -> int:
    mig = MIGRATION.read_text(encoding="utf-8")
    rb = ROLLBACK.read_text(encoding="utf-8")
    only = {int(x) for x in os.environ.get("CAL_XU_MUTANTS", "").split(",") if x.strip()}
    with tempfile.TemporaryDirectory(prefix="xu-mut-") as tmp:
        if not only:
            control = run(MIGRATION, ROLLBACK)
            ok = control.returncode == 0 and "XU_ALL_PASS" in control.stdout
            print("control: unmutated candidate " + ("passes" if ok else "FAILS"))
            if not ok:
                print(control.stdout[-1500:], control.stderr[-1500:])
                return 1
        survivors = []
        for i, (label, target, old, new) in enumerate(MUTANTS, 1):
            if only and i not in only:
                continue
            base = mig if target == "migration" else rb
            if base.count(old) != 1:
                print(f"mutant {i:2d} INVALID  {label}: site matched {base.count(old)} times")
                survivors.append(label)
                continue
            mutated = pathlib.Path(tmp) / f"mutant_{i}.sql"
            mutated.write_text(base.replace(old, new), encoding="utf-8")
            result = run(mutated, ROLLBACK) if target == "migration" else run(MIGRATION, mutated)
            if result.returncode != 0:
                text = (result.stderr or result.stdout).strip().splitlines()
                print(f"mutant {i:2d} KILLED   {label}: {text[-1][:110] if text else ''}")
            else:
                print(f"mutant {i:2d} SURVIVED {label}")
                survivors.append(label)
    if survivors:
        print("SURVIVORS: " + "; ".join(survivors))
        return 1
    print(f"COMMON_ACCOUNT_X_UNCONFIRMED_MUTATIONS_PASS ({len(only) or len(MUTANTS)} mutants killed)")
    return 0


sys.exit(main())
