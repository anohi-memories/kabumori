-- Market Intelligence Core (MIC) Central Banks Phase 2B1:
-- FRED numeric facts for the Federal Funds target range.
--
-- This is a data-only seed. The existing FRED source, rates domain, ingest
-- path, and State evaluator remain unchanged. No central_bank_decision or
-- macro_release events are created by these two metric mappings.
--
-- FRED observation dates identify the date on which the target rate is
-- effective. They are stored date-only (observed_at=NULL) by the existing
-- adapter. The FOMC statement's publication instant belongs to a future
-- decision-event record and is intentionally not written to market_metrics.
--
-- The current freshness model is age-based rather than meeting-calendar-
-- aware. FRED republishes the effective target range daily (with the same
-- value between meetings), so these generous 90-day fresh / 180-day stale
-- windows are interim safeguards against treating a held target as stale
-- during a long meeting gap. Source fetch health remains tracked separately.
-- Materiality is based on value movement only: 0.01 percentage points.
-- New FRED observation dates with an unchanged value are not material under
-- the existing State decision logic. The first observation is material by
-- the existing first-observation rule.

insert into public.mic_metric_domain_map (
  metric_key,
  domain,
  display_name,
  pct_change_threshold,
  abs_change_threshold,
  always_material,
  expected_observation_lag_minutes,
  observation_stale_after_minutes
) values
  (
    'FED_FUNDS_TARGET_LOWER',
    'rates',
    'Federal Funds target range (lower bound)',
    null,
    0.01,
    false,
    129600,
    259200
  ),
  (
    'FED_FUNDS_TARGET_UPPER',
    'rates',
    'Federal Funds target range (upper bound)',
    null,
    0.01,
    false,
    129600,
    259200
  )
on conflict (metric_key) do nothing;
