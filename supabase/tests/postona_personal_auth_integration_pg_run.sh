#!/usr/bin/env bash
# G5-36: the G5 personal-auth candidates TOGETHER, on a THROW-AWAY LOCAL PostgreSQL 17 with fake data. Nothing is merged or rebased: every
# candidate is read from its own PR head with `git show` and its blob is checked, then loaded in a fixed order by the suite:
#   world  the G5 Draft stack at 21a5cad4 (`git archive`; R1 / R0 / SV / W1, the owner epoch, the reviewed T13; verdict blobs checked)
#   D1     002_verdicts_anonymous_strict.sql          PR #494 head c9f726e9  (R0 / R1 / SV strict is_anonymous)
#   S2-3   003_s2_3_workspace_eligibility.sql         PR #506 head bbc52a6b  (the personal-workspace predicate, R0 on it)
#   S2-2   004_s2_2_personal_session.sql              PR #510 head 6d59f3b6  (the person-session gate)
#   S2-1   001_t13_anonymous_refusal.sql              PR #489 head 1c3b16a7  (T13 refuses an anonymous / unproven caller)
# and their rollbacks. The FAKE consumers (postona_personal_auth_integration_fake_consumers.sql, this PR) model the call sequences G3 / G4 / G6 are
# asked to use; they are NOT the products' code. No network, no credential, no managed project; no G3 / G4 / G6 file is read or changed. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_auth_integration_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
n="$$"; owner="kb_s36_owner_$n"; prefix="kabumori_s36_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g536int.XXXXXX")"
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

git -C "$repo" cat-file -e "$pin^{commit}" || { echo "Pinned commit $pin missing; run git fetch origin." >&2; exit 2; }
tree="$work/pinned"; mkdir -p "$tree" "$work/c"
git -C "$repo" archive "$pin" supabase/migrations supabase/tests supabase/candidates/common_account_brand_owner_epoch \
  supabase/candidates/common_account_authorization_verdict | tar -x -C "$tree"
v="$tree/supabase/candidates/common_account_authorization_verdict"
for pair in "001_authorization_verdict.sql 6e4ebfc4eb19807b8b0a493c8169313d66c9a1fc" "002_bootstrap_verdict.sql f78d87a9e66d054775076fc0edf1867f077b0e70" \
            "003_session_verdict.sql a0680eb32397b66bb64bdd5e946a02c7ee09eabd"; do
  set -- $pair
  [ "$(git hash-object "$v/$1")" = "$2" ] || { echo "Pinned blob differs: $1" >&2; exit 2; }
done
[ "$(git hash-object "$tree/supabase/migrations/20261010051938_common_account_service_write_guard.sql")" = "da587631cfe8872e3ccf6fd521b919a5439c6574" ] \
  || { echo "The world's T13 is not the reviewed blob." >&2; exit 2; }
# each candidate and rollback from its own PR head, blob checked: name commit path blob
cp_pinned() {
  git -C "$repo" cat-file -e "$2^{commit}" || { echo "Commit $2 missing; run git fetch origin." >&2; exit 2; }
  [ "$(git -C "$repo" rev-parse "$2:$3")" = "$4" ] || { echo "Blob of $3 at $2 differs." >&2; exit 2; }
  git -C "$repo" show "$2:$3" > "$work/c/$1"
}
A=supabase/candidates/postona_personal_auth
cp_pinned d1.sql c9f726e9bea8dece62c12f6cfd7872890ae3b5ad $A/002_verdicts_anonymous_strict.sql 4f58351e98f039c0d71b103be5152854fe4f7a90
cp_pinned d1_rb.sql c9f726e9bea8dece62c12f6cfd7872890ae3b5ad $A/002_verdicts_anonymous_strict_rollback.sql 788f060b662c37ae124bc38b4a0060e061d3b5b5
cp_pinned s23.sql bbc52a6b78efd9eb4b174f7fbb6835162a631659 $A/003_s2_3_workspace_eligibility.sql 84a9ad79484b68b5b05691c6b17ce4b3f32a13a6
cp_pinned s23_rb.sql bbc52a6b78efd9eb4b174f7fbb6835162a631659 $A/003_s2_3_workspace_eligibility_rollback.sql ac50cb29f8cf68e08f293360d615cec7a1296c67
cp_pinned s22.sql 6d59f3b6690e237c203ba4ee8a8afbf42e7a5e11 $A/004_s2_2_personal_session.sql 0790ad69e99f10bc57965aad88831b4baa143895
cp_pinned s22_rb.sql 6d59f3b6690e237c203ba4ee8a8afbf42e7a5e11 $A/004_s2_2_personal_session_rollback.sql f2318751728bff75a6e02a712b923546b35a85ec
cp_pinned s21.sql 1c3b16a75e9fe6230af913eb720376ab34566356 $A/001_t13_anonymous_refusal.sql 8cbba51c631c9b99fd5cee11ef66bd3e46e70086
cp_pinned s21_rb.sql 1c3b16a75e9fe6230af913eb720376ab34566356 $A/001_t13_anonymous_refusal_rollback.sql 9fd0a07b73cc04f2d64101c027decf236e395285
m="$tree/supabase/migrations"; t="$tree/supabase/tests"

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
"${S[@]}" -d postgres -c "create database ${prefix}_int owner $owner" >/dev/null
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_int" "$@"; }
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
( cd "$repo" && CAL_E2E=1 S36_C="$work/c" S36_FAKES="$here/postona_personal_auth_integration_fake_consumers.sql" \
    S36_OWNER="$owner" S36_DB="${prefix}_int" PGSUPER="$super" PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/postona_personal_auth_integration_pg_test.ts" )
