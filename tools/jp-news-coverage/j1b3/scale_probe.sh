#!/bin/bash
# Synthetic scale probe: N market-wide rows (mixed status/severity, unique titles) in the two variant DBs created by
# real_matrix.sh (current, a); prints wall time of the feed RPC as `authenticated` for an all_useful user. Disposable only.
set -uo pipefail
n="${N:-3000}"; export LC_ALL=C
for v in current a; do
  db="j1b3_v_$v"
  psql "$@" -d "$db" -qAt -v ON_ERROR_STOP=1 -c "
    insert into public.important_news_candidates
      (source_type, source_priority, source_url, source_name, title, normalized_title, category, published_at, content_hash,
       status, importance, coverage_severity, japan_market_relevance, fact_check_status)
    select 'market_macro', 1, 'https://www.example.go.jp/s' || g, 'jp_official', '[S' || g || '] 合成ニュース' || g || 'について' || md5(g::text),
           'ns' || g, 'other_market_moving', now() - make_interval(mins => g), md5('s' || g) || md5('t' || g),
           (array['rejected','published','ready_for_generation'])[1 + g % 3], 'no_post',
           (array['medium','high','critical','low'])[1 + g % 4], 'medium', 'passed'
    from generate_series(1, $n) as g;" >/dev/null
  s=$(date +%s.%N)
  psql "$@" -d "$db" -qAt -c "set role authenticated; set request.jwt.claim.sub = '10000000-0000-0000-0000-000000000005'; select count(*) from public.get_my_important_stock_news(50);" | tail -1 | sed "s/^/$v rows=/"
  e=$(date +%s.%N); echo "$v elapsed_s=$(echo "$e - $s" | bc)"
done
