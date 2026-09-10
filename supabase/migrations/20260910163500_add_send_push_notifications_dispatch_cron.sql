-- Dispatcher cron for send-push-notifications.
--
-- The Edge Function itself decides nothing about *which* notifications exist; it
-- only drains rows that already sit at notifications.push_status='pending'
-- (respecting alert_settings opt-outs). Without a scheduler that draining only
-- ever happened when someone invoked the function by hand, so a pending push
-- could sit undelivered indefinitely. This job closes that gap.
--
-- Auth: the function requires a matching X-Cron-Secret header
-- (SEND_PUSH_NOTIFICATIONS_CRON_SECRET on the function side). The value is read
-- at call time from Supabase Vault by NAME only -- it is never written into this
-- migration, the repo, or any ordinary table. This mirrors the existing
-- kabumori-stocks-master-sync / kabumori-stocks-new-listing-sync jobs.
--
-- Fail-safe: if the vault entry is missing or empty the CTE returns no rows, so
-- net.http_post is never reached. A misconfigured secret makes this job a silent
-- no-op instead of firing an unauthenticated request.
--
-- Frequency: every minute, matching dispatch-scheduled-posts. Important-news
-- pushes are time-sensitive, and a run with nothing pending costs one HTTP call
-- that returns {"status":"completed","processedCount":0} without touching the
-- Expo API.
do $migration$
begin
  if not exists (
    select 1 from cron.job where jobname = 'send-push-notifications-dispatch'
  ) then
    perform cron.schedule(
      'send-push-notifications-dispatch',
      '* * * * *',
      $cron$
        with secret as (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'send_push_notifications_cron_secret'
            and decrypted_secret is not null
            and decrypted_secret <> ''
          limit 1
        )
        select net.http_post(
          url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/send-push-notifications',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Cron-Secret', secret.decrypted_secret
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        )
        from secret;
      $cron$
    );
  end if;
end
$migration$;
