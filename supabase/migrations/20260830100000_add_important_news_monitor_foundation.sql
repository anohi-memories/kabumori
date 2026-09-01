create table if not exists public.important_news_monitor_settings (
  id boolean primary key default true check (id),
  is_active boolean not null default false,
  interval_minutes smallint not null default 20 check (interval_minutes >= 5),
  auto_publish boolean not null default false,
  luna_enabled boolean not null default true,
  sol_escalation_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.important_news_candidates (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('primary', 'secondary')),
  source_priority smallint not null check (source_priority in (1, 2)),
  source_url text not null check (source_url ~ '^https://'),
  source_name text not null,
  title text not null,
  normalized_title text not null,
  body_summary text,
  company_code text,
  entity_key text,
  category text not null check (category in (
    'earnings_revision_up', 'earnings_revision_down', 'earnings',
    'share_buyback', 'dividend_increase', 'dividend_decrease', 'no_dividend',
    'ma', 'tob', 'business_alliance', 'capital_alliance', 'large_order',
    'misconduct', 'administrative_action', 'litigation', 'major_shareholder',
    'large_shareholding', 'other_corporate_ir', 'boj', 'frb', 'interest_rates',
    'fx', 'tariffs', 'china_policy', 'us_government_policy', 'geopolitics',
    'war_ceasefire', 'sanctions', 'major_security_incident',
    'semiconductor_ai', 'other_market_moving'
  )),
  published_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  importance text not null default 'no_post'
    check (importance in ('no_post', 'important', 'most_important')),
  status text not null default 'pending_judgement'
    check (status in (
      'fetched', 'duplicate', 'pending_judgement', 'rejected',
      'ready_for_generation', 'published', 'failed'
    )),
  duplicate_of uuid references public.important_news_candidates(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_priority = case source_type when 'primary' then 1 else 2 end),
  check ((status = 'duplicate') = (duplicate_of is not null))
);

create table if not exists public.important_news_monitor_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_type text not null default 'manual' check (trigger_type in ('manual', 'scheduled')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'skipped_inactive')),
  fetched_count integer not null default 0 check (fetched_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  new_candidate_count integer not null default 0 check (new_candidate_count >= 0),
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists important_news_candidates_content_hash_uidx
  on public.important_news_candidates (content_hash);
create unique index if not exists important_news_candidates_source_url_uidx
  on public.important_news_candidates (source_url);
create index if not exists important_news_candidates_duplicate_of_idx
  on public.important_news_candidates (duplicate_of)
  where duplicate_of is not null;
create index if not exists important_news_candidates_title_entity_time_idx
  on public.important_news_candidates (normalized_title, entity_key, company_code, published_at desc);
create index if not exists important_news_candidates_pending_idx
  on public.important_news_candidates (source_priority, published_at desc)
  where status = 'pending_judgement';
create index if not exists important_news_monitor_runs_started_at_idx
  on public.important_news_monitor_runs (started_at desc);

create or replace function public.set_important_news_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists important_news_candidates_updated_at on public.important_news_candidates;
create trigger important_news_candidates_updated_at
before update on public.important_news_candidates
for each row execute function public.set_important_news_updated_at();

drop trigger if exists important_news_monitor_settings_updated_at on public.important_news_monitor_settings;
create trigger important_news_monitor_settings_updated_at
before update on public.important_news_monitor_settings
for each row execute function public.set_important_news_updated_at();

revoke all on function public.set_important_news_updated_at() from public, anon, authenticated;

insert into public.important_news_monitor_settings (
  id, is_active, interval_minutes, auto_publish, luna_enabled, sol_escalation_enabled
) values (true, false, 20, false, true, true)
on conflict (id) do update set
  interval_minutes = 20,
  is_active = false,
  auto_publish = false,
  luna_enabled = true,
  sol_escalation_enabled = true,
  updated_at = now();

alter table public.important_news_monitor_settings enable row level security;
alter table public.important_news_candidates enable row level security;
alter table public.important_news_monitor_runs enable row level security;

revoke all on public.important_news_monitor_settings from anon, authenticated;
revoke all on public.important_news_candidates from anon, authenticated;
revoke all on public.important_news_monitor_runs from anon, authenticated;

grant select on public.important_news_monitor_settings to service_role;
grant select, insert, update on public.important_news_candidates to service_role;
grant select, insert, update on public.important_news_monitor_runs to service_role;

-- Ver.1 stage 1: no cron job and no publication path are created here.
