#!/bin/bash
# Times the feed RPC (as `authenticated`, all_useful user) for variants on synthetic N rows, with a statement_timeout.
# Usage: N=400 VARIANTS="current a" timing.sh <template_db> <psql args...>   (disposable cluster only)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; tpl="$1"; shift
export LC_ALL=C PGOPTIONS="-c statement_timeout=${TIMEOUT_MS:-120000}"
n="${N:-400}"
for v in ${VARIANTS:-current a}; do
  db="j1b4_t_$v"
  psql "$@" -d postgres -qAt -c "drop database if exists $db" -c "create database $db template $tpl" >/dev/null 2>&1
  if [ "$v" != "current" ]; then
    f="$here/.t_$v.sql"
    case "$v" in
      a|b|c) python3 "$here/make_variant.py" "$v" > "$f" ;;
      *) cp "$here/../j1b4/candidate/$v.sql" "$f" ;;
    esac
    psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "$v: apply FAILED"; continue; }
  fi
  psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -f "$here/real_scenarios.sql" >/dev/null 2>&1
  psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -v n="$n" -f "$here/seed_scale.sql" >/dev/null 2>&1
  s=$(python3 -c 'import time;print(time.time())')
  out="$(psql "$@" -d "$db" -qAt -c "set role authenticated; set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000005'; select count(*) || ' rows ' || coalesce(string_agg(distinct severity, ','), '') from public.get_my_important_stock_news(50);" 2>&1 | tail -1)"
  e=$(python3 -c 'import time;print(time.time())')
  printf '%s N=%s %s elapsed_s=%.2f\n' "$v" "$n" "$out" "$(python3 -c "print($e-$s)")"
done
