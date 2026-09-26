#!/usr/bin/env bash
# Disposable-only Stage 3A proof runner. Creates a throwaway database on a
# LOCAL Unix-socket PostgreSQL cluster, applies the production-shaped core
# fixture -> refresh core -> (pre-3A state seed) -> Stage 3A rollout as a
# non-superuser owner, runs the rollout behavior proof and races, then drops
# the database. Fake data only; never production.
# Usage: ROLLOUT_PGHOST=/private/tmp/<socket-dir> ROLLOUT_PGPORT=<port> \
#        ROLLOUT_PGSUPER=<local superuser> supabase/tests/x_account_refresh_rollout_run.sh
set -euo pipefail

host="${ROLLOUT_PGHOST:?ROLLOUT_PGHOST (local socket dir) required}"
port="${ROLLOUT_PGPORT:?ROLLOUT_PGPORT required}"
super="${ROLLOUT_PGSUPER:?ROLLOUT_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: ROLLOUT_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_refresh_rollout_$$"
owner="kb_refresh_rollout_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
as_service=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

cleanup() {
  "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
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
SQL

"${as_owner[@]}" -f "$here/x_account_refresh_core_fixture.sql"
# Count Vault reads with a (non-transactional) sequence so reads inside a
# refused, rolled-back call are still visible to the proof.
"${as_owner[@]}" <<'SQL'
create sequence vault.fixture_read_seq;
create function vault.fixture_count_read(p_secret text) returns text language plpgsql volatile as $$
begin perform nextval('vault.fixture_read_seq'); return p_secret; end;
$$;
create or replace view vault.decrypted_secrets as
select s.id, vault.fixture_count_read(s.secret) as decrypted_secret from vault.secrets s;
SQL
"${as_owner[@]}" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql"
# Pre-3A production-like history: acct_i has a clean committed refresh
# (grandfathered); acct_h has one with an unresolved error; acct_e is uncertain.
"${as_owner[@]}" <<'SQL'
insert into public.x_account_refresh_state_v2 (social_account_id, status, generation, last_refreshed_at, last_error_code) values
  ('acct_i', 'idle', 1, now() - interval '1 hour', null),
  ('acct_h', 'idle', 3, now() - interval '1 hour', 'X_OLD_ERROR'),
  ('acct_e', 'uncertain', 2, now() - interval '1 hour', 'X_REFRESH_NETWORK_UNCERTAIN');
SQL
"${as_owner[@]}" -f "$migrations/20260926032054_x_account_refresh_rollout_authority.sql"
# Not re-runnable, and never replays the core.
if "${as_owner[@]}" -f "$migrations/20260926032054_x_account_refresh_rollout_authority.sql" > /dev/null 2>&1; then
  echo "FAIL Stage 3A re-apply was not refused" >&2; exit 1
fi
if "${as_owner[@]}" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql" > /dev/null 2>&1; then
  echo "FAIL core replay was not refused" >&2; exit 1
fi
"${as_owner[@]}" -f "$here/x_account_refresh_rollout_behavior.sql" | grep -q ROLLOUT_BEHAVIOR_PASS || { echo "FAIL behavior" >&2; exit 1; }
echo "ROLLOUT_BEHAVIOR_PASS"

tmp="$(mktemp -d /private/tmp/kabumori-refresh-rollout-race.XXXXXX)"
trap 'rm -rf "$tmp"; cleanup' EXIT

# Race 1: two concurrent begins on one enabled account -> exactly one lease.
"${as_owner[@]}" <<'SQL'
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null, lease_token = null, lease_kind = null,
  lease_post_id = null, lease_post_attempt = null, lease_attempt_id = null, leased_at = null;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where id in ('acct_i', 'acct_d');
create table public.race_posts as
select b.brand_id, b.account, n, gen_random_uuid() as post_id
from (values ('brand_i', 'acct_i'), ('brand_d', 'acct_d')) b(brand_id, account) cross join generate_series(1, 2) n;
insert into public.scheduled_posts (id, brand_id, status, attempt_count, started_at)
select post_id, brand_id, 'running', 1, now() from public.race_posts;
grant select on public.race_posts to service_role;
SQL
begin_for() {
  echo "select b.lease_token from (select * from public.race_posts where account = '$1' and n = $2) p cross join lateral public.begin_x_account_refresh_legacy_post(p.post_id, p.account, p.brand_id) b"
}
"${as_service[@]}" -c "begin; set local role service_role; $(begin_for acct_i 1); select pg_sleep(2); commit;" > "$tmp/one" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "set role service_role; $(begin_for acct_i 2);" > "$tmp/two" 2>&1 &
wait
grep -qE '^[0-9a-f-]{36}$' "$tmp/one" || { echo "FAIL first lease: $(cat "$tmp/one")" >&2; exit 1; }
grep -q 'X_REFRESH_IN_PROGRESS' "$tmp/two" || { echo "FAIL second lease not refused: $(cat "$tmp/two")" >&2; exit 1; }

# Race 2: re-connect (row lock, then UPDATE) racing the commit of an in-flight
# refresh. Whatever PostgreSQL decides (wait or deadlock victim), the new
# tokens must never land in a re-connected account.
li="$(grep -E '^[0-9a-f-]{36}$' "$tmp/one")"
"${as_service[@]}" -c "begin; select 1 from public.social_accounts where id = 'acct_i' for update; select pg_sleep(1.5);
  update public.social_accounts set verified_at = now(), updated_at = now() where id = 'acct_i'; commit;" > "$tmp/reconnect" 2>&1 &
sleep 0.3
"${as_service[@]}" -c "set role service_role; select public.commit_x_account_refresh_legacy_post('$li', 'acct_i', 'fake_I_RACE_access', 'fake_I_RACE_refresh', 60);" > "$tmp/commit" 2>&1 &
wait || true
reconnected=no; grep -qi 'deadlock\|ERROR' "$tmp/reconnect" || reconnected=yes
commit_out="$(tr -d '\n' < "$tmp/commit")"
written="$("${as_service[@]}" -c "select count(*) from vault.secrets where secret like 'fake_I_RACE%'")"
state="$("${as_service[@]}" -c "select status from public.x_account_refresh_state_v2 where social_account_id = 'acct_i'")"
case "$commit_out" in
  committed) [[ "$reconnected" == no && "$written" == 2 ]] || { echo "FAIL commit won but reconnect=$reconnected written=$written" >&2; exit 1; } ;;
  account_changed) [[ "$reconnected" == yes && "$written" == 0 && "$state" == uncertain ]] || { echo "FAIL account_changed reconnect=$reconnected written=$written state=$state" >&2; exit 1; } ;;
  *X_REFRESH_PERSIST_FAILED*) [[ "$reconnected" == yes && "$written" == 0 && "$state" == refreshing ]] || { echo "FAIL persist_failed reconnect=$reconnected written=$written state=$state" >&2; exit 1; } ;;
  *) echo "FAIL unexpected commit outcome: $commit_out / reconnect: $(cat "$tmp/reconnect")" >&2; exit 1 ;;
esac
if grep -h 'fake_' "$tmp/two" "$tmp/commit" "$tmp/reconnect"; then echo "FAIL secret in output" >&2; exit 1; fi
outcome="${commit_out//[^a-zA-Z_]/}"
echo "ROLLOUT_RACE_PASS one_lease_per_account=acct_i reconnect_vs_commit=${outcome:0:40} reconnected=$reconnected written=$written"

cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "ROLLOUT_CLEANUP_PASS"
