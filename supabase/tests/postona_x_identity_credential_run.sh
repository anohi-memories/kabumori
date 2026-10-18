#!/usr/bin/env bash
# F4 / G4 POSTONA X M1: identity attestation + verified predicate + server-only credential handoff
# (supabase/candidates/postona_x_identity_credential/001-003, and PR #126's v2 with the attestation record), against the
# REAL G5/F5 lifecycle and F3's real candidates. Disposable and local only: never production, never a managed Supabase,
# never real Vault, OAuth, tokens or X (the X call is a counting fake in the e2e).
#
# 1. A throwaway tree under /private/tmp from this checkout's working tree plus BOUNDED, READ-ONLY copies (nothing is
#    merged, checked out or pushed; an overlay path that already exists stops the run):
#      F5 PR #178 83334a091ded5571cf595fd99d7a035627564735  G5/F5 Phase 3b guard (T13) + fixture, Phase 4, F5 workspace
#                                                           service state, Phase 6
#      G4 PR #124 c30f246409a77080cbc03aef6c4cb72b5481e125  the T9 personal-workspace provisioner + its test fixture
#      F5 PR #285 3a5eef3d6b981e0646683ce101a22542fd0a4e2f  the shared brand owner epoch candidate (001_brand_owner_epoch.sql)
#      F3 PR #278 bf76a7c7b54ff8aa1155aace2045235e9408c18a  reservation candidates 001-006 (005 single post, 006 live fence
#                                                           with x_credential_generation), the T13 guard of the live X
#                                                           onboarding, the G4 predicate contract (K1-K6) + helpers + test
#                                                           double, x_publisher.ts / worker.ts / x_credential_contract.ts /
#                                                           x_credential_generation.ts (identical to PR #257 where shared)
#    and, for fail-before only, PR #276 39ab57ab3648a4c727be8a31366e4a03b2fad9fc's own copies of the G4 candidates.
# 2. On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner (CREATEROLE for F3's two roles):
#    G5's lifecycle fixtures and REAL migrations, the membership RLS migration (20260918120000) and F5 PR #285's REAL owner
#    epoch candidate (overlaid from 3a5eef3d), the live X onboarding, account deletion, Phase 2a-2, PR #124, PR #126's fake
#    attestation key, F3's 001-006 and T13 guard, the refresh state aligned to the refresh core's production columns.
#    Then, with PR #126 (this branch) on top:
#      a. preconditions of PR #126 (owner epoch), 001, 002, 003; re-apply refused;
#      b. postona_x_identity_credential_behavior.sql (incl. J2 V2 R1 same-transaction v2 -> v1, R2 A -> B -> A);
#      c. PR #278's G4 contract (K1-K6) against G4's predicate: live-v1 onboarding -> K1 refused by design; attested
#         onboarding -> PASS;
#      d. fail-before: PR #276's own candidates show R1 and R2 (verified, a token, a revived generation); F3's test double
#         verifies a client-claimed identity; this branch refuses all three;
#      e. two-session races: a live (v1) overwrite and an owner transfer committing around a handoff;
#      f. supabase/tests/postona_x_identity_credential_e2e_test.ts: F3's C1-C5 and G1-G5 checkers and F3's real X
#         publisher (counting fake X) over the real database through psql (separate sessions = the owner channel);
#      g. mutations of 001 / 002 / 003 must FAIL the proof.
# (2026-10-19, F4 postona-f4-pr282-pr285-owner-epoch-offline-integration-20261019: the TEST-ONLY epoch stand-in is gone; the
# world installs F5 PR #285 3a5eef3d6b981e0646683ce101a22542fd0a4e2f's real candidate, whose getter answers NULL when unknown.)
# Usage: XG_PGHOST=/private/tmp/<socket-dir> XG_PGPORT=<port> XG_PGSUPER=<superuser> supabase/tests/postona_x_identity_credential_run.sh
# Roles postona_resv_api / postona_resv_worker are cluster-wide: run alone on its cluster.
set -euo pipefail
export LC_ALL=C

host="${XG_PGHOST:?XG_PGHOST (local socket dir) required}"
port="${XG_PGPORT:?XG_PGPORT required}"
super="${XG_PGSUPER:?XG_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: XG_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
PR124=c30f246409a77080cbc03aef6c4cb72b5481e125
PR178=83334a091ded5571cf595fd99d7a035627564735
PR278=bf76a7c7b54ff8aa1155aace2045235e9408c18a
PR276=39ab57ab3648a4c727be8a31366e4a03b2fad9fc
PR285=3a5eef3d6b981e0646683ce101a22542fd0a4e2f
for sha in "$PR124" "$PR178" "$PR278" "$PR276" "$PR285"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-x-identity.XXXXXX)"
n="$$"
owner="kb_x_identity_owner_$n"
prefix="kabumori_x_identity_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree --------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/XG_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the F4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/XG_MANIFEST.txt"; done
}
overlay "$PR178" supabase/tests/common_account_write_guard_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql
overlay "$PR124" supabase/candidates/postona_threads_oauth_workspace_candidate.sql supabase/tests/postona_threads_oauth_test_fixture.sql
overlay "$PR285" supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql
r=supabase/candidates/postona_x_reservations; g=supabase/candidates/postona_x_oauth_t13_guard; f=supabase/functions/_shared/postona_reservations
overlay "$PR278" "$r/001_postona_x_reservations.sql" "$r/002_postona_x_resv_api_role.sql" "$r/003_postona_x_resv_g5_binding.sql" \
  "$r/004_postona_x_resv_dispatch.sql" "$r/005_postona_x_single_post.sql" "$r/006_postona_x_single_post_live_fence.sql" \
  "$g/001_x_oauth_t13_guard.sql" "$g/g4_predicate_contract.sql" "$g/helpers.sql" "$g/g4_predicate_test_double.sql" \
  "$f/x_publisher.ts" "$f/worker.ts" "$f/x_credential_contract.ts" "$f/x_credential_generation.ts"
mkdir -p "$tree/pr276"
for path in supabase/candidates/postona_x_oauth_hardening_candidate.sql supabase/candidates/postona_x_identity_credential/001_x_identity_credential_candidate.sql \
            supabase/candidates/postona_x_identity_credential/002_g3_predicate_binding.sql; do
  git -C "$repo" show "$PR276:$path" > "$tree/pr276/$(basename "$path")"
  echo "$PR276 $(shasum -a 256 "$tree/pr276/$(basename "$path")" | cut -c1-16) $path (fail-before copy)" >> "$tree/XG_MANIFEST.txt"
done
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
pr126="$c/postona_x_oauth_hardening_candidate.sql"
g4="${XG_CANDIDATE_001:-$c/postona_x_identity_credential/001_x_identity_credential_candidate.sql}"
binding="${XG_CANDIDATE_002:-$c/postona_x_identity_credential/002_g3_predicate_binding.sql}"
cfor="${XG_CANDIDATE_003:-$c/postona_x_identity_credential/003_x_posting_credential_for.sql}"

# ---- 2. The world ---------------------------------------------------------------------------------------------
"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
drop role if exists postona_resv_api;
drop role if exists postona_resv_worker;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role to $owner;
SQL
as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
create_db() { "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null; }
copy() { local db="${prefix}_$1"; create_db "$db" "$2"; echo "$db"; }
apply() {
  local db="$1" file="$2" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$file" 2>&1)"; then echo applied
  else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}
need() { [[ "$(apply "$1" "$2")" == applied ]] || fail "$(basename "$2") did not apply: $(apply "$(copy "why_$RANDOM" "$1")" "$2")"; }
pre="${prefix}_pre"
create_db "$pre"
as_owner "$pre" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$pre" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$pre" -f "$m/$f" > /dev/null
done
as_owner "$pre" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
  as_owner "$pre" -f "$m/$f" > /dev/null
done
as_owner "$pre" -f "$t/common_account_write_guard_fixture.sql" > /dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql 20261012230000_common_account_service_brand_state.sql; do
  need "$pre" "$m/$f"
done
as_owner "$pre" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
q "$pre" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$pre" > /dev/null
q "$pre" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
need "$pre" "$m/20261007150000_postona_social_accounts_multi_provider.sql"
need "$pre" "$m/20261013120000_common_account_service_deletion_ownership.sql"
"${as_super[@]}" -d "$pre" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
as_owner "$pre" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
as_owner "$pre" -f "$t/postona_x_oauth_hardening_test_fixture.sql" > /dev/null
# F5's owner epoch (PR #285, real candidate) after the membership RLS migration its precondition needs (as F5's runner).
as_owner "$pre" -f "$m/20260918120000_social_mobile_brand_memberships.sql" > /dev/null
need "$pre" "$c/common_account_brand_owner_epoch/001_brand_owner_epoch.sql"
# The refresh state as the refresh core (20260925140000) shapes it in production: the two columns the fixture omits.
q "$pre" -c "alter table public.x_account_refresh_state_v2 add column access_expires_at timestamptz, add column last_refreshed_at timestamptz" > /dev/null
for f in "$c/postona_threads_oauth_workspace_candidate.sql" "$tree/$r/001_postona_x_reservations.sql" "$tree/$r/002_postona_x_resv_api_role.sql" \
  "$tree/$r/003_postona_x_resv_g5_binding.sql" "$tree/$r/004_postona_x_resv_dispatch.sql" "$tree/$g/001_x_oauth_t13_guard.sql" \
  "$tree/$r/005_postona_x_single_post.sql" "$tree/$r/006_postona_x_single_post_live_fence.sql"; do
  need "$pre" "$f"
done
world="$(copy world "$pre")"
need "$world" "$pr126"
echo "PASS world: real G5 (T13 + Phase 4 + F5 + Phase 6) + F5 PR #285 owner epoch + live X onboarding + 2a-2 + #124 + F3 001-006 + F3 T13 guard + #126 v2 (attestation)"

# ---- 2a. Preconditions -------------------------------------------------------------------------------------------
expect() { local label="$1" db="$2" file="$3" code="$4" got; got="$(apply "$db" "$file")"; [[ "$got" == "$code" ]] || fail "$label: $got"; }
db="$(copy p_126epoch "$pre")"; q "$db" -c "drop function private.account_lifecycle_brand_owner_epoch(text)" > /dev/null
expect "PR #126 without F5's owner epoch" "$db" "$pr126" POSTONA_X_OAUTH_PRECONDITION_OWNER_EPOCH
db="$(copy p_126cover "$pre")"; q "$db" -c "drop function private.account_lifecycle_brand_owner_epoch_covered()" > /dev/null
expect "PR #126 with an epoch getter but not F5's real candidate (no coverage check: a stand-in)" "$db" "$pr126" POSTONA_X_OAUTH_PRECONDITION_OWNER_EPOCH
db="$(copy p_attest "$world")"; q "$db" -c "drop table public.x_account_identity_attestations" > /dev/null
expect "001 without the attestation record" "$db" "$g4" X_IDENTITY_CREDENTIAL_PRECONDITION_ATTESTATION
db="$(copy p_f5 "$world")"; "${as_super[@]}" -d "$db" -c "grant execute on function private.account_lifecycle_service_state_readonly(uuid, text) to service_role" > /dev/null
expect "001 with F5's read-only decision reachable by service_role" "$db" "$g4" X_IDENTITY_CREDENTIAL_PRECONDITION_F5
db="$(copy p_epoch "$world")"; q "$db" -c "drop function private.account_lifecycle_brand_owner_epoch(text)" > /dev/null
expect "001 without F5's owner epoch" "$db" "$g4" X_IDENTITY_CREDENTIAL_PRECONDITION_F5
db="$(copy p_shape "$world")"; q "$db" -c "alter table public.x_account_refresh_state_v2 drop column access_expires_at" > /dev/null
expect "001 with a refresh state without the expiry" "$db" "$g4" X_IDENTITY_CREDENTIAL_PRECONDITION_SHAPE
db="$(copy p_super "$world")"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$g4" 2>&1 || true)"; got="$(sed -n 's/^.*ERROR: *//p' <<<"$got" | head -1)"
[[ "$got" == X_IDENTITY_CREDENTIAL_PRECONDITION_OWNER ]] || fail "001 applied by a superuser: $got"
db="$(copy p_binding_g4 "$world")"
expect "002 without G4's 001" "$db" "$binding" X_G4_BINDING_PRECONDITION_G4
db="$(copy p_binding_double "$world")"; need "$db" "$g4"; need "$db" "$tree/$g/g4_predicate_test_double.sql"
expect "002 over F3's test double (not the shipped DENY)" "$db" "$binding" X_G4_BINDING_PRECONDITION_F3_DENY
db="$(copy p_cfor_g4 "$world")"
expect "003 without G4's 001" "$db" "$cfor" X_CREDENTIAL_FOR_PRECONDITION_G4
db="$(copy p_cfor_f3 "$world")"; need "$db" "$g4"; q "$db" -c "drop function postona_x_resv.x_credential_generation(text)" > /dev/null
expect "003 without F3's generation (006)" "$db" "$cfor" X_CREDENTIAL_FOR_PRECONDITION_F3_GENERATION
echo "PASS preconditions (PR126: owner epoch, coverage; 001: attestation, F5 reachable, owner epoch, refresh shape, superuser; 002: G4, not F3's DENY; 003: G4, F3 generation)"

# ---- 2b/2e. The proof ---------------------------------------------------------------------------------------------
A=101
race() {  # $1 db, $2 holder SQL (own session, ~1.5 s), $3 tag: the handoff during the hold and after it
  local db="$1" hold="$2" tag="$3" holder during after attested v1
  attested="$(q "$db" -c "select xg.access('RACE')")"; v1="$(q "$db" -c "select xg.access('RACE-V1')")"
  q "$db" -c "$hold" > "$tree/hold_$tag.log" 2>&1 &
  holder=$!; sleep 0.4
  during="$(q "$db" -c "select coalesce((select c.token from public.x_posting_credential_for((select v from xg.ids where k = 'race')) c), 'null')")"
  wait "$holder" || { echo "R_${tag}_HOLDER $(tr '\n' ' ' < "$tree/hold_$tag.log")"; return 0; }
  after="$(q "$db" -c "select coalesce((select c.token from public.x_posting_credential_for((select v from xg.ids where k = 'race')) c), 'null')")"
  [[ "$during" == "$attested" || "$during" == null ]] || { echo "R_${tag}_DURING_LEAKED_UNCOVERED_TOKEN"; return 0; }
  [[ "$after" == null ]] || { echo "R_${tag}_AFTER $after"; return 0; }
  [[ "$during" != "$v1" && "$after" != "$v1" ]] || { echo "R_${tag}_V1_TOKEN"; return 0; }
  echo PASS
}
race_setup() { q "$1" -c "insert into xg.ids values ('race', xg.connect_v2(xg.enroll($A), 'race1', '1201', 'RACE'))" > /dev/null; }
install() {  # $1 db, $2 001, $3 002, $4 003: "" or the failure
  [[ "$(apply "$1" "$2")" == applied ]] || { echo "APPLY001 $(apply "$(copy "a1_$RANDOM" "$world")" "$2")"; return 0; }
  [[ "$(apply "$1" "$2")" == X_IDENTITY_CREDENTIAL_PRECONDITION_ALREADY_APPLIED ]] || { echo REAPPLY001; return 0; }
  [[ "$(apply "$1" "$3")" == applied ]] || { echo "APPLY002 $(apply "$1" "$3")"; return 0; }
  [[ "$(apply "$1" "$4")" == applied ]] || { echo "APPLY003 $(apply "$1" "$4")"; return 0; }
  [[ "$(apply "$1" "$4")" == X_CREDENTIAL_FOR_PRECONDITION_ALREADY_APPLIED ]] || { echo REAPPLY003; return 0; }
  [[ "$(apply "$1" "$t/postona_x_identity_credential_fixture.sql")" == applied ]] || { echo FIXTURE; return 0; }
}
prove() {
  local f001="$1" f002="$2" f003="$3" tag="$4" db out base
  db="$(copy "m_$tag" "$world")"
  out="$(install "$db" "$f001" "$f002" "$f003")"; [[ -z "$out" ]] || { echo "$out"; return 0; }
  base="$(copy "b_$tag" "$db")"
  if ! out="$(as_owner "$db" -A -t -f "$t/postona_x_identity_credential_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"; return 0
  fi
  grep -q X_IDENTITY_CREDENTIAL_BEHAVIOR_OK <<<"$out" || { echo BEHAVIOR_INCOMPLETE; return 0; }
  db="$(copy "r1_$tag" "$base")"; race_setup "$db"
  out="$(race "$db" "begin; select xg.connect_v1(xg.uid($A), 'race2', '1201', 'RACE-V1'); select pg_sleep(1.5); commit;" "v1$tag")"
  [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  db="$(copy "r2_$tag" "$base")"; race_setup "$db"
  out="$(race "$db" "begin; select xg.enroll(202); update public.brand_memberships set user_id = xg.uid(202) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid($A)) and user_id = xg.uid($A) and role = 'owner'; select pg_sleep(1.5); commit;" "ow$tag")"
  [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  echo PASS
}
result="$(prove "$g4" "$binding" "$cfor" real)"
[[ "$result" == PASS ]] || fail "G4 candidates: $result"
echo "PASS G4 001 + 002 + 003: apply, re-apply refused, behavior (8 sections + R1 + R2), races (v1 overwrite, owner transfer around a handoff)"

# c. PR #278's (= PR #257's) G4 contract against G4's predicate.
k="$tree/kcontract"; mkdir -p "$k/live" "$k/attested"
cp "$tree/$g/g4_predicate_contract.sql" "$tree/$g/helpers.sql" "$k/live/"
cp "$tree/$g/g4_predicate_contract.sql" "$k/attested/"
cat "$tree/$g/helpers.sql" - > "$k/attested/helpers.sql" <<'SQL'
-- F4 (TEST-ONLY override of F3's helpers): the onboarding is G4's attested v2 (begin -> consume -> complete with the
-- Edge's attestation, fake key), as the documented rollout grants it to authenticated.
create or replace function pg_temp.begin_sql(p_label text) returns text language sql as $$
  select format('select social_account_id from public.begin_social_mobile_x_oauth_connection_v2(%L, %L, now() + interval ''5 minutes'')',
                pg_temp.state_hash(p_label), 'kabumori://oauth/x') $$;
create or replace function pg_temp.consume_sql(p_label text) returns text language sql as $$
  select format('select oauth_state_id::text from public.consume_social_mobile_x_oauth_state_v2(%L)', pg_temp.state_hash(p_label)) $$;
create or replace function pg_temp.complete_sql(p_state uuid, p_platform_user_id text) returns text language sql as $$
  select format('select public.complete_social_mobile_x_oauth_connection_v2(%L::uuid, %L, %L, %L, %L, %L)::text',
                p_state, p_platform_user_id, 'h' || p_platform_user_id, 'fake-access-' || p_platform_user_id || '-0123456789',
                'fake-refresh-' || p_platform_user_id || '-0123456789',
                encode(extensions.hmac(convert_to(concat_ws(chr(10), 'postona-x-connect-v1', p_state::text, p_platform_user_id, 'h' || p_platform_user_id,
                  encode(sha256(convert_to('fake-access-' || p_platform_user_id || '-0123456789', 'UTF8')), 'hex'),
                  encode(sha256(convert_to('fake-refresh-' || p_platform_user_id || '-0123456789', 'UTF8')), 'hex')), 'UTF8'),
                  convert_to('fake_x_attestation_key_0123456789abcdef0123456789ab', 'UTF8'), 'sha256'), 'hex')) $$;
SQL
kbase="$(copy kbase "$world")"
out="$(install "$kbase" "$g4" "$binding" "$cfor")"; [[ -z "$out" ]] || fail "K setup: $out"
db="$(copy k_live "$kbase")"
if out="$(as_owner "$db" -A -t -f "$k/live/g4_predicate_contract.sql" 2>&1)"; then fail "K with the live v1 onboarding passed: a client-stated X id was accepted as proof"; fi
grep -q "FAIL K1 verified own account" <<<"$out" || fail "K live failed for another reason: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
echo "PASS K with F3's live-v1 onboarding: K1 refused by design (a client-stated X identity is not proof; Issue #131)"
db="$(copy k_attested "$kbase")"
q "$db" -c "grant execute on function public.begin_social_mobile_x_oauth_connection_v2(text,text,timestamptz), public.consume_social_mobile_x_oauth_state_v2(text), public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text) to authenticated" > /dev/null
out="$(as_owner "$db" -A -t -f "$k/attested/g4_predicate_contract.sql" 2>&1)" || fail "K with the attested onboarding: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
grep -q G4_PREDICATE_CONTRACT_PASS <<<"$out" || fail "K attested incomplete"
echo "PASS K1-K6 with the attested onboarding (G4_PREDICATE_CONTRACT_PASS; v2 granted to authenticated TEST-ONLY, as the documented rollout)"

# d. Fail-before: PR #276's own candidates (R1, R2) and F3's test double; after: this branch.
r1_r2() {  # $1 db: '<R1 verified> <R1 token tag> | <R2 verified> <R2 token> <R2 generation revived>'
  local db="$1" a1 a2
  q "$db" -c "begin; insert into xg.ids values ('fb_r1', xg.connect_v2(xg.enroll(701), 'fbr1v2', '1701', 'FBR1')); select xg.connect_v1(xg.uid(701), 'fbr1v1', '1701', 'FBR1-UNSIGNED'); commit;" > /dev/null
  a1="$(q "$db" -c "select public.x_account_g4_verified(xg.uid(701), (select v from xg.ids where k = 'fb_r1'))::text || ' ' || coalesce(public.x_posting_access_token_for((select v from xg.ids where k = 'fb_r1')), 'null')")"
  q "$db" -c "insert into xg.ids values ('fb_r2', xg.connect_v2(xg.enroll(702), 'fbr2', '1702', 'FBR2')); select xg.enroll(703);" > /dev/null
  q "$db" -c "insert into xg.ids values ('fb_r2_t0', coalesce(public.x_posting_access_token_for((select v from xg.ids where k = 'fb_r2')), 'null'))" > /dev/null
  q "$db" -c "update public.brand_memberships set user_id = xg.uid(703) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid(702)) and user_id = xg.uid(702) and role = 'owner'" > /dev/null
  q "$db" -c "update public.brand_memberships set user_id = xg.uid(702) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid(702)) and user_id = xg.uid(703) and role = 'owner'" > /dev/null
  a2="$(q "$db" -c "select public.x_account_g4_verified(xg.uid(702), (select v from xg.ids where k = 'fb_r2'))::text || ' ' || coalesce(public.x_posting_access_token_for((select v from xg.ids where k = 'fb_r2')), 'null') || ' ' || (coalesce(public.x_posting_access_token_for((select v from xg.ids where k = 'fb_r2')), 'null') = (select v from xg.ids where k = 'fb_r2_t0'))::text")"
  echo "$a1 | $a2"
}
db="$(copy fb276 "$pre")"
for f in "$tree/pr276/postona_x_oauth_hardening_candidate.sql" "$tree/pr276/001_x_identity_credential_candidate.sql" "$tree/pr276/002_g3_predicate_binding.sql" \
         "$t/postona_x_identity_credential_fixture.sql"; do need "$db" "$f"; done
before="$(r1_r2 "$db")"
[[ "$before" == "true fake-x-access-FBR1-UNSIGNED-0123456789 | true fake-x-access-FBR2-0123456789 true" ]] || fail "fail-before: PR #276 did not show R1 / R2 ($before)"
echo "PASS fail-before on PR #276: R1 same-transaction v1 -> verified + the UNSIGNED token; R2 A->B->A -> verified + the old token back ($before)"
db="$(copy fbnew "$world")"; out="$(install "$db" "$g4" "$binding" "$cfor")"; [[ -z "$out" ]] || fail "after setup: $out"
after="$(r1_r2 "$db")"
[[ "$after" == "false null | false null false" ]] || fail "after: this branch still shows R1 / R2 ($after)"
echo "PASS after on this branch: $after"
db="$(copy fbdouble "$world")"; need "$db" "$g4"; need "$db" "$t/postona_x_identity_credential_fixture.sql"; need "$db" "$tree/$g/g4_predicate_test_double.sql"
# (Two statements: a stable predicate in the same statement as the connect would read the pre-connect snapshot.)
q "$db" -c "insert into xg.ids values ('fb', xg.connect_v1(xg.enroll(301), 'fb1', '9301', 'FB'))" > /dev/null
before="$(q "$db" -c "select postona_x_resv.g4_x_account_verified(xg.uid(301), (select v from xg.ids where k = 'fb'))::text")"
[[ "$before" == true ]] || fail "fail-before: F3's test double did not accept the v1-claimed identity ($before)"
after="$(q "$db" -c "select public.x_account_g4_verified(xg.uid(301), (select v from xg.ids where k = 'fb'))::text || ' ' || coalesce(public.x_posting_access_token_for((select v from xg.ids where k = 'fb')), 'null')")"
[[ "$after" == "false null" ]] || fail "after: G4 accepted the v1-claimed identity ($after)"
echo "PASS fail-before: F3's test double verifies a client-claimed (v1) X identity; G4: not verified, no token"

# f. The e2e: F3's C1-C5 / G1-G5 checkers and F3's X publisher over the real database (psql sessions = the owner channel).
db="$(copy e2e "$world")"; out="$(install "$db" "$g4" "$binding" "$cfor")"; [[ -z "$out" ]] || fail "e2e setup: $out"
if ! out="$(cd "$tree" && XG_E2E_HOST="$host" XG_E2E_PORT="$port" XG_E2E_USER="$owner" XG_E2E_DB="$db" XG_E2E_PSQL="$psql_bin" \
    deno test --no-config --no-check --cached-only --allow-read --allow-env=XG_E2E_HOST,XG_E2E_PORT,XG_E2E_USER,XG_E2E_DB,XG_E2E_PSQL --allow-run \
    supabase/tests/postona_x_identity_credential_e2e_test.ts 2>&1)"; then
  echo "$out" | tail -30; fail "e2e"
fi
echo "PASS e2e: $(grep -E '^ok \||passed' <<<"$out" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"

# ---- 2g. Mutations --------------------------------------------------------------------------------------------------
mutate() {
  local name="$1" which="$2" from="$3" to="$4" out="$tree/mut_$1.sql" got count file
  case "$which" in 001) file="$g4" ;; 002) file="$binding" ;; 003) file="$cfor" ;; esac
  count="$(FROM="$from" perl -0ne 'my $n = () = /\Q$ENV{FROM}\E/g; print $n' "$file")"
  [[ "$count" == 1 ]] || fail "mutation $name: pattern occurs $count times"
  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$file" > "$out"
  case "$which" in
    001) got="$(prove "$out" "$binding" "$cfor" "$name")" ;;
    002) got="$(prove "$g4" "$out" "$cfor" "$name")" ;;
    003) got="$(prove "$g4" "$binding" "$out" "$name")" ;;
  esac
  [[ "$got" != PASS ]] || fail "mutation $name was NOT caught"
  echo "PASS mutation $name caught (${got:0:140})"
}
mutate no_access_digest 001 "    and (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.decrypted_secret, 'UTF8')), 'hex')
         from vault.decrypted_secrets d where d.id = sa.vault_access_token_secret_id) = a.access_token_sha256
" ""
mutate no_refresh_digest 001 "    and (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.decrypted_secret, 'UTF8')), 'hex')
         from vault.decrypted_secrets d where d.id = sa.vault_refresh_token_secret_id) = a.refresh_token_sha256
" ""
mutate no_owner_epoch 001 "    and private.account_lifecycle_brand_owner_epoch(sa.brand_id) = a.owner_epoch
" ""
mutate epoch_null_as_match 001 "    and private.account_lifecycle_brand_owner_epoch(sa.brand_id) = a.owner_epoch
" "    and coalesce(private.account_lifecycle_brand_owner_epoch(sa.brand_id), a.owner_epoch) = a.owner_epoch
"
mutate no_verified_at_binding 001 "    and a.verified_at = sa.verified_at
" ""
mutate no_reference_binding 001 "    and a.vault_access_token_secret_id = sa.vault_access_token_secret_id
    and a.vault_refresh_token_secret_id = sa.vault_refresh_token_secret_id
" ""
mutate no_owner_rule 001 "    and private.account_lifecycle_brand_owner(sa.brand_id) = a.user_id
    -- The references" "    -- The references"
mutate no_shared_reference_check 001 "    and not exists (select 1 from public.social_accounts o
                    where o.id <> sa.id" "    and not exists (select 1 from public.social_accounts o
                    where false and o.id <> sa.id"
mutate no_deletion_tombstone 001 "    and not exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id)
" ""
mutate predicate_no_lifecycle 001 "                  and public.x_account_attested_owner(p_social_account_id) = p_user_id
                  and private.account_lifecycle_service_state_readonly(p_user_id, 'x_autopost') is null, false)" "                  and public.x_account_attested_owner(p_social_account_id) = p_user_id, false)"
mutate handoff_no_lifecycle 001 "    and private.account_lifecycle_service_state_readonly(a.user_id, 'x_autopost') is null
    and coalesce(st.status, 'idle') = 'idle'" "    and coalesce(st.status, 'idle') = 'idle'"
mutate handoff_no_refresh_state 001 "    and coalesce(st.status, 'idle') = 'idle'
" ""
mutate handoff_no_expiry 001 "    and a.access_expires_at > pg_catalog.clock_timestamp() + interval '2 minutes'
" ""
mutate handoff_no_binding 001 "    and public.x_account_attested_owner(sa.id) = a.user_id
" ""
mutate handoff_granted 001 "-- Postcondition: five definer functions" "grant execute on function public.x_posting_access_token_for(text) to service_role;
-- Postcondition: five definer functions"
mutate reattest_no_digest_check 001 "     or (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.decrypted_secret, 'UTF8')), 'hex')
         from vault.decrypted_secrets d where d.id = v_sa.vault_access_token_secret_id) is distinct from p_access_token_sha256
" ""
mutate reattest_no_generation_check 001 " or v_generation <= v_a.refresh_generation" ""
mutate reattest_no_epoch_check 001 "     or private.account_lifecycle_brand_owner_epoch(v_sa.brand_id) is distinct from v_a.owner_epoch
" ""
mutate binding_allows_all 002 "  select public.x_account_g4_verified(p_user_id, p_social_account_id)" "  select true"
mutate credential_for_other_generation 003 "postona_x_resv.x_credential_generation(p_social_account_id) as generation" "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_social_account_id, 'UTF8')), 'hex') as generation"
cat "$tree/XG_MANIFEST.txt"
echo "ALL PASS (RUN: local disposable PG17, REAL G5/F5 lifecycle + F5 PR #285 owner epoch, F3's real candidates 001-006 and publisher with a counting fake X. MOCKED: the Edge code exchange's attestation (fake key), X. NOT_RUN: managed Supabase Auth / PostgREST / Vault, real OAuth / tokens / X, production)"
