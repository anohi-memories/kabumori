#!/usr/bin/env bash
# LOCAL dedicated cluster. Real parent source chain, MOCK_ONLY T13/Auth/Vault; NOT managed proof.
set -euo pipefail
host="${H5_PGHOST:?}"; port="${H5_PGPORT:?}"; super="${H5_PGSUPER:?}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"
tests="$here/../../tests"; migrations="$here/../../migrations"
p="${PSQL:-/opt/homebrew/opt/postgresql@17/bin/psql}"
owner="h5_parent_owner_$$"; db="h5_parent_$$"
a=("$p" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
"${a[@]}" -d postgres -c "create role $owner login nosuperuser; grant anon,authenticated,service_role to $owner;" -c "create database $db owner $owner"
q=("$p" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
"${q[@]}" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
for f in 20260919120000_social_mobile_x_oauth_onboarding.sql 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql;do
 "${q[@]}" -f "$migrations/$f" >/dev/null;done
"${q[@]}" -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql;do
 "${q[@]}" -f "$migrations/$f" >/dev/null;done
"${q[@]}" -f "$tests/postona_social_accounts_multi_provider_fixture.sql" >/dev/null
"${q[@]}" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" >/dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$migrations/20260925140000_x_account_credential_refresh_core.sql" | "${q[@]}" >/dev/null
"${q[@]}" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" >/dev/null
"${q[@]}" -f "$migrations/20261007150000_postona_social_accounts_multi_provider.sql" >/dev/null
"${a[@]}" -d "$db" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' >/dev/null
"${q[@]}" -f "$tests/postona_threads_oauth_mock_t13_fixture.sql" >/dev/null
"${q[@]}" -f "$tests/postona_threads_oauth_test_fixture.sql" >/dev/null
"${q[@]}" -f "$here/../postona_threads_oauth_workspace_candidate.sql" >/dev/null
"${q[@]}" -f "$here/claim_candidate.sql" >/dev/null
# Reproduce parent negative/X regression after H5 apply; test-only API grants are not deployment SQL.
"${q[@]}" -c 'grant execute on function public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz),public.consume_social_mobile_threads_oauth_state(text),public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text) to authenticated;' >/dev/null
"${q[@]}" -v mock=true -v g5=false -v owner="$owner" -f "$tests/postona_threads_oauth_behavior.sql"
# Owner begin/remember/claim/complete/outcome on real parent; fake actor created by behavior fixture.
"${q[@]}" <<'SQL'
begin;
select postona_t.act('00000000-0000-4000-8000-00000000a001');
select postona_threads_runtime.assert_actor('00000000-0000-4000-8000-00000000a001',postona_t.session_of('00000000-0000-4000-8000-00000000a001'));
select * from public.begin_social_mobile_threads_oauth_connection(postona_t.h('h5-parent'),'https://postona.example/callback',now()+interval '5 minutes');
select postona_threads_runtime.remember(postona_t.h('h5-parent'),'00000000-0000-4000-8000-00000000a001',postona_t.session_of('00000000-0000-4000-8000-00000000a001'),'https://postona.example/callback');
commit;
begin;
select postona_t.act('00000000-0000-4000-8000-00000000a001');
select postona_threads_runtime.claim(postona_t.h('h5-parent'),repeat('f',64),'00000000-0000-4000-8000-00000000a001',postona_t.session_of('00000000-0000-4000-8000-00000000a001'),'https://postona.example/callback');
commit;
begin;
select postona_t.act('00000000-0000-4000-8000-00000000a001');
select postona_threads_runtime.assert_actor('00000000-0000-4000-8000-00000000a001',postona_t.session_of('00000000-0000-4000-8000-00000000a001'));
select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-00000000a001'));
select id from public.social_account_oauth_states where state_hash=postona_t.h('h5-parent') for update;
select state_hash from postona_threads_runtime.attempts where state_hash=postona_t.h('h5-parent') for update;
select public.complete_social_mobile_threads_oauth_connection(s.id,a.platform_user_id,'offline_dummy','fakeH5token01234567890123456789',postona_t.attest(s.id,a.platform_user_id,'offline_dummy','fakeH5token01234567890123456789'))
from public.social_account_oauth_states s join public.social_accounts a on a.id=postona_t.threads_id('00000000-0000-4000-8000-00000000a001') where s.state_hash=postona_t.h('h5-parent');
select postona_threads_runtime.outcome(postona_t.h('h5-parent'),'00000000-0000-4000-8000-00000000a001',postona_t.session_of('00000000-0000-4000-8000-00000000a001'),'complete',now()+interval '60 days');
commit;
do $$begin
 if not exists(select 1 from postona_threads_runtime.attempts a join public.social_accounts s on s.id=a.social_account_id
 where a.state_hash=postona_t.h('h5-parent') and a.status='complete' and a.token_expires_at>now()
 and s.platform='threads' and s.publish_enabled=false and s.vault_access_token_secret_id is not null and s.vault_refresh_token_secret_id is null)
 then raise exception 'H5_PARENT_INTEGRATION_FAILED';end if;
end$$;
select 'H5_PARENT_INTEGRATION_PASS: fake Vault, real parent RPC, MOCK_ONLY T13';
SQL
echo "database=$db owner=$owner"
