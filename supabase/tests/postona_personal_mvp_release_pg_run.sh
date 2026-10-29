#!/usr/bin/env bash
# G5-50: the personal MVP RELEASE path on a THROW-AWAY LOCAL PostgreSQL 17 (socket only, fake data): MVP_RELEASE_PREFLIGHT.sql (read-only)
# before / between / after each step, MVP_INSTALL.sql -> MVP_R1_EXECUTE_GRANT.sql -> the person -> MVP_R1_EXECUTE_REVOKE.sql -> MVP_ROLLBACK.sql,
# and ONE end-to-end chain on the same databases:
#   G1 PR #576 (8d95307c, read-only `git archive`, blob-checked): the app's real snapshot read (workspace id), assist gate and post-assist client
#   -> G6 PR #566 (79300d05, read-only archive, blob-checked): the real Edge entry handler + personal-MVP adapter + G5 transport + ledger client
#   -> G5 (this checkout): R1-MVP and its grant / stop; G6's real ledger + ai_calls + owner-held SQL; a fake OpenAI.
# Two databases: g5 (G5's prerequisite world, as postona_personal_mvp_auth_pg_run.sh builds "ne": the G5 Draft chain at 21a5cad4, no owner
# epoch) and led (G6's ledger side, as G6's own runner builds it). The Supabase-like role graph is modelled: authenticator NOINHERIT member of
# authenticated with SET (added here for the run and removed afterwards, also when this run made the role). The test plays PostgREST / GoTrue /
# the Functions client with fixed fake tokens -> fixed claims: no JWT is verified (NOT_VERIFIED). G1's / G6's sources are not changed: the G1
# copy only has its two `@/` / extensionless import specifiers rewritten to relative files so Deno can load it. No network, no credential, no
# managed project, no OAuth / token / Vault / SNS / paid API call. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_personal_mvp_release_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
python3 "$here/postona_personal_mvp_auth_build.py" "$repo" --check >/dev/null || { echo "The MVP profile does not re-derive." >&2; exit 2; }
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
G1=8d95307c7001a6456719c6a829ef41a83ab703c3
G6=79300d0539e6ff1657726bdddd129634745bc5cd
n="$$"; owner="kb_s50_owner_$n"; db="kabumori_s50_${n}_g5"; led="kabumori_s50_${n}_led"
work="$(mktemp -d "${TMPDIR:-/tmp}/g550rel.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
made_authenticator=false; added_membership=false
cleanup() {
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop database if exists $led with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  # roles are cluster-wide: undo exactly what this run added
  if [ "$added_membership" = true ]; then "${S[@]}" -d postgres -c "revoke authenticated from authenticator" >/dev/null 2>&1 || true; fi
  if [ "$made_authenticator" = true ]; then "${S[@]}" -d postgres -c "drop role if exists authenticator" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
[ "$("${S[@]}" -d postgres -c "show listen_addresses")" = "" ] || { echo "The server listens on TCP; use a socket-only scratch cluster." >&2; exit 2; }
for c in "$pin" "$G1" "$G6"; do git -C "$repo" cat-file -e "$c^{commit}" 2>/dev/null || { echo "Commit $c missing; run git fetch origin." >&2; exit 2; }; done
blob() { [ "$(git hash-object "$1")" = "$2" ] || { echo "$1 is not the pinned blob $2." >&2; exit 2; }; }

# G5's prerequisite world (as postona_personal_mvp_auth_pg_run.sh)
tree="$work/pinned"; mkdir -p "$tree"
git -C "$repo" archive "$pin" supabase/migrations supabase/tests | tar -x -C "$tree"
blob "$tree/supabase/migrations/20261010051938_common_account_service_write_guard.sql" da587631cfe8872e3ccf6fd521b919a5439c6574
m="$tree/supabase/migrations"; t="$tree/supabase/tests"
# G1 PR #576 (read-only): the files the chain runs, blob-checked BEFORE the import-specifier rewrite
mkdir -p "$work/g1"; git -C "$repo" archive "$G1" apps/social-mobile/src/data apps/social-mobile/src/features/schedule apps/social-mobile/src/domain | tar -x -C "$work/g1"
g1="$work/g1/apps/social-mobile/src"
blob "$g1/data/post-assist-client.ts" c7d7f63e8d0d16e7b5987e04c1964272644ccd97
blob "$g1/features/schedule/post-assist.ts" 88506a26bf0f6022cf32057acac39f3ef9cadf68
blob "$g1/data/supabase-repository.ts" 09523ceee89c76238e8ce6a78c12681810e9d282
blob "$g1/domain/post-status.ts" dca749eeb9676703fec5f9b94179316b0283eef0
sed -i.orig -e "s#from '@/domain/post-status'#from '../domain/post-status.ts'#" -e "s#from '@/domain/types'#from '../domain/types.ts'#" "$g1/data/supabase-repository.ts"
sed -i.orig -e "s#from './types'#from './types.ts'#" "$g1/domain/post-status.ts"
[ "$(diff "$g1/data/supabase-repository.ts.orig" "$g1/data/supabase-repository.ts" | grep -c '^>')" = 2 ] || { echo "G1 rewrite is not exactly 2 lines." >&2; exit 2; }
[ "$(diff "$g1/domain/post-status.ts.orig" "$g1/domain/post-status.ts" | grep -c '^>')" = 1 ] || { echo "G1 rewrite is not exactly 1 line." >&2; exit 2; }
# G6 PR #566 (read-only): the Edge entry and everything it imports, plus the ledger SQL its own runner applies
mkdir -p "$work/g6"; git -C "$repo" archive "$G6" supabase/functions/_shared supabase/migrations supabase/candidates/common_ai_g6 | tar -x -C "$work/g6"
gw="$work/g6/supabase/functions/_shared/ai_gateway"
blob "$gw/postona_post_assist_edge.ts" 0e0371d968dea85d71c9a47fa623f8d74d2e8abd
blob "$gw/postona_post_assist_mvp.ts" e8626373f230386e322926fba51126efc29eff7a
blob "$gw/g5_rpc_transport.ts" 8a68bd3ca2e787fbbba8d95f8c5a32d475004975
blob "$gw/authority_port.ts" 0c7ef2b052ba8af08c7d1bb82d510615fbd34e01
blob "$work/g6/supabase/candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql" 51678cbf1a35ec0768cb27bb7aa86f75b3db3642

made_authenticator="$("${S[@]}" -d postgres -c "select (to_regrole('authenticator') is null)::text")"
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin noinherit; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role to $owner;
SQL
[ "$("${S[@]}" -d postgres -c "select pg_has_role('authenticator', 'authenticated', 'MEMBER')::text")" = true ] \
  || { "${S[@]}" -d postgres -c "grant authenticated to authenticator with inherit false, set true" >/dev/null; added_membership=true; }
"${S[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
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
# TEST-WORLD stand-ins, as the G5 verdict suites: G3's L-1 revoke (P3) and auth.uid() reading both claim sources; managed behaviour NOT_VERIFIED
own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
# the app reads these as the person (G1's snapshot, under the RLS policies of 20260918120000): the SELECT grants Supabase's defaults give them
own -c "grant usage on schema public to authenticated; grant select on public.brand_memberships, public.brands, public.social_accounts, public.scheduled_posts to authenticated" >/dev/null

# G6's ledger side (as G6's runner at 79300d05)
"${S[@]}" -d postgres -c "create database $led" >/dev/null
"${S[@]}" -d "$led" >/dev/null <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
for f in migrations/20261010050613_ai_provider_budget_ledger.sql migrations/20261017120000_ai_consumer_call_store.sql migrations/20261017150000_ai_ledger_user_erasure.sql \
         migrations/20261020154536_ai_calls_owner_held_rc_guard.sql candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql; do
  "${S[@]}" -d "$led" -f "$work/g6/supabase/$f" >/dev/null
done
"${S[@]}" -d "$led" -c "insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
  values ('g550.postona.post', 'openai', 'gpt-6-luna', 'postona', 'post_generation', 'user', true, 'day', 200, 5, 0.2)" >/dev/null

( cd "$repo" && env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY S50_E2E=1 S50_HOST="$host" S50_PORT="$port" S50_SUPER="$super" S50_OWNER="$owner" S50_DB="$db" S50_LED="$led" \
    S50_MVP="$repo/supabase/candidates/postona_personal_mvp_auth" S50_G1="$g1" S50_G6="$work/g6/supabase/functions/_shared" \
    deno test --no-config --no-check --deny-net --allow-read --allow-env --allow-run=psql "$here/postona_personal_mvp_release_pg_test.ts" )
