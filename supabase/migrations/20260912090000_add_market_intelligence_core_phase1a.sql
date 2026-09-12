-- Market Intelligence Core (MIC) Phase 1A: the foundation for safely
-- accumulating structured market facts. Expand-only -- nothing existing is
-- altered or dropped. This migration is NOT applied to production as part
-- of this change; it is reviewed first (see docs/market-intelligence/).
--
-- Scope (per docs/market-intelligence/ARCHITECTURE.md section 5, refined
-- after Phase 0 review): source catalog, raw event facts, raw metric time
-- series (with explicit freshness/provenance columns rather than opaque
-- JSONB), ingestion run claims/audit, and a cost ledger schema for future
-- AI usage (no AI is called by anything in this migration or Phase 1A).
--
-- Out of scope for this migration: Market State / Stock State / Scenario
-- tables (Phase 2), Excel export views (Phase 2), any change to existing
-- tables or functions (important_news_*, *_report_*, posting_windows,
-- stocks_master, etc.).
begin;

-- ---------------------------------------------------------------------------
-- 1. mic_source_registry -- single source of truth for where each category
--    of fact/metric comes from. Adapters reference this by source_key;
--    downstream consumers (market_events.source_key, market_metrics.source_key)
--    also reference it, so "which source is this from" is never duplicated
--    as free text.
-- ---------------------------------------------------------------------------
create table if not exists public.mic_source_registry (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  category text not null check (category in (
    'market_price', 'macro', 'corporate_jp', 'corporate_us', 'politics', 'geopolitics'
  )),
  display_name text not null,
  provider text not null,
  endpoint_url text,
  source_kind text not null check (source_kind in ('structured_api', 'rss', 'html_scrape', 'ai_search')),
  requires_auth boolean not null default false,
  cost_tier text not null default 'free' check (cost_tier in ('free', 'freemium', 'paid')),
  update_frequency_minutes integer check (update_frequency_minutes is null or update_frequency_minutes > 0),
  -- Typical publish lag between the real-world observation and when this
  -- source makes it available -- distinct from market_metrics.delay_minutes,
  -- which is the actual measured delay for one observation.
  expected_delay_minutes integer check (expected_delay_minutes is null or expected_delay_minutes >= 0),
  quality_tier text not null check (quality_tier in ('official', 'official_delayed', 'trusted_free', 'fallback')),
  is_official boolean not null default false,
  is_primary boolean not null default true,
  -- Safe default: no adapter run is triggered by anything just because a
  -- registry row exists. Flipping this to true is an ops decision made
  -- after Phase 1A review, not part of this migration.
  is_active boolean not null default false,
  reliability_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mic_source_registry enable row level security;

drop trigger if exists trg_mic_source_registry_updated_at on public.mic_source_registry;
create trigger trg_mic_source_registry_updated_at
before update on public.mic_source_registry
for each row execute function public.kabumori_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. market_events -- discrete Facts (one row per occurrence/disclosure/
--    announcement). AI-generated content is never written here directly;
--    everything in this table is either a deterministic extraction from a
--    structured source, or (in a later phase) an AI-assisted web_search
--    result that has already passed the "model actually visited this URL"
--    check used by important-news-monitor's breaking_market lane. Either
--    way, fact_status distinguishes confidence, and correction/retraction
--    is modelled via duplicate_of / superseded_by rather than overwriting
--    or deleting rows.
-- ---------------------------------------------------------------------------
create table if not exists public.market_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz,
  published_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  event_type text not null check (event_type in (
    'price_move', 'rate_decision', 'macro_release', 'earnings', 'guidance',
    'buyback', 'dividend', 'ma_deal', 'large_order', 'regulatory',
    'shareholder_structure', 'sanction', 'geopolitical', 'political_statement', 'other'
  )),
  category text not null,
  subcategory text,
  country text,
  region text,
  entity_type text check (entity_type in (
    'company', 'government', 'central_bank', 'index', 'commodity', 'currency', 'other'
  )),
  entity_id text,
  ticker text,
  sector text,
  title text not null,
  summary text not null,
  source_name text not null,
  source_url text not null check (source_url ~ '^https://'),
  source_key text not null references public.mic_source_registry(source_key),
  source_timestamp timestamptz,
  importance text check (importance in ('low', 'medium', 'high', 'critical')),
  market_direction text check (market_direction in ('bullish', 'bearish', 'neutral', 'mixed', 'unclear')),
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  fact_status text not null default 'unverified' check (fact_status in (
    'unverified', 'verified', 'needs_review', 'duplicate', 'retracted', 'corrected'
  )),
  raw_payload jsonb,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Advisory-only fuzzy-match helper (e.g. normalized source_url or an
  -- entity+time bucket key). Intentionally NOT unique -- unlike content_hash,
  -- a collision here is a hint for review, not a hard duplicate.
  dedupe_key text,
  duplicate_of uuid references public.market_events(id),
  superseded_by uuid references public.market_events(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((fact_status = 'duplicate') = (duplicate_of is not null)),
  check (superseded_by is null or fact_status in ('retracted', 'corrected')),
  check (superseded_by is null or superseded_by <> id)
);

-- content_hash is a plain (non-partial) unique index, mirroring
-- important_news_candidates: a true duplicate is never inserted as a second
-- row at all (the writer catches the 409 and reports "duplicate" without
-- writing), so there is never a second row sharing a hash to exempt via a
-- partial index.
create unique index if not exists market_events_content_hash_uidx
  on public.market_events (content_hash);
create index if not exists market_events_entity_time_idx
  on public.market_events (entity_id, published_at desc);
create index if not exists market_events_ticker_time_idx
  on public.market_events (ticker, published_at desc) where ticker is not null;
create index if not exists market_events_dedupe_key_idx
  on public.market_events (dedupe_key) where dedupe_key is not null;
create index if not exists market_events_source_key_time_idx
  on public.market_events (source_key, published_at desc);
create index if not exists market_events_duplicate_of_idx
  on public.market_events (duplicate_of) where duplicate_of is not null;
create index if not exists market_events_needs_review_idx
  on public.market_events (fact_status, published_at desc)
  where fact_status in ('needs_review', 'retracted', 'corrected');

alter table public.market_events enable row level security;

drop trigger if exists trg_market_events_updated_at on public.market_events;
create trigger trg_market_events_updated_at
before update on public.market_events
for each row execute function public.kabumori_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. market_metrics -- normalized numeric time series (prices, indices,
--    rates, FX, commodities). Per Phase 0 review: provenance/freshness are
--    explicit columns, not buried in metadata jsonb, because stale-checks,
--    forecasting inputs and the future Excel export all filter/sort on them
--    directly. observed_at (when the value is true in the real world) and
--    fetched_at (when this system retrieved it) are intentionally separate
--    columns -- for most free sources used in Phase 1A the two differ by
--    up to a day (see is_delayed/delay_minutes).
-- ---------------------------------------------------------------------------
create table if not exists public.market_metrics (
  id bigint generated always as identity primary key,
  -- Provider-agnostic on purpose: 'US10Y' is the same metric whether it
  -- comes from FRED today or a paid vendor later. Never embed a provider
  -- name in metric_key.
  metric_key text not null,
  value numeric not null,
  unit text not null,
  observed_at timestamptz not null,
  fetched_at timestamptz not null,
  source_key text not null references public.mic_source_registry(source_key),
  provider text not null,
  source_url text,
  is_delayed boolean not null default false,
  delay_minutes integer check (delay_minutes is null or delay_minutes >= 0),
  quality_tier text not null check (quality_tier in ('official', 'official_delayed', 'trusted_free', 'fallback')),
  is_official boolean not null default false,
  metadata jsonb,
  created_at timestamptz not null default now(),
  check (is_delayed or delay_minutes is null or delay_minutes = 0)
);

-- The dedupe key: re-ingesting the same observation from the same source is
-- an idempotent upsert (fetched_at/metadata refresh), not a new row and not
-- an error.
create unique index if not exists market_metrics_dedupe_uidx
  on public.market_metrics (metric_key, observed_at, source_key);
create index if not exists market_metrics_latest_idx
  on public.market_metrics (metric_key, observed_at desc);
create index if not exists market_metrics_source_key_idx
  on public.market_metrics (source_key, fetched_at desc);

alter table public.market_metrics enable row level security;

-- ---------------------------------------------------------------------------
-- 4. mic_ingestion_runs -- per-source ingestion run audit log AND the
--    idempotency/claim mechanism. The unique (source_key, run_window)
--    constraint *is* the lock, mirroring publish_claims: the first insert
--    for a given window wins, every later attempt for the same window is
--    ignored by Postgres rather than by racy application-level checks.
-- ---------------------------------------------------------------------------
create table if not exists public.mic_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.mic_source_registry(source_key),
  -- A caller-computed bucket key (e.g. "fred:2026-09-12T09") that makes two
  -- invocations for the same source within the same window collide on the
  -- unique constraint below instead of double-fetching.
  run_window text not null,
  trigger_type text not null default 'manual' check (trigger_type in ('manual', 'scheduled')),
  status text not null default 'running' check (status in (
    'running', 'completed', 'failed', 'skipped_inactive', 'skipped_duplicate'
  )),
  fetched_count integer not null default 0 check (fetched_count >= 0),
  new_count integer not null default 0 check (new_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_key, run_window)
);

create index if not exists mic_ingestion_runs_started_at_idx
  on public.mic_ingestion_runs (started_at desc);
create index if not exists mic_ingestion_runs_running_idx
  on public.mic_ingestion_runs (source_key, started_at)
  where status = 'running';

alter table public.mic_ingestion_runs enable row level security;

-- ---------------------------------------------------------------------------
-- 5. ai_usage_events -- a single cross-cutting AI cost ledger for MIC.
--    Schema only in Phase 1A: nothing in this migration or in Phase 1A's
--    Edge Function calls OpenAI, and existing AI usage columns on
--    important_news_candidates / *_report_runs / useful_tip_verifications /
--    post_execution_logs are untouched. This exists now so Phase 2 (Market
--    State AI evaluation) has one ledger to write to from day one instead
--    of adding a fourth ad-hoc copy of the same cost-tracking columns.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  feature text not null,
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  web_search_calls integer not null default 0 check (web_search_calls >= 0),
  cost_usd numeric(12, 8) not null check (cost_usd >= 0),
  related_table text,
  related_id text,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_created_at_idx
  on public.ai_usage_events (created_at desc);
create index if not exists ai_usage_events_feature_idx
  on public.ai_usage_events (feature, created_at desc);

alter table public.ai_usage_events enable row level security;

-- ---------------------------------------------------------------------------
-- RLS / grants -- mirrors the existing admin-dashboard convention exactly
-- (private.is_admin(), e.g. 20260901064201_add_admin_dashboard_access.sql):
-- service_role gets full read/write for ingestion, authenticated gets
-- select-only and only for admins (RLS-gated), anon gets nothing at all.
-- ---------------------------------------------------------------------------
revoke all on public.mic_source_registry from anon, authenticated;
revoke all on public.market_events from anon, authenticated;
revoke all on public.market_metrics from anon, authenticated;
revoke all on public.mic_ingestion_runs from anon, authenticated;
revoke all on public.ai_usage_events from anon, authenticated;

grant select, insert, update, delete on public.mic_source_registry to service_role;
grant select, insert, update on public.market_events to service_role;
grant select, insert on public.market_metrics to service_role;
grant select, insert, update on public.mic_ingestion_runs to service_role;
grant select, insert on public.ai_usage_events to service_role;

grant select on public.mic_source_registry to authenticated;
grant select on public.market_events to authenticated;
grant select on public.market_metrics to authenticated;
grant select on public.mic_ingestion_runs to authenticated;
grant select on public.ai_usage_events to authenticated;

create policy admin_select_mic_source_registry on public.mic_source_registry
  for select to authenticated using ((select private.is_admin()));
create policy admin_select_market_events on public.market_events
  for select to authenticated using ((select private.is_admin()));
create policy admin_select_market_metrics on public.market_metrics
  for select to authenticated using ((select private.is_admin()));
create policy admin_select_mic_ingestion_runs on public.mic_ingestion_runs
  for select to authenticated using ((select private.is_admin()));
create policy admin_select_ai_usage_events on public.ai_usage_events
  for select to authenticated using ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- Seed data: only the 4 source integrations actually implemented in Phase
-- 1A. Categories covered by existing functions (TDnet, BOJ/Fed RSS,
-- breaking_market AI search) are deliberately NOT registered here yet --
-- doing so is a Phase 1B/3 decision once MIC actually reads from them, not
-- busywork for this migration. All rows start is_active=false.
-- ---------------------------------------------------------------------------
insert into public.mic_source_registry
  (source_key, category, display_name, provider, endpoint_url, source_kind, requires_auth,
   cost_tier, update_frequency_minutes, expected_delay_minutes, quality_tier, is_official, is_primary,
   is_active, reliability_notes)
values
  ('fred', 'market_price', 'FRED (Federal Reserve Economic Data)', 'FRED',
   'https://api.stlouisfed.org/fred/series/observations', 'structured_api', true,
   'free', 60, 1440, 'official', true, true,
   false, 'US2Y(DGS2)/US10Y(DGS10)をPhase 1Aで実装済み。CPI/PCE/PAYROLL/GDP等は同adapterのmapping追加のみで対応可能（未実装）。FRED日次系列は当日ではなく前営業日分の確定値が中心のため1日程度の遅延を既定とする。'),
  ('mof_jgb', 'market_price', 'Ministry of Finance Japan -- JGB yields', 'MOF',
   'https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv', 'structured_api', false,
   'free', 1440, 1440, 'official', true, true,
   false, '国債金利情報CSV（Shift-JIS、和暦日付）。Phase 1AではJGB2Y/JGB10Yを実装。'),
  ('eia', 'market_price', 'EIA (U.S. Energy Information Administration)', 'EIA',
   'https://api.eia.gov/v2/petroleum/pri/spt/data/', 'structured_api', true,
   'free', 1440, 1440, 'official', true, true,
   false, 'WTI(RWTC)/Brent(RBRTE)スポット価格。日次更新で確定値には1日前後の遅延あり。'),
  ('sec_edgar', 'corporate_us', 'SEC EDGAR -- company submissions', 'SEC',
   'https://data.sec.gov/submissions/', 'structured_api', false,
   'free', 15, 5, 'official', true, true,
   false, '8-K/10-Q/10-Kのみ検知。Phase 1Aは固定の小規模watchlist（米メガキャップ数社）。CIK拡張・全銘柄監視はPhase 1B以降。User-Agentヘッダ必須（SEC要件、secret未設定時はSECRET_MISSINGで安全に失敗）。')
on conflict (source_key) do nothing;

commit;
