-- Market Intelligence Core (MIC) Phase 1B automation prep, part A:
-- correct FRED's ingest cadence.
--
-- US2Y/US10Y (FRED) are a US-Treasury-published daily series -- the
-- underlying data changes at most once per US business day. The current
-- update_frequency_minutes=60 was set before this was reviewed and implies
-- checking FRED up to 24x/day for a value that changes at most once/day,
-- 24x more often than useful. It also feeds v_mic_source_fetch_status's
-- fetch-freshness "stale" threshold (update_frequency_minutes * 3), so at
-- 60 minutes the fetch pipeline itself gets flagged stale after only 3
-- hours of no successful run -- far tighter than the actual publication
-- cadence warrants.
--
-- MOF JGB and EIA are left untouched: both are already set to 1440
-- (daily), which already matches their real publication cadence.
-- SEC EDGAR is out of scope (BLOCKED at the network level, not a cadence
-- problem) and is not touched here.
update public.mic_source_registry
set update_frequency_minutes = 1440,
    updated_at = now()
where source_key = 'fred';
