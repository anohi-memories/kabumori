#!/usr/bin/env bash
# Disposable-only Stage 3B proof runner: production-shaped core fixture plus a
# second Vault-backed account ('sa_pilot'), the production fingerprint/log
# tables, the PR81 settings store (candidate + hardening) and a copy of the live
# claim step -> refresh core -> Stage 3A -> Stage 3B (completion, settings
# reader, publish authority), as a non-superuser owner. Runs the pilot behavior proof and races
# (account-local leases, single claim), then drops the database. Never production.
# Usage: PILOT_PGHOST=/private/tmp/<socket-dir> PILOT_PGPORT=<port> \
#        PILOT_PGSUPER=<local superuser> supabase/tests/x_account_refresh_pilot_run.sh
set -euo pipefail

host="${PILOT_PGHOST:?PILOT_PGHOST (local socket dir) required}"
port="${PILOT_PGPORT:?PILOT_PGPORT required}"
super="${PILOT_PGSUPER:?PILOT_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PILOT_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_refresh_pilot_$$"
owner="kb_refresh_pilot_owner"
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
"${as_owner[@]}" -f "$here/x_account_stage3b_base_fixture.sql"
"${as_owner[@]}" -1 -f "$migrations/20260922045046_social_mobile_content_settings_candidate.sql" \
  -f "$migrations/20261003120000_social_mobile_content_settings_hardening.sql" > /dev/null
"${as_owner[@]}" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql"
# Production-like history: AI Lab has a clean committed refresh (grandfathered).
"${as_owner[@]}" -c "insert into public.x_account_refresh_state_v2 (social_account_id, status, generation, last_refreshed_at) values ('ai_salaryman_lab_x', 'idle', 1, now() - interval '1 hour')"
"${as_owner[@]}" -f "$migrations/20260926032054_x_account_refresh_rollout_authority.sql"
# The authority migration refuses to run before the settings reader exists.
if "${as_owner[@]}" -f "$migrations/20261006160200_x_account_publish_authority.sql" > /dev/null 2>&1; then
  echo "FAIL publish authority applied without its preconditions" >&2; exit 1
fi
"${as_owner[@]}" -f "$migrations/20261006160000_vault_account_brand_post_completion.sql"
if "${as_owner[@]}" -f "$migrations/20261006160000_vault_account_brand_post_completion.sql" > /dev/null 2>&1; then
  echo "FAIL Stage 3B re-apply was not refused" >&2; exit 1
fi
"${as_owner[@]}" -f "$migrations/20261006160100_social_mobile_publish_settings_reader.sql"
if "${as_owner[@]}" -f "$migrations/20261006160100_social_mobile_publish_settings_reader.sql" > /dev/null 2>&1; then
  echo "FAIL settings reader re-apply was not refused" >&2; exit 1
fi
"${as_owner[@]}" -f "$migrations/20261006160200_x_account_publish_authority.sql"
if "${as_owner[@]}" -f "$migrations/20261006160200_x_account_publish_authority.sql" > /dev/null 2>&1; then
  echo "FAIL publish authority re-apply was not refused" >&2; exit 1
fi
"${as_owner[@]}" -f "$here/x_account_refresh_pilot_behavior.sql" | grep -q PILOT_BEHAVIOR_PASS || { echo "FAIL behavior" >&2; exit 1; }
echo "PILOT_BEHAVIOR_PASS"
"${as_owner[@]}" -f "$here/x_account_publish_authority_behavior.sql" | grep -q PUBLISH_AUTHORITY_BEHAVIOR_PASS || { echo "FAIL publish authority behavior" >&2; exit 1; }
echo "PUBLISH_AUTHORITY_BEHAVIOR_PASS"
"${as_owner[@]}" -f "$here/social_mobile_publish_settings_reader_behavior.sql" | grep -q PUBLISH_SETTINGS_READER_BEHAVIOR_PASS || { echo "FAIL settings reader behavior" >&2; exit 1; }
echo "PUBLISH_SETTINGS_READER_BEHAVIOR_PASS"

tmp="$(mktemp -d /private/tmp/kabumori-refresh-pilot-race.XXXXXX)"
trap 'rm -rf "$tmp"; cleanup' EXIT

# Race 1 (10): AI Lab and the pilot account lease in parallel (independent);
# a second pilot lease waits and is refused.
"${as_owner[@]}" <<'SQL'
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null, lease_token = null, lease_kind = null,
  lease_post_id = null, lease_post_attempt = null, lease_attempt_id = null, leased_at = null;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where id in ('sa_pilot', 'ai_salaryman_lab_x');
update public.x_account_refresh_rollout set pilot_max_generation = 100 where social_account_id = 'sa_pilot';
create table public.race_posts as
select b.brand_id, b.account, n, gen_random_uuid() as post_id
from (values ('ai_salaryman_lab', 'ai_salaryman_lab_x'), ('u_pilot', 'sa_pilot')) b(brand_id, account) cross join generate_series(1, 2) n;
insert into public.scheduled_posts (id, brand_id, post_type, status, attempt_count, started_at)
select post_id, brand_id, 'brand_post', 'running', 1, now() from public.race_posts;
grant select on public.race_posts to service_role;
SQL
begin_for() {
  echo "select b.refresh_token from (select * from public.race_posts where account = '$1' and n = $2) p cross join lateral public.begin_x_account_refresh_legacy_post(p.post_id, p.account, p.brand_id) b"
}
"${as_service[@]}" -c "begin; set local role service_role; $(begin_for sa_pilot 1); select pg_sleep(2); commit;" > "$tmp/p1" 2>&1 &
sleep 0.5
"${as_service[@]}" -c "set role service_role; $(begin_for sa_pilot 2);" > "$tmp/p2" 2>&1 &
"${as_service[@]}" -c "set role service_role; $(begin_for ai_salaryman_lab_x 1);" > "$tmp/a1" 2>&1 &
wait
grep -q 'fake_PILOT_REFRESH' "$tmp/p1" || { echo "FAIL pilot lease: $(cat "$tmp/p1")" >&2; exit 1; }
grep -q 'X_REFRESH_IN_PROGRESS' "$tmp/p2" || { echo "FAIL second pilot lease not refused: $(cat "$tmp/p2")" >&2; exit 1; }
grep -q 'fake_AI_REFRESH' "$tmp/a1" || { echo "FAIL AI Lab lease not independent: $(cat "$tmp/a1")" >&2; exit 1; }
if grep -h 'fake_' "$tmp/p2"; then echo "FAIL secret in error output" >&2; exit 1; fi

# Race 2 (14): two concurrent claims of one due pilot row -> exactly one claim.
"${as_owner[@]}" -c "update public.scheduled_posts set status = 'failed' where status = 'pending'" \
  -c "insert into public.scheduled_posts (brand_id, post_type, scheduled_for) values ('u_pilot', 'brand_post', now() - interval '1 minute')"
for i in 1 2 3; do
  "${as_service[@]}" -c "set role service_role; select id from public.claim_due_post();" > "$tmp/c$i" 2>&1 &
done
wait
claimed="$(cat "$tmp/c1" "$tmp/c2" "$tmp/c3" | grep -cE '^[0-9a-f-]{36}$' || true)"
[[ "$claimed" == 1 ]] || { echo "FAIL claims=$claimed" >&2; exit 1; }
dupes="$(cat "$tmp/c1" "$tmp/c2" "$tmp/c3" | grep -E '^[0-9a-f-]{36}$' | sort | uniq -d | wc -l | tr -d ' ')"
[[ "$dupes" == 0 ]] || { echo "FAIL duplicate claim" >&2; exit 1; }
starts="$("${as_service[@]}" -c "select count(*) from public.post_execution_logs where status = 'started' and brand_id = 'u_pilot'")"
[[ "$starts" == 1 ]] || { echo "FAIL started logs=$starts" >&2; exit 1; }
echo "PILOT_RACE_PASS account_local_leases=ai_salaryman_lab_x,sa_pilot single_claim=$claimed"

# Race 3 (publish boundary): a revocation is effective from its commit. A check
# that runs while the revocation is still uncommitted sees the last committed
# state; every check after the commit refuses. (The Edge path re-checks
# immediately before its single X create, so at most that one in-flight create
# can straddle a revocation commit.)
post="$("${as_service[@]}" -c "insert into public.scheduled_posts (brand_id, post_type, status, attempt_count, started_at) values ('u_pilot', 'brand_post', 'running', 1, now()) returning id" | head -1)"
check_sql="set role service_role; select public.check_x_account_publish_authority('$post', 'sa_pilot', 'u_pilot');"
[[ "$("${as_service[@]}" -c "$check_sql" 2>&1)" == allowed ]] || { echo "FAIL publish race precondition" >&2; exit 1; }
"${as_service[@]}" -c "begin; set local role service_role; select public.set_x_account_publish_authority('sa_pilot', 'revoked', 'RACE_REVOKE'); select pg_sleep(2); commit;" > "$tmp/revoke" 2>&1 &
sleep 0.7
during="$("${as_service[@]}" -c "$check_sql" 2>&1 | tr -d '\n')"
wait
after="$("${as_service[@]}" -c "$check_sql" 2>&1 | tr -d '\n' || true)"
[[ "$during" == allowed ]] || { echo "FAIL during-revoke check: $during" >&2; exit 1; }
[[ "$after" == *VAULT_PUBLISH_AUTHORITY_REVOKED* ]] || { echo "FAIL after-revoke check: $after" >&2; exit 1; }
echo "PUBLISH_RACE_PASS revoke_effective_at_commit during=allowed after=revoked"

cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || { echo "FAIL cleanup left database $db" >&2; exit 1; }
echo "PILOT_CLEANUP_PASS"
