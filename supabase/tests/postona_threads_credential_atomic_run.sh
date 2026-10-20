#!/usr/bin/env bash
# G4-11 (Issue #319): the Threads credential atomic read candidate (supabase/candidates/postona_threads_credential_atomic/001)
# on a disposable LOCAL PostgreSQL 17, against the REAL G5/F5 lifecycle and the real candidates it reads. Never production,
# never a managed Supabase, never real Vault, OAuth, tokens or Threads (Vault is the fixtures' table stub; tokens are fake).
#
# 1. A throwaway tree from this checkout plus BOUNDED, READ-ONLY copies (an overlay path that already exists stops the run):
#      F5 PR #178 83334a091ded5571cf595fd99d7a035627564735  G5 Phase 3b guard (T13) + fixture, Phase 4, brand state, Phase 6
#      F5 PR #303 88481aefaf5488adb2735161ec76fa8ea7046260  the brand owner epoch candidate
#      G4 PR #367 fd71450511f4a8d73e150a92bd9fe95677b70edc  the binding generation candidate (H2: CHANGES_REQUIRED, not approved)
#      G5 PR #358 4f4ece89af51a345c0e71cb3876278789a4f3896  R1 / W1 / W2 (candidate; H1 re-review CHANGES_REQUIRED on install checks)
#      G3 PR #374 e3dfbd3cce3fffccdb638159f3aa6c3313d5098c  007: ONLY its threads_credential_generation function, verbatim
# 2. The world (as G4-09) + G4 custody + PR #367 + PR #358 + G3's generation.
# 3. Preconditions of 001 (superuser, an API role able to become the owner, missing dependencies, a VOLATILE dependency),
#    H2's delegation shapes (a default-ACL grant to a delegate role reached by authenticated WITH INHERIT FALSE, SET TRUE),
#    re-apply / rollback / re-apply.
# 4. postona_threads_credential_atomic_behavior.sql.
# 5. A two-session race: a rotation committing while credential_row runs -> always a matching (token, generation) pair.
# 6. Mutations of 001 must FAIL the proof.
# Usage: TC_PGHOST=/private/tmp/<socket-dir> TC_PGPORT=<port> TC_PGSUPER=<superuser> supabase/tests/postona_threads_credential_atomic_run.sh
# A delegate role is created cluster-wide for some cases: run alone on its cluster.
set -euo pipefail
export LC_ALL=C
export PGOPTIONS="-c client_min_messages=warning"

host="${TC_PGHOST:?TC_PGHOST (local socket dir) required}"
port="${TC_PGPORT:?TC_PGPORT required}"
super="${TC_PGSUPER:?TC_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: TC_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
PR178=83334a091ded5571cf595fd99d7a035627564735
PR303=88481aefaf5488adb2735161ec76fa8ea7046260
PR367=fd71450511f4a8d73e150a92bd9fe95677b70edc
PR358=4f4ece89af51a345c0e71cb3876278789a4f3896
PR374=e3dfbd3cce3fffccdb638159f3aa6c3313d5098c
for sha in "$PR178" "$PR303" "$PR367" "$PR358" "$PR374"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-tc.XXXXXX)"
n="$$"
owner="kb_tc_owner_$n"
delegate="kb_tc_delegate_$n"
prefix="kabumori_tc_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $delegate" -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree ----------------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/TC_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/TC_MANIFEST.txt"; done
}
overlay "$PR178" supabase/tests/common_account_write_guard_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql
overlay "$PR303" supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql
overlay "$PR367" supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql
overlay "$PR358" supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql
git -C "$repo" show "$PR374:supabase/candidates/postona_threads_reservations/007_postona_threads_reservations.sql" > "$tree/g3_007.sql"
echo "$PR374 $(shasum -a 256 "$tree/g3_007.sql" | cut -c1-16) supabase/candidates/postona_threads_reservations/007_postona_threads_reservations.sql (generation function only)" >> "$tree/TC_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
cand="${TC_CANDIDATE:-$c/postona_threads_credential_atomic/001_threads_credential_atomic.sql}"
rollback="$c/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql"
behavior="$t/postona_threads_credential_atomic_behavior.sql"
sed 's/^/  /' "$tree/TC_MANIFEST.txt"

# ---- 2. The world ---------------------------------------------------------------------------------------------------
"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin noinherit; end if;
end \$\$;
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
as_owner "$pre" -f "$m/20260918120000_social_mobile_brand_memberships.sql" > /dev/null
# As F5's own runner (PR #303): TEST-WORLD revoke of TRIGGER / TRUNCATE / REFERENCES on brand_memberships (F3 / G3's dependency).
q "$pre" -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" > /dev/null
need "$pre" "$c/common_account_brand_owner_epoch/001_brand_owner_epoch.sql"
need "$pre" "$c/postona_threads_oauth_workspace_candidate.sql"
# G4's custody (this branch), G4's binding (PR #367, read-only, CHANGES_REQUIRED by H2 #329), G5's R1/W1 (PR #358, candidate),
# and G3's credential generation: the ONE function 007 (PR #374) defines for it, extracted verbatim (the rest of 007 needs
# F3's 001-006 and is not installed here; 007 as a whole x this candidate is NOT_VERIFIED).
need "$pre" "$c/postona_threads_publish/threads_credential_custody_candidate.sql"
need "$pre" "$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql"
need "$pre" "$c/common_account_authorization_verdict/001_authorization_verdict.sql"
q "$pre" -c "create schema postona_threads_resv; revoke all on schema postona_threads_resv from public" > /dev/null
awk 'index($0,"create function postona_threads_resv.threads_credential_generation(") == 1 {on=1} on {print} on && $0=="end $$;" {exit}' \
  "$tree/g3_007.sql" > "$tree/g3_generation.sql"
[[ -s "$tree/g3_generation.sql" ]] || fail "G3's generation function not found in 007"
need "$pre" "$tree/g3_generation.sql"
q "$pre" -c "revoke all on function postona_threads_resv.threads_credential_generation(text) from public, anon, authenticated, service_role" > /dev/null
echo "PASS world: real G5 (T13 + Phase 4 + brand state + Phase 6) + F5 PR #303 owner epoch + 2a-2 + PR #124 + G4 custody + G4 PR #367 binding + G5 PR #358 R1/W1 + G3 PR #374 generation (verbatim)"

# ---- 3. Preconditions, H2's delegation shapes, apply / rollback / re-apply --------------------------------------------
expect() { local label="$1" db="$2" file="$3" code="$4" got; got="$(apply "$db" "$file")"; [[ "$got" == "$code"* ]] || fail "$label: $got"; }
db="$(copy p_super "$pre")"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$cand" 2>&1 || true)"; got="$(sed -n 's/^.*ERROR: *//p' <<<"$got" | head -1)"
[[ "$got" == THREADS_CREDENTIAL_PRECONDITION_OWNER ]] || fail "001 applied by a superuser: $got"
i=0
for dep in "private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)" "postona_threads_resv.threads_credential_generation(text)" \
           "public.threads_account_credential_expires_at(text)"; do
  i=$((i + 1)); db="$(copy "p_dep_$i" "$pre")"; q "$db" -c "drop function $dep cascade" > /dev/null
  expect "001 without $dep" "$db" "$cand" "THREADS_CREDENTIAL_PRECONDITION_DEPENDENCY $dep"
done
db="$(copy p_volatile "$pre")"; q "$db" -c "alter function postona_threads_resv.threads_credential_generation(text) volatile" > /dev/null
expect "001 over a VOLATILE generation (no single snapshot)" "$db" "$cand" "THREADS_CREDENTIAL_PRECONDITION_DEPENDENCY postona_threads_resv.threads_credential_generation(text)"
db="$(copy p_binding "$pre")"; q "$db" -c "drop schema postona_threads_binding cascade" > /dev/null
expect "001 without G4's binding table" "$db" "$cand" THREADS_CREDENTIAL_PRECONDITION_TABLES
# (The test owner is itself a member of anon / authenticated / service_role, so only PostgREST's login role can be made a
#  member of it here; the check is the same for every API role.)
db="$(copy p_reach "$pre")"; "${as_super[@]}" -d "$db" -c "grant $owner to authenticator with inherit false, set true" > /dev/null
expect "001 while authenticator can SET ROLE to the owner (NOINHERIT)" "$db" "$cand" "THREADS_CREDENTIAL_PRECONDITION_OWNER_REACHABLE authenticator"
"${as_super[@]}" -d postgres -c "revoke $owner from authenticator" > /dev/null
# H2 #329 (PR #367 P2): a default ACL of the owner grants EXECUTE on new functions to a delegate role that authenticated
# reaches WITH INHERIT FALSE, SET TRUE. The install must refuse (the ACL names a non-owner).
"${as_super[@]}" -d postgres -c "create role $delegate nologin" -c "grant $delegate to authenticated with inherit false, set true" > /dev/null
db="$(copy p_default_acl "$pre")"; q "$db" -c "alter default privileges for role $owner grant execute on functions to $delegate" > /dev/null
expect "001 under a default ACL granting a delegate (H2 shape)" "$db" "$cand" THREADS_CREDENTIAL_POSTCONDITION_FUNCTION_ACL
db="$(copy p_default_schema "$pre")"; q "$db" -c "alter default privileges for role $owner grant usage on schemas to $delegate" > /dev/null
expect "001 under a default schema ACL granting a delegate" "$db" "$cand" THREADS_CREDENTIAL_POSTCONDITION_SCHEMA_ACL
db="$(copy p_again "$pre")"; need "$db" "$cand"
expect "001 re-applied" "$db" "$cand" THREADS_CREDENTIAL_ALREADY_APPLIED
need "$db" "$rollback"
expect "rollback twice" "$db" "$rollback" THREADS_CREDENTIAL_NOT_APPLIED
need "$db" "$cand"
echo "PASS preconditions (superuser, owner reachable via NOINHERIT/SET, W1 / G3 generation / custody missing, VOLATILE dependency, binding missing) + H2 delegation (default ACL on functions / schemas) + re-apply refused + rollback + re-apply"

# ---- 4. Behavior -----------------------------------------------------------------------------------------------------
world="$(copy world "$pre")"
need "$world" "$cand"
main="$(copy main "$world")"
out="$(as_owner "$main" -A -t -v delegate="$delegate" -f "$behavior" 2>&1)" || fail "behavior: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_CREDENTIAL_ATOMIC_BEHAVIOR_PASS <<<"$out" || fail "behavior marker missing"
echo "PASS behavior (postona_threads_credential_atomic_behavior.sql)"

# ---- 5. Race: a rotation commits while credential_row runs --------------------------------------------------------------
race="$(copy race "$world")"
{ sed -n '1,/^-- 0\. No API role/p' "$behavior" | sed '$d'
  printf '%s\n' "select tc.enroll(81) as r \\gset" \
    "select tc.check(tc.connect_all(:'r', 'r1', '17841400000000081') like 'sa_%', 'race connect');"
} > "$tree/race_setup.sql"
as_owner "$race" -A -t -f "$tree/race_setup.sql" > /dev/null
acct="$(q "$race" -c "select id from public.social_accounts where platform_user_id = '17841400000000081'")"
pair() { q "$race" -c "select access_token || '|' || generation from postona_threads_credential.credential_row('$acct', 'x_autopost')"; }
old="$(pair)"
[[ "$old" == *"|"* ]] || fail "race: no row before the rotation"
rot="update vault.secrets set secret = 'fakeTHREADSrotated0123456789ab' where id = (select vault_access_token_secret_id from public.social_accounts where id = '$acct'); update public.threads_account_credential_custody set recorded_at = clock_timestamp() where social_account_id = '$acct'"
( as_owner "$race" -A -t -c "begin" -c "$rot" -c "select pg_sleep(1.5)" -c "commit" > "$tree/race1.out" 2>&1 ) &
holder=$!
sleep 0.4
during="$(pair)"
wait "$holder" || fail "race holder: $(cat "$tree/race1.out")"
after="$(pair)"
[[ "$during" == "$old" ]] || fail "race: during the uncommitted rotation the pair changed: $during"
[[ "$after" == fakeTHREADSrotated0123456789ab"|"* && "${after#*|}" != "${old#*|}" ]] || fail "race: after the rotation: $after"
echo "PASS race (an uncommitted rotation is invisible; after commit the NEW token comes with a NEW generation; never a mixed pair)"

# ---- 6. Mutations -----------------------------------------------------------------------------------------------------
caught=0; total=0
mutate() {
  local name="$1" old="$2" new="$3" file db
  total=$((total + 1))
  file="$tree/mut_$name.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$cand" "$file" "$old" "$new" || fail "mutation $name: pattern not unique"
  db="$(copy "m_$name" "$pre")"
  if [[ "$(apply "$db" "$file")" != applied ]] || ! as_owner "$db" -A -t -v delegate="$delegate" -f "$behavior" > /dev/null 2>&1; then
    caught=$((caught + 1)); echo "  CAUGHT $name"
  else
    echo "  MISSED $name"
  fi
}
mutate any_key "       where p_service_key = 'x_autopost'
         and sa.id" "       where sa.id"
mutate no_w1 "         and private.account_lifecycle_worker_brand_verdict(sa.brand_id, 'x_autopost', b.owner_epoch, b.lifecycle_version) = 'active'
" ""
mutate w1_not_active_ok "b.owner_epoch, b.lifecycle_version) = 'active'" "b.owner_epoch, b.lifecycle_version) is not null"
mutate no_binding_identity "          on b.social_account_id = sa.id and b.brand_id = sa.brand_id and b.threads_user_id = sa.platform_user_id" "          on b.social_account_id = sa.id"
mutate no_bound_owner "         and b.bound_by = private.account_lifecycle_brand_owner(sa.brand_id)
" ""
mutate custody_expiry_ignored "         and public.threads_account_credential_expires_at(sa.id) > pg_catalog.now()
" ""
mutate generation_separate "             postona_threads_resv.threads_credential_generation(sa.id) as generation" "             null::text as generation"
mutate api_grant "revoke all on function postona_threads_credential.credential_row(text, text) from public, anon, authenticated, service_role;" "revoke all on function postona_threads_credential.credential_row(text, text) from public, anon, service_role;
grant execute on function postona_threads_credential.credential_row(text, text) to authenticated;"
# Install-time guards are proven where they matter: the mutated file must still REFUSE in the adverse world.
mutate_install() {  # caught when the mutated file no longer refuses the adverse world with the expected code
  local name="$1" old="$2" new="$3" setup="$4" super_setup="$5" undo="$6" want="$7" file db got
  total=$((total + 1))
  file="$tree/mut_$name.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$cand" "$file" "$old" "$new" || fail "mutation $name: pattern not unique"
  db="$(copy "m_$name" "$pre")"
  [[ -n "$setup" ]] && q "$db" -c "$setup" > /dev/null
  [[ -n "$super_setup" ]] && "${as_super[@]}" -d "$db" -c "$super_setup" > /dev/null
  got="$(apply "$db" "$file")"
  [[ -n "$undo" ]] && "${as_super[@]}" -d postgres -c "$undo" > /dev/null
  if [[ "$got" != "$want"* ]]; then caught=$((caught + 1)); echo "  CAUGHT $name ($got)"; else echo "  MISSED $name"; fi
}
mutate_install acl_postcheck_weak "     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee <> v_me) then" "     or false then" \
  "alter default privileges for role $owner grant execute on functions to $delegate" "" "" THREADS_CREDENTIAL_POSTCONDITION_FUNCTION_ACL
mutate_install schema_postcheck_weak "              where n.nspname = 'postona_threads_credential' and a.grantee <> v_me) then" "              where false) then" \
  "alter default privileges for role $owner grant usage on schemas to $delegate" "" "" THREADS_CREDENTIAL_POSTCONDITION_SCHEMA_ACL
mutate_install owner_reach_unchecked "       and (pg_catalog.pg_has_role(v_api, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_api, v_me, 'SET')
            or pg_catalog.pg_has_role(v_api, v_me, 'USAGE')) then" "       and false then" \
  "" "grant $owner to authenticator with inherit false, set true" "revoke $owner from authenticator" THREADS_CREDENTIAL_PRECONDITION_OWNER_REACHABLE
mutate_install volatile_dependency_ok " and p.proowner = v_me and p.provolatile = 's') then" " and p.proowner = v_me) then" \
  "alter function postona_threads_resv.threads_credential_generation(text) volatile" "" "" THREADS_CREDENTIAL_PRECONDITION_DEPENDENCY
echo "mutations caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a mutation was not caught"
# Known EQUIVALENT mutants (defence in depth; reported, not counted): removing them changes no answer because another
# condition of the same statement already requires the same fact.
equiv() {
  local name="$1" old="$2" new="$3" why="$4" file db
  file="$tree/eq_$name.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$cand" "$file" "$old" "$new" || fail "equivalent $name: pattern not unique"
  db="$(copy "e_$name" "$pre")"
  if [[ "$(apply "$db" "$file")" == applied ]] && as_owner "$db" -A -t -v delegate="$delegate" -f "$behavior" > /dev/null 2>&1; then
    echo "  EQUIVALENT $name ($why)"
  else
    echo "  (caught after all) $name"
  fi
}
equiv not_verified_ok "         and sa.connection_status = 'identity_verified'
" "" "G4 custody's reader also requires identity_verified"
equiv generation_not_required "   where c.generation ~ '^[0-9a-f]{64}\$'" "   where true" "G3's generation is always 64 hex for a Threads account the statement already selected"
echo "POSTONA_THREADS_CREDENTIAL_ATOMIC_RUN_PASS"
