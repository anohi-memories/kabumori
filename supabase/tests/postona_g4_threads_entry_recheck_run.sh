#!/usr/bin/env bash
# G4-42 (Issue #319): B10 for Threads -- supabase/candidates/postona_g4_threads_personal_auth/001_threads_entry_workspace_recheck.sql
# on a disposable LOCAL PostgreSQL 17, never production / managed / real Vault / OAuth / Meta / Threads.
# Sections 1-2 (the world: real G5 lifecycle + T13 + F5 owner epoch + PR #124 + custody) are postona_threads_binding_epoch_run.sh's
# L30-L153, copied so that this proof stands alone; nothing here changes an existing file. Then, with the binding-epoch 001 entry
# and G5 PR #506's S2-3 predicate body (verbatim, under its own name):
#   G4-42 1. postona_g4_threads_entry_recheck_behavior.sql: mode=current (the gap reproduces) / mode=candidate (refused)
#   G4-42 2. regression: postona_threads_binding_epoch_behavior.sql passes with the candidate installed
#   G4-42 3. install refusals (no G5 predicate, re-apply), rollback refusal, rollback -> mode=current passes again
#   G4-42 4. negative controls (mutants of the candidate)
# A delegate role and authenticator are cluster-wide: run alone.
# Usage: TB_PGHOST=/private/tmp/<socket-dir> TB_PGPORT=<port> TB_PGSUPER=<superuser> supabase/tests/postona_g4_threads_entry_recheck_run.sh
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

# ---- G4-42: B10 for Threads ----------------------------------------------------------------------------------------------
G5S23=bbc52a6b
git -C "$repo" cat-file -e "${G5S23}^{commit}" 2>/dev/null || fail "missing git objects for $G5S23 (fetch G5 PR #506)"
g5_file=supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql
[ "$(git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' | md5 -q)" = "3d7cf91b22b9f841fd9b4ed3b47eae32" ] \
  || fail "G5 PR #506 predicate lines moved (pin)"
# G5's S2-3 predicate under its own name, body verbatim (its install file needs D1 / R0, which this world does not carry)
git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' > "$tree/g5_predicate.sql"
g4t="$c/postona_g4_threads_personal_auth/001_threads_entry_workspace_recheck.sql"
g4t_rb="$c/postona_g4_threads_personal_auth/001_threads_entry_workspace_recheck_rollback.sql"
mine="$t/postona_g4_threads_entry_recheck_behavior.sql"
sed -n '1,/^-- 0\. No API role/p' "$behavior" | sed '$d' > "$tree/g4t_prelude.sql"
run_g4t() { # <db> <mode>
  cat "$tree/g4t_prelude.sql" "$mine" > "$tree/g4t_full.sql"
  as_owner "$1" -A -t -v mode="$2" -f "$tree/g4t_full.sql" 2>&1
}
world="$(copy world "$pre")"
need "$world" "$cand"
as_owner "$world" -f "$tree/g5_predicate.sql" > /dev/null
if [ -n "${G4T_PRINT_PINS:-}" ]; then
  q "$world" -c "select 'entry=' || md5(prosrc) from pg_proc where oid = to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)')"
  pin="$(copy pin "$world")"
  awk '/^create or replace function postona_threads_binding.complete_and_attest_binding\(/ {on=1} on {print} on && /^end \$\$;/ {exit}' "$g4t" | q "$pin" > /dev/null
  q "$pin" -c "select 'candidate=' || md5(prosrc) from pg_proc where oid = to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)')"
  exit 0
fi

echo "== G4-42 1. behavior"
cur="$(copy cur "$world")"
out="$(run_g4t "$cur" current)" || fail "mode=current: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o 'G4T_THREADS_RECHECK_BEHAVIOR_PASS mode=current' <<<"$out" || fail "mode=current marker"
cdb="$(copy cand "$world")"
need "$cdb" "$g4t"
out="$(run_g4t "$cdb" candidate)" || fail "mode=candidate: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o 'G4T_THREADS_RECHECK_BEHAVIOR_PASS mode=candidate' <<<"$out" || fail "mode=candidate marker"

echo "== G4-42 2. regression: the binding-epoch behavior with the candidate installed"
reg="$(copy reg "$world")"
need "$reg" "$g4t"
out="$(as_owner "$reg" -A -t -f "$behavior" 2>&1)" || fail "binding-epoch behavior with the candidate: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o POSTONA_THREADS_BINDING_EPOCH_BEHAVIOR_PASS <<<"$out" || fail "binding-epoch marker"

echo "== G4-42 3. install refusals and rollback"
nog5="$(copy nog5 "$pre")"
need "$nog5" "$cand"
got="$(apply "$nog5" "$g4t")"; [[ "$got" == G4T_PRECONDITION_AUTHORITY_MISSING* ]] || fail "no G5 predicate: $got"; echo "REFUSED_AS_EXPECTED $got"
got="$(apply "$cdb" "$g4t")"; [[ "$got" == G4T_PRECONDITION_ENTRY_BODY* ]] || fail "re-apply: $got"; echo "REFUSED_AS_EXPECTED $got"
got="$(apply "$cur" "$g4t_rb")"; [[ "$got" == G4T_ROLLBACK_NOT_APPLIED* ]] || fail "rollback not applied: $got"; echo "REFUSED_AS_EXPECTED $got"
rb="$(copy rb "$world")"
need "$rb" "$g4t"
need "$rb" "$g4t_rb"
out="$(run_g4t "$rb" current)" || fail "mode=current after rollback: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o 'G4T_THREADS_RECHECK_BEHAVIOR_PASS mode=current' <<<"$out" | sed 's/^/after rollback: /'

echo "== G4-42 4. negative controls"
survived=0
mutate_g4t() { # <name> <perl substitution>
  local f="$tree/g4t_mut_$1.sql" db
  perl -0pe "$2" "$g4t" > "$f"
  cmp -s "$f" "$g4t" && fail "mutant $1 did not change the candidate"
  # the postcondition pins the reviewed body: strip it so that the mutant installs and the behavior judges it
  perl -0pi -e "s/raise exception 'G4T_POSTCONDITION_ENTRY_BODY';/null;/" "$f"
  db="$(copy "m_$1" "$world")"
  [[ "$(apply "$db" "$f")" == applied ]] || { echo "MUTANT_CAUGHT $1 (install refused)"; return; }
  if out="$(run_g4t "$db" candidate)"; then
    echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
  else
    echo "MUTANT_CAUGHT $1 by: $(grep -m1 -o 'FAIL [^:]*' <<<"$out")"
  fi
}
mutate_g4t check_removed "s/  v_verdict := private.postona_personal_workspace_eligibility\(v_actor\);\n  if v_verdict is distinct from 'own' then/  v_verdict := private.postona_personal_workspace_eligibility(v_actor);\n  if false then/"
mutate_g4t null_only "s/  if v_verdict is distinct from 'own' then/  if v_verdict is null then/"
# (asking about the workspace owner instead of the actor is an EQUIVALENT mutant: the entry has already required owner = actor)
mutate_g4t conflict_allowed "s/  if v_verdict is distinct from 'own' then/  if v_verdict not in ('own', 'OWN_WORKSPACE_CONFLICT') then/"
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"
echo "G4T_THREADS_ENTRY_RECHECK_ALL_PASS"
