#!/bin/bash
# Real-schema proof. Usage: real_matrix.sh <template_db> <psql connection args...>   (disposable local cluster only)
# For each variant: clone the template (real migrations applied), apply the candidate variant, seed synthetic data, call the
# RPC AS the `authenticated` role for each user, and print the visible case ids. ACL=1 adds privilege/signature rows.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tpl="$1"; shift
export LC_ALL=C
for variant in ${VARIANTS:-current a b c}; do
  db="j1b3_v_${variant}"
  psql "$@" -d postgres -qAt -c "drop database if exists $db" -c "create database $db template $tpl" >/dev/null 2>&1
  if [ "$variant" != "current" ]; then
    python3 "$here/make_variant.py" "$variant" > "$here/.variant.sql"
    psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -f "$here/.variant.sql" >/dev/null 2>"$here/.err" || { echo "variant $variant FAILED: $(head -c 300 "$here/.err")"; continue; }
  fi
  psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -f "$here/real_scenarios.sql" >/dev/null 2>"$here/.err" || { echo "seed FAILED: $(head -c 300 "$here/.err")"; continue; }
  echo "## $variant"
  for user in 1 2 3 4 5; do
    rows="$(psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -c "set role authenticated; set request.jwt.claim.sub = '10000000-0000-0000-0000-00000000000$user'; select coalesce(string_agg(substring(title from '\\[C[0-9]+\\]'), ',' order by news_time desc), '') from public.get_my_important_stock_news(50);" | tail -1)"
    echo "u$user: ${rows:-<none>}"
  done
  if [ "${ACL:-0}" = "1" ]; then
    psql "$@" -d "$db" -qAt -c "select 'sig ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || md5(pg_get_function_result(p.oid)) || ' secdef=' || p.prosecdef || ' cfg=' || coalesce(p.proconfig::text,'') || ' owner=' || pg_get_userbyid(p.proowner) || ' acl=' || coalesce(p.proacl::text,'NULL') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'get_my_important_stock_news%' or p.proname like 'important_news_feed_%' or p.proname like 'enqueue_%important%' or p.proname = 'enqueue_market_critical_notifications' or p.proname in ('important_news_same_event','important_news_market_themes','important_news_theme_sectors','important_news_app_copy_targets')) order by 1"
  fi
done
