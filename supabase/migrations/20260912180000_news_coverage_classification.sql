-- Broad news coverage, Phase 2: store the coverage classification alongside the
-- existing judgement, and allow the new 'disaster' category.
--
-- Expand-only. Nothing existing is dropped or rewritten: `importance`,
-- `japan_market_relevance`, `fact_check_status`, the X publish path, the app feed
-- RPC and both notification producers are untouched,
-- so this migration cannot change what is posted to X, shown in the app, or
-- pushed to anyone. It only adds columns the monitor writes and a wider category
-- check.
--
-- NOT applied to production as part of this change: it is reviewed first (K1),
-- together with the important-news-monitor deploy that writes these columns.
-- `supabase db push` is never used; when approved, this one file is applied on
-- its own after a rolled-back pre-test.
begin;

-- ---------------------------------------------------------------------------
-- 1. 'disaster' category
-- ---------------------------------------------------------------------------
-- Earthquakes, tsunami, eruptions, typhoons and large infrastructure outages had
-- no category of their own, so they could only be stored as
-- major_security_incident or other_market_moving. Both the TS enum
-- (IMPORTANT_NEWS_CATEGORIES) and this check must list it.

alter table public.important_news_candidates
  drop constraint if exists important_news_candidates_category_check;

alter table public.important_news_candidates
  add constraint important_news_candidates_category_check check (category = any (array[
    'earnings_revision_up', 'earnings_revision_down', 'earnings',
    'share_buyback', 'dividend_increase', 'dividend_decrease', 'no_dividend',
    'ma', 'tob', 'business_alliance', 'capital_alliance', 'large_order',
    'misconduct', 'administrative_action', 'litigation', 'major_shareholder',
    'large_shareholding', 'other_corporate_ir', 'boj', 'frb', 'interest_rates',
    'fx', 'tariffs', 'china_policy', 'us_government_policy', 'geopolitics',
    'war_ceasefire', 'sanctions', 'major_security_incident', 'semiconductor_ai',
    'disaster',
    'other_market_moving'
  ]::text[]));

-- ---------------------------------------------------------------------------
-- 2. Coverage classification columns
-- ---------------------------------------------------------------------------
-- coverage_severity is a separate, wider scale than `importance` (which stays
-- the X publish gate): emergency / critical / high / medium / low. It is written
-- when a candidate is stored (emergency only) and completed when the judgement is
-- saved. coverage_categories can hold several categories per item.

alter table public.important_news_candidates
  add column if not exists coverage_categories text[] not null default '{}'::text[],
  add column if not exists coverage_severity text,
  add column if not exists emergency_class text,
  add column if not exists coverage_classified_at timestamptz;

alter table public.important_news_candidates
  drop constraint if exists important_news_candidates_coverage_severity_check;
alter table public.important_news_candidates
  add constraint important_news_candidates_coverage_severity_check
  check (coverage_severity is null or coverage_severity in ('emergency', 'critical', 'high', 'medium', 'low'));

alter table public.important_news_candidates
  drop constraint if exists important_news_candidates_emergency_class_check;
alter table public.important_news_candidates
  add constraint important_news_candidates_emergency_class_check
  check (emergency_class is null or emergency_class in (
    'missile_near_japan', 'war_escalation', 'chokepoint_disruption', 'taiwan_contingency',
    'major_disaster', 'emergency_monetary_action', 'market_infrastructure_failure',
    'oil_supply_disruption'
  ));

-- An emergency is by definition market-wide; a company disclosure never is.
alter table public.important_news_candidates
  drop constraint if exists important_news_candidates_emergency_is_market_wide;
alter table public.important_news_candidates
  add constraint important_news_candidates_emergency_is_market_wide
  check (emergency_class is null or company_code is null);

create index if not exists idx_important_news_coverage_severity
  on public.important_news_candidates (coverage_severity, published_at desc);

create index if not exists idx_important_news_coverage_categories
  on public.important_news_candidates using gin (coverage_categories);

create index if not exists idx_important_news_emergency
  on public.important_news_candidates (published_at desc)
  where emergency_class is not null;

comment on column public.important_news_candidates.coverage_severity is
  'App/notification-facing severity (emergency|critical|high|medium|low). Separate from importance, which remains the X publish gate.';
comment on column public.important_news_candidates.coverage_categories is
  'Coverage categories (may be several): geopolitics, disaster, monetary_policy, fx, rates, oil_energy, commodities, shipping_logistics, semiconductors, ai_tech, us_market, japan_market, regulation_policy, corporate, earnings, financial_system.';
comment on column public.important_news_candidates.emergency_class is
  'Set only for market-wide emergencies (missile near Japan, chokepoint closure, major disaster, ...). Recorded at collection time behind source/freshness gates; reaches opted-in users without a sector match once the notification phase is approved.';

commit;
