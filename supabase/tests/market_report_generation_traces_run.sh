#!/usr/bin/env bash
# Disposable-PostgreSQL proof of 20261007120000_market_report_generation_traces.sql. Never touches Supabase.
#
#   TRC_PGHOST=/tmp/<socket dir> TRC_PGPORT=54878 TRC_PGSUPER=<superuser> bash supabase/tests/market_report_generation_traces_run.sh
#
# The host must be a local socket directory under /tmp (the runner refuses anything else), so a mistyped
# host can never point this at a real project. A scratch database is created and dropped.
set -euo pipefail
export LC_ALL=C

HOST="${TRC_PGHOST:?TRC_PGHOST (local socket dir under /tmp or /private/tmp) is required}"
PORT="${TRC_PGPORT:-5432}"
SUPER="${TRC_PGSUPER:-postgres}"
case "$HOST" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../migrations/20261007120000_market_report_generation_traces.sql"
DB="trc_proof_$$"
psql_super() { psql -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
cleanup() { psql_super -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql_super -d postgres -c "create database $DB" >/dev/null
# The roles Supabase provides; created only inside this scratch cluster when missing.
psql_super -d "$DB" <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$$;
grant usage on schema public to anon, authenticated, service_role;
SQL

psql_super -d "$DB" -f "$MIGRATION" >/dev/null
echo "migration applied to scratch database $DB"
# Re-applying must fail cleanly (create table, not create-or-replace): the migration is one-shot.
if psql_super -d "$DB" -f "$MIGRATION" >/dev/null 2>&1; then echo "FAIL: migration applied twice" >&2; exit 1; fi
psql_super -d "$DB" -f "$HERE/market_report_generation_traces_behavior.sql"
