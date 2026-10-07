#!/usr/bin/env python3
"""Checks the read-only results of ./sql against expected.json (20261006230000 production gate).

    check.py before OUT_DIR                     same-day preflight; writes OUT_DIR/baseline.json
    check.py after OUT_DIR BASELINE [--history] read-back after the apply; --history once the row was added

Every check prints PASS or FAIL; the exit code is 0 only when all pass. Inputs are the JSON files the
Supabase CLI wrote (either the agent shape {"rows": [...]} or a plain list), one row with a `result` column.
The expected owner is postgres (the role production migrations run as); EXPECTED_OWNER overrides it for the
local proof only.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECTED = json.load(open(os.path.join(HERE, "expected.json")))
OWNER = os.environ.get("EXPECTED_OWNER", "postgres")
TARGET = "20261006230000"
failures = []


def check(label, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + label + ("" if ok else "  -> " + detail))
    if not ok:
        failures.append(label)


def result(out_dir, name):
    path = os.path.join(out_dir, name + ".json")
    data = json.load(open(path))
    rows = data["rows"] if isinstance(data, dict) else data
    if len(rows) != 1 or "result" not in rows[0]:
        raise SystemExit(f"FAIL  {name}: unexpected output shape in {path}")
    value = rows[0]["result"]
    return json.loads(value) if isinstance(value, str) else value


def touched_matches(actual, expected, label):
    by_sig = {t["sig"]: t for t in actual}
    check(f"{label}: exactly the eight touched signatures reported", sorted(by_sig) == sorted(expected))
    for sig, want in sorted(expected.items()):
        got = by_sig.get(sig, {})
        if not want["exists"]:
            check(f"{label}: {sig} absent", got.get("exists") is False, json.dumps(got))
            continue
        same = all(got.get(k) == want[k] for k in ("exists", "secdef", "config", "volatility", "acl", "exec", "def_md5"))
        check(f"{label}: {sig} exact (definition, definer, search_path, ACL, effective EXECUTE)", same,
              json.dumps({k: got.get(k) for k in want}))
        check(f"{label}: {sig} owner {OWNER}", got.get("owner") == OWNER, str(got.get("owner")))


def common(out_dir, phase, history_recorded):
    r1 = result(out_dir, "01_identity_history")
    check("01: PostgreSQL 17", str(r1["server_version_num"]).startswith("17"), str(r1["server_version_num"]))
    check("01: Phase 1 history row", r1["rows"].get("20261001150000") == "common_account_lifecycle_foundation", json.dumps(r1["rows"]))
    want_target = "common_account_service_start_intent" if history_recorded else "ABSENT"
    check(f"01: history row {TARGET} {'recorded' if history_recorded else 'absent'}", r1["rows"].get(TARGET) == want_target, json.dumps(r1["rows"]))

    r2 = result(out_dir, "02_dependencies")
    for sig, want in EXPECTED["dependencies"].items():
        got = (r2["dependencies"] or {}).get(sig) or {}
        check(f"02: dependency {sig} unchanged", all(got.get(k) == v for k, v in want.items()), json.dumps(got))
    check("02: callers of the lifecycle start/restart helpers", sorted(r2["callers"]) == sorted(EXPECTED[phase]["callers"]), json.dumps(r2["callers"]))
    check("02: anon/authenticated/service_role are members of no role", r2["api_role_memberships"] == 0, str(r2["api_role_memberships"]))

    r3 = result(out_dir, "03_lifecycle_state")
    settings = r3["settings"] or []
    check("03: guard shadow, integration not_started (one settings row)",
          len(settings) == 1 and settings[0].startswith("shadow/not_started/"), json.dumps(settings))
    check("03: no lifecycle operation in progress", (r3["operations"] or {}).get("in_progress", 0) == 0, json.dumps(r3["operations"]))
    check("03: no transaction open longer than a minute", r3["long_open_transactions"] == 0, str(r3["long_open_transactions"]))

    r4 = result(out_dir, "04_touched_and_fingerprints")
    touched_matches(r4["touched"], EXPECTED[phase]["touched"], "04")
    check("04: no other overload of a touched name", r4["overloads"] == EXPECTED[phase]["overloads"], json.dumps(r4["overloads"]))
    check("04: history row count for the target matches 01", len(r4["history_target"]) == (1 if history_recorded else 0), json.dumps(r4["history_target"]))
    return r3, r4


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("before", "after"):
        raise SystemExit(__doc__)
    phase, out_dir = sys.argv[1], sys.argv[2]
    if phase == "before":
        r3, r4 = common(out_dir, "before", history_recorded=False)
        baseline = {"untouched_functions": r4["untouched_functions"], "relations_fingerprint": r4["relations_fingerprint"],
                    "state": r4["state"], "lifecycle": r3, "history_latest": r4["history_latest"]}
        json.dump(baseline, open(os.path.join(out_dir, "baseline.json"), "w"), indent=1, sort_keys=True)
        print(f"baseline written: {os.path.join(out_dir, 'baseline.json')}")
    else:
        if len(sys.argv) < 4:
            raise SystemExit(__doc__)
        baseline = json.load(open(sys.argv[3]))
        history = "--history" in sys.argv[4:]
        r3, r4 = common(out_dir, "after", history_recorded=history)
        check("04: every other public/private function unchanged (definition + ACL fingerprint)",
              r4["untouched_functions"] == baseline["untouched_functions"],
              json.dumps([r4["untouched_functions"], baseline["untouched_functions"]]))
        check("04: tables, columns, policies, triggers unchanged (fingerprint)",
              r4["relations_fingerprint"] == baseline["relations_fingerprint"])
        check("04: accounts / entitlements / operations / settings / profiles unchanged", r4["state"] == baseline["state"],
              json.dumps([r4["state"], baseline["state"]]))
        smoke = result(out_dir, "05_smoke")
        check("05: smoke answers exact", smoke == EXPECTED["after"]["smoke"], json.dumps(smoke, ensure_ascii=False))
    print()
    print(("ALL PASS" if not failures else f"FAILED: {len(failures)} check(s)") + f" ({phase})")
    sys.exit(0 if not failures else 1)


main()
