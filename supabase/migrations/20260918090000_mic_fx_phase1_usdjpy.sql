-- Market Intelligence Core (MIC) FX Phase 1: USD/JPY via Frankfurter.
--
-- Pure data seed -- no schema change. mic_source_registry.category already
-- allows 'market_price' (used by fred/mof_jgb/eia), mic_metric_domain_map's
-- domain check already allows 'fx', and the freshness/threshold columns
-- used below (expected_observation_lag_minutes, observation_stale_after_minutes)
-- were already added in the Phase 1B hardening migrations. Nothing here
-- needs an ALTER TABLE.
--
-- provider vs underlying source: Frankfurter (the API we call) is not the
-- same thing as who the data actually comes from. Frankfurter derives
-- USD/JPY as a EUR-denominated cross-rate from the European Central
-- Bank's daily reference rates -- it does not quote USD/JPY directly, and
-- the ECB itself does not publish USD/JPY as a first-party quote either.
-- That's why quality_tier is 'trusted_free' and is_official is false here,
-- unlike FRED's Treasury yields or MOF's JGB yields (both true
-- is_official=true one-source-of-truth quotes). reliability_notes carries
-- this distinction explicitly for anyone reading the registry later.
--
-- is_active stays false: this seed only registers the source/metric so
-- the ingest adapter and State evaluator can be exercised end-to-end
-- locally and, later, via a manual production smoke test. Activation (and
-- any Cron wiring) is a separate, later approval, same pattern as every
-- other MIC source before it.
insert into public.mic_source_registry (
  source_key, category, display_name, provider, endpoint_url, source_kind,
  requires_auth, cost_tier, update_frequency_minutes, expected_delay_minutes,
  quality_tier, is_official, is_primary, is_active, reliability_notes
) values (
  'frankfurter',
  'market_price',
  'Frankfurter (ECB reference rates)',
  'Frankfurter',
  'https://api.frankfurter.dev/v1/latest',
  'structured_api',
  false,
  'free',
  1440,
  1440,
  'trusted_free',
  false,
  true,
  false,
  'Free, unauthenticated, no quota. Underlying data is the European Central Bank''s daily reference rates (~16:00 CET, TARGET business days only) -- Frankfurter derives USD/JPY as a EUR cross-rate rather than quoting it directly, so this is not a single-source-of-truth feed the way FRED/MOF are.'
)
on conflict (source_key) do nothing;

insert into public.mic_metric_domain_map (
  metric_key, domain, display_name, pct_change_threshold, abs_change_threshold,
  always_material, expected_observation_lag_minutes, observation_stale_after_minutes
) values (
  'USDJPY',
  'fx',
  'USD/JPY',
  0.5,
  null,
  false,
  4320, -- 72h: same weekend-absorbing fresh cutoff already proven for US2Y/US10Y
  7200  -- 5 calendar days: same stale-after margin already proven for US2Y/US10Y
)
on conflict (metric_key) do nothing;
