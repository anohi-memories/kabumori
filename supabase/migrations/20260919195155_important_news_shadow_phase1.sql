-- Phase 1 live-shadow storage for important-news cost/recall measurement.
--
-- These tables are deliberately isolated from the live candidate selector and
-- publication pipeline.  The shadow Function is the only writer (service_role)
-- and client roles receive no privileges or RLS policies.

create table public.important_news_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  run_slot timestamptz not null,
  trigger_type text not null default 'scheduled'
    check (trigger_type in ('scheduled', 'manual', 'smoke')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed')),
  source_health jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_health) = 'object'),
  free_fetch_count integer not null default 0 check (free_fetch_count >= 0),
  free_candidate_count integer not null default 0 check (free_candidate_count >= 0),
  matched_live_count integer not null default 0 check (matched_live_count >= 0),
  conditional_search_count integer not null default 0 check (conditional_search_count >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  web_search_calls integer not null default 0 check (web_search_calls >= 0),
  cost_usd numeric(12, 8) not null default 0 check (cost_usd >= 0),
  error_summary jsonb not null default '[]'::jsonb
    check (jsonb_typeof(error_summary) = 'array'),
  synthetic boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_slot, trigger_type, synthetic)
);

create table public.important_news_shadow_candidates (
  id uuid primary key default gen_random_uuid(),
  shadow_run_id uuid not null references public.important_news_shadow_runs(id) on delete cascade,
  event_key text not null,
  dedupe_key text not null check (dedupe_key ~ '^[0-9a-f]{64}$'),
  source_name text not null,
  source_url text not null check (source_url ~ '^https://'),
  topic text not null,
  category text not null,
  headline text not null,
  body_summary text,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  trigger_reason text not null,
  free_source_health jsonb not null default '{}'::jsonb
    check (jsonb_typeof(free_source_health) = 'object'),
  conditional_search_used boolean not null default false,
  search_topic text,
  estimated_cost_usd numeric(12, 8) not null default 0 check (estimated_cost_usd >= 0),
  matched_live_candidate_id uuid references public.important_news_candidates(id) on delete set null,
  old_detected_at timestamptz,
  old_importance text check (old_importance is null or old_importance in ('no_post', 'important', 'most_important')),
  detection_delay_sec integer,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  unique (dedupe_key, synthetic)
);

create index important_news_shadow_runs_started_at_idx
  on public.important_news_shadow_runs (started_at desc);
create index important_news_shadow_runs_status_idx
  on public.important_news_shadow_runs (status, started_at desc);
create index important_news_shadow_candidates_first_seen_idx
  on public.important_news_shadow_candidates (first_seen_at desc);
create index important_news_shadow_candidates_live_match_idx
  on public.important_news_shadow_candidates (matched_live_candidate_id)
  where matched_live_candidate_id is not null;
create index important_news_shadow_candidates_topic_seen_idx
  on public.important_news_shadow_candidates (topic, first_seen_at desc);

alter table public.important_news_shadow_runs enable row level security;
alter table public.important_news_shadow_candidates enable row level security;

revoke all on public.important_news_shadow_runs from public, anon, authenticated;
revoke all on public.important_news_shadow_candidates from public, anon, authenticated;

grant select, insert, update, delete on public.important_news_shadow_runs to service_role;
grant select, insert, update, delete on public.important_news_shadow_candidates to service_role;

comment on table public.important_news_shadow_runs is
  'Isolated live-shadow run telemetry; never consumed by the important-news publication pipeline.';
comment on table public.important_news_shadow_candidates is
  'Isolated free-source observations used only for recall/latency measurement.';
