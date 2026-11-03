#!/usr/bin/env bash
# G6-25 (2026-10-29): POSTONA's AI post assist through its REAL Edge entry handler (G6-23/G6-24, supabase/functions/_shared/ai_gateway/
# postona_post_assist_edge.ts) against G5-48's UNAPPLIED personal-MVP auth candidate (PR #563, read-only `git archive`, blob-checked) and
# G6's real ledger + ai_calls + owner-held SQL, on a THROW-AWAY local PostgreSQL 17 (socket only, fake data). Two scratch databases:
#   g5   G5's prerequisite world (the G5 Draft chain at 21a5cad4, as PR #563's own runner builds it); MVP_INSTALL.sql, MVP_R1_EXECUTE_GRANT.sql
#        and MVP_R1_EXECUTE_REVOKE.sql are run by the test as G5's lifecycle owner (a non-superuser role created here and dropped afterwards)
#   led  the ledger (20261010050613), call store (20261017120000), maintenance (20261017150000), owner-held (20261020154536) and the G6-20
#        owner-held ledger candidate (supabase/candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql)
# The test's fetch plays PostgREST (the person's token -> fixed fake claims -> `set local role authenticated`) and a fake OpenAI. No network, no
# credential, no managed project, no real JWT verification, no OAuth / token / Vault / SNS call. G5's and G1's sources are not changed.
#   G6PA_PGHOST=/private/tmp/<socket> G6PA_PGPORT=<port> G6PA_PGSUPER=<local superuser> bash supabase/tests/common_ai_gateway_post_assist_g5_48_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
HOST="${G6PA_PGHOST:?G6PA_PGHOST (local socket dir under /tmp) is required}"
PORT="${G6PA_PGPORT:?G6PA_PGPORT is required}"
SUPER="${G6PA_PGSUPER:?G6PA_PGSUPER is required}"
case "$HOST" in /tmp/*|/private/tmp/*) ;; *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;; esac
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CONFIG="$REPO/supabase/functions/_shared/ai_consumer_bridge/deno.json"
# G5's sources, read only: the world (PR #563's runner pin) and the G5-48 candidate (PR #563 HEAD, source-only accepted, review pending)
G5W=21a5cad4b71de63265db8517da93c6efc60cdde8
G5M=9846c0f062626db1dd4d9e8c10d5b1573e7f4982
N="$$"; OWNER="g6pa_owner_$N"; DB_G5="g6pa_g5_$N"; DB_LED="g6pa_led_$N"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/g6pa.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$HOST" -p "$PORT" -U "$SUPER")
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  "${S[@]}" -d postgres -c "drop database if exists $DB_G5 with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop database if exists $DB_LED with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $OWNER" >/dev/null 2>&1 || true
  # roles are cluster-wide: a leftover authenticator changes other suites' Supabase-like preflights, so drop it when this run made it
  if [ "${MADE_AUTHENTICATOR:-false}" = true ]; then "${S[@]}" -d postgres -c "drop role if exists authenticator" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
[ "$("${S[@]}" -d postgres -c "show listen_addresses")" = "" ] || fail "the server listens on TCP; use a socket-only scratch cluster"
for c in "$G5W" "$G5M"; do git -C "$REPO" cat-file -e "$c^{commit}" 2>/dev/null || fail "commit $c missing; run git fetch origin pull/563/head"; done
mkdir -p "$WORK/g5m" "$WORK/g5w"
git -C "$REPO" archive "$G5M" supabase/candidates/postona_personal_mvp_auth | tar -x -C "$WORK/g5m"
git -C "$REPO" archive "$G5W" supabase/migrations supabase/tests | tar -x -C "$WORK/g5w"
MVP="$WORK/g5m/supabase/candidates/postona_personal_mvp_auth"
for pair in MVP_INSTALL.sql:eebaabf2629575901947c0664d6f0002526d3273 MVP_R1_EXECUTE_GRANT.sql:9a8a94d159412868ed21968cea385f18188e626e \
            MVP_R1_EXECUTE_REVOKE.sql:a4de2fe0b2b5c1d406c1127fa9613b32141a3026; do
  [ "$(git hash-object "$MVP/${pair%%:*}")" = "${pair##*:}" ] || fail "G5's ${pair%%:*} is not PR #563's blob"
done
[ "$(git hash-object "$WORK/g5w/supabase/migrations/20261010051938_common_account_service_write_guard.sql")" = da587631cfe8872e3ccf6fd521b919a5439c6574 ] \
  || fail "the world's T13 is not the reviewed blob"
m="$WORK/g5w/supabase/migrations"; t="$WORK/g5w/supabase/tests"

MADE_AUTHENTICATOR="$("${S[@]}" -d postgres -c "select (to_regrole('authenticator') is null)::text")"
# ---- g5: G5's world, built exactly as PR #563's runner builds its "ne" world (no owner epoch) ----------------------------------------------
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $OWNER login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role to $OWNER;
SQL
"${S[@]}" -d postgres -c "create database $DB_G5 owner $OWNER" >/dev/null
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$HOST" -p "$PORT" -U "$OWNER" -d "$DB_G5" "$@"; }
own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified 20260928160000_social_mobile_account_deletion_candidate; do own -f "$m/$f.sql" >/dev/null; done
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
# TEST-WORLD stand-in for G3's L-1 revoke (P3) and auth.uid() reading both claim sources, as PR #563's runner; managed behaviour NOT_VERIFIED
own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null

# ---- led: G6's ledger side (as common_ai_gateway_restart_race_pg_run.sh + the G6-20 candidate) ------------------------------------------
"${S[@]}" -d postgres -c "create database $DB_LED" >/dev/null
"${S[@]}" -d "$DB_LED" >/dev/null <<'SQL'
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
for f in migrations/20261010050613_ai_provider_budget_ledger.sql migrations/20261017120000_ai_consumer_call_store.sql migrations/20261017150000_ai_ledger_user_erasure.sql \
         migrations/20261020154536_ai_calls_owner_held_rc_guard.sql candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql; do
  "${S[@]}" -d "$DB_LED" -f "$REPO/supabase/$f" >/dev/null
done
"${S[@]}" -d "$DB_LED" -c "insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
  values ('g6pa.postona.post', 'openai', 'gpt-6-luna', 'postona', 'post_generation', 'user', true, 'day', 200, 5, 0.2)" >/dev/null

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_WEBHOOK_SIGNING_KEY -u ANTHROPIC_CUSTOM_HEADERS -u OPENAI_API_KEY \
    G6PA_E2E=1 G6PA_PGHOST="$HOST" G6PA_PGPORT="$PORT" G6PA_PGSUPER="$SUPER" G6PA_OWNER="$OWNER" G6PA_DB_G5="$DB_G5" G6PA_DB_LED="$DB_LED" G6PA_MVP="$MVP" \
  deno test --cached-only --frozen --config "$CONFIG" --deny-net --deny-write --allow-run=psql \
    --allow-env=G6PA_E2E,G6PA_PGHOST,G6PA_PGPORT,G6PA_PGSUPER,G6PA_OWNER,G6PA_DB_G5,G6PA_DB_LED,G6PA_MVP,ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY \
    --allow-read="$MVP" "$HERE/common_ai_gateway_post_assist_g5_48_pg_test.ts" >"$WORK/test.log" 2>&1 \
  || { cat "$WORK/test.log" >&2; fail "post assist x G5-48 x real ledger"; }
if grep -q "[1-9][0-9]* ignored" "$WORK/test.log"; then cat "$WORK/test.log" >&2; fail "tests were ignored (environment not passed)"; fi
grep -Eq '[1-9][0-9]* passed' "$WORK/test.log" || { cat "$WORK/test.log" >&2; fail "no test ran"; }
sed 's/\x1b\[[0-9;]*m//g' "$WORK/test.log" | grep -a -E '^G6-25 ' || true
echo "PASS post assist Edge x G5-48 R1-MVP (grant/stop) x real ledger + ai_calls: $(sed 's/\x1b\[[0-9;]*m//g' "$WORK/test.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1)"
