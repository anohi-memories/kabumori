#!/usr/bin/env bash
# G5-44: ONE batch of the CURRENT POSTONA consumers on the G5-42 migration candidate + the G5-43 alignment check, on a THROW-AWAY LOCAL
# PostgreSQL 17 with fake data. The consumers are their owners' REAL source, pinned by commit + blob (read-only, never changed here):
#   G4 PR #533 98e5cf03  postona_g4_x_oauth_personal_epoch/001..004 (+ rollbacks)                 -- X begin / consume / complete
#   G3 PR #541 8d49f94c  postona_x_reservations/001..006, postona_x_oauth_t13_guard/001 (+ rollback) -- reservations, single post, X OAuth T13
#                        postona_x_oauth_t13_guard/g4_predicate_test_double.sql                     -- G3's own TEST DOUBLE of G4's verified-X predicate
#   G6 PR #500 636c38b9  supabase/ai_gateway (transport + authority port), run in Deno with a fake fetch fed real R1 answers
# Worlds (all on the G5-42 prerequisite world, the G5 Draft chain at 21a5cad4 via `git archive`):
#   bt  G5 migration, then G4 X 001-004, then G3's X OAuth T13 guard (wrapping G4's bodies), then G3 001-006 -- all by the lifecycle owner
#   rv  G5 migration + G4 X 001-004 only (today's G4 stack without the T13 wrapper)
#   ro  G5 migration, then G3's T13 guard FIRST, then G4 X 001 (the other order)
# No network, no credential, no managed project; no OAuth exchange, token, Vault, SNS or paid call. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_auth_consumer_batch_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
python3 "$here/postona_personal_auth_migration_build.py" "$repo" --check >/dev/null || { echo "The migration candidate does not re-derive from the bundle." >&2; exit 2; }
mig="$repo/supabase/candidates/postona_personal_auth_migration"
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
n="$$"; owner="kb_s44_owner_$n"; prefix="kabumori_s44_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g544bat.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
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
G4=98e5cf0320000421c301be7602aab3a9d8357548; G3=1dc19904a884b97d4f4d785a7c32058f1d31ef24
c="$work/consumers"; mkdir -p "$c"; g4d=supabase/candidates/postona_g4_x_oauth_personal_epoch
pinned "$G4" "$g4d/001_x_oauth_personal_epoch.sql" 9635d33eed9c88d0b5f0fadc7eae3701985b757f "$c/g4_001.sql"
pinned "$G4" "$g4d/002_x_oauth_product_wiring.sql" fdd231b312f0b4ae00cb576d50c8e0e80baf0413 "$c/g4_002.sql"
pinned "$G4" "$g4d/003_x_disconnect_user_rpc.sql" 2b60e48a906ae6cd1caeb3fc6e4f44bd21f6e4e9 "$c/g4_003.sql"
pinned "$G4" "$g4d/004_x_consume_preexchange_recheck.sql" 41017b789dd248eee2685622773eedef7455176b "$c/g4_004.sql"
pinned "$G4" "$g4d/001_x_oauth_personal_epoch_rollback.sql" 469402f8961a528cb8dcd4cd5bc10c2e69406828 "$c/g4_001_rollback.sql"
pinned "$G4" "$g4d/002_x_oauth_product_wiring_rollback.sql" 0a9b6c5b29254efa19a73fda1f11c2b806e7c930 "$c/g4_002_rollback.sql"
pinned "$G4" "$g4d/003_x_disconnect_user_rpc_rollback.sql" 8dbd90f0a7b43f56fcf740d21ec56e9ec6441110 "$c/g4_003_rollback.sql"
pinned "$G4" "$g4d/004_x_consume_preexchange_recheck_rollback.sql" c0d6c10038c6471072d3e55b16e098b3db78056f "$c/g4_004_rollback.sql"
G3=8d49f94c453539fb67074833d6c3bc64e1c5ac6f; r3=supabase/candidates/postona_x_reservations; t3=supabase/candidates/postona_x_oauth_t13_guard
pinned "$G3" "$r3/001_postona_x_reservations.sql" 83bae8ee99adee3c7036b640c1283581f54b6c26 "$c/g3_001.sql"
pinned "$G3" "$r3/002_postona_x_resv_api_role.sql" 06e70a17eb332845a886998a762691afb93ed7c6 "$c/g3_002.sql"
pinned "$G3" "$r3/003_postona_x_resv_g5_binding.sql" dd848a0747bf8bddef204e141aeb306e2a40c214 "$c/g3_003.sql"
pinned "$G3" "$r3/004_postona_x_resv_dispatch.sql" 385b67d4ec64322edc51d137acd4fc13b840847c "$c/g3_004.sql"
pinned "$G3" "$r3/005_postona_x_single_post.sql" 8eb4293d2e96fd41fe68daa4ba7f3f4ad8ea8141 "$c/g3_005.sql"
pinned "$G3" "$r3/006_postona_x_single_post_live_fence.sql" a08cc0cbcd8a48e989118acdc21e1f693aaae874 "$c/g3_006.sql"
pinned "$G3" "$t3/001_x_oauth_t13_guard.sql" a83d813dcf887ab3ede1ad891484f9c83b68dc69 "$c/g3_t13.sql"
pinned "$G3" "$t3/001_x_oauth_t13_guard_rollback.sql" e96d8c93a0a926cde0b41fd9e29e110007ae0da0 "$c/g3_t13_rollback.sql"
pinned "$G3" "$t3/g4_predicate_test_double.sql" 2a05c7fbcc5ad01aa08467642dc715b67d4bdebb "$c/g3_g4_predicate_test_double.sql"
G6=636c38b9824ae14c734f25da40d2fe6ecaaa1f03
git -C "$repo" cat-file -e "$G6^{commit}" || { echo "Commit $G6 missing; run git fetch origin." >&2; exit 2; }
mkdir -p "$c/g6"; git -C "$repo" archive "$G6" supabase/ai_gateway supabase/functions/_shared/ai_provider | tar -x -C "$c/g6"
[ "$(git hash-object "$c/g6/supabase/ai_gateway/authority_port.ts")" = 0c7ef2b052ba8af08c7d1bb82d510615fbd34e01 ] || { echo "G6 authority_port.ts differs." >&2; exit 2; }
[ "$(git hash-object "$c/g6/supabase/ai_gateway/g5_rpc_transport.ts")" = f1fc0ca2571cb0c13c507b80ca762a0c141feb99 ] || { echo "G6 g5_rpc_transport.ts differs." >&2; exit 2; }
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
for w in bt rv ro; do
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
  # P2, not part of the candidate: the owner-epoch candidate of PR #457 (its independent review is still open)
  own -f "$tree/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null
  # TEST-WORLD auth.uid() reading both claim sources (as the G5 verdict suites); managed behaviour NOT_VERIFIED
  own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
done
mkdir -p "$work/tmp"
( cd "$repo" && env CAL_E2E=1 S44_MIG="$mig" S44_CHECK="$repo/supabase/candidates/postona_personal_auth_consumer_alignment/consumer_owner_alignment_check.sql" \
    S44_CONSUMERS="$c" S44_OWNER="$owner" S44_PREFIX="$prefix" PGSUPER="$super" PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/postona_personal_auth_consumer_batch_pg_test.ts" )
