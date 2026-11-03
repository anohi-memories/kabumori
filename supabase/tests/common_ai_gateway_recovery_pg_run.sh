#!/usr/bin/env bash
# Disposable-PostgreSQL run of the G6-06 UNKNOWN recovery coordinator (supabase/functions/_shared/ai_gateway/recovery.ts) against the real ledger
# (20261010050613), call store (20261017120000) and maintenance (20261017150000) migrations. Never touches Supabase, never uses the network.
#
#   GWV_PGHOST=/private/tmp/<socket dir> GWV_PGPORT=54931 GWV_PGSUPER=<superuser> bash supabase/tests/common_ai_gateway_recovery_pg_run.sh
#
# The host must be a local socket directory under /tmp (anything else is refused) and the server must have no TCP
# listener. One scratch database is created and dropped; no role is created (the three Supabase API roles are
# created only if the cluster lacks them, as nologin roles).
set -euo pipefail
export LC_ALL=C

HOST="${GWV_PGHOST:?GWV_PGHOST (local socket dir under /tmp or /private/tmp) is required}"
PORT="${GWV_PGPORT:-5432}"
SUPER="${GWV_PGSUPER:-postgres}"
case "$HOST" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;;
esac
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE

HERE="$(cd "$(dirname "$0")" && pwd)"
LEDGER="$HERE/../migrations/20261010050613_ai_provider_budget_ledger.sql"
STORE="$HERE/../migrations/20261017120000_ai_consumer_call_store.sql"
# ai_calls_recovery_candidates lives in the erasure / maintenance migration (PR256).
MAINTENANCE="$HERE/../migrations/20261017150000_ai_ledger_user_erasure.sql"
DB="gwv_proof_$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gwv_proof.XXXXXX")"

psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  psql_super -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true
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

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_WEBHOOK_SIGNING_KEY \
    -u ANTHROPIC_CUSTOM_HEADERS -u OPENAI_API_KEY \
    GWV_PGHOST="$HOST" GWV_PGPORT="$PORT" GWV_PGSUPER="$SUPER" GWV_DB="$DB" \
  deno test --cached-only --frozen --config "$HERE/../functions/_shared/ai_consumer_bridge/deno.json" \
    --deny-net --deny-write --allow-run=psql \
    --allow-env=GWV_PGHOST,GWV_PGPORT,GWV_PGSUPER,GWV_DB,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_CUSTOM_HEADERS \
    "$HERE/common_ai_gateway_recovery_pg_test.ts" >"$WORK/test.log" 2>&1 \
  || { cat "$WORK/test.log" >&2; fail "gateway UNKNOWN recovery"; }
if grep -q "[1-9][0-9]* ignored" "$WORK/test.log"; then cat "$WORK/test.log" >&2; fail "tests were ignored (environment not passed)"; fi
grep -Eq '[1-9][0-9]* passed' "$WORK/test.log" || { cat "$WORK/test.log" >&2; fail "no test ran"; }
echo "PASS UNKNOWN recovery coordinator x real ledger + ai_calls: $(sed 's/\x1b\[[0-9;]*m//g' "$WORK/test.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1)"
