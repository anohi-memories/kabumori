#!/usr/bin/env bash
# G4-46 (Issue #319): X connect with G5's T13 in G4's own bodies (005_x_connect_lifecycle_t13.sql) on G5's REAL world, on a disposable
# LOCAL PostgreSQL 17 -- never production / managed / real Vault / OAuth / X. No network, no token, no paid call.
# The world is G5-44's (PR #543 b2e5aaa4 postona_personal_auth_consumer_batch_pg_run.sh L83-L104, copied: the real lifecycle chain and
# T13 from main's migrations at the pinned 21a5cad4, the owner-epoch candidate, auth.sessions, auth.uid() over both claim sources),
# then, all as the lifecycle owner (NOT a superuser): G5's migration candidate (PR #543's install file, pinned blob), G4 001-004 (this
# checkout) and 005. People are G5-44's: A = POSTONA started + live session, C = workspace + session, no service.
#   1. "rv" (G4 001-004, no 005) -- G5-44's GAP G4-1 reproduces: C and a service being ended begin an X connection
#   2. "t13" (+ 005)             -- the same requests are refused with G5's codes; A connects (begin + consume + complete)
#   3. install refusals: 005 twice; 005 by a superuser-owned stack; 005 without 004
#   4. rollback of 005 -> 002/004 bodies back (the GAP returns)   5. mutants of 005
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_g4_x_oauth_t13_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${TQ_PGHOST:?TQ_PGHOST required}"; port="${TQ_PGPORT:?TQ_PGPORT required}"; super="${TQ_PGSUPER:?TQ_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: TQ_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
cand="$repo/supabase/candidates/postona_g4_x_oauth_personal_epoch"
fail() { echo "FAIL $*" >&2; exit 1; }
P21=21a5cad4b71de63265db8517da93c6efc60cdde8
G5=b2e5aaa48af0b4d149c133bf52f923ff683b0ee0
for sha in "$P21" "$G5"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch G5 PR #543 / its base)"
done
n="$$"; owner="kb_g4t13_owner_$n"; prefix="kabumori_g4t13_$n"
work="$(mktemp -d /private/tmp/kabumori-g4t13.XXXXXX)"
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
tree="$work/pinned"; mkdir -p "$tree"
git -C "$repo" archive "$P21" supabase/migrations supabase/tests supabase/candidates/common_account_brand_owner_epoch | tar -x -C "$tree"
[ "$(git hash-object "$tree/supabase/migrations/20261010051938_common_account_service_write_guard.sql")" = "da587631cfe8872e3ccf6fd521b919a5439c6574" ] \
  || fail "the world's T13 is not the reviewed blob"
install="$work/g5_install.sql"
git -C "$repo" show "$G5:supabase/candidates/postona_personal_auth_migration/20261028090000_postona_personal_auth_install.sql" > "$install"
echo "G5 install blob: $(git -C "$repo" rev-parse "$G5:supabase/candidates/postona_personal_auth_migration/20261028090000_postona_personal_auth_install.sql")"
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

# world <name>: G5-44's world (copied, see the header), then G5's install, as the lifecycle owner
world() {
  local w="$1" f  # (local f: callers keep their own $f)
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
  own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
  own -f "$tree/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null
  own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
  own -f "$install" >/dev/null
}
own_db() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$1" "${@:2}"; }
apply() { # <db> <file> [user]: 'applied' or the first ERROR text
  local out
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "${3:-$owner}" -d "${prefix}_$1" -f "$2" 2>&1)"; then echo applied
  elif grep -q 'ERROR:' <<<"$out"; then sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1
  else echo "PSQL_FAILED $(tail -1 <<<"$out")"; fi
}
A=00000000-0000-4000-8000-000000004401; B=00000000-0000-4000-8000-000000004402; C=00000000-0000-4000-8000-000000004403
SA=00000000-0000-4000-8000-000000004451; SC=00000000-0000-4000-8000-000000004453
claims() { printf '{"sub":"%s","role":"authenticated","session_id":"%s","is_anonymous":%s}' "$1" "$2" "${3:-false}"; }
claims_without_anonymous() { printf '{"sub":"%s","role":"authenticated","session_id":"%s"}' "$1" "$2"; }
# as <db> <claims json> <statement> [before] [commit]: one request as `authenticated`; 'OK <last line>' or 'ERROR <text>'
as() {
  local out
  if out="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$1" \
      -c "begin; ${4:-}" -c "select set_config('request.jwt.claims', '$2', true); set local role authenticated;" -c "$3" -c "${5:-rollback};" 2>&1)"; then
    echo "OK $(tail -1 <<<"$out")"
  else
    echo "ERROR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  fi
}
people() {
  own_db "$1" -c "select public.fixture_user_with_workspace('$A'::uuid, 'g4ta'), public.fixture_user_with_workspace('$B'::uuid, 'g4tb'),
    public.fixture_user_with_workspace('$C'::uuid, 'g4tc'); select public.fixture_login(u) from unnest(array['$A', '$B', '$C']::uuid[]) u;
    insert into auth.sessions (id, user_id, not_after) values ('$SA', '$A', null), ('$SC', '$C', null)" >/dev/null
  [ "$(as "$1" "$(claims "$A" "$SA")" "select public.start_x_autopost_service() ->> 'status'" "" "commit;")" = "OK active" ] || fail "people: A not active"
  own_db "$1" -c "update public.brands set code_profile_key = 'social_mobile_user_v1' where id in ('u_' || substr(md5('$A'), 1, 24), 'u_' || substr(md5('$C'), 1, 24))" >/dev/null
}
hash() { printf '%064x' "$1"; }
BEGIN() { echo "select brand_id || ',' || social_account_id from public.begin_social_mobile_x_oauth_connection('$(hash "$1")', 'https://example.test/cb', now() + interval '10 minutes')"; }
CONSUME() { echo "select oauth_state_id from public.consume_social_mobile_x_oauth_state('$(hash "$1")')"; }
COMPLETE() { echo "select public.complete_social_mobile_x_oauth_connection((select id from public.social_account_oauth_states where state_hash = '$(hash "$1")'), '$2', 'h$2', 'fakeXat_$1', 'fakeXrt_$1')"; }
STOP_A="set local role service_role; select public.begin_service_deletion('$A'::uuid, 'x_autopost'); reset role;"
ENDED="update auth.sessions set not_after = now() - interval '1 minute' where id = '$SA';"
check() { if [ "$2" != "$3" ]; then fail "$1: expected [$3], got [$2]"; fi; echo "PASS $1 -> [$2] (expected [$3])"; }
match() { [[ "$2" == $3 ]] || fail "$1: expected $3, got '$2'"; echo "PASS $1 -> $2"; }
x4() { local xf; for xf in 001_x_oauth_personal_epoch.sql 002_x_oauth_product_wiring.sql 003_x_disconnect_user_rpc.sql 004_x_consume_preexchange_recheck.sql; do
  [ "$(apply "$1" "$cand/$xf")" = applied ] || fail "$xf on $1: $(apply "$1" "$cand/$xf")"; done; }
# run_cases <db> <mode: rv|t13>
run_cases() {
  local db="$1" mode="$2" wa puid
  wa="u_$(printf '%s' "$A" | md5 -q | cut -c1-24)"
  # the X user id the fixture already gave A's account (complete refuses another one: X_IDENTITY_ACCOUNT_MISMATCH)
  puid="$(own_db "$db" -c "select coalesce(platform_user_id, 'x_g4ta') from public.social_accounts where brand_id = '$wa' and platform = 'x'")"
  if [ "$mode" = rv ]; then
    match "rv C (no POSTONA) begins: GAP G4-1" "$(as "$db" "$(claims "$C" "$SC")" "$(BEGIN 5)")" "OK u_*"
    match "rv A with the service being ended begins: GAP G4-1" "$(as "$db" "$(claims "$A" "$SA")" "$(BEGIN 6)" "$STOP_A")" "OK u_*"
    return
  fi
  match "t13 A begins" "$(as "$db" "$(claims "$A" "$SA")" "$(BEGIN 1)" "" "commit;")" "OK $wa,sa_*"
  match "t13 A consumes" "$(as "$db" "$(claims "$A" "$SA")" "$(CONSUME 1)")" "OK *-*"
  check "t13 C (no POSTONA) begin" "$(as "$db" "$(claims "$C" "$SC")" "$(BEGIN 2)")" "ERROR ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND"
  check "t13 service being ended: begin" "$(as "$db" "$(claims "$A" "$SA")" "$(BEGIN 3)" "$STOP_A")" "ERROR SERVICE_DELETION_IN_PROGRESS"
  check "t13 service being ended: consume" "$(as "$db" "$(claims "$A" "$SA")" "$(CONSUME 1)" "$STOP_A")" "ERROR SERVICE_DELETION_IN_PROGRESS"
  check "t13 service being ended: complete" "$(as "$db" "$(claims "$A" "$SA")" "$(COMPLETE 1 "$puid")" "$STOP_A")" "ERROR SERVICE_DELETION_IN_PROGRESS"
  check "t13 anonymous begin" "$(as "$db" "$(claims "$A" "$SA" true)" "$(BEGIN 4)")" "ERROR ACCOUNT_LIFECYCLE_AUTH_REQUIRED"
  check "t13 is_anonymous missing" "$(as "$db" "$(claims_without_anonymous "$A" "$SA")" "$(BEGIN 4)")" "ERROR ACCOUNT_LIFECYCLE_AUTH_REQUIRED"
  check "t13 ended session: consume" "$(as "$db" "$(claims "$A" "$SA")" "$(CONSUME 1)" "$ENDED")" "ERROR ACCOUNT_LIFECYCLE_AUTH_REQUIRED"
  check "t13 A -> B -> A: consume" "$(as "$db" "$(claims "$A" "$SA")" "$(CONSUME 1)" \
    "insert into public.brand_memberships (brand_id, user_id, role) values ('$wa', '$B', 'owner'); delete from public.brand_memberships where brand_id = '$wa' and user_id = '$B';")" \
    "ERROR OWNER_EPOCH_CHANGED"
  # (complete returns void: psql's last line is the claims line, so only "OK" is asserted; the account row below is the proof)
  match "t13 A completes" "$(as "$db" "$(claims "$A" "$SA")" "$(COMPLETE 1 "$puid")" "" "commit;")" "OK*"
  check "t13 A's account verified" "$(own_db "$db" -c "select connection_status from public.social_accounts where brand_id = '$wa' and platform = 'x'")" "identity_verified"
}

echo "== 1. rv: G5 install + G4 001-004 (no 005)"
world rv; x4 rv; people rv; run_cases rv rv
echo "== 2. t13: + 005"
world t13; x4 t13
[ "$(apply t13 "$cand/005_x_connect_lifecycle_t13.sql")" = applied ] || fail "005: $(apply t13 "$cand/005_x_connect_lifecycle_t13.sql")"
people t13; run_cases t13 t13
echo "== 3. install refusals"
got="$(apply t13 "$cand/005_x_connect_lifecycle_t13.sql")"; [[ "$got" == G4X_T13_PRECONDITION_BODY* ]] || fail "re-apply: $got"; echo "REFUSED_AS_EXPECTED $got"
world no4
for f in 001_x_oauth_personal_epoch.sql 002_x_oauth_product_wiring.sql 003_x_disconnect_user_rpc.sql; do [ "$(apply no4 "$cand/$f")" = applied ] || fail "no4 $f"; done
got="$(apply no4 "$cand/005_x_connect_lifecycle_t13.sql")"; [[ "$got" == G4X_T13_PRECONDITION_BODY* ]] || fail "without 004: $got"; echo "REFUSED_AS_EXPECTED $got"
FNS7="public.begin_social_mobile_x_oauth_connection(text,text,timestamptz) public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text) public.consume_social_mobile_x_oauth_state(text) private.account_lifecycle_assert_active_service_write(uuid,text) private.postona_personal_session() private.postona_personal_workspace_eligibility(uuid) private.account_lifecycle_brand_owner_epoch(text)"
# a stack owned by a superuser (all seven functions): the rolsuper rule refuses
superworld() {
  local fn
  world "$1"; x4 "$1"
  for fn in $FNS7; do "${S[@]}" -d "${prefix}_$1" -c "alter function $fn owner to $super" >/dev/null; done
}
superworld su
got="$(apply su "$cand/005_x_connect_lifecycle_t13.sql" "$super")"; [[ "$got" == G4X_T13_PRECONDITION_OWNER* ]] || fail "superuser-owned stack: $got"; echo "REFUSED_AS_EXPECTED $got (superuser-owned stack)"
# begin alone owned by another role than T13's: the one-owner rule refuses
world mix; x4 mix
"${S[@]}" -d "${prefix}_mix" -c "alter function public.begin_social_mobile_x_oauth_connection(text,text,timestamptz) owner to $super" >/dev/null
got="$(apply mix "$cand/005_x_connect_lifecycle_t13.sql" "$super")"; [[ "$got" == G4X_T13_PRECONDITION_OWNER* ]] || fail "mixed owners: $got"; echo "REFUSED_AS_EXPECTED $got (begin owned by another role)"
echo "== 4. rollback of 005"
got="$(apply rv "$cand/005_x_connect_lifecycle_t13_rollback.sql")"; [[ "$got" == G4X_T13_ROLLBACK_NOT_APPLIED* ]] || fail "rollback not applied: $got"; echo "REFUSED_AS_EXPECTED $got"
# while 005 is installed, 004's / 002's rollbacks refuse (005 first)
got="$(apply t13 "$cand/004_x_consume_preexchange_recheck_rollback.sql")"; [[ "$got" == G4X_CONSUME_ROLLBACK_NOT_APPLIED* ]] || fail "004 rollback under 005: $got"; echo "REFUSED_AS_EXPECTED $got (004 rollback under 005)"
got="$(apply t13 "$cand/002_x_oauth_product_wiring_rollback.sql")"; [[ "$got" == G4X_WIRING_ROLLBACK_BODY_UNEXPECTED* ]] || fail "002 rollback under 005: $got"; echo "REFUSED_AS_EXPECTED $got (002 rollback under 005)"
world rb; x4 rb
[ "$(apply rb "$cand/005_x_connect_lifecycle_t13.sql")" = applied ] || fail "rb 005"
[ "$(apply rb "$cand/005_x_connect_lifecycle_t13_rollback.sql")" = applied ] || fail "rollback: $(apply rb "$cand/005_x_connect_lifecycle_t13_rollback.sql")"
people rb; run_cases rb rv
echo "== 5. mutants of 005"
survived=0
mutant() { # <name> <perl substitution>
  local f="$work/mut_$1.sql" w="m$(printf '%s' "$1" | md5 -q | cut -c1-6)" out
  perl -0pe "$2" "$cand/005_x_connect_lifecycle_t13.sql" > "$f"
  cmp -s "$f" "$cand/005_x_connect_lifecycle_t13.sql" && fail "mutant $1 did not change 005"
  perl -0pi -e "s/raise exception 'G4X_T13_POSTCONDITION_BODY';/null;/" "$f"
  world "$w"; x4 "$w"
  local got; got="$(apply "$w" "$f")"; [ "$got" = applied ] || { echo "MUTANT_INSTALL_REFUSED $1: $got"; survived=$((survived + 1)); return; }
  people "$w"
  if out="$(run_cases "$w" t13 2>&1)"; then echo "MUTANT_SURVIVED $1"; survived=$((survived + 1)); else echo "MUTANT_CAUGHT $1 by: $(grep -m1 '^FAIL' <<<"$out" | cut -c1-90)"; fi
}
mutant t13_not_in_begin "s/(create or replace function public.begin_social_mobile_x_oauth_connection\(.*?\nbegin\n)  perform private.account_lifecycle_assert_active_service_write[^\n]*\n/\$1/s"
mutant t13_not_in_consume "s/(create or replace function public.consume_social_mobile_x_oauth_state\(.*?\nbegin\n)  perform private.account_lifecycle_assert_active_service_write[^\n]*\n/\$1/s"
mutant t13_not_in_complete "s/(create or replace function public.complete_social_mobile_x_oauth_connection\(.*?\nbegin\n)  perform private.account_lifecycle_assert_active_service_write[^\n]*\n/\$1/s"
# the precondition mutant is judged by its install on the superuser-owned stack
f="$work/mut_superuser.sql"
perl -0pe "s/  if \(select r.rolsuper from pg_roles r where r.oid = v_owner\) then\n    raise exception 'G4X_T13_PRECONDITION_OWNER';\n  end if;\n//" \
  "$cand/005_x_connect_lifecycle_t13.sql" > "$f"
cmp -s "$f" "$cand/005_x_connect_lifecycle_t13.sql" && fail "mutant superuser_owner_allowed did not change 005"
perl -0pi -e "s/raise exception 'G4X_T13_POSTCONDITION_BODY';/null;/" "$f"
superworld msu
got="$(apply msu "$f" "$super")"; echo "superuser mutant install: $got"; if [ "$got" = applied ]; then
  echo "MUTANT_CAUGHT superuser_owner_allowed by: it installs on a superuser-owned stack (the real file refuses there)"
else
  echo "MUTANT_SURVIVED superuser_owner_allowed"; survived=$((survived + 1))
fi
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"
echo "G4X_T13_ALL_PASS"
