select (started_at at time zone 'Asia/Tokyo')::date::text as jst_date,
  count(*) as runs,
  count(*) filter (where status = 'completed') as completed,
  round(percentile_cont(0.5) within group (order by extract(epoch from (completed_at - started_at)))::numeric, 1) as dur_p50_s,
  round(percentile_cont(0.9) within group (order by extract(epoch from (completed_at - started_at)))::numeric, 1) as dur_p90_s,
  round(max(extract(epoch from (completed_at - started_at)))::numeric, 1) as dur_max_s,
  sum(fetched_count) as fetched, sum(new_candidate_count) as new_cand, sum(duplicate_count) as dup
from important_news_monitor_runs
where started_at >= now() - interval '7 days' and completed_at is not null
group by 1 order by 1
