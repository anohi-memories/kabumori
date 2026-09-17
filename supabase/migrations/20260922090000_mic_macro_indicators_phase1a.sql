-- Market Intelligence Core (MIC) Macro Indicators Phase 1A: 16 FRED-sourced
-- US/JP macro metrics (CPI/Core CPI/PCE/Core PCE/NFP/Unemployment
-- Rate/GDP/Retail Sales for the US, GDP for Japan), domain='macro'.
--
-- Pure data seed -- no schema change (no ALTER anywhere in this file).
-- domain='macro' and market_state_current's macro row already existed
-- from the original Phase 1B migration
-- (20260913090000_add_market_intelligence_state_layer_phase1b.sql); this
-- migration only adds mic_metric_domain_map rows for it, exactly like
-- Equity Index Phase 1 did for 'equity_index'. All 16 metrics use
-- source_key='fred', already active and already fetched by the existing
-- mic-ingest-fred-* Cron jobs in production -- adding the corresponding
-- entries to FRED_SERIES_MAPPINGS in the adapter (done in this same
-- change, local-only) is what makes them actually get fetched; this
-- migration only tells the State evaluator how to interpret them once
-- Facts exist. No Cron job is added or changed by this migration.
--
-- ---------------------------------------------------------------------------
-- Material-change policy (design doc section 5 of the Phase 1 report,
-- refined per explicit instruction not to blanket always_material every
-- metric):
--
-- Each of the 7 "level + derived" pairs below (e.g. US_CPI + US_CPI_YOY)
-- always lands in market_metrics from the SAME FRED ingest run, so a
-- single domain-level State evaluation (evaluateMaterialChange collects
-- ALL new observations across a domain into one call, confirmed by code
-- reading mic_state_decision_logic.ts) already fires once per release
-- regardless of how many of the pair are individually flagged material --
-- there is no risk of a "duplicate AI dispatch" from setting both. The
-- minimal-noise design instead avoids setting BOTH members of a pair to
-- always_material, since that would be two redundant "always" reasons for
-- the same underlying release with no discriminating signal:
--   - The DERIVED (rate/change) metric -- the figure media/investors
--     actually react to -- gets always_material=true, guaranteeing every
--     new monthly/quarterly print gets evaluated (per the design doc:
--     macro releases are infrequent enough that "did a new print arrive"
--     is itself always noteworthy).
--   - Its LEVEL companion gets a conservative pct_change_threshold instead
--     (not always_material), since the derived metric already guarantees
--     the domain gets evaluated on every real release.
-- Two metrics have no derived companion (US_UNEMPLOYMENT_RATE, JP_GDP) --
-- both get always_material=true directly, since there is no paired metric
-- to rely on instead.
--
-- Per the design doc's explicit rule ("percentage/rate metricsではpct_change_
-- thresholdよりabs_change_threshold(pp単位)を優先"): none of the
-- always_material rate/change metrics below also carry a pct/abs threshold
-- (always_material alone satisfies the table's
-- "pct_change_threshold IS NOT NULL OR abs_change_threshold IS NOT NULL OR
-- always_material" check, and leaving the others null avoids ambiguity
-- about which one would actually govern). Level companions use
-- pct_change_threshold (never abs_change_threshold), since their value is
-- a genuine index/level/count, not already a percentage.
--
-- ---------------------------------------------------------------------------
-- Freshness (design doc section 10, RECOMPUTED and CORRECTED here after
-- re-checking each series' actual release cadence, per explicit
-- instruction to re-verify before implementation):
--
-- observed_date is always the reference period's START date (e.g. 2026-08
-- CPI -> observed_date=2026-08-01; 2026-Q2 GDP -> observed_date=2026-04-01),
-- the standard convention BLS/BEA/Census/FRED themselves use for these
-- series. Because observed_date does NOT move until a genuinely new
-- period is published, a row's age (now - observed_date) legitimately
-- grows for the ENTIRE gap until the next release -- "expected_observation_
-- lag_minutes" (the fresh cutoff) must therefore cover that whole gap, not
-- just the initial publish lag, or the view would call a perfectly current
-- macro figure "stale" for most of its life. General formula used below:
-- for a reference period of length Q days whose OWN first print appears R
-- days after that period's end, this period's row remains "the latest
-- known value" until the NEXT period's own first print appears at
-- (2*Q + R) days after THIS period's observed_date (Q days to reach this
-- period's own end, another Q days to reach the next period's end, plus
-- that period's own R-day release lag).
--
--   Monthly US/JP series (Q=~30 days, R=~12-14 days after month-end for
--   CPI/PCE/Retail Sales, R=~0-7 days for NFP/Unemployment -- using the
--   slower CPI-class R as the shared bucket, which only makes the window
--   MORE generous for NFP/Unemployment, never falsely-stale):
--     2*30 + 13 ~= 73 days -> fresh cutoff set to 80 days (115200 min),
--     stale_after set to 110 days (158400 min), ~30 days of grace beyond
--     that for a delayed release (a real, confirmed scenario: BLS's own
--     published data shows an October 2025 gap from a lapse in
--     appropriations).
--
--   US GDP (Q=~91 days/quarter, R=~30 days for the advance estimate):
--     2*91 + 30 = 212 days -> fresh cutoff 212 days (305280 min).
--     ** This CORRECTS the design doc's earlier estimate of 130 days/
--     187200 min, which only accounted for R (single publish lag) and not
--     2*Q+R (the full inter-release gap) -- the original number would have
--     called a perfectly current GDP print "stale" roughly 80 days before
--     the next quarter's data even exists. ** stale_after set to 250 days
--     (360000 min), ~38 days of grace beyond the fresh cutoff.
--
--   JP GDP (Q=~91 days/quarter, R=~45 days for the 1st preliminary
--     estimate, per the Cabinet Office's QE release cadence):
--     2*91 + 45 = 227 days -> fresh cutoff 227 days (326880 min).
--     ** Corrects the design doc's earlier estimate of 140 days/201600 min
--     for the same reason as US GDP. ** stale_after set to 267 days
--     (384480 min), 40 days of grace beyond the fresh cutoff.
--
-- All three stale_after values remain strictly greater than their fresh
-- cutoff, satisfying mic_metric_domain_map_stale_after_gt_lag_check.
insert into public.mic_metric_domain_map (
  metric_key, domain, display_name, pct_change_threshold, abs_change_threshold,
  always_material, expected_observation_lag_minutes, observation_stale_after_minutes
) values
  -- --- US CPI (monthly) ---
  ('US_CPI', 'macro', '米CPI(消費者物価指数)', 0.3, null, false, 115200, 158400),
  ('US_CPI_YOY', 'macro', '米CPI前年比', null, null, true, 115200, 158400),
  ('US_CORE_CPI', 'macro', '米コアCPI', 0.3, null, false, 115200, 158400),
  ('US_CORE_CPI_YOY', 'macro', '米コアCPI前年比', null, null, true, 115200, 158400),
  -- --- US PCE Price Index (monthly, Fed's preferred gauge) ---
  ('US_PCE', 'macro', '米PCE物価指数', 0.3, null, false, 115200, 158400),
  ('US_PCE_YOY', 'macro', '米PCE物価指数前年比', null, null, true, 115200, 158400),
  ('US_CORE_PCE', 'macro', '米コアPCE物価指数', 0.3, null, false, 115200, 158400),
  ('US_CORE_PCE_YOY', 'macro', '米コアPCE物価指数前年比(FRB最重視指標)', null, null, true, 115200, 158400),
  -- --- US employment (monthly) ---
  ('US_NFP', 'macro', '米非農業部門雇用者数', 0.1, null, false, 115200, 158400),
  ('US_NFP_CHANGE', 'macro', '米非農業部門雇用者数 前月差', null, null, true, 115200, 158400),
  ('US_UNEMPLOYMENT_RATE', 'macro', '米失業率', null, null, true, 115200, 158400),
  -- --- US GDP (quarterly) ---
  ('US_GDP', 'macro', '米実質GDP', 0.3, null, false, 305280, 360000),
  ('US_GDP_GROWTH', 'macro', '米実質GDP成長率(年率換算)', null, null, true, 305280, 360000),
  -- --- US Retail Sales (monthly) ---
  ('US_RETAIL_SALES', 'macro', '米小売売上高', 0.3, null, false, 115200, 158400),
  ('US_RETAIL_SALES_MOM', 'macro', '米小売売上高 前月比', null, null, true, 115200, 158400),
  -- --- Japan GDP (quarterly) ---
  ('JP_GDP', 'macro', '日本実質GDP', null, null, true, 326880, 384480)
on conflict (metric_key) do nothing;
