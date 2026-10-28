#!/usr/bin/env bash
# G5-46: the PERSONAL MVP auth profile (supabase/candidates/postona_personal_mvp_auth/) on a THROW-AWAY LOCAL PostgreSQL 17 with fake data.
# First `postona_personal_mvp_auth_build.py --check` (both entrypoints re-derive from the reviewed bundle parts + parts/M10). Then two databases on
# the G5 prerequisite world (the G5 Draft chain at 21a5cad4 via `git archive`, as the G5-42 runner):
#   ne  WITHOUT the brand owner epoch (PR #285 / #303 / #457 left out) -- the MVP's target
#   ep  WITH it -- to show the MVP profile and the G5-42 migration candidate exclude each other and can be switched
# G5-47: G6's REAL transport + authority port (PR #500 636c38b9, `git archive`, blob-checked) fed R1-MVP's answers, unchanged; and a TEST-ONLY
# copy with the one-line OWNER_EPOCH pattern the contract asks G6 for (accept g5pv:<n>) -- G6's source is not changed.
# No network, no credential, no managed project, no OAuth / token / Vault / SNS call. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_mvp_auth_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
python3 "$here/postona_personal_mvp_auth_build.py" "$repo" --check >/dev/null || { echo "The MVP profile does not re-derive." >&2; exit 2; }
python3 "$here/postona_personal_auth_migration_build.py" "$repo" --check >/dev/null || { echo "The migration candidate does not re-derive." >&2; exit 2; }
mig="$repo/supabase/candidates/postona_personal_auth_migration"
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
n="$$"; owner="kb_s46_owner_$n"; prefix="kabumori_s46_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g546mvp.XXXXXX")"
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
pinned() {  # commit path blob out
  git -C "$repo" cat-file -e "$1^{commit}" || { echo "Commit $1 missing; run git fetch origin." >&2; exit 2; }
  [ "$(git -C "$repo" rev-parse "$1:$2")" = "$3" ] || { echo "Blob of $2 at $1 differs." >&2; exit 2; }
  git -C "$repo" show "$1:$2" > "$4"
}
git -C "$repo" cat-file -e "$pin^{commit}" || { echo "Pinned commit $pin missing; run git fetch origin." >&2; exit 2; }
tree="$work/pinned"; mkdir -p "$tree"
git -C "$repo" archive "$pin" supabase/migrations supabase/tests supabase/candidates/common_account_brand_owner_epoch | tar -x -C "$tree"
[ "$(git hash-object "$tree/supabase/migrations/20261010051938_common_account_service_write_guard.sql")" = "da587631cfe8872e3ccf6fd521b919a5439c6574" ] \
  || { echo "The world's T13 is not the reviewed blob." >&2; exit 2; }
m="$tree/supabase/migrations"; t="$tree/supabase/tests"
G6=636c38b9824ae14c734f25da40d2fe6ecaaa1f03
git -C "$repo" cat-file -e "$G6^{commit}" || { echo "Commit $G6 missing; run git fetch origin." >&2; exit 2; }
for d in g6 g6p; do mkdir -p "$work/$d"; git -C "$repo" archive "$G6" supabase/ai_gateway supabase/functions/_shared/ai_provider | tar -x -C "$work/$d"; done
[ "$(git hash-object "$work/g6/supabase/ai_gateway/authority_port.ts")" = 0c7ef2b052ba8af08c7d1bb82d510615fbd34e01 ] || { echo "G6 authority_port.ts differs." >&2; exit 2; }
[ "$(git hash-object "$work/g6/supabase/ai_gateway/g5_rpc_transport.ts")" = f1fc0ca2571cb0c13c507b80ca762a0c141feb99 ] || { echo "G6 g5_rpc_transport.ts differs." >&2; exit 2; }
python3 - "$work/g6p/supabase/ai_gateway/authority_port.ts" <<'PY2'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = 'const OWNER_EPOCH = /^g5oe:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$/u;'
assert s.count(old) == 1, 'G6 OWNER_EPOCH line moved'
open(p, 'w', encoding='utf-8').write(s.replace(old, 'const OWNER_EPOCH = /^(?:g5oe:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}|g5pv:[1-9][0-9]{0,18})$/u;'))
PY2
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
for w in ne ep; do
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
  # TEST-WORLD stand-in for G3's L-1 revoke (P3), exactly as the G5 verdict suites do
  own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
  # the owner-epoch candidate of PR #457 (its independent review is still open): ONLY in "ep"; the MVP world "ne" never has it
  if [ "$w" = ep ]; then own -f "$tree/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null; fi
  # TEST-WORLD auth.uid() reading both claim sources (as the G5 verdict suites); managed behaviour NOT_VERIFIED
  own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
done
mkdir -p "$work/tmp"
( cd "$repo" && env CAL_E2E=1 S46_MVP="$repo/supabase/candidates/postona_personal_mvp_auth" S46_MIG="$mig" S46_OWNER="$owner" S46_PREFIX="$prefix" S46_G6="$work/g6" S46_G6P="$work/g6p" \
    PGSUPER="$super" PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/postona_personal_mvp_auth_pg_test.ts" )
