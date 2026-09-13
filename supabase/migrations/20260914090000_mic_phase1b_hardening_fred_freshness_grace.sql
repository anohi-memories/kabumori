-- Market Intelligence Core (MIC) Phase 1B hardening: FRED weekend freshness
-- grace period.
--
-- Production audit (2026-09-13) found US2Y/US10Y flipping to
-- observation_status='stale' purely because a Thu-observed value crosses a
-- Sun/Mon calendar-day boundary against the source_registry-wide 24h
-- expected_delay_minutes fallback (v_mic_metric_observation_status has no
-- business-day awareness -- it is pure calendar-time arithmetic). MOF JGB
-- (2026-08-31, ~13 days stale at audit time) is a genuine multi-week gap in
-- MOF's own published dataset, not a weekend artifact, and is deliberately
-- left untouched here.
--
-- This sets a per-metric override via the column mic_metric_domain_map.
-- expected_observation_lag_minutes already added in the Phase 1B migration
-- specifically so this kind of adjustment needs no schema change --
-- v_mic_metric_observation_status already does
-- coalesce(map.expected_observation_lag_minutes, source_registry.expected_delay_minutes).
--
-- 72h (4320 minutes) chosen as the "fresh" cutoff so a normal Thu->Mon or
-- Fri->Mon business-day gap lands inside fresh/delayed_expected instead of
-- stale. Known trade-off: because observation_status derives
-- delayed_expected/stale as multiples (1x/3x) of this same lag value, this
-- also pushes the stale cutoff for US2Y/US10Y out to 9 days (was 3 days).
-- A genuine multi-day FRED outage would take longer to surface as 'stale'.
-- Accepted for now per the audit's recommended design (option B); revisit
-- if a real outage-detection gap becomes a problem (see PHASE_1B_STATE_LAYER.md).
update public.mic_metric_domain_map
set expected_observation_lag_minutes = 4320, -- 72h
    updated_at = now()
where metric_key in ('US2Y', 'US10Y');

-- JGB2Y/JGB10Y and every other metric are intentionally left untouched
-- (expected_observation_lag_minutes stays null, falling back to
-- mic_source_registry.expected_delay_minutes as before). mic_source_registry
-- itself is not modified by this migration.
