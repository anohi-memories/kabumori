select ((published_at at time zone 'Asia/Tokyo')::time >= time '08:00')::int as _x,
  (extract(hour from published_at at time zone 'Asia/Tokyo'))::int as jst_hour,
  count(*) as items,
  count(distinct (published_at at time zone 'Asia/Tokyo')::date) as days,
  round(percentile_cont(0.5) within group (order by extract(epoch from (created_at - published_at))/60)::numeric, 1) as lag_p50_min,
  round(percentile_cont(0.9) within group (order by extract(epoch from (created_at - published_at))/60)::numeric, 1) as lag_p90_min,
  round(max(extract(epoch from (created_at - published_at))/60)::numeric, 1) as lag_max_min,
  count(*) filter (where category <> 'other_corporate_ir') as non_generic_cat,
  count(*) filter (where title ~ 'ETF|上場投資信託|REIT|投資法人|NAV|基準価額') as etf_reit_like
from important_news_candidates
where source_type = 'tdnet' and published_at >= now() - interval '14 days'
group by 1, 2 order by 2
