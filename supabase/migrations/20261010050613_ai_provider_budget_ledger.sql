-- AI provider budget ledger (common AI foundation, Phase 1b). Source candidate: NOT applied anywhere.
--
-- What it adds (nothing existing is changed):
--   * schema ai_ledger (not exposed to the Data API, no grant to any application role) holding
--       budget_policies       caps per scope (whole / provider / model / application / feature / role / subject kind /
--                             one brand / one user, or per-brand / per-user buckets), per JST month or JST day;
--       budget_buckets        the live counters of each policy x period (x brand / x user);
--       reservations          one row per HTTP attempt: reserved -> sent -> settled | unknown, or reserved -> released;
--       usage_events          the append-only ledger: one row per finalised attempt, priced when it happened;
--       billing_observations  append-only figures read from the provider (Console usage, credit, out-of-pocket),
--                             kept apart from our own estimates for later reconciliation;
--   * seven public RPCs (p jsonb -> jsonb), SECURITY DEFINER, search_path '', EXECUTE for service_role only:
--       ai_ledger_reserve, ai_ledger_mark_sent, ai_ledger_settle, ai_ledger_release, ai_ledger_recover_stale,
--       ai_ledger_usage_summary, ai_ledger_budget_status.
--
-- Why SECURITY DEFINER: the tables have no grant to any application role, service_role included, so the only
-- way to change the ledger is through these functions, which keep its invariants (atomic check-and-reserve,
-- idempotent settlement, append-only events, no release of a sent attempt). With SECURITY INVOKER service_role
-- would need direct table writes and could bypass all of that.
--
-- Concurrency: every reservation takes one transaction-scoped advisory lock (reservations are serialised; they are
-- rare and short), then locks the affected bucket rows FOR UPDATE in id order. Settlement / release / recovery
-- lock the reservation row, then its buckets in id order. A stale REPEATABLE READ snapshot cannot overbook: the
-- FOR UPDATE of a bucket changed after the snapshot raises serialization_failure.
--
-- Money is NUMERIC (8 decimals); a usage event stores the cost computed when it happened together with the price
-- catalog version, and is never recomputed. Estimated cost is not the provider invoice and not credit.
--
-- Personal data: only opaque subject identifiers (user_id / brand_id uuid, no foreign key so the common-account
-- deletion flow is untouched), token counts, model names, status and estimated cost. No prompt, output, API key,
-- header or conversation is stored. Retention / deletion: docs/ai-provider/PHASE1B_LEDGER_DESIGN.md.
--
-- Access is verified, not assumed: after the objects and grants exist, the migration checks owners, memberships,
-- the exact direct ACLs and the EFFECTIVE privileges of anon / authenticated / service_role, and raises (rolling
-- the whole migration back) if anything is reachable that should not be. Nothing is repaired.

begin;

create schema ai_ledger;
comment on schema ai_ledger is
  'AI provider usage ledger and budget counters. Owner-only; reached only through the public.ai_ledger_* RPCs.';
-- Also any default USAGE / CREATE the environment would hand to an application role on a new schema.
revoke all on schema ai_ledger from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Helpers (owner-only)
-- ---------------------------------------------------------------------------------------------------------
create function ai_ledger.jst_month_start(p_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select date_trunc('month', (p_at at time zone 'UTC') + interval '9 hours')::date
$$;

create function ai_ledger.jst_day(p_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select ((p_at at time zone 'UTC') + interval '9 hours')::date
$$;

-- The value of a required / optional identifier field; raises AI_LEDGER_INVALID_INPUT otherwise.
create function ai_ledger.input_identifier(p jsonb, p_key text, p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text;
begin
  if p is null or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' then
    if p_required then
      raise exception 'AI_LEDGER_INVALID_INPUT: % is required', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(p -> p_key) <> 'string' then
    raise exception 'AI_LEDGER_INVALID_INPUT: % must be a string', p_key using errcode = '22023';
  end if;
  v := p ->> p_key;
  if v !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$' then
    raise exception 'AI_LEDGER_INVALID_INPUT: % is not an identifier', p_key using errcode = '22023';
  end if;
  return v;
end;
$$;

create function ai_ledger.input_uuid(p jsonb, p_key text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p -> p_key) <> 'string' or (p ->> p_key) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'AI_LEDGER_INVALID_INPUT: % must be a uuid', p_key using errcode = '22023';
  end if;
  return (p ->> p_key)::uuid;
end;
$$;

-- A JSON number within [p_min, p_max]; null when absent and not required.
create function ai_ledger.input_number(p jsonb, p_key text, p_required boolean, p_min numeric, p_max numeric)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if p is null or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' then
    if p_required then
      raise exception 'AI_LEDGER_INVALID_INPUT: % is required', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(p -> p_key) <> 'number' then
    raise exception 'AI_LEDGER_INVALID_INPUT: % must be a number', p_key using errcode = '22023';
  end if;
  v := (p ->> p_key)::numeric;
  if v < p_min or v > p_max then
    raise exception 'AI_LEDGER_INVALID_INPUT: % is out of range', p_key using errcode = '22023';
  end if;
  return v;
end;
$$;

create function ai_ledger.input_count(p jsonb, p_key text, p_required boolean)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric := ai_ledger.input_number(p, p_key, p_required, 0, 10000000000);
begin
  if v is not null and v <> trunc(v) then
    raise exception 'AI_LEDGER_INVALID_INPUT: % must be an integer', p_key using errcode = '22023';
  end if;
  return v::bigint;
end;
$$;

-- Round a USD amount UP to the ledger scale (8 decimals), so an upper bound never shrinks.
create function ai_ledger.ceil_usd(p numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select (ceil(p * 100000000) / 100000000)::numeric(16, 8)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------
create table ai_ledger.budget_policies (
  id uuid primary key default gen_random_uuid(),
  policy_key text not null unique check (policy_key ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'),
  scope_provider text check (scope_provider in ('openai', 'anthropic')),
  scope_model text check (scope_model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  scope_application text check (scope_application ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  scope_feature text check (scope_feature ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  scope_logical_role text check (scope_logical_role ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  scope_subject_kind text check (scope_subject_kind in ('system', 'user')),
  scope_brand_id uuid,
  scope_user_id uuid,
  -- true: a separate counter per brand / per user (the policy then applies only to calls that carry one).
  per_brand boolean not null default false,
  per_user boolean not null default false,
  period text not null check (period in ('month', 'day')),
  max_estimated_usd numeric(14, 6) check (max_estimated_usd >= 0),
  max_calls integer check (max_calls >= 0),
  max_usd_per_call numeric(14, 6) check (max_usd_per_call >= 0),
  enabled boolean not null default true,
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_policies_has_cap check (max_estimated_usd is not null or max_calls is not null or max_usd_per_call is not null),
  constraint budget_policies_brand_scope check (not (per_brand and scope_brand_id is not null)),
  constraint budget_policies_user_scope check (not (per_user and scope_user_id is not null)),
  -- A policy about brands or users can only concern user calls: system work never carries either.
  constraint budget_policies_subject_scope check (
    (scope_brand_id is null and scope_user_id is null and not per_brand and not per_user)
    or scope_subject_kind = 'user'
  )
);
comment on table ai_ledger.budget_policies is
  'Budget caps. Every enabled policy whose scope matches a call applies; the call must satisfy all of them.';

create table ai_ledger.budget_buckets (
  id bigint generated always as identity primary key,
  policy_id uuid not null references ai_ledger.budget_policies (id) on delete restrict,
  period_start date not null,
  brand_id uuid,
  user_id uuid,
  calls integer not null default 0 check (calls >= 0),
  held_usd numeric(16, 8) not null default 0 check (held_usd >= 0),
  settled_usd numeric(16, 8) not null default 0 check (settled_usd >= 0),
  updated_at timestamptz not null default now(),
  constraint budget_buckets_key unique nulls not distinct (policy_id, period_start, brand_id, user_id)
);
comment on table ai_ledger.budget_buckets is
  'Live counters: calls and held (in-flight reservations) + settled (finalised, measured or upper bound) USD.';

create table ai_ledger.reservations (
  id uuid primary key default gen_random_uuid(),
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  attempt smallint not null check (attempt between 1 and 10),
  attempt_id text generated always as (request_id || '#' || attempt::text) stored,
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null check (model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  application text not null check (application ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  feature text not null check (feature ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  logical_role text not null check (logical_role ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  subject_kind text not null check (subject_kind in ('system', 'user')),
  user_id uuid,
  brand_id uuid,
  billing_month date not null,
  usage_day date not null,
  reserved_usd numeric(16, 8) not null check (reserved_usd >= 0),
  bucket_ids bigint[] not null,
  status text not null check (status in ('reserved', 'sent', 'settled', 'unknown', 'released')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  finalized_at timestamptz,
  constraint reservations_attempt_key unique (request_id, attempt),
  constraint reservations_attempt_id_key unique (attempt_id),
  constraint reservations_subject check (
    (subject_kind = 'system' and user_id is null and brand_id is null)
    or (subject_kind = 'user' and user_id is not null)
  ),
  constraint reservations_state check (
    (status = 'reserved' and sent_at is null and finalized_at is null)
    or (status = 'sent' and sent_at is not null and finalized_at is null)
    or (status = 'released' and sent_at is null and finalized_at is not null)
    or (status in ('settled', 'unknown') and finalized_at is not null)
  )
);
comment on table ai_ledger.reservations is
  'One row per HTTP attempt. reserved = provably not sent; sent = dispatched, outcome pending; settled = measured; '
  'unknown = outcome unknown, held at its upper bound for good; released = never sent, hold returned.';

create table ai_ledger.usage_events (
  id bigint generated always as identity primary key,
  reservation_id uuid not null references ai_ledger.reservations (id) on delete restrict,
  request_id text not null,
  attempt smallint not null,
  attempt_id text not null,
  provider text not null,
  model text not null,
  actual_model text check (actual_model ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  application text not null,
  feature text not null,
  logical_role text not null,
  subject_kind text not null check (subject_kind in ('system', 'user')),
  user_id uuid,
  brand_id uuid,
  billing_month date not null,
  outcome text not null check (outcome in ('succeeded', 'failed', 'unknown')),
  error_code text check (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  cost_basis text not null check (cost_basis in ('measured', 'upper_bound')),
  input_tokens bigint check (input_tokens >= 0),
  cache_read_input_tokens bigint check (cache_read_input_tokens >= 0),
  cache_write_5m_input_tokens bigint check (cache_write_5m_input_tokens >= 0),
  cache_write_1h_input_tokens bigint check (cache_write_1h_input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  reasoning_output_tokens bigint check (reasoning_output_tokens >= 0),
  estimated_cost_usd numeric(16, 8) not null check (estimated_cost_usd >= 0),
  reserved_usd numeric(16, 8) not null check (reserved_usd >= 0),
  price_catalog_version text not null check (price_catalog_version ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$'),
  provider_request_id text check (provider_request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  http_status smallint check (http_status between 100 and 599),
  latency_ms integer check (latency_ms >= 0),
  created_at timestamptz not null default now(),
  constraint usage_events_reservation_key unique (reservation_id),
  constraint usage_events_attempt_id_key unique (attempt_id),
  -- measured: the provider reported usage. upper_bound: usage unknown (timeout, lost connection, unreadable body,
  -- or a response without usage), charged at no less than the hold. An unknown OUTCOME always has unknown usage.
  constraint usage_events_basis check (
    (cost_basis = 'measured' and outcome <> 'unknown' and input_tokens is not null and output_tokens is not null
       and cache_read_input_tokens is not null and cache_write_5m_input_tokens is not null
       and cache_write_1h_input_tokens is not null)
    or (cost_basis = 'upper_bound' and input_tokens is null and output_tokens is null
       and cache_read_input_tokens is null and cache_write_5m_input_tokens is null
       and cache_write_1h_input_tokens is null and reasoning_output_tokens is null
       and estimated_cost_usd >= reserved_usd)
  ),
  constraint usage_events_cache_within_input check (
    input_tokens is null
    or cache_read_input_tokens + cache_write_5m_input_tokens + cache_write_1h_input_tokens <= input_tokens
  ),
  constraint usage_events_reasoning_within_output check (
    reasoning_output_tokens is null or output_tokens is null or reasoning_output_tokens <= output_tokens
  ),
  constraint usage_events_subject check (
    (subject_kind = 'system' and user_id is null and brand_id is null)
    or (subject_kind = 'user' and user_id is not null)
  )
);
comment on table ai_ledger.usage_events is
  'Append-only. One row per finalised attempt. estimated_cost_usd is our estimate at that time (catalog version '
  'recorded); it is never recomputed and is not the invoice.';
create index usage_events_month_idx on ai_ledger.usage_events (billing_month, provider, model);
create index usage_events_subject_idx on ai_ledger.usage_events (billing_month, user_id, brand_id) where subject_kind = 'user';

create table ai_ledger.billing_observations (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('openai', 'anthropic')),
  billing_period_start date not null,
  billing_period_end date not null,
  source text not null check (source in ('console_manual', 'usage_cost_api', 'invoice')),
  console_usage_usd numeric(14, 6) check (console_usage_usd >= 0),
  credit_granted_usd numeric(14, 6) check (credit_granted_usd >= 0),
  credit_applied_usd numeric(14, 6) check (credit_applied_usd >= 0),
  credit_balance_usd numeric(14, 6) check (credit_balance_usd >= 0),
  out_of_pocket_usd numeric(14, 6) check (out_of_pocket_usd >= 0),
  observed_at timestamptz not null,
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  constraint billing_observations_period check (billing_period_end >= billing_period_start)
);
comment on table ai_ledger.billing_observations is
  'Append-only figures READ from the provider (Console usage, credit granted / applied / balance, out-of-pocket). '
  'Kept apart from estimated costs; never inferred.';

alter table ai_ledger.budget_policies enable row level security;
alter table ai_ledger.budget_buckets enable row level security;
alter table ai_ledger.reservations enable row level security;
alter table ai_ledger.usage_events enable row level security;
alter table ai_ledger.billing_observations enable row level security;

-- ---------------------------------------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------------------------------------
create function ai_ledger.reject_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AI_LEDGER_APPEND_ONLY: % on %', tg_op, tg_table_name using errcode = 'P0001';
end;
$$;

create trigger usage_events_append_only before update or delete on ai_ledger.usage_events
  for each row execute function ai_ledger.reject_change();
create trigger usage_events_no_truncate before truncate on ai_ledger.usage_events
  for each statement execute function ai_ledger.reject_change();
create trigger billing_observations_append_only before update or delete on ai_ledger.billing_observations
  for each row execute function ai_ledger.reject_change();
create trigger billing_observations_no_truncate before truncate on ai_ledger.billing_observations
  for each statement execute function ai_ledger.reject_change();
create trigger reservations_no_delete before delete on ai_ledger.reservations
  for each row execute function ai_ledger.reject_change();
create trigger reservations_no_truncate before truncate on ai_ledger.reservations
  for each statement execute function ai_ledger.reject_change();

-- Reservation identity is immutable and status only moves forward.
create function ai_ledger.reservation_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.request_id, new.attempt, new.provider, new.model, new.application, new.feature, new.logical_role,
      new.subject_kind, new.user_id, new.brand_id, new.billing_month, new.usage_day, new.reserved_usd, new.bucket_ids,
      new.created_at, new.expires_at)
     is distinct from
     (old.id, old.request_id, old.attempt, old.provider, old.model, old.application, old.feature, old.logical_role,
      old.subject_kind, old.user_id, old.brand_id, old.billing_month, old.usage_day, old.reserved_usd, old.bucket_ids,
      old.created_at, old.expires_at) then
    raise exception 'AI_LEDGER_RESERVATION_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'reserved' and new.status in ('sent', 'released', 'settled', 'unknown'))
    or (old.status = 'sent' and new.status in ('settled', 'unknown'))
    or (old.status = 'released' and new.status in ('settled', 'unknown'))
  ) then
    raise exception 'AI_LEDGER_RESERVATION_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger reservations_transition before update on ai_ledger.reservations
  for each row execute function ai_ledger.reservation_transition();

-- ---------------------------------------------------------------------------------------------------------
-- RPC: reserve
--   p: request_id, attempt, provider, model, application, feature, logical_role, subject_kind ('system' | 'user'),
--      user_id?, brand_id?, amount_usd, hold_seconds? (30..3600, default 900)
--   -> {allowed, reservation_id?, status?, reused, reason?, policy_key?, level}
-- Idempotent per (request_id, attempt): a repeat returns the same reservation and counts nothing again.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_reserve(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id text := ai_ledger.input_identifier(p, 'request_id', true);
  v_attempt numeric := ai_ledger.input_number(p, 'attempt', true, 1, 10);
  v_provider text := ai_ledger.input_identifier(p, 'provider', true);
  v_model text := ai_ledger.input_identifier(p, 'model', true);
  v_application text := ai_ledger.input_identifier(p, 'application', true);
  v_feature text := ai_ledger.input_identifier(p, 'feature', true);
  v_role text := ai_ledger.input_identifier(p, 'logical_role', true);
  v_subject text := ai_ledger.input_identifier(p, 'subject_kind', true);
  v_user uuid := ai_ledger.input_uuid(p, 'user_id');
  v_brand uuid := ai_ledger.input_uuid(p, 'brand_id');
  v_amount numeric := ai_ledger.ceil_usd(ai_ledger.input_number(p, 'amount_usd', true, 0, 1000));
  v_hold numeric := coalesce(ai_ledger.input_number(p, 'hold_seconds', false, 30, 3600), 900);
  v_month date;
  v_day date;
  v_existing ai_ledger.reservations;
  v_policy_ids uuid[];
  v_policy record;
  v_row record;
  v_bucket_ids bigint[] := '{}';
  v_ratio numeric := 0;
  v_deny text;
  v_deny_policy text;
  v_id uuid;
begin
  if v_attempt <> trunc(v_attempt) then
    raise exception 'AI_LEDGER_INVALID_INPUT: attempt must be an integer' using errcode = '22023';
  end if;
  if v_provider not in ('openai', 'anthropic') then
    raise exception 'AI_LEDGER_INVALID_INPUT: provider' using errcode = '22023';
  end if;
  if v_subject not in ('system', 'user')
     or (v_subject = 'system' and (v_user is not null or v_brand is not null))
     or (v_subject = 'user' and v_user is null) then
    raise exception 'AI_LEDGER_INVALID_INPUT: subject' using errcode = '22023';
  end if;
  if v_hold <> trunc(v_hold) then
    raise exception 'AI_LEDGER_INVALID_INPUT: hold_seconds must be an integer' using errcode = '22023';
  end if;

  -- Reservations are serialised: one at a time across every caller and process.
  perform pg_advisory_xact_lock(hashtextextended('ai_ledger:reserve', 0));

  select r.* into v_existing
    from ai_ledger.reservations r
   where r.request_id = v_request_id and r.attempt = v_attempt
   for update;
  if found then
    if (v_existing.provider, v_existing.model, v_existing.application, v_existing.feature, v_existing.logical_role,
        v_existing.subject_kind, v_existing.user_id, v_existing.brand_id, v_existing.reserved_usd)
       is distinct from (v_provider, v_model, v_application, v_feature, v_role, v_subject, v_user, v_brand, v_amount) then
      raise exception 'AI_LEDGER_ATTEMPT_CONFLICT' using errcode = 'P0001';
    end if;
    if v_existing.status in ('reserved', 'sent') then
      return jsonb_build_object('allowed', true, 'reservation_id', v_existing.id, 'status', v_existing.status,
                                'reused', true, 'level', 'ok');
    end if;
    return jsonb_build_object('allowed', false, 'reservation_id', v_existing.id, 'status', v_existing.status,
                              'reused', true, 'reason', 'ATTEMPT_FINALIZED', 'level', 'ok');
  end if;

  v_month := ai_ledger.jst_month_start(now());
  v_day := ai_ledger.jst_day(now());

  select array_agg(pol.id order by pol.policy_key) into v_policy_ids
    from ai_ledger.budget_policies pol
   where pol.enabled
     and (pol.scope_provider is null or pol.scope_provider = v_provider)
     and (pol.scope_model is null or pol.scope_model = v_model)
     and (pol.scope_application is null or pol.scope_application = v_application)
     and (pol.scope_feature is null or pol.scope_feature = v_feature)
     and (pol.scope_logical_role is null or pol.scope_logical_role = v_role)
     and (pol.scope_subject_kind is null or pol.scope_subject_kind = v_subject)
     and (pol.scope_brand_id is null or pol.scope_brand_id = v_brand)
     and (pol.scope_user_id is null or pol.scope_user_id = v_user)
     and (not pol.per_brand or v_brand is not null)
     and (not pol.per_user or v_user is not null);
  if v_policy_ids is null then
    return jsonb_build_object('allowed', false, 'reused', false, 'reason', 'NO_MATCHING_POLICY', 'level', 'critical');
  end if;

  select pol.policy_key into v_deny_policy
    from ai_ledger.budget_policies pol
   where pol.id = any (v_policy_ids) and pol.max_usd_per_call is not null and v_amount > pol.max_usd_per_call
   order by pol.policy_key
   limit 1;
  if v_deny_policy is not null then
    return jsonb_build_object('allowed', false, 'reused', false, 'reason', 'PER_CALL_LIMIT',
                              'policy_key', v_deny_policy, 'level', 'critical');
  end if;

  -- Make sure every counter exists (in policy_key order), then lock them in id order.
  for v_policy in
    select pol.id, pol.period, pol.per_brand, pol.per_user
      from ai_ledger.budget_policies pol
     where pol.id = any (v_policy_ids)
     order by pol.policy_key
  loop
    insert into ai_ledger.budget_buckets (policy_id, period_start, brand_id, user_id)
    values (v_policy.id,
            case v_policy.period when 'month' then v_month else v_day end,
            case when v_policy.per_brand then v_brand end,
            case when v_policy.per_user then v_user end)
    on conflict on constraint budget_buckets_key do nothing;
  end loop;

  for v_row in
    select b.id, b.calls, b.held_usd, b.settled_usd, pol.policy_key, pol.max_calls, pol.max_estimated_usd
      from ai_ledger.budget_policies pol
      join ai_ledger.budget_buckets b
        on b.policy_id = pol.id
       and b.period_start = case pol.period when 'month' then v_month else v_day end
       and b.brand_id is not distinct from (case when pol.per_brand then v_brand end)
       and b.user_id is not distinct from (case when pol.per_user then v_user end)
     where pol.id = any (v_policy_ids)
     order by b.id
     for update of b
  loop
    v_bucket_ids := v_bucket_ids || v_row.id;
    if v_deny is null and v_row.max_calls is not null and v_row.calls + 1 > v_row.max_calls then
      v_deny := 'CALL_LIMIT';
      v_deny_policy := v_row.policy_key;
    end if;
    if v_deny is null and v_row.max_estimated_usd is not null
       and v_row.held_usd + v_row.settled_usd + v_amount > v_row.max_estimated_usd then
      v_deny := 'COST_LIMIT';
      v_deny_policy := v_row.policy_key;
    end if;
    if v_row.max_calls is not null and v_row.max_calls > 0 then
      v_ratio := greatest(v_ratio, (v_row.calls + 1)::numeric / v_row.max_calls);
    end if;
    if v_row.max_estimated_usd is not null and v_row.max_estimated_usd > 0 then
      v_ratio := greatest(v_ratio, (v_row.held_usd + v_row.settled_usd + v_amount) / v_row.max_estimated_usd);
    end if;
  end loop;

  if coalesce(array_length(v_bucket_ids, 1), 0) <> array_length(v_policy_ids, 1) then
    raise exception 'AI_LEDGER_BUCKET_MISSING' using errcode = 'P0001';
  end if;
  if v_deny is not null then
    return jsonb_build_object('allowed', false, 'reused', false, 'reason', v_deny, 'policy_key', v_deny_policy,
                              'level', 'critical');
  end if;

  update ai_ledger.budget_buckets b
     set calls = b.calls + 1, held_usd = b.held_usd + v_amount, updated_at = now()
   where b.id = any (v_bucket_ids);

  insert into ai_ledger.reservations (
    request_id, attempt, provider, model, application, feature, logical_role, subject_kind, user_id, brand_id,
    billing_month, usage_day, reserved_usd, bucket_ids, status, expires_at)
  values (
    v_request_id, v_attempt, v_provider, v_model, v_application, v_feature, v_role, v_subject, v_user, v_brand,
    v_month, v_day, v_amount, v_bucket_ids, 'reserved', now() + make_interval(secs => v_hold))
  returning id into v_id;

  return jsonb_build_object(
    'allowed', true, 'reservation_id', v_id, 'status', 'reserved', 'reused', false,
    'level', case when v_ratio >= 0.95 then 'critical' when v_ratio >= 0.8 then 'warn'
                  when v_ratio >= 0.5 then 'notice' else 'ok' end);
end;
$$;

-- Return the holds of a reservation that was never sent (status reserved -> released). Caller holds the row lock.
create function ai_ledger.release_locked(p_reservation ai_ledger.reservations)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from ai_ledger.budget_buckets b where b.id = any (p_reservation.bucket_ids) order by b.id for update;
  update ai_ledger.budget_buckets b
     set calls = greatest(0, b.calls - 1), held_usd = greatest(0, b.held_usd - p_reservation.reserved_usd),
         updated_at = now()
   where b.id = any (p_reservation.bucket_ids);
  update ai_ledger.reservations r set status = 'released', finalized_at = now() where r.id = p_reservation.id;
end;
$$;

-- Finalise a reservation with an event. Caller holds the row lock and has validated the figures.
create function ai_ledger.finalize_locked(
  p_reservation ai_ledger.reservations, p_outcome text, p_basis text, p_cost numeric,
  p_input bigint, p_cache_read bigint, p_cache_5m bigint, p_cache_1h bigint, p_output bigint, p_reasoning bigint,
  p_actual_model text, p_error_code text, p_provider_request_id text, p_http_status integer, p_latency_ms integer,
  p_catalog_version text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_event bigint;
begin
  perform 1 from ai_ledger.budget_buckets b where b.id = any (p_reservation.bucket_ids) order by b.id for update;
  if p_reservation.status in ('reserved', 'sent') then
    update ai_ledger.budget_buckets b
       set held_usd = greatest(0, b.held_usd - p_reservation.reserved_usd), settled_usd = b.settled_usd + p_cost,
           updated_at = now()
     where b.id = any (p_reservation.bucket_ids);
  else
    -- released, then a settlement arrived: the attempt WAS sent after all. Count it; never lose real cost.
    update ai_ledger.budget_buckets b
       set calls = b.calls + 1, settled_usd = b.settled_usd + p_cost, updated_at = now()
     where b.id = any (p_reservation.bucket_ids);
  end if;
  insert into ai_ledger.usage_events (
    reservation_id, request_id, attempt, attempt_id, provider, model, actual_model, application, feature,
    logical_role, subject_kind, user_id, brand_id, billing_month, outcome, error_code, cost_basis,
    input_tokens, cache_read_input_tokens, cache_write_5m_input_tokens, cache_write_1h_input_tokens, output_tokens,
    reasoning_output_tokens, estimated_cost_usd, reserved_usd, price_catalog_version, provider_request_id,
    http_status, latency_ms)
  values (
    p_reservation.id, p_reservation.request_id, p_reservation.attempt, p_reservation.attempt_id,
    p_reservation.provider, p_reservation.model, p_actual_model, p_reservation.application, p_reservation.feature,
    p_reservation.logical_role, p_reservation.subject_kind, p_reservation.user_id, p_reservation.brand_id,
    p_reservation.billing_month, p_outcome, p_error_code, p_basis,
    p_input, p_cache_read, p_cache_5m, p_cache_1h, p_output, p_reasoning, p_cost, p_reservation.reserved_usd,
    p_catalog_version, p_provider_request_id, p_http_status, p_latency_ms)
  returning id into v_event;
  update ai_ledger.reservations r
     set status = case p_basis when 'measured' then 'settled' else 'unknown' end, finalized_at = now()
   where r.id = p_reservation.id;
  return v_event;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: mark_sent  p: {reservation_id} -> {status, may_send}
-- The caller sends the HTTP request only when may_send is true. An expired, never-sent reservation is released
-- here instead, so a late caller can never send on a hold that recovery already returned.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_mark_sent(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := ai_ledger.input_uuid(p, 'reservation_id');
  v_res ai_ledger.reservations;
begin
  if v_id is null then
    raise exception 'AI_LEDGER_INVALID_INPUT: reservation_id is required' using errcode = '22023';
  end if;
  select r.* into v_res from ai_ledger.reservations r where r.id = v_id for update;
  if not found then
    raise exception 'AI_LEDGER_RESERVATION_UNKNOWN' using errcode = 'P0002';
  end if;
  if v_res.status = 'reserved' then
    if v_res.expires_at <= now() then
      perform ai_ledger.release_locked(v_res);
      return jsonb_build_object('status', 'released', 'may_send', false);
    end if;
    update ai_ledger.reservations r set status = 'sent', sent_at = now() where r.id = v_id;
    return jsonb_build_object('status', 'sent', 'may_send', true);
  end if;
  return jsonb_build_object('status', v_res.status, 'may_send', v_res.status = 'sent');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: settle
--   p: reservation_id, outcome ('succeeded' | 'failed' | 'unknown'), cost_basis ('measured' | 'upper_bound'),
--      estimated_cost_usd, input_tokens?, cache_read_input_tokens?, cache_write_5m_input_tokens?,
--      cache_write_1h_input_tokens?, output_tokens?, reasoning_output_tokens?, actual_model?, error_code?,
--      provider_request_id?, http_status?, latency_ms?, price_catalog_version
--   -> {status, usage_event_id, duplicate, estimated_cost_usd}
-- Idempotent: a repeated identical settlement returns the first one; a different one is a conflict. An upper-bound
-- settlement never charges less than the hold.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_settle(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := ai_ledger.input_uuid(p, 'reservation_id');
  v_outcome text := ai_ledger.input_identifier(p, 'outcome', true);
  v_basis text := ai_ledger.input_identifier(p, 'cost_basis', true);
  v_cost numeric := ai_ledger.input_number(p, 'estimated_cost_usd', true, 0, 1000);
  v_input bigint := ai_ledger.input_count(p, 'input_tokens', false);
  v_cache_read bigint := ai_ledger.input_count(p, 'cache_read_input_tokens', false);
  v_cache_5m bigint := ai_ledger.input_count(p, 'cache_write_5m_input_tokens', false);
  v_cache_1h bigint := ai_ledger.input_count(p, 'cache_write_1h_input_tokens', false);
  v_output bigint := ai_ledger.input_count(p, 'output_tokens', false);
  v_reasoning bigint := ai_ledger.input_count(p, 'reasoning_output_tokens', false);
  v_actual_model text := ai_ledger.input_identifier(p, 'actual_model', false);
  v_error_code text := ai_ledger.input_identifier(p, 'error_code', false);
  v_provider_request_id text := ai_ledger.input_identifier(p, 'provider_request_id', false);
  v_http_status numeric := ai_ledger.input_number(p, 'http_status', false, 100, 599);
  v_latency numeric := ai_ledger.input_number(p, 'latency_ms', false, 0, 86400000);
  v_catalog text := ai_ledger.input_identifier(p, 'price_catalog_version', true);
  v_res ai_ledger.reservations;
  v_event ai_ledger.usage_events;
  v_event_id bigint;
begin
  if v_id is null then
    raise exception 'AI_LEDGER_INVALID_INPUT: reservation_id is required' using errcode = '22023';
  end if;
  if v_outcome not in ('succeeded', 'failed', 'unknown') or v_basis not in ('measured', 'upper_bound')
     or (v_outcome = 'unknown' and v_basis <> 'upper_bound') then
    raise exception 'AI_LEDGER_INVALID_INPUT: outcome / cost_basis' using errcode = '22023';
  end if;
  if v_basis = 'measured' and (v_input is null or v_output is null) then
    raise exception 'AI_LEDGER_INVALID_INPUT: measured usage needs input_tokens and output_tokens' using errcode = '22023';
  end if;
  if v_basis = 'upper_bound' and num_nonnulls(v_input, v_cache_read, v_cache_5m, v_cache_1h, v_output, v_reasoning) > 0 then
    raise exception 'AI_LEDGER_INVALID_INPUT: an unknown outcome has no token counts' using errcode = '22023';
  end if;
  if v_basis = 'measured' then
    v_cache_read := coalesce(v_cache_read, 0);
    v_cache_5m := coalesce(v_cache_5m, 0);
    v_cache_1h := coalesce(v_cache_1h, 0);
    if v_cache_read + v_cache_5m + v_cache_1h > v_input or (v_reasoning is not null and v_reasoning > v_output) then
      raise exception 'AI_LEDGER_INVALID_INPUT: token breakdown exceeds its total' using errcode = '22023';
    end if;
  end if;
  if v_error_code is not null and v_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'AI_LEDGER_INVALID_INPUT: error_code' using errcode = '22023';
  end if;
  if (v_http_status is not null and v_http_status <> trunc(v_http_status))
     or (v_latency is not null and v_latency <> trunc(v_latency)) then
    raise exception 'AI_LEDGER_INVALID_INPUT: http_status / latency_ms must be integers' using errcode = '22023';
  end if;
  if char_length(v_catalog) > 64 then
    raise exception 'AI_LEDGER_INVALID_INPUT: price_catalog_version' using errcode = '22023';
  end if;

  select r.* into v_res from ai_ledger.reservations r where r.id = v_id for update;
  if not found then
    raise exception 'AI_LEDGER_RESERVATION_UNKNOWN' using errcode = 'P0002';
  end if;
  v_cost := ai_ledger.ceil_usd(v_cost);
  if v_basis = 'upper_bound' then
    v_cost := greatest(v_cost, v_res.reserved_usd);
  end if;

  select e.* into v_event from ai_ledger.usage_events e where e.reservation_id = v_id;
  if found then
    if (v_event.outcome, v_event.cost_basis, v_event.estimated_cost_usd, v_event.input_tokens, v_event.output_tokens,
        v_event.cache_read_input_tokens, v_event.cache_write_5m_input_tokens, v_event.cache_write_1h_input_tokens)
       is distinct from (v_outcome, v_basis, v_cost, v_input, v_output, v_cache_read, v_cache_5m, v_cache_1h) then
      raise exception 'AI_LEDGER_SETTLEMENT_CONFLICT' using errcode = 'P0001';
    end if;
    return jsonb_build_object('status', v_res.status, 'usage_event_id', v_event.id, 'duplicate', true,
                              'estimated_cost_usd', v_event.estimated_cost_usd);
  end if;

  v_event_id := ai_ledger.finalize_locked(v_res, v_outcome, v_basis, v_cost, v_input, v_cache_read, v_cache_5m,
                                          v_cache_1h, v_output, v_reasoning, v_actual_model, v_error_code,
                                          v_provider_request_id, v_http_status::integer, v_latency::integer, v_catalog);
  return jsonb_build_object('status', case v_basis when 'measured' then 'settled' else 'unknown' end,
                            'usage_event_id', v_event_id, 'duplicate', false, 'estimated_cost_usd', v_cost);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: release  p: {reservation_id} -> {status}
-- Only a reservation that was never marked sent can be released; anything else is returned unchanged.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_release(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := ai_ledger.input_uuid(p, 'reservation_id');
  v_res ai_ledger.reservations;
begin
  if v_id is null then
    raise exception 'AI_LEDGER_INVALID_INPUT: reservation_id is required' using errcode = '22023';
  end if;
  select r.* into v_res from ai_ledger.reservations r where r.id = v_id for update;
  if not found then
    raise exception 'AI_LEDGER_RESERVATION_UNKNOWN' using errcode = 'P0002';
  end if;
  if v_res.status = 'reserved' then
    perform ai_ledger.release_locked(v_res);
    return jsonb_build_object('status', 'released');
  end if;
  return jsonb_build_object('status', v_res.status);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: recover_stale  p: {sent_grace_seconds? (60..86400, default 900), limit? (1..5000, default 1000)}
--   -> {released, marked_unknown}
-- Crash recovery. A reservation still 'reserved' after its expiry was provably never sent (mark_sent refuses an
-- expired hold) and is released. A reservation 'sent' for longer than the grace period has no settlement: its
-- outcome is unknown, so it is finalised at its upper bound and NEVER released.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_recover_stale(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grace numeric := coalesce(ai_ledger.input_number(coalesce(p, '{}'::jsonb), 'sent_grace_seconds', false, 60, 86400), 900);
  v_limit numeric := coalesce(ai_ledger.input_number(coalesce(p, '{}'::jsonb), 'limit', false, 1, 5000), 1000);
  v_res ai_ledger.reservations;
  v_released integer := 0;
  v_unknown integer := 0;
begin
  if v_grace <> trunc(v_grace) or v_limit <> trunc(v_limit) then
    raise exception 'AI_LEDGER_INVALID_INPUT: integers required' using errcode = '22023';
  end if;
  for v_res in
    select r.* from ai_ledger.reservations r
     where r.status = 'reserved' and r.expires_at <= now()
     order by r.created_at
     limit v_limit
     for update skip locked
  loop
    perform ai_ledger.release_locked(v_res);
    v_released := v_released + 1;
  end loop;
  for v_res in
    select r.* from ai_ledger.reservations r
     where r.status = 'sent' and r.sent_at <= now() - make_interval(secs => v_grace)
     order by r.sent_at
     limit v_limit
     for update skip locked
  loop
    perform ai_ledger.finalize_locked(v_res, 'unknown', 'upper_bound', v_res.reserved_usd, null, null, null, null,
                                      null, null, null, 'RECOVERED_UNKNOWN', null, null, null, 'recovered');
    v_unknown := v_unknown + 1;
  end loop;
  return jsonb_build_object('released', v_released, 'marked_unknown', v_unknown);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: usage_summary  p: {billing_month: 'YYYY-MM-01', dimension} -> [{key, attempts, ...}]
-- dimension: total | provider | model | application | feature | logical_role | subject_kind | brand | user
-- For an admin screen later: aggregate counts and estimated USD only.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_usage_summary(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dimension text := ai_ledger.input_identifier(p, 'dimension', true);
  v_month date;
  v_result jsonb;
begin
  if p is null or jsonb_typeof(p -> 'billing_month') is distinct from 'string'
     or (p ->> 'billing_month') !~ '^\d{4}-\d{2}-01$' then
    raise exception 'AI_LEDGER_INVALID_INPUT: billing_month must be YYYY-MM-01' using errcode = '22023';
  end if;
  v_month := (p ->> 'billing_month')::date;
  if v_dimension not in ('total', 'provider', 'model', 'application', 'feature', 'logical_role', 'subject_kind', 'brand', 'user') then
    raise exception 'AI_LEDGER_INVALID_INPUT: dimension' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by s.key), '[]'::jsonb) into v_result
    from (
      select case v_dimension
               when 'total' then 'total'
               when 'provider' then e.provider
               when 'model' then e.model
               when 'application' then e.application
               when 'feature' then e.application || '/' || e.feature
               when 'logical_role' then e.logical_role
               when 'subject_kind' then e.subject_kind
               when 'brand' then coalesce(e.brand_id::text, '(none)')
               when 'user' then coalesce(e.user_id::text, '(none)')
             end as key,
             count(*) as attempts,
             count(*) filter (where e.outcome = 'succeeded') as succeeded,
             count(*) filter (where e.outcome = 'failed') as failed,
             count(*) filter (where e.outcome = 'unknown') as unknown,
             coalesce(sum(e.input_tokens), 0) as input_tokens,
             coalesce(sum(e.output_tokens), 0) as output_tokens,
             coalesce(sum(e.cache_read_input_tokens), 0) as cache_read_input_tokens,
             coalesce(sum(e.cache_write_5m_input_tokens + e.cache_write_1h_input_tokens), 0) as cache_write_input_tokens,
             sum(e.estimated_cost_usd) as estimated_cost_usd,
             coalesce(sum(e.estimated_cost_usd) filter (where e.cost_basis = 'upper_bound'), 0) as upper_bound_cost_usd
        from ai_ledger.usage_events e
       where e.billing_month = v_month
       group by 1
    ) s;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: budget_status  p: {} -> [{policy_key, period, period_start, brand_id, user_id, calls, max_calls,
--                                held_usd, settled_usd, max_estimated_usd, level}]  (current periods only)
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_budget_status(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := ai_ledger.jst_month_start(now());
  v_day date := ai_ledger.jst_day(now());
  v_result jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by s.policy_key, s.brand_id, s.user_id), '[]'::jsonb) into v_result
    from (
      select pol.policy_key, pol.period, b.period_start, b.brand_id, b.user_id, b.calls, pol.max_calls,
             b.held_usd, b.settled_usd, pol.max_estimated_usd,
             case
               when ratio.value >= 0.95 then 'critical'
               when ratio.value >= 0.8 then 'warn'
               when ratio.value >= 0.5 then 'notice'
               else 'ok'
             end as level
        from ai_ledger.budget_buckets b
        join ai_ledger.budget_policies pol on pol.id = b.policy_id
        cross join lateral (
          select greatest(
                   case when pol.max_calls > 0 then b.calls::numeric / pol.max_calls else 0 end,
                   case when pol.max_estimated_usd > 0 then (b.held_usd + b.settled_usd) / pol.max_estimated_usd else 0 end
                 ) as value
        ) ratio
       where b.period_start = case pol.period when 'month' then v_month else v_day end
    ) s;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Grants: nothing on the schema, tables, sequences or helpers for any application role; EXECUTE on the seven
-- RPCs for service_role only (a Supabase default EXECUTE grant to anon / authenticated must not survive).
-- ---------------------------------------------------------------------------------------------------------
revoke all on all tables in schema ai_ledger from public, anon, authenticated, service_role;
revoke all on all sequences in schema ai_ledger from public, anon, authenticated, service_role;
revoke all on all functions in schema ai_ledger from public, anon, authenticated, service_role;
revoke all on function
  public.ai_ledger_reserve(jsonb), public.ai_ledger_mark_sent(jsonb), public.ai_ledger_settle(jsonb),
  public.ai_ledger_release(jsonb), public.ai_ledger_recover_stale(jsonb), public.ai_ledger_usage_summary(jsonb),
  public.ai_ledger_budget_status(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.ai_ledger_reserve(jsonb), public.ai_ledger_mark_sent(jsonb), public.ai_ledger_settle(jsonb),
  public.ai_ledger_release(jsonb), public.ai_ledger_recover_stale(jsonb), public.ai_ledger_usage_summary(jsonb),
  public.ai_ledger_budget_status(jsonb)
  to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Access verification. Raises (rolling the whole migration back) unless every object is reachable by exactly the
-- intended roles. Nothing is repaired here.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_schema constant regnamespace := 'ai_ledger'::regnamespace;
  v_owner oid;
  v_owner_name name;
  v_roles constant text[] := array['anon', 'authenticated', 'service_role'];
  v_table_privs text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_rpcs constant regprocedure[] := array[
    'public.ai_ledger_reserve(jsonb)'::regprocedure, 'public.ai_ledger_mark_sent(jsonb)'::regprocedure,
    'public.ai_ledger_settle(jsonb)'::regprocedure, 'public.ai_ledger_release(jsonb)'::regprocedure,
    'public.ai_ledger_recover_stale(jsonb)'::regprocedure, 'public.ai_ledger_usage_summary(jsonb)'::regprocedure,
    'public.ai_ledger_budget_status(jsonb)'::regprocedure];
  v_role text;
  v_priv text;
  v_rel record;
  v_fn record;
  v_rpc regprocedure;
  v_extra text;
begin
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := array_append(v_table_privs, 'MAINTAIN');
  end if;

  select n.nspowner into v_owner from pg_namespace n where n.oid = v_schema;
  select r.rolname into v_owner_name from pg_roles r where r.oid = v_owner;

  -- 1. One owner for everything, and not an application role.
  if v_owner_name in ('anon', 'authenticated', 'service_role') then
    raise exception 'AI_LEDGER_ACL_UNSAFE_OWNER: schema owner % is an application role', v_owner_name using errcode = 'P0001';
  end if;
  if exists (select 1 from pg_class c where c.relnamespace = v_schema and c.relowner <> v_owner)
     or exists (select 1 from pg_proc f where f.pronamespace = v_schema and f.proowner <> v_owner)
     or exists (select 1 from unnest(v_rpcs) x(oid) join pg_proc f on f.oid = x.oid where f.proowner <> v_owner) then
    raise exception 'AI_LEDGER_ACL_UNSAFE_OWNER: mixed owners' using errcode = 'P0001';
  end if;

  -- 2. No application role may be a member of the owner or of any superuser.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    if pg_has_role(v_role, v_owner, 'MEMBER') then
      raise exception 'AI_LEDGER_ACL_UNSAFE_MEMBERSHIP: % is a member of the owner %', v_role, v_owner_name using errcode = 'P0001';
    end if;
    select string_agg(super.rolname, ', ' order by super.rolname) into v_extra
      from pg_roles super where super.rolsuper and pg_has_role(v_role, super.oid, 'MEMBER');
    if v_extra is not null then
      raise exception 'AI_LEDGER_ACL_UNSAFE_MEMBERSHIP: % is or inherits superuser %', v_role, v_extra using errcode = 'P0001';
    end if;
  end loop;

  -- 3. Exact direct ACLs: schema, relations (tables and sequences) and helper functions carry no grant to anyone
  --    but the owner; each RPC carries EXECUTE for service_role (without grant option) and nothing else.
  select string_agg(format('%s:%s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
    from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    left join pg_roles r on r.oid = a.grantee
   where n.oid = v_schema and a.grantee <> n.nspowner;
  if v_extra is not null then
    raise exception 'AI_LEDGER_ACL_UNEXPECTED_SCHEMA_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  select string_agg(format('%s %s:%s', c.relname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
    from pg_class c cross join lateral aclexplode(c.relacl) a
    left join pg_roles r on r.oid = a.grantee
   where c.relnamespace = v_schema and a.grantee <> c.relowner;
  if v_extra is not null then
    raise exception 'AI_LEDGER_ACL_UNEXPECTED_RELATION_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  select string_agg(format('%s %s:%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
    from pg_proc f cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where f.pronamespace = v_schema and a.grantee <> f.proowner;
  if v_extra is not null then
    raise exception 'AI_LEDGER_ACL_UNEXPECTED_HELPER_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  select string_agg(format('%s %s:%s%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type,
                           case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
    from unnest(v_rpcs) x(oid) join pg_proc f on f.oid = x.oid
    cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where a.grantee <> f.proowner
     and not (r.rolname is not distinct from 'service_role' and a.privilege_type = 'EXECUTE' and not a.is_grantable);
  if v_extra is not null then
    raise exception 'AI_LEDGER_ACL_UNEXPECTED_RPC_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  if exists (select 1 from pg_attribute att join pg_class c on c.oid = att.attrelid
              where c.relnamespace = v_schema and att.attnum > 0 and att.attacl is not null) then
    raise exception 'AI_LEDGER_ACL_UNEXPECTED_COLUMN_GRANT' using errcode = 'P0001';
  end if;

  -- 4. RPC shape: SECURITY DEFINER with an empty search_path. Helpers are not SECURITY DEFINER.
  foreach v_rpc in array v_rpcs loop
    if not coalesce((select f.prosecdef and f.proconfig = array['search_path=""'] from pg_proc f where f.oid = v_rpc), false) then
      raise exception 'AI_LEDGER_RPC_SHAPE: % must be SECURITY DEFINER with an empty search_path', v_rpc using errcode = 'P0001';
    end if;
  end loop;
  if exists (select 1 from pg_proc f where f.pronamespace = v_schema and f.prosecdef) then
    raise exception 'AI_LEDGER_HELPER_SHAPE: a helper is SECURITY DEFINER' using errcode = 'P0001';
  end if;

  -- 5. Effective privileges (inheritance, PUBLIC, grant options, column privileges) of each application role.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    if has_schema_privilege(v_role, v_schema, 'USAGE') or has_schema_privilege(v_role, v_schema, 'CREATE') then
      raise exception 'AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE: % can use the ai_ledger schema', v_role using errcode = 'P0001';
    end if;
    for v_rel in select c.oid, c.relname, c.relkind from pg_class c where c.relnamespace = v_schema and c.relkind in ('r', 'S', 'v', 'm') loop
      if v_rel.relkind = 'S' then
        if has_sequence_privilege(v_role, v_rel.oid, 'USAGE') or has_sequence_privilege(v_role, v_rel.oid, 'SELECT')
           or has_sequence_privilege(v_role, v_rel.oid, 'UPDATE') then
          raise exception 'AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE: % can use sequence %', v_role, v_rel.relname using errcode = 'P0001';
        end if;
        continue;
      end if;
      foreach v_priv in array v_table_privs loop
        if has_table_privilege(v_role, v_rel.oid, v_priv) then
          raise exception 'AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE: % holds % on %', v_role, v_priv, v_rel.relname using errcode = 'P0001';
        end if;
      end loop;
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
        if has_any_column_privilege(v_role, v_rel.oid, v_priv) then
          raise exception 'AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE: % has column % on %', v_role, v_priv, v_rel.relname using errcode = 'P0001';
        end if;
      end loop;
    end loop;
    for v_fn in select f.oid, f.proname from pg_proc f where f.pronamespace = v_schema loop
      if has_function_privilege(v_role, v_fn.oid, 'EXECUTE') then
        raise exception 'AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE: % can execute helper %', v_role, v_fn.proname using errcode = 'P0001';
      end if;
    end loop;
    foreach v_rpc in array v_rpcs loop
      if has_function_privilege(v_role, v_rpc, 'EXECUTE') is distinct from (v_role = 'service_role') then
        raise exception 'AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE: EXECUTE of % for % is wrong', v_rpc, v_role using errcode = 'P0001';
      end if;
      if has_function_privilege(v_role, v_rpc, 'EXECUTE WITH GRANT OPTION') then
        raise exception 'AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE: % may grant %', v_role, v_rpc using errcode = 'P0001';
      end if;
    end loop;
  end loop;

  -- 6. Row level security is on for every table (no policy: nobody but the owner sees a row).
  if exists (select 1 from pg_class c where c.relnamespace = v_schema and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'AI_LEDGER_RLS_DISABLED' using errcode = 'P0001';
  end if;
end;
$$;

commit;
