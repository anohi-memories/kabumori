#!/usr/bin/env bash
# Offline proof that catalog_fingerprint.sql (Phase 3c) only reads, is deterministic and sees what the proof needs.
# Builds the lifecycle suites' production-shaped baseline (fixtures, onboarding + social-mobile deletion migrations,
# Phase 1, Phase 2, Phase 3a) on a LOCAL Unix-socket PostgreSQL, then runs the fingerprint inside a READ ONLY
# transaction twice. Fake catalog only; never a remote database.
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_disposable_e2e/fingerprint_local_run.sh
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
tests="$here/.."
migrations="$here/../../migrations"
owner="kb_cal_fingerprint_owner"
db="kabumori_cal_fingerprint_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
Q=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
tmp="$(mktemp -d /private/tmp/kabumori-cal-fingerprint.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
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
"${O[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
"${O[@]}" -f "$migrations/20261006230000_common_account_service_start_intent.sql" >/dev/null
"${O[@]}" -f "$migrations/20261009120000_common_account_deletion_completion.sql" >/dev/null

fingerprint() {
  { echo 'begin transaction read only;'; cat "$here/catalog_fingerprint.sql"; echo 'rollback;'; } | "${Q[@]}"
}

# 1. A READ ONLY transaction really stops writes here (so the wrapper is a guard, not decoration).
if "${Q[@]}" -c "begin transaction read only; create table public.fingerprint_probe (id int); rollback;" >/dev/null 2>&1; then
  echo "FAIL a read-only transaction accepted a write" >&2; exit 1
fi

# 2. Deterministic, and the catalog is unchanged by running it.
catalog_md5() { "${Q[@]}" -c "select md5(string_agg(oid::text || relname || relkind::text, ',' order by oid)) from pg_class"; }
before="$(catalog_md5)"
fingerprint > "$tmp/a"
fingerprint > "$tmp/b"
cmp -s "$tmp/a" "$tmp/b" || { echo "FAIL the fingerprint is not deterministic" >&2; diff "$tmp/a" "$tmp/b" >&2 || true; exit 1; }
[[ "$(catalog_md5)" == "$before" ]] || { echo "FAIL the fingerprint changed the catalog" >&2; exit 1; }
# Optional: keep the local fingerprint (an absolute path outside the repository).
if [[ -n "${CAL_FINGERPRINT_OUT:-}" ]]; then cp "$tmp/a" "$CAL_FINGERPRINT_OUT"; fi

# 3. It sees what the proof compares: auth tables and privileges, the cascades from the login, the lifecycle
#    triggers and functions with owners/ACLs, auth.uid(), and the API roles.
for want in '^auth_table\|users\|' '^fk\|auth\.identities\|identities_user_id_fkey\|on_delete=c\|' '^fk\|common_accounts\|' \
            '^trigger\|common_accounts\|account_lifecycle_guard_account_delete\|' '^function\|auth\.uid\(\)\|' '^role\|service_role\|' \
            '^function\|(public\.)?start_kabumori_service\(\)\|' '^function\|(public\.)?begin_common_account_deletion_external_step\('; do
  grep -Eq "$want" "$tmp/a" || { echo "FAIL fingerprint misses: $want" >&2; exit 1; }
done
# No user data: the fixture has no rows yet, but the query must not read any table outside the catalogs either.
if grep -Eiq 'eyJ|@|[0-9a-f]{8}-[0-9a-f]{4}-' "$tmp/a"; then echo "FAIL the fingerprint printed data-like values" >&2; exit 1; fi
echo "COMMON_ACCOUNT_DISPOSABLE_FINGERPRINT_LINES $(wc -l < "$tmp/a" | tr -d ' ')"
echo "COMMON_ACCOUNT_DISPOSABLE_FINGERPRINT_SHA256 $(shasum -a 256 "$tmp/a" | cut -d' ' -f1)"
echo "COMMON_ACCOUNT_DISPOSABLE_FINGERPRINT_LOCAL_PASS"
