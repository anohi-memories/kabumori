-- Market Intelligence Core (MIC) Phase 1B hardening, part 2: independent
-- stale-after threshold.
--
-- The first hardening pass (20260914090000) fixed US2Y/US10Y flipping to
-- observation_status='stale' over a normal weekend by raising
-- expected_observation_lag_minutes (the "fresh" cutoff) to 72h. But
-- v_mic_metric_observation_status derived delayed_expected/stale as fixed
-- multiples (1x/3x) of that SAME lag value, so raising the fresh cutoff
-- also pushed the stale cutoff out to 9 days (3 * 72h) -- far looser than
-- intended, and enough to mask a genuine multi-day FRED outage for over a
-- week.
--
-- This adds an independent, optional stale-after threshold so the
-- "how long until fresh" and "how long until stale" questions are no
-- longer coupled through one multiplier.
alter table public.mic_metric_domain_map
  add column if not exists observation_stale_after_minutes integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mic_metric_domain_map_stale_after_positive_check'
  ) then
    alter table public.mic_metric_domain_map
      add constraint mic_metric_domain_map_stale_after_positive_check
      check (observation_stale_after_minutes is null or observation_stale_after_minutes > 0);
  end if;
end $$;

-- Prevent a nonsensical config (stale kicking in before/at the fresh
-- cutoff) when both columns are set for the same metric.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mic_metric_domain_map_stale_after_gt_lag_check'
  ) then
    alter table public.mic_metric_domain_map
      add constraint mic_metric_domain_map_stale_after_gt_lag_check
      check (
        observation_stale_after_minutes is null
        or expected_observation_lag_minutes is null
        or observation_stale_after_minutes > expected_observation_lag_minutes
      );
  end if;
end $$;

comment on column public.mic_metric_domain_map.observation_stale_after_minutes is
  'Optional per-metric override for when v_mic_metric_observation_status calls a metric stale (independent of the fresh cutoff expected_observation_lag_minutes). When null, the view falls back to its prior behavior of expected_lag_minutes * 3, so any metric never explicitly given a stale_after keeps its existing thresholds unchanged.';

-- v_mic_metric_observation_status: same shape as before, only the
-- fresh/delayed_expected/stale boundary logic changes. A metric with
-- observation_stale_after_minutes set gets:
--   age <= expected_lag                      -> fresh
--   expected_lag < age <= stale_after         -> delayed_expected
--   age > stale_after                         -> stale
-- A metric with it unset (the fallback branch) keeps the original
-- expected_lag / expected_lag*3 / >expected_lag*3 tiers exactly as
-- introduced in the Phase 1B migration, so every metric that hasn't been
-- given an explicit stale_after is completely unaffected by this change.
create or replace view public.v_mic_metric_observation_status
  with (security_invoker = true) as
with base as (
  select
    map.metric_key,
    map.domain,
    ch.current_value,
    ch.previous_value,
    ch.pct_change,
    ch.abs_change,
    ch.unit,
    ch.observed_date,
    ch.observed_at,
    ch.time_precision,
    ch.fetched_at,
    ch.source_key,
    ch.provider,
    ch.is_delayed,
    ch.delay_minutes,
    ch.quality_tier,
    ch.is_official,
    coalesce(map.expected_observation_lag_minutes, sr.expected_delay_minutes) as expected_lag_minutes,
    map.observation_stale_after_minutes,
    case when ch.metric_key is null then null else
      extract(epoch from (
        now() - case
          when ch.time_precision = 'timestamp' then ch.observed_at
          else (ch.observed_date::timestamp at time zone 'UTC')
        end
      )) / 60
    end as observation_age_minutes
  from public.mic_metric_domain_map map
  left join public.v_mic_latest_metric_changes ch on ch.metric_key = map.metric_key
  left join public.mic_source_registry sr on sr.source_key = ch.source_key
)
select
  base.metric_key,
  base.domain,
  base.current_value,
  base.previous_value,
  base.pct_change,
  base.abs_change,
  base.unit,
  base.observed_date,
  base.observed_at,
  base.time_precision,
  base.fetched_at,
  base.source_key,
  base.provider,
  base.is_delayed,
  base.delay_minutes,
  base.quality_tier,
  base.is_official,
  base.expected_lag_minutes,
  base.observation_age_minutes,
  case
    when base.current_value is null then 'unknown'
    when base.observation_age_minutes <= coalesce(base.expected_lag_minutes, 1440) then 'fresh'
    when base.observation_age_minutes <= coalesce(
      base.observation_stale_after_minutes,
      coalesce(base.expected_lag_minutes, 1440) * 3
    ) then 'delayed_expected'
    else 'stale'
  end as observation_status
from base;

grant select on public.v_mic_metric_observation_status to service_role, authenticated;

-- US2Y/US10Y: keep the 72h fresh cutoff from the prior hardening
-- migration, and add an independent stale-after of 5 calendar days
-- (7200 minutes). Rationale: a plain weekend is a 3-day gap; a single
-- US market holiday adjacent to a weekend (e.g. a Monday holiday) is a
-- 4-day gap between real trading days. 5 days gives a full extra business
-- day of margin beyond that worst ordinary case before treating the
-- series as stale, while still catching a genuine multi-day FRED outage
-- well within two weeks -- versus the 9-day stale cutoff the 3x-of-lag
-- fallback produced in the previous migration.
update public.mic_metric_domain_map
set observation_stale_after_minutes = 7200, -- 5 calendar days
    updated_at = now()
where metric_key in ('US2Y', 'US10Y');

-- JGB2Y/JGB10Y (and every other metric) intentionally untouched --
-- observation_stale_after_minutes stays null, falling back to the
-- original expected_lag_minutes * 3 behavior (1440 * 3 = 4320 minutes,
-- 3 days), so MOF's real multi-week gap keeps surfacing as stale exactly
-- as before this migration.
