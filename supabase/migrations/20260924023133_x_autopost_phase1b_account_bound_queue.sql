-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed dispatcher cutover.
-- Existing planners/claim_due_post/retry_scheduled_post remain untouched.
alter table public.scheduled_posts
  add column social_account_id text,
  add column target_platform text generated always as ('x'::text) stored;

alter table public.social_accounts
  add constraint social_accounts_id_brand_platform_key unique (id, brand_id, platform);
alter table public.social_accounts
  add constraint social_accounts_id_brand_key unique (id, brand_id);
alter table public.scheduled_posts
  add constraint scheduled_posts_x_account_fkey
  foreign key (social_account_id, brand_id, target_platform)
  references public.social_accounts (id, brand_id, platform);
alter table public.scheduled_posts
  add constraint scheduled_posts_attempt_scope_key unique (id, brand_id, social_account_id);

create index scheduled_posts_account_due_v2_idx
  on public.scheduled_posts (brand_id, social_account_id, scheduled_for, id)
  where status = 'pending' and social_account_id is not null;

create sequence public.post_queue_claim_order_v2;
revoke all on sequence public.post_queue_claim_order_v2 from public, anon, authenticated;

create table public.post_queue_account_turns_v2 (
  brand_id text not null,
  social_account_id text not null,
  last_claim_order bigint not null default 0,
  primary key (brand_id, social_account_id),
  foreign key (social_account_id, brand_id) references public.social_accounts (id, brand_id)
);
-- The account-platform check is performed at enqueue and claim; scheduled_posts has
-- the authoritative three-column FK even if a future social platform is introduced.

create table public.post_queue_attempts_v2 (
  id uuid primary key default gen_random_uuid(),
  claim_token uuid not null unique default gen_random_uuid(),
  scheduled_post_id uuid not null,
  brand_id text not null,
  social_account_id text not null,
  attempt_no integer not null check (attempt_no between 1 and 3),
  phase text not null default 'pre_x'
    check (phase in ('pre_x', 'provider_started', 'finished')),
  outcome text check (outcome in (
    'pre_x_retryable', 'pre_x_terminal', 'x_outcome_uncertain',
    'x_confirmed_db_incomplete', 'completed'
  )),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  x_post_id text,
  claimed_at timestamptz not null default now(),
  provider_started_at timestamptz,
  finished_at timestamptz,
  unique (scheduled_post_id, attempt_no),
  foreign key (scheduled_post_id, brand_id, social_account_id)
    references public.scheduled_posts (id, brand_id, social_account_id),
  check ((phase = 'pre_x' and outcome is null and provider_started_at is null and finished_at is null)
      or (phase = 'provider_started' and outcome is null and provider_started_at is not null and finished_at is null)
      or (phase = 'finished' and outcome is not null and finished_at is not null)),
  check (outcome is null
      or (outcome in ('pre_x_retryable', 'pre_x_terminal') and provider_started_at is null and x_post_id is null)
      or (outcome = 'x_outcome_uncertain' and provider_started_at is not null and x_post_id is null)
      or (outcome in ('x_confirmed_db_incomplete', 'completed')
          and provider_started_at is not null and x_post_id is not null))
);
create unique index post_queue_one_open_attempt_v2_idx
  on public.post_queue_attempts_v2 (scheduled_post_id) where phase <> 'finished';
create index post_queue_stale_pre_x_v2_idx
  on public.post_queue_attempts_v2 (claimed_at, id) where phase = 'pre_x';

alter table public.post_queue_account_turns_v2 enable row level security;
alter table public.post_queue_attempts_v2 enable row level security;
revoke all on public.post_queue_account_turns_v2, public.post_queue_attempts_v2 from public, anon, authenticated;
grant select on public.post_queue_attempts_v2 to service_role;

-- Trusted callers must pass the exact account. No lookup/default from brand_id.
create function public.schedule_account_bound_post_v2(
  p_brand_id text, p_social_account_id text, p_schedule_date date,
  p_post_type text, p_slot_no smallint, p_scheduled_for timestamptz
) returns public.scheduled_posts
language plpgsql security definer set search_path = '' as $$
declare v_post public.scheduled_posts%rowtype;
begin
  if p_brand_id is null or p_social_account_id is null or p_schedule_date is null
     or p_post_type is null or p_slot_no is null or p_scheduled_for is null then
    raise exception 'ACCOUNT_BINDING_REQUIRED';
  end if;
  if not exists (
    select 1 from public.social_accounts a
    where a.id = p_social_account_id and a.brand_id = p_brand_id
      and a.platform = 'x' and a.connection_status = 'identity_verified'
      and a.platform_user_id is not null
  ) then
    raise exception 'ACCOUNT_BINDING_NOT_VERIFIED';
  end if;
  -- Materialize the account turn at scheduling time. Doing INSERT ON CONFLICT
  -- inside claim would wait behind another worker's updated turn row.
  insert into public.post_queue_account_turns_v2 (brand_id, social_account_id)
  values (p_brand_id, p_social_account_id) on conflict do nothing;
  insert into public.scheduled_posts
    (brand_id, social_account_id, schedule_date, post_type, slot_no, scheduled_for)
  values (p_brand_id, p_social_account_id, p_schedule_date, p_post_type, p_slot_no, p_scheduled_for)
  on conflict (brand_id, schedule_date, post_type, slot_no) do nothing
  returning * into v_post;
  if v_post.id is null then
    select * into v_post from public.scheduled_posts s
    where s.brand_id = p_brand_id and s.schedule_date = p_schedule_date
      and s.post_type = p_post_type and s.slot_no = p_slot_no;
    if v_post.social_account_id is distinct from p_social_account_id then
      raise exception 'ACCOUNT_BINDING_CONFLICT';
    end if;
  end if;
  return v_post;
end;
$$;

-- Daily window planner candidate. The caller supplies the intended account;
-- report/useful-tip planners with no such trusted input stay legacy/unbound.
create function public.plan_daily_posts_v2(
  p_brand_id text, p_social_account_id text,
  p_date date default ((now() at time zone 'Asia/Tokyo')::date)
) returns setof public.scheduled_posts
language plpgsql security definer set search_path = '' as $$
declare v_window public.posting_windows%rowtype;
        v_now_local timestamp;
        v_start time;
        v_seconds integer;
begin
  if p_brand_id is null or p_social_account_id is null or p_date is null then
    raise exception 'ACCOUNT_BINDING_REQUIRED'; end if;
  for v_window in
    select * from public.posting_windows w
    where w.brand_id = p_brand_id and w.is_active
    order by w.post_type, w.slot_no
  loop
    v_now_local := now() at time zone v_window.timezone;
    v_start := v_window.start_time;
    if p_date = v_now_local::date then
      if v_now_local::time >= v_window.end_time then continue; end if;
      if v_now_local::time > v_start then
        v_start := (v_now_local + interval '1 minute')::time;
      end if;
    end if;
    if v_start > v_window.end_time then continue; end if;
    v_seconds := floor(random() * (
      extract(epoch from (v_window.end_time - v_start)) + 1
    ))::integer;
    perform public.schedule_account_bound_post_v2(
      p_brand_id, p_social_account_id, p_date, v_window.post_type,
      v_window.slot_no,
      ((p_date + v_start + v_seconds * interval '1 second') at time zone v_window.timezone)
    );
  end loop;
  return query select s.* from public.scheduled_posts s
    where s.brand_id = p_brand_id and s.social_account_id = p_social_account_id
      and s.schedule_date = p_date order by s.scheduled_for;
end;
$$;

-- Fairness is per (brand,account), not global oldest. A served account receives
-- a monotonically increasing order, so another due account is chosen next.
create function public.claim_due_post_v2()
returns table (scheduled_post_id uuid, attempt_id uuid, claim_token uuid,
               brand_id text, social_account_id text, post_type text)
language plpgsql security definer set search_path = '' as $$
declare v_turn public.post_queue_account_turns_v2%rowtype;
        v_post public.scheduled_posts%rowtype;
        v_attempt public.post_queue_attempts_v2%rowtype;
begin
  for v_turn in
    select t.* from public.post_queue_account_turns_v2 t
    where exists (
      select 1 from public.scheduled_posts s join public.social_accounts a
        on a.id = s.social_account_id and a.brand_id = s.brand_id and a.platform = 'x'
      where s.brand_id = t.brand_id and s.social_account_id = t.social_account_id
        and s.social_account_id is not null
        and s.status = 'pending' and s.scheduled_for <= now() and s.attempt_count < 3
        and a.publish_enabled and a.connection_status = 'identity_verified'
        and a.platform_user_id is not null
    )
    order by t.last_claim_order, t.brand_id, t.social_account_id
    for update of t skip locked
  loop
    select s.* into v_post from public.scheduled_posts s
    where s.brand_id = v_turn.brand_id and s.social_account_id = v_turn.social_account_id
      and s.status = 'pending' and s.scheduled_for <= now() and s.attempt_count < 3
    order by s.scheduled_for, s.id for update of s skip locked limit 1;
    if v_post.id is null then continue; end if;

    update public.scheduled_posts s set status = 'running', started_at = now(),
      attempt_count = s.attempt_count + 1, finished_at = null
    where s.id = v_post.id;
    insert into public.post_queue_attempts_v2
      (scheduled_post_id, brand_id, social_account_id, attempt_no)
    values (v_post.id, v_post.brand_id, v_post.social_account_id, v_post.attempt_count + 1)
    returning * into v_attempt;
    update public.post_queue_account_turns_v2 t
      set last_claim_order = nextval('public.post_queue_claim_order_v2'::regclass)
    where t.brand_id = v_post.brand_id and t.social_account_id = v_post.social_account_id;
    scheduled_post_id := v_post.id; attempt_id := v_attempt.id;
    claim_token := v_attempt.claim_token; brand_id := v_post.brand_id;
    social_account_id := v_post.social_account_id; post_type := v_post.post_type;
    return next;
    return;
  end loop;
end;
$$;

-- Set immediately before the first provider request. From here on, an unknown
-- provider result is never eligible for automated replay.
create function public.mark_post_provider_started_v2(p_attempt_id uuid, p_claim_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.post_queue_attempts_v2 a
  set phase = 'provider_started', provider_started_at = now()
  where a.id = p_attempt_id and a.claim_token = p_claim_token and a.phase = 'pre_x'
    and exists (select 1 from public.scheduled_posts s
                where s.id = a.scheduled_post_id and s.status = 'running');
  if not found then raise exception 'ATTEMPT_NOT_PRE_X'; end if;
end;
$$;

create function public.settle_post_pre_x_v2(
  p_attempt_id uuid, p_claim_token uuid, p_retryable boolean, p_error_code text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_retry boolean;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,99}$' then
    raise exception 'INVALID_ERROR_CODE';
  end if;
  select * into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if v_attempt.id is null or v_attempt.phase <> 'pre_x' then
    raise exception 'ATTEMPT_NOT_PRE_X';
  end if;
  v_retry := coalesce(p_retryable, false) and v_attempt.attempt_no < 3;
  update public.scheduled_posts s
    set status = case when v_retry then 'pending' else 'failed' end,
        started_at = null, finished_at = case when v_retry then null else now() end
  where s.id = v_attempt.scheduled_post_id and s.status = 'running';
  if not found then raise exception 'POST_NOT_RUNNING'; end if;
  update public.post_queue_attempts_v2 a
    set phase = 'finished', outcome = case when v_retry then 'pre_x_retryable' else 'pre_x_terminal' end,
        error_code = p_error_code, finished_at = now()
  where a.id = v_attempt.id;
  return case when v_retry then 'pre_x_retryable' else 'pre_x_terminal' end;
end;
$$;

create function public.record_post_x_uncertain_v2(
  p_attempt_id uuid, p_claim_token uuid, p_error_code text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,99}$' then
    raise exception 'INVALID_ERROR_CODE'; end if;
  select * into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if v_attempt.id is null or v_attempt.phase <> 'provider_started' then
    raise exception 'ATTEMPT_NOT_PROVIDER_STARTED'; end if;
  update public.scheduled_posts s set status = 'failed', finished_at = now()
  where s.id = v_attempt.scheduled_post_id and s.status = 'running';
  if not found then raise exception 'POST_NOT_RUNNING'; end if;
  update public.post_queue_attempts_v2 a
  set phase = 'finished', outcome = 'x_outcome_uncertain', error_code = p_error_code, finished_at = now()
  where a.id = v_attempt.id;
end;
$$;

create function public.record_post_x_confirmed_incomplete_v2(
  p_attempt_id uuid, p_claim_token uuid, p_x_post_id text, p_error_code text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
begin
  if nullif(btrim(p_x_post_id), '') is null or p_error_code is null
     or p_error_code !~ '^[A-Z][A-Z0-9_]{1,99}$' then
    raise exception 'INVALID_CONFIRMED_OUTCOME'; end if;
  select * into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if v_attempt.id is null or v_attempt.phase <> 'provider_started' then
    raise exception 'ATTEMPT_NOT_PROVIDER_STARTED'; end if;
  update public.scheduled_posts s set status = 'failed', finished_at = now()
  where s.id = v_attempt.scheduled_post_id and s.status = 'running';
  if not found then raise exception 'POST_NOT_RUNNING'; end if;
  update public.post_queue_attempts_v2 a
  set phase = 'finished', outcome = 'x_confirmed_db_incomplete', x_post_id = p_x_post_id,
      error_code = p_error_code, finished_at = now()
  where a.id = v_attempt.id;
end;
$$;

create function public.complete_post_x_confirmed_v2(
  p_attempt_id uuid, p_claim_token uuid, p_x_post_id text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
begin
  if nullif(btrim(p_x_post_id), '') is null then raise exception 'X_POST_ID_REQUIRED'; end if;
  select * into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if v_attempt.id is null or not (
    (v_attempt.phase = 'provider_started' and v_attempt.outcome is null)
    or (v_attempt.phase = 'finished' and v_attempt.outcome = 'x_confirmed_db_incomplete'
        and v_attempt.x_post_id = p_x_post_id)
  ) then raise exception 'ATTEMPT_NOT_CONFIRMABLE'; end if;
  update public.scheduled_posts s set status = 'succeeded', finished_at = now()
  where s.id = v_attempt.scheduled_post_id
    and s.status = case when v_attempt.phase = 'provider_started' then 'running' else 'failed' end;
  if not found then raise exception 'POST_NOT_CONFIRMABLE'; end if;
  update public.post_queue_attempts_v2 a
  set phase = 'finished', outcome = 'completed', x_post_id = p_x_post_id,
      error_code = null, finished_at = now()
  where a.id = v_attempt.id;
end;
$$;

create function public.reconcile_stale_pre_x_v2(p_age interval default interval '15 minutes')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype; v_count integer := 0;
begin
  if p_age is null or p_age < interval '15 minutes' then raise exception 'STALE_AGE_TOO_SHORT'; end if;
  for v_attempt in
    select a.* from public.post_queue_attempts_v2 a
    where a.phase = 'pre_x' and a.claimed_at <= now() - p_age
    order by a.claimed_at, a.id for update of a skip locked
  loop
    update public.scheduled_posts s
    set status = case when v_attempt.attempt_no < 3 then 'pending' else 'failed' end,
        started_at = null,
        finished_at = case when v_attempt.attempt_no < 3 then null else now() end
    where s.id = v_attempt.scheduled_post_id and s.status = 'running';
    if not found then continue; end if;
    update public.post_queue_attempts_v2 a
    set phase = 'finished',
        outcome = case when v_attempt.attempt_no < 3 then 'pre_x_retryable' else 'pre_x_terminal' end,
        error_code = 'PRE_X_STALE_RECONCILED', finished_at = now()
    where a.id = v_attempt.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.schedule_account_bound_post_v2(text,text,date,text,smallint,timestamptz),
  public.plan_daily_posts_v2(text,text,date),
  public.claim_due_post_v2(), public.mark_post_provider_started_v2(uuid,uuid),
  public.settle_post_pre_x_v2(uuid,uuid,boolean,text),
  public.record_post_x_uncertain_v2(uuid,uuid,text),
  public.record_post_x_confirmed_incomplete_v2(uuid,uuid,text,text),
  public.complete_post_x_confirmed_v2(uuid,uuid,text),
  public.reconcile_stale_pre_x_v2(interval) from public, anon, authenticated;
grant execute on function public.schedule_account_bound_post_v2(text,text,date,text,smallint,timestamptz),
  public.plan_daily_posts_v2(text,text,date),
  public.claim_due_post_v2(), public.mark_post_provider_started_v2(uuid,uuid),
  public.settle_post_pre_x_v2(uuid,uuid,boolean,text),
  public.record_post_x_uncertain_v2(uuid,uuid,text),
  public.record_post_x_confirmed_incomplete_v2(uuid,uuid,text,text),
  public.complete_post_x_confirmed_v2(uuid,uuid,text),
  public.reconcile_stale_pre_x_v2(interval) to service_role;
