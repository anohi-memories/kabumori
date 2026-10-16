-- F8 news pause PRE-FLIGHT (read-only, aggregate-only). NOT executed by F8: there was no production access in this task.
-- One SELECT, one json document; no ids, urls, titles, bodies, tokens, users or raw cron commands are returned.
-- Run it yourself (or a later approved task) immediately before the pause; every value it prints is a CURRENT measurement,
-- not a number to carry over from earlier reports. All counts are NOT_VERIFIED until this runs.
select jsonb_build_object(
  'measured_at', now(),
  'settings', (
    select jsonb_build_object('is_active', is_active, 'auto_publish', auto_publish, 'luna_enabled', luna_enabled,
                              'sol_escalation_enabled', sol_escalation_enabled, 'updated_at', updated_at)
    from public.important_news_monitor_settings where id),
  'candidates_by_status', (
    select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    from (select status, count(*) n from public.important_news_candidates group by status) s),
  'in_flight_candidates', (
    -- rows a stopped worker can leave behind: claimed for generation / being published
    select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', n, 'oldest_age_minutes', oldest)), '[]'::jsonb)
    from (select status, count(*) n, round(extract(epoch from now() - min(updated_at)) / 60) oldest
          from public.important_news_candidates where status in ('generating', 'publishing') group by status) s),
  'ready_for_publish', (
    select jsonb_build_object('count', count(*), 'oldest_age_hours', round(extract(epoch from now() - min(updated_at)) / 3600))
    from public.important_news_candidates where status = 'ready_for_publish'),
  'publish_unknown_outcome_candidates', (
    -- publishing rows stay as they are after an unknown X outcome; they must be reconciled by hand, never retried blindly
    select count(*) from public.important_news_candidates where status in ('publishing', 'publish_failed')),
  'running_monitor_runs', (
    select jsonb_build_object('count', count(*), 'oldest_age_minutes', round(extract(epoch from now() - min(started_at)) / 60))
    from public.important_news_monitor_runs where status = 'running'),
  'last_monitor_run', (
    select jsonb_build_object('started_at', max(started_at)) from public.important_news_monitor_runs),
  'monitor_runs_last_24h_by_status', (
    select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
    from (select status, count(*) n from public.important_news_monitor_runs where started_at >= now() - interval '24 hours' group by status) s),
  'push_queue_important_news', (
    select coalesce(jsonb_object_agg(push_status, jsonb_build_object('count', n, 'oldest_age_minutes', oldest)), '{}'::jsonb)
    from (select push_status, count(*) n, round(extract(epoch from now() - min(created_at)) / 60) oldest
          from public.notifications where source_type = 'important_news' and push_status in ('pending', 'processing') group by push_status) s),
  'ai_usage_last_60_minutes_by_feature', (
    select coalesce(jsonb_object_agg(feature, n), '{}'::jsonb)
    from (select feature, count(*) n from public.ai_usage_events where created_at >= now() - interval '60 minutes' group by feature) s),
  'news_discovery_observer', (
    select jsonb_build_object('last_started_at', max(started_at), 'runs_last_24h', count(*) filter (where started_at >= now() - interval '24 hours'))
    from public.news_discovery_runs),
  'cron_jobs', (
    -- name / schedule / active only; the command text is intentionally NOT returned (it can contain secret lookups)
    select coalesce(jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'active', active,
                                                  'command_md5', md5(command)) order by jobname), '[]'::jsonb)
    from cron.job
    where jobname like 'important-news-%' or jobname like '%news%' or jobname like '%discovery%' or jobname like '%push%')
) as f8_pause_preflight;
