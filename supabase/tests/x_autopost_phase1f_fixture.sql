-- Fake-only Phase1F additions, applied after the Phase1D and Phase1E fixtures
-- and before the Phase1B/1D/1E/1F migrations. Never production. Column sets
-- mirror the live-source migrations for every table a completion touches.
set timezone = 'UTC';

alter table public.post_execution_logs
  add column tip_id uuid,
  add column useful_tip_id uuid,
  add column source_urls jsonb,
  add column verified_at timestamptz,
  add column model_used text,
  add column escalated_to_sol boolean,
  add column input_tokens integer,
  add column output_tokens integer,
  add column api_cost_usd numeric(12,6),
  add column error_code text;

create table public.interaction_topics (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  last_used_at timestamptz,
  use_count integer not null default 0
);
create table public.interaction_post_metrics (
  id bigint generated always as identity primary key,
  scheduled_post_id uuid not null references public.scheduled_posts(id),
  interaction_topic_id uuid not null references public.interaction_topics(id),
  x_post_id text not null,
  created_at timestamptz not null default now(),
  unique (x_post_id)
);
create table public.useful_tips (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  last_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0)
);
create table public.morning_report_runs (
  id uuid primary key default gen_random_uuid(),
  scheduled_post_id uuid references public.scheduled_posts(id),
  generated_at timestamptz,
  source_urls jsonb not null default '[]'::jsonb,
  model_used text not null,
  input_tokens integer, output_tokens integer, api_cost_usd numeric(12,6),
  x_post_id text,
  status text not null check (status in ('generating','dry_run_succeeded','succeeded','failed','skipped_holiday')),
  error text
);
create table public.close_report_runs (like public.morning_report_runs including all);
create table public.us_premarket_report_runs (like public.morning_report_runs including all);

insert into public.interaction_topics (id, title) values
  ('00000000-0000-4000-8000-0000000000c1', 'topic one'),
  ('00000000-0000-4000-8000-0000000000c2', 'topic two');
insert into public.useful_tips (id, title) values ('00000000-0000-4000-8000-0000000000d1', 'useful one');
