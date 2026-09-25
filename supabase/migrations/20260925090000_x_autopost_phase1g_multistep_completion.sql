-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
-- Requires Phase1B (20260924023133), Phase1D (20260924160000), Phase1E
-- (20260924170000) and Phase1F (20260924180000). Legacy tip/morning_greeting
-- paths (postThreadToX, runMorningGreetingManualPublish, complete_tip_post,
-- complete_morning_greeting_post, the publish_claim REST helpers) are unchanged.
--
-- Transaction: one explicit transaction (no committed PUBLIC EXECUTE window; a
-- failed assertion leaves nothing). Apply as its own unit with a tool that does
-- NOT wrap the file in another transaction. Not re-runnable.
begin;

-- 0. Fail closed unless the objects this migration builds on are present.
do $$
begin
  if to_regclass('public.post_provider_steps_v2') is null
     or to_regprocedure('public.begin_provider_step_v2(uuid,uuid,smallint,text,text)') is null
     or to_regprocedure('public.x_v2_finish_confirmed_attempt(uuid,uuid,text,text,text,text)') is null then
    raise exception 'PHASE1G_PRECONDITION_PHASE1F_MISSING';
  end if;
  -- publish_claims must be brand-scoped (live Phase0c shape) for ON CONFLICT.
  if not exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indrelid and c.relname = 'publish_claims'
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where i.indisunique and i.indpred is null
      and (select array_agg(a.attname::text order by k.ord)
           from unnest(i.indkey) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum)
          = array['brand_id', 'post_type', 'date_jst']
  ) then
    raise exception 'PHASE1G_PRECONDITION_PUBLISH_CLAIMS_NOT_BRAND_SCOPED';
  end if;
end $$;

-- 1. Step plan: the number and shape of provider requests are fixed before
--    the first request. One plan per attempt, immutable.
create table public.post_provider_step_plans_v2 (
  attempt_id uuid primary key references public.post_queue_attempts_v2 (id),
  plan_kind text not null check (plan_kind in ('tip_thread', 'morning_greeting_media_post')),
  expected_steps smallint not null,
  created_at timestamptz not null default now(),
  check ((plan_kind = 'tip_thread' and expected_steps between 1 and 3)
      or (plan_kind = 'morning_greeting_media_post' and expected_steps = 2))
);
alter table public.post_provider_step_plans_v2 enable row level security;
revoke all on public.post_provider_step_plans_v2 from public, anon, authenticated, service_role;
grant select on public.post_provider_step_plans_v2 to service_role;

-- The provider object a step consumed (greeting create_post: the media id).
alter table public.post_provider_steps_v2 add column input_provider_object_id text;

-- 2. Same-day morning_greeting claim owned by exactly one v2 attempt
--    (execution_id = attempt id). Taken before provider start. Never
--    transferred: like the legacy path, a day whose claim failed is a
--    human-review case.
create function public.acquire_greeting_publish_claim_v2(p_attempt_id uuid, p_claim_token uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_post public.scheduled_posts%rowtype;
        v_claim public.publish_claims%rowtype;
begin
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found or v_attempt.phase <> 'pre_x' then raise exception 'X_CLAIM_NOT_PRE_X' using errcode = 'P0001'; end if;
  select s.* into v_post from public.scheduled_posts s where s.id = v_attempt.scheduled_post_id;
  if v_post.post_type <> 'morning_greeting' or v_post.status <> 'running'
     or v_post.social_account_id is distinct from v_attempt.social_account_id then
    raise exception 'X_COMPLETION_POST_TYPE_MISMATCH' using errcode = 'P0001';
  end if;
  -- The legacy greeting publisher uses the execution day's JST date. Do not
  -- let an overdue scheduled row claim a prior day and publish again today.
  if v_post.schedule_date <> (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date then
    raise exception 'GREETING_SCHEDULE_DATE_STALE' using errcode = 'P0001';
  end if;
  insert into public.publish_claims (brand_id, post_type, date_jst, execution_id, status)
  values (v_attempt.brand_id, 'morning_greeting', v_post.schedule_date, v_attempt.id::text, 'publishing')
  on conflict (brand_id, post_type, date_jst) do nothing;
  select c.* into v_claim from public.publish_claims c
  where c.brand_id = v_attempt.brand_id and c.post_type = 'morning_greeting' and c.date_jst = v_post.schedule_date
  for update;
  if v_claim.execution_id = v_attempt.id::text and v_claim.status = 'publishing' then return 'claimed'; end if;
  if v_claim.status = 'published' then raise exception 'GREETING_ALREADY_PUBLISHED' using errcode = 'P0001'; end if;
  raise exception 'GREETING_PUBLISH_CLAIM_HELD' using errcode = 'P0001';
end;
$$;

create function public.plan_provider_steps_v2(
  p_attempt_id uuid, p_claim_token uuid, p_plan_kind text, p_expected_steps smallint
) returns text language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_post_type text;
        v_plan public.post_provider_step_plans_v2%rowtype;
begin
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found then raise exception 'X_COMPLETION_CLAIM_INVALID' using errcode = 'P0001'; end if;
  select p.* into v_plan from public.post_provider_step_plans_v2 p where p.attempt_id = p_attempt_id;
  if found then
    if v_plan.plan_kind = p_plan_kind and v_plan.expected_steps = p_expected_steps then return 'already_planned'; end if;
    raise exception 'PROVIDER_STEP_PLAN_CONFLICT' using errcode = 'P0001';
  end if;
  if v_attempt.phase <> 'pre_x' then raise exception 'X_CLAIM_NOT_PRE_X' using errcode = 'P0001'; end if;
  select s.post_type into v_post_type from public.scheduled_posts s where s.id = v_attempt.scheduled_post_id;
  if (p_plan_kind = 'tip_thread' and v_post_type <> 'tip')
     or (p_plan_kind = 'morning_greeting_media_post' and v_post_type <> 'morning_greeting')
     or p_plan_kind is null or p_plan_kind not in ('tip_thread', 'morning_greeting_media_post') then
    raise exception 'X_COMPLETION_POST_TYPE_MISMATCH' using errcode = 'P0001';
  end if;
  if p_plan_kind = 'morning_greeting_media_post' and not exists (
    select 1 from public.publish_claims c
    where c.execution_id = p_attempt_id::text and c.brand_id = v_attempt.brand_id
      and c.post_type = 'morning_greeting' and c.status = 'publishing'
  ) then
    raise exception 'GREETING_PUBLISH_CLAIM_NOT_HELD' using errcode = 'P0001';
  end if;
  insert into public.post_provider_step_plans_v2 (attempt_id, plan_kind, expected_steps)
  values (p_attempt_id, p_plan_kind, p_expected_steps);
  return 'planned';
exception
  when check_violation then raise exception 'PROVIDER_STEP_PLAN_INVALID' using errcode = 'P0001';
end;
$$;

-- 3. The only way to start a step: it must fit the plan (count, kind at that
--    position, greeting create consumes exactly the confirmed media id), then
--    the Phase1F order/parent/terminal rules apply.
create function public.begin_planned_provider_step_v2(
  p_attempt_id uuid, p_claim_token uuid, p_step_no smallint, p_step_kind text,
  p_parent_provider_object_id text default null, p_input_provider_object_id text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_plan public.post_provider_step_plans_v2%rowtype;
        v_media public.post_provider_steps_v2%rowtype;
        v_expected_kind text;
begin
  perform 1 from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found then raise exception 'ATTEMPT_NOT_PROVIDER_STARTED' using errcode = 'P0001'; end if;
  select p.* into v_plan from public.post_provider_step_plans_v2 p where p.attempt_id = p_attempt_id;
  if not found then raise exception 'PROVIDER_STEP_PLAN_REQUIRED' using errcode = 'P0001'; end if;
  if p_step_no is null or p_step_no < 1 or p_step_no > v_plan.expected_steps then
    raise exception 'PROVIDER_STEP_BEYOND_PLAN' using errcode = 'P0001';
  end if;
  v_expected_kind := case
    when v_plan.plan_kind = 'tip_thread' and p_step_no = 1 then 'create_post'
    when v_plan.plan_kind = 'tip_thread' then 'create_reply'
    when p_step_no = 1 then 'media_upload'
    else 'create_post' end;
  if p_step_kind is distinct from v_expected_kind then
    raise exception 'PROVIDER_STEP_KIND_NOT_IN_PLAN' using errcode = 'P0001';
  end if;
  if v_plan.plan_kind = 'morning_greeting_media_post' then
    -- Recheck immediately before every X step: a plan/claim made before JST
    -- midnight must not authorize a later-day media upload or tweet create.
    if not exists (
      select 1 from public.post_queue_attempts_v2 a
      join public.scheduled_posts s on s.id = a.scheduled_post_id
      where a.id = p_attempt_id
        and s.schedule_date = (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date
    ) then
      raise exception 'GREETING_SCHEDULE_DATE_STALE' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.publish_claims c
                   where c.execution_id = p_attempt_id::text and c.post_type = 'morning_greeting'
                     and c.status = 'publishing') then
      raise exception 'GREETING_PUBLISH_CLAIM_NOT_HELD' using errcode = 'P0001';
    end if;
    if p_step_no = 2 then
      select s.* into v_media from public.post_provider_steps_v2 s
      where s.attempt_id = p_attempt_id and s.step_no = 1;
      if v_media.outcome is distinct from 'provider_object_confirmed'
         or p_input_provider_object_id is distinct from v_media.provider_object_id then
        raise exception 'PROVIDER_STEP_INPUT_MISMATCH' using errcode = 'P0001';
      end if;
    elsif p_input_provider_object_id is not null then
      raise exception 'PROVIDER_STEP_INPUT_MISMATCH' using errcode = 'P0001';
    end if;
  elsif p_input_provider_object_id is not null then
    raise exception 'PROVIDER_STEP_INPUT_MISMATCH' using errcode = 'P0001';
  end if;
  perform public.begin_provider_step_v2(p_attempt_id, p_claim_token, p_step_no, p_step_kind, p_parent_provider_object_id);
  update public.post_provider_steps_v2 s set input_provider_object_id = p_input_provider_object_id
  where s.attempt_id = p_attempt_id and s.step_no = p_step_no;
end;
$$;

-- 4. Thread completion: every planned part confirmed, chained, nothing extra.
--    Same side effects as complete_tip_post (tip usage, one success log with
--    the root id); every part id stays in post_provider_steps_v2.
create function public.x_v2_confirmed_thread_root(p_attempt_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_plan public.post_provider_step_plans_v2%rowtype;
        v_step public.post_provider_steps_v2%rowtype;
        v_prev_object text;
        v_root text;
        v_count integer := 0;
begin
  select p.* into v_plan from public.post_provider_step_plans_v2 p where p.attempt_id = p_attempt_id;
  if not found or v_plan.plan_kind <> 'tip_thread' then raise exception 'PROVIDER_STEP_PLAN_REQUIRED' using errcode = 'P0001'; end if;
  for v_step in select s.* from public.post_provider_steps_v2 s where s.attempt_id = p_attempt_id order by s.step_no loop
    v_count := v_count + 1;
    if v_step.step_no <> v_count or v_step.outcome is distinct from 'provider_object_confirmed'
       or v_step.input_provider_object_id is not null
       or (v_count = 1 and (v_step.step_kind <> 'create_post' or v_step.parent_provider_object_id is not null))
       or (v_count > 1 and (v_step.step_kind <> 'create_reply' or v_step.parent_provider_object_id is distinct from v_prev_object)) then
      raise exception 'THREAD_STEPS_NOT_COMPLETE' using errcode = 'P0001';
    end if;
    if v_count = 1 then v_root := v_step.provider_object_id; end if;
    v_prev_object := v_step.provider_object_id;
  end loop;
  if v_count <> v_plan.expected_steps then raise exception 'THREAD_STEPS_NOT_COMPLETE' using errcode = 'P0001'; end if;
  if (select count(distinct s.provider_object_id) from public.post_provider_steps_v2 s where s.attempt_id = p_attempt_id) <> v_count then
    raise exception 'THREAD_STEPS_NOT_COMPLETE' using errcode = 'P0001';
  end if;
  return v_root;
end;
$$;

create function public.complete_tip_post_v2(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text, p_brand_id text, p_tip_id uuid
) returns text language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_root text;
        v_result text;
        v_post_id uuid;
begin
  if p_tip_id is null then raise exception 'X_COMPLETION_REQUEST_INVALID' using errcode = 'P0001'; end if;
  perform 1 from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found then raise exception 'X_COMPLETION_CLAIM_INVALID' using errcode = 'P0001'; end if;
  v_root := public.x_v2_confirmed_thread_root(p_attempt_id);
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_result := public.x_v2_finish_confirmed_attempt(
    p_attempt_id, p_claim_token, p_social_account_id, p_brand_id, 'tip', v_root);
  if v_result = 'completed' then
    select a.scheduled_post_id into v_post_id from public.post_queue_attempts_v2 a where a.id = p_attempt_id;
    update public.tips set last_used_at = now(), use_count = use_count + 1 where id = p_tip_id;
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, tip_id, x_post_id, message)
    values (v_post_id, 'tip', 'succeeded', p_tip_id, v_root, 'X post created');
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_result;
end;
$$;

-- 5. Greeting completion: media confirmed, create confirmed with exactly that
--    media, same-day claim held by this attempt. Same effects as the legacy
--    path's DB part (publish_claims published + complete_morning_greeting_post);
--    the Storage receipt stays a best-effort write after commit.
create function public.complete_morning_greeting_post_v2(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text, p_brand_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_plan public.post_provider_step_plans_v2%rowtype;
        v_media public.post_provider_steps_v2%rowtype;
        v_create public.post_provider_steps_v2%rowtype;
        v_attempt public.post_queue_attempts_v2%rowtype;
        v_result text;
begin
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found then raise exception 'X_COMPLETION_CLAIM_INVALID' using errcode = 'P0001'; end if;
  select p.* into v_plan from public.post_provider_step_plans_v2 p where p.attempt_id = p_attempt_id;
  if not found or v_plan.plan_kind <> 'morning_greeting_media_post' then
    raise exception 'PROVIDER_STEP_PLAN_REQUIRED' using errcode = 'P0001';
  end if;
  select s.* into v_media from public.post_provider_steps_v2 s where s.attempt_id = p_attempt_id and s.step_no = 1;
  select s.* into v_create from public.post_provider_steps_v2 s where s.attempt_id = p_attempt_id and s.step_no = 2;
  if v_media.step_kind is distinct from 'media_upload' or v_media.outcome is distinct from 'provider_object_confirmed'
     or v_create.step_kind is distinct from 'create_post' or v_create.outcome is distinct from 'provider_object_confirmed'
     or v_create.input_provider_object_id is distinct from v_media.provider_object_id
     or (select count(*) from public.post_provider_steps_v2 s where s.attempt_id = p_attempt_id) <> 2 then
    raise exception 'GREETING_STEPS_NOT_COMPLETE' using errcode = 'P0001';
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_result := public.x_v2_finish_confirmed_attempt(
    p_attempt_id, p_claim_token, p_social_account_id, p_brand_id, 'morning_greeting', v_create.provider_object_id);
  if v_result = 'completed' then
    update public.publish_claims c
    set status = 'published', x_post_id = v_create.provider_object_id, published_at = now()
    where c.execution_id = p_attempt_id::text and c.brand_id = v_attempt.brand_id
      and c.post_type = 'morning_greeting' and c.status = 'publishing'
      and c.date_jst = (select s.schedule_date from public.scheduled_posts s where s.id = v_attempt.scheduled_post_id);
    if not found then raise exception 'GREETING_PUBLISH_CLAIM_NOT_HELD' using errcode = 'P0001'; end if;
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, x_post_id, message)
    values (v_attempt.scheduled_post_id, 'morning_greeting', 'succeeded', v_create.provider_object_id, 'X post created');
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_result;
end;
$$;

-- 6. Attempt invariants for multi-step posts.
--    a) A thread with any confirmed part is not "rejected": X created something.
--    b) A greeting attempt that ends without completing (and without a
--       confirmed create waiting for DB completion) fails its day claim, as
--       the legacy path does. x_confirmed_db_incomplete keeps the claim
--       'publishing' so the same typed completion can still publish it.
create function public.x_v2_multistep_attempt_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.outcome = 'x_rejected' and old.outcome is distinct from 'x_rejected'
     and exists (select 1 from public.post_provider_steps_v2 s
                 where s.attempt_id = new.id and s.outcome = 'provider_object_confirmed'
                   and s.step_kind in ('create_post', 'create_reply')) then
    raise exception 'X_REJECTED_AFTER_CONFIRMED_CREATE' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function public.x_v2_greeting_claim_on_finish() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.phase = 'finished' and old.phase <> 'finished'
     and new.outcome not in ('completed', 'x_confirmed_db_incomplete') then
    update public.publish_claims c
    set status = 'failed', error_code = left(upper(new.outcome) || ':' || coalesce(new.error_code, 'UNSPECIFIED'), 300)
    where c.execution_id = new.id::text and c.post_type = 'morning_greeting' and c.status = 'publishing';
  end if;
  return null;
end;
$$;

create trigger post_queue_attempts_v2_multistep_guard
before update of outcome on public.post_queue_attempts_v2
for each row execute function public.x_v2_multistep_attempt_guard();
create trigger post_queue_attempts_v2_greeting_claim
after update of phase on public.post_queue_attempts_v2
for each row execute function public.x_v2_greeting_claim_on_finish();

-- 7. Steps can only be started through the plan-aware entry point.
revoke execute on function public.begin_provider_step_v2(uuid, uuid, smallint, text, text) from service_role;

-- 8. ACL.
revoke all on function public.acquire_greeting_publish_claim_v2(uuid, uuid),
  public.plan_provider_steps_v2(uuid, uuid, text, smallint),
  public.begin_planned_provider_step_v2(uuid, uuid, smallint, text, text, text),
  public.x_v2_confirmed_thread_root(uuid),
  public.complete_tip_post_v2(uuid, uuid, text, text, uuid),
  public.complete_morning_greeting_post_v2(uuid, uuid, text, text),
  public.x_v2_multistep_attempt_guard(), public.x_v2_greeting_claim_on_finish()
from public, anon, authenticated, service_role;
grant execute on function
  public.acquire_greeting_publish_claim_v2(uuid, uuid),
  public.plan_provider_steps_v2(uuid, uuid, text, smallint),
  public.begin_planned_provider_step_v2(uuid, uuid, smallint, text, text, text),
  public.complete_tip_post_v2(uuid, uuid, text, text, uuid),
  public.complete_morning_greeting_post_v2(uuid, uuid, text, text)
to service_role;

commit;
