-- Local proposal only: production application is intentionally deferred.
-- The function's auto-publish cutover guard prevents pre-enable backlog rows from being selected.
do $migration$
begin
  if not exists (
    select 1 from cron.job where jobname = 'important-news-publish-ready'
  ) then
    perform cron.schedule(
      'important-news-publish-ready',
      '*/5 * * * *',
      $cron$
        select net.http_post(
          url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/important-news-monitor',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := '{"mode":"publish_ready"}'::jsonb,
          timeout_milliseconds := 150000
        )
        from public.important_news_monitor_settings
        where id = true and is_active = true and auto_publish = true;
      $cron$
    );
  end if;
end
$migration$;
