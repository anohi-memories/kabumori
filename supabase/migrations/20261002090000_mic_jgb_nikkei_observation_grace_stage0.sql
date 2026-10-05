-- Market Intelligence Core (MIC) State freshness Stage 0: holiday-tolerant
-- observation freshness for the Japanese-calendar metrics.
--
-- NOT APPLIED ANYWHERE. Source-only candidate. Data-only change to
-- mic_metric_domain_map; no schema, view, RPC, Cron or State/Scenario
-- freshness contract changes (ai_evaluated_at, source_evaluation_run_id and
-- Scenario valid_until keep their meaning).
--
-- v_mic_metric_observation_status classifies each metric by the age of its
-- newest observation (now - observed_date 00:00 UTC):
--   age <= expected_observation_lag_minutes          -> fresh
--   age <= observation_stale_after_minutes           -> delayed_expected
--   otherwise                                        -> stale
-- and a domain's observation_status is its WORST metric, so one metric that
-- is 'stale' takes 0.4 off the whole domain's data_confidence.
--
-- JGB2Y / JGB10Y (source: MOF, rates domain)
--   Before: no per-metric values, so the fallback applied: fresh <= 24 h
--   (mic_source_registry.expected_delay_minutes = 1440), stale after 3 days
--   (3 x 1440). MOF publishes day T's yields on the next business day, so
--   with the corrected adapter the newest row is already ~30-54 h old on an
--   ordinary weekday and ~78-102 h old across a weekend: never 'fresh', and
--   'stale' every Monday.
--   After: fresh <= 96 h, stale after 10 days.
--     96 h   an ordinary weekend (Friday's row read on Monday, ~78-81 h) is
--            fresh; a Monday holiday shows 'delayed_expected' (-0.1), which
--            is what that status means.
--     10 d   Japanese holiday clusters are normal, not outages. The real
--            file has no row between 2026-09-18 and 2026-09-24 (Respect for
--            the Aged Day, a bridge holiday and the Autumnal Equinox): on
--            the morning of 09-25, before the 06:00 UTC ingest reads 09-24's row, the
--            newest row is 7.25 days old. Golden Week and New Year produce
--            the same shape. 10 days covers them with margin and still
--            reports a real MOF outage within two weeks. A rare 10-day
--            Golden Week (2019) would still surface as stale.
--
-- NIKKEI225 (source: FRED, equity_index domain)
--   Before: fresh <= 72 h, stale after 5 days -- the values chosen for the
--   US series, whose longest ordinary gap is a 4-day holiday weekend.
--   FRED carries a NIKKEI225 row on the same day (2026-10-01's row was
--   present at 21:00 UTC that day), but Tokyo's holiday clusters are longer
--   than New York's: 2026-09-18 -> 09-24 is 6 days, and year-end/New Year can
--   reach 6.9 days (last session Fri 12-29, first session Thu 01-04). With a
--   5-day cutoff the metric turned 'stale' on the last day of each cluster
--   and dragged the whole equity_index State to data_confidence 0.6.
--   After: fresh <= 72 h (unchanged), stale after 8 days (one day beyond the
--   6.9-day worst ordinary case). It is deliberately shorter than the JGB
--   value because there is no next-business-day publication lag on top.
--
-- SP500 / NASDAQ / VIX / US2Y / US10Y / FED_FUNDS_* are not touched.
begin;

do $migration$
declare
  v_count integer;
begin
  update public.mic_metric_domain_map
  set expected_observation_lag_minutes = 5760,   -- 96 h
      observation_stale_after_minutes = 14400,   -- 10 days
      updated_at = now()
  where metric_key in ('JGB2Y', 'JGB10Y')
    and domain = 'rates'
    and (
      (expected_observation_lag_minutes is null and observation_stale_after_minutes is null)
      or (expected_observation_lag_minutes = 5760 and observation_stale_after_minutes = 14400)
    );
  get diagnostics v_count = row_count;
  if v_count <> 2 then
    raise exception 'Expected JGB2Y/JGB10Y in rates with original or Stage0 freshness, updated % row(s)', v_count;
  end if;

  update public.mic_metric_domain_map
  set observation_stale_after_minutes = 11520,   -- 8 days (fresh cutoff stays 4320 = 72 h)
      updated_at = now()
  where metric_key = 'NIKKEI225'
    and expected_observation_lag_minutes = 4320
    and domain = 'equity_index'
    and observation_stale_after_minutes in (7200, 11520);
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'Expected NIKKEI225 in equity_index with original or Stage0 freshness, updated % row(s)', v_count;
  end if;
end
$migration$;

commit;
