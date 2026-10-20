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
prefix="kabumori_tb_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $owner" > /dev/null 2>&1 || true
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
behavior="$t/postona_threads_binding_epoch_behavior.sql"
sed 's/^/  /' "$tree/TB_MANIFEST.txt"

# ---- 2. The world ---------------------------------------------------------------------------------------------------
"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
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
echo "PASS preconditions (superuser, F5 getter, F5 coverage, PR #124, G5 brand owner) + re-apply refused + rollback + re-apply"

# ---- 4. Behavior -----------------------------------------------------------------------------------------------------
world="$(copy world "$pre")"
need "$world" "$cand"
main="$(copy main "$world")"
out="$(as_owner "$main" -A -t -f "$behavior" 2>&1)" || fail "behavior: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_BINDING_EPOCH_BEHAVIOR_PASS <<<"$out" || fail "behavior marker missing"
echo "PASS behavior (postona_threads_binding_epoch_behavior.sql)"

# ---- 5. Race: two attests of one state ------------------------------------------------------------------------------
race="$(copy race "$world")"
{ sed -n '1,/^-- 0\. No API role/p' "$behavior" | sed '$d'
  cat <<'SQL'
select tb.enroll(71) as r \gset
select tb.begin(:'r', 'r1') as acct_r \gset
select tb.check(tb.record(:'r', 'r1', tb.epoch(:'r'), tb.lifecycle(:'r')) = 'OK', 'race record');
select tb.check(tb.as_person(:'r', format('select public.complete_social_mobile_threads_oauth_connection(%L::uuid, %L, %L, %L, %L)::text',
                tb.state('r1'), '17841400000000071', 'h71', tb.token('r1'), tb.attest(tb.state('r1'), '17841400000000071', 'h71', tb.token('r1'))))
                not like 'ERR:%', 'race complete (committed before the two attests)');
SQL
} > "$tree/race_setup.sql"
as_owner "$race" -A -t -f "$tree/race_setup.sql" > /dev/null
attest_sql="select postona_threads_binding.attest_binding('00000000-0000-4000-8000-000000000071'::uuid, tb.state('r1'), '17841400000000071')"
( as_owner "$race" -A -t -c "begin" -c "$attest_sql" -c "select pg_sleep(1.5)" -c "commit" > "$tree/race1.out" 2>&1 ) &
holder=$!
sleep 0.4
second="$(as_owner "$race" -A -t -c "$attest_sql" 2>&1 || true)"
wait "$holder" || fail "race holder: $(cat "$tree/race1.out")"
grep -q THREADS_BINDING_ALREADY_ATTESTED <<<"$second" || fail "race second attest: $second"
[[ "$(q "$race" -c "select count(*) from postona_threads_binding.bindings")" == 1 ]] || fail "race: not exactly one binding"
echo "PASS race (the second attest waits for the first and is refused; one binding)"

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
  -- A reconnect" "  -- A reconnect"
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
mutate attest_any_actor "  if v_gen.initiated_by is distinct from p_actor then
    raise exception 'THREADS_BINDING_NOT_INITIATOR' using errcode = 'P0001';
  end if;" ""
mutate attest_any_threads_user "     or v_account.platform_user_id is distinct from p_threads_user_id then" "     then"
mutate attest_replay_ok "  if exists (select 1 from postona_threads_binding.bindings b where b.oauth_state_id = p_oauth_state_id) then
    raise exception 'THREADS_BINDING_ALREADY_ATTESTED' using errcode = 'P0001';
  end if;" ""
mutate attest_before_complete "and s.consumed_at is not null" "and true"
mutate record_consumed_ok "s.initiated_by_user_id = p_actor and s.consumed_at is null and s.expires_at > now()" "s.initiated_by_user_id = p_actor and s.expires_at > now()"
mutate record_expired_ok "s.initiated_by_user_id = p_actor and s.consumed_at is null and s.expires_at > now()" "s.initiated_by_user_id = p_actor and s.consumed_at is null"
mutate record_any_actor "s.id = p_oauth_state_id and s.initiated_by_user_id = p_actor and s.consumed_at is null" "s.id = p_oauth_state_id and s.consumed_at is null"
mutate attest_no_owner "  if v_owner is distinct from p_actor then
    raise exception 'THREADS_BINDING_NOT_OWNER' using errcode = 'P0001';
  end if;
  if v_epoch is null or v_epoch < 1 then
    raise exception 'THREADS_BINDING_OWNER_EPOCH_UNKNOWN' using errcode = 'P0001';
  end if;
  if v_epoch <> v_gen.owner_epoch" "  if v_epoch <> v_gen.owner_epoch"
mutate row_numbers_bigint "has_access_credential boolean, bound_by uuid, bind_owner_epoch text, bind_lifecycle_version text)" "has_access_credential boolean, bound_by uuid, bind_owner_epoch bigint, bind_lifecycle_version bigint)"
mutate row_ignores_identity " and b.threads_user_id is not distinct from sa.platform_user_id" ""
mutate api_role_reaches "-- Postconditions: owner, definer" "grant execute on function postona_threads_binding.binding_row(text) to authenticated;
-- Postconditions: owner, definer"
mutate record_input_zero_ok "p_owner_epoch is null or p_owner_epoch < 1
     or p_lifecycle_version is null or p_lifecycle_version < 1" "p_owner_epoch is null
     or p_lifecycle_version is null"
echo "mutations caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a mutation was not caught"
echo "POSTONA_THREADS_BINDING_EPOCH_RUN_PASS"
