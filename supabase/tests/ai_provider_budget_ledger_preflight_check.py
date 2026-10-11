#!/usr/bin/env python3
"""Verdict for ai_provider_budget_ledger_preflight.sql (read-only production preflight of the AI budget ledger).

  supabase db query --linked --project-ref <ref> --output-format json \
    -f supabase/tests/ai_provider_budget_ledger_preflight.sql | python3 -I supabase/tests/ai_provider_budget_ledger_preflight_check.py

Reads the CLI output from stdin (a plain JSON array, or the {"boundary", "rows", "warning"} object the CLI prints
when it detects an agent) and prints only catalog facts: no table data, no secret. Exit 0 = READY_TO_APPLY,
1 = NOT_READY (the migration would refuse, or it is already there), 2 = unreadable input.
"""
import json
import sys


def load_result(text):
    data = json.loads(text)
    rows = data.get("rows") if isinstance(data, dict) else data
    if not isinstance(rows, list) or len(rows) != 1:
        raise ValueError("expected exactly one row")
    result = rows[0].get("result")
    return json.loads(result) if isinstance(result, str) else result


def main():
    try:
        r = load_result(sys.stdin.read())
    except (ValueError, KeyError, AttributeError, TypeError) as error:
        print(f"UNREADABLE: {error}")
        return 2

    problems = []
    identity, history, target = r["identity"], r["history"] or {}, r["target_absent"]
    print(f"database={identity['database']} user={identity['current_user']} superuser={identity['current_user_is_superuser']} "
          f"server={identity['server_version_num']} checked_at_jst={identity['checked_at_jst']}")
    print(f"history rows={history.get('rows')} max={history.get('max_version')} "
          f"ai_ledger_row={history.get('has_20261010050613_ai_ledger')} "
          f"g5_deletion_completion_row={history.get('has_20261009120000_g5_deletion_completion')}")
    print(f"g5 objects: {json.dumps(r['g5_objects'])}")
    print(f"target: schema_absent={target['schema_ai_ledger_absent']} public_ai_ledger_functions={target['public_ai_ledger_functions']}")
    if not target["schema_ai_ledger_absent"] or target["public_ai_ledger_functions"] != 0 or history.get("has_20261010050613_ai_ledger"):
        problems.append("ALREADY_PRESENT: ai_ledger schema, RPCs or history row exists")
    if identity["server_version_num"] < 160000:
        problems.append("SERVER_BELOW_16: SET ROLE paths are checked by plain membership (stricter)")
    if not identity["can_create_schema"] or not identity["can_create_in_public"]:
        problems.append("NO_CREATE_PRIVILEGE for the applying role")

    for name, value in r["predicted_refusals"].items():
        bad = bool(value)
        print(f"predicted_refusal {name}: {'YES ' + json.dumps(value) if bad else 'no'}")
        if bad:
            problems.append(f"WOULD_REFUSE: {name}")
    for reach in r["reachable_roles"]:
        print(f"reachable: {reach['from']} -> {reach['to']} via {reach['path']} super={reach['super']}")

    postgrest = r["postgrest"]
    print(f"postgrest: ddl_watch={postgrest['ddl_watch_trigger']} drop_watch={postgrest['drop_watch_trigger']} "
          f"service_role_public_usage={postgrest['service_role_public_usage']} authenticator_config={json.dumps(postgrest['authenticator_config'])}")
    if not postgrest["service_role_public_usage"]:
        problems.append("SERVICE_ROLE_NO_PUBLIC_USAGE: the RPCs could not be called through PostgREST")
    print("event_triggers: " + ", ".join(f"{e['name']}({e['event']},{e['enabled']})" for e in r["event_triggers"]))
    print(f"extensions: {json.dumps(r['extensions'])}")
    print(f"default_acl entries: {len(r['default_acl'])}")

    if problems:
        print("VERDICT: NOT_READY")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("VERDICT: READY_TO_APPLY (catalog prediction only; G5 window, approval and read-back still required)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
