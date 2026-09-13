-- Market Intelligence Core (MIC) Phase 1B: the State layer. Design doc:
-- docs/market-intelligence/PHASE_1B_STATE_LAYER.md (commit 4db848b3, the
-- 3-fix revision). Expand-only -- nothing from Phase 1A
-- (20260912090000_add_market_intelligence_core_phase1a.sql) is altered.
-- This migration is NOT applied to production as part of this change; it
-- is reviewed and verified against a local/isolated Postgres first.
--
-- Scope: mic_metric_domain_map (metric_key -> domain + material-change
-- thresholds, as data), market_state_current / market_state_history (AI
-- Interpretation only -- never a second copy of Facts), mic_state_evaluation_runs
-- (claim/retry audit, same partial-unique-index pattern as
-- mic_ingestion_runs), and three deterministic views over
-- market_metrics/market_events/mic_ingestion_runs so "what is the value
-- now" and "is this fresh" are always computed live, never duplicated.
--
-- Out of scope for this migration: any AI call, any production write to
-- these tables beyond the fixed seed rows below, Stock State, Scenario/
-- Forecast, Excel export views.
begin;

-- ---------------------------------------------------------------------------
-- 1. mic_metric_domain_map -- metric_key -> domain, and the material-change
--    threshold for that metric. Kept as data (not hardcoded in the
--    evaluator) so thresholds can be tuned without a migration. The domain
--    enum spans all 7 domains from the design doc even though only
--    'rates' and 'commodities' have any seeded metrics yet -- 'fx',
--    'equity_index', 'macro', 'geopolitical', 'corporate_events' have zero
--    rows here until a metric-producing source exists for them (events for
--    geopolitical/corporate_events are handled separately via
--    market_events, not this table).
-- ---------------------------------------------------------------------------
create table public.mic_metric_domain_map (
  metric_key text primary key,
  domain text not null check (domain in (
    'rates', 'fx', 'commodities', 'equity_index', 'macro', 'geopolitical', 'corporate_events'
  )),
  display_name text not null,
  -- Percent-based threshold; use abs_change_threshold instead for metrics
  -- where "%" doesn't make sense (e.g. rates in bp).
  pct_change_threshold numeric(6, 3) check (pct_change_threshold is null or pct_change_threshold > 0),
  abs_change_threshold numeric check (abs_change_threshold is null or abs_change_threshold > 0),
  -- Escape hatch for metrics without a calibrated threshold yet: any new
  -- observation counts as material_change (see the design doc's macro
  -- section). Meant to be flipped back to false once a real threshold is
  -- set -- a data update, not a migration.
  always_material boolean not null default false,
  -- Expected lag between the real-world observation and this metric being
  -- published, in minutes. Null falls back to
  -- mic_source_registry.expected_delay_minutes at query time.
  expected_observation_lag_minutes integer check (expected_observation_lag_minutes is null or expected_observation_lag_minutes >= 0),
  -- How much overrun of the source's update_frequency_minutes is tolerated
  -- before fetch_status flips to 'stale'. Null falls back to a 3x
  -- multiplier in the view.
  fetch_cadence_grace_minutes integer check (fetch_cadence_grace_minutes is null or fetch_cadence_grace_minutes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A registered metric must have some way to ever become material --
  -- otherwise it would silently never trigger AI evaluation at all.
  check (pct_change_threshold is not null or abs_change_threshold is not null or always_material)
);

alter table public.mic_metric_domain_map enable row level security;

drop trigger if exists trg_mic_metric_domain_map_updated_at on public.mic_metric_domain_map;
create trigger trg_mic_metric_domain_map_updated_at
before update on public.mic_metric_domain_map
for each row execute function public.kabumori_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. market_state_current -- AI Interpretation only, one row per domain
--    (singleton per domain key). numeric_baseline_snapshot is grounding
--    metadata for the narrative (what was true when it was written), not a
--    second source of truth -- "what is the value right now" always comes
--    from the views below, never from this table.
--
--    fetch_status and observation_status are two independent axes (design
--    doc section 8): fetch_status says whether the ingestion job itself is
--    running on schedule (from mic_ingestion_runs); observation_status
--    says how old the fetched value itself is (from observed_date/
--    observed_at/time_precision). A source can be fetching fine every day
--    while the value it reports hasn't changed in weeks -- that is
--    fetch_status='fresh' + observation_status='stale', not a single
--    conflated "staleness".
-- ---------------------------------------------------------------------------
create table public.market_state_current (
  domain text primary key check (domain in (
    'rates', 'fx', 'commodities', 'equity_index', 'macro', 'geopolitical', 'corporate_events'
  )),
  as_of timestamptz,
  updated_at timestamptz not null default now(),

  narrative text,
  bullish_factors jsonb,
  bearish_factors jsonb,
  key_risks jsonb,
  numeric_baseline_snapshot jsonb,
  source_metric_keys text[],
  source_event_ids uuid[],

  ai_model text,
  ai_confidence numeric(4, 3) check (ai_confidence is null or ai_confidence between 0 and 1),
  ai_input_tokens integer check (ai_input_tokens is null or ai_input_tokens >= 0),
  ai_output_tokens integer check (ai_output_tokens is null or ai_output_tokens >= 0),
  ai_cost_usd numeric(12, 8) check (ai_cost_usd is null or ai_cost_usd >= 0),
  ai_evaluated_at timestamptz,

  -- Deterministic, code-computed confidence -- never set by AI. Distinct
  -- from ai_confidence (the model's own self-assessment).
  data_confidence numeric(4, 3) check (data_confidence is null or data_confidence between 0 and 1),
  coverage_status text not null default 'unavailable'
    check (coverage_status in ('full', 'partial', 'unavailable')),
  fetch_status text not null default 'unknown'
    check (fetch_status in ('fresh', 'stale', 'failed', 'unknown')),
  observation_status text not null default 'unknown'
    check (observation_status in ('fresh', 'delayed_expected', 'stale', 'unknown')),

  fact_status text not null default 'ai_interpretation'
);

alter table public.market_state_current enable row level security;

drop trigger if exists trg_market_state_current_updated_at on public.market_state_current;
create trigger trg_market_state_current_updated_at
before update on public.market_state_current
for each row execute function public.kabumori_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. market_state_history -- append-only, never overwritten. One row per
--    state change so a past interpretation can always be checked against
--    what actually happened afterward.
-- ---------------------------------------------------------------------------
create table public.market_state_history (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (domain in (
    'rates', 'fx', 'commodities', 'equity_index', 'macro', 'geopolitical', 'corporate_events'
  )),
  as_of timestamptz,
  snapshot jsonb not null,
  triggered_by text not null check (triggered_by in ('material_change', 'scheduled_check', 'manual')),
  reason text,
  created_at timestamptz not null default now()
);

create index mic_market_state_history_domain_idx
  on public.market_state_history (domain, created_at desc);

alter table public.market_state_history enable row level security;

-- ---------------------------------------------------------------------------
-- 4. mic_state_evaluation_runs -- claim/retry + audit for the state
--    evaluator, mirroring mic_ingestion_runs exactly: a partial unique
--    index blocks concurrent/duplicate claims for the same
--    (domain, run_window) while any of 'running', 'no_change', or
--    'evaluated' holds that slot, but a 'failed' row never blocks a later
--    retry attempt.
-- ---------------------------------------------------------------------------
create table public.mic_state_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (domain in (
    'rates', 'fx', 'commodities', 'equity_index', 'macro', 'geopolitical', 'corporate_events'
  )),
  run_window text not null,
  attempt_no integer not null default 1 check (attempt_no >= 1),
  status text not null default 'running'
    check (status in ('running', 'no_change', 'evaluated', 'failed')),
  -- {"new_observations": ["US10Y"], "material": true, "reason": "..."}
  decision_detail jsonb,
  ai_usage_event_id bigint references public.ai_usage_events(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error text
);

create unique index mic_state_evaluation_runs_active_claim_uidx
  on public.mic_state_evaluation_runs (domain, run_window)
  where status in ('running', 'no_change', 'evaluated');

create index mic_state_evaluation_runs_started_at_idx
  on public.mic_state_evaluation_runs (started_at desc);
create index mic_state_evaluation_runs_running_idx
  on public.mic_state_evaluation_runs (domain, started_at)
  where status = 'running';
create index mic_state_evaluation_runs_window_attempt_idx
  on public.mic_state_evaluation_runs (domain, run_window, attempt_no desc);

alter table public.mic_state_evaluation_runs enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Deterministic views. security_invoker so RLS on the underlying
--    tables (market_metrics, market_events, mic_source_registry,
--    mic_metric_domain_map -- all admin-only for `authenticated`) is
--    enforced for whichever role queries the view, not the view owner's.
--    service_role bypasses RLS entirely regardless (rolbypassrls), so this
--    only matters for the admin-dashboard `authenticated` path.
-- ---------------------------------------------------------------------------

-- 5.1 Latest value + prior value + change, per metric_key. Facts only --
-- no domain, no thresholds, no AI. Used by both the observation-status
-- view below and (later) Excel "Market Summary".
create or replace view public.v_mic_latest_metric_changes
  with (security_invoker = true) as
with ranked as (
  select
    mm.*,
    row_number() over (partition by mm.metric_key order by mm.dedupe_anchor_at desc) as rn
  from public.market_metrics mm
)
select
  latest.metric_key,
  latest.value as current_value,
  prev.value as previous_value,
  case when prev.value is not null and prev.value <> 0
    then round((latest.value - prev.value) / abs(prev.value) * 100, 4)
    else null end as pct_change,
  (latest.value - prev.value) as abs_change,
  latest.unit,
  latest.observed_date,
  latest.observed_at,
  latest.time_precision,
  latest.fetched_at,
  latest.source_key,
  latest.provider,
  latest.is_delayed,
  latest.delay_minutes,
  latest.quality_tier,
  latest.is_official
from ranked latest
left join ranked prev on prev.metric_key = latest.metric_key and prev.rn = 2
where latest.rn = 1;

-- 5.2 Fetch freshness (design doc section 8A): is the ingestion job for
-- this source itself running on schedule? Looks only at
-- mic_ingestion_runs + mic_source_registry.update_frequency_minutes --
-- never at the fetched values themselves. Left-joined from
-- mic_source_registry so every registered source appears even with zero
-- runs yet (fetch_status='unknown').
create or replace view public.v_mic_source_fetch_status
  with (security_invoker = true) as
with latest_completed as (
  select distinct on (source_key)
    source_key, completed_at, status
  from public.mic_ingestion_runs
  where status in ('completed', 'failed')
  order by source_key, started_at desc
)
select
  sr.source_key,
  sr.update_frequency_minutes,
  lc.status as last_run_status,
  lc.completed_at as last_completed_at,
  case
    when lc.completed_at is null then 'unknown'
    when lc.status = 'failed' then 'failed'
    when (extract(epoch from (now() - lc.completed_at)) / 60)
      > coalesce(sr.update_frequency_minutes, 60) * 3 then 'stale'
    else 'fresh'
  end as fetch_status
from public.mic_source_registry sr
left join latest_completed lc on lc.source_key = sr.source_key;

-- 5.3 Observation freshness (design doc section 8B): how old is the
-- fetched value itself? Looks only at observed_date/observed_at/
-- time_precision vs an expected publication lag -- never at whether the
-- ingestion job ran. Left-joined from mic_metric_domain_map so every
-- registered metric appears even with zero Facts yet
-- (observation_status='unknown'), and the age computation never writes a
-- fabricated time back anywhere: for 'date' precision it uses
-- observed_date at 00:00 UTC only inside this read-only view expression,
-- never persisted to market_metrics.observed_at.
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
  base.*,
  case
    when base.current_value is null then 'unknown'
    when base.observation_age_minutes <= coalesce(base.expected_lag_minutes, 1440) then 'fresh'
    when base.observation_age_minutes <= coalesce(base.expected_lag_minutes, 1440) * 3 then 'delayed_expected'
    else 'stale'
  end as observation_status
from base;

-- ---------------------------------------------------------------------------
-- RLS / grants -- identical convention to Phase 1A: service_role gets
-- read/write for evaluation, authenticated gets select-only and only for
-- admins (RLS-gated via private.is_admin()), anon gets nothing.
-- ---------------------------------------------------------------------------
revoke all on public.mic_metric_domain_map from anon, authenticated;
revoke all on public.market_state_current from anon, authenticated;
revoke all on public.market_state_history from anon, authenticated;
revoke all on public.mic_state_evaluation_runs from anon, authenticated;

grant select, insert, update, delete on public.mic_metric_domain_map to service_role;
grant select, insert, update on public.market_state_current to service_role;
grant select, insert on public.market_state_history to service_role;
grant select, insert, update on public.mic_state_evaluation_runs to service_role;

grant select on public.mic_metric_domain_map to authenticated;
grant select on public.market_state_current to authenticated;
grant select on public.market_state_history to authenticated;
grant select on public.mic_state_evaluation_runs to authenticated;

create policy admin_select_mic_metric_domain_map on public.mic_metric_domain_map
  for select to authenticated using ((select private.is_admin()));
create policy admin_select_market_state_current on public.market_state_current
  for select to authenticated using ((select private.is_admin()));
create policy admin_select_market_state_history on public.market_state_history
  for select to authenticated using ((select private.is_admin()));
create policy admin_select_mic_state_evaluation_runs on public.mic_state_evaluation_runs
  for select to authenticated using ((select private.is_admin()));

-- Views: service_role bypasses RLS outright; authenticated needs an
-- explicit grant on the view object itself (security_invoker above makes
-- the underlying tables' admin-only RLS apply to whichever role queries
-- the view).
grant select on public.v_mic_latest_metric_changes to service_role, authenticated;
grant select on public.v_mic_source_fetch_status to service_role, authenticated;
grant select on public.v_mic_metric_observation_status to service_role, authenticated;

-- ---------------------------------------------------------------------------
-- Seed data: only the metrics that actually exist in production today
-- (confirmed via the Phase 1A MOF/FRED/EIA smoke tests), with thresholds
-- from the design doc. No fx/equity_index/macro/geopolitical/
-- corporate_events rows -- there is no metric-producing source for those
-- yet, and adding thresholds with no real basis was explicitly out of
-- scope for this change.
-- ---------------------------------------------------------------------------
insert into public.mic_metric_domain_map
  (metric_key, domain, display_name, pct_change_threshold, abs_change_threshold, always_material)
values
  ('US2Y', 'rates', '米国2年国債利回り', null, 0.05, false),
  ('US10Y', 'rates', '米国10年国債利回り', null, 0.05, false),
  ('JGB2Y', 'rates', '日本国債2年利回り', null, 0.05, false),
  ('JGB10Y', 'rates', '日本国債10年利回り', null, 0.05, false),
  ('WTI', 'commodities', 'WTI原油先物', 3.0, null, false),
  ('BRENT', 'commodities', 'Brent原油', 3.0, null, false)
on conflict (metric_key) do nothing;

-- Pre-seed all 7 domain rows so market_state_current always has exactly
-- one row per domain (an UPDATE target that always exists), rather than
-- the evaluator needing insert-or-update branching. Domains with no Facts
-- yet stay at the safe defaults (narrative null, coverage_status
-- 'unavailable', fetch/observation_status 'unknown').
insert into public.market_state_current (domain)
values ('rates'), ('fx'), ('commodities'), ('equity_index'), ('macro'), ('geopolitical'), ('corporate_events')
on conflict (domain) do nothing;

commit;
