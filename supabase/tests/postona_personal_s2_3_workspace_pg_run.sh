#!/usr/bin/env bash
# G5-33 (S2-3): the personal-workspace eligibility candidate (supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql) on a
# THROW-AWAY LOCAL PostgreSQL 17 with fake data. The world is the D1 suite's (the G5 Draft stack at the pinned commit 21a5cad4 via `git archive`;
# the three verdict files' blobs are checked) plus D1 itself (002_verdicts_anonymous_strict.sql, blob checked: PR #494 head c9f726e9) on BOTH
# databases: "s23" gets the S2-3 candidate, "rev" keeps R0 as D1 leaves it, for the before / after comparison and the refused installs. No network,
# no credential, no managed project; no G3 / G4 / G6 file is read or changed. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_s2_3_workspace_pg_run.sh
# Optional: S33_REPO_ROOT (a tree with supabase/tests and supabase/candidates/postona_personal_auth; the mutation script points it at a mutant copy)
# and S33_PINNED_TREE (an already extracted pinned tree, for a copy without .git).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${S33_REPO_ROOT:-$(cd "$here/../.." && pwd)}"
cand="$repo/supabase/candidates/postona_personal_auth"
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
n="$$"; owner="kb_s33_owner_$n"; prefix="kabumori_s33_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g533s23.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ -n "${S33_PINNED_TREE:-}" ]; then
  tree="$S33_PINNED_TREE"
else
  git -C "$repo" cat-file -e "$pin^{commit}" || { echo "Pinned commit $pin missing; run git fetch origin." >&2; exit 2; }
  tree="$work/pinned"; mkdir -p "$tree"
  git -C "$repo" archive "$pin" supabase/migrations supabase/tests supabase/candidates/common_account_brand_owner_epoch \
    supabase/candidates/common_account_authorization_verdict | tar -x -C "$tree"
fi
v="$tree/supabase/candidates/common_account_authorization_verdict"
for pair in "001_authorization_verdict.sql 6e4ebfc4eb19807b8b0a493c8169313d66c9a1fc" "002_bootstrap_verdict.sql f78d87a9e66d054775076fc0edf1867f077b0e70" \
            "003_session_verdict.sql a0680eb32397b66bb64bdd5e946a02c7ee09eabd"; do
  set -- $pair
  [ "$(git hash-object "$v/$1")" = "$2" ] || { echo "Pinned blob differs: $1" >&2; exit 2; }
done
m="$tree/supabase/migrations"; t="$tree/supabase/tests"
# D1 (PR #494 head c9f726e9) is the base R0 of S2-3: exactly that blob
d1="$cand/002_verdicts_anonymous_strict.sql"
[ "$(git hash-object "$d1")" = "4f58351e98f039c0d71b103be5152854fe4f7a90" ] || { echo "D1 candidate differs from PR #494's blob." >&2; exit 2; }

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role to $owner;
SQL
for w in s23 rev; do
  "${S[@]}" -d postgres -c "create database ${prefix}_$w owner $owner" >/dev/null
  own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$w" "$@"; }
  own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
  own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
  for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own -f "$m/$f" >/dev/null; done
  own -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
  own -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
  own -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null
  own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
  for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
           20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
           20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
           20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
    own -f "$m/$f.sql" >/dev/null
  done
  # TEST-WORLD stand-in for G3's L-1 revoke, exactly as the G5 verdict suites do
  own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
  own -f "$tree/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null
  # TEST-WORLD auth.uid() reading both claim sources (as the G5 verdict suites); managed behaviour NOT_VERIFIED
  own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
  own -f "$v/001_authorization_verdict.sql" >/dev/null
  own -f "$v/002_bootstrap_verdict.sql" >/dev/null
  own -f "$v/003_session_verdict.sql" >/dev/null
  own -f "$d1" >/dev/null
done
( cd "$repo" && CAL_E2E=1 S33_CANDIDATE="$cand/003_s2_3_workspace_eligibility.sql" S33_ROLLBACK="$cand/003_s2_3_workspace_eligibility_rollback.sql" \
    S33_OWNER="$owner" S33_DB="${prefix}_s23" S33_REV="${prefix}_rev" PGSUPER="$super" PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/postona_personal_s2_3_workspace_pg_test.ts" )
