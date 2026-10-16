#!/usr/bin/env bash
# F5 Phase 12: the baseline provenance report (BG1), generated OFFLINE from repository inputs only.
# Builds two throw-away local databases -- the reviewed FIXTURE world the proofs use, and a bare platform stand-in on which
# every repository migration is REPLAYED -- and writes (or checks) supabase/preflight/managed_disposable/baseline_provenance.json.
# No production schema, no managed project, no credential. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> bash supabase/tests/common_account_phase12_baseline_report_run.sh [--write]
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
report="$repo/supabase/preflight/managed_disposable/baseline_provenance.json"
mode="--check"; [[ "${1:-}" == "--write" ]] && mode="--write"
n="$$"; owner="kb_p12_owner_$n"; prefix="kabumori_p12_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
mk() { "${S[@]}" -d postgres -c "create database $1 owner $owner" >/dev/null; }

fixture="${prefix}_fixture"; replay="${prefix}_replay"
mk "$fixture"
own "$fixture" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$fixture" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own "$fixture" -f "$m/$f" >/dev/null; done
own "$fixture" -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
own "$fixture" -f "$t/common_account_write_guard_fixture.sql" >/dev/null
mk "$replay"
own "$replay" -f "$t/common_account_phase12_platform_stubs.sql" >/dev/null 2>&1

( cd "$repo" && PGHOST="$host" PGPORT="$port" PGUSER="$owner" P12_FIXTURE_DB="$fixture" P12_REPLAY_DB="$replay" \
    deno run --no-config --allow-read --allow-write --allow-run=psql --allow-env supabase/preflight/managed_disposable/baseline_report.ts "$mode" "$report" )
