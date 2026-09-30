-- MIC Phase 3C: independent Scenario evaluator Cron. Source-only candidate.
-- The two jobs are inert until exactly one non-empty Vault secret with the
-- expected name exists. No secret value is stored in this migration.
-- Reapply accepts only an identical active job; a same-name conflict fails
-- closed rather than silently replacing an existing schedule/command.
begin;

do $migration$
declare
  v_count integer;
  v_job record;
  v_command constant text := $scenario_command$
with secret as (
  select max(decrypted_secret) as decrypted_secret
  from vault.decrypted_secrets
  where name = 'mic_scenario_evaluator_cron_secret'
  having count(*) = 1
     and count(*) filter (where decrypted_secret is not null and decrypted_secret <> '') = 1
)
select net.http_post(
  url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-scenario-evaluator',
  headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
  body := '{"trigger":"cron"}'::jsonb,
  timeout_milliseconds := 150000
)
from secret;
$scenario_command$;
begin
  select count(*) into v_count from cron.job where jobname = 'mic-scenario-after-state-0100';
  if v_count = 0 then
    perform cron.schedule('mic-scenario-after-state-0100', '25 1 * * 2-6', v_command);
  elsif v_count = 1 then
    select * into v_job from cron.job where jobname = 'mic-scenario-after-state-0100';
    if v_job.schedule is distinct from '25 1 * * 2-6'
       or v_job.command is distinct from v_command
       or v_job.active is distinct from true
       or v_job.database is distinct from current_database()
       or v_job.username is distinct from current_user then
      raise exception 'Cron conflict for mic-scenario-after-state-0100; existing job not modified';
    end if;
  else
    raise exception 'Multiple Cron jobs named mic-scenario-after-state-0100; no jobs modified';
  end if;

  select count(*) into v_count from cron.job where jobname = 'mic-scenario-after-state-weekday';
  if v_count = 0 then
    perform cron.schedule('mic-scenario-after-state-weekday', '25 6,9,21,22 * * 1-5', v_command);
  elsif v_count = 1 then
    select * into v_job from cron.job where jobname = 'mic-scenario-after-state-weekday';
    if v_job.schedule is distinct from '25 6,9,21,22 * * 1-5'
       or v_job.command is distinct from v_command
       or v_job.active is distinct from true
       or v_job.database is distinct from current_database()
       or v_job.username is distinct from current_user then
      raise exception 'Cron conflict for mic-scenario-after-state-weekday; existing job not modified';
    end if;
  else
    raise exception 'Multiple Cron jobs named mic-scenario-after-state-weekday; no jobs modified';
  end if;
end
$migration$;

commit;
