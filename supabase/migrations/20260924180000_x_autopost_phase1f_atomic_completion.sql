-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
-- Requires Phase1B (20260924023133), Phase1D (20260924160000) and Phase1E
-- (20260924170000). Legacy complete_*/retry/fail RPCs are not changed.
--
-- Transaction: the whole file runs in one explicit transaction so no new
-- function is ever committed with the default PUBLIC EXECUTE grant and a
-- failed shape assertion leaves nothing behind. Apply it as its own unit with
-- a tool that does NOT already wrap the file in a transaction (a nested BEGIN
-- only warns, but this COMMIT would end the outer transaction early). It is
-- not re-runnable: a second apply fails at the first CREATE and rolls back.
begin;

-- 0. Fail closed unless the Phase1B attempt constraints are exactly the
--    reviewed shape this migration widens.
do $$
begin
  if (select pg_get_constraintdef(c.oid) from pg_constraint c
      where c.conrelid = 'public.post_queue_attempts_v2'::regclass
        and c.conname = 'post_queue_attempts_v2_outcome_check')
     is distinct from
     'CHECK ((outcome = ANY (ARRAY[''pre_x_retryable''::text, ''pre_x_terminal''::text, ''x_outcome_uncertain''::text, ''x_confirmed_db_incomplete''::text, ''completed''::text])))'
  or (select pg_get_constraintdef(c.oid) from pg_constraint c
      where c.conrelid = 'public.post_queue_attempts_v2'::regclass
        and c.conname = 'post_queue_attempts_v2_check1')
     is distinct from
     'CHECK (((outcome IS NULL) OR ((outcome = ANY (ARRAY[''pre_x_retryable''::text, ''pre_x_terminal''::text])) AND (provider_started_at IS NULL) AND (x_post_id IS NULL)) OR ((outcome = ''x_outcome_uncertain''::text) AND (provider_started_at IS NOT NULL) AND (x_post_id IS NULL)) OR ((outcome = ANY (ARRAY[''x_confirmed_db_incomplete''::text, ''completed''::text])) AND (provider_started_at IS NOT NULL) AND (x_post_id IS NOT NULL))))'
  then
    raise exception 'PHASE1F_PRECONDITION_ATTEMPT_CONSTRAINTS_DRIFTED';
  end if;
end $$;

-- 1. Outcome model. x_rejected = the provider was started and X answered that
--    it did not create the post. Terminal, non-reclaimable, never carries an
--    X post id, always carries an error code.
alter table public.post_queue_attempts_v2
  drop constraint post_queue_attempts_v2_outcome_check,
  drop constraint post_queue_attempts_v2_check1;
alter table public.post_queue_attempts_v2
  add constraint post_queue_attempts_v2_outcome_values_check check (outcome in (
    'pre_x_retryable', 'pre_x_terminal', 'x_outcome_uncertain', 'x_rejected',
    'x_confirmed_db_incomplete', 'completed')),
  add constraint post_queue_attempts_v2_outcome_shape_check check (outcome is null
    or (outcome in ('pre_x_retryable', 'pre_x_terminal') and provider_started_at is null and x_post_id is null)
    or (outcome = 'x_outcome_uncertain' and provider_started_at is not null and x_post_id is null)
    or (outcome = 'x_rejected' and provider_started_at is not null and x_post_id is null and error_code is not null)
    or (outcome in ('x_confirmed_db_incomplete', 'completed')
        and provider_started_at is not null and x_post_id is not null));

-- 2. Provider-step ledger foundation for multi-request post types (tip
--    threads, media + create). One row per X request, created durably before
--    the request, in strict order; a step number can never be started twice.
create table public.post_provider_steps_v2 (
  attempt_id uuid not null references public.post_queue_attempts_v2 (id),
  step_no smallint not null check (step_no between 1 and 10),
  step_kind text not null check (step_kind in ('media_upload', 'create_post', 'create_reply')),
  parent_provider_object_id text,
  phase text not null default 'provider_started' check (phase in ('provider_started', 'finished')),
  outcome text check (outcome in ('provider_object_confirmed', 'x_rejected', 'x_outcome_uncertain')),
  provider_object_id text,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (attempt_id, step_no),
  check ((step_kind = 'create_reply') = (parent_provider_object_id is not null)),
  check ((phase = 'provider_started' and outcome is null and provider_object_id is null and finished_at is null)
      or (phase = 'finished' and finished_at is not null and (
            (outcome = 'provider_object_confirmed' and provider_object_id is not null and error_code is null)
         or (outcome in ('x_rejected', 'x_outcome_uncertain') and provider_object_id is null and error_code is not null))))
);
alter table public.post_provider_steps_v2 enable row level security;
-- Supabase default privileges also grant service_role write access to new
-- tables; the ledger must only change through the RPCs below.
revoke all on public.post_provider_steps_v2 from public, anon, authenticated, service_role;
grant select on public.post_provider_steps_v2 to service_role;
-- Same hardening for the Phase1B ledger tables: API roles, including
-- service_role, may read attempts but never write the ledger directly.
revoke insert, update, delete, truncate on public.post_queue_attempts_v2, public.post_queue_account_turns_v2
  from service_role;
-- Phase1D's custom domain setting is caller-settable; it is not an ACL.
-- Keep bound-post lifecycle writes inside the reviewed SECURITY DEFINER RPCs.
-- Legacy owner-executed planners/completions remain available for unbound rows.
revoke insert, update, delete, truncate on public.scheduled_posts
  from public, anon, authenticated, service_role;

-- 3. Shared internal transition for a confirmed X create. Locks the attempt and
--    the post, proves claim/account/brand/post-type identity, and moves both
--    to their completed state. Returns 'already_completed' (and changes
--    nothing) for an exact duplicate, so callers skip their side effects.
--    Callers must already be in the v2 queue domain. Not callable by API roles.
create function public.x_v2_finish_confirmed_attempt(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text,
  p_brand_id text, p_post_type text, p_x_post_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_post public.scheduled_posts%rowtype;
begin
  if p_attempt_id is null or p_claim_token is null
     or nullif(btrim(p_social_account_id), '') is null or nullif(btrim(p_brand_id), '') is null
     or nullif(btrim(p_post_type), '') is null or nullif(btrim(p_x_post_id), '') is null then
    raise exception 'X_COMPLETION_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  if coalesce(pg_catalog.current_setting('kabumori.x_queue_domain', true), '') <> 'v2' then
    raise exception 'X_COMPLETION_OUTSIDE_V2_DOMAIN' using errcode = 'P0001';
  end if;
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found then raise exception 'X_COMPLETION_CLAIM_INVALID' using errcode = 'P0001'; end if;
  if v_attempt.social_account_id <> p_social_account_id or v_attempt.brand_id <> p_brand_id then
    raise exception 'X_COMPLETION_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  select s.* into v_post from public.scheduled_posts s
  where s.id = v_attempt.scheduled_post_id for update;
  if not found or v_post.social_account_id is distinct from v_attempt.social_account_id
     or v_post.brand_id is distinct from v_attempt.brand_id then
    raise exception 'X_COMPLETION_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if v_post.post_type <> p_post_type then
    raise exception 'X_COMPLETION_POST_TYPE_MISMATCH' using errcode = 'P0001';
  end if;
  -- Exactly-once completion across concurrent or repeated calls.
  if v_attempt.outcome = 'completed' then
    if v_attempt.x_post_id = p_x_post_id and v_post.status = 'succeeded' then
      return 'already_completed';
    end if;
    raise exception 'X_COMPLETION_CONFLICT' using errcode = 'P0001';
  end if;
  -- Legal predecessors only; never backwards across the provider-start boundary.
  if v_attempt.phase = 'provider_started' and v_attempt.outcome is null then
    if v_post.status <> 'running' then raise exception 'X_COMPLETION_POST_NOT_RUNNING' using errcode = 'P0001'; end if;
  elsif v_attempt.phase = 'finished' and v_attempt.outcome = 'x_confirmed_db_incomplete' then
    if v_attempt.x_post_id <> p_x_post_id then raise exception 'X_COMPLETION_CONFLICT' using errcode = 'P0001'; end if;
    if v_post.status <> 'failed' then raise exception 'X_COMPLETION_POST_NOT_RECOVERABLE' using errcode = 'P0001'; end if;
  else
    raise exception 'ATTEMPT_NOT_CONFIRMABLE' using errcode = 'P0001';
  end if;
  -- Newer attempts for the same post would make this one stale.
  if exists (select 1 from public.post_queue_attempts_v2 a
             where a.scheduled_post_id = v_attempt.scheduled_post_id and a.attempt_no > v_attempt.attempt_no) then
    raise exception 'ATTEMPT_NOT_CONFIRMABLE' using errcode = 'P0001';
  end if;
  update public.scheduled_posts s set status = 'succeeded', finished_at = now() where s.id = v_post.id;
  update public.post_queue_attempts_v2 a
  set phase = 'finished', outcome = 'completed', x_post_id = p_x_post_id,
      error_code = null, finished_at = now()
  where a.id = v_attempt.id;
  return 'completed';
end;
$$;

-- 4. Per-type atomic completion. Each function is one transaction: identity +
--    outcome validation, scheduled_posts, the v2 ledger, the exact legacy
--    side effects of the matching complete_*_post, and the success log.
create function public.complete_interaction_post_v2(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text, p_brand_id text,
  p_x_post_id text, p_interaction_topic_id uuid
) returns text language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_result text;
        v_post_id uuid;
begin
  if p_interaction_topic_id is null then raise exception 'X_COMPLETION_REQUEST_INVALID' using errcode = 'P0001'; end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_result := public.x_v2_finish_confirmed_attempt(
    p_attempt_id, p_claim_token, p_social_account_id, p_brand_id, 'interaction', p_x_post_id);
  if v_result = 'completed' then
    select a.scheduled_post_id into v_post_id from public.post_queue_attempts_v2 a where a.id = p_attempt_id;
    update public.interaction_topics
    set last_used_at = now(), use_count = use_count + 1
    where id = p_interaction_topic_id;
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, x_post_id, message)
    values (v_post_id, 'interaction', 'succeeded', p_x_post_id,
            'Interaction X post created; topic=' || p_interaction_topic_id::text);
    insert into public.interaction_post_metrics (scheduled_post_id, interaction_topic_id, x_post_id)
    values (v_post_id, p_interaction_topic_id, p_x_post_id);
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_result;
end;
$$;

create function public.complete_useful_tip_post_v2(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text, p_brand_id text,
  p_x_post_id text, p_useful_tip_id uuid, p_source_urls jsonb, p_model_used text,
  p_escalated boolean, p_input_tokens integer, p_output_tokens integer, p_api_cost numeric
) returns text language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_result text;
        v_post_id uuid;
begin
  if p_useful_tip_id is null then raise exception 'X_COMPLETION_REQUEST_INVALID' using errcode = 'P0001'; end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_result := public.x_v2_finish_confirmed_attempt(
    p_attempt_id, p_claim_token, p_social_account_id, p_brand_id, 'useful_tip', p_x_post_id);
  if v_result = 'completed' then
    select a.scheduled_post_id into v_post_id from public.post_queue_attempts_v2 a where a.id = p_attempt_id;
    update public.useful_tips set last_used_at = now(), use_count = use_count + 1 where id = p_useful_tip_id;
    insert into public.post_execution_logs (
      scheduled_post_id, post_type, status, useful_tip_id, x_post_id, message,
      source_urls, verified_at, model_used, escalated_to_sol, input_tokens, output_tokens, api_cost_usd
    ) values (
      v_post_id, 'useful_tip', 'succeeded', p_useful_tip_id, p_x_post_id,
      'Verified useful tip posted', p_source_urls, now(), p_model_used, p_escalated,
      p_input_tokens, p_output_tokens, p_api_cost
    );
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_result;
end;
$$;

-- Report runs: same effects as complete_{morning,close,us_premarket}_report_post,
-- plus a fail-closed check that the run belongs to the claimed post.
create function public.x_v2_complete_report_run(
  p_post_type text, p_scheduled_post_id uuid, p_run_id uuid, p_x_post_id text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_run_post uuid;
        v_source_urls jsonb; v_generated_at timestamptz; v_model text;
        v_in integer; v_out integer; v_cost numeric;
        v_message text;
begin
  if p_run_id is null then raise exception 'X_COMPLETION_REQUEST_INVALID' using errcode = 'P0001'; end if;
  if p_post_type = 'morning_report' then
    select r.scheduled_post_id into v_run_post from public.morning_report_runs r where r.id = p_run_id for update;
    if not found then raise exception 'MORNING_REPORT_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
    if v_run_post is distinct from p_scheduled_post_id then raise exception 'X_COMPLETION_RUN_POST_MISMATCH' using errcode = 'P0001'; end if;
    update public.morning_report_runs r set status = 'succeeded', x_post_id = p_x_post_id, error = null
    where r.id = p_run_id
    returning r.source_urls, r.generated_at, r.model_used, r.input_tokens, r.output_tokens, r.api_cost_usd
      into v_source_urls, v_generated_at, v_model, v_in, v_out, v_cost;
    v_message := 'Morning report posted';
  elsif p_post_type = 'close_report' then
    select r.scheduled_post_id into v_run_post from public.close_report_runs r where r.id = p_run_id for update;
    if not found then raise exception 'CLOSE_REPORT_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
    if v_run_post is distinct from p_scheduled_post_id then raise exception 'X_COMPLETION_RUN_POST_MISMATCH' using errcode = 'P0001'; end if;
    update public.close_report_runs r set status = 'succeeded', x_post_id = p_x_post_id, error = null
    where r.id = p_run_id
    returning r.source_urls, r.generated_at, r.model_used, r.input_tokens, r.output_tokens, r.api_cost_usd
      into v_source_urls, v_generated_at, v_model, v_in, v_out, v_cost;
    v_message := 'Close report posted';
  elsif p_post_type = 'us_premarket_report' then
    select r.scheduled_post_id into v_run_post from public.us_premarket_report_runs r where r.id = p_run_id for update;
    if not found then raise exception 'US_PREMARKET_REPORT_RUN_NOT_FOUND' using errcode = 'P0001'; end if;
    if v_run_post is distinct from p_scheduled_post_id then raise exception 'X_COMPLETION_RUN_POST_MISMATCH' using errcode = 'P0001'; end if;
    update public.us_premarket_report_runs r set status = 'succeeded', x_post_id = p_x_post_id, error = null
    where r.id = p_run_id
    returning r.source_urls, r.generated_at, r.model_used, r.input_tokens, r.output_tokens, r.api_cost_usd
      into v_source_urls, v_generated_at, v_model, v_in, v_out, v_cost;
    v_message := 'US premarket report posted';
  else
    raise exception 'X_COMPLETION_POST_TYPE_MISMATCH' using errcode = 'P0001';
  end if;
  insert into public.post_execution_logs (
    scheduled_post_id, post_type, status, x_post_id, message,
    source_urls, verified_at, model_used, input_tokens, output_tokens, api_cost_usd
  ) values (
    p_scheduled_post_id, p_post_type, 'succeeded', p_x_post_id, v_message,
    v_source_urls, v_generated_at, v_model, v_in, v_out, v_cost
  );
end;
$$;

create function public.complete_report_post_v2(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text, p_brand_id text,
  p_post_type text, p_x_post_id text, p_run_id uuid
) returns text language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_result text;
        v_post_id uuid;
begin
  if p_post_type is null or p_post_type not in ('morning_report', 'close_report', 'us_premarket_report') then
    raise exception 'X_COMPLETION_POST_TYPE_MISMATCH' using errcode = 'P0001';
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  v_result := public.x_v2_finish_confirmed_attempt(
    p_attempt_id, p_claim_token, p_social_account_id, p_brand_id, p_post_type, p_x_post_id);
  if v_result = 'completed' then
    select a.scheduled_post_id into v_post_id from public.post_queue_attempts_v2 a where a.id = p_attempt_id;
    perform public.x_v2_complete_report_run(p_post_type, v_post_id, p_run_id, p_x_post_id);
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
  return v_result;
end;
$$;

-- 5. Durable x_rejected. Only from provider_started; the post becomes failed,
--    which neither lane can re-claim.
create function public.record_post_x_rejected_v2(
  p_attempt_id uuid, p_claim_token uuid, p_error_code text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_prev text := pg_catalog.current_setting('kabumori.x_queue_domain', true);
        v_attempt public.post_queue_attempts_v2%rowtype;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,99}$' then
    raise exception 'INVALID_ERROR_CODE' using errcode = 'P0001';
  end if;
  perform pg_catalog.set_config('kabumori.x_queue_domain', 'v2', true);
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found or v_attempt.phase <> 'provider_started' or v_attempt.outcome is not null then
    raise exception 'ATTEMPT_NOT_PROVIDER_STARTED' using errcode = 'P0001';
  end if;
  update public.scheduled_posts s set status = 'failed', finished_at = now()
  where s.id = v_attempt.scheduled_post_id and s.status = 'running';
  if not found then raise exception 'POST_NOT_RUNNING' using errcode = 'P0001'; end if;
  update public.post_queue_attempts_v2 a
  set phase = 'finished', outcome = 'x_rejected', error_code = p_error_code, finished_at = now()
  where a.id = v_attempt.id;
  perform pg_catalog.set_config('kabumori.x_queue_domain', coalesce(v_prev, ''), true);
end;
$$;

-- 6. Provider steps. The attempt must already be provider_started (the single
--    durable boundary). Steps are strictly sequential; a started step is never
--    restarted, so a request is never sent twice for the same step.
create function public.begin_provider_step_v2(
  p_attempt_id uuid, p_claim_token uuid, p_step_no smallint, p_step_kind text,
  p_parent_provider_object_id text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_prev_step public.post_provider_steps_v2%rowtype;
begin
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found or v_attempt.phase <> 'provider_started' or v_attempt.outcome is not null then
    raise exception 'ATTEMPT_NOT_PROVIDER_STARTED' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.post_provider_steps_v2 s where s.attempt_id = p_attempt_id and s.step_no = p_step_no) then
    raise exception 'PROVIDER_STEP_ALREADY_STARTED' using errcode = 'P0001';
  end if;
  if p_step_no is null or p_step_no <> coalesce(
       (select max(s.step_no) from public.post_provider_steps_v2 s where s.attempt_id = p_attempt_id), 0) + 1 then
    raise exception 'PROVIDER_STEP_OUT_OF_ORDER' using errcode = 'P0001';
  end if;
  if p_step_no = 1 and p_step_kind = 'create_reply' then
    raise exception 'PROVIDER_STEP_FIRST_MUST_CREATE' using errcode = 'P0001';
  end if;
  if p_step_no > 1 then
    select s.* into v_prev_step from public.post_provider_steps_v2 s
    where s.attempt_id = p_attempt_id and s.step_no = p_step_no - 1;
    if v_prev_step.phase <> 'finished' or v_prev_step.outcome <> 'provider_object_confirmed' then
      raise exception 'PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED' using errcode = 'P0001';
    end if;
    if (v_prev_step.step_kind = 'media_upload' and p_step_kind is distinct from 'create_post')
       or (v_prev_step.step_kind in ('create_post', 'create_reply')
           and p_step_kind is distinct from 'create_reply') then
      raise exception 'PROVIDER_STEP_KIND_SEQUENCE_INVALID' using errcode = 'P0001';
    end if;
    if p_step_kind = 'create_reply'
       and p_parent_provider_object_id is distinct from v_prev_step.provider_object_id then
      raise exception 'PROVIDER_STEP_PARENT_MISMATCH' using errcode = 'P0001';
    end if;
  end if;
  insert into public.post_provider_steps_v2 (attempt_id, step_no, step_kind, parent_provider_object_id)
  values (p_attempt_id, p_step_no, p_step_kind, p_parent_provider_object_id);
end;
$$;

create function public.finish_provider_step_v2(
  p_attempt_id uuid, p_claim_token uuid, p_step_no smallint, p_outcome text,
  p_provider_object_id text, p_error_code text
) returns text language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_step public.post_provider_steps_v2%rowtype;
begin
  -- Lock the attempt before the step, as begin_provider_step_v2 does. This
  -- serializes a finish against any terminal attempt transition.
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found then
    raise exception 'X_COMPLETION_CLAIM_INVALID' using errcode = 'P0001';
  end if;
  select s.* into v_step from public.post_provider_steps_v2 s
  where s.attempt_id = p_attempt_id and s.step_no = p_step_no for update;
  if not found then raise exception 'PROVIDER_STEP_NOT_STARTED' using errcode = 'P0001'; end if;
  if v_step.phase = 'finished' then
    if v_step.outcome = p_outcome and v_step.provider_object_id is not distinct from p_provider_object_id
       and v_step.error_code is not distinct from p_error_code then
      return 'already_finished';
    end if;
    raise exception 'PROVIDER_STEP_CONFLICT' using errcode = 'P0001';
  end if;
  if v_attempt.phase <> 'provider_started' or v_attempt.outcome is not null then
    raise exception 'ATTEMPT_NOT_PROVIDER_STARTED' using errcode = 'P0001';
  end if;
  update public.post_provider_steps_v2 s
  set phase = 'finished', outcome = p_outcome, provider_object_id = p_provider_object_id,
      error_code = p_error_code, finished_at = now()
  where s.attempt_id = p_attempt_id and s.step_no = p_step_no;
  return 'finished';
end;
$$;

-- 7. Observability. Attempts write the legacy-shaped started log at claim and
--    a failed log that names the exact outcome when they finish without
--    completing. Reclaimability is decided by the ledger, never by these logs.
create function public.x_v2_attempt_log_started() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.post_execution_logs (scheduled_post_id, post_type, status, message)
  select s.id, s.post_type, 'started', 'Scheduled post claimed (v2 attempt ' || new.attempt_no || ')'
  from public.scheduled_posts s where s.id = new.scheduled_post_id;
  return null;
end;
$$;

create function public.x_v2_attempt_log_finished() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.phase = 'finished' and old.phase <> 'finished' and new.outcome <> 'completed' then
    insert into public.post_execution_logs (scheduled_post_id, post_type, status, x_post_id, error_code, message)
    select s.id, s.post_type, 'failed', new.x_post_id, new.error_code,
           left(upper(new.outcome) || ':' || coalesce(new.error_code, 'UNSPECIFIED'), 300)
    from public.scheduled_posts s where s.id = new.scheduled_post_id;
  end if;
  return null;
end;
$$;

create trigger post_queue_attempts_v2_log_started
after insert on public.post_queue_attempts_v2
for each row execute function public.x_v2_attempt_log_started();
create trigger post_queue_attempts_v2_log_finished
after update of phase on public.post_queue_attempts_v2
for each row execute function public.x_v2_attempt_log_finished();

-- 8. The Phase1B generic completion performs no type side effects. Retire it
--    so every confirmed create goes through a typed atomic completion.
revoke execute on function public.complete_post_x_confirmed_v2(uuid, uuid, text) from service_role;

-- 9. ACL.
revoke all on function public.x_v2_finish_confirmed_attempt(uuid, uuid, text, text, text, text),
  public.x_v2_complete_report_run(text, uuid, uuid, text),
  public.x_v2_attempt_log_started(), public.x_v2_attempt_log_finished(),
  public.complete_interaction_post_v2(uuid, uuid, text, text, text, uuid),
  public.complete_useful_tip_post_v2(uuid, uuid, text, text, text, uuid, jsonb, text, boolean, integer, integer, numeric),
  public.complete_report_post_v2(uuid, uuid, text, text, text, text, uuid),
  public.record_post_x_rejected_v2(uuid, uuid, text),
  public.begin_provider_step_v2(uuid, uuid, smallint, text, text),
  public.finish_provider_step_v2(uuid, uuid, smallint, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.complete_interaction_post_v2(uuid, uuid, text, text, text, uuid),
  public.complete_useful_tip_post_v2(uuid, uuid, text, text, text, uuid, jsonb, text, boolean, integer, integer, numeric),
  public.complete_report_post_v2(uuid, uuid, text, text, text, text, uuid),
  public.record_post_x_rejected_v2(uuid, uuid, text),
  public.begin_provider_step_v2(uuid, uuid, smallint, text, text),
  public.finish_provider_step_v2(uuid, uuid, smallint, text, text, text)
to service_role;

commit;
