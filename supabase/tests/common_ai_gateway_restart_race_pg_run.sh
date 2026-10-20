#!/usr/bin/env bash
# Disposable-PostgreSQL run of the G6-07 restart / concurrent-recovery harness: separate gateway and recovery PROCESSES
# (supabase/tests/common_ai_gateway_restart_race_worker.ts) against the real ledger (20261010050613), call store
# (20261017120000) and maintenance (20261017150000) migrations. Never touches Supabase, never uses the network.
#
#   GRR_PGHOST=/private/tmp/<socket dir> GRR_PGPORT=54991 GRR_PGSUPER=<superuser> bash supabase/tests/common_ai_gateway_restart_race_pg_run.sh [test file]
#
# The test file is common_ai_gateway_restart_race_pg_test.ts (G6-07, the default) or
# common_ai_gateway_fence_review_pg_test.ts (G6-08: the pre-send claim check under review) or
# common_ai_gateway_r1_r2_corrective_pg_test.ts (G6-09: the R1 / R2 corrective) or
# common_ai_gateway_lost_reserve_pg_test.ts (G6-10: an ambiguous reserve failure) or
# common_ai_gateway_owner_held_contract_pg_test.ts (G6-11: the candidate non-creating owner-held check, created by
# that test in this scratch database only); nothing else is accepted.
#
# The host must be a local socket directory under /tmp (anything else is refused) and the server must have no TCP
# listener. One scratch database is created and dropped; no role is created (the three Supabase API roles are
# created only if the cluster lacks them, as nologin roles). The fake G5 / provider log tables live in that database only.
set -euo pipefail
export LC_ALL=C

HOST="${GRR_PGHOST:?GRR_PGHOST (local socket dir under /tmp or /private/tmp) is required}"
PORT="${GRR_PGPORT:-5432}"
SUPER="${GRR_PGSUPER:-postgres}"
case "$HOST" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;;
esac
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE

HERE="$(cd "$(dirname "$0")" && pwd)"
TEST="${1:-common_ai_gateway_restart_race_pg_test.ts}"
case "$TEST" in
  common_ai_gateway_restart_race_pg_test.ts|common_ai_gateway_fence_review_pg_test.ts|common_ai_gateway_r1_r2_corrective_pg_test.ts|common_ai_gateway_lost_reserve_pg_test.ts|common_ai_gateway_owner_held_contract_pg_test.ts) ;;
  *) echo "refusing test file '$TEST'" >&2; exit 2 ;;
esac
LEDGER="$HERE/../migrations/20261010050613_ai_provider_budget_ledger.sql"
STORE="$HERE/../migrations/20261017120000_ai_consumer_call_store.sql"
MAINTENANCE="$HERE/../migrations/20261017150000_ai_ledger_user_erasure.sql"
CONFIG="$HERE/../functions/_shared/ai_consumer_bridge/deno.json"
DB="grr_proof_$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/grr_proof.XXXXXX")"

psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  psql_super -d postgres -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  find "$WORK" -type f -delete 2>/dev/null || true
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# isolation: a local socket-only server.
[ "$(psql_super -d postgres -Atc "show listen_addresses")" = "" ] || fail "the server listens on TCP; use a socket-only scratch cluster"

psql_super -d postgres -c "create database $DB" >/dev/null
psql_super -d "$DB" >/dev/null <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL
psql_super -d "$DB" -f "$LEDGER" >/dev/null
psql_super -d "$DB" -f "$STORE" >/dev/null
psql_super -d "$DB" -f "$MAINTENANCE" >/dev/null
# The harness's own tables (superuser only; no grant to any API role): the fake G5, the pause points and gates of
# the worker processes, and every request a fake provider received.
psql_super -d "$DB" >/dev/null <<'SQL'
create schema g6r_fake;
revoke all on schema g6r_fake from public;
create table g6r_fake.sessions (jwt text primary key, user_id uuid not null, session_ref text not null, state text not null);
create table g6r_fake.entitlements (user_id uuid not null, entitlement text not null, primary key (user_id, entitlement));
create table g6r_fake.brands (slug text primary key, owner uuid not null, owner_epoch bigint not null, lifecycle bigint not null);
create table g6r_fake.events (seq bigserial primary key, worker text not null, point text not null, at timestamptz not null default clock_timestamp());
create table g6r_fake.gates (worker text primary key);
create table g6r_fake.provider_requests (seq bigserial primary key, worker text not null, operation_id text not null, provider text not null,
  at timestamptz not null default clock_timestamp());
SQL

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_WEBHOOK_SIGNING_KEY \
    -u ANTHROPIC_CUSTOM_HEADERS -u OPENAI_API_KEY \
    GRR_PGHOST="$HOST" GRR_PGPORT="$PORT" GRR_PGSUPER="$SUPER" GRR_DB="$DB" GRR_DENO_CONFIG="$CONFIG" \
  deno test --cached-only --frozen --config "$CONFIG" \
    --deny-net --deny-write --allow-run=psql,deno \
    --allow-env=GRR_PGHOST,GRR_PGPORT,GRR_PGSUPER,GRR_DB,GRR_DENO_CONFIG \
    "$HERE/$TEST" >"$WORK/test.log" 2>&1 \
  || { cat "$WORK/test.log" >&2; fail "gateway restart / concurrent recovery ($TEST)"; }
if grep -q "[1-9][0-9]* ignored" "$WORK/test.log"; then cat "$WORK/test.log" >&2; fail "tests were ignored (environment not passed)"; fi
grep -Eq '[1-9][0-9]* passed' "$WORK/test.log" || { cat "$WORK/test.log" >&2; fail "no test ran"; }
# Measured distributions the tests print (e.g. the G6-08 4-way race orders).
sed 's/\x1b\[[0-9;]*m//g' "$WORK/test.log" | grep -a -E '^G6-[0-9]+ ' || true
echo "PASS restart / concurrent recovery across processes x real ledger + ai_calls ($TEST): $(sed 's/\x1b\[[0-9;]*m//g' "$WORK/test.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1)"
