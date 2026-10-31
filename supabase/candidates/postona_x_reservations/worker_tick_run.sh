#!/usr/bin/env bash
# G3-02 #11 (H4-17): SQL 016 (worker tick) on a disposable LOCAL PostgreSQL with fake pg_net / Vault / pg_cron catalogs
# (worker_tick/catalogs.sql: the queue readable by PUBLIC, as H4-17 measured). Never a remote project; no network.
#   B   before: the 016 of PR #609 (ee8eeaee, git show) -- H4-17's P1 (the key in the queue), P2 (another project's URL) and P2 (an alias
#       job left calling a dropped tick) reproduced, printed as measured;
#   T1-T6  the repaired 016 (behavior.sql); BUSY (a second session holds the tick lock);
#   R   rollback: refused while any visible job calls the tick (canonical, alias, quoted / cased / schema-qualified), while a wrapper
#       function names it, and while the job list is unreadable; nothing dropped on a refusal; then clean.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> worker_tick_run.sh
#        WORKER_TICK_CANDIDATE=<file> runs a modified 016 (mutation tests).
set -euo pipefail
host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
export LC_ALL=C PGTZ=UTC
here="$(cd "$(dirname "$0")" && pwd)"
candidate="${WORKER_TICK_CANDIDATE:-$here/016_postona_x_resv_worker_tick.sql}"
rollback="${WORKER_TICK_ROLLBACK:-$here/016_postona_x_resv_worker_tick_rollback.sql}"
owner="kb_g3_tick_owner"
prefix="kabumori_g3_tick_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-g3-tick.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  local db
  for db in $("${S[@]}" -A -t -d postgres -c "select datname from pg_database where datname like '${prefix}\_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'postona_resv_api') then create role postona_resv_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'postona_resv_worker') then create role postona_resv_worker nologin; end if;
end \$\$;
grant postona_resv_api, postona_resv_worker to $owner with inherit false, set true;
SQL

new_world() {  # $1 = db suffix: fake catalogs (superuser), then G3's schema with inert 001-015 signatures (owner)
  local db="${prefix}_$1"
  "${S[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  "${S[@]}" -d "$db" -f "$here/worker_tick/catalogs.sql" >/dev/null
  "${S[@]}" -d "$db" -c "grant usage on schema vault, extensions to $owner" -c "grant select on vault.decrypted_secrets to $owner" -c "grant insert, update, delete, select on vault.secrets to $owner" \
    -c "grant insert, select on net._http_response to $owner" >/dev/null
  psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" >/dev/null <<'SQL'
create schema postona_x_resv;
grant usage on schema postona_x_resv to postona_resv_api, postona_resv_worker;
-- inert stand-ins with 004 / 015's signatures (016's precondition only; never called here)
create function postona_x_resv.claim_due(text, integer, integer) returns void language sql as $$ select $$;
create function postona_x_resv.pre_publish_check_bound(uuid, uuid) returns void language sql as $$ select $$;
SQL
  echo "$db"
}
own() { local db="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
val() { local db="$1"; shift; own "$db" -A -t "$@"; }
KEY="g3-fake-worker-secret-0123456789abcdef-0123456789"
ALIAS="select POSTONA_X_RESV.\"tick_delivery_worker\"()"

# ---- B: before (PR #609's 016) -----------------------------------------------------------------------------------------------------
git -C "$here" show ee8eeaeec53391a587b3a908837198e54551f335:supabase/candidates/postona_x_reservations/016_postona_x_resv_worker_tick.sql > "$tmp/old016.sql"
git -C "$here" show ee8eeaeec53391a587b3a908837198e54551f335:supabase/candidates/postona_x_reservations/016_postona_x_resv_worker_tick_rollback.sql > "$tmp/old016r.sql"
old="$(new_world old)"
own "$old" -f "$tmp/old016.sql" >/dev/null
own "$old" -v k="$KEY" >/dev/null <<'SQL'
insert into vault.secrets values ('postona_resv_worker_secret', :'k'), ('postona_resv_worker_url', 'https://otherprojectref00001.supabase.co/functions/v1/postona-x-reservation-worker');
select postona_x_resv.tick_delivery_worker();
SQL
p1="$(val "$old" -v k="$KEY" <<'SQL'
set role postona_resv_api;
select exists (select 1 from net.http_request_queue q where position(:'k' in q.headers::text) > 0);
SQL
)"
p2="$(val "$old" -c "select exists (select 1 from net.http_request_queue q where q.url like 'https://otherprojectref00001.%')")"
own "$old" -f "$here/016_postona_x_resv_worker_tick_schedule.sql" >/dev/null
own "$old" -c "select cron.schedule('nightly-other-name', '*/5 * * * *', '$ALIAS')" >/dev/null
own "$old" -f "$here/016_postona_x_resv_worker_tick_schedule_rollback.sql" >/dev/null
if own "$old" -f "$tmp/old016r.sql" >/dev/null 2>&1; then p3="$(val "$old" -c "select exists (select 1 from cron.job where jobname = 'nightly-other-name') and to_regprocedure('postona_x_resv.tick_delivery_worker()') is null")"; else p3=f; fi
echo "B_BEFORE_PR609 P1_key_readable_in_queue_by_api_role=$p1 P2_other_project_url_called=$p2 P2_alias_job_left_after_rollback=$p3"
if [[ -z "${WORKER_TICK_CANDIDATE:-}${WORKER_TICK_ROLLBACK:-}" ]]; then
  [[ "$p1/$p2/$p3" == "t/t/t" ]] || fail "the H4-17 counterexamples did not reproduce on PR #609's 016 ($p1/$p2/$p3)"
fi

# ---- T: the repaired 016 -------------------------------------------------------------------------------------------------------------
db="$(new_world new)"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/re" 2>&1; then fail "016 re-applied"; fi
grep -q POSTONA_X_WORKER_TICK_ALREADY_APPLIED "$tmp/re" || fail "re-apply: $(tail -1 "$tmp/re")"
own "$db" -f "$here/worker_tick/behavior.sql" >"$tmp/b" 2>&1 || { cat "$tmp/b"; fail "behaviour"; }
for marker in T1_NOT_CONFIGURED_PASS T2_TARGET_PINNED_PASS T3_NO_KEY_IN_QUEUE_PASS T4_ONE_USE_PASS T5_IN_FLIGHT_PASS T6_PRIVILEGES_PASS; do
  grep -q "$marker" "$tmp/b" || { cat "$tmp/b"; fail "missing $marker"; }
  echo "$marker"
done
# BUSY: a second session holds the tick lock
own "$db" -c "insert into net._http_response (id, status_code) select request_id, 200 from postona_x_resv.worker_ticks where outcome = 'INVOKED' and request_id not in (select id from net._http_response)" >/dev/null
own "$db" -c "begin; select pg_advisory_xact_lock(hashtextextended('postona_x_resv:worker_tick', 0)); select pg_sleep(3); commit;" >/dev/null &
holder=$!
sleep 1
[[ "$(val "$db" -c "select postona_x_resv.tick_delivery_worker()")" == TICK_BUSY ]] || fail "a held lock did not answer TICK_BUSY"
wait "$holder"
echo "BUSY_TICK_LOCK_PASS"

# ---- R: rollback (H4-17 P2 alias) ----------------------------------------------------------------------------------------------------
fns() { val "$db" -c "select count(*) from pg_proc where pronamespace = 'postona_x_resv'::regnamespace and proname in ('worker_url', 'tick_delivery_worker', 'worker_tick_health', 'consume_worker_tick')"; }
refused() {  # <code>: the rollback refuses with it and drops nothing
  if own "$db" -f "$rollback" >"$tmp/r" 2>&1; then fail "rollback ran ($1)"; fi
  grep -q "$1" "$tmp/r" || fail "rollback: expected $1, got $(tail -1 "$tmp/r")"
  [[ "$(fns)" == 4 ]] || fail "rollback dropped something ($1)"
}
own "$db" -f "$here/016_postona_x_resv_worker_tick_schedule.sql" >/dev/null
refused "SCHEDULE_PRESENT: postona-x-reservation-worker-tick"
for alias in "$ALIAS" "SELECT postona_x_resv.TICK_DELIVERY_WORKER();" "select tick_delivery_worker()"; do
  own "$db" -c "select cron.schedule('nightly-other-name', '*/5 * * * *', \$q\$$alias\$q\$)" >/dev/null
  own "$db" -f "$here/016_postona_x_resv_worker_tick_schedule_rollback.sql" >/dev/null 2>&1 || true   # removes only the canonical job, if any
  refused "SCHEDULE_PRESENT: nightly-other-name"
  [[ "$(val "$db" -c "select count(*) from cron.job where jobname = 'nightly-other-name'")" == 1 ]] || fail "the alias job was touched"
  own "$db" -c "select cron.unschedule('nightly-other-name')" >/dev/null   # the operator removes it knowingly
done
own "$db" -c "create function public.g3_tick_wrapper() returns text language sql as 'select postona_x_resv.tick_delivery_worker()'" >/dev/null
refused "TICK_REFERENCED: g3_tick_wrapper()"
own "$db" -c "drop function public.g3_tick_wrapper()" >/dev/null
"${S[@]}" -d "$db" -c "revoke select on cron.job from public" >/dev/null
refused CRON_CATALOG_UNREADABLE
"${S[@]}" -d "$db" -c "grant select on cron.job to public" >/dev/null
own "$db" -f "$rollback" >/dev/null || fail "clean rollback"
[[ "$(val "$db" -c "select to_regclass('postona_x_resv.worker_ticks') is null and to_regclass('postona_x_resv.worker_target') is null and (select count(*) from pg_proc where pronamespace = 'postona_x_resv'::regnamespace) = 2")" == t ]] || fail "016 left behind"
own "$db" -f "$candidate" >/dev/null || fail "re-apply after rollback"
echo "R_ROLLBACK_ALIAS_WRAPPER_CATALOG_REFUSED_THEN_CLEAN_PASS"
echo "G3_WORKER_TICK_ALL_PASS"
