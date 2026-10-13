-- Minimal stub schema for the offline proof (names and columns as used by the feed RPCs). Synthetic only.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
create table public.stocks_master (id uuid primary key default gen_random_uuid(), ticker_code text, company_name text, sector text);
create table public.tracked_stocks (id uuid primary key default gen_random_uuid(), user_id uuid, stock_id uuid, tracking_type text, is_active boolean default true);
create table public.alert_settings (user_id uuid primary key, notification_preset text, market_critical_news boolean default false);
create table public.important_news_candidates (
  id uuid primary key default gen_random_uuid(),
  duplicate_of uuid, status text, importance text default 'no_post', category text, title text, source_type text, source_name text,
  source_url text, published_at timestamptz, created_at timestamptz default now(), company_code text, company_name text,
  japan_market_relevance text, fact_check_status text, coverage_severity text, coverage_categories text[], affected_entities jsonb default '[]',
  body_summary text, generated_text text, generation_fact_status text, app_copy_fact_status text, app_title_ja text, app_summary_ja text,
  app_detail_ja text, app_key_points_ja jsonb, entity_key text
);
