#!/usr/bin/env python3
"""Verdicts for the AI budget ledger production gate (migration 20261010050613). Reads JSON only; prints catalog
facts, counts, project refs and policy configuration, never table data or secrets.

  [--require-array] preflight        stdin = ai_provider_budget_ledger_preflight.sql output
                                     exit 0 READY_TO_APPLY, 1 NOT_READY (the migration would refuse, or it is there)
  [--require-array] readback EXPECT  stdin = ai_provider_budget_ledger_readback.sql output; EXPECT = none | test | stopped
                                     (none: no policy rows yet; test: exactly the Phase 1d policies, enabled;
                                      stopped: the same policies, all disabled by the stop switch)
                                     exit 0 READBACK_PASS, 1 READBACK_FAIL
  [--require-array] identity REF     stdin = ai_provider_budget_ledger_target_identity.sql output
                                     exit 0 TARGET_VERIFIED (cron jobs call exactly REF, Kabumori markers present),
                                     1 TARGET_NOT_VERIFIED
  [--require-array] field KIND EXPR  stdin = output of the KIND query; exit 0 when the Python expression EXPR over the
                                     result `r` is true, 1 when false (used by the rollout runner)
  [--require-array] compare BEFORE AFTER [--expect-rpcs N]
                                     two ai_provider_budget_ledger_existing_fingerprint.sql outputs (files)
                                     exit 0 EXISTING_UNCHANGED, 1 EXISTING_CHANGED
  Exit 2 = unreadable or unexpected input: anything but exactly one row whose only column "result" is an object with
  exactly the keys of that query. Nothing unexpected is ever read as a pass.

Input is the Supabase CLI output (`db query --output-format json`): a plain JSON array of rows (`--agent no`), or the
agent envelope {"boundary", "rows", "warning"[, "advisory"]}. --require-array (the rollout runner, which always
passes --agent no) accepts only the plain array.
"""
import json
import re
import sys

TEST_POLICIES = {
    "anthropic.opus.kabumori.market_report.daily": ("day", 2.0, 6, 1.0),
    "anthropic.opus.kabumori.market_report.monthly": ("month", 5.0, 40, 1.0),
}

# The exact shape of every query's result: a missing or renamed key is unreadable input, never a silent pass.
KEYS = {
    "preflight": {"identity", "history", "target_absent", "g5_objects", "app_roles", "reachable_roles",
                  "predicted_refusals", "default_acl", "event_triggers", "postgrest", "extensions"},
    "readback": {"checked_at_jst", "must_be_true", "rows", "policies", "history_row"},
    "fingerprint": {"checked_at_jst", "categories", "functions_including_ai_ledger", "ai_ledger_rpcs"},
    "identity": {"database", "cron_jobs", "cron_project_refs", "product_markers", "history_markers"},
}
PREDICTED_REFUSALS = {"app_role_reaches_owner_or_superuser", "app_role_reaches_service_role_privileges",
                      "app_role_reaches_all_data_role", "default_acl_grantees_not_revoked"}
MUST_BE_TRUE = {"schema_present", "exact_seven_rpcs", "exact_five_tables", "one_owner",
                "rpcs_security_definer_empty_search_path", "helpers_not_security_definer", "rls_on_every_table",
                "no_policies", "no_direct_relation_grants", "service_role_executes_rpcs",
                "anon_authenticated_cannot_execute_rpcs", "no_rpc_grant_option", "app_roles_no_schema_access",
                "app_roles_no_table_access", "app_roles_no_helper_execute", "reject_change_triggers",
                "reservation_transition_trigger"}
ROWS = {"budget_policies", "budget_policies_enabled", "budget_buckets", "reservations", "open_reserved", "open_sent",
        "usage_events", "billing_observations"}
ENVELOPE_KEYS = {"boundary", "rows", "warning"}
REF = re.compile(r"^[a-z]{20}$")


class Unreadable(Exception):
    pass


def rows_of(data, require_array):
    if isinstance(data, list):
        return data
    if require_array:
        raise Unreadable("expected a plain JSON array (the runner passes --agent no)")
    if not isinstance(data, dict) or not ENVELOPE_KEYS <= set(data) or not set(data) <= ENVELOPE_KEYS | {"advisory"}:
        raise Unreadable("neither a JSON array nor the CLI agent envelope")
    if not isinstance(data["boundary"], str) or not re.fullmatch(r"[0-9a-f]{32}", data["boundary"]):
        raise Unreadable("agent envelope without a valid boundary")
    return data["rows"]


def load_result(text, kind=None, require_array=False):
    if not text.strip():
        raise Unreadable("empty output")
    try:
        data = json.loads(text)
    except ValueError as error:
        raise Unreadable(f"not JSON: {error}") from None
    rows = rows_of(data, require_array)
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) or set(rows[0]) != {"result"}:
        raise Unreadable("expected exactly one row whose only column is result")
    result = rows[0]["result"]
    try:
        result = json.loads(result) if isinstance(result, str) else result
    except ValueError as error:
        raise Unreadable(f"result is not JSON: {error}") from None
    if not isinstance(result, dict):
        raise Unreadable("result is not an object")
    if kind is not None:
        validate(result, kind)
    return result


def validate(r, kind):
    if set(r) != KEYS[kind]:
        raise Unreadable(f"{kind}: unexpected keys (missing {sorted(KEYS[kind] - set(r))}, extra {sorted(set(r) - KEYS[kind])})")
    if kind == "preflight":
        if set(r["predicted_refusals"]) != PREDICTED_REFUSALS:
            raise Unreadable("preflight: unexpected predicted_refusals keys")
        if not isinstance(r["history"], dict) or not isinstance(r["target_absent"], dict):
            raise Unreadable("preflight: history / target_absent missing")
    elif kind == "readback":
        if set(r["must_be_true"]) != MUST_BE_TRUE or set(r["rows"]) != ROWS:
            raise Unreadable("readback: unexpected must_be_true / rows keys")
        if not all(isinstance(v, bool) for v in r["must_be_true"].values()) or not isinstance(r["policies"], list):
            raise Unreadable("readback: must_be_true values must be booleans and policies a list")
    elif kind == "fingerprint":
        if not isinstance(r["categories"], dict) or not r["categories"]:
            raise Unreadable("fingerprint: no categories")
    elif kind == "identity":
        refs = r["cron_project_refs"]
        if not isinstance(refs, list) or not all(isinstance(x, str) and REF.match(x) for x in refs):
            raise Unreadable("identity: cron_project_refs must be a list of project refs")
        if not isinstance(r["product_markers"], dict) or not isinstance(r["history_markers"], dict):
            raise Unreadable("identity: markers missing")


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


def identity(r, ref):
    problems = []
    refs = r["cron_project_refs"]
    print(f"database={r['database']} cron_jobs={r['cron_jobs']} cron_project_refs={','.join(refs) or '(none)'} expected_ref={ref}")
    print(f"product_markers: {json.dumps(r['product_markers'], sort_keys=True)}")
    print(f"history_markers: {json.dumps(r['history_markers'], sort_keys=True)}")
    if refs != [ref]:
        problems.append(f"PROJECT_REF_MISMATCH: the database's cron jobs call {refs or 'no project'}, not exactly [{ref}]")
    missing = sorted(name for name, present in r["product_markers"].items() if present is not True)
    if missing:
        problems.append(f"NOT_THIS_PRODUCT: missing {missing}")
    history = sorted(name for name, present in r["history_markers"].items() if present is not True)
    if history:
        problems.append(f"HISTORY_MARKERS_MISSING: {history}")
    return verdict(not problems, "TARGET_VERIFIED", "TARGET_NOT_VERIFIED", problems)


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
    require_array = False
    if argv[:1] == ["--require-array"]:
        require_array, argv = True, argv[1:]
    try:
        if argv == ["preflight"]:
            return preflight(load_result(sys.stdin.read(), "preflight", require_array))
        if len(argv) == 2 and argv[0] == "readback" and argv[1] in ("none", "test", "stopped"):
            return readback(load_result(sys.stdin.read(), "readback", require_array), argv[1])
        if len(argv) == 2 and argv[0] == "identity":
            if not REF.match(argv[1]):
                raise Unreadable("identity needs a 20-letter project ref")
            return identity(load_result(sys.stdin.read(), "identity", require_array), argv[1])
        if len(argv) == 3 and argv[0] == "field" and argv[1] in KEYS:
            r = load_result(sys.stdin.read(), argv[1], require_array)
            return 0 if eval(argv[2], {"__builtins__": {}}, {"r": r}) else 1  # expressions are constants in the runner
        if len(argv) in (3, 5) and argv[0] == "compare":
            expect = None
            if len(argv) == 5:
                if argv[3] != "--expect-rpcs" or not argv[4].isdigit():
                    raise Unreadable("usage: compare BEFORE AFTER [--expect-rpcs N]")
                expect = int(argv[4])
            with open(argv[1], encoding="utf-8") as fb, open(argv[2], encoding="utf-8") as fa:
                return compare(load_result(fb.read(), "fingerprint", require_array), load_result(fa.read(), "fingerprint", require_array), expect)
        raise Unreadable("usage: [--require-array] preflight | readback none|test|stopped | identity REF | field KIND EXPR"
                         " | compare BEFORE AFTER [--expect-rpcs N]")
    except (Unreadable, KeyError, TypeError, OSError) as error:
        print(f"UNREADABLE: {error}")
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
