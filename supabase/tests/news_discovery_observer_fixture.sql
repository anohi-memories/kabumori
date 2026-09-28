-- Disposable-only fixture: minimal stand-ins for EXISTING production tables so the proof can show
-- the observer migration leaves them unchanged (definition + ACL). Not production shapes in full.
create table public.important_news_candidates (
  id uuid primary key default gen_random_uuid(), source_type text not null, title text not null,
  status text not null default 'pending_judgement', created_at timestamptz not null default now()
);
create table public.important_news_monitor_runs (id uuid primary key default gen_random_uuid(), status text not null);
create table public.ai_usage_events (id bigserial primary key, feature text not null, cost_usd numeric);
create table public.stocks_master (
  id uuid primary key default gen_random_uuid(), ticker_code text not null, company_name text not null,
  market text not null default 'TSE', is_listed boolean not null default true
);
alter table public.important_news_candidates enable row level security;
revoke all on public.important_news_candidates, public.important_news_monitor_runs, public.ai_usage_events from anon, authenticated;
grant select on public.important_news_candidates to service_role;
grant select on public.stocks_master to service_role;
insert into public.important_news_candidates (source_type, title) values ('tdnet', 'fixture row');
