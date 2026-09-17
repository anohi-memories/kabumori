-- Market Intelligence Core (MIC) FX Phase 1: Frankfurter/USDJPY Cron
-- automation.
--
-- Same safety pattern as the existing MIC automation migration
-- (20260916100000_mic_phase1b_automation_cron.sql) -- see that file for
-- the full rationale. Summary:
--
-- 1. No secret VALUE is written here. Both jobs reference existing Vault
--    secret NAMES only (market_intelligence_ingest_cron_secret,
--    market_intelligence_state_evaluator_cron_secret) -- the same two
--    secrets FRED/MOF/EIA and rates/commodities already use. Neither
--    secret's value is touched by this migration.
-- 2. `net.http_post` only runs `FROM secret [, ...]` -- an empty CTE
--    (secret missing, or the evaluator's gate failing) means zero HTTP
--    calls, not a call with a blank/stale header.
-- 3. The ingest job's body names exactly one source
--    (`{"trigger":"cron","sources":["frankfurter"]}`), matching the
--    existing FRED/MOF/EIA jobs' shape exactly (trigger + single source).
-- 4. The evaluator job's body names exactly one domain
--    (`{"domains":["fx"]}`), never all-domain, and gates on a
--    `latest_ingest` CTE: the single most recent mic_ingestion_runs row
--    for source_key='frankfurter' with started_at within the last 60
--    minutes, filtered by `where latest_ingest.status = 'completed'`
--    AFTER selecting the latest row -- not "does a completed row exist
--    anywhere in the window". A failed or still-running latest run
--    correctly blocks the evaluator even if an older completed run is
--    still inside the 60-minute window (this is the exact fix applied to
--    the FRED/MOF/EIA evaluator gates in 20260916100000, reused here
--    unchanged).
-- 5. `cron.schedule(name, ...)` upserts by job name: re-running this
--    migration is safe, and it never references any job name outside the
--    two new `mic-ingest-frankfurter-fx-*` / `mic-evaluator-fx-after-*`
--    pairs below, so no existing MIC or non-MIC Cron job is touched.
-- 6. No immediate/in-process retry: a failed run is picked up (or not) by
--    the next scheduled slot below, same as every other MIC source.
--
-- Schedule rationale: Frankfurter mirrors the ECB's daily reference rate,
-- published once per TARGET business day around 16:00 CET (roughly
-- 14:00-15:00 UTC depending on DST) with some Frankfurter-side lag on top
-- (observed in the Phase 1 smoke test: a request on 2026-09-17 returned
-- the 2026-09-16 rate). 17:30 UTC gives a comfortable margin past the
-- fixing for same-day pickup; 01:30 UTC the next calendar day is the
-- backstop for a delayed publish, mirroring FRED's 21:00+01:00 two-slot
-- pattern. Both are weekday-only (no weekend runs) since ECB does not
-- publish on non-TARGET days -- this is a daily, not real-time, feed, and
-- polling it more often would not produce fresher data.

select cron.schedule(
  'mic-ingest-frankfurter-fx-1730',
  '30 17 * * 1-5',
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
    body := '{"trigger":"cron","sources":["frankfurter"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-ingest-frankfurter-fx-0130',
  '30 1 * * 2-6',
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
    body := '{"trigger":"cron","sources":["frankfurter"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret;
  $$
);

select cron.schedule(
  'mic-evaluator-fx-after-frankfurter-1730',
  '45 17 * * 1-5',
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
    where source_key = 'frankfurter'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["fx"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);

select cron.schedule(
  'mic-evaluator-fx-after-frankfurter-0130',
  '45 1 * * 2-6',
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
    where source_key = 'frankfurter'
      and started_at > now() - interval '60 minutes'
    order by started_at desc
    limit 1
  )
  select net.http_post(
    url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-state-evaluator',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
    body := '{"domains":["fx"]}'::jsonb,
    timeout_milliseconds := 150000
  )
  from secret
  cross join latest_ingest
  where latest_ingest.status = 'completed';
  $$
);
