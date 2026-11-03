#!/usr/bin/env bash
# G4-09 (Issue #319): the Threads binding generation candidate (supabase/candidates/postona_threads_binding_epoch/001) on a
# disposable LOCAL PostgreSQL 17, against the REAL G5/F5 lifecycle. Never production, never a managed Supabase, never real
# Vault, OAuth, tokens or Threads.
#
# 1. A throwaway tree under /private/tmp from this checkout's working tree plus BOUNDED, READ-ONLY copies (nothing merged,
#    checked out or pushed; an overlay path that already exists stops the run):
#      F5 PR #178 83334a091ded5571cf595fd99d7a035627564735  G5 Phase 3b guard (T13) + fixture, Phase 4, brand state, Phase 6
#      F5 PR #303 88481aefaf5488adb2735161ec76fa8ea7046260  the shared brand owner epoch candidate (R1-R3 fix of PR #285)
# 2. The world: G5's lifecycle fixtures and REAL migrations, the live X onboarding (its tables), account deletion, Phase
#    2a-2, the membership RLS migration, F5's owner epoch candidate, PR #124's Threads OAuth candidate with its fake
#    attestation key fixture.
# 3. Preconditions of 001 (superuser, F5 getter / coverage, PR #124 missing; re-apply), apply / rollback / re-apply.
# 4. postona_threads_binding_epoch_behavior.sql.
# 5. A two-session race: two attests of one state; exactly one binding.
# 6. Mutations of 001 must FAIL the proof.
# G4-13 (H2 #329 on PR #367): 3 also shows the ORIGINAL PR #367 001 (fd714505) installing under H2's delegation shape and
# leaving the delegate EXECUTE / USAGE (fail-before), and this version refusing it (owner reachable via NOINHERIT / SET;
# default ACLs on functions / schemas / tables naming a delegate); 4 adds S1 -> S2 -> S1 and later-transaction attests;
# 5 races two complete + attest transactions on one state. A delegate role and authenticator are cluster-wide: run alone.
# G4-14 (H2 #329 C2 on PR #388): 3 refuses an exposed or changed PR #124 complete; 4 has no attest entry any more (one
# complete_and_attest_binding call), and adds rollback / savepoint / same-transaction cases; 5b opens many sessions until two
# DIFFERENT transactions share now() and shows PR #388's 001 (5bf6f915) accepting an attest there and leaving a rolled-back
# attest's completion committed (fail-before), then this 001 refusing it and undoing both together. 5b needs node.
# G4-16: the world also holds G4's custody candidate. 4c applies 002 (the custody writer requires 001's connect proof
# instead of verified_at = now()): preconditions, rollback (restores the original writer), postona_threads_binding_custody_
# behavior.sql; 5c shows the ORIGINAL writer accepting an expiry from another transaction with the same now() (fail-before)
# and 002 refusing it; 6 mutates 001's proof and 002.
# Usage: TB_PGHOST=/private/tmp/<socket-dir> TB_PGPORT=<port> TB_PGSUPER=<superuser> supabase/tests/postona_threads_binding_epoch_run.sh
set -euo pipefail
export LC_ALL=C
export PGOPTIONS="-c client_min_messages=warning"

host="${TB_PGHOST:?TB_PGHOST (local socket dir) required}"
port="${TB_PGPORT:?TB_PGPORT required}"
super="${TB_PGSUPER:?TB_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: TB_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
PR178=83334a091ded5571cf595fd99d7a035627564735
PR303=88481aefaf5488adb2735161ec76fa8ea7046260
for sha in "$PR178" "$PR303"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-tb.XXXXXX)"
n="$$"
owner="kb_tb_owner_$n"
delegate="kb_tb_delegate_$n"
hop1="kb_tb_hop1_$n"; hop2="kb_tb_hop2_$n"; leaf="kb_tb_leaf_$n"
prefix="kabumori_tb_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $leaf" -c "drop role if exists $hop2" -c "drop role if exists $hop1" > /dev/null 2>&1 || true
  "${as_super[@]}" -d postgres -c "drop role if exists $delegate" -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree ----------------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/TB_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/TB_MANIFEST.txt"; done
}
overlay "$PR178" supabase/tests/common_account_write_guard_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql
overlay "$PR303" supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
cand="${TB_CANDIDATE:-$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql}"
rollback="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
cand2="${TB_CANDIDATE2:-$c/postona_threads_binding_epoch/002_custody_connect_proof.sql}"
rollback2="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
custody_behavior="$t/postona_threads_binding_custody_behavior.sql"
behavior="$t/postona_threads_binding_epoch_behavior.sql"
git -C "$repo" show "fd71450511f4a8d73e150a92bd9fe95677b70edc:supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql" > "$tree/pr367_original_001.sql"
echo "fd71450511f4a8d73e150a92bd9fe95677b70edc $(shasum -a 256 "$tree/pr367_original_001.sql" | cut -c1-16) PR #367's original 001 (fail-before copy)" >> "$tree/TB_MANIFEST.txt"
git -C "$repo" show "5bf6f915353eadb4e1425ae6aec3d281ac36c8a8:supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql" > "$tree/pr388_001.sql"
echo "5bf6f915353eadb4e1425ae6aec3d281ac36c8a8 $(shasum -a 256 "$tree/pr388_001.sql" | cut -c1-16) PR #388's 001 (fail-before copy)" >> "$tree/TB_MANIFEST.txt"
git -C "$repo" show "80667ffb788836722eb8d98190eaa874e6d5acc4:supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql" > "$tree/pr405_001.sql"
echo "80667ffb788836722eb8d98190eaa874e6d5acc4 $(shasum -a 256 "$tree/pr405_001.sql" | cut -c1-16) PR #405's 001 (no connect proof)" >> "$tree/TB_MANIFEST.txt"
sed 's/^/  /' "$tree/TB_MANIFEST.txt"

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
# As F5's own runner (PR #303 common_account_owner_epoch_run.sh): the model world's default grants leave TRIGGER / TRUNCATE /
# REFERENCES on public.brand_memberships to API roles, which PR #303 refuses; the real revoke is F3 / G3's dependency. This
# TEST-WORLD revoke stands in for it.
q "$pre" -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" > /dev/null
need "$pre" "$c/common_account_brand_owner_epoch/001_brand_owner_epoch.sql"
need "$pre" "$c/postona_threads_oauth_workspace_candidate.sql"
need "$pre" "$c/postona_threads_publish/threads_credential_custody_candidate.sql"
echo "PASS world: real G5 (T13 + Phase 4 + brand state + Phase 6) + F5 PR #303 owner epoch + live X onboarding tables + 2a-2 + PR #124"

# ---- 3. Preconditions, apply / rollback / re-apply ------------------------------------------------------------------
expect() { local label="$1" db="$2" file="$3" code="$4" got; got="$(apply "$db" "$file")"; [[ "$got" == "$code"* ]] || fail "$label: $got"; }
db="$(copy p_super "$pre")"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$cand" 2>&1 || true)"; got="$(sed -n 's/^.*ERROR: *//p' <<<"$got" | head -1)"
[[ "$got" == THREADS_BINDING_PRECONDITION_OWNER ]] || fail "001 applied by a superuser: $got"
db="$(copy p_epoch "$pre")"; q "$db" -c "drop function private.account_lifecycle_brand_owner_epoch(text)" > /dev/null
expect "001 without F5's owner epoch getter" "$db" "$cand" "THREADS_BINDING_PRECONDITION_DEPENDENCY private.account_lifecycle_brand_owner_epoch(text)"
db="$(copy p_cover "$pre")"; q "$db" -c "drop function private.account_lifecycle_brand_owner_epoch_covered()" > /dev/null
expect "001 without F5's coverage check (a stand-in getter)" "$db" "$cand" "THREADS_BINDING_PRECONDITION_DEPENDENCY private.account_lifecycle_brand_owner_epoch_covered()"
db="$(copy p_124 "$pre")"; q "$db" -c "drop function public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)" > /dev/null
expect "001 without PR #124" "$db" "$cand" "THREADS_BINDING_PRECONDITION_DEPENDENCY public.complete_social_mobile_threads_oauth_connection"
db="$(copy p_owner "$pre")"; q "$db" -c "drop function private.account_lifecycle_brand_owner(text)" > /dev/null 2>&1 || true
expect "001 without G5's brand owner" "$db" "$cand" "THREADS_BINDING_PRECONDITION_DEPENDENCY"
db="$(copy p_again "$pre")"; need "$db" "$cand"
expect "001 re-applied" "$db" "$cand" THREADS_BINDING_ALREADY_APPLIED
need "$db" "$rollback"
expect "rollback twice" "$db" "$rollback" THREADS_BINDING_NOT_APPLIED
need "$db" "$cand"
# G4-13: H2's role graph. authenticator able to SET ROLE to the owner; a delegate role authenticated reaches WITH INHERIT
# FALSE, SET TRUE, granted by the owner's default ACLs on functions / schemas / tables.
db="$(copy p_reach "$pre")"; "${as_super[@]}" -d "$db" -c "grant $owner to authenticator with inherit false, set true" > /dev/null
expect "001 while authenticator can SET ROLE to the owner (NOINHERIT)" "$db" "$cand" "THREADS_BINDING_PRECONDITION_OWNER_REACHABLE authenticator"
"${as_super[@]}" -d postgres -c "revoke $owner from authenticator" > /dev/null
"${as_super[@]}" -d postgres -c "create role $delegate nologin" -c "grant $delegate to authenticated with inherit false, set true" > /dev/null
db="$(copy p_h2_fn "$pre")"; q "$db" -c "alter default privileges for role $owner grant execute on functions to $delegate" > /dev/null
expect "001 under a default ACL granting functions to a delegate (H2 R1)" "$db" "$cand" "THREADS_BINDING_POSTCONDITION_FUNCTION_ACL"
db="$(copy p_h2_schema "$pre")"; q "$db" -c "alter default privileges for role $owner grant usage on schemas to $delegate" > /dev/null
expect "001 under a default ACL granting schemas to a delegate (H2 R1)" "$db" "$cand" "THREADS_BINDING_POSTCONDITION_SCHEMA_ACL"
db="$(copy p_h2_table "$pre")"; q "$db" -c "alter default privileges for role $owner grant select on tables to $delegate" > /dev/null
expect "001 under a default ACL granting tables to a delegate" "$db" "$cand" "THREADS_BINDING_POSTCONDITION_TABLE_ACL"
# G4-14: deeper graphs. authenticated -> hop1 -> hop2 -> leaf, each WITH INHERIT FALSE, SET TRUE, a default ACL granting the
# leaf: refused by the ACL enumeration whatever the depth. authenticator -> hop1 -> owner (SET only): refused as reachable.
"${as_super[@]}" -d postgres -c "create role $hop1 nologin noinherit" -c "create role $hop2 nologin noinherit" -c "create role $leaf nologin" \
  -c "grant $hop1 to authenticated with inherit false, set true" -c "grant $hop2 to $hop1 with inherit false, set true" \
  -c "grant $leaf to $hop2 with inherit false, set true" > /dev/null
[[ "$(q postgres -c "select pg_has_role('authenticated', '$leaf', 'SET') and not pg_has_role('authenticated', '$leaf', 'USAGE')")" == t ]] || fail "deep graph read-back"
db="$(copy p_deep_fn "$pre")"; q "$db" -c "alter default privileges for role $owner grant execute on functions to $leaf" > /dev/null
expect "001 under a default ACL granting functions to a leaf 3 SET-only hops from authenticated" "$db" "$cand" "THREADS_BINDING_POSTCONDITION_FUNCTION_ACL"
db="$(copy p_deep_table "$pre")"; q "$db" -c "alter default privileges for role $owner grant select, insert, update, delete, truncate, references, trigger, maintain on tables to $leaf" > /dev/null
expect "001 under a default ACL granting every table privilege to the leaf" "$db" "$cand" "THREADS_BINDING_POSTCONDITION_TABLE_ACL"
db="$(copy p_deep_owner "$pre")"
"${as_super[@]}" -d postgres -c "revoke $hop1 from authenticated" -c "grant $hop1 to authenticator with inherit false, set true" -c "grant $owner to $hop1 with inherit false, set true" > /dev/null
expect "001 while authenticator reaches the owner in two SET-only hops" "$db" "$cand" "THREADS_BINDING_PRECONDITION_OWNER_REACHABLE authenticator"
"${as_super[@]}" -d postgres -c "revoke $owner from $hop1" -c "revoke $hop1 from authenticator" > /dev/null
echo "PASS deep role graphs (3 SET-only hops to a default-ACL leaf: functions / all table privileges refused; authenticator 2 hops to the owner refused)"
# Fail-before: PR #367's original 001 installs in H2's world and the delegate (which authenticated may SET ROLE to) keeps
# EXECUTE on attest_binding and USAGE on the schema.
db="$(copy p_h2_before "$pre")"
q "$db" -c "alter default privileges for role $owner grant execute on functions to $delegate" -c "alter default privileges for role $owner grant usage on schemas to $delegate" > /dev/null
[[ "$(apply "$db" "$tree/pr367_original_001.sql")" == applied ]] || fail "fail-before: PR #367's original did not install under H2's shape"
before="$(q "$db" -c "select pg_has_role('authenticated', '$delegate', 'SET')::text || ',' || has_function_privilege('$delegate', 'postona_threads_binding.attest_binding(uuid,uuid,text)', 'EXECUTE')::text || ',' || has_schema_privilege('$delegate', 'postona_threads_binding', 'USAGE')::text || ',' || has_function_privilege('authenticated', 'postona_threads_binding.attest_binding(uuid,uuid,text)', 'EXECUTE')::text")"
[[ "$before" == "true,true,true,false" ]] || fail "fail-before read-back: $before"
echo "PASS fail-before (PR #367 fd714505 installs under H2's shape: authenticated SET->delegate, delegate EXECUTE attest_binding, delegate USAGE schema, authenticated itself not = $before)"
# G4-14: the complete the entry calls is PR #124's reviewed body and owner-only.
db="$(copy p_124_exposed "$pre")"; q "$db" -c "grant execute on function public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text) to authenticated" > /dev/null
expect "001 while PR #124's complete is granted to authenticated" "$db" "$cand" THREADS_BINDING_PRECONDITION_COMPLETE_EXPOSED
db="$(copy p_124_drift "$pre")"; q "$db" -c "do \$\$ begin execute format('create or replace function public.complete_social_mobile_threads_oauth_connection(p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_attestation text) returns void language plpgsql volatile security definer set search_path = '''' as %L', (select p.prosrc from pg_proc p where p.oid = 'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)'::regprocedure) || '-- drift'); end \$\$" > /dev/null
expect "001 while PR #124's complete body differs from the reviewed one" "$db" "$cand" THREADS_BINDING_PRECONDITION_COMPLETE_UNPINNED
echo "PASS preconditions (superuser, F5 getter, F5 coverage, PR #124, G5 brand owner, authenticator SET->owner, PR #124 complete exposed / changed) + H2 default ACLs (functions, schemas, tables) refused + re-apply refused + rollback + re-apply"

# ---- 4. Behavior -----------------------------------------------------------------------------------------------------
world="$(copy world "$pre")"
need "$world" "$cand"
main="$(copy main "$world")"
out="$(as_owner "$main" -A -t -f "$behavior" 2>&1)" || fail "behavior: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_BINDING_EPOCH_BEHAVIOR_PASS <<<"$out" || fail "behavior marker missing"
echo "PASS behavior (postona_threads_binding_epoch_behavior.sql)"

# ---- 4c. 002: the custody writer proven by the connect proof (G4-16) ------------------------------------------------------
prelude() { sed -n '1,/^-- 0\. No API role/p' "$behavior" | sed '$d'; }
w1="$(copy w001 "$pre")"; need "$w1" "$cand"
drift_writer="do \$\$ begin execute format('create or replace function public.record_threads_credential_custody(p_social_account_id text, p_expires_at timestamptz) returns void language plpgsql security invoker set search_path = '''' as %L', (select p.prosrc from pg_proc p where p.oid = 'public.record_threads_credential_custody(text,timestamptz)'::regprocedure) || '-- drift'); end \$\$"
db="$(copy q_no001 "$pre")"
expect "002 without 001" "$db" "$cand2" THREADS_CUSTODY_PROOF_PRECONDITION_BINDING
db="$(copy q_pr405 "$pre")"; need "$db" "$tree/pr405_001.sql"
expect "002 over PR #405's 001 (no connect proof)" "$db" "$cand2" THREADS_CUSTODY_PROOF_PRECONDITION_BINDING
db="$(copy q_drift "$w1")"; q "$db" -c "$drift_writer" > /dev/null
expect "002 over a writer that is not the custody candidate's" "$db" "$cand2" THREADS_CUSTODY_PROOF_PRECONDITION_WRITER_UNPINNED
db="$(copy q_super "$w1")"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$cand2" 2>&1 || true)"; got="$(sed -n 's/^.*ERROR: *//p' <<<"$got" | head -1)"
[[ "$got" == THREADS_CUSTODY_PROOF_PRECONDITION_OWNER ]] || fail "002 applied by a superuser: $got"
db="$(copy q_reach "$w1")"; "${as_super[@]}" -d "$db" -c "grant $owner to authenticator with inherit false, set true" > /dev/null
expect "002 while authenticator can SET ROLE to the owner" "$db" "$cand2" "THREADS_CUSTODY_PROOF_PRECONDITION_OWNER_REACHABLE authenticator"
"${as_super[@]}" -d postgres -c "revoke $owner from authenticator" > /dev/null
db="$(copy q_acl "$w1")"; q "$db" -c "grant execute on function public.record_threads_credential_custody(text, timestamptz) to $delegate" > /dev/null
expect "002 while the writer is granted to a delegate role" "$db" "$cand2" THREADS_CUSTODY_PROOF_POSTCONDITION_ACL
db="$(copy q_again "$w1")"; need "$db" "$cand2"
expect "002 re-applied" "$db" "$cand2" THREADS_CUSTODY_PROOF_ALREADY_APPLIED
need "$db" "$rollback2"
[[ "$(q "$db" -c "select md5(prosrc) = 'eb58930b04d23d6a012cf1b54ab93e0f' and obj_description(oid, 'pg_proc') is null from pg_proc where oid = 'public.record_threads_credential_custody(text,timestamptz)'::regprocedure")" == t ]] || fail "002 rollback did not restore the original writer"
expect "002 rollback twice" "$db" "$rollback2" THREADS_CUSTODY_PROOF_NOT_APPLIED
need "$db" "$cand2"
echo "PASS 002 preconditions (no 001, PR #405's 001 without a proof, a writer not the candidate's, superuser, authenticator SET->owner, writer granted to a delegate) + re-apply refused + rollback restores the original writer + rollback twice refused + re-apply"
w2="$(copy w002 "$w1")"; need "$w2" "$cand2"
cmain="$(copy cmain "$w2")"
{ prelude; cat "$custody_behavior"; } > "$tree/custody_behavior_full.sql"
out="$(as_owner "$cmain" -A -t -f "$tree/custody_behavior_full.sql" 2>&1)" || fail "custody behavior: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_BINDING_CUSTODY_BEHAVIOR_PASS <<<"$out" || fail "custody behavior marker missing"
echo "PASS custody behavior (postona_threads_binding_custody_behavior.sql)"

# ---- 5. Race: two complete + attest transactions on one state (G4-13: attest only inside the completing transaction) ----
race="$(copy race "$world")"
{ sed -n '1,/^-- 0\. No API role/p' "$behavior" | sed '$d'
  cat <<'SQL'
select tb.enroll(71) as r \gset
select tb.begin(:'r', 'r1') as acct_r \gset
select tb.check(tb.record(:'r', 'r1', tb.epoch(:'r'), tb.lifecycle(:'r')) = 'OK', 'race record');
SQL
} > "$tree/race_setup.sql"
as_owner "$race" -A -t -f "$tree/race_setup.sql" > /dev/null
connect_sql="select tb.connect('00000000-0000-4000-8000-000000000071'::uuid, 'r1', '17841400000000071')"
( as_owner "$race" -A -t -c "begin" -c "$connect_sql" -c "select pg_sleep(1.5)" -c "commit" > "$tree/race1.out" 2>&1 ) &
holder=$!
sleep 0.4
second="$(as_owner "$race" -A -t -c "$connect_sql" 2>&1 || true)"
wait "$holder" || fail "race holder: $(cat "$tree/race1.out")"
grep -q '^OK$' "$tree/race1.out" || fail "race first: $(cat "$tree/race1.out")"
grep -q THREADS_OAUTH_STATE_NOT_CONSUMABLE <<<"$second" || fail "race second complete + attest: $second"
[[ "$(q "$race" -c "select count(*) from postona_threads_binding.bindings")" == 1 ]] || fail "race: not exactly one binding"
[[ "$(q "$race" -c "select count(*) from postona_threads_binding.state_generations where attested_at is not null")" == 1 ]] || fail "race: not exactly one attested state"
echo "PASS race (two complete + attest transactions on one state: the second waits and is refused by PR #124; one binding, one attested state)"

# ---- 5b. Same now(), different transactions (G4-14, H2 #329 C2 R1) -------------------------------------------------------
collision_setup() {
  { sed -n '1,/^-- 0\. No API role/p' "$behavior" | sed '$d'
    cat <<'SQL'
select tb.enroll(911) as c1u \gset
select tb.begin(:'c1u', 'c1') as acct_c1 \gset
select tb.check(tb.record(:'c1u', 'c1', tb.epoch(:'c1u'), tb.lifecycle(:'c1u')) = 'OK', 'collision record c1');
select tb.enroll(912) as c2u \gset
select tb.begin(:'c2u', 'c2') as acct_c2 \gset
select tb.check(tb.record(:'c2u', 'c2', tb.epoch(:'c2u'), tb.lifecycle(:'c2u')) = 'OK', 'collision record c2');
SQL
  } > "$tree/collision_setup.sql"
  as_owner "$1" -A -t -f "$tree/collision_setup.sql" > /dev/null
}
node_bin="${NODE:-node}"
cb="$(copy coll_before "$pre")"; need "$cb" "$tree/pr388_001.sql"; collision_setup "$cb"
"$node_bin" "$t/postona_threads_binding_epoch_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$cb" before > "$tree/collision_before.out" 2>&1 \
  || fail "fail-before collision: $(cat "$tree/collision_before.out")"
sed 's/^/  /' "$tree/collision_before.out"
ca="$(copy coll_after "$pre")"; need "$ca" "$cand"; collision_setup "$ca"
"$node_bin" "$t/postona_threads_binding_epoch_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$ca" after > "$tree/collision_after.out" 2>&1 \
  || fail "collision: $(cat "$tree/collision_after.out")"
sed 's/^/  /' "$tree/collision_after.out"
echo "PASS same-now() different transactions (PR #388 5bf6f915: other-transaction attest accepted + rollback left the completion committed = fail-before; this 001: refused, rollback undoes both)"

# ---- 5c. Same now(), different transactions: the custody writer (G4-16) -------------------------------------------------
custody_collision_setup() {
  collision_setup "$1"
  awk 'index($0,"create function tb.custody(") == 1 {on=1} on {print} on && /\$\$;$/ {exit}' "$custody_behavior" | as_owner "$1" -A -t > /dev/null
}
kb="$(copy cust_before "$w1")"; custody_collision_setup "$kb"
"$node_bin" "$t/postona_threads_binding_epoch_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$kb" custody_before > "$tree/custody_before.out" 2>&1 \
  || fail "custody fail-before collision: $(cat "$tree/custody_before.out")"
sed 's/^/  /' "$tree/custody_before.out"
# What the original DOES guarantee: a later transaction with a different start time is refused by verified_at = now().
got="$(q "$kb" -c "select tb.custody(tb.uid(911), (select id from public.social_accounts where platform_user_id = '17841400000000911'), now() + interval '20 days')")"
[[ "$got" == ERR:THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION ]] || fail "original writer, later transaction with another now(): $got"
echo "  original writer, a later transaction with another now(): $got (its check holds only when the start times differ)"
ka="$(copy cust_after "$w2")"; custody_collision_setup "$ka"
"$node_bin" "$t/postona_threads_binding_epoch_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$ka" custody_after > "$tree/custody_after.out" 2>&1 \
  || fail "custody collision: $(cat "$tree/custody_after.out")"
sed 's/^/  /' "$tree/custody_after.out"
echo "PASS custody same-now() different transactions (original writer: accepted = fail-before; 002: refused, nothing recorded)"

# ---- 6. Mutations -----------------------------------------------------------------------------------------------------
caught=0; total=0
mutate() {
  local name="$1" old="$2" new="$3" file db
  total=$((total + 1))
  file="$tree/mut_$name.sql"
  python3 -I - "$cand" "$file" "$old" "$new" <<'PY' || fail "mutation $name: pattern not unique"
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
if s.count(old) != 1: sys.exit(1)
open(dst, 'w', encoding='utf-8').write(s.replace(old, new))
PY
  db="$(copy "m_$name" "$pre")"
  if [[ "$(apply "$db" "$file")" != applied ]] || ! as_owner "$db" -A -t -f "$behavior" > /dev/null 2>&1; then
    caught=$((caught + 1)); echo "  CAUGHT $name"
  else
    echo "  MISSED $name"
  fi
}
mutate attest_no_epoch "  if v_epoch <> v_gen.owner_epoch then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_CHANGED' using errcode = 'P0001';
  end if;
  if v_lifecycle is distinct from v_gen.lifecycle_version then" "  if v_lifecycle is distinct from v_gen.lifecycle_version then"
mutate attest_no_lifecycle "  if v_lifecycle is distinct from v_gen.lifecycle_version then
    raise exception 'THREADS_BINDING_SERVICE_GENERATION_CHANGED' using errcode = 'P0001';
  end if;
  update postona_threads_binding.state_generations" "  update postona_threads_binding.state_generations"
mutate record_no_epoch "  if v_epoch <> p_owner_epoch then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_CHANGED' using errcode = 'P0001';
  end if;" ""
mutate record_no_lifecycle "  if v_lifecycle is distinct from p_lifecycle_version then
    raise exception 'THREADS_BINDING_SERVICE_GENERATION_CHANGED' using errcode = 'P0001';
  end if;" ""
mutate attest_unrecorded_ok "  if not found then
    raise exception 'THREADS_BINDING_GENERATION_UNRECORDED' using errcode = 'P0001';
  end if;" "  if not found then
    return;
  end if;"
mutate attest_replay_ok "  if v_gen.attested_at is not null
     or exists (select 1 from postona_threads_binding.bindings b where b.oauth_state_id = p_oauth_state_id) then
    raise exception 'THREADS_BINDING_ALREADY_ATTESTED' using errcode = 'P0001';
  end if;" ""
mutate attest_once_only_current "  if v_gen.attested_at is not null
     or exists" "  if exists"
mutate entry_skips_complete "  perform public.complete_social_mobile_threads_oauth_connection(p_oauth_state_id, p_platform_user_id, p_handle,
                                                                 p_access_token, p_attestation);" ""
mutate entry_unpinned "                    and pg_catalog.md5(p.prosrc) = '8c90c72f625ff4af247a11e413fc761b'
                    and p.proacl is not null" "                    and p.proacl is not null"
mutate entry_exposed_ok "                    and p.proacl is not null
                    and not exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee <> p.proowner)) then" "                    ) then"
mutate entry_invoker_ok "                    and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                    and p.prosecdef and" "                    and p.proowner = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                    and"
mutate entry_no_actor "  if v_actor is null or p_oauth_state_id is null" "  if p_oauth_state_id is null"
mutate separate_attest_kept "-- The G4-03 ThreadsAccountRow" "create function postona_threads_binding.attest_binding(p_actor uuid, p_oauth_state_id uuid, p_threads_user_id text)
returns void language sql volatile security definer set search_path = '' as \$\$ select \$\$;
revoke all on function postona_threads_binding.attest_binding(uuid, uuid, text) from public, anon, authenticated, service_role;
-- The G4-03 ThreadsAccountRow"
mutate attested_at_not_set "  update postona_threads_binding.state_generations set attested_at = now() where oauth_state_id = p_oauth_state_id;
" ""
mutate record_consumed_ok "s.initiated_by_user_id = p_actor and s.consumed_at is null and s.expires_at > now()" "s.initiated_by_user_id = p_actor and s.expires_at > now()"
mutate record_expired_ok "s.initiated_by_user_id = p_actor and s.consumed_at is null and s.expires_at > now()" "s.initiated_by_user_id = p_actor and s.consumed_at is null"
mutate record_any_actor "s.id = p_oauth_state_id and s.initiated_by_user_id = p_actor and s.consumed_at is null" "s.id = p_oauth_state_id and s.consumed_at is null"
mutate attest_no_owner "  if v_owner is distinct from v_actor then
    raise exception 'THREADS_BINDING_NOT_OWNER' using errcode = 'P0001';
  end if;
  if v_epoch is null or v_epoch < 1 then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_UNKNOWN' using errcode = 'P0001';
  end if;
  if v_epoch <> v_gen.owner_epoch" "  if v_epoch <> v_gen.owner_epoch"
mutate row_numbers_bigint "has_access_credential boolean, bound_by uuid, bind_owner_epoch text, bind_lifecycle_version text)" "has_access_credential boolean, bound_by uuid, bind_owner_epoch bigint, bind_lifecycle_version bigint)"
mutate row_ignores_identity " and b.threads_user_id is not distinct from sa.platform_user_id" ""
mutate api_role_reaches "-- Postconditions (G4-13, H2 #329 R1)" "grant execute on function postona_threads_binding.binding_row(text) to authenticated;
-- Postconditions (G4-13, H2 #329 R1)"
mutate record_input_zero_ok "p_owner_epoch is null or p_owner_epoch < 1
     or p_lifecycle_version is null or p_lifecycle_version < 1" "p_owner_epoch is null
     or p_lifecycle_version is null"
# Install-time guards are proven where they matter: the mutated file must still refuse the adverse world with that code.
mutate_install() {  # caught when the mutated file no longer refuses with the expected code
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
mutate_install function_acl_weak "       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                   where p.oid = to_regprocedure(v_fn) and a.grantee <> v_me) then" "       or false then" \
  "alter default privileges for role $owner grant execute on functions to $delegate" "" "" THREADS_BINDING_POSTCONDITION_FUNCTION_ACL
mutate_install schema_acl_weak "              where n.nspname = 'postona_threads_binding' and a.grantee <> v_me) then" "              where false) then" \
  "alter default privileges for role $owner grant usage on schemas to $delegate" "" "" THREADS_BINDING_POSTCONDITION_SCHEMA_ACL
mutate_install table_acl_weak "                where c.oid = to_regclass(v_rel) and a.grantee <> v_me) then" "                where false) then" \
  "alter default privileges for role $owner grant select on tables to $delegate" "" "" THREADS_BINDING_POSTCONDITION_TABLE_ACL
mutate_install complete_pin_pre_removed "                    and pg_catalog.md5(p.prosrc) = '8c90c72f625ff4af247a11e413fc761b') then
    raise exception 'THREADS_BINDING_PRECONDITION_COMPLETE_UNPINNED';" "                    ) then
    raise exception 'THREADS_BINDING_PRECONDITION_COMPLETE_UNPINNED';" \
  "do \$\$ begin execute format('create or replace function public.complete_social_mobile_threads_oauth_connection(p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_attestation text) returns void language plpgsql volatile security definer set search_path = '''' as %L', (select p.prosrc from pg_proc p where p.oid = 'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)'::regprocedure) || '-- drift'); end \$\$" "" "" THREADS_BINDING_PRECONDITION_COMPLETE_UNPINNED
mutate_install complete_exposed_pre_removed "    raise exception 'THREADS_BINDING_PRECONDITION_COMPLETE_EXPOSED';" "    null;" \
  "grant execute on function public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text) to authenticated" "" "" THREADS_BINDING_PRECONDITION_COMPLETE_EXPOSED
mutate_install owner_reach_pre_removed "    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_fn)
       and (pg_catalog.pg_has_role(v_fn, v_me, 'MEMBER') or pg_catalog.pg_has_role(v_fn, v_me, 'SET')
            or pg_catalog.pg_has_role(v_fn, v_me, 'USAGE')) then
      raise exception 'THREADS_BINDING_PRECONDITION_OWNER_REACHABLE %', v_fn;
    end if;" "    null;" \
  "" "grant $owner to authenticator with inherit false, set true" "revoke $owner from authenticator" THREADS_BINDING_PRECONDITION_OWNER_REACHABLE
# G4-16: 001's connect proof (binding behavior 10b) ...
mutate entry_no_proof_setting "  perform pg_catalog.set_config('postona_threads_binding.connect_proof', v_proof::text, true);" ""
mutate entry_proof_session_wide "pg_catalog.set_config('postona_threads_binding.connect_proof', v_proof::text, true)" "pg_catalog.set_config('postona_threads_binding.connect_proof', v_proof::text, false)"
mutate entry_proof_not_stored "  values (v_account.id, v_gen.brand_id, p_platform_user_id, v_actor, p_oauth_state_id, v_proof, v_gen.owner_epoch," "  values (v_account.id, v_gen.brand_id, p_platform_user_id, v_actor, p_oauth_state_id, pg_catalog.gen_random_uuid(), v_gen.owner_epoch,"
mutate reconnect_keeps_old_proof "oauth_state_id = excluded.oauth_state_id, connect_proof = excluded.connect_proof," "oauth_state_id = excluded.oauth_state_id,"
# ... and 002 (custody behavior, over the world + 001).
mutate2() {
  local name="$1" old="$2" new="$3" file db
  total=$((total + 1))
  file="$tree/mut2_$name.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$cand2" "$file" "$old" "$new" || fail "mutation $name: pattern not unique"
  db="$(copy "n_$name" "$w1")"
  if [[ "$(apply "$db" "$file")" != applied ]] || ! as_owner "$db" -A -t -f "$tree/custody_behavior_full.sql" > /dev/null 2>&1; then
    caught=$((caught + 1)); echo "  CAUGHT $name"
  else
    echo "  MISSED $name"
  fi
}
mutate2 custody_proof_unchecked "  if not exists (
       select 1 from postona_threads_binding.bindings b
        where b.social_account_id = v_account.id and b.brand_id = v_account.brand_id
          and b.threads_user_id = v_account.platform_user_id and b.bound_by = v_user
          and b.connect_proof::text = v_proof) then
    raise exception 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION' using errcode = 'P0001';
  end if;" ""
mutate2 custody_any_bound_binding "          and b.connect_proof::text = v_proof) then" "          ) then"
mutate2 custody_any_binder " and b.bound_by = v_user
          and b.connect_proof" "
          and b.connect_proof"
mutate2 custody_any_identity "          and b.threads_user_id = v_account.platform_user_id and b.bound_by = v_user" "          and b.bound_by = v_user"
mutate2 custody_back_to_clock "          and b.connect_proof::text = v_proof) then" "          and v_account.verified_at = pg_catalog.now()) then"
mutate2_install() {  # caught when the mutated 002 no longer refuses the adverse world with the expected code
  local name="$1" old="$2" new="$3" setup="$4" super_setup="$5" undo="$6" want="$7" file db got
  total=$((total + 1))
  file="$tree/mut2_$name.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$cand2" "$file" "$old" "$new" || fail "mutation $name: pattern not unique"
  db="$(copy "n_$name" "$w1")"
  [[ -n "$setup" ]] && q "$db" -c "$setup" > /dev/null
  [[ -n "$super_setup" ]] && "${as_super[@]}" -d "$db" -c "$super_setup" > /dev/null
  got="$(apply "$db" "$file")"
  [[ -n "$undo" ]] && "${as_super[@]}" -d postgres -c "$undo" > /dev/null
  if [[ "$got" != "$want"* ]]; then caught=$((caught + 1)); echo "  CAUGHT $name ($got)"; else echo "  MISSED $name"; fi
}
mutate2_install custody_writer_unpinned "  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'eb58930b04d23d6a012cf1b54ab93e0f' then" "  if false then" \
  "$drift_writer" "" "" THREADS_CUSTODY_PROOF_PRECONDITION_WRITER_UNPINNED
mutate2_install custody_acl_post_weak "     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee <> v_me) then" "     or false then" \
  "grant execute on function public.record_threads_credential_custody(text, timestamptz) to $delegate" "" "" THREADS_CUSTODY_PROOF_POSTCONDITION_ACL
mutate2_install custody_owner_reach_removed "      raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_OWNER_REACHABLE %', v_api;" "      null;" \
  "" "grant $owner to authenticator with inherit false, set true" "revoke $owner from authenticator" THREADS_CUSTODY_PROOF_PRECONDITION_OWNER_REACHABLE
mutate2_install custody_binding_pre_removed "    raise exception 'THREADS_CUSTODY_PROOF_PRECONDITION_BINDING';" "    null;" \
  "alter table postona_threads_binding.bindings drop column connect_proof" "" "" THREADS_CUSTODY_PROOF_PRECONDITION_BINDING
echo "mutations caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a mutation was not caught"
echo "POSTONA_THREADS_BINDING_EPOCH_RUN_PASS"
