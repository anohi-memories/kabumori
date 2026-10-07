#!/usr/bin/env bash
# Disposable LOCAL proof of this bundle (never production): builds the same baseline as
# ../common_account_service_start_intent_run.sh (fixtures + Phase 1) plus the production history ledger's
# shape, then shows that check.py
#   * passes `before` on the Phase 1 baseline and `after` once the exact migration is applied (with and
#     without the history row), and
#   * fails for: before-mode on the applied state, a missing/extra history row, an extra EXECUTE grant on
#     a new private helper, an extra overload of a new RPC, an ACL change on an unrelated function, and a
#     changed row count.
# --write-expected regenerates expected.json from the local apply (only together with a reviewed migration
# change; production's Phase 1 definitions were checked to hash identically, 2026-10-07).
#
# Usage: PROOF_PGHOST=/private/tmp/<socket-dir> PROOF_PGPORT=<port> PROOF_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_service_start_intent_preflight/proof.sh [--write-expected]
set -euo pipefail
export LC_ALL=C

host="${PROOF_PGHOST:?PROOF_PGHOST (local socket dir) required}"
port="${PROOF_PGPORT:?PROOF_PGPORT required}"
super="${PROOF_PGSUPER:?PROOF_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: PROOF_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
tests="$here/.."
migrations="$here/../../migrations"
owner="kb_cal_intent_owner"
db="kabumori_intent_preflight_$$"
tmp="$(mktemp -d)"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
Q=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
cleanup() { "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
"${O[@]}" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${O[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${O[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${O[@]}" -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20260924100000_ensure_my_profile.sql" >/dev/null
"${O[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
# The production ledger's shape (read 2026-10-07): version text PK, statements text[], name, created_by,
# idempotency_key unique, rollback text[]; Phase 1 was recorded as (version, name) only.
"${O[@]}" >/dev/null <<'SQL'
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text,
  created_by text, idempotency_key text unique, rollback text[]);
insert into supabase_migrations.schema_migrations (version, name) values ('20261001150000', 'common_account_lifecycle_foundation');
SQL

# Runs ./sql like run.sh does, writing the Supabase CLI's JSON shape: {"rows": [{"result": ...}]}.
collect() {  # dir, include-smoke(0/1)
  local dir="$1" f n
  mkdir -p "$dir"
  for f in "$here"/sql/0[1-4]_*.sql; do
    n="$(basename "$f" .sql)"
    printf '{"rows": [{"result": %s}]}\n' "$("${Q[@]}" -f "$f")" >"$dir/$n.json"
  done
  if [[ "$2" == 1 ]]; then
    printf '{"rows": [{"result": %s}]}\n' "$("${Q[@]}" -f "$here/sql/05_smoke.sql")" >"$dir/05_smoke.json"
  fi
}
pass() { EXPECTED_OWNER="$owner" python3 "$here/check.py" "$@" >"$tmp/last.log" 2>&1 || { cat "$tmp/last.log" >&2; echo "FAIL proof: expected PASS for: $*" >&2; exit 1; }; }
fails() { if EXPECTED_OWNER="$owner" python3 "$here/check.py" "$@" >"$tmp/last.log" 2>&1; then echo "FAIL proof: expected a FAIL for: $*" >&2; exit 1; fi; }
must_fail_with() {  # label, check label fragment, check.py args...
  local label="$1" fragment="$2"; shift 2
  fails "$@"
  grep -q "^FAIL  .*$fragment" "$tmp/last.log" || { cat "$tmp/last.log" >&2; echo "FAIL proof: $label did not fail on '$fragment'" >&2; exit 1; }
  echo "PROOF_NEGATIVE_PASS $label"
}

collect "$tmp/before" 0
"${O[@]}" -f "$migrations/20261006230000_common_account_service_start_intent.sql" >/dev/null
collect "$tmp/after" 1

if [[ "${1:-}" == "--write-expected" ]]; then
  python3 - "$tmp" "$here/expected.json" <<'PY'
import json, sys
tmp, target = sys.argv[1], sys.argv[2]
def r(phase, name):
    return json.load(open(f"{tmp}/{phase}/{name}.json"))["rows"][0]["result"]
def touched(phase):
    keys = ("exists", "secdef", "config", "volatility", "acl", "exec", "def_md5")
    return {t["sig"]: ({k: t[k] for k in keys} if t["exists"] else {"exists": False})
            for t in r(phase, "04_touched_and_fingerprints")["touched"]}
deps = r("before", "02_dependencies")["dependencies"]
expected = {
  "migration": {"file": "20261006230000_common_account_service_start_intent.sql",
                "sha256": "2c736e5aa70c61bf5563eee185d226fbde2c7f37f034c262f5e4b31f81888fa4"},
  "dependencies": {sig: {k: v[k] for k in ("secdef", "config", "def_md5", "exec")} for sig, v in deps.items()},
  "before": {"touched": touched("before"), "overloads": r("before", "04_touched_and_fingerprints")["overloads"],
             "callers": r("before", "02_dependencies")["callers"]},
  "after": {"touched": touched("after"), "overloads": r("after", "04_touched_and_fingerprints")["overloads"],
            "callers": r("after", "02_dependencies")["callers"], "smoke": r("after", "05_smoke")},
}
json.dump(expected, open(target, "w"), indent=1, sort_keys=True)
open(target, "a").write("\n")
print("expected.json written")
PY
fi

# Positive paths.
pass before "$tmp/before"
cp "$tmp/before/baseline.json" "$tmp/baseline.json"
pass after "$tmp/after" "$tmp/baseline.json"
echo "PROOF_BEFORE_AND_AFTER_PASS"
"${O[@]}" -c "insert into supabase_migrations.schema_migrations (version, name) values ('20261006230000', 'common_account_service_start_intent')" >/dev/null
collect "$tmp/after_history" 1
pass after "$tmp/after_history" "$tmp/baseline.json" --history
echo "PROOF_AFTER_WITH_HISTORY_PASS"

# Negative paths: each must fail on the intended check, and pass again once undone.
must_fail_with "before-mode on the applied state" "absent" before "$tmp/after_history"
must_fail_with "history row expected but missing" "recorded" after "$tmp/after" "$tmp/baseline.json" --history
must_fail_with "history row present but not expected" "absent" after "$tmp/after_history" "$tmp/baseline.json"

"${O[@]}" -c "grant execute on function private.account_lifecycle_reactivate_service(uuid, text, bigint) to authenticated" >/dev/null
collect "$tmp/neg1" 1
must_fail_with "extra EXECUTE on a new private helper" "account_lifecycle_reactivate_service.*exact" after "$tmp/neg1" "$tmp/baseline.json" --history
"${O[@]}" -c "revoke execute on function private.account_lifecycle_reactivate_service(uuid, text, bigint) from authenticated" >/dev/null

"${O[@]}" -c "create function public.reactivate_kabumori_service(p text) returns jsonb language sql as \$\$ select null::jsonb \$\$" >/dev/null
collect "$tmp/neg2" 1
must_fail_with "extra overload of a new RPC" "overload" after "$tmp/neg2" "$tmp/baseline.json" --history
"${O[@]}" -c "drop function public.reactivate_kabumori_service(text)" >/dev/null

"${O[@]}" -c "grant execute on function private.account_lifecycle_footprint(uuid) to service_role" >/dev/null
collect "$tmp/neg3" 1
must_fail_with "ACL change on an unrelated function" "every other public/private function" after "$tmp/neg3" "$tmp/baseline.json" --history
"${O[@]}" -c "revoke execute on function private.account_lifecycle_footprint(uuid) from service_role" >/dev/null

"${O[@]}" -c "insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000aa'); insert into public.profiles (id) values ('00000000-0000-4000-8000-0000000000aa')" >/dev/null
collect "$tmp/neg4" 1
must_fail_with "changed row count" "unchanged" after "$tmp/neg4" "$tmp/baseline.json" --history
"${O[@]}" -c "delete from public.profiles where id = '00000000-0000-4000-8000-0000000000aa'" >/dev/null

collect "$tmp/restored" 1
pass after "$tmp/restored" "$tmp/baseline.json" --history
echo "PROOF_RESTORED_PASS"
echo "COMMON_ACCOUNT_START_INTENT_PREFLIGHT_PROOF_ALL_PASS"
