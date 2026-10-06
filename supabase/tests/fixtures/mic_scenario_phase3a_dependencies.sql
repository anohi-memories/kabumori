-- DISPOSABLE DB ONLY. Minimal dependency columns mirrored from MIC Phase1A,
-- Phase1B and Phase2C1; no historical migration chain or production connection.
do $$ begin
  if current_database() <> 'mic_scenario_review' then raise exception 'DISPOSABLE_DB_REQUIRED'; end if;
end $$;
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create schema private;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create table public.admin_users (user_id uuid primary key);
insert into public.admin_users values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
create function private.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.admin_users where user_id = (select auth.uid()));
$$;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;
revoke execute on function private.is_admin() from anon, public;
create function public.kabumori_set_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
create table public.ai_usage_events (
  id bigint generated always as identity primary key,
  feature text not null, model text not null,
  input_tokens integer not null default 0 check(input_tokens >= 0),
  output_tokens integer not null default 0 check(output_tokens >= 0),
  web_search_calls integer not null default 0 check(web_search_calls >= 0),
  cost_usd numeric(12,8) not null check(cost_usd >= 0),
  related_table text, related_id text, created_at timestamptz not null default now()
);
alter table public.ai_usage_events enable row level security;
grant select, insert on public.ai_usage_events to service_role;
grant usage, select on sequence public.ai_usage_events_id_seq to service_role;
create table public.mic_state_evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  domain text not null check(domain in ('rates','fx','commodities','equity_index','macro','geopolitical','corporate_events')),
  run_window text not null, attempt_no integer not null default 1 check(attempt_no >= 1),
  status text not null default 'running' check(status in ('running','no_change','evaluated','failed')),
  ai_usage_event_id bigint references public.ai_usage_events(id),
  started_at timestamptz not null default now(), completed_at timestamptz
);
create table public.market_state_current (
  domain text primary key check(domain in ('rates','fx','commodities','equity_index','macro','geopolitical','corporate_events')),
  narrative text, bullish_factors jsonb, bearish_factors jsonb, key_risks jsonb,
  ai_confidence numeric(4,3) check(ai_confidence is null or ai_confidence between 0 and 1),
  data_confidence numeric(4,3) check(data_confidence is null or data_confidence between 0 and 1),
  coverage_status text not null default 'unavailable' check(coverage_status in ('full','partial','unavailable')),
  observation_status text not null default 'unknown' check(observation_status in ('fresh','delayed_expected','stale','unknown')),
  ai_evaluated_at timestamptz,
  source_evaluation_run_id uuid references public.mic_state_evaluation_runs(id) on delete restrict,
  updated_at timestamptz not null default now()
);
alter table public.market_state_current enable row level security;
grant select on public.market_state_current, public.mic_state_evaluation_runs to service_role;
grant update on public.market_state_current to service_role; -- existing State writer grant; FOR SHARE also needs it
insert into public.mic_state_evaluation_runs(id,domain,run_window,status) values
 ('11111111-1111-4111-8111-111111111111','rates','fixture','evaluated'),
 ('33333333-3333-4333-8333-333333333333','equity_index','fixture','evaluated');
insert into public.market_state_current(domain,narrative,bullish_factors,bearish_factors,key_risks,ai_confidence,
 data_confidence,coverage_status,observation_status,ai_evaluated_at,source_evaluation_run_id)
select domain, domain || ' interpretation', '["b"]','["r"]','["k"]',0.8,0.9,'full','fresh',now()-interval '2 hours',id
from public.mic_state_evaluation_runs;
