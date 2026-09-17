-- Phase 2 candidate only. This migration is intentionally not applied by H1.
-- The writer is backend/service-role only; no client-facing policy is added.

alter table public.daily_content_plans
  add column if not exists request_key text,
  add column if not exists activation_requested boolean not null default false,
  add column if not exists activated_at timestamptz;

create unique index if not exists daily_content_plans_request_key_idx
  on public.daily_content_plans (brand_id, target_date, request_key)
  where request_key is not null;

create or replace function public.write_daily_content_plan(
  p_brand_id text,
  p_target_date date,
  p_source text,
  p_plan jsonb,
  p_activate boolean default false,
  p_request_key text default null
)
returns table (
  id uuid,
  version integer,
  status text,
  target_date date,
  brand_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  item_id text;
  item_slot numeric;
  item_priority numeric;
  item_count integer;
  existing_id uuid;
  existing_version integer;
  existing_status text;
  existing_source text;
  existing_plan jsonb;
  existing_activation_requested boolean;
  next_version integer;
begin
  -- The function is deliberately not an end-user API. PostgREST service-role
  -- calls carry this role claim; direct postgres/supabase_admin maintenance is
  -- also permitted for controlled backend administration.
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    and session_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception using errcode = '42501', message = 'DAILY_CONTENT_PLAN_WRITER_FORBIDDEN';
  end if;

  if p_brand_id is null or btrim(p_brand_id) = '' then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_BRAND_REQUIRED';
  end if;
  if p_target_date is null then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_DATE_REQUIRED';
  end if;
  if p_source is null or p_source not in ('chatgpt', 'app_ai', 'manual') then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_SOURCE_INVALID';
  end if;
  if p_request_key is null or btrim(p_request_key) = '' or length(p_request_key) > 200 then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_REQUEST_KEY_REQUIRED';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_OBJECT_REQUIRED';
  end if;
  if not (p_plan ? 'items') or jsonb_typeof(p_plan->'items') <> 'array' then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEMS_REQUIRED';
  end if;
  if pg_column_size(p_plan) > 65536 then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_PAYLOAD_TOO_LARGE';
  end if;
  item_count := jsonb_array_length(p_plan->'items');
  if item_count < 1 or item_count > 32 then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_COUNT_INVALID';
  end if;
  if p_plan ? 'day_theme' and jsonb_typeof(p_plan->'day_theme') <> 'string' then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_DAY_THEME_INVALID';
  end if;
  if p_plan ? 'narrative_arc' and jsonb_typeof(p_plan->'narrative_arc') <> 'string' then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_NARRATIVE_ARC_INVALID';
  end if;

  if exists (
    select 1
    from (
      select value->>'id' as id
      from jsonb_array_elements(p_plan->'items')
    ) ids
    group by ids.id
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_DUPLICATE_ITEM_ID';
  end if;

  for item in select value from jsonb_array_elements(p_plan->'items') loop
    if jsonb_typeof(item) <> 'object' then
      raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_OBJECT_REQUIRED';
    end if;
    if not (item ? 'id') or jsonb_typeof(item->'id') <> 'string' or btrim(item->>'id') = '' then
      raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_ID_REQUIRED';
    end if;
    item_id := btrim(item->>'id');
    if length(item_id) > 120 then
      raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_ID_TOO_LONG';
    end if;
    if not (item ? 'topic') or jsonb_typeof(item->'topic') <> 'string' or btrim(item->>'topic') = '' then
      raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_TOPIC_REQUIRED';
    end if;
    if length(item->>'topic') > 2000 then
      raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_TOPIC_TOO_LONG';
    end if;
    if item ? 'context' and jsonb_typeof(item->'context') <> 'string' then
      raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_CONTEXT_INVALID';
    end if;
    if item ? 'tone_override' and jsonb_typeof(item->'tone_override') <> 'string' then
      raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_ITEM_TONE_INVALID';
    end if;
    if item ? 'slot_no' and item->'slot_no' <> 'null' then
      if jsonb_typeof(item->'slot_no') <> 'number' then
        raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_SLOT_INVALID';
      end if;
      item_slot := (item->>'slot_no')::numeric;
      if item_slot < 1 or item_slot <> trunc(item_slot) then
        raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_SLOT_INVALID';
      end if;
    end if;
    if item ? 'priority' then
      if jsonb_typeof(item->'priority') <> 'number'
        or (item->>'priority') !~ '^-?[0-9]+(\.[0-9]+)?$' then
        raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_PRIORITY_INVALID';
      end if;
      item_priority := (item->>'priority')::numeric;
      if abs(item_priority) > 1000000000 then
        raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_PRIORITY_INVALID';
      end if;
    end if;
    foreach item_id in array array['key_points', 'must_include', 'must_avoid'] loop
      if item ? item_id then
        if jsonb_typeof(item->item_id) <> 'array' then
          raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_STRING_ARRAY_INVALID';
        end if;
        if exists (
          select 1 from jsonb_array_elements(item->item_id) value
          where jsonb_typeof(value) <> 'string'
        ) then
          raise exception using errcode = '22023', message = 'DAILY_CONTENT_PLAN_STRING_ARRAY_INVALID';
        end if;
      end if;
    end loop;
  end loop;

  -- Serialize all writes for one brand/date. The partial unique index remains
  -- the final invariant if another writer bypasses this function.
  perform pg_advisory_xact_lock(
    hashtextextended(p_brand_id || ':' || p_target_date::text, 0)
  );

  select d.id, d.version, d.status, d.source, d.plan, d.activation_requested
    into existing_id, existing_version, existing_status, existing_source,
      existing_plan, existing_activation_requested
  from public.daily_content_plans d
  where d.brand_id = p_brand_id
    and d.target_date = p_target_date
    and d.request_key = p_request_key
  for update;

  if found then
    if existing_source <> p_source
      or existing_plan <> p_plan
      or existing_activation_requested <> p_activate then
      raise exception using errcode = '23505', message = 'DAILY_CONTENT_PLAN_REQUEST_KEY_CONFLICT';
    end if;
    return query
      select existing_id, existing_version, existing_status, p_target_date, p_brand_id;
    return;
  end if;

  select coalesce(max(d.version), 0) + 1
    into next_version
  from public.daily_content_plans d
  where d.brand_id = p_brand_id and d.target_date = p_target_date;

  if p_activate then
    update public.daily_content_plans d
    set status = 'archived', updated_at = clock_timestamp()
    where d.brand_id = p_brand_id
      and d.target_date = p_target_date
      and d.status = 'active';
  end if;

  return query
    insert into public.daily_content_plans (
      brand_id, target_date, version, source, status, plan,
      request_key, activation_requested, activated_at
    ) values (
      p_brand_id, p_target_date, next_version, p_source,
      case when p_activate then 'active' else 'draft' end,
      p_plan, p_request_key, p_activate,
      case when p_activate then clock_timestamp() else null end
    )
    returning daily_content_plans.id, daily_content_plans.version,
      daily_content_plans.status, daily_content_plans.target_date,
      daily_content_plans.brand_id;
end;
$$;

revoke execute on function public.write_daily_content_plan(text, date, text, jsonb, boolean, text)
  from public, anon, authenticated;
grant execute on function public.write_daily_content_plan(text, date, text, jsonb, boolean, text)
  to service_role;
