select (published_at at time zone 'Asia/Tokyo')::date::text as jst_date,
  count(*) as items,
  count(*) filter (where body_summary is null) as no_body,
  count(*) filter (where status = 'duplicate') as dup,
  count(*) filter (where duplicate_of is null) as representatives,
  round(percentile_cont(0.5) within group (order by extract(epoch from (created_at - published_at))/60)::numeric, 1) as lag_p50_min,
  round(percentile_cont(0.9) within group (order by extract(epoch from (created_at - published_at))/60)::numeric, 1) as lag_p90_min,
  round(max(extract(epoch from (created_at - published_at))/60)::numeric, 1) as lag_max_min
from important_news_candidates
where source_type = 'tdnet' and published_at >= now() - interval '14 days'
group by 1 order by 1
