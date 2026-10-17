-- Supabase query_logs ClickHouse; not PostgreSQL.
-- project_id: wsmznyzcvmuitkglfeuj
-- iso_timestamp_start: 2026-10-16T10:20:00Z
-- iso_timestamp_end: 2026-10-17T10:20:00Z
-- Reference fields discovered by mapKeys(log_attributes); do not retrieve raw auth headers.

select source,count(*) as count,min(timestamp) as first_at,max(timestamp) as last_at
from logs group by source order by source;

select log_attributes['request.pathname'] as path,
 log_attributes['response.status_code'] as status,
 log_attributes['request.headers.user_agent'] as user_agent,
 count(*) as count,min(timestamp) as first_at,max(timestamp) as last_at,
 countIf(timestamp>='2026-10-17 02:00:00') as after_0200_utc
from logs where source='function_edge_logs'
group by path,status,user_agent order by path,status,user_agent;
