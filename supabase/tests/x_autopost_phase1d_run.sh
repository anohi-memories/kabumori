#!/usr/bin/env bash
# Disposable-only Phase1D proof runner. Creates a throwaway database on a LOCAL
# Unix-socket PostgreSQL cluster, applies fixture -> Phase1B -> Phase1D as a
# non-superuser owner, runs behavior + concurrency proofs, then drops it.
# Usage: PHASE1D_PGHOST=/private/tmp/<socket-dir> PHASE1D_PGPORT=<port> \
#        PHASE1D_PGSUPER=<local superuser> supabase/tests/x_autopost_phase1d_run.sh
set -euo pipefail

host="${PHASE1D_PGHOST:?PHASE1D_PGHOST (local socket dir) required}"
port="${PHASE1D_PGPORT:?PHASE1D_PGPORT required}"
super="${PHASE1D_PGSUPER:?PHASE1D_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PHASE1D_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_phase1d_$$"
db2="kabumori_phase1d_conc_$$"
owner="kb_phase1d_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
owner_base=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner")
as_owner=("${owner_base[@]}" -d "$db")
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

cleanup() {
  for d in "$db" "$db2"; do
    "${as_super[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

"${as_super[@]}" -d postgres <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
create database $db2 owner $owner;
SQL

for d in "$db" "$db2"; do
  "${owner_base[@]}" -d "$d" -f "$here/x_autopost_phase1d_fixture.sql"
  "${owner_base[@]}" -d "$d" -f "$migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql"
  "${owner_base[@]}" -d "$d" -f "$migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql"
done
"${as_owner[@]}" -f "$here/x_autopost_phase1d_behavior.sql"

# Concurrency on a separate fresh database, after the simulated activation step.
as_owner=("${owner_base[@]}" -d "$db2")
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db2")
"${as_owner[@]}" <<'SQL'
revoke execute on function public.claim_due_post() from service_role;
set role service_role;
insert into public.scheduled_posts (brand_id, schedule_date, post_type, slot_no, scheduled_for)
values ('brand_a', current_date, 'tip', 60, now() - interval '1 hour');
select public.schedule_account_bound_post_v2('brand_a','acct_a',current_date,'tip',61::smallint,now()-interval '2 hours');
select public.schedule_account_bound_post_v2('brand_b','acct_b',current_date,'tip',62::smallint,now()-interval '2 hours');
SQL

tmp="$(mktemp -d /private/tmp/kabumori-phase1d-conc.XXXXXX)"
trap 'rm -rf "$tmp"; cleanup' EXIT
hold="begin; set role service_role;"
# Four workers race while each holds its claim transaction open for 3 seconds:
# two legacy lanes and two v2 lanes over one unbound and two bound due rows.
for i in 1 2; do
  "${as_service[@]}" -c "$hold select 'L|' || id || '|' || coalesce(social_account_id,'NULL') from public.claim_due_post_legacy_unbound_v2(); select pg_sleep(3); commit;" > "$tmp/legacy$i" &
  "${as_service[@]}" -c "$hold select 'V|' || scheduled_post_id || '|' || social_account_id from public.claim_due_post_v2(); select pg_sleep(3); commit;" > "$tmp/v2_$i" &
done
wait

claims="$(cat "$tmp"/legacy* "$tmp"/v2_* | grep -E '^[LV]\|' || true)"
echo "$claims"
legacy_n="$(grep -c '^L|' <<<"$claims" || true)"
v2_n="$(grep -c '^V|' <<<"$claims" || true)"
dupes="$(cut -d'|' -f2 <<<"$claims" | sort | uniq -d)"
[[ "$legacy_n" == 1 ]] || { echo "FAIL legacy claims=$legacy_n (want 1)" >&2; exit 1; }
[[ "$v2_n" -ge 1 ]] || { echo "FAIL v2 claims=$v2_n (want >=1)" >&2; exit 1; }
[[ -z "$dupes" ]] || { echo "FAIL double claim: $dupes" >&2; exit 1; }
grep -q '^L|.*|NULL$' <<<"$claims" || { echo "FAIL legacy claimed a bound row" >&2; exit 1; }
! grep -q '^V|.*|NULL$' <<<"$claims" || { echo "FAIL v2 claimed an unbound row" >&2; exit 1; }
echo "RACE legacy=$legacy_n v2=$v2_n (no double claim, no cross-domain claim)"

# After the race commits, the other account is still independently claimable.
"${as_service[@]}" -c "set role service_role; select 'V|' || scheduled_post_id || '|' || social_account_id from public.claim_due_post_v2();" > "$tmp/followup"
[[ "$(cat "$tmp/v2_"* "$tmp/followup" | grep '^V|' | cut -d'|' -f3 | sort -u | tr '\n' ',')" == "acct_a,acct_b," ]] \
  || { echo "FAIL v2 accounts did not progress independently" >&2; exit 1; }
state="$("${as_service[@]}" -c "select count(*) filter (where status='running' and social_account_id is null) || '|' || count(*) filter (where status='running' and social_account_id is not null) || '|' || (select count(*) from public.post_queue_attempts_v2 where phase='pre_x') from public.scheduled_posts where slot_no in (60,61,62)")"
[[ "$state" == "1|2|2" ]] || { echo "FAIL final state $state (want 1|2|2)" >&2; exit 1; }
echo "PHASE1D_CONCURRENCY_PASS race_v2=$v2_n final_state=$state"

# Diagnostic (Phase1B behavior, not a Phase1D gate): while one v2 claim
# transaction is open, how many account-turn rows can another worker lock?
"${as_owner[@]}" <<'SQL'
set role service_role;
select public.schedule_account_bound_post_v2('brand_a','acct_a',current_date,'tip',63::smallint,now()-interval '1 hour');
select public.schedule_account_bound_post_v2('brand_b','acct_b',current_date,'tip',64::smallint,now()-interval '1 hour');
SQL
"${as_service[@]}" -c "$hold select 1 from public.claim_due_post_v2(); select pg_sleep(3); commit;" > /dev/null &
sleep 1
lockable="$("${as_owner[@]}" -A -t -c "begin; select count(*) from (select 1 from public.post_queue_account_turns_v2 for update skip locked) x; rollback;" | grep -E '^[0-9]+$')"
wait
echo "DIAG turn_rows_lockable_by_second_worker_while_first_v2_claim_open=$lockable of 2"

cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname in ('$db', '$db2')")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left disposable databases" >&2; exit 1; }
echo "PHASE1D_CLEANUP_PASS"
