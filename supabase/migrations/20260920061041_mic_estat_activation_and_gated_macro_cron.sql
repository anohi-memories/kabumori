-- Macro Indicators Phase 1B: activate the already-smoke-tested e-Stat source
-- and schedule its low-frequency ingest plus a gated macro State evaluation.
-- Secrets are looked up from Vault at runtime and are never embedded here.
begin;

do $migration$
declare
  v_estat_count integer;
  v_job_count integer;
  v_job record;
  v_ingest_command constant text := $ingest_command$
with secret as (
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'market_intelligence_ingest_cron_secret'
    and decrypted_secret is not null
    and decrypted_secret <> ''
  limit 1
)
select net.http_post(
  url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-ingest',
  headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
  body := '{"sources":["estat"]}'::jsonb,
  timeout_milliseconds := 150000
)
from secret;
$ingest_command$;
  v_evaluator_command constant text := $evaluator_command$
with latest_estat_run as (
  select status, started_at
  from public.mic_ingestion_runs
  where source_key = 'estat'
    and started_at >= now() - interval '60 minutes'
  order by started_at desc
  limit 1
), secret as (
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'market_intelligence_state_evaluator_cron_secret'
    and decrypted_secret is not null
    and decrypted_secret <> ''
  limit 1
)
select net.http_post(
  url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
  headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
  body := '{"domains":["macro"]}'::jsonb,
  timeout_milliseconds := 150000
)
from latest_estat_run
cross join secret
where latest_estat_run.status = 'completed';
$evaluator_command$;
begin
  select count(*)
  into v_estat_count
  from public.mic_source_registry
  where source_key = 'estat';

  if v_estat_count <> 1 then
    raise exception 'Expected exactly one estat source registry row, found %', v_estat_count;
  end if;

  update public.mic_source_registry
  set is_active = true
  where source_key = 'estat'
    and is_active is distinct from true;

  select count(*)
  into v_job_count
  from cron.job
  where jobname = 'mic-ingest-estat-daily';

  if v_job_count = 0 then
    perform cron.schedule('mic-ingest-estat-daily', '0 22 * * 1-5', v_ingest_command);
  elsif v_job_count = 1 then
    select * into v_job
    from cron.job
    where jobname = 'mic-ingest-estat-daily';

    if v_job.schedule is distinct from '0 22 * * 1-5'
      or v_job.command is distinct from v_ingest_command
      or v_job.active is distinct from true then
      raise exception 'Cron conflict for mic-ingest-estat-daily; existing job was not modified';
    end if;
  else
    raise exception 'Multiple Cron jobs named mic-ingest-estat-daily; no jobs were modified';
  end if;

  select count(*)
  into v_job_count
  from cron.job
  where jobname = 'mic-evaluator-macro-after-estat';

  if v_job_count = 0 then
    perform cron.schedule('mic-evaluator-macro-after-estat', '15 22 * * 1-5', v_evaluator_command);
  elsif v_job_count = 1 then
    select * into v_job
    from cron.job
    where jobname = 'mic-evaluator-macro-after-estat';

    if v_job.schedule is distinct from '15 22 * * 1-5'
      or v_job.command is distinct from v_evaluator_command
      or v_job.active is distinct from true then
      raise exception 'Cron conflict for mic-evaluator-macro-after-estat; existing job was not modified';
    end if;
  else
    raise exception 'Multiple Cron jobs named mic-evaluator-macro-after-estat; no jobs were modified';
  end if;
end
$migration$;

commit;
