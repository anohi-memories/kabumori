-- Market report generation traces: append-only debug evidence of every model generation.
--
-- Why (2026-10-07 morning): the shared analysis failed twice and left a report_status of
-- ANALYSIS_FACT_FAILED, a few fixed codes and the last Fact issue. The generated bodies, the local-guard
-- issues of the first generation and the 07:55 attempt were gone (each retry overwrites the cycle's
-- report_diagnostics), so nobody could tell whether the model had written something wrong or a guard had
-- rejected something safe. During the test phase the model output and the guards' findings are kept.
--
-- Model
--   market_report_generation_traces   append-only. One row per model generation of one invocation of
--                                     the analysis function (a scheduled attempt = one invocation). The
--                                     candidate is the structured output the model returned, so a failed
--                                     generation stays readable after the next generation or the next
--                                     scheduled retry. Written by the function after generating, never
--                                     in the path that delivers a report: a failed insert is only logged.
--
-- No existing object is changed. No client read path: RLS on, no policy, no grant to anon/authenticated;
-- service_role may insert and select (inspection happens with the secret key or the SQL editor).
-- source / subject_ref keep room for personalized reports entering QA later; nothing here generates one.
-- Never store credentials: the writer redacts token / key / Authorization shaped content (see
-- supabase/functions/market-report-analysis/debug_trace.ts); the table has no column for them.

begin;

create table public.market_report_generation_traces (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- What produced the text: the shared market analysis today; a personalized report later.
  source text not null default 'shared_market_report'
    check (source in ('shared_market_report', 'personalized_report')),
  report_type text not null check (report_type in ('morning', 'close')),
  trading_date date not null,
  -- No foreign keys on purpose: a trace must outlive and never block cycle / packet maintenance.
  cycle_id uuid,
  data_packet_id uuid,
  report_packet_id uuid,
  -- Future personalized reports: user / account / report identifier. Null for the shared analysis.
  subject_ref text check (subject_ref is null or char_length(subject_ref) <= 120),
  -- One invocation of the analysis function; attempt is the cycle's report attempt (07:55 = 1, 08:05 = 2).
  invocation_id uuid not null,
  attempt integer not null check (attempt >= 1),
  generation_index integer not null check (generation_index between 1 and 4),
  model text,
  -- Short hash of the instructions the model was given (which prompt produced this candidate).
  prompt_hash text check (prompt_hash is null or prompt_hash ~ '^[0-9a-f]{16}$'),
  stage text not null
    check (stage in ('invalid_output', 'local', 'fact', 'delivered', 'safe_candidate', 'request_failed')),
  hard_rejection text check (hard_rejection is null or hard_rejection in ('invalid_output', 'local', 'fact')),
  local_passed boolean,
  local_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(local_issues) = 'array'),
  local_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(local_warnings) = 'array'),
  fact_ran boolean not null default false,
  fact_passed boolean,
  fact_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(fact_issues) = 'array'),
  selected_for_delivery boolean not null default false,
  fallback_reason text check (fallback_reason is null or char_length(fallback_reason) <= 120),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  -- The structured model output (headline, summary, claims, x_post, app_story ...), null when it did not parse.
  candidate jsonb,
  -- Cumulative for the invocation when this generation finished.
  calls integer check (calls is null or calls >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  api_cost_usd numeric(12, 6) check (api_cost_usd is null or api_cost_usd >= 0),
  constraint market_report_generation_traces_invocation_generation_key unique (invocation_id, generation_index)
);

comment on table public.market_report_generation_traces is
  'Test-phase debug evidence: append-only, one row per model generation (candidate JSON + local / Fact findings). Service role only. Never holds credentials. Written best-effort; its absence never blocks delivery.';

create index market_report_generation_traces_day_idx
  on public.market_report_generation_traces (trading_date, report_type, created_at desc);
create index market_report_generation_traces_cycle_idx
  on public.market_report_generation_traces (cycle_id, attempt, generation_index);

-- Append-only: the evidence of a failed generation must not change afterwards.
create function public.market_report_generation_traces_reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'MARKET_REPORT_GENERATION_TRACE_IMMUTABLE' using errcode = 'P0001';
end;
$$;

create trigger market_report_generation_traces_no_update
  before update on public.market_report_generation_traces
  for each row execute function public.market_report_generation_traces_reject_change();

create trigger market_report_generation_traces_no_delete
  before delete on public.market_report_generation_traces
  for each row execute function public.market_report_generation_traces_reject_change();

create trigger market_report_generation_traces_no_truncate
  before truncate on public.market_report_generation_traces
  for each statement execute function public.market_report_generation_traces_reject_change();

alter table public.market_report_generation_traces enable row level security;

revoke all on table public.market_report_generation_traces from public, anon, authenticated, service_role;
grant select, insert on table public.market_report_generation_traces to service_role;
revoke all on function public.market_report_generation_traces_reject_change() from public, anon, authenticated, service_role;

commit;
