-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
-- Requires 20260924023133_x_autopost_phase1b_account_bound_queue.sql.
-- Live claim_due_post/retry_scheduled_post/fail_scheduled_post and every
-- complete_*_post RPC are left untouched; this migration is additive.
--
-- Claim-domain contract:
--   * social_account_id IS NULL      -> legacy domain only
--   * social_account_id IS NOT NULL  -> v2 domain only
--   * the binding of an existing row never changes (no bind, rebind, unbind)
--   * lifecycle changes to bound rows happen only inside the v2 RPCs
--   * v2 RPCs never touch unbound rows
--   * no bound row can be written or claimed while the unpartitioned legacy
--     claim_due_post() is still executable by an API role

-- True when the unpartitioned legacy claim cannot be called by any API role.
-- A missing function also counts as retired.
create function public.x_queue_legacy_claim_retired_v2()
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_fn regprocedure := to_regprocedure('public.claim_due_post()');
        v_role text;
begin
  if v_fn is null then return true; end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname = v_role)
       and pg_catalog.has_function_privilege(v_role, v_fn, 'EXECUTE') then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function public.scheduled_posts_claim_domain_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_in_v2 boolean :=
  coalesce(pg_catalog.current_setting('kabumori.x_queue_domain', true), '') = 'v2';
begin
  if tg_op = 'INSERT' then
    if new.social_account_id is null then
      if v_in_v2 then raise exception 'UNBOUND_ROW_IN_V2_DOMAIN'; end if;
    elsif not public.x_queue_legacy_claim_retired_v2() then
      raise exception 'LEGACY_UNPARTITIONED_CLAIM_ACTIVE';
    end if;
    return new;
  end if;

  if new.social_account_id is distinct from old.social_account_id then
    raise exception 'CLAIM_DOMAIN_IMMUTABLE';
  end if;

  if new.social_account_id is null then
    if v_in_v2 then raise exception 'UNBOUND_ROW_IN_V2_DOMAIN'; end if;
    return new;
  end if;

  if (new.status, new.attempt_count, new.scheduled_for, new.started_at, new.finished_at)
     is distinct from
     (old.status, old.attempt_count, old.scheduled_for, old.started_at, old.finished_at) then
    if not v_in_v2 then raise exception 'BOUND_ROW_REQUIRES_V2_PATH'; end if;
    if old.status = 'pending' and new.status = 'running'
       and not public.x_queue_legacy_claim_retired_v2() then
      raise exception 'LEGACY_UNPARTITIONED_CLAIM_ACTIVE';
    end if;
  end if;
  return new;
end;
$$;

create trigger scheduled_posts_claim_domain_v2
before insert or update on public.scheduled_posts
for each row execute function public.scheduled_posts_claim_domain_guard();

-- Every Phase1B RPC runs in the v2 domain. A non-superuser owner cannot attach
-- a custom setting with ALTER FUNCTION ... SET, so each reviewed Phase1B body
-- is kept byte-for-byte under a *_core name (no API role may call it) and the
-- public name becomes a wrapper that sets the transaction-local domain,
-- calls the core, and restores the previous value.
alter function public.schedule_account_bound_post_v2(text,text,date,text,smallint,timestamptz)
  rename to schedule_account_bound_post_v2_core;
alter function public.plan_daily_posts_v2(text,text,date) rename to plan_daily_posts_v2_core;
alter function public.claim_due_post_v2() rename to claim_due_post_v2_core;
alter function public.mark_post_provider_started_v2(uuid,uuid) rename to mark_post_provider_started_v2_core;
alter function public.settle_post_pre_x_v2(uuid,uuid,boolean,text) rename to settle_post_pre_x_v2_core;
alter function public.record_post_x_uncertain_v2(uuid,uuid,text) rename to record_post_x_uncertain_v2_core;
alter function public.record_post_x_confirmed_incomplete_v2(uuid,uuid,text,text)
  rename to record_post_x_confirmed_incomplete_v2_core;
alter function public.complete_post_x_confirmed_v2(uuid,uuid,text) rename to complete_post_x_confirmed_v2_core;
alter function public.reconcile_stale_pre_x_v2(interval) rename to reconcile_stale_pre_x_v2_core;

revoke all on function public.schedule_account_bound_post_v2_core(text,text,date,text,smallint,timestamptz),
  public.plan_daily_posts_v2_core(text,text,date),
  public.claim_due_post_v2_core(), public.mark_post_provider_started_v2_core(uuid,uuid),
  public.settle_post_pre_x_v2_core(uuid,uuid,boolean,text),
  public.record_post_x_uncertain_v2_core(uuid,uuid,text),
  public.record_post_x_confirmed_incomplete_v2_core(uuid,uuid,text,text),
  public.complete_post_x_confirmed_v2_core(uuid,uuid,text),
  public.reconcile_stale_pre_x_v2_core(interval)
from public, anon, authenticated, service_role;

create function public.schedule_account_bound_post_v2(
  p_brand_id text, p_social_account_id text, p_schedule_date date,
  p_post_type text, p_slot_no smallint, p_scheduled_for timestamptz
) returns public.scheduled_posts
language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_post public.scheduled_posts%rowtype;
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_post := public.schedule_account_bound_post_v2_core(
    p_brand_id, p_social_account_id, p_schedule_date, p_post_type, p_slot_no, p_scheduled_for);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_post;
end;
$$;

create function public.plan_daily_posts_v2(
  p_brand_id text, p_social_account_id text,
  p_date date default ((now() at time zone 'Asia/Tokyo')::date)
) returns setof public.scheduled_posts
language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  return query select * from public.plan_daily_posts_v2_core(p_brand_id, p_social_account_id, p_date);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

create function public.claim_due_post_v2()
returns table (scheduled_post_id uuid, attempt_id uuid, claim_token uuid,
               brand_id text, social_account_id text, post_type text)
language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  return query select * from public.claim_due_post_v2_core();
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

create function public.mark_post_provider_started_v2(p_attempt_id uuid, p_claim_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  perform public.mark_post_provider_started_v2_core(p_attempt_id, p_claim_token);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

create function public.settle_post_pre_x_v2(
  p_attempt_id uuid, p_claim_token uuid, p_retryable boolean, p_error_code text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_outcome text;
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_outcome := public.settle_post_pre_x_v2_core(p_attempt_id, p_claim_token, p_retryable, p_error_code);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_outcome;
end;
$$;

create function public.record_post_x_uncertain_v2(
  p_attempt_id uuid, p_claim_token uuid, p_error_code text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  perform public.record_post_x_uncertain_v2_core(p_attempt_id, p_claim_token, p_error_code);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

create function public.record_post_x_confirmed_incomplete_v2(
  p_attempt_id uuid, p_claim_token uuid, p_x_post_id text, p_error_code text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  perform public.record_post_x_confirmed_incomplete_v2_core(
    p_attempt_id, p_claim_token, p_x_post_id, p_error_code);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

create function public.complete_post_x_confirmed_v2(
  p_attempt_id uuid, p_claim_token uuid, p_x_post_id text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  perform public.complete_post_x_confirmed_v2_core(p_attempt_id, p_claim_token, p_x_post_id);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

create function public.reconcile_stale_pre_x_v2(p_age interval default interval '15 minutes')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_count integer;
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_count := public.reconcile_stale_pre_x_v2_core(p_age);
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_count;
end;
$$;

-- Versioned legacy claim: the live claim_due_post() body (five planners, then
-- the globally oldest due row, started log) fenced to unbound rows. It never
-- writes an account binding. Legacy retry/fail/complete RPCs stay as they are;
-- the trigger above prevents them from changing a bound row.
create function public.claim_due_post_legacy_unbound_v2()
returns setof public.scheduled_posts
language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_claimed_id uuid;
begin
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'legacy', true);
  perform public.plan_morning_report();
  perform public.plan_close_report();
  perform public.plan_daily_posts();
  perform public.plan_weekly_useful_tips();
  -- Plan last so its ±20 minute collision check sees all other scheduled content.
  perform public.plan_us_premarket_report();

  select s.id into v_claimed_id from public.scheduled_posts s
  where s.social_account_id is null
    and s.status = 'pending' and s.scheduled_for <= now()
  order by s.scheduled_for for update of s skip locked limit 1;
  if v_claimed_id is null then
    perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
    return;
  end if;

  update public.scheduled_posts s
  set status = 'running', started_at = now(), attempt_count = s.attempt_count + 1
  where s.id = v_claimed_id and s.social_account_id is null and s.status = 'pending';
  if not found then
    perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
    return;
  end if;

  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
  select s.id, s.post_type, 'started', 'Scheduled post claimed'
  from public.scheduled_posts s where s.id = v_claimed_id;
  return query select s.* from public.scheduled_posts s where s.id = v_claimed_id;
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

revoke all on function public.x_queue_legacy_claim_retired_v2(),
  public.scheduled_posts_claim_domain_guard(),
  public.claim_due_post_legacy_unbound_v2(),
  public.schedule_account_bound_post_v2(text,text,date,text,smallint,timestamptz),
  public.plan_daily_posts_v2(text,text,date),
  public.claim_due_post_v2(), public.mark_post_provider_started_v2(uuid,uuid),
  public.settle_post_pre_x_v2(uuid,uuid,boolean,text),
  public.record_post_x_uncertain_v2(uuid,uuid,text),
  public.record_post_x_confirmed_incomplete_v2(uuid,uuid,text,text),
  public.complete_post_x_confirmed_v2(uuid,uuid,text),
  public.reconcile_stale_pre_x_v2(interval)
from public, anon, authenticated;
grant execute on function public.x_queue_legacy_claim_retired_v2(),
  public.claim_due_post_legacy_unbound_v2(),
  public.schedule_account_bound_post_v2(text,text,date,text,smallint,timestamptz),
  public.plan_daily_posts_v2(text,text,date),
  public.claim_due_post_v2(), public.mark_post_provider_started_v2(uuid,uuid),
  public.settle_post_pre_x_v2(uuid,uuid,boolean,text),
  public.record_post_x_uncertain_v2(uuid,uuid,text),
  public.record_post_x_confirmed_incomplete_v2(uuid,uuid,text,text),
  public.complete_post_x_confirmed_v2(uuid,uuid,text),
  public.reconcile_stale_pre_x_v2(interval)
to service_role;
