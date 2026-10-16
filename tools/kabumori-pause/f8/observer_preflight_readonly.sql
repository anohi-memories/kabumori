-- F8 observer (news-discovery-observer) pre-pause read-only preflight. NOT executed by F8 (no production access).
-- One SELECT, aggregate-only: no urls, titles, summaries, raw_reference, ids or secrets are returned.
select jsonb_build_object(
  'measured_at', now(),
  'runs_last_24h_by_status', (
    select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    from (select status, count(*) n from public.news_discovery_runs where started_at >= now() - interval '24 hours' group by status) s),
  'runs_last_24h_by_trigger', (
    select coalesce(jsonb_object_agg(trigger_type, n), '{}'::jsonb)
    from (select trigger_type, count(*) n from public.news_discovery_runs where started_at >= now() - interval '24 hours' group by trigger_type) s),
  'running_runs', (
    select jsonb_build_object('count', count(*), 'oldest_age_minutes', round(extract(epoch from now() - min(started_at)) / 60))
    from public.news_discovery_runs where status = 'running'),
  'last_run_started_at', (select max(started_at) from public.news_discovery_runs),
  'searches_today_by_status', (
    -- paid web search attempts (reserved before the provider call); the budget row is read separately
    select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    from (select status, count(*) n from public.news_discovery_searches where reserved_at >= date_trunc('day', now()) group by status) s),
  'search_budget', (
    select jsonb_build_object('daily_soft_budget', daily_soft_budget, 'daily_hard_limit', daily_hard_limit, 'updated_at', updated_at)
    from public.news_discovery_search_config where id),
  'signals_last_24h', (select count(*) from public.news_discovery_signals where fetched_at >= now() - interval '24 hours'),
  'cron_jobs_mentioning_discovery', (
    -- name / schedule / active / command hash only (the command text can carry secret lookups and is never returned)
    select coalesce(jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'active', active, 'command_md5', md5(command))
                             order by jobname), '[]'::jsonb)
    from cron.job where command ~* 'news-discovery-observer')
) as observer_preflight;
