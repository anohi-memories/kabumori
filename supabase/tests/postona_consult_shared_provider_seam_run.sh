#!/usr/bin/env bash
# Runs the POSTONA consult seam tests: the offline one (fakes everywhere), then the same seam against the real ledger
# and call-store migrations in a disposable local PostgreSQL. Never touches Supabase or OpenAI.
#
#   ACS_PGHOST=/private/tmp/<socket dir> ACS_PGPORT=54915 ACS_PGSUPER=<superuser> bash supabase/tests/postona_consult_shared_provider_seam_run.sh
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
CONFIG="$HERE/../functions/_shared/ai_consumer_bridge/deno.json"
DB="consult_seam_$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/consult_seam.XXXXXX")"
psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
trap 'psql_super -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; find "$WORK" -type f -delete 2>/dev/null || true; rmdir "$WORK" 2>/dev/null || true' EXIT
SECRETS=(-u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_WEBHOOK_SIGNING_KEY -u ANTHROPIC_CUSTOM_HEADERS -u OPENAI_API_KEY)

ISO="$(psql_super -d postgres -Atc "select current_setting('listen_addresses') || '|' || coalesce(inet_server_addr()::text, 'unix-socket')")"
[ "$ISO" = "|unix-socket" ] || fail "isolation: TCP listener or TCP connection ($ISO)"
echo "PASS isolation: no TCP listener, unix socket only"

env "${SECRETS[@]}" deno test --cached-only --frozen --config "$CONFIG" --deny-net --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS \
  "$HERE/postona_consult_shared_provider_seam_test.ts" >"$WORK/offline.log" 2>&1 || { cat "$WORK/offline.log" >&2; fail "offline seam tests"; }
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
for f in 20261010050613_ai_provider_budget_ledger.sql 20261017120000_ai_consumer_call_store.sql; do
  psql_super -d "$DB" -f "$HERE/../migrations/$f" >/dev/null
done
env "${SECRETS[@]}" ACS_PGHOST="$HOST" ACS_PGPORT="$PORT" ACS_PGSUPER="$SUPER" ACS_DB="$DB" \
  deno test --cached-only --frozen --config "$CONFIG" --deny-net --deny-write --allow-run=psql \
    --allow-env=ACS_PGHOST,ACS_PGPORT,ACS_PGSUPER,ACS_DB,ANTHROPIC_CUSTOM_HEADERS \
    "$HERE/postona_consult_shared_provider_seam_pg_test.ts" >"$WORK/pg.log" 2>&1 \
  || { cat "$WORK/pg.log" >&2; fail "seam against the real ledger and call store"; }
if grep -q "[1-9][0-9]* ignored" "$WORK/pg.log"; then cat "$WORK/pg.log" >&2; fail "pg seam tests were ignored"; fi
echo "PASS real ledger + call store: $(sed 's/\x1b\[[0-9;]*m//g' "$WORK/pg.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1)"
echo "ALL PASSED"
