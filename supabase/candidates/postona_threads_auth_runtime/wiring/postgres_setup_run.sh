#!/usr/bin/env bash
# NEW H5 dedicated LOCAL cluster ONLY; uses exact protected source with fake Auth/Vault data.
set -euo pipefail
host="${H5_PGHOST:?}"; port="${H5_PGPORT:?}"; super="${H5_PGSUPER:?}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
tests="$here/../../../tests"; migrations="$here/../../../migrations"
p="${PSQL:-/opt/homebrew/opt/postgresql@17/bin/psql}"; owner="h5_wiring_owner_$$"; db="h5_wiring_$$"
a=("$p" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
"${a[@]}" -d postgres -c "do \$\$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls;end if;
 if not exists(select 1 from pg_roles where rolname='authenticator') then create role authenticator;end if;
end \$\$; create role $owner login nosuperuser; grant anon,authenticated,service_role to $owner;" -c "create database $db owner $owner"
q=("$p" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
"${q[@]}" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
for f in 20260919120000_social_mobile_x_oauth_onboarding.sql 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql;do "${q[@]}" -f "$migrations/$f" >/dev/null;done
"${q[@]}" -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql;do "${q[@]}" -f "$migrations/$f" >/dev/null;done
"${q[@]}" -f "$tests/postona_social_accounts_multi_provider_fixture.sql" >/dev/null
"${q[@]}" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" >/dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$migrations/20260925140000_x_account_credential_refresh_core.sql" | "${q[@]}" >/dev/null
"${q[@]}" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" >/dev/null
"${q[@]}" -f "$migrations/20261007150000_postona_social_accounts_multi_provider.sql" >/dev/null
"${a[@]}" -d "$db" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' >/dev/null
# G5 REAL exact guard/fixture, not the PR124 mock. Current repaired PR152 contains unchanged PR121 T13.
g5=ccea1fe8132c6f573a768f0df5a033a05c62ef2c
git -C "$repo" show "$g5:supabase/tests/common_account_write_guard_fixture.sql" | "${q[@]}" >/dev/null
git -C "$repo" show "$g5:supabase/migrations/20261010051938_common_account_service_write_guard.sql" | "${q[@]}" >/dev/null
"${q[@]}" -f "$tests/postona_threads_oauth_test_fixture.sql" >/dev/null
"${q[@]}" -f "$here/../../postona_threads_oauth_workspace_candidate.sql" >/dev/null
if [[ "${H5_LOCK_MUTATION:-}" == key-share ]]; then
 # Deliberate local fail-before mutation ONLY; never used in source output or any connected project.
 sed 's/for share;/for key share;/' "$here/../claim_candidate.sql" | "${q[@]}" >/dev/null
else "${q[@]}" -f "$here/../claim_candidate.sql" >/dev/null; fi
# G4 custody exact owner source, copied through stdin, never edited or pushed into H5 PR.
git -C "$repo" show '98287392327eabfd5092a3ba89dde51a2e8beff6:supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql' | "${q[@]}" >/dev/null
set --; [[ -z "${H5_TEST_FILTER:-}" ]] || set -- --filter "$H5_TEST_FILTER"
H5_PGUSER="$owner" H5_PGDATABASE="$db" deno test "$@" --cached-only --config "$here/deno.json" \
 --allow-env=H5_PGHOST,H5_PGPORT,H5_PGUSER,H5_PGDATABASE --allow-read="$host" --allow-write="$host/.s.PGSQL.$port" --allow-net="unix:$host/.s.PGSQL.$port" "$here/postgres_integration.smoke.ts"
echo "H5_WIRING_LOCAL_PG_PASS db=$db owner=$owner G5=$g5; FAKE_AUTH_VAULT, no managed/TLS proof"
