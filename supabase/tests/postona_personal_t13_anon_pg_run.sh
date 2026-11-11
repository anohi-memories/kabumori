#!/usr/bin/env bash
# G5-24 (S2-1): the T13 anonymous-refusal candidate (supabase/candidates/postona_personal_auth/001_t13_anonymous_refusal.sql) on a THROW-AWAY
# LOCAL PostgreSQL 17 with fake data. Two identical databases are built from main's lifecycle chain (fixtures, onboarding, deletion, Phase 1,
# Phase 2, Phase 3a) plus the REVIEWED T13 migration 20261010051938 and its test fixture, both read with `git show` from the pinned commit
# 76b50e1e (G5 Draft chain; their blobs are checked): "s21" gets the candidate, "rev" keeps the reviewed T13 for the before / after
# comparison and the refused installs. No network, no credential, no managed project; no G3 / G4 / G6 file is read or changed. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_t13_anon_pg_run.sh
# Optional: S21_REPO_ROOT (a tree with supabase/migrations, supabase/tests and supabase/candidates/postona_personal_auth; the mutation script
# points it at a mutant copy) and S21_PINNED_DIR (a directory holding the two pinned files, for a copy without .git).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${S21_REPO_ROOT:-$(cd "$here/../.." && pwd)}"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"; cand="$repo/supabase/candidates/postona_personal_auth"
pin=76b50e1e03f82faaa3460bab1603afa8fef3ce44
t13_path=supabase/migrations/20261010051938_common_account_service_write_guard.sql; t13_blob=da587631cfe8872e3ccf6fd521b919a5439c6574
fx_path=supabase/tests/common_account_write_guard_fixture.sql; fx_blob=32cd803cf27f416029f0eb194456ab935139825c
n="$$"; owner="kb_s21_owner_$n"; other="kb_s21_other_$n"; prefix="kabumori_s21_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g524s21.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $other" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# the reviewed T13 and its fixture, exactly the pinned blobs
if [ -n "${S21_PINNED_DIR:-}" ]; then
  cp "$S21_PINNED_DIR/t13.sql" "$work/t13.sql"; cp "$S21_PINNED_DIR/fixture.sql" "$work/fixture.sql"
else
  git -C "$repo" cat-file -e "$pin^{commit}" || { echo "Pinned commit $pin missing; run git fetch origin." >&2; exit 2; }
  [ "$(git -C "$repo" rev-parse "$pin:$t13_path")" = "$t13_blob" ] && [ "$(git -C "$repo" rev-parse "$pin:$fx_path")" = "$fx_blob" ] \
    || { echo "Pinned blobs differ." >&2; exit 2; }
  git -C "$repo" show "$pin:$t13_path" > "$work/t13.sql"; git -C "$repo" show "$pin:$fx_path" > "$work/fixture.sql"
fi

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb nocreaterole;
create role $other login nosuperuser nocreatedb nocreaterole;
grant anon, authenticated, service_role to $owner;
SQL
for w in s21 rev; do
  "${S[@]}" -d postgres -c "create database ${prefix}_$w owner $owner" >/dev/null
  own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$w" "$@"; }
  own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
  own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
  own -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
  own -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
  own -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
  own -f "$m/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
  own -f "$m/20261006230000_common_account_service_start_intent.sql" >/dev/null
  own -f "$m/20261009120000_common_account_deletion_completion.sql" >/dev/null
  own -f "$work/fixture.sql" >/dev/null
  own -f "$work/t13.sql" >/dev/null
  "${S[@]}" -d "${prefix}_$w" -c "grant usage on schema private to $other" >/dev/null
done
( cd "$repo" && CAL_E2E=1 S21_CANDIDATE="$cand/001_t13_anonymous_refusal.sql" S21_ROLLBACK="$cand/001_t13_anonymous_refusal_rollback.sql" \
    S21_OWNER="$owner" S21_OTHER="$other" S21_DB="${prefix}_s21" S21_REV="${prefix}_rev" PGSUPER="$super" PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/postona_personal_t13_anon_pg_test.ts" )
