-- Market Intelligence Core (MIC) Equity Index Phase 1: NIKKEI225 / SP500 /
-- NASDAQCOMPOSITE / NASDAQ100 / VIX, all via the existing FRED source.
--
-- Pure data seed -- no schema change. mic_metric_domain_map.domain already
-- allows 'equity_index'; no new source_key is registered (all 5 metrics
-- use source_key='fred', already active and already fetched by the
-- existing mic-ingest-fred-* Cron jobs in production -- adding these
-- mappings to FRED_SERIES_MAPPINGS in the adapter is what makes them
-- actually get fetched, this migration only tells the State evaluator how
-- to interpret them once Facts exist).
--
-- Freshness values reuse the exact expected_observation_lag_minutes=4320
-- (72h) / observation_stale_after_minutes=7200 (5 days) pair already
-- proven for US2Y/US10Y/USDJPY -- all of these are daily-close,
-- business-day-only series with the identical Friday-close/weekend-gap
-- shape, so the same weekend-absorbing margin applies without
-- re-deriving it per market.
--
-- VIX is the one metric here using BOTH abs_change_threshold AND
-- pct_change_threshold at once. evaluateMaterialChange (existing,
-- unchanged) checks abs first and falls through to pct if abs isn't
-- already material -- so either condition alone is enough to trigger
-- material_change, giving a rough level-independent OR rule (a 2-point
-- move matters more at a low VIX level as a %, and matters as an absolute
-- 2-point move even at a high VIX level where 2 points is a small %).
-- True level-crossing (20/25/30) is explicitly NOT implemented here --
-- the current schema has no concept of a fixed threshold independent of
-- the metric's own previous value, and adding one is out of scope for
-- this migration (documented as a future candidate, not built now).
insert into public.mic_metric_domain_map (
  metric_key, domain, display_name, pct_change_threshold, abs_change_threshold,
  always_material, expected_observation_lag_minutes, observation_stale_after_minutes
) values
  ('NIKKEI225', 'equity_index', 'Nikkei 225', 1.0, null, false, 4320, 7200),
  ('SP500', 'equity_index', 'S&P 500', 1.0, null, false, 4320, 7200),
  ('NASDAQCOMPOSITE', 'equity_index', 'NASDAQ Composite', 1.2, null, false, 4320, 7200),
  ('NASDAQ100', 'equity_index', 'NASDAQ-100', 1.2, null, false, 4320, 7200),
  ('VIX', 'equity_index', 'CBOE Volatility Index (VIX)', 10.0, 2.0, false, 4320, 7200)
on conflict (metric_key) do nothing;
