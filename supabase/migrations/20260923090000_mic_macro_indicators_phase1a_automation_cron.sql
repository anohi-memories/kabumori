-- Market Intelligence Core (MIC) Macro Indicators Phase 1A: State evaluator
-- Cron automation.
--
-- Same safety pattern as the existing MIC automation migrations
-- (20260916100000_mic_phase1b_automation_cron.sql,
-- 20260919090000_mic_fx_phase1_automation_cron.sql,
-- 20260921090000_mic_equity_index_phase1_automation_cron.sql) -- see those
-- files for the full rationale. Summary:
--
-- 1. No new ingest Cron job is added here. All 16 macro metrics
--    (US_CPI/US_CORE_CPI/US_PCE/US_CORE_PCE/US_NFP/US_UNEMPLOYMENT_RATE/
--    US_GDP/US_RETAIL_SALES and their derived pairs, plus JP_GDP) are
--    fetched by the existing FRED adapter, so the existing FRED ingest
--    jobs (mic-ingest-fred-2100, mic-ingest-fred-0100) are reused as-is
--    and are NOT modified by this migration.
-- 2. No secret VALUE is written here. Both new jobs reference the existing
--    Vault secret name 'market_intelligence_state_evaluator_cron_secret'
--    only -- the same secret the rates/commodities/fx/equity_index
--    evaluator jobs already use. That secret's value is not touched by
--    this migration.
-- 3. `net.http_post` only runs `FROM secret CROSS JOIN latest_ingest` -- if
--    either CTE is empty, the FROM clause is empty and no HTTP request is
--    ever made.
-- 4. Each job's body names exactly one domain (`{"domains":["macro"]}`),
--    never all-domain.
-- 5. Each job gates on a `latest_ingest` CTE: the single most recent
--    `mic_ingestion_runs` row for source_key='fred' with started_at within
--    the last 60 minutes, filtered by `where latest_ingest.status =
--    'completed'` AFTER selecting the latest row -- not "does a completed
--    row exist anywhere in the window". A failed or still-running latest
--    FRED run correctly blocks the macro evaluator even if an older
--    completed run is still inside the 60-minute window. This is the
--    exact hardened gate already used by mic-evaluator-rates-after-fred-*
--    and mic-evaluator-equity-index-after-fred-* (both of which also gate
--    on source_key='fred'), reused unchanged here.
-- 6. `cron.schedule(name, ...)` upserts by job name: re-running this
--    migration is safe, and it only ever references the two new
--    `mic-evaluator-macro-after-fred-*` job names below, so no existing
--    MIC or non-MIC Cron job (including the FRED ingest jobs and the
--    existing rates/equity_index evaluator jobs that also fire off the
--    same FRED ingest) is touched.
-- 7. No immediate/in-process retry: a failed run is picked up (or not) by
--    the next scheduled FRED ingest/evaluator slot, same as every other
--    MIC domain.
--
-- Schedule rationale: mirrors mic-evaluator-rates-after-fred-* and
-- mic-evaluator-equity-index-after-fred-* exactly, since rates,
-- equity_index, and macro are all populated by the same FRED ingest jobs
-- -- 15 minutes after each FRED ingest slot (21:00 Mon-Fri, 01:00 Tue-Sat
-- UTC).

select cron.schedule(
  'mic-evaluator-macro-after-fred-2100',
  '15 21 * * 1-5',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_state_evaluator_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  ),
  latest_ingest as (
    select status, completed_at, started_at, run_window
    from public.mic_ingestion_runs
    where source_key = 'fred'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["macro"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);

select cron.schedule(
  'mic-evaluator-macro-after-fred-0100',
  '15 1 * * 2-6',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_state_evaluator_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  ),
  latest_ingest as (
    select status, completed_at, started_at, run_window
    from public.mic_ingestion_runs
    where source_key = 'fred'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["macro"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);
