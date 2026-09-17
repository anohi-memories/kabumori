-- Market report shared platform, Phase 2: shared market_report_packet.v1 and
-- the consumer gate.
--
-- Design: docs/market-report-shared-platform/DESIGN.md §5, §9 option B.
-- Builds on 20260919100000_market_report_data_packets_phase1.sql. Adds only new
-- objects plus new columns on market_report_cycles and a replacement of that
-- migration's own cycle guard trigger function. No existing consumer table,
-- Cron, X path, app path or push path is changed.
--
-- Model
--   market_report_packets             insert-only. One Fact-passed shared market
--                                     analysis per cycle (unique cycle_id).
--   market_report_cycles.report_*     analysis attempt state, independent of the
--                                     data packet state.
--   market_report_consumer_settings   singleton gate. x_enabled / app_enabled
--                                     default false: consumers keep their legacy
--                                     paths until the gate is switched on.
--
-- Consumers call get_shared_market_report(consumer, report_type, trading_date).
-- It returns the gate state and, when completed, the report packet with its
-- source data packet, so X and the app read the exact same row.

begin;

alter table public.market_report_cycles
  add column report_status text not null default 'pending'
    check (report_status in ('pending', 'running', 'completed', 'failed')),
  add column report_attempt_count integer not null default 0 check (report_attempt_count >= 0),
  add column report_claim_token uuid,
  add column report_started_at timestamptz,
  add column report_completed_at timestamptz,
  add column report_failed_at timestamptz,
  add column current_report_packet_id uuid,
  add column report_last_error text check (report_last_error is null or char_length(report_last_error) <= 300),
  add column report_diagnostics jsonb not null default '{}'::jsonb check (jsonb_typeof(report_diagnostics) = 'object'),
  add constraint market_report_cycles_report_completed_has_packet
    check (report_status <> 'completed' or current_report_packet_id is not null),
  add constraint market_report_cycles_report_running_has_token
    check ((report_status = 'running') = (report_claim_token is not null));

create table public.market_report_packets (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.market_report_cycles (id),
  data_packet_id uuid not null references public.market_data_packets (id),
  attempt integer not null check (attempt >= 1),
  schema_version text not null check (schema_version = 'market_report_packet.v1'),
  report_type text not null check (report_type in ('morning', 'close')),
  trading_date date not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  fact_status text not null check (fact_status = 'passed'),
  model text not null,
  generation_calls integer not null check (generation_calls >= 1),
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  api_cost_usd numeric(12, 6) not null check (api_cost_usd >= 0),
  created_at timestamptz not null default now(),
  constraint market_report_packets_cycle_key unique (cycle_id),
  constraint market_report_packets_payload_identity check (
    payload ->> 'schema_version' = schema_version
    and payload ->> 'report_type' = report_type
    and payload ->> 'trading_date' = to_char(trading_date, 'YYYY-MM-DD')
    and payload ->> 'data_packet_id' = data_packet_id::text
  )
);

comment on table public.market_report_packets is
  'Phase 2: insert-only, Fact-passed shared market analysis (market_report_packet.v1), one per cycle. Source of the market part of X and app reports once the consumer gate is on.';

create index market_report_packets_data_packet_id_idx on public.market_report_packets (data_packet_id);

alter table public.market_report_cycles
  add constraint market_report_cycles_current_report_packet_fkey
  foreign key (current_report_packet_id) references public.market_report_packets (id);

create trigger market_report_packets_no_update
  before update on public.market_report_packets
  for each row execute function public.market_data_packets_reject_change();

create trigger market_report_packets_no_delete
  before delete on public.market_report_packets
  for each row execute function public.market_data_packets_reject_change();

create trigger market_report_packets_no_truncate
  before truncate on public.market_report_packets
  for each statement execute function public.market_data_packets_reject_change();

create function public.market_report_packets_match_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cycle public.market_report_cycles%rowtype;
begin
  select * into v_cycle from public.market_report_cycles as cycle where cycle.id = new.cycle_id;
  if not found
     or v_cycle.report_type <> new.report_type
     or v_cycle.trading_date <> new.trading_date
     or v_cycle.current_data_packet_id is distinct from new.data_packet_id then
    raise exception 'MARKET_REPORT_PACKET_CYCLE_MISMATCH' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger market_report_packets_match_cycle
  before insert on public.market_report_packets
  for each row execute function public.market_report_packets_match_cycle();

-- Replaces the Phase 1 guard with the same rules plus the report pointer rules.
create or replace function public.market_report_cycles_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_packet public.market_data_packets%rowtype;
  v_report public.market_report_packets%rowtype;
begin
  if new.report_type <> old.report_type or new.trading_date <> old.trading_date then
    raise exception 'MARKET_REPORT_CYCLE_IDENTITY_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.current_data_packet_id is not null
     and new.current_data_packet_id is distinct from old.current_data_packet_id then
    raise exception 'MARKET_REPORT_CYCLE_PACKET_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.cycle_status = 'completed' and new.cycle_status <> 'completed' then
    raise exception 'MARKET_REPORT_CYCLE_COMPLETED_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.current_data_packet_id is not null and old.current_data_packet_id is null then
    select * into v_packet from public.market_data_packets as packet where packet.id = new.current_data_packet_id;
    if not found
       or v_packet.cycle_id <> new.id
       or v_packet.data_quality_status not in ('ok', 'partial') then
      raise exception 'MARKET_REPORT_CYCLE_PACKET_INVALID' using errcode = 'P0001';
    end if;
  end if;

  if old.current_report_packet_id is not null
     and new.current_report_packet_id is distinct from old.current_report_packet_id then
    raise exception 'MARKET_REPORT_CYCLE_REPORT_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.report_status = 'completed' and new.report_status <> 'completed' then
    raise exception 'MARKET_REPORT_CYCLE_REPORT_COMPLETED_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.current_report_packet_id is not null and old.current_report_packet_id is null then
    select * into v_report from public.market_report_packets as report where report.id = new.current_report_packet_id;
    if not found or v_report.cycle_id <> new.id then
      raise exception 'MARKET_REPORT_CYCLE_REPORT_INVALID' using errcode = 'P0001';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Consumer gate (singleton)
-- ---------------------------------------------------------------------------

create table public.market_report_consumer_settings (
  id boolean primary key default true check (id),
  x_enabled boolean not null default false,
  app_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.market_report_consumer_settings is
  'Phase 2 cutover gate. false = X / app keep their legacy market paths. true = they read only the shared market_report_packet and fail closed without one.';

insert into public.market_report_consumer_settings (id) values (true);

-- ---------------------------------------------------------------------------
-- Analysis RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- Outcomes: claimed / already_completed / in_progress / attempts_exhausted /
-- data_not_ready (no cycle, or its data packet is not completed).
create function public.claim_market_report_analysis(
  p_report_type text,
  p_trading_date date,
  p_stale_after_seconds integer default 600,
  p_max_attempts integer default 3
)
returns table (cycle_id uuid, claim_token uuid, attempt integer, outcome text, data_packet_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_cycle public.market_report_cycles%rowtype;
  v_token uuid;
begin
  if p_report_type is null or p_report_type not in ('morning', 'close') or p_trading_date is null then
    raise exception 'MARKET_REPORT_CYCLE_INVALID_ARGUMENT' using errcode = '22023';
  end if;

  select * into v_cycle
  from public.market_report_cycles as cycle
  where cycle.report_type = p_report_type and cycle.trading_date = p_trading_date
  for update;

  if not found or v_cycle.cycle_status <> 'completed' or v_cycle.current_data_packet_id is null then
    return query select v_cycle.id, null::uuid, coalesce(v_cycle.report_attempt_count, 0), 'data_not_ready'::text, null::uuid;
    return;
  end if;
  if v_cycle.report_status = 'completed' then
    return query select v_cycle.id, null::uuid, v_cycle.report_attempt_count, 'already_completed'::text, v_cycle.current_data_packet_id;
    return;
  end if;
  if v_cycle.report_status = 'running'
     and v_cycle.report_started_at > now() - make_interval(secs => greatest(coalesce(p_stale_after_seconds, 600), 60)) then
    return query select v_cycle.id, null::uuid, v_cycle.report_attempt_count, 'in_progress'::text, v_cycle.current_data_packet_id;
    return;
  end if;
  if v_cycle.report_attempt_count >= greatest(coalesce(p_max_attempts, 3), 1) then
    return query select v_cycle.id, null::uuid, v_cycle.report_attempt_count, 'attempts_exhausted'::text, v_cycle.current_data_packet_id;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.market_report_cycles as cycle
  set report_status = 'running',
      report_attempt_count = cycle.report_attempt_count + 1,
      report_claim_token = v_token,
      report_started_at = now(),
      report_last_error = null
  where cycle.id = v_cycle.id;

  return query select v_cycle.id, v_token, v_cycle.report_attempt_count + 1, 'claimed'::text, v_cycle.current_data_packet_id;
end;
$$;

create function public.complete_market_report_analysis(
  p_cycle_id uuid,
  p_claim_token uuid,
  p_payload jsonb,
  p_content_hash text,
  p_model text,
  p_generation_calls integer,
  p_input_tokens integer,
  p_output_tokens integer,
  p_api_cost_usd numeric,
  p_diagnostics jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cycle public.market_report_cycles%rowtype;
  v_packet_id uuid;
begin
  select * into v_cycle from public.market_report_cycles as cycle where cycle.id = p_cycle_id for update;
  if not found
     or p_claim_token is null
     or v_cycle.report_status <> 'running'
     or v_cycle.report_claim_token is distinct from p_claim_token then
    raise exception 'MARKET_REPORT_ANALYSIS_CLAIM_LOST' using errcode = 'P0001';
  end if;

  insert into public.market_report_packets (
    cycle_id, data_packet_id, attempt, schema_version, report_type, trading_date,
    payload, content_hash, fact_status, model, generation_calls, input_tokens, output_tokens, api_cost_usd
  ) values (
    v_cycle.id, v_cycle.current_data_packet_id, v_cycle.report_attempt_count, p_payload ->> 'schema_version',
    v_cycle.report_type, v_cycle.trading_date, p_payload, p_content_hash, 'passed', p_model,
    p_generation_calls, p_input_tokens, p_output_tokens, p_api_cost_usd
  )
  returning id into v_packet_id;

  update public.market_report_cycles as cycle
  set report_status = 'completed',
      current_report_packet_id = v_packet_id,
      report_completed_at = now(),
      report_claim_token = null,
      report_last_error = null,
      report_diagnostics = coalesce(p_diagnostics, '{}'::jsonb)
  where cycle.id = v_cycle.id;

  return v_packet_id;
end;
$$;

create function public.fail_market_report_analysis(
  p_cycle_id uuid,
  p_claim_token uuid,
  p_error text,
  p_diagnostics jsonb default '{}'::jsonb
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.market_report_cycles as cycle
  set report_status = 'failed',
      report_failed_at = now(),
      report_claim_token = null,
      report_last_error = left(coalesce(p_error, 'UNKNOWN'), 300),
      report_diagnostics = coalesce(p_diagnostics, '{}'::jsonb)
  where cycle.id = p_cycle_id
    and cycle.report_status = 'running'
    and p_claim_token is not null
    and cycle.report_claim_token = p_claim_token;
  return case when found then 'failed' else 'claim_lost' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Consumer read RPC (service_role only)
-- ---------------------------------------------------------------------------

create function public.get_shared_market_report(
  p_consumer text,
  p_report_type text,
  p_trading_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_cycle public.market_report_cycles%rowtype;
  v_report public.market_report_packets%rowtype;
  v_data public.market_data_packets%rowtype;
begin
  if p_consumer is null or p_consumer not in ('x', 'app')
     or p_report_type is null or p_report_type not in ('morning', 'close') or p_trading_date is null then
    raise exception 'SHARED_MARKET_REPORT_INVALID_ARGUMENT' using errcode = '22023';
  end if;

  select case when p_consumer = 'x' then settings.x_enabled else settings.app_enabled end
  into v_enabled
  from public.market_report_consumer_settings as settings
  where settings.id;

  if not coalesce(v_enabled, false) then
    return jsonb_build_object('enabled', false, 'status', 'disabled');
  end if;

  select * into v_cycle
  from public.market_report_cycles as cycle
  where cycle.report_type = p_report_type and cycle.trading_date = p_trading_date;

  if not found then
    return jsonb_build_object('enabled', true, 'status', 'missing');
  end if;
  if v_cycle.report_status <> 'completed' or v_cycle.current_report_packet_id is null then
    return jsonb_build_object(
      'enabled', true,
      'status', 'not_ready',
      'cycle_status', v_cycle.cycle_status,
      'report_status', v_cycle.report_status,
      'report_last_error', v_cycle.report_last_error
    );
  end if;

  select * into v_report from public.market_report_packets as report where report.id = v_cycle.current_report_packet_id;
  select * into v_data from public.market_data_packets as data where data.id = v_report.data_packet_id;

  return jsonb_build_object(
    'enabled', true,
    'status', 'completed',
    'report_packet_id', v_report.id,
    'report_content_hash', v_report.content_hash,
    'data_packet_id', v_data.id,
    'data_content_hash', v_data.content_hash,
    'report', v_report.payload,
    'data', v_data.payload
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS / grants
-- ---------------------------------------------------------------------------

alter table public.market_report_packets enable row level security;
alter table public.market_report_consumer_settings enable row level security;

revoke all on table public.market_report_packets from public, anon, authenticated, service_role;
revoke all on table public.market_report_consumer_settings from public, anon, authenticated, service_role;
grant select on table public.market_report_packets to service_role;
grant select on table public.market_report_consumer_settings to service_role;

revoke all on function public.market_report_packets_match_cycle() from public, anon, authenticated, service_role;
revoke all on function public.market_report_cycles_guard_update() from public, anon, authenticated, service_role;

revoke all on function public.claim_market_report_analysis(text, date, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_market_report_analysis(uuid, uuid, jsonb, text, text, integer, integer, integer, numeric, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_market_report_analysis(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.get_shared_market_report(text, text, date) from public, anon, authenticated;
grant execute on function public.claim_market_report_analysis(text, date, integer, integer) to service_role;
grant execute on function public.complete_market_report_analysis(uuid, uuid, jsonb, text, text, integer, integer, integer, numeric, jsonb)
  to service_role;
grant execute on function public.fail_market_report_analysis(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.get_shared_market_report(text, text, date) to service_role;

commit;
