-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
-- Requires Phase1B/1D/1E/1F/1G (20260924023133 .. 20260925090000).
-- Supports the gated v2 dispatcher's multi-step resume after a process
-- restart. The Phase1E reader is unchanged and still pre-X only.
--
-- Transaction: one explicit transaction; apply alone with a tool that does
-- NOT wrap the file in another transaction; not re-runnable.
begin;

do $$
begin
  if to_regclass('public.post_provider_step_plans_v2') is null
     or to_regprocedure('public.begin_planned_provider_step_v2(uuid,uuid,smallint,text,text,text)') is null
     or to_regprocedure('public.read_x_publish_credential_for_claim_v2(uuid,uuid,text,text,boolean)') is null then
    raise exception 'PHASE1H_PRECONDITION_PHASE1E_1G_MISSING';
  end if;
end $$;

-- 1. Content snapshot: the exact text a multi-step publish will send, fixed
--    before provider start so a restarted process continues with the same
--    parts instead of regenerating them. Not secret; no tokens.
create table public.post_v2_content_snapshots (
  attempt_id uuid primary key references public.post_queue_attempts_v2 (id),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.post_v2_content_snapshots enable row level security;
revoke all on public.post_v2_content_snapshots from public, anon, authenticated, service_role;
grant select on public.post_v2_content_snapshots to service_role;

create function public.record_v2_content_snapshot(p_attempt_id uuid, p_claim_token uuid, p_payload jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_plan public.post_provider_step_plans_v2%rowtype;
        v_existing jsonb;
        v_part jsonb;
begin
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token for update;
  if not found then raise exception 'X_COMPLETION_CLAIM_INVALID' using errcode = 'P0001'; end if;
  select s.payload into v_existing from public.post_v2_content_snapshots s where s.attempt_id = p_attempt_id;
  if found then
    if v_existing = p_payload then return 'already_recorded'; end if;
    raise exception 'V2_CONTENT_SNAPSHOT_CONFLICT' using errcode = 'P0001';
  end if;
  if v_attempt.phase <> 'pre_x' then raise exception 'X_CLAIM_NOT_PRE_X' using errcode = 'P0001'; end if;
  select p.* into v_plan from public.post_provider_step_plans_v2 p where p.attempt_id = p_attempt_id;
  if not found then raise exception 'PROVIDER_STEP_PLAN_REQUIRED' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'V2_CONTENT_SNAPSHOT_INVALID' using errcode = 'P0001';
  end if;
  if v_plan.plan_kind = 'tip_thread' then
    if (select count(*) from jsonb_object_keys(p_payload)) <> 2
       or jsonb_typeof(p_payload -> 'parts') is distinct from 'array'
       or jsonb_array_length(p_payload -> 'parts') <> v_plan.expected_steps
       or (p_payload ->> 'tip_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'V2_CONTENT_SNAPSHOT_INVALID' using errcode = 'P0001';
    end if;
    for v_part in select * from jsonb_array_elements(p_payload -> 'parts') loop
      if jsonb_typeof(v_part) <> 'string' or length(btrim(v_part #>> '{}')) = 0 or length(v_part #>> '{}') > 1000 then
        raise exception 'V2_CONTENT_SNAPSHOT_INVALID' using errcode = 'P0001';
      end if;
    end loop;
  else
    if (select count(*) from jsonb_object_keys(p_payload)) <> 1
       or jsonb_typeof(p_payload -> 'text') is distinct from 'string'
       or length(btrim(p_payload ->> 'text')) = 0 or length(p_payload ->> 'text') > 1000 then
      raise exception 'V2_CONTENT_SNAPSHOT_INVALID' using errcode = 'P0001';
    end if;
  end if;
  insert into public.post_v2_content_snapshots (attempt_id, payload) values (p_attempt_id, p_payload);
  return 'recorded';
end;
$$;

-- 2. tip / morning_greeting cannot cross the provider-start boundary without
--    a plan and a content snapshot.
create function public.x_v2_require_plan_before_start() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_post_type text;
begin
  if old.phase = 'pre_x' and new.phase = 'provider_started' then
    select s.post_type into v_post_type from public.scheduled_posts s where s.id = new.scheduled_post_id;
    if v_post_type in ('tip', 'morning_greeting') then
      if not exists (select 1 from public.post_provider_step_plans_v2 p where p.attempt_id = new.id) then
        raise exception 'PROVIDER_STEP_PLAN_REQUIRED' using errcode = 'P0001';
      end if;
      if not exists (select 1 from public.post_v2_content_snapshots c where c.attempt_id = new.id) then
        raise exception 'V2_CONTENT_SNAPSHOT_REQUIRED' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger post_queue_attempts_v2_require_plan
before update of phase on public.post_queue_attempts_v2
for each row execute function public.x_v2_require_plan_before_start();

-- 3. Resumable multi-step attempts: provider started, no outcome, plan and
--    snapshot present, no step in flight, every finished step confirmed.
--    Includes attempts whose steps are all confirmed (ready to complete).
create function public.x_v2_attempt_resumable(p_attempt_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.post_queue_attempts_v2 a
    join public.scheduled_posts s on s.id = a.scheduled_post_id
      and s.status = 'running' and s.social_account_id = a.social_account_id and s.brand_id = a.brand_id
    join public.post_provider_step_plans_v2 p on p.attempt_id = a.id
    join public.post_v2_content_snapshots c on c.attempt_id = a.id
    where a.id = p_attempt_id and a.phase = 'provider_started' and a.outcome is null
      and not exists (select 1 from public.post_provider_steps_v2 st
                      where st.attempt_id = a.id
                        and (st.phase <> 'finished' or st.outcome <> 'provider_object_confirmed'))
      and (select count(*) from public.post_provider_steps_v2 st where st.attempt_id = a.id) <= p.expected_steps
  )
$$;

create function public.list_resumable_v2_attempts(p_limit integer default 1)
returns table (attempt_id uuid, claim_token uuid, scheduled_post_id uuid, brand_id text,
               social_account_id text, post_type text, plan_kind text, expected_steps smallint,
               confirmed_steps integer)
language sql stable security definer set search_path = '' as $$
  select a.id, a.claim_token, a.scheduled_post_id, a.brand_id, a.social_account_id, s.post_type,
         p.plan_kind, p.expected_steps,
         (select count(*)::integer from public.post_provider_steps_v2 st where st.attempt_id = a.id)
  from public.post_queue_attempts_v2 a
  join public.scheduled_posts s on s.id = a.scheduled_post_id
  join public.post_provider_step_plans_v2 p on p.attempt_id = a.id
  where a.phase = 'provider_started' and a.outcome is null
    and public.x_v2_attempt_resumable(a.id)
  order by a.provider_started_at, a.id
  limit greatest(1, least(coalesce(p_limit, 1), 10))
$$;

-- 4. Credential for the next step of a resumable attempt only. Same account,
--    brand, verification, publish and Vault rules as Phase1E; never for an
--    attempt with a step in flight or a non-confirmed step, never once all
--    planned steps exist (only completion remains, which needs no token).
create function public.read_x_publish_credential_for_resume_v2(
  p_attempt_id uuid, p_claim_token uuid, p_social_account_id text, p_expected_brand_id text
)
returns table (social_account_id text, brand_id text, platform_user_id text, access_token text)
language plpgsql security definer set search_path = '' as $$
declare v_attempt public.post_queue_attempts_v2%rowtype;
        v_account record;
        v_access_secret_id uuid;
        v_access_token text;
begin
  if p_attempt_id is null or p_claim_token is null
     or nullif(btrim(p_social_account_id), '') is null or nullif(btrim(p_expected_brand_id), '') is null then
    raise exception 'X_CREDENTIAL_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select a.* into v_attempt from public.post_queue_attempts_v2 a
  where a.id = p_attempt_id and a.claim_token = p_claim_token;
  if not found then raise exception 'X_RESUME_NOT_ALLOWED' using errcode = 'P0001'; end if;
  if v_attempt.social_account_id <> p_social_account_id or v_attempt.brand_id <> p_expected_brand_id then
    raise exception 'X_CLAIM_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  if not public.x_v2_attempt_resumable(p_attempt_id)
     or (select count(*) from public.post_provider_steps_v2 st where st.attempt_id = p_attempt_id)
        >= (select p.expected_steps from public.post_provider_step_plans_v2 p where p.attempt_id = p_attempt_id) then
    raise exception 'X_RESUME_NOT_ALLOWED' using errcode = 'P0001';
  end if;

  select sa.id, sa.brand_id, sa.platform, sa.connection_status, sa.platform_user_id, sa.publish_enabled
    into v_account
  from public.social_accounts sa where sa.id = v_attempt.social_account_id;
  if not found then raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001'; end if;
  if v_account.platform is distinct from 'x' then raise exception 'X_ACCOUNT_NOT_X' using errcode = 'P0001'; end if;
  if v_account.brand_id is distinct from v_attempt.brand_id then
    raise exception 'X_ACCOUNT_BRAND_MISMATCH' using errcode = 'P0001';
  end if;
  if v_account.connection_status is distinct from 'identity_verified'
     or nullif(btrim(v_account.platform_user_id), '') is null then
    raise exception 'X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  if v_account.publish_enabled is distinct from true then
    raise exception 'X_ACCOUNT_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;
  select sa.vault_access_token_secret_id into v_access_secret_id
  from public.social_accounts sa
  where sa.id = v_account.id and sa.brand_id = v_account.brand_id and sa.platform = 'x';
  if v_access_secret_id is null then raise exception 'X_CREDENTIAL_NOT_CONFIGURED' using errcode = 'P0001'; end if;
  begin
    select ds.decrypted_secret into v_access_token
    from vault.decrypted_secrets ds where ds.id = v_access_secret_id;
  exception when others then
    raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
  end;
  if not found or nullif(v_access_token, '') is null then
    raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
  end if;
  social_account_id := v_account.id;
  brand_id := v_account.brand_id;
  platform_user_id := v_account.platform_user_id;
  access_token := v_access_token;
  return next;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'X_CREDENTIAL_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

revoke all on function public.record_v2_content_snapshot(uuid, uuid, jsonb),
  public.x_v2_require_plan_before_start(),
  public.x_v2_attempt_resumable(uuid),
  public.list_resumable_v2_attempts(integer),
  public.read_x_publish_credential_for_resume_v2(uuid, uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.record_v2_content_snapshot(uuid, uuid, jsonb),
  public.list_resumable_v2_attempts(integer),
  public.read_x_publish_credential_for_resume_v2(uuid, uuid, text, text)
to service_role;

commit;
