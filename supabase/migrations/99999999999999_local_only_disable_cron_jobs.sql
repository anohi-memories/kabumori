-- LOCAL DEVELOPMENT ONLY. Never apply to production.
--
-- Phase 1 finding (2026-09-10): every `cron.schedule(...)` call in the existing migration
-- history embeds the *production* project URL in the job body (net.http_post to
-- https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/...). Replaying the full migration
-- history into a local `supabase start` database (see
-- 00000000000000_local_only_enable_extensions.sql) registers those same jobs in the *local*
-- pg_cron scheduler. A local pg_cron worker firing net.http_post at those URLs would be a real
-- request against production. Named with the highest possible timestamp so it always runs last,
-- after every other migration (including any future one that adds a cron job) has been applied.
-- Idempotent and side-effect-free against production: this only ever touches the local
-- cron.job table already sitting in this local-only worktree's own Postgres container.
do $migration$
declare
  job record;
begin
  for job in select jobname from cron.job loop
    perform cron.unschedule(job.jobname);
  end loop;
end
$migration$;
