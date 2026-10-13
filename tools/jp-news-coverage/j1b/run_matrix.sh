#!/bin/bash
# Offline proof of the feed RPC visibility on a throwaway local Postgres. Usage: run_matrix.sh <psql-prefix-args...>
# Needs: python3, a local postgres reachable through the given psql args. Never touches a remote database.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
variant="${VARIANT:-current}"
tmp="$(mktemp -t j1b_rpc).sql"
python3 "$here/build_rpc_sql.py" "$tmp" >/dev/null
if [ "$variant" != "current" ]; then
  python3 "$here/apply_variant.py" "$tmp" "$variant"
fi
psql "$@" -qAt -v ON_ERROR_STOP=1 -c "set client_min_messages = warning; drop schema if exists public cascade; create schema public;" >/dev/null 2>&1
psql "$@" -qAt -v ON_ERROR_STOP=1 -c "set client_min_messages = warning" -f "$here/stub_schema.sql" >/dev/null 2>&1
psql "$@" -qAt -v ON_ERROR_STOP=1 -f "$tmp" >/dev/null
psql "$@" -qAt -v ON_ERROR_STOP=1 -f "$here/scenarios.sql" >/dev/null
for user in 1 2 3 4 5; do
  uid="10000000-0000-0000-0000-00000000000$user"
  rows="$(psql "$@" -qAt -v ON_ERROR_STOP=1 -c "set app.uid = '$uid'; select string_agg(substring(title from '\\[C[0-9]+\\]'), ',' order by news_time desc) from public.get_my_important_stock_news(50);" | tail -1)"
  echo "u$user: ${rows:-<none>}"
done
# Optional: function privileges / definer flags of the feed RPCs (ACL=1). Used to show the candidate keeps them.
if [ "${ACL:-0}" = "1" ]; then
  psql "$@" -qAt -v ON_ERROR_STOP=1 -c "select p.proname || ' secdef=' || p.prosecdef || ' acl=' || coalesce(p.proacl::text, 'NULL') || ' anon_exec=' || has_function_privilege('anon', p.oid, 'execute') || ' auth_exec=' || has_function_privilege('authenticated', p.oid, 'execute') || ' service_exec=' || has_function_privilege('service_role', p.oid, 'execute') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%important%' order by p.proname"
fi
