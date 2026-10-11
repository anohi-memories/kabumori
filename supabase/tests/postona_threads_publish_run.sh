#!/usr/bin/env bash
# Disposable-only proof runner for the POSTONA Threads manual publish SQL candidate
# (supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql).
#
# On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner, it builds a
# production-shaped database from the existing publish-permission fixture and the REAL unmodified X /
# deletion migrations, applies the REAL Phase 2a-2 migration (20261007150000) and then:
#   1. preconditions: the candidate refuses without 2a-2 (PRECONDITION_2A2), without the G5 fence
#      (PRECONDITION_T13) and without the credential expiry reader (PRECONDITION_CREDENTIAL_EXPIRY),
#      changing nothing;
#   2. applies the candidate over the proof fixture (a contract stand-in for the G5 fence, fake
#      Threads accounts), refuses a second apply (ALREADY_APPLIED) and runs the behavior proof
#      (postona_threads_publish_behavior.sql);
#   3. a race: two callers of the same workspace begin with different keys at the same time (a test-only
#      trigger holds the first insert open); exactly one attempt is reserved;
#   4. mutations: copies of the candidate with one safety property removed must FAIL the proof
#      (fence disabled, permission or expiry not re-checked at redeem, no compare-and-set on claim, no
#      one-open index, redeem granted to authenticated).
# Fake data only; every database and role it creates is dropped. Never production.
#
# Usage: THREADS_PGHOST=/private/tmp/<socket-dir> THREADS_PGPORT=<port> THREADS_PGSUPER=<local superuser> \
#        supabase/tests/postona_threads_publish_run.sh
# The server must answer in English (lc_messages=C).
set -euo pipefail
export LC_ALL=C

host="${THREADS_PGHOST:?THREADS_PGHOST (local socket dir) required}"
port="${THREADS_PGPORT:?THREADS_PGPORT required}"
super="${THREADS_PGSUPER:?THREADS_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: THREADS_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="$here/../candidates/postona_threads_publish/threads_manual_publish_candidate.sql"
psql_bin="${PSQL:-psql}"
n="$$"
owner="kb_threads_pub_owner_$n"
prefix="kabumori_threads_pub_${n}"

as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-threads-pub.XXXXXX)"
fail() { echo "FAIL $*" >&2; exit 1; }

cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%' order by datname" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $owner" > /dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb nocreaterole;
grant anon, authenticated, service_role to $owner;
SQL
[[ "$("${as_super[@]}" -d postgres -c "select pg_has_role('anon', 'service_role', 'member') or pg_has_role('authenticated', 'service_role', 'member') or pg_has_role('anon', 'authenticated', 'member')")" == f ]] \
  || fail "the cluster's app roles already reach each other"

as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
create_db() { "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null; }
copy() { local db="${prefix}_$1"; create_db "$db" "$2"; echo "$db"; }
apply() {
  local db="$1" file="$2" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$file" 2>&1)"; then
    echo applied
  else
    sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1
  fi
}
objects() {
  "${as_super[@]}" -d "$1" -c "select (select count(*) from pg_class where relname in ('threads_manual_publish_attempts', 'social_account_manual_publish_permissions'))
                                    + (select count(*) from pg_proc where proname like '%threads_manual_publish%')"
}

# ---- Databases -------------------------------------------------------------------------------------------
pre2a2="${prefix}_pre2a2"
create_db "$pre2a2"
as_owner "$pre2a2" -f "$here/social_mobile_publish_permission_fixture.sql" > /dev/null
for real in \
  20260919120000_social_mobile_x_oauth_onboarding.sql \
  20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql \
  20260925140000_x_account_credential_refresh_core.sql \
  20260926032054_x_account_refresh_rollout_authority.sql \
  20260928160000_social_mobile_account_deletion_candidate.sql \
  20261003090000_social_mobile_publish_permission_boundary.sql; do
  as_owner "$pre2a2" -f "$migrations/$real" > /dev/null
done
as_owner "$pre2a2" -f "$here/postona_social_accounts_multi_provider_fixture.sql" > /dev/null

# 1a. Without Phase 2a-2 the candidate refuses and creates nothing.
db="$(copy no2a2 "$pre2a2")"
got="$(apply "$db" "$candidate")"
[[ "$got" == THREADS_PUBLISH_PRECONDITION_2A2 ]] || fail "without 2a-2: got ${got}"
[[ "$(objects "$db")" == 0 ]] || fail "without 2a-2: objects created"

with2a2="${prefix}_with2a2"
create_db "$with2a2" "$pre2a2"
as_owner "$with2a2" -f "$migrations/20261007150000_postona_social_accounts_multi_provider.sql" > /dev/null

# 1b. Without the G5 fence the candidate refuses and creates nothing.
db="$(copy not13 "$with2a2")"
got="$(apply "$db" "$candidate")"
[[ "$got" == THREADS_PUBLISH_PRECONDITION_T13 ]] || fail "without the G5 fence: got ${got}"
[[ "$(objects "$db")" == 0 ]] || fail "without the G5 fence: objects created"

template="${prefix}_tpl"
create_db "$template" "$with2a2"
as_owner "$template" -f "$here/postona_threads_publish_fixture.sql" > /dev/null

# 1c. A fence executable by an app role is refused too.
db="$(copy t13open "$template")"
"${as_super[@]}" -d "$db" -c "grant usage on schema private to authenticated; grant execute on function private.account_lifecycle_assert_active_service_write(uuid, text) to authenticated" > /dev/null
got="$(apply "$db" "$candidate")"
[[ "$got" == THREADS_PUBLISH_PRECONDITION_T13 ]] || fail "app-executable fence: got ${got}"
# 1d. Without the credential custody owner's expiry reader the candidate refuses too.
db="$(copy noexpiry "$template")"
"${as_super[@]}" -d "$db" -c "drop function public.threads_account_credential_expires_at(text)" > /dev/null
got="$(apply "$db" "$candidate")"
[[ "$got" == THREADS_PUBLISH_PRECONDITION_CREDENTIAL_EXPIRY ]] || fail "without the expiry reader: got ${got}"
[[ "$(objects "$db")" == 0 ]] || fail "without the expiry reader: objects created"
echo "PASS preconditions (2a-2, G5 fence missing, G5 fence reachable, credential expiry reader missing)"

# ---- 2. Apply + behavior -----------------------------------------------------------------------------------
# Runs the whole proof against one candidate file; prints PASS or the first failure.
prove() {
  local file="$1" tag="$2" db got out
  db="$(copy "main_$tag" "$template")"
  got="$(apply "$db" "$file")"
  [[ "$got" == applied ]] || { echo "APPLY_REFUSED $got"; return 0; }
  got="$(apply "$db" "$file")"
  [[ "$got" == THREADS_PUBLISH_PRECONDITION_ALREADY_APPLIED ]] || { echo "REAPPLY $got"; return 0; }
  if ! out="$(as_owner "$db" -A -t -f "$here/postona_threads_publish_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
    return 0
  fi
  grep -q BEHAVIOR_OK <<<"$out" || { echo "BEHAVIOR_INCOMPLETE"; return 0; }
  # ---- 3. Race: two callers, different keys, the first insert held open ------------------------
  db="$(copy "race_$tag" "$template")"
  [[ "$(apply "$db" "$file")" == applied ]] || { echo "RACE_APPLY"; return 0; }
  as_owner "$db" > /dev/null <<'SQL'
do $$
declare brand text;
begin
  brand := public.fixture_brand('00000000-0000-4000-8000-0000000000a1', 'ra');
  perform public.fixture_member(brand, '00000000-0000-4000-8000-0000000000d1', 'admin');
  perform postona_threads_proof.threads_account(brand, 'ra');
  insert into postona_threads_proof.lifecycle values ('00000000-0000-4000-8000-0000000000a1', 'active'), ('00000000-0000-4000-8000-0000000000d1', 'active');
  perform postona_threads_proof.as_user('00000000-0000-4000-8000-0000000000a1', 'permission', 'sa_th_ra', 'true', 'false');
end $$;
create table postona_threads_proof.race_hold (on_text text primary key);
insert into postona_threads_proof.race_hold values ('race A');
create function postona_threads_proof.race_sleep() returns trigger language plpgsql as $$
begin
  if exists (select 1 from postona_threads_proof.race_hold h where h.on_text = new.post_text) then perform pg_sleep(2); end if;
  return new;
end $$;
create trigger aa_race_sleep before insert on public.threads_manual_publish_attempts for each row execute function postona_threads_proof.race_sleep();
SQL
  local r1="$tmp/race1_$tag" r2="$tmp/race2_$tag"
  ( as_owner "$db" -A -t -c "select postona_threads_proof.as_user('00000000-0000-4000-8000-0000000000a1', 'begin', 'sa_th_ra', '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a', 'race A')" > "$r1" 2>&1 ) &
  local p1=$!
  sleep 0.5
  ( as_owner "$db" -A -t -c "select postona_threads_proof.as_user('00000000-0000-4000-8000-0000000000d1', 'begin', 'sa_th_ra', '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b', 'race B')" > "$r2" 2>&1 ) &
  local p2=$!
  wait "$p1" "$p2" || true
  local reserved
  reserved="$("${as_super[@]}" -d "$db" -c "select count(*) from public.threads_manual_publish_attempts where status = 'reserved'")"
  [[ "$reserved" == 1 ]] || { echo "RACE reserved=$reserved ($(cat "$r1") / $(cat "$r2"))"; return 0; }
  # B passes the open-attempt check while A is held inside its insert; only the unique index decides.
  [[ "$(cat "$r1" "$r2" | grep -c '"reserved"')" == 1 && "$(cat "$r1" "$r2" | grep -Ec 'PUBLISH_IN_PROGRESS|BUSY')" == 1 ]] \
    || { echo "RACE answers: $(cat "$r1") / $(cat "$r2")"; return 0; }
  echo PASS
}

result="$(prove "$candidate" real)"
[[ "$result" == PASS ]] || fail "candidate: $result"
echo "PASS candidate: apply, re-apply refused, behavior, race"

# ---- 4. Mutations: each must be caught ---------------------------------------------------------------------
mutate() {
  local tag="$1" from="$2" to="$3" out="$tmp/mut_$1.sql"
  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$candidate" > "$out"
  cmp -s "$candidate" "$out" && fail "mutation $tag: pattern not found"
  local r
  r="$(prove "$out" "$tag")"
  [[ "$r" != PASS ]] || fail "mutation $tag was NOT caught"
  echo "PASS mutation $tag caught ($r)"
}
mutate fence_disabled \
  "    perform private.account_lifecycle_assert_active_service_write(p_user, 'x_autopost');" \
  "    null;"
mutate redeem_skips_permission \
  "    when p_step in ('create_container', 'check_container', 'publish') and not exists (" \
  "    when false and not exists ("
mutate redeem_skips_expiry \
  "    when coalesce(public.threads_account_credential_expires_at(v_account.id), '-infinity') <= pg_catalog.clock_timestamp() + interval '5 minutes'" \
  "    when false"
mutate claim_no_compare_and_set \
  "  if v_row.status is distinct from v_from then return public.threads_manual_publish_refused('STALE_STEP'); end if;" \
  ""
mutate no_one_open_index \
  "create unique index threads_manual_publish_one_open_per_account" \
  "create index threads_manual_publish_one_open_per_account"
mutate redeem_for_authenticated \
  "to service_role;
" \
  "to service_role, authenticated;
"
echo "ALL PASS"
