#!/usr/bin/env bash
# F4 / G4 POSTONA X M1: identity attestation + verified predicate + server-only credential handoff
# (supabase/candidates/postona_x_identity_credential/001 + 002, and PR #126's v2 with the attestation record), against
# the REAL G5/F5 lifecycle and F3's real candidates. Disposable and local only: never production, never a managed
# Supabase, never real Vault, OAuth, tokens or X (the X call is a counting fake in the e2e).
#
# 1. A throwaway tree under /private/tmp from this checkout's working tree plus BOUNDED, READ-ONLY copies (nothing is
#    merged, checked out or pushed; an overlay path that already exists stops the run):
#      F5 PR #178 83334a091ded5571cf595fd99d7a035627564735  G5/F5 Phase 3b guard (T13) + fixture, Phase 4, F5 workspace
#                                                           service state, Phase 6
#      G4 PR #124 c30f246409a77080cbc03aef6c4cb72b5481e125  the T9 personal-workspace provisioner + its test fixture
#      F3 PR #257 005d7eccb0d71068abc4c746214a83f1b3f6f847  reservation candidates 001-004, the T13 guard of the live X
#                                                           onboarding, the G4 predicate contract (K1-K6) + helpers +
#                                                           test double, x_publisher.ts / worker.ts / x_credential_contract.ts
# 2. On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner (CREATEROLE for F3's two roles):
#    G5's lifecycle fixtures and REAL migrations, the live X onboarding, account deletion, Phase 2a-2, PR #124, PR #126
#    (this branch: v2 + attestation record) with its fake attestation key, F3's 001-004 and T13 guard, the refresh
#    state aligned to the refresh core's production columns (access_expires_at, last_refreshed_at). Then:
#      a. preconditions of 001 / 002; re-apply refused;
#      b. postona_x_identity_credential_behavior.sql;
#      c. PR #257's own G4 contract (K1-K6) against G4's predicate: with F3's live-v1 onboarding helpers K1 FAILS by
#         design (a client-stated X id is not proof: Issue #131), with the attested onboarding it PASSES;
#      d. fail-before: F3's test double (what F3's chain used for G4) verifies a client-claimed (v1) identity; G4's
#         bound predicate refuses it and hands over no token;
#      e. two-session races: a live (v1) overwrite, and an owner transfer, committing around a handoff -- the handoff
#         never returns a token the decision did not cover;
#      f. supabase/tests/postona_x_identity_credential_e2e_test.ts: F3's C1-C5 checker and F3's real X publisher
#         (counting fake X) over the real database through psql (the owner channel);
#      g. mutations of 001 / 002 must FAIL the proof.
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
PR257=005d7eccb0d71068abc4c746214a83f1b3f6f847
for sha in "$PR124" "$PR178" "$PR257"; do
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
r=supabase/candidates/postona_x_reservations; g=supabase/candidates/postona_x_oauth_t13_guard; f=supabase/functions/_shared/postona_reservations
overlay "$PR257" "$r/001_postona_x_reservations.sql" "$r/002_postona_x_resv_api_role.sql" "$r/003_postona_x_resv_g5_binding.sql" \
  "$r/004_postona_x_resv_dispatch.sql" "$g/001_x_oauth_t13_guard.sql" "$g/g4_predicate_contract.sql" "$g/helpers.sql" \
  "$g/g4_predicate_test_double.sql" "$f/x_publisher.ts" "$f/worker.ts" "$f/x_credential_contract.ts"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
g4="${XG_CANDIDATE_001:-$c/postona_x_identity_credential/001_x_identity_credential_candidate.sql}"
binding="${XG_CANDIDATE_002:-$c/postona_x_identity_credential/002_g3_predicate_binding.sql}"

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
world="${prefix}_world"
create_db "$world"
as_owner "$world" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$world" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$world" -f "$m/$f" > /dev/null
done
as_owner "$world" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
  as_owner "$world" -f "$m/$f" > /dev/null
done
as_owner "$world" -f "$t/common_account_write_guard_fixture.sql" > /dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql 20261012230000_common_account_service_brand_state.sql; do
  [[ "$(apply "$world" "$m/$f")" == applied ]] || fail "G5 $f did not apply"
done
as_owner "$world" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
q "$world" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$world" > /dev/null
q "$world" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
[[ "$(apply "$world" "$m/20261007150000_postona_social_accounts_multi_provider.sql")" == applied ]] || fail "Phase 2a-2 did not apply"
[[ "$(apply "$world" "$m/20261013120000_common_account_service_deletion_ownership.sql")" == applied ]] || fail "G5/F5 Phase 6 did not apply"
"${as_super[@]}" -d "$world" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
as_owner "$world" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
as_owner "$world" -f "$t/postona_x_oauth_hardening_test_fixture.sql" > /dev/null
for f in "$c/postona_threads_oauth_workspace_candidate.sql" "$c/postona_x_oauth_hardening_candidate.sql" \
  "$tree/$r/001_postona_x_reservations.sql" "$tree/$r/002_postona_x_resv_api_role.sql" "$tree/$r/003_postona_x_resv_g5_binding.sql" \
  "$tree/$r/004_postona_x_resv_dispatch.sql" "$tree/$g/001_x_oauth_t13_guard.sql"; do
  [[ "$(apply "$world" "$f")" == applied ]] || fail "$(basename "$f") did not apply on the world: $(apply "$(copy "why_$RANDOM" "$world")" "$f")"
done
# The refresh state as the refresh core (20260925140000) shapes it in production: the two columns the fixture omits.
q "$world" -c "alter table public.x_account_refresh_state_v2 add column access_expires_at timestamptz, add column last_refreshed_at timestamptz" > /dev/null
echo "PASS world: real G5 (T13 + Phase 4 + F5 + Phase 6) + live X onboarding + 2a-2 + #124 + #126 v2 (attestation) + F3 001-004 + F3 T13 guard"

# ---- 2a. Preconditions -------------------------------------------------------------------------------------------
expect() { local label="$1" db="$2" file="$3" code="$4" got; got="$(apply "$db" "$file")"; [[ "$got" == "$code" ]] || fail "$label: $got"; }
db="$(copy p_attest "$world")"; q "$db" -c "drop table public.x_account_identity_attestations" > /dev/null
expect "without the attestation record" "$db" "$g4" X_IDENTITY_CREDENTIAL_PRECONDITION_ATTESTATION
db="$(copy p_f5 "$world")"; "${as_super[@]}" -d "$db" -c "grant execute on function private.account_lifecycle_service_state_readonly(uuid, text) to service_role" > /dev/null
expect "F5's read-only decision reachable by service_role" "$db" "$g4" X_IDENTITY_CREDENTIAL_PRECONDITION_F5
db="$(copy p_shape "$world")"; q "$db" -c "alter table public.x_account_refresh_state_v2 drop column access_expires_at" > /dev/null
expect "refresh state without the expiry" "$db" "$g4" X_IDENTITY_CREDENTIAL_PRECONDITION_SHAPE
db="$(copy p_super "$world")"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$g4" 2>&1 || true)"; got="$(sed -n 's/^.*ERROR: *//p' <<<"$got" | head -1)"
[[ "$got" == X_IDENTITY_CREDENTIAL_PRECONDITION_OWNER ]] || fail "001 applied by a superuser: $got"
db="$(copy p_binding_g4 "$world")"
expect "002 without G4's 001" "$db" "$binding" X_G4_BINDING_PRECONDITION_G4
db="$(copy p_binding_double "$world")"
[[ "$(apply "$db" "$g4")" == applied && "$(apply "$db" "$tree/$g/g4_predicate_test_double.sql")" == applied ]] || fail "p_binding_double setup"
expect "002 over F3's test double (not the shipped DENY)" "$db" "$binding" X_G4_BINDING_PRECONDITION_F3_DENY
echo "PASS preconditions (001: attestation missing, F5 reachable, refresh shape, superuser; 002: G4 missing, not F3's DENY)"

# ---- 2b-2e. The proof --------------------------------------------------------------------------------------------
A=101
race() {  # $1 db, $2 holder SQL (own session, ~1.5 s), $3 tag: the handoff during the hold and after it
  local db="$1" hold="$2" tag="$3" holder during after attested v1
  attested="$(q "$db" -c "select xg.access('RACE')")"; v1="$(q "$db" -c "select xg.access('RACE-V1')")"
  q "$db" -c "$hold" > "$tree/hold_$tag.log" 2>&1 &
  holder=$!; sleep 0.4
  during="$(q "$db" -c "select coalesce(public.x_posting_access_token_for((select v from xg.ids where k = 'race')), 'null')")"
  wait "$holder" || { echo "R_${tag}_HOLDER $(tr '\n' ' ' < "$tree/hold_$tag.log")"; return 0; }
  after="$(q "$db" -c "select coalesce(public.x_posting_access_token_for((select v from xg.ids where k = 'race')), 'null')")"
  [[ "$during" == "$attested" || "$during" == null ]] || { echo "R_${tag}_DURING_LEAKED_UNCOVERED_TOKEN"; return 0; }
  [[ "$after" == null ]] || { echo "R_${tag}_AFTER $after"; return 0; }
  [[ "$during" != "$v1" && "$after" != "$v1" ]] || { echo "R_${tag}_V1_TOKEN"; return 0; }
  echo PASS
}
race_setup() { q "$1" -c "insert into xg.ids values ('race', xg.connect_v2(xg.enroll($A), 'race1', '1201', 'RACE'))" > /dev/null; }
prove() {
  local f001="$1" f002="$2" tag="$3" db out base
  db="$(copy "m_$tag" "$world")"
  [[ "$(apply "$db" "$f001")" == applied ]] || { echo "APPLY001 $(apply "$(copy "a1_$tag" "$world")" "$f001")"; return 0; }
  [[ "$(apply "$db" "$f001")" == X_IDENTITY_CREDENTIAL_PRECONDITION_ALREADY_APPLIED ]] || { echo "REAPPLY001"; return 0; }
  [[ "$(apply "$db" "$f002")" == applied ]] || { echo "APPLY002 $(apply "$(copy "a2_$tag" "$world")" "$f002")"; return 0; }
  [[ "$(apply "$db" "$t/postona_x_identity_credential_fixture.sql")" == applied ]] || { echo FIXTURE; return 0; }
  base="$(copy "b_$tag" "$db")"
  if ! out="$(as_owner "$db" -A -t -f "$t/postona_x_identity_credential_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"; return 0
  fi
  grep -q X_IDENTITY_CREDENTIAL_BEHAVIOR_OK <<<"$out" || { echo BEHAVIOR_INCOMPLETE; return 0; }
  # R1: a live (v1) overwrite of the attested account commits around a handoff.
  db="$(copy "r1_$tag" "$base")"; race_setup "$db"
  out="$(race "$db" "begin; select xg.connect_v1(xg.uid($A), 'race2', '1201', 'RACE-V1'); select pg_sleep(1.5); commit;" "v1$tag")"
  [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  # R2: the workspace is handed to another person around a handoff.
  db="$(copy "r2_$tag" "$base")"; race_setup "$db"
  out="$(race "$db" "begin; select xg.enroll(202); update public.brand_memberships set user_id = xg.uid(202) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid($A)) and user_id = xg.uid($A) and role = 'owner'; select pg_sleep(1.5); commit;" "ow$tag")"
  [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  echo PASS
}
result="$(prove "$g4" "$binding" real)"
[[ "$result" == PASS ]] || fail "G4 candidate: $result"
echo "PASS G4 001 + 002: apply, re-apply refused, behavior (9 sections), races (v1 overwrite, owner transfer around a handoff)"

# c. PR #257's G4 contract against G4's predicate.
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
[[ "$(apply "$kbase" "$g4")" == applied && "$(apply "$kbase" "$binding")" == applied ]] || fail "K setup"
db="$(copy k_live "$kbase")"
if out="$(as_owner "$db" -A -t -f "$k/live/g4_predicate_contract.sql" 2>&1)"; then fail "K with the live v1 onboarding passed: a client-stated X id was accepted as proof"; fi
grep -q "FAIL K1 verified own account" <<<"$out" || fail "K live failed for another reason: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
echo "PASS K with F3's live-v1 onboarding: K1 refused by design (a client-stated X identity is not proof; Issue #131)"
db="$(copy k_attested "$kbase")"
q "$db" -c "grant execute on function public.begin_social_mobile_x_oauth_connection_v2(text,text,timestamptz), public.consume_social_mobile_x_oauth_state_v2(text), public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text) to authenticated" > /dev/null
out="$(as_owner "$db" -A -t -f "$k/attested/g4_predicate_contract.sql" 2>&1)" || fail "K with the attested onboarding: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
grep -q G4_PREDICATE_CONTRACT_PASS <<<"$out" || fail "K attested incomplete"
echo "PASS K1-K6 with the attested onboarding (G4_PREDICATE_CONTRACT_PASS; v2 granted to authenticated TEST-ONLY, as the documented rollout)"

# d. Fail-before: F3's test double (the G4 stand-in F3's chain ran with) verifies a client-claimed identity.
db="$(copy fb "$world")"
[[ "$(apply "$db" "$g4")" == applied && "$(apply "$db" "$t/postona_x_identity_credential_fixture.sql")" == applied ]] || fail "fail-before setup"
[[ "$(apply "$db" "$tree/$g/g4_predicate_test_double.sql")" == applied ]] || fail "test double"
# (Two statements: a stable predicate in the same statement as the connect would read the pre-connect snapshot.)
q "$db" -c "insert into xg.ids values ('fb', xg.connect_v1(xg.enroll(301), 'fb1', '9301', 'FB'))" > /dev/null
before="$(q "$db" -c "select postona_x_resv.g4_x_account_verified(xg.uid(301), (select v from xg.ids where k = 'fb'))::text")"
[[ "$before" == true ]] || fail "fail-before: F3's test double did not accept the v1-claimed identity ($before)"
after="$(q "$db" -c "select (public.x_account_g4_verified(xg.uid(301), (select id from public.social_accounts where platform_user_id = '9301'))::text || ' ' || coalesce(public.x_posting_access_token_for((select id from public.social_accounts where platform_user_id = '9301')), 'null'))")"
[[ "$after" == "false null" ]] || fail "after: G4 accepted the v1-claimed identity ($after)"
echo "PASS fail-before: F3's test double verifies a client-claimed (v1) X identity; G4: not verified, no token"

# f. The e2e: F3's C1-C5 checker and F3's X publisher over the real database (psql as the owner channel).
db="$(copy e2e "$world")"
[[ "$(apply "$db" "$g4")" == applied && "$(apply "$db" "$binding")" == applied && "$(apply "$db" "$t/postona_x_identity_credential_fixture.sql")" == applied ]] || fail "e2e setup"
if ! out="$(cd "$tree" && XG_E2E_HOST="$host" XG_E2E_PORT="$port" XG_E2E_USER="$owner" XG_E2E_DB="$db" XG_E2E_PSQL="$psql_bin" \
    deno test --no-config --no-check --cached-only --allow-read --allow-env=XG_E2E_HOST,XG_E2E_PORT,XG_E2E_USER,XG_E2E_DB,XG_E2E_PSQL --allow-run \
    supabase/tests/postona_x_identity_credential_e2e_test.ts 2>&1)"; then
  echo "$out" | tail -30; fail "e2e"
fi
echo "PASS e2e: $(grep -E '^ok \||passed' <<<"$out" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"

# ---- 2g. Mutations --------------------------------------------------------------------------------------------------
mutate() {
  local name="$1" file="$2" from="$3" to="$4" out="$tree/mut_$1.sql" got count
  count="$(FROM="$from" perl -0ne 'my $n = () = /\Q$ENV{FROM}\E/g; print $n' "$file")"
  [[ "$count" == 1 ]] || fail "mutation $name: pattern occurs $count times"
  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$file" > "$out"
  if [[ "$file" == "$binding" ]]; then got="$(prove "$g4" "$out" "$name")"; else got="$(prove "$out" "$binding" "$name")"; fi
  [[ "$got" != PASS ]] || fail "mutation $name was NOT caught"
  echo "PASS mutation $name caught (${got:0:140})"
}
mutate no_verified_at_binding "$g4" "    and a.verified_at = sa.verified_at
" ""
mutate no_reference_binding "$g4" "    and a.vault_access_token_secret_id = sa.vault_access_token_secret_id
    and a.vault_refresh_token_secret_id = sa.vault_refresh_token_secret_id
" ""
mutate no_owner_rule "$g4" "    and private.account_lifecycle_brand_owner(sa.brand_id) = a.user_id
" ""
mutate no_shared_reference_check "$g4" "    and not exists (select 1 from public.social_accounts o
                    where o.id <> sa.id" "    and not exists (select 1 from public.social_accounts o
                    where false and o.id <> sa.id"
mutate no_dangling_reference_check "$g4" "where d.id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)) = 2" "where d.id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)) >= 1"
mutate no_deletion_tombstone "$g4" "    and not exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id)
" ""
mutate predicate_no_lifecycle "$g4" "                  and public.x_account_attested_owner(p_social_account_id) = p_user_id
                  and private.account_lifecycle_service_state_readonly(p_user_id, 'x_autopost') is null, false)" "                  and public.x_account_attested_owner(p_social_account_id) = p_user_id, false)"
mutate handoff_no_lifecycle "$g4" "    and private.account_lifecycle_service_state_readonly(a.user_id, 'x_autopost') is null
    and coalesce(st.status, 'idle') = 'idle'" "    and coalesce(st.status, 'idle') = 'idle'"
mutate handoff_no_refresh_state "$g4" "    and coalesce(st.status, 'idle') = 'idle'
" ""
mutate handoff_no_expiry "$g4" "             else a.attested_at + interval '2 hours' end > pg_catalog.clock_timestamp() + interval '2 minutes'" "             else a.attested_at + interval '2 hours' end > '-infinity'::timestamptz"
mutate handoff_no_binding "$g4" "    and public.x_account_attested_owner(sa.id) = a.user_id
" ""
mutate generation_ignores_refresh "$g4" "a.vault_refresh_token_secret_id::text, coalesce(st.generation, -1)::text))" "a.vault_refresh_token_secret_id::text))"
mutate handoff_granted "$g4" "-- Postcondition: four definer functions" "grant execute on function public.x_posting_access_token_for(text) to service_role;
-- Postcondition: four definer functions"
mutate binding_allows_all "$binding" "  select public.x_account_g4_verified(p_user_id, p_social_account_id)" "  select true"
cat "$tree/XG_MANIFEST.txt"
echo "ALL PASS (RUN: local disposable PG17, REAL G5/F5 lifecycle, F3's real candidates and publisher with a counting fake X. MOCKED: the Edge code exchange's attestation (fake key), X. NOT_RUN: managed Supabase Auth / PostgREST / Vault, real OAuth / tokens / X, production)"
