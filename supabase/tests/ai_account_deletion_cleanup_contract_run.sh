#!/usr/bin/env bash
# Runs the AI-cleanup contract tests: the offline one (fake rpc), then the same reference against the real
# PR249 -> PR256 -> PR261 migrations in a disposable local PostgreSQL. Never touches Supabase.
#
#   ACS_PGHOST=/private/tmp/<socket dir> ACS_PGPORT=54914 ACS_PGSUPER=<superuser> bash supabase/tests/ai_account_deletion_cleanup_contract_run.sh
set -euo pipefail
export LC_ALL=C

HOST="${ACS_PGHOST:?ACS_PGHOST (local socket dir under /tmp or /private/tmp) is required}"
PORT="${ACS_PGPORT:-5432}"
SUPER="${ACS_PGSUPER:-postgres}"
case "$HOST" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;;
esac
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE
HERE="$(cd "$(dirname "$0")" && pwd)"
DB="aue_contract_$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/aue_contract.XXXXXX")"
psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
trap 'psql_super -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; find "$WORK" -type f -delete 2>/dev/null || true; rmdir "$WORK" 2>/dev/null || true' EXIT

ISO="$(psql_super -d postgres -Atc "select current_setting('listen_addresses') || '|' || coalesce(inet_server_addr()::text, 'unix-socket')")"
[ "$ISO" = "|unix-socket" ] || fail "isolation: TCP listener or TCP connection ($ISO)"
echo "PASS isolation: no TCP listener, unix socket only"

deno test --no-config --deny-net --deny-write "$HERE/ai_account_deletion_cleanup_contract_test.ts" >"$WORK/offline.log" 2>&1 \
  || { cat "$WORK/offline.log" >&2; fail "offline contract tests"; }
echo "PASS offline: $(sed 's/\x1b\[[0-9;]*m//g' "$WORK/offline.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1)"

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
SQL
for f in 20261010050613_ai_provider_budget_ledger.sql 20261017120000_ai_consumer_call_store.sql 20261017150000_ai_ledger_user_erasure.sql; do
  psql_super -d "$DB" -f "$HERE/../migrations/$f" >/dev/null
done
for f in ai_provider_budget_ledger_fixture.sql ai_consumer_call_store_fixture.sql ai_ledger_user_erasure_fixture.sql; do
  psql_super -d "$DB" -f "$HERE/$f" >/dev/null
done
ACS_PGHOST="$HOST" ACS_PGPORT="$PORT" ACS_PGSUPER="$SUPER" ACS_DB="$DB" \
  deno test --no-config --deny-net --deny-write --allow-run=psql --allow-env=ACS_PGHOST,ACS_PGPORT,ACS_PGSUPER,ACS_DB \
    "$HERE/ai_account_deletion_cleanup_contract_pg_test.ts" >"$WORK/pg.log" 2>&1 \
  || { cat "$WORK/pg.log" >&2; fail "contract against the real SQL"; }
if grep -q "[1-9][0-9]* ignored" "$WORK/pg.log"; then cat "$WORK/pg.log" >&2; fail "pg contract tests were ignored"; fi
echo "PASS real SQL: $(sed 's/\x1b\[[0-9;]*m//g' "$WORK/pg.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1)"
echo "ALL PASSED"
