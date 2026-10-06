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
"${as_owner[@]}" <<'SQL'
-- Vault reads counted by a non-transactional sequence.
create sequence vault.fixture_read_seq;
create function vault.fixture_count_read(p_secret text) returns text language plpgsql volatile as $$
begin perform nextval('vault.fixture_read_seq'); return p_secret; end;
$$;
create or replace view vault.decrypted_secrets as
select s.id, vault.fixture_count_read(s.secret) as decrypted_secret from vault.secrets s;
-- Production-shaped completion targets (read-only inspection 2026-09-27).
create table public.published_content_fingerprints (
  id bigint generated always as identity primary key,
  brand_id text not null references public.brands (id),
  social_account_id text not null references public.social_accounts (id),
  post_type text not null,
  normalized_text_sha256 text not null check (normalized_text_sha256 ~ '^[0-9a-f]{64}$'),
  x_post_id text,
  published_at timestamptz not null default now()
);
create unique index published_content_fingerprints_account_x_post_uidx
  on public.published_content_fingerprints (social_account_id, x_post_id) where x_post_id is not null;
create table public.post_execution_logs (
  id bigint generated always as identity primary key,
  scheduled_post_id uuid references public.scheduled_posts (id),
  post_type text not null,
  status text not null check (status in ('started', 'succeeded', 'failed')),
  x_post_id text,
  message text,
  created_at timestamptz not null default now(),
  brand_id text not null default 'kabumori' references public.brands (id)
);
-- The claim step of the live public.claim_due_post() (planners omitted).
create function public.claim_due_post() returns setof public.scheduled_posts
language plpgsql security definer set search_path = public as $$
declare claimed_id uuid;
begin
  select id into claimed_id from public.scheduled_posts
  where status = 'pending' and scheduled_for <= now() order by scheduled_for for update skip locked limit 1;
  if claimed_id is null then return; end if;
  update public.scheduled_posts set status = 'running', started_at = now(), attempt_count = attempt_count + 1 where id = claimed_id;
  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message, brand_id)
  select id, post_type, 'started', 'Scheduled post claimed', brand_id from public.scheduled_posts where id = claimed_id;
  return query select * from public.scheduled_posts where id = claimed_id;
end;
$$;
revoke all on function public.claim_due_post() from public, anon, authenticated;
grant execute on function public.claim_due_post() to service_role;
-- Production brand/admin columns the publish predicate reads.
alter table public.brands add column is_active boolean not null default false,
  add column publish_mode text not null default 'disabled' check (publish_mode in ('disabled', 'dry_run', 'live'));
create table public.brand_settings (
  brand_id text primary key references public.brands (id),
  fixed_hashtags jsonb not null default '[]'::jsonb,
  note_url text,
  image_policy jsonb not null default '{}'::jsonb,
  enabled_post_types jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The second (pilot) Vault-backed account and an account without refs.
insert into public.brands values ('u_pilot'), ('u_norefs');
insert into vault.secrets (id, secret) values
  ('00000000-0000-4000-8000-00000000e1e1', 'fake_PILOT_access_1'),
  ('00000000-0000-4000-8000-00000000e1e2', 'fake_PILOT_REFRESH_1');
insert into public.social_accounts
  (id, brand_id, platform, handle, platform_user_id, connection_status, publish_enabled, oauth_client_ref,
   vault_access_token_secret_id, vault_refresh_token_secret_id)
values
  ('sa_pilot', 'u_pilot', 'x', 'pilot', 'x_pilot', 'identity_verified', true, 'default',
   '00000000-0000-4000-8000-00000000e1e1', '00000000-0000-4000-8000-00000000e1e2'),
  ('sa_norefs', 'u_norefs', 'x', 'norefs', 'x_norefs', 'identity_verified', true, 'default', null, null);
SQL
# PR81 settings store, exactly as main ships it (candidate + hardening), on the production-shaped
# auth/membership pieces it depends on; brands carry their code profile (production column).
"${as_owner[@]}" <<'SQL'
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter table public.brands add column code_profile_key text not null default 'kabumori_v1';
update public.brands set code_profile_key = 'ai_salaryman_lab_v1' where id = 'ai_salaryman_lab';
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in ('u_pilot', 'u_norefs');
-- A second user workspace (cross-brand isolation) and a workspace on another, internal profile.
insert into public.brands (id, code_profile_key) values ('u_other', 'social_mobile_user_v1'), ('u_internal', 'internal_ops_v1');
create table public.brand_memberships (
  brand_id text not null references public.brands (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  primary key (brand_id, user_id)
);
alter table public.brand_memberships enable row level security;
create policy brand_memberships_self_select on public.brand_memberships
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on table public.brand_memberships from anon, authenticated, service_role;
grant select on table public.brand_memberships to authenticated;
SQL
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
