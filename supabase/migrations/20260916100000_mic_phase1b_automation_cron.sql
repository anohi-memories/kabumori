-- Market Intelligence Core (MIC) Phase 1B automation prep, part B: ingest
-- and State evaluator Cron jobs.
--
-- Safety properties (all mirrored from the existing, already-running
-- kabumori-stocks-master-sync / kabumori-stocks-new-listing-sync pattern --
-- see 20260904160000_kabumori_stocks_sync_cron.sql):
--
-- 1. No secret VALUE is ever written into this file, git, or any report.
--    Only Vault secret NAMES are referenced
--    ('market_intelligence_ingest_cron_secret',
--    'market_intelligence_state_evaluator_cron_secret'). The actual values
--    must be generated fresh and registered into BOTH the Edge Function
--    secrets AND Supabase Vault (under these exact names) in one
--    deliberate rotation session before these jobs can ever fire
--    successfully -- copying the current (already-set, unrecoverable)
--    Edge Function secret values into Vault is explicitly not an option
--    here, since Supabase never returns a secret's value once set.
-- 2. Every job reads its secret from `vault.decrypted_secrets` via a CTE;
--    `net.http_post` only runs `FROM secret [, ...]` -- if that CTE (or
--    any other CTE joined into the same FROM clause) returns zero rows,
--    the FROM clause is empty and no HTTP request is ever made. Until the
--    Vault secrets above are actually registered, every job in this
--    migration is a safe no-op every time it fires.
-- 3. Each ingest job's `body` names its ONE target source explicitly
--    (`{"sources":["fred"]}` etc.) -- never an all-source call.
-- 4. Each State evaluator job's `body` names its ONE target domain
--    explicitly (`{"domains":["rates"]}` / `{"domains":["commodities"]}`)
--    -- never an all-domain call, and never SEC/corporate_events (still
--    BLOCKED, out of scope).
-- 5. Every evaluator job additionally gates on a `latest_ingest` CTE: the
--    single most recent `mic_ingestion_runs` row for its specific
--    triggering source, restricted to started_at within the last 60
--    minutes (the job fires 15 minutes after its paired ingest job; 60
--    minutes comfortably covers normal ingest latency without reaching
--    back to a stale run from hours earlier). The gate is
--    `latest_ingest.status = 'completed'` -- deliberately "take the latest
--    run in the window, then check its status" rather than "does a
--    completed row exist somewhere in the window", so a sequence like
--    (30 min ago: completed) -> (just now: failed) correctly reads the
--    failed run as the latest one and skips the evaluator, instead of
--    matching the older completed row and evaluating stale Facts anyway.
--    If there is no run at all in the window, or the latest one is
--    'failed'/'running'/anything but 'completed', latest_ingest still
--    returns a row (or zero, if no run exists) but the `where
--    latest_ingest.status = 'completed'` filter empties the result either
--    way -- no wasted evaluator runs, no noise in
--    mic_state_evaluation_runs for a source that just failed or hasn't
--    finished yet.
-- 6. `cron.schedule(name, ...)` upserts by job name, so re-running this
--    migration is safe and never creates a duplicate job, and it never
--    touches any job name outside the `mic-ingest-*` / `mic-evaluator-*`
--    prefixes used here -- every pre-existing Cron job (stocks sync,
--    important-news-monitor, send-push-notifications, etc.) is untouched.
-- 7. No immediate/in-process retry anywhere: a failed ingest or evaluator
--    run is simply picked up (or not, if there's nothing new) by the next
--    scheduled slot below. This is a deliberate choice to avoid retry
--    storms against FRED/MOF/EIA or OpenAI.
--
-- Schedules (all UTC, all Mon-Fri unless noted):
--   FRED ingest:        21:00 Mon-Fri, 01:00 Tue-Sat (next-day backstop)
--   MOF JGB ingest:     06:00, 09:00 Mon-Fri
--   EIA ingest:         15:00, 19:00 Mon-Fri
--   rates evaluator:    15 minutes after each FRED/MOF slot above
--   commodities evaluator: 15 minutes after each EIA slot above
-- SEC EDGAR has no ingest or evaluator job here -- still BLOCKED, out of
-- scope for this automation pass.

-- ---------------------------------------------------------------------------
-- Ingest jobs
-- ---------------------------------------------------------------------------

select cron.schedule(
  'mic-ingest-fred-2100',
  '0 21 * * 1-5',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_ingest_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron","sources":["fred"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-ingest-fred-0100',
  '0 1 * * 2-6',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_ingest_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron","sources":["fred"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-ingest-mof-jgb-0600',
  '0 6 * * 1-5',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_ingest_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron","sources":["mof_jgb"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-ingest-mof-jgb-0900',
  '0 9 * * 1-5',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_ingest_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron","sources":["mof_jgb"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-ingest-eia-1500',
  '0 15 * * 1-5',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_ingest_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron","sources":["eia"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-ingest-eia-1900',
  '0 19 * * 1-5',
  $$
  with secret as (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'market_intelligence_ingest_cron_secret'
      and decrypted_secret is not null and decrypted_secret <> ''
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"trigger":"cron","sources":["eia"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

-- ---------------------------------------------------------------------------
-- State evaluator jobs -- each gated on secret presence AND the LATEST
-- mic_ingestion_runs row for its specific triggering source (within the
-- last 60 minutes) actually being status='completed' (see point 5 above).
-- ---------------------------------------------------------------------------

select cron.schedule(
  'mic-evaluator-rates-after-fred-2100',
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
    body := '{"domains":["rates"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);

select cron.schedule(
  'mic-evaluator-rates-after-fred-0100',
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
    body := '{"domains":["rates"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);

select cron.schedule(
  'mic-evaluator-rates-after-mof-jgb-0600',
  '15 6 * * 1-5',
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
    where source_key = 'mof_jgb'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["rates"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);

select cron.schedule(
  'mic-evaluator-rates-after-mof-jgb-0900',
  '15 9 * * 1-5',
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
    where source_key = 'mof_jgb'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["rates"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);

select cron.schedule(
  'mic-evaluator-commodities-after-eia-1500',
  '15 15 * * 1-5',
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
    where source_key = 'eia'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["commodities"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);

select cron.schedule(
  'mic-evaluator-commodities-after-eia-1900',
  '15 19 * * 1-5',
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
    where source_key = 'eia'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["commodities"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);
