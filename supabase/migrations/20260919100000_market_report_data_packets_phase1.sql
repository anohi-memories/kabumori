-- Market report shared platform, Phase 1: market_data_packet shadow storage.
--
-- Design: docs/market-report-shared-platform/DESIGN.md (§4, §9 option B).
-- This migration only adds new objects. No existing table, function, Cron,
-- X path, app path or push path is touched, and nothing reads these tables
-- yet (shadow). Do not apply to production before K1 approval.
--
-- Model
--   market_report_cycles  one row per (report_type, trading_date). Carries the
--                         claim/attempt state and, once completed, a pointer
--                         to the packet that is the cycle's source of truth.
--   market_data_packets   insert-only. Every attempt that produced a packet
--                         (usable or blocked) is kept; rows can never be
--                         updated or deleted.
--
-- Invariants enforced in the database (not only in the Edge Function)
--   * one cycle per (report_type, trading_date)
--   * a packet cannot be updated or deleted
--   * a cycle's current_data_packet_id is set at most once, only to a usable
--     (ok / partial) packet of the same cycle, and a completed cycle never
--     changes status again, so a retry cannot overwrite a confirmed packet
--   * a packet's identity columns always match its payload and its cycle
--
-- Access: RLS on with no policies; anon/authenticated have no privileges.
-- service_role may only select; every write goes through the three
-- SECURITY DEFINER RPCs below (service_role only).

begin;

create table public.market_report_cycles (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('morning', 'close')),
  trading_date date not null,
  cycle_status text not null default 'pending'
    check (cycle_status in ('pending', 'running', 'completed', 'blocked', 'failed')),
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claim_token uuid,
  current_data_packet_id uuid,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  diagnostics jsonb not null default '{}'::jsonb check (jsonb_typeof(diagnostics) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_report_cycles_type_date_key unique (report_type, trading_date),
  constraint market_report_cycles_completed_has_packet
    check (cycle_status <> 'completed' or current_data_packet_id is not null),
  constraint market_report_cycles_running_has_token
    check ((cycle_status = 'running') = (claim_token is not null))
);

comment on table public.market_report_cycles is
  'Shadow (Phase 1): one market report cycle per report_type + trading_date. current_data_packet_id is set once and never changes.';

create table public.market_data_packets (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.market_report_cycles (id),
  attempt integer not null check (attempt >= 1),
  schema_version text not null check (schema_version = 'market_data_packet.v1'),
  report_type text not null check (report_type in ('morning', 'close')),
  trading_date date not null,
  as_of timestamptz not null,
  generated_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  data_quality_status text not null check (data_quality_status in ('ok', 'partial', 'blocked')),
  created_at timestamptz not null default now(),
  constraint market_data_packets_cycle_attempt_key unique (cycle_id, attempt),
  constraint market_data_packets_payload_identity check (
    payload ->> 'schema_version' = schema_version
    and payload ->> 'report_type' = report_type
    and payload ->> 'trading_date' = to_char(trading_date, 'YYYY-MM-DD')
    and payload #>> '{data_quality,status}' = data_quality_status
  )
);

comment on table public.market_data_packets is
  'Shadow (Phase 1): insert-only market_data_packet.v1 facts (no AI). Rows are immutable.';

create index market_data_packets_cycle_id_idx on public.market_data_packets (cycle_id);
create index market_report_cycles_trading_date_idx on public.market_report_cycles (trading_date desc);

alter table public.market_report_cycles
  add constraint market_report_cycles_current_packet_fkey
  foreign key (current_data_packet_id) references public.market_data_packets (id);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

create function public.market_data_packets_reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'MARKET_DATA_PACKET_IMMUTABLE' using errcode = 'P0001';
end;
$$;

create trigger market_data_packets_no_update
  before update on public.market_data_packets
  for each row execute function public.market_data_packets_reject_change();

create trigger market_data_packets_no_delete
  before delete on public.market_data_packets
  for each row execute function public.market_data_packets_reject_change();

create trigger market_data_packets_no_truncate
  before truncate on public.market_data_packets
  for each statement execute function public.market_data_packets_reject_change();

create function public.market_data_packets_match_cycle()
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
     or v_cycle.trading_date <> new.trading_date then
    raise exception 'MARKET_DATA_PACKET_CYCLE_MISMATCH' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger market_data_packets_match_cycle
  before insert on public.market_data_packets
  for each row execute function public.market_data_packets_match_cycle();

create function public.market_report_cycles_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_packet public.market_data_packets%rowtype;
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
  new.updated_at := now();
  return new;
end;
$$;

create trigger market_report_cycles_guard_update
  before update on public.market_report_cycles
  for each row execute function public.market_report_cycles_guard_update();

-- ---------------------------------------------------------------------------
-- RPCs (service_role only)
-- ---------------------------------------------------------------------------

-- Claims the cycle for one attempt. Outcomes:
--   claimed            caller owns attempt N and must complete or fail it
--   already_completed  a usable packet exists; nothing to do (idempotent)
--   in_progress        another attempt is running and not yet stale
--   attempts_exhausted retry budget used up
create function public.claim_market_report_cycle(
  p_report_type text,
  p_trading_date date,
  p_scheduled_for timestamptz default null,
  p_stale_after_seconds integer default 900,
  p_max_attempts integer default 3
)
returns table (cycle_id uuid, claim_token uuid, attempt integer, outcome text)
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

  insert into public.market_report_cycles (report_type, trading_date, scheduled_for)
  values (p_report_type, p_trading_date, p_scheduled_for)
  on conflict (report_type, trading_date) do nothing;

  select * into v_cycle
  from public.market_report_cycles as cycle
  where cycle.report_type = p_report_type and cycle.trading_date = p_trading_date
  for update;

  if v_cycle.cycle_status = 'completed' then
    return query select v_cycle.id, null::uuid, v_cycle.attempt_count, 'already_completed'::text;
    return;
  end if;

  if v_cycle.cycle_status = 'running'
     and v_cycle.started_at > now() - make_interval(secs => greatest(coalesce(p_stale_after_seconds, 900), 60)) then
    return query select v_cycle.id, null::uuid, v_cycle.attempt_count, 'in_progress'::text;
    return;
  end if;

  if v_cycle.attempt_count >= greatest(coalesce(p_max_attempts, 3), 1) then
    return query select v_cycle.id, null::uuid, v_cycle.attempt_count, 'attempts_exhausted'::text;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.market_report_cycles as cycle
  set cycle_status = 'running',
      attempt_count = cycle.attempt_count + 1,
      claim_token = v_token,
      started_at = now(),
      scheduled_for = coalesce(cycle.scheduled_for, p_scheduled_for),
      last_error = null
  where cycle.id = v_cycle.id;

  return query select v_cycle.id, v_token, v_cycle.attempt_count + 1, 'claimed'::text;
end;
$$;

-- Stores the packet for the claimed attempt. A usable packet (ok / partial)
-- completes the cycle and becomes its permanent current packet; a blocked
-- packet is kept for diagnostics and leaves the cycle retryable.
create function public.complete_market_report_cycle(
  p_cycle_id uuid,
  p_claim_token uuid,
  p_payload jsonb,
  p_content_hash text,
  p_as_of timestamptz,
  p_generated_at timestamptz,
  p_diagnostics jsonb default '{}'::jsonb
)
returns table (packet_id uuid, cycle_status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_cycle public.market_report_cycles%rowtype;
  v_packet_id uuid;
  v_quality text;
  v_status text;
begin
  select * into v_cycle
  from public.market_report_cycles as cycle
  where cycle.id = p_cycle_id
  for update;

  if not found
     or p_claim_token is null
     or v_cycle.cycle_status <> 'running'
     or v_cycle.claim_token is distinct from p_claim_token then
    raise exception 'MARKET_REPORT_CYCLE_CLAIM_LOST' using errcode = 'P0001';
  end if;

  v_quality := p_payload #>> '{data_quality,status}';

  insert into public.market_data_packets (
    cycle_id, attempt, schema_version, report_type, trading_date,
    as_of, generated_at, payload, content_hash, data_quality_status
  ) values (
    v_cycle.id, v_cycle.attempt_count, p_payload ->> 'schema_version', v_cycle.report_type, v_cycle.trading_date,
    p_as_of, p_generated_at, p_payload, p_content_hash, v_quality
  )
  returning id into v_packet_id;

  if v_quality in ('ok', 'partial') then
    v_status := 'completed';
    update public.market_report_cycles as cycle
    set cycle_status = 'completed',
        current_data_packet_id = v_packet_id,
        completed_at = now(),
        claim_token = null,
        last_error = null,
        diagnostics = coalesce(p_diagnostics, '{}'::jsonb)
    where cycle.id = v_cycle.id;
  else
    v_status := 'blocked';
    update public.market_report_cycles as cycle
    set cycle_status = 'blocked',
        failed_at = now(),
        claim_token = null,
        last_error = 'DATA_QUALITY_BLOCKED',
        diagnostics = coalesce(p_diagnostics, '{}'::jsonb)
    where cycle.id = v_cycle.id;
  end if;

  return query select v_packet_id, v_status;
end;
$$;

-- Records a failed attempt that produced no packet. Returns 'failed', or
-- 'claim_lost' when the caller no longer owns the attempt.
create function public.fail_market_report_cycle(
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
  set cycle_status = 'failed',
      failed_at = now(),
      claim_token = null,
      last_error = left(coalesce(p_error, 'UNKNOWN'), 300),
      diagnostics = coalesce(p_diagnostics, '{}'::jsonb)
  where cycle.id = p_cycle_id
    and cycle.cycle_status = 'running'
    and p_claim_token is not null
    and cycle.claim_token = p_claim_token;
  return case when found then 'failed' else 'claim_lost' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS / grants
-- ---------------------------------------------------------------------------

alter table public.market_report_cycles enable row level security;
alter table public.market_data_packets enable row level security;

revoke all on table public.market_report_cycles from public, anon, authenticated, service_role;
revoke all on table public.market_data_packets from public, anon, authenticated, service_role;
grant select on table public.market_report_cycles to service_role;
grant select on table public.market_data_packets to service_role;

revoke all on function public.market_data_packets_reject_change() from public, anon, authenticated, service_role;
revoke all on function public.market_data_packets_match_cycle() from public, anon, authenticated, service_role;
revoke all on function public.market_report_cycles_guard_update() from public, anon, authenticated, service_role;

revoke all on function public.claim_market_report_cycle(text, date, timestamptz, integer, integer)
  from public, anon, authenticated;
revoke all on function public.complete_market_report_cycle(uuid, uuid, jsonb, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.fail_market_report_cycle(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_market_report_cycle(text, date, timestamptz, integer, integer) to service_role;
grant execute on function public.complete_market_report_cycle(uuid, uuid, jsonb, text, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.fail_market_report_cycle(uuid, uuid, text, jsonb) to service_role;

commit;
