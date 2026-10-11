#!/usr/bin/env python3
"""Verdicts for the AI budget ledger production gate (migration 20261010050613). Reads JSON only; prints catalog
facts, counts and policy configuration, never table data or secrets.

  preflight          stdin = output of ai_provider_budget_ledger_preflight.sql
                     exit 0 READY_TO_APPLY, 1 NOT_READY (the migration would refuse, or it is already there)
  readback EXPECT    stdin = output of ai_provider_budget_ledger_readback.sql; EXPECT = none | test | stopped
                     (none: no policy rows yet; test: exactly the Phase 1d test-phase policies, enabled;
                      stopped: the same policies, all disabled by the stop switch)
                     exit 0 READBACK_PASS, 1 READBACK_FAIL
  compare BEFORE AFTER [--expect-rpcs N]
                     two outputs of ai_provider_budget_ledger_existing_fingerprint.sql (files)
                     exit 0 EXISTING_UNCHANGED, 1 EXISTING_CHANGED
  Exit 2 = unreadable input.

Input is the Supabase CLI output: a plain JSON array of rows, or the {"boundary", "rows", "warning"} object the CLI
prints when it detects an agent. Exactly one row with a "result" column is expected.
"""
import json
import sys

TEST_POLICIES = {
    "anthropic.opus.kabumori.market_report.daily": ("day", 2.0, 6, 1.0),
    "anthropic.opus.kabumori.market_report.monthly": ("month", 5.0, 40, 1.0),
}


class Unreadable(Exception):
    pass


def load_result(text):
    try:
        data = json.loads(text)
    except ValueError as error:
        raise Unreadable(f"not JSON: {error}") from None
    rows = data.get("rows") if isinstance(data, dict) else data
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or "result" not in rows[0]:
        raise Unreadable("expected exactly one row with a result column")
    result = rows[0]["result"]
    try:
        result = json.loads(result) if isinstance(result, str) else result
    except ValueError as error:
        raise Unreadable(f"result is not JSON: {error}") from None
    if not isinstance(result, dict):
        raise Unreadable("result is not an object")
    return result


def verdict(ok, good, bad, problems):
    if ok:
        print(f"VERDICT: {good}")
        return 0
    print(f"VERDICT: {bad}")
    for problem in problems:
        print(f"  - {problem}")
    return 1


def preflight(r):
    problems = []
    identity, history, target = r["identity"], r["history"] or {}, r["target_absent"]
    print(f"database={identity['database']} user={identity['current_user']} superuser={identity['current_user_is_superuser']} "
          f"server={identity['server_version_num']} checked_at_jst={identity['checked_at_jst']}")
    print(f"history rows={history.get('rows')} max={history.get('max_version')} "
          f"ai_ledger_row={history.get('has_20261010050613_ai_ledger')} "
          f"g5_deletion_completion_row={history.get('has_20261009120000_g5_deletion_completion')} "
          f"newer_than_ledger={history.get('newer_than_20261010050613')}")
    print(f"target: schema_absent={target['schema_ai_ledger_absent']} public_ai_ledger_functions={target['public_ai_ledger_functions']} "
          f"other_same_named={target.get('other_ai_ledger_named_objects')}")
    print(f"g5: {json.dumps(r['g5_objects'], sort_keys=True)}")
    if not target["schema_ai_ledger_absent"] or target["public_ai_ledger_functions"] != 0 or history.get("has_20261010050613_ai_ledger"):
        problems.append("ALREADY_PRESENT: ai_ledger schema, RPCs or history row exists")
    if identity["server_version_num"] < 160000:
        problems.append("SERVER_BELOW_16: SET ROLE paths are checked by plain membership (stricter)")
    if not identity["can_create_schema"] or not identity["can_create_in_public"]:
        problems.append("NO_CREATE_PRIVILEGE for the applying role")

    for name, value in sorted(r["predicted_refusals"].items()):
        bad = bool(value)
        print(f"predicted_refusal {name}: {'YES ' + json.dumps(value) if bad else 'no'}")
        if bad:
            problems.append(f"WOULD_REFUSE: {name}")
    for reach in r["reachable_roles"]:
        print(f"reachable: {reach['from']} -> {reach['to']} via {reach['path']} super={reach['super']}")

    postgrest = r["postgrest"]
    print(f"postgrest: ddl_watch={postgrest['ddl_watch_trigger']} drop_watch={postgrest['drop_watch_trigger']} "
          f"authenticator_can_set_service_role={postgrest.get('authenticator_can_set_service_role')} "
          f"service_role_public_usage={postgrest['service_role_public_usage']} "
          f"authenticator_config={json.dumps(postgrest['authenticator_config'])}")
    if not postgrest["service_role_public_usage"]:
        problems.append("SERVICE_ROLE_NO_PUBLIC_USAGE: the RPCs could not be called through PostgREST")
    if postgrest.get("authenticator_can_set_service_role") is False:
        problems.append("AUTHENTICATOR_CANNOT_SET_SERVICE_ROLE: a service key could not reach the RPCs")
    if not (postgrest["ddl_watch_trigger"] and postgrest["drop_watch_trigger"]):
        print("note: no PostgREST DDL watch trigger; after the apply run `notify pgrst, 'reload schema'` once if an RPC answers 404")
    print("event_triggers: " + ", ".join(f"{e['name']}({e['event']},{e['enabled']})" for e in r["event_triggers"]))
    print(f"extensions: {json.dumps(r['extensions'], sort_keys=True)}")
    print(f"default_acl entries: {len(r['default_acl'])}")
    return verdict(not problems, "READY_TO_APPLY (catalog prediction only; G5 window, approval and read-back still required)",
                   "NOT_READY", problems)


def readback(r, expect):
    problems = [f"FALSE: {name}" for name, value in sorted(r["must_be_true"].items()) if value is not True]
    rows = r["rows"]
    print(f"checked_at_jst={r['checked_at_jst']} history_row={r['history_row']}")
    print("rows: " + " ".join(f"{k}={rows[k]}" for k in sorted(rows)))
    for name, value in sorted(r["must_be_true"].items()):
        print(f"must_be_true {name}: {value}")
    policies = r["policies"]
    for p in policies:
        print(f"policy {p['policy_key']}: {p['provider']}/{p['model']}/{p['application']}/{p['feature']}/{p['subject_kind']} "
              f"{p['period']} usd={p['max_estimated_usd']} calls={p['max_calls']} per_call={p['max_usd_per_call']} enabled={p['enabled']}")
    if expect == "none":
        if policies:
            problems.append("POLICIES_PRESENT: expected no policy rows yet")
    else:
        keys = sorted(p["policy_key"] for p in policies)
        if keys != sorted(TEST_POLICIES):
            problems.append(f"POLICY_SET: expected exactly {sorted(TEST_POLICIES)}")
        for p in policies:
            want = TEST_POLICIES.get(p["policy_key"])
            if want is None:
                continue
            got = (p["period"], float(p["max_estimated_usd"]), p["max_calls"], float(p["max_usd_per_call"]))
            scoped = (p["provider"], p["model"], p["application"], p["feature"], p["subject_kind"]) == (
                "anthropic", "claude-opus-5-5", "kabumori", "market_report", "system")
            narrow = not (p["logical_role"] or p["brand_scoped"] or p["user_scoped"] or p["per_brand"] or p["per_user"])
            if got != want or not scoped or not narrow or p["enabled"] is not (expect == "test"):
                problems.append(f"POLICY_VALUES: {p['policy_key']}")
    return verdict(not problems, "READBACK_PASS", "READBACK_FAIL", problems)


def compare(before, after, expect_rpcs):
    problems = []
    b, a = before["categories"], after["categories"]
    for name in sorted(set(b) | set(a)):
        same = b.get(name) == a.get(name)
        print(f"{name}: {'same' if same else 'CHANGED'} (count {b.get(name, {}).get('count', 0)} -> {a.get(name, {}).get('count', 0)})")
        if not same:
            problems.append(f"EXISTING_CHANGED: {name}")
    added = after["functions_including_ai_ledger"] - before["functions_including_ai_ledger"]
    print(f"public/private functions incl. ledger RPCs: {before['functions_including_ai_ledger']} -> "
          f"{after['functions_including_ai_ledger']} (+{added}); ai_ledger RPCs {before['ai_ledger_rpcs']} -> {after['ai_ledger_rpcs']}")
    if expect_rpcs is not None and (after["ai_ledger_rpcs"] - before["ai_ledger_rpcs"] != expect_rpcs or added != expect_rpcs):
        problems.append(f"RPC_DELTA: expected exactly +{expect_rpcs} functions, all of them ai_ledger RPCs")
    return verdict(not problems, "EXISTING_UNCHANGED", "EXISTING_CHANGED", problems)


def main(argv):
    try:
        if len(argv) == 1 and argv[0] == "preflight":
            return preflight(load_result(sys.stdin.read()))
        if len(argv) == 2 and argv[0] == "readback" and argv[1] in ("none", "test", "stopped"):
            return readback(load_result(sys.stdin.read()), argv[1])
        if len(argv) in (3, 5) and argv[0] == "compare":
            expect = None
            if len(argv) == 5:
                if argv[3] != "--expect-rpcs" or not argv[4].isdigit():
                    raise Unreadable("usage: compare BEFORE AFTER [--expect-rpcs N]")
                expect = int(argv[4])
            with open(argv[1], encoding="utf-8") as fb, open(argv[2], encoding="utf-8") as fa:
                return compare(load_result(fb.read()), load_result(fa.read()), expect)
        raise Unreadable("usage: preflight | readback none|test|stopped | compare BEFORE AFTER [--expect-rpcs N]")
    except (Unreadable, KeyError, TypeError, OSError) as error:
        print(f"UNREADABLE: {error}")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
