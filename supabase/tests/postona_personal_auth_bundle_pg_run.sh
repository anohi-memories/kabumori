#!/usr/bin/env bash
# G5-40: the POSTONA personal-auth install bundle (supabase/candidates/postona_personal_auth_bundle/) on a THROW-AWAY LOCAL PostgreSQL 17 with
# fake data. The bundle is checked against its MANIFEST first (postona_personal_auth_bundle_verify.py). Then three databases share one
# PREREQUISITE world -- the G5 Draft chain at 21a5cad4 (`git archive`): fixtures, the lifecycle migrations 20261001..20261015 (the reviewed T13
# among them), the owner-epoch candidate of PR #457 (unreviewed, H3 stopped) and the test-world auth.uid() -- WITHOUT R1 / R0 / SV:
#   bundle  the bundle suite installs steps 10..70 itself, in order and out of order, rolls back in reverse (with the guard), reinstalls;
#   int     steps 10..30 from the bundle, then PR #518's integration suite (fdc281fe, git show, blobs checked) on the bundle's 40..70 files;
#   src     the same, then PR #528's consumer-source suite (5b74d977) with G3 / G4 / G6 code cut from their PR heads (as its own runner does).
# No network, no credential, no managed project; nothing of G3 / G4 / G6 is changed. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_auth_bundle_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bundle="$repo/supabase/candidates/postona_personal_auth_bundle"
python3 "$here/postona_personal_auth_bundle_verify.py" "$repo" >/dev/null || { echo "The bundle does not match its MANIFEST." >&2; exit 2; }
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
n="$$"; owner="kb_s40_owner_$n"; prefix="kabumori_s40_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g540bdl.XXXXXX")"
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
# the suites of PR #518 and PR #528, and the consumer files PR #528's suite reads
mkdir -p "$work/s" "$work/x" "$work/c"
pinned fdc281fe5270d63503e5675b6275f7ffaaee9864 supabase/tests/postona_personal_auth_integration_pg_test.ts 6377969a317abf5538cbf826eda020881558c7d4 "$work/s/int_test.ts"
pinned fdc281fe5270d63503e5675b6275f7ffaaee9864 supabase/tests/postona_personal_auth_integration_fake_consumers.sql c9ea0fc9c6c2da1fb473898726e17e00cbb31f72 "$work/s/fakes.sql"
pinned 5b74d97740425a4a82ca43e173297737034606d8 supabase/tests/postona_personal_consumer_source_gate_pg_test.ts 5d928e30878116cb6db21f5cb9bd3b8b1c5d8256 "$work/s/src_test.ts"
pinned 32f5938762412c38d873a1cc21460c2c39033fb6 supabase/candidates/postona_x_reservations/001_postona_x_reservations.sql 88b5525f6826f02f55dc1c7fd47f7ecf0b37cb56 "$work/x/g3_001.sql"
pinned 32f5938762412c38d873a1cc21460c2c39033fb6 supabase/functions/_shared/postona_reservations/supabase_auth.ts 0b6e636b422cc575404ddabf6bb0ea976e7ac75b "$work/x/g3_supabase_auth.ts"
pinned cbd3922c51f363c72e903cd03ed89c518897e0b3 supabase/candidates/postona_g4_x_oauth_personal_epoch/001_x_oauth_personal_epoch.sql 9635d33eed9c88d0b5f0fadc7eae3701985b757f "$work/x/g4_001.sql"
g6=636c38b9824ae14c734f25da40d2fe6ecaaa1f03
git -C "$repo" cat-file -e "$g6^{commit}" || { echo "Commit $g6 missing." >&2; exit 2; }
mkdir -p "$work/x/g6"; git -C "$repo" archive "$g6" supabase/ai_gateway supabase/functions/_shared/ai_provider | tar -x -C "$work/x/g6"
# the bundle's 40..70 under the names PR #518's / PR #528's suites read
cp "$bundle/40_d1_verdicts_anonymous_strict.sql" "$work/c/d1.sql"; cp "$bundle/R40_d1_verdicts_anonymous_strict_rollback.sql" "$work/c/d1_rb.sql"
cp "$bundle/50_s2_3_workspace_eligibility.sql" "$work/c/s23.sql"; cp "$bundle/R50_s2_3_workspace_eligibility_rollback.sql" "$work/c/s23_rb.sql"
cp "$bundle/60_s2_2_personal_session.sql" "$work/c/s22.sql"; cp "$bundle/R60_s2_2_personal_session_rollback.sql" "$work/c/s22_rb.sql"
cp "$bundle/70_s2_1_t13_anonymous_refusal.sql" "$work/c/s21.sql"; cp "$bundle/R70_s2_1_t13_anonymous_refusal_rollback.sql" "$work/c/s21_rb.sql"

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
for w in bundle probe int src; do
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
  # PREREQUISITE, not part of the bundle: the owner-epoch candidate of PR #457 (its independent review is still open)
  own -f "$tree/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null
  # TEST-WORLD auth.uid() reading both claim sources (as the G5 verdict suites); managed behaviour NOT_VERIFIED
  own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
  if [ "$w" = int ] || [ "$w" = src ]; then
    for f in 10_r1_authorization_verdict 20_r0_bootstrap_verdict 30_sv_session_verdict; do own -f "$bundle/$f.sql" >/dev/null; done
  fi
done
rc=0
d=(deno test --no-config --no-check --allow-read --allow-env --allow-run=psql)
c=(PGSUPER="$super" PGHOST="$host" PGPORT="$port" PGUSER="$owner")
echo "== bundle suite"
( cd "$repo" && env CAL_E2E=1 S40_BUNDLE="$bundle" S40_OWNER="$owner" S40_DB="${prefix}_bundle" S40_PROBE="${prefix}_probe" "${c[@]}" \
    "${d[@]}" "$here/postona_personal_auth_bundle_pg_test.ts" ) || rc=1
echo "== PR #518 integration suite on the bundle's files"
( cd "$repo" && env CAL_E2E=1 S36_C="$work/c" S36_FAKES="$work/s/fakes.sql" S36_OWNER="$owner" S36_DB="${prefix}_int" "${c[@]}" \
    "${d[@]}" "$work/s/int_test.ts" ) || rc=1
echo "== PR #528 consumer-source suite on the bundle's files"
( cd "$repo" && env CAL_E2E=1 S39_X="$work/x" S36_C="$work/c" S36_OWNER="$owner" S36_DB="${prefix}_src" "${c[@]}" \
    "${d[@]}" "$work/s/src_test.ts" ) || rc=1
exit $rc
