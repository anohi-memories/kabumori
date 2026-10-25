#!/usr/bin/env bash
# G3 TASK 12/50 proof (disposable LOCAL PostgreSQL only): U8 -- the REAL 2a-2 CHECK social_accounts_meta_publish_disabled stays IN
# FORCE for the whole run (no test-only lift anywhere), and G3's Threads reservations (007, unchanged) must fail closed: no row, no
# publish request, no automatic retry, no existence leak. Same world as postona_threads_g4_credential_run.sh (PR #382): G5 #371's
# baseline with the real 2a-2, G3 #370 -> G5 #303 -> G4 #124 -> G4 custody -> G4 #367 -> G5 #371 -> 007 -> G4 #377, people through
# G4's real connect path ('sa_<24 hex>'). G4 / G5 / #370 files are read-only copies, never edited. Roles are cluster-wide: run alone.
# Environment: as postona_threads_g4_credential_run.sh.
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${RESV_G5_SOURCE_DIR:-}"; g4="${THREADS_G4_SOURCE_DIR:-}"; bm="${THREADS_BM_CANDIDATE:-}"; g4bind="${THREADS_G4_BINDING_SQL:-}"
oe="$g5/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql"
av="$g5/supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql"
g4social="$g4/supabase/functions/_shared/social"
g4cred="$g4/supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic.sql"
g4custody="$g4/supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql"
g4oauth="$g4/supabase/candidates/postona_threads_oauth_workspace_candidate.sql"
for f in "$oe" "$av" "$g5/supabase/tests/common_account_phase9_auth_fixture.sql" "$g4social/threads_send_port.ts" "$g4cred" "$g4custody" "$g4oauth" \
         "$g4/supabase/tests/postona_threads_oauth_test_fixture.sql" "$g4/supabase/tests/postona_social_accounts_multi_provider_fixture.sql" "$bm" "$g4bind"; do
  [[ -n "$f" && -f "$f" ]] || { echo "RUN_NOT_AVAILABLE: missing $f" >&2; exit 3; }
done
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
resv="$here/../postona_x_reservations"
candidate="${THREADS_RESV_CANDIDATE:-$here/007_postona_threads_reservations.sql}"
t="$here/tests"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_sp_owner"
apilogin="kb_postona_g3_api"
wklogin="kb_postona_g3_worker"
db="kabumori_postona_g3u8_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-g3u8.XXXXXX)"
drop_roles() {
  "${S[@]}" -d postgres -c "drop role if exists $apilogin" -c "drop role if exists $wklogin" -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
}
cleanup() {
  rm -rf "$tmp"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  drop_roles
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

drop_roles
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
val() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
refuse() { local file="$1" code="$2" label="$3"
  if own -f "$file" >"$tmp/r" 2>&1; then fail "$label: applied"; fi
  grep -q "$code" "$tmp/r" || fail "$label: wrong refusal: $(grep ERROR "$tmp/r" | head -1)"; }

# 1. G5's baseline (as G5's / G4's runners), with the REAL 2a-2 migration (G4-11's preparation) instead of G3's stand-in
own -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
own -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
own -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
own -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
own -f "$tests/common_account_phase9_auth_fixture.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion; do
  own -f "$m/$f.sql" >/dev/null
done
own -f "$tests/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$db" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
for f in 20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state; do
  own -f "$m/$f.sql" >/dev/null
done
own -f "$g4/supabase/tests/postona_social_accounts_multi_provider_fixture.sql" >/dev/null
val -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" >/dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | val >/dev/null
val -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" >/dev/null
own -f "$m/20261007150000_postona_social_accounts_multi_provider.sql" >/dev/null
for f in 20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
         20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
  own -f "$m/$f.sql" >/dev/null
done
"${S[@]}" -d "$db" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' >/dev/null
own -f "$g4/supabase/tests/postona_threads_oauth_test_fixture.sql" >/dev/null
own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
echo "BASELINE_REAL_2A2_READY"

# 2. G3's X reservations 001-006 (unchanged), as every G3 runner
own -f "$repo/supabase/candidates/postona_x_publish_entitlement/test_stand_ins.sql" >/dev/null
own -f "$repo/supabase/migrations/20261006160200_x_account_publish_authority.sql" >/dev/null
own -f "$repo/supabase/candidates/postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql" >/dev/null
own -f "$resv/001_postona_x_reservations.sql" >/dev/null
own -f "$resv/002_postona_x_resv_api_role.sql" >/dev/null
own -f "$resv/003_postona_x_resv_g5_binding.sql" >/dev/null
own -f "$repo/supabase/candidates/postona_x_oauth_t13_guard/g4_predicate_test_double.sql" >/dev/null
own -f "$resv/004_postona_x_resv_dispatch.sql" >/dev/null
"${S[@]}" -d postgres -c "create role $apilogin login noinherit" -c "grant postona_resv_api to $apilogin" \
  -c "grant postona_resv_api to $owner with inherit false, set true" -c "grant postona_resv_worker to $owner with inherit false, set true" >/dev/null
own -f "$resv/005_postona_x_single_post.sql" >/dev/null
own -f "$resv/006_postona_x_single_post_live_fence.sql" >/dev/null
"${S[@]}" -d postgres -c "create role $wklogin login noinherit" -c "grant postona_resv_worker to $wklogin" >/dev/null
xfp() { val -c "select md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || p.prosrc || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || coalesce(array_to_string(p.proacl::text[], ','), ''), '|' order by p.oid::regprocedure::text), '')
  || (select coalesce(string_agg(c.relname || ':' || coalesce(array_to_string(c.relacl::text[], ','), ''), '|' order by c.relname), '') from pg_class c where c.relnamespace = 'postona_x_resv'::regnamespace))
  from pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace"; }
FPX="$(xfp)"
echo "BASELINE_001_006_READY"
# G3-34: G5's person-session gate S2-2 (caller() asks it first), pinned at PR #510's head, installed by the schema owner
. "$resv/g5_s2_2_pinned.sh"
s22_pinned "$tmp/s22.sql"
own -f "$tmp/s22.sql" >/dev/null
echo "G5_S2_2_PINNED_INSTALLED"

# 3. The owners' candidates, in their dependency order (every refusal before its prerequisite is checked)
refuse "$oe" OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS "S0 #303 before #370"
own -f "$bm" >/dev/null
own -f "$oe" >/dev/null
own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
own -f "$g4oauth" >/dev/null
own -f "$g4custody" >/dev/null
own -f "$g4bind" >/dev/null
own -f "$av" >/dev/null
refuse "$g4cred" "THREADS_CREDENTIAL_PRECONDITION_DEPENDENCY postona_threads_resv.threads_credential_generation" "S0 G4 #377 before G3 007"
own -f "$t/g4_credential_world.sql" >/dev/null
own -f "$candidate" >/dev/null
own -f "$t/g4_g5_test_doubles.sql" >/dev/null
own -f "$g4cred" >/dev/null
[[ "$(val -c "select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE') || '/' || (select count(*) from pg_namespace where nspname in ('t_g5'))")" == "NONE/0" ]] || fail "S0 G5 exposure / doubles"
[[ "$(xfp)" == "$FPX" ]] || fail "the candidates changed postona_x_resv"
echo "S0_ORDER_370_303_124_CUSTODY_367_371_007_377_PASS"

# 4. People through G4's real connect path ('sa_<24 hex>' accounts, binding, custody, fake Vault tokens)
own -f "$t/g4_connect_people.sql" >"$tmp/people" 2>&1 || { cat "$tmp/people"; fail "people"; }
grep -q G4_CONNECT_PEOPLE_READY "$tmp/people" || { cat "$tmp/people"; fail "people not ready"; }
echo "PEOPLE_THROUGH_G4_CONNECT_READY"
# U8 precondition of this whole run: the 2a-2 CHECK is present and no Threads row is publish-enabled
[[ "$(val -c "select (select count(*) from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled')::text
  || '/' || (select count(*) from public.social_accounts where platform = 'threads' and publish_enabled)::text")" == "1/0" ]] || fail "U8 precondition: 2a-2 CHECK in force, no Threads row publish-enabled"
echo "U8_CHECK_IN_FORCE"

( cd "$g4social" && shasum -a 256 threads_send_port.ts threads_publish_contract.ts threads_connect_to_send.ts ) | sed 's/^/G4_COPY_SHA256 /'
( shasum -a 256 "$g4cred" "$g4bind" "$g4custody" "$g4oauth" | sed "s|$g4/||; s|$(dirname "$g4bind")/||" ) | sed 's/^/G4_SQL_SHA256 /'
if ! THREADS_XO_API_URL="postgres://$apilogin@127.0.0.1:$port/$db" THREADS_XO_WORKER_URL="postgres://$wklogin@127.0.0.1:$port/$db" \
  THREADS_XO_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" THREADS_G4_SOCIAL_DIR="$g4social" DENO_NO_PACKAGE_JSON=1 \
  deno test --no-config --no-lock --allow-net=127.0.0.1:"$port" --allow-read --allow-env=THREADS_XO_API_URL,THREADS_XO_WORKER_URL,THREADS_XO_OWNER_URL,THREADS_G4_SOCIAL_DIR \
  "$t/u8_publish_switch_failclosed_test.ts" >"$tmp/e2e" 2>&1; then
  cat "$tmp/e2e"; fail "U8 fail-closed e2e"
fi
sed $'s/\x1b\[[0-9;]*m//g' "$tmp/e2e" | grep -E "^U[0-9]+ " || true
grep -E "passed|failed" "$tmp/e2e" | tail -1
[[ "$(xfp)" == "$FPX" ]] || fail "the run changed postona_x_resv"
[[ "$(val -c "select (select count(*) from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled')::text
  || '/' || (select count(*) from public.social_accounts where platform = 'threads' and publish_enabled)::text")" == "1/0" ]] || fail "U8: the CHECK must still be in force after the run"
echo "E2E_THREADS_U8_FAILCLOSED_PG_PASS"
echo "POSTONA_THREADS_U8_FAILCLOSED_ALL_PASS"
