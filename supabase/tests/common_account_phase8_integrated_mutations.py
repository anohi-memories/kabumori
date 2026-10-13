#!/usr/bin/env python3
"""Mutation check for the ASSEMBLED proof (common_account_phase8_integrated_run.sh): each mutant changes ONE seam
between the three stacks in this checkout (in place; the original bytes are restored in a `finally`), and the
integrated runner (sections world, e2e, acl) must fail. An unmutated control must pass first. Disposable local
PostgreSQL only. ~1.5 minutes per mutant.

Optional: CAL_P8_MUTANTS=6,7 runs only those mutants (no control).
Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
       python3 supabase/tests/common_account_phase8_integrated_mutations.py
"""
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNNER = HERE / "common_account_phase8_integrated_run.sh"
SECTIONS = "world,e2e,acl"

HTTP = "supabase/functions/account-delete/http.ts"
LOGIC = "supabase/functions/account-delete/lifecycle_logic.ts"
REGISTRY = "supabase/candidates/common_account_provider_registration/provider_registry.threads.candidate.ts"
GRANT = "supabase/candidates/common_account_provider_registration/threads_cleanup_execute_grant_candidate.sql"
P1 = "supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql"
P8 = "supabase/migrations/20261013140000_common_account_service_reconciliation_facts.sql"

MUTANTS = [
    ("the common flow asks the X saga for scope social_and_login (it would delete the login)", HTTP,
     "expected_scope: 'social_only',", "expected_scope: 'social_and_login',"),
    ("an X revoke that failed is read as done", HTTP,
     "  if (error === 'X_REVOKE_FAILED' || error === 'CREDENTIALS_CHANGED' || error === 'FINALIZE_FAILED') return { outcome: 'failed', reason: error };\n",
     "  if (error === 'X_REVOKE_FAILED') return { outcome: 'done' };\n"),
    ("Threads is registered as remotely revocable (no acknowledgement is asked for)", REGISTRY,
     "remoteRevoke: { threads: 'unsupported' },", "remoteRevoke: { threads: 'supported' },"),
    ("the cleanup grant also goes to authenticated", GRANT,
     "grant execute on function public.cleanup_threads_provider_footprint(uuid) to service_role;",
     "grant execute on function public.cleanup_threads_provider_footprint(uuid) to service_role, authenticated;"),
    ("an end does not move the entitlement to deleting (competing writers are not refused)", P1,
     "  update public.service_entitlements set status = 'deleting', updated_at = now()\n   where user_id = p_user_id and service_key = p_service_key;\n  insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type, service_key)",
     "  update public.service_entitlements set updated_at = now()\n   where user_id = p_user_id and service_key = p_service_key;\n  insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type, service_key)"),
    ("the read-back of an end leaves out the durable facts (a later read would say clean)", P8,
     "    'reconciliation', v_operation.reconciliation,\n", "    'reconciliation', '{}'::jsonb,\n"),
    ("the saga's unconfirmed count is not recorded (a retry would end clean)", LOGIC,
     "      let fact: Record<string, unknown> | null = null;\n      for (let attempt = 0; attempt < FACT_ATTEMPTS && fact?.status !== 'recorded' && fact?.status !== 'lease_lost'; attempt++) {\n        fact = await call(deps, 'record_reconciliation', { ...own, p_fact: 'x_posts_unconfirmed', p_count: unconfirmedPosts });\n      }\n",
     "      const fact: Record<string, unknown> | null = { status: 'recorded' };\n"),
]


def run() -> subprocess.CompletedProcess:
    env = dict(os.environ, LC_ALL="C", CAL_P8_SECTIONS=SECTIONS)
    return subprocess.run(["bash", str(RUNNER)], env=env, capture_output=True, text=True, timeout=1500)


def main() -> int:
    only = {int(x) for x in os.environ.get("CAL_P8_MUTANTS", "").split(",") if x.strip()}   # e.g. "6" re-runs one mutant
    if not only:
        control = run()
        print("control: unmutated assembly " + ("passes" if control.returncode == 0 and "PHASE8_ALL_PASS" in control.stdout else "FAILS"))
        if control.returncode != 0:
            print(control.stdout[-1500:], control.stderr[-1500:])
            return 1
    survivors = []
    for i, (label, rel, old, new) in enumerate(MUTANTS, 1):
        if only and i not in only:
            continue
        path = REPO / rel
        original = path.read_bytes()
        text = original.decode("utf-8")
        if text.count(old) != 1:
            print(f"mutant {i:2d} INVALID  {label}: site matched {text.count(old)} times")
            survivors.append(label)
            continue
        try:
            path.write_bytes(text.replace(old, new).encode("utf-8"))
            result = run()
        finally:
            path.write_bytes(original)
        if result.returncode != 0:
            tail = (result.stderr or result.stdout).strip().splitlines()[-1][:110] if (result.stderr or result.stdout).strip() else ""
            print(f"mutant {i:2d} KILLED   {label}: {tail}")
        else:
            print(f"mutant {i:2d} SURVIVED {label}")
            survivors.append(label)
    if survivors:
        print("SURVIVORS: " + "; ".join(survivors))
        return 1
    print(f"COMMON_ACCOUNT_PHASE8_INTEGRATED_MUTATIONS_PASS ({len(only) or len(MUTANTS)} mutants killed)")
    return 0


sys.exit(main())
