-- Apply after fixture and migration (including its idempotent second apply).
-- No live network call is possible: net.http_post is the local recorder.
do $disposable_guard$
begin
  if current_database() <> 'postgres'
     or inet_server_addr() is not null
     or current_setting('mic_phase3c.disposable', true) is distinct from 'yes' then
    raise exception 'MIC_PHASE3C_DISPOSABLE_DB_REQUIRED';
  end if;
end
$disposable_guard$;

do $test$
declare
  v_job record;
  v_secret_id uuid;
begin
  if (select count(*) from cron.job where jobname like 'mic-scenario-after-state-%') <> 2 then
    raise exception 'Expected exactly two Scenario Cron jobs';
  end if;
  if (select count(*) from cron.job where jobname = 'mic-scenario-after-state-0100'
      and schedule = '25 1 * * 2-6' and active) <> 1 then
    raise exception 'Scenario 01:25 schedule mismatch';
  end if;
  if (select count(*) from cron.job where jobname = 'mic-scenario-after-state-weekday'
      and schedule = '25 6,9,21,22 * * 1-5' and active) <> 1 then
    raise exception 'Scenario weekday schedule mismatch';
  end if;

  -- No Vault row: each stored command executes but sends zero requests.
  for v_job in select command from cron.job where jobname like 'mic-scenario-after-state-%' loop
    execute v_job.command;
  end loop;
  if (select count(*) from public.mic_phase3c_http_calls) <> 0 then
    raise exception 'Secret absent must send zero requests';
  end if;

  v_secret_id := vault.create_secret('local_dummy_only', 'mic_scenario_evaluator_cron_secret');
  if v_secret_id is null then raise exception 'Dummy Vault secret not created'; end if;
  for v_job in select command from cron.job where jobname like 'mic-scenario-after-state-%' loop
    execute v_job.command;
  end loop;
  if (select count(*) from public.mic_phase3c_http_calls) <> 2 then
    raise exception 'Exactly one request per job expected';
  end if;
  if exists (
    select 1 from public.mic_phase3c_http_calls
    where url <> 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-scenario-evaluator'
       or body <> '{"trigger":"cron"}'::jsonb
       or timeout_ms <> 150000
       or not content_type_ok
       or not cron_secret_ok
  ) then
    raise exception 'Scenario request contract mismatch';
  end if;

  -- The actual Supabase Vault schema rejects a second row for the same name.
  -- The Cron SQL also requires count(*)=1 as defense if a different Vault
  -- implementation ever permits duplicates.
  begin
    perform vault.create_secret('different_local_dummy', 'mic_scenario_evaluator_cron_secret');
    raise exception 'Duplicate Vault name unexpectedly accepted';
  exception when unique_violation then
    null;
  end;
  if (select count(*) from vault.secrets where name = 'mic_scenario_evaluator_cron_secret') <> 1 then
    raise exception 'Vault name uniqueness not preserved';
  end if;
  if (select count(*) from public.mic_phase3c_http_calls) <> 2 then
    raise exception 'Duplicate Vault name must send zero additional requests';
  end if;
end
$test$;
