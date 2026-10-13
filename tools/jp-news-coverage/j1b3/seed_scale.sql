-- synthetic N market-wide rows for timing; :n is a psql variable
insert into public.important_news_candidates
  (source_type, source_priority, source_url, source_name, title, normalized_title, category, published_at, content_hash,
   status, importance, coverage_severity, japan_market_relevance, fact_check_status)
select 'market_macro', 1, 'https://www.example.go.jp/s' || g, 'jp_official',
       '[S' || g || '] 合成ニュース' || g || 'について' || md5(g::text) || case when g % 10 = 0 then ' 3.5% 12,000' else '' end,
       'ns' || g, (array['other_market_moving','fx','administrative_action'])[1 + g % 3], now() - make_interval(mins => g),
       md5('s' || g) || md5('t' || g),
       (array['rejected','published','ready_for_generation'])[1 + g % 3], 'no_post',
       (array['medium','high','critical','low'])[1 + g % 4], 'medium', 'passed'
from generate_series(1, :n) as g;
