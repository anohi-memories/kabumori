#!/usr/bin/env bash
# Disposable-only proof runner for the G4 POSTONA Threads publish stack:
#   supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql
#   supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql   (PR #140, unchanged)
#   supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql  (fixes the K4 P1)
#
# On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner, it builds the
# publish-permission world from the existing fixture and the REAL X / deletion migrations, applies the
# REAL Phase 2a-2 migration, pgcrypto (schema extensions, as Supabase) and the proof fixture
# (postona_threads_release_fixture.sql: a contract stand-in for the G5 fence, auth.sessions, named Vault
# secrets), then:
#   1. preconditions: release refuses without the publish candidate, without pgcrypto and without
#      auth.sessions; the custody candidate refuses a second apply;
#   2. applies the stack and runs postona_threads_release_behavior.sql;
#   3. races: the owner and an admin release `publish` for the same attempt at the same time (a test-only
#      trigger holds the first inside its release); exactly one is released. And the session race (C3 R1),
#      two real connections ordered by observed lock waits: release first => a concurrent expiry UPDATE
#      cannot commit until the release has committed; expiry in flight first => the release waits for it
#      and then refuses with no credential;
#   4. mutations: copies with one safety property removed must FAIL.
# Fake data only; every database and role it creates is dropped. Never production.
#
# Usage: THREADS_PGHOST=/private/tmp/<socket-dir> THREADS_PGPORT=<port> THREADS_PGSUPER=<local superuser> \
#        supabase/tests/postona_threads_release_run.sh
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
cands="$here/../candidates/postona_threads_publish"
custody="$cands/threads_credential_custody_candidate.sql"
publish="$cands/threads_manual_publish_candidate.sql"
release="$cands/threads_publish_release_candidate.sql"
psql_bin="${PSQL:-psql}"
n="$$"
owner="kb_threads_rel_owner_$n"
prefix="kabumori_threads_rel_${n}"

as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-threads-rel.XXXXXX)"
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

# ---- World ----------------------------------------------------------------------------------------------
world="${prefix}_world"
create_db "$world"
as_owner "$world" -f "$here/social_mobile_publish_permission_fixture.sql" > /dev/null
for real in \
  20260919120000_social_mobile_x_oauth_onboarding.sql \
  20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql \
  20260925140000_x_account_credential_refresh_core.sql \
  20260926032054_x_account_refresh_rollout_authority.sql \
  20260928160000_social_mobile_account_deletion_candidate.sql \
  20261003090000_social_mobile_publish_permission_boundary.sql; do
  as_owner "$world" -f "$migrations/$real" > /dev/null
done
as_owner "$world" -f "$here/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
as_owner "$world" -f "$migrations/20261007150000_postona_social_accounts_multi_provider.sql" > /dev/null
as_owner "$world" -f "$here/postona_threads_release_fixture.sql" > /dev/null

base="${prefix}_base"
create_db "$base" "$world"
"${as_super[@]}" -d "$base" -c "create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions" > /dev/null

# ---- 1. Preconditions -------------------------------------------------------------------------------------
db="$(copy nopub "$base")"
[[ "$(apply "$db" "$custody")" == applied ]] || fail "custody on the base"
[[ "$(apply "$db" "$custody")" == THREADS_CUSTODY_PRECONDITION_ALREADY_APPLIED ]] || fail "custody re-apply"
got="$(apply "$db" "$release")"
[[ "$got" == THREADS_RELEASE_PRECONDITION_PUBLISH_CANDIDATE ]] || fail "release without the publish candidate: $got"
db="$(copy nopgcrypto "$world")"
[[ "$(apply "$db" "$custody")" == applied && "$(apply "$db" "$publish")" == applied ]] || fail "stack without pgcrypto"
got="$(apply "$db" "$release")"
[[ "$got" == THREADS_RELEASE_PRECONDITION_PGCRYPTO ]] || fail "release without pgcrypto: $got"
db="$(copy nosessions "$base")"
"${as_super[@]}" -d "$db" -c "drop table auth.sessions" > /dev/null
[[ "$(apply "$db" "$custody")" == applied && "$(apply "$db" "$publish")" == applied ]] || fail "stack without sessions"
got="$(apply "$db" "$release")"
[[ "$got" == THREADS_RELEASE_PRECONDITION_AUTH_SESSIONS ]] || fail "release without auth.sessions: $got"
echo "PASS preconditions (publish candidate, pgcrypto, auth.sessions, custody re-apply)"

# ---- Session race (C3 R1): two real connections, ordered by observed lock waits, not by sleeps -----------
as_owner_app() { local app="$1" db="$2"; shift 2; PGAPPNAME="$app" "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
# Polls (up to ~10 s) until the SQL condition, evaluated by the superuser, is true.
wait_for() {
  local db="$1" cond="$2" i
  for i in $(seq 1 200); do
    [[ "$("${as_super[@]}" -d "$db" -c "select ($cond)")" == t ]] && return 0
    sleep 0.05
  done
  return 1
}
A_USER=00000000-0000-4000-8000-0000000000a1
# Prints PASS or the first failed expectation.
session_race() {
  local c="$1" p="$2" r="$3" tag="$4" db
  db="$(copy "sess_$tag" "$base")"
  for f in "$c" "$p" "$r"; do [[ "$(apply "$db" "$f")" == applied ]] || { echo "SESSION_APPLY"; return 0; }; done
  as_owner "$db" > /dev/null <<'SQL'
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; brand text; acct text; att text;
begin
  brand := public.fixture_brand(a, 'sr');
  perform postona_rel.login(a);
  insert into postona_rel.lifecycle (user_id, state) values (a, 'active');
  acct := postona_rel.connect_threads(a, brand, 'sr');
  perform postona_rel.as_user(a, 'permission', acct, 'true', 'false');
  att := postona_rel.as_user(a, 'begin', acct, '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c', 'session race')->'attempt'->>'attempt_id';
  create table postona_rel.sess (attempt uuid);
  insert into postona_rel.sess values (att::uuid);
end $$;
create table postona_rel.go (step int);
create table postona_rel.barrier_on (on_ boolean);
-- Test-only barrier inside release, AFTER its session check (the nonce insert comes later): it waits for
-- advisory lock 4242 while the controller connection holds it.
create function postona_rel.barrier() returns trigger language plpgsql as $$
begin
  if exists (select 1 from postona_rel.barrier_on) then perform pg_advisory_xact_lock(4242); end if;
  return new;
end $$;
create trigger aa_barrier before insert on public.threads_manual_publish_nonces for each row execute function postona_rel.barrier();
SQL
  local release_sql="select postona_rel.release('$A_USER', (select attempt from postona_rel.sess), 'create_container')"
  local expire_sql="update auth.sessions set not_after = clock_timestamp() - interval '1 second' where user_id = '$A_USER'"
  local wait_go1="do \$\$ declare i int := 0; begin while not exists (select 1 from postona_rel.go where step = 1) and i < 400 loop perform pg_sleep(0.05); i := i + 1; end loop; end \$\$"
  local wait_go2="do \$\$ declare i int := 0; begin while not exists (select 1 from postona_rel.go where step = 2) and i < 400 loop perform pg_sleep(0.05); i := i + 1; end loop; end \$\$"
  local ra="$tmp/sessA_$tag" rb="$tmp/sessB_$tag" ra2="$tmp/sessA2_$tag" rb2="$tmp/sessB2_$tag" pa pc pb verdict=PASS
  finish() { as_owner "$db" -c "insert into postona_rel.go values (1), (2)" > /dev/null 2>&1 || true; wait "$@" 2>/dev/null || true; }

  # Case 1: release first. It holds the session row lock (barrier keeps it inside the transaction); an
  # expiry UPDATE with a 1 s lock timeout must NOT commit; the release then commits with the credential;
  # only afterwards can the expiry commit, and the next release is refused.
  as_owner "$db" -c "insert into postona_rel.barrier_on values (true)" > /dev/null
  as_owner_app g4_race_C "$db" -A -t -c "select pg_advisory_lock(4242)" -c "$wait_go1" -c "select pg_advisory_unlock(4242)" > /dev/null 2>&1 &
  pc=$!
  wait_for "$db" "exists (select 1 from pg_locks l join pg_stat_activity s using (pid) where s.application_name = 'g4_race_C' and l.locktype = 'advisory' and l.granted)" \
    || { finish "$pc"; echo "SESSION_C_NOT_READY"; return 0; }
  as_owner_app g4_race_A "$db" -A -t -c "$release_sql" > "$ra" 2>&1 &
  pa=$!
  wait_for "$db" "exists (select 1 from pg_stat_activity where application_name = 'g4_race_A' and wait_event_type = 'Lock' and wait_event = 'advisory')" \
    || { finish "$pa" "$pc"; echo "SESSION_A_NOT_AT_BARRIER"; return 0; }
  if as_owner "$db" -c "set lock_timeout = '1s'" -c "$expire_sql" > "$rb" 2>&1; then
    verdict="SESSION_CASE1 expiry committed while the release held the session"
  elif ! grep -q 'lock timeout' "$rb"; then
    verdict="SESSION_CASE1 expiry failed for another reason: $(head -c 120 "$rb")"
  fi
  as_owner "$db" -c "insert into postona_rel.go values (1)" > /dev/null
  wait "$pa" "$pc" || true
  [[ "$verdict" == PASS ]] || { finish; echo "$verdict"; return 0; }
  grep -q '"status": "released"' "$ra" || { finish; echo "SESSION_CASE1 release: $(head -c 160 "$ra")"; return 0; }
  as_owner "$db" -c "$expire_sql" > /dev/null || { finish; echo "SESSION_CASE1 expiry after commit"; return 0; }
  as_owner "$db" -c "delete from postona_rel.barrier_on" > /dev/null
  local after
  after="$(as_owner "$db" -A -t -c "$release_sql")"
  [[ "$after" == *AUTH_REQUIRED* && "$after" != *access_token* ]] || { finish; echo "SESSION_CASE1 next release: ${after:0:160}"; return 0; }

  # Case 2: expiry first, still in flight. The release must wait for it and then, on the committed row,
  # refuse (AUTH_REQUIRED) without the credential.
  as_owner "$db" -c "update auth.sessions set not_after = null where user_id = '$A_USER'" \
    -c "update public.threads_manual_publish_attempts set status = 'reserved', grant_hash = null, grant_step = null, grant_state = null, grant_expires_at = null, grant_user_id = null, grant_session_id = null" > /dev/null
  as_owner_app g4_race_B "$db" -A -t -c "begin" -c "$expire_sql" -c "$wait_go2" -c "commit" > "$rb2" 2>&1 &
  pb=$!
  wait_for "$db" "exists (select 1 from pg_locks l join pg_stat_activity s using (pid) where s.application_name = 'g4_race_B' and l.locktype = 'transactionid' and l.granted)" \
    || { finish "$pb"; echo "SESSION_B_NOT_READY"; return 0; }
  as_owner_app g4_race_A "$db" -A -t -c "$release_sql" > "$ra2" 2>&1 &
  pa=$!
  if ! wait_for "$db" "exists (select 1 from pg_stat_activity where application_name = 'g4_race_A' and wait_event_type = 'Lock')"; then
    verdict="SESSION_CASE2 the release did not wait for the in-flight expiry: $(head -c 120 "$ra2")"
  fi
  as_owner "$db" -c "insert into postona_rel.go values (2)" > /dev/null
  wait "$pa" "$pb" || true
  [[ "$verdict" == PASS ]] || { finish; echo "$verdict"; return 0; }
  grep -q AUTH_REQUIRED "$ra2" && ! grep -q access_token "$ra2" || { finish; echo "SESSION_CASE2 release: $(head -c 160 "$ra2")"; return 0; }
  echo PASS
}

# ---- 2-3. The stack, its behavior, the races ------------------------------------------------------------
prove() {
  local c="$1" p="$2" r="$3" tag="$4" db got out
  db="$(copy "main_$tag" "$base")"
  for f in "$c" "$p" "$r"; do
    got="$(apply "$db" "$f")"
    [[ "$got" == applied ]] || { echo "APPLY_REFUSED $got"; return 0; }
  done
  [[ "$(apply "$db" "$r")" == THREADS_RELEASE_PRECONDITION_ALREADY_APPLIED ]] || { echo "REAPPLY"; return 0; }
  if ! out="$(as_owner "$db" -A -t -f "$here/postona_threads_release_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
    return 0
  fi
  grep -q RELEASE_BEHAVIOR_OK <<<"$out" || { echo "BEHAVIOR_INCOMPLETE"; return 0; }
  db="$(copy "race_$tag" "$base")"
  for f in "$c" "$p" "$r"; do [[ "$(apply "$db" "$f")" == applied ]] || { echo "RACE_APPLY"; return 0; }; done
  as_owner "$db" > /dev/null <<'SQL'
create temp table ctx as select 1;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  m uuid := '00000000-0000-4000-8000-0000000000d1';
  brand text; acct text; att text; r jsonb; g text;
begin
  brand := public.fixture_brand(a, 'ra');
  perform public.fixture_member(brand, m, 'admin');
  perform postona_rel.login(a); perform postona_rel.login(m);
  insert into postona_rel.lifecycle (user_id, state) values (a, 'active'), (m, 'active');
  acct := postona_rel.connect_threads(a, brand, 'ra');
  perform postona_rel.as_user(a, 'permission', acct, 'true', 'false');
  att := postona_rel.as_user(a, 'begin', acct, '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a', 'race')->'attempt'->>'attempt_id';
  r := postona_rel.release(a, att::uuid, 'create_container');
  g := r->>'grant';
  perform postona_rel.record(a, att::uuid, 'create_container', g, 'container_created', '17890000000000001');
  create table postona_rel.race (attempt uuid);
  insert into postona_rel.race values (att::uuid);
end $$;
-- Holds the OWNER's release inside its transaction, after every authorization check and before the
-- attempt row lock, so the admin's release runs entirely in between.
create function postona_rel.race_sleep() returns trigger language plpgsql as $$
begin
  if auth.uid() = '00000000-0000-4000-8000-0000000000a1' then perform pg_sleep(2); end if;
  return new;
end $$;
create trigger aa_race_sleep before insert on public.threads_manual_publish_nonces for each row execute function postona_rel.race_sleep();
SQL
  local r1="$tmp/race1_$tag" r2="$tmp/race2_$tag"
  ( as_owner "$db" -A -t -c "select postona_rel.release('00000000-0000-4000-8000-0000000000a1', (select attempt from postona_rel.race), 'publish')" > "$r1" 2>&1 ) &
  local p1=$!
  sleep 0.5
  ( as_owner "$db" -A -t -c "select postona_rel.release('00000000-0000-4000-8000-0000000000d1', (select attempt from postona_rel.race), 'publish')" > "$r2" 2>&1 ) &
  local p2=$!
  wait "$p1" "$p2" || true
  [[ "$(cat "$r1" "$r2" | grep -c '"status": "released"')" == 1 && "$(cat "$r1" "$r2" | grep -c 'STALE_STEP')" == 1 ]] \
    || { echo "RACE $(cut -c1-120 "$r1") / $(cut -c1-120 "$r2")"; return 0; }
  local sess
  sess="$(session_race "$c" "$p" "$r" "$tag")"
  [[ "$sess" == PASS ]] || { echo "$sess"; return 0; }
  echo PASS
}

result="$(prove "$custody" "$publish" "$release" real)"
[[ "$result" == PASS ]] || fail "stack: $result"
echo "PASS stack: apply, re-apply refused, behavior, concurrent publish release, session race (release first / expiry first)"

# ---- 4. Mutations -----------------------------------------------------------------------------------------
mutate() {
  local tag="$1" which="$2" from="$3" to="$4" out="$tmp/mut_$1.sql" c="$custody" r="$release" src
  src="$([[ "$which" == custody ]] && echo "$custody" || echo "$release")"
  FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$src" > "$out"
  cmp -s "$src" "$out" && fail "mutation $tag: pattern not found"
  if [[ "$which" == custody ]]; then c="$out"; else r="$out"; fi
  local got
  got="$(prove "$c" "$publish" "$r" "$tag")"
  [[ "$got" != PASS ]] || fail "mutation $tag was NOT caught"
  echo "PASS mutation $tag caught (${got:0:140})"
}
mutate release_no_fence release "  v_code := public.threads_manual_publish_fence(v_user);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  -- FOR SHARE, not FOR KEY SHARE" "  -- FOR SHARE, not FOR KEY SHARE"
mutate release_no_session release "  if not found then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;" ""
mutate release_no_attestation release "  if not v_valid or pg_catalog.abs(" "  if false and pg_catalog.abs("
mutate release_no_nonce release "  exception when unique_violation then
    return public.threads_manual_publish_refused('ATTESTATION_INVALID');" "  exception when unique_violation then
    null;"
mutate release_no_compare_and_set release "  if v_row.status is distinct from v_from then return public.threads_manual_publish_refused('STALE_STEP'); end if;" ""
mutate record_no_session_binding release "     or v_row.grant_user_id is distinct from v_user or v_row.grant_session_id is distinct from v_session" "     or v_row.grant_user_id is distinct from v_user"
mutate release_for_service_role release "to authenticated;

do \$\$" "to authenticated, service_role;

do \$\$"
mutate release_session_key_share_only release "   for share;
  if not found then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;" "   for key share;
  if not found then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;"
mutate custody_no_reconnect_binding custody "    and c.recorded_at >= a.verified_at" ""
echo "ALL PASS"
