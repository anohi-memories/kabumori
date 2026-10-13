#!/bin/bash
# Differential test: the rewritten feed (precomputed signature / event key, hash anti-join) must return EXACTLY the same
# ordered rows as the original definitions on varied deterministic data, for six users.
#   base : original phase5_base (copied under another name) vs rewritten phase5_base
#   wrapper : PR #181 candidate (a) vs performance candidate (p_perf_a)
# Usage: equivalence.sh <template_db> <psql args...>   (disposable cluster only)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; j1b3="$here/../j1b3"; tpl="$1"; shift
CONN=("$@")
export LC_ALL=C PGOPTIONS="-c statement_timeout=170000"
fail=0; empty=0; nonempty_total=0
for shape in "30 600" "7 900" "400 700" "3 500"; do
  pool="${shape% *}"; n="${shape#* }"
  for v in a p_perf_a; do
    db="j1b4_eq_$v"
    psql "${CONN[@]}" -d postgres -qAt -c "drop database if exists $db" -c "create database $db template $tpl" >/dev/null 2>&1
    if [ "$v" = "a" ]; then python3 "$j1b3/make_variant.py" a > "$here/.eq.sql"; else cp "${CANDIDATE:-$here/candidate/p_perf_a.sql}" "$here/.eq.sql"; fi
    # keep an untouched copy of the ORIGINAL base under another name (before the candidate replaces it)
    psql "${CONN[@]}" -d "$db" -qAt -v ON_ERROR_STOP=1 -c "
      do \$\$ declare def text; begin
        select pg_get_functiondef('public.get_my_important_stock_news_phase5_base(integer)'::regprocedure) into def;
        def := replace(def, 'get_my_important_stock_news_phase5_base', 'get_my_important_stock_news_phase5_base_orig');
        execute def;
      end \$\$;" >/dev/null || { echo "FAIL: could not copy original base"; fail=1; continue; }
    psql "${CONN[@]}" -d "$db" -qAt -v ON_ERROR_STOP=1 -f "$here/.eq.sql" >/dev/null 2>&1 || { echo "FAIL: apply $v"; fail=1; continue; }
    psql "${CONN[@]}" -d "$db" -qAt -v ON_ERROR_STOP=1 -v pool="$pool" -v n="$n" -f "$here/equivalence_seed.sql" >/dev/null 2>"$here/.eq.err" || { echo "FAIL: seed: $(head -c 200 "$here/.eq.err")"; fail=1; continue; }
  done
  for user in 1 2 3 4 5 6; do
    uid="10000000-0000-0000-0000-00000000000$user"
    run() { psql "${CONN[@]}" -d "$1" -qAt -c "$3 set request.jwt.claim.sub = '$uid'; select coalesce(string_agg(regexp_replace(title, '^\\[(E[0-9]+)\\].*', '\\1') || ':' || tracking_type || ':' || severity, ',' order by news_time desc, news_id), '') from $2;" | tail -1; }
    # base: original vs rewritten (rewritten lives in the p_perf_a database, original copy in the same database)
    b_new="$(run j1b4_eq_p_perf_a "public.get_my_important_stock_news_phase5_base(50)" "")"
    b_old="$(run j1b4_eq_p_perf_a "public.get_my_important_stock_news_phase5_base_orig(50)" "")"
    [ "$b_new" = "$b_old" ] || { echo "FAIL base differs (pool=$pool n=$n user=$user)"; fail=1; }
    w_new="$(run j1b4_eq_p_perf_a "public.get_my_important_stock_news(50)" "set role authenticated;")"
    w_old="$(run j1b4_eq_a "public.get_my_important_stock_news(50)" "set role authenticated;")"
    [ "$w_new" = "$w_old" ] || { echo "FAIL wrapper differs (pool=$pool n=$n user=$user)"; fail=1; }
    if [ -z "$b_old" ]; then empty=$((empty+1)); fi
    nonempty_total=$((nonempty_total+1))
  done
done
echo "feeds compared: $nonempty_total (empty: $empty)"
[ "$empty" -lt "$nonempty_total" ] || { echo "FAIL: every compared feed was empty"; fail=1; }
if [ "$fail" = "0" ]; then echo "J1-b4 equivalence: PASS (base and wrapper identical on 4 data shapes x 6 users)"; else echo "J1-b4 equivalence: FAIL"; exit 1; fi
