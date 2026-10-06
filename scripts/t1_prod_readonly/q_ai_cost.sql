select (created_at at time zone 'Asia/Tokyo')::date::text as jst_date,
  split_part(feature, '|', 1) as feature,
  count(*) as calls,
  round(avg(input_tokens)) as avg_in, round(avg(output_tokens)) as avg_out,
  round(sum(cost_usd)::numeric, 4) as usd,
  sum(web_search_calls) as web_search_calls
from ai_usage_events
where created_at >= now() - interval '14 days'
  and (feature like 'news_judgement%' or feature like 'news_generation%' or feature like 'news_breaking%' or feature like 'news_trigger%')
group by 1, 2 order by 1, 2
