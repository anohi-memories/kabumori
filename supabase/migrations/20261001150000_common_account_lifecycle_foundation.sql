-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is
-- mandatory before any apply; apply as a single reviewed file (never db push).
-- Common account v1, Phase 1: additive lifecycle foundation.
--
-- What this adds (nothing existing is renamed, dropped, rewritten or re-granted):
--   * public.common_accounts       one row per auth.users row: the shared account's
--                                  application state (active / deleting / locked)
--   * public.service_entitlements  explicit per-service registration
--                                  ('kabumori', 'x_autopost')
--   * private.account_lifecycle_operations  durable deletion intent / saga record
--   * private.account_lifecycle_settings    one row: the Auth-delete guard mode
--   * the RPC boundary that is the only writer of the above
--
-- Unchanged on purpose: public.profiles stays the Kabumori root,
-- brand_memberships stays the X workspace authorization, every existing RLS
-- policy and RPC keeps its behaviour. Nothing reads the new tables yet.
--
-- Production shape relied on (read-only inventory 2026-10-01):
--   * profiles.id -> auth.users CASCADE; every Kabumori user table -> profiles CASCADE
--   * brand_memberships.user_id and social_account_oauth_states.initiated_by_user_id
--     -> auth.users CASCADE; brands / social_accounts hold no reference to auth.users
--   * the self-service X workspace id is social_mobile_account_deletion_workspace(user_id)
--
-- Lifecycle invariants (docs/common-account/phase1-lifecycle-foundation.md):
--   I1 One serialization point per person: every lifecycle RPC first locks the
--      person's auth.users row (KEY SHARE; finalize: FOR UPDATE) and then the
--      common_accounts row FOR UPDATE, before it reads anything else.
--   I2 A service can be started only while the account is 'active'. Once
--      whole-account deletion has begun ('deleting'), every start fails closed.
--   I3 Service-only deletion ends one entitlement and never touches the login
--      or the other service.
--   I4 The login (auth.users) is deleted only by finalize, in the same
--      transaction that holds the auth.users row lock and the common_accounts
--      lock, and only when every entitlement is 'ended' and no service
--      footprint, admin membership or foreign workspace remains. External
--      steps (X revoke, Vault purge, Apple revoke) are saga steps recorded as
--      checkpoints; they are never pretended to be atomic with the database.
--   I5 Anything unknown fails closed: admin accounts, shared or internal
--      workspaces, service data without an entitlement, entitlement states
--      that are neither active, deleting nor ended.
--   I6 All lifecycle RPCs require READ COMMITTED, so the state read after a
--      lock wait is the committed state.
--
-- Lock order (outermost first): auth.users row -> common_accounts row ->
-- entitlement / operation rows -> service rows. This is the direction a login
-- delete cascades in, so a lifecycle call and a legacy hard delete of the same
-- person queue behind each other instead of deadlocking.
--
-- Auth-delete guard: a BEFORE DELETE trigger on common_accounts (reached by
-- the cascade from auth.users). Mode 'shadow' (the default installed here)
-- allows every delete, so existing deletion routes behave exactly as before.
-- Mode 'enforce' refuses any login deletion that finalize did not authorize.
-- Switching the mode is a separate, later, reviewed step.

begin;

do $$
declare
  v_name text;
begin
  if to_regclass('public.common_accounts') is not null
     or to_regclass('public.service_entitlements') is not null
     or to_regclass('private.account_lifecycle_operations') is not null
     or to_regclass('private.account_lifecycle_settings') is not null then
    raise exception 'COMMON_ACCOUNT_FOUNDATION_ALREADY_APPLIED';
  end if;
  if to_regnamespace('private') is null then
    raise exception 'COMMON_ACCOUNT_PREFLIGHT_MISSING_SCHEMA:private';
  end if;
  foreach v_name in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = v_name) then
      raise exception 'COMMON_ACCOUNT_PREFLIGHT_MISSING_ROLE:%', v_name;
    end if;
  end loop;
  foreach v_name in array array[
    'auth.users', 'auth.identities',
    'public.profiles', 'public.admin_users',
    'public.tracked_stocks', 'public.alert_settings', 'public.alert_category_settings',
    'public.notifications', 'public.device_push_tokens', 'public.personalized_reports',
    'public.brands', 'public.brand_memberships', 'public.social_accounts',
    'public.social_account_oauth_states', 'public.social_mobile_account_deletions'
  ] loop
    if to_regclass(v_name) is null then
      raise exception 'COMMON_ACCOUNT_PREFLIGHT_MISSING_TABLE:%', v_name;
    end if;
  end loop;
  foreach v_name in array array[
    'auth.identities.user_id', 'auth.identities.provider',
    'public.profiles.created_at',
    'public.brands.code_profile_key',
    'public.brand_memberships.role', 'public.brand_memberships.created_at',
    'public.social_accounts.connection_status',
    'public.social_account_oauth_states.initiated_by_user_id',
    'public.social_mobile_account_deletions.workspace_id'
  ] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = split_part(v_name, '.', 1)
         and table_name = split_part(v_name, '.', 2)
         and column_name = split_part(v_name, '.', 3)
    ) then
      raise exception 'COMMON_ACCOUNT_PREFLIGHT_MISSING_COLUMN:%', v_name;
    end if;
  end loop;
  if to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or to_regprocedure('public.social_mobile_account_deletion_subject(uuid)') is null then
    raise exception 'COMMON_ACCOUNT_PREFLIGHT_MISSING_FUNCTION:social_mobile_account_deletion_workspace/subject';
  end if;
  -- Kabumori withdrawal deletes the profiles row and relies on the cascade.
  if not exists (
    select 1 from pg_constraint c
     where c.contype = 'f' and c.conrelid = 'public.profiles'::regclass
       and c.confrelid = 'auth.users'::regclass and c.confdeltype = 'c'
  ) then
    raise exception 'COMMON_ACCOUNT_PREFLIGHT_PROFILES_NOT_CASCADE_FROM_AUTH';
  end if;
  if exists (
    select 1 from pg_constraint c
     where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and c.confdeltype <> 'c'
  ) then
    raise exception 'COMMON_ACCOUNT_PREFLIGHT_PROFILES_CHILD_NOT_CASCADE';
  end if;
  -- finalize serializes with workspace creation through these two references.
  if not exists (
    select 1 from pg_constraint c
     where c.contype = 'f' and c.conrelid = 'public.brand_memberships'::regclass
       and c.confrelid = 'auth.users'::regclass
  ) or not exists (
    select 1 from pg_constraint c
     where c.contype = 'f' and c.conrelid = 'public.social_account_oauth_states'::regclass
       and c.confrelid = 'auth.users'::regclass
  ) then
    raise exception 'COMMON_ACCOUNT_PREFLIGHT_X_ROWS_NOT_BOUND_TO_AUTH';
  end if;
end;
$$;

-- 1. Tables ------------------------------------------------------------------

create table public.common_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'deleting', 'locked')),
  -- Incremented on every account or entitlement state change. A deletion is
  -- begun against the version the user confirmed.
  lifecycle_version bigint not null default 1 check (lifecycle_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.service_entitlements (
  user_id uuid not null references public.common_accounts (user_id) on delete cascade,
  service_key text not null check (service_key in ('kabumori', 'x_autopost')),
  -- 'provisioning' and 'suspended' are reserved: no RPC here produces them,
  -- and every gate treats them as "service still present" (fail closed).
  status text not null check (status in ('provisioning', 'active', 'suspended', 'deleting', 'ended')),
  source text not null check (source in ('self_service', 'legacy_backfill', 'operator')),
  -- Why a backfilled row exists; lets weak legacy candidates be reviewed later.
  legacy_evidence text check (legacy_evidence in (
    'kabumori_activity', 'kabumori_profile_only', 'x_identity_verified', 'x_workspace_pending')),
  activated_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, service_key),
  check ((source = 'legacy_backfill') = (legacy_evidence is not null)),
  check ((status = 'ended') = (ended_at is not null)),
  check (status = 'provisioning' or activated_at is not null)
);

-- Durable deletion intent. Holds the raw user id only while the person still
-- exists; it is cleared when the login is removed (subject hash remains).
create table private.account_lifecycle_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  subject_sha256 text not null check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  operation_type text not null check (operation_type in ('service_deletion', 'account_deletion')),
  service_key text check (service_key in ('kabumori', 'x_autopost')),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'aborted')),
  current_step text not null default 'cleanup' check (current_step in ('cleanup', 'auth_delete', 'finished')),
  apple_revoke_required boolean not null default false,
  apple_revoked_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((operation_type = 'service_deletion') = (service_key is not null)),
  check ((status = 'in_progress') = (finished_at is null)),
  check ((status = 'in_progress') = (current_step <> 'finished')),
  check (status <> 'in_progress' or user_id is not null),
  check (current_step <> 'auth_delete' or operation_type = 'account_deletion')
);
create unique index account_lifecycle_operations_one_in_progress
  on private.account_lifecycle_operations (user_id, operation_type, coalesce(service_key, ''))
  where status = 'in_progress';

create table private.account_lifecycle_settings (
  id boolean primary key default true check (id),
  auth_delete_guard text not null default 'shadow' check (auth_delete_guard in ('shadow', 'enforce')),
  updated_at timestamptz not null default now()
);
insert into private.account_lifecycle_settings default values;

-- 2. RLS / grants on the new tables --------------------------------------------
-- Clients read their own rows; every write goes through the RPCs below.

alter table public.common_accounts enable row level security;
alter table public.service_entitlements enable row level security;
alter table private.account_lifecycle_operations enable row level security;
alter table private.account_lifecycle_settings enable row level security;

revoke all on table public.common_accounts from public, anon, authenticated, service_role;
revoke all on table public.service_entitlements from public, anon, authenticated, service_role;
revoke all on table private.account_lifecycle_operations from public, anon, authenticated, service_role;
revoke all on table private.account_lifecycle_settings from public, anon, authenticated, service_role;

grant select (user_id, status, lifecycle_version, created_at, updated_at)
  on table public.common_accounts to authenticated;
grant select (user_id, service_key, status, activated_at, ended_at, updated_at)
  on table public.service_entitlements to authenticated;

create policy common_accounts_select_own
  on public.common_accounts
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy service_entitlements_select_own
  on public.service_entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- 3. Internal helpers (schema private: not exposed through the Data API) -------

-- I1 + I6: the serialization point. Returns the locked row; a null user_id
-- means "no login or no common account" (only when p_create is false).
-- p_exclusive is for finalize: nothing may reference the login while it decides.
create function private.account_lifecycle_lock(p_user_id uuid, p_create boolean, p_exclusive boolean default false)
returns public.common_accounts language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.common_accounts;
begin
  if p_user_id is null then raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED'; end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ACCOUNT_LIFECYCLE_REQUIRES_READ_COMMITTED';
  end if;
  if p_exclusive then
    perform 1 from auth.users where id = p_user_id for update;
  else
    perform 1 from auth.users where id = p_user_id for key share;
  end if;
  if not found then
    -- The login no longer exists (a still-valid token of a deleted person).
    if p_create then
      raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501';
    end if;
    return v_row;
  end if;
  if p_create then
    insert into public.common_accounts (user_id) values (p_user_id) on conflict (user_id) do nothing;
  end if;
  select * into v_row from public.common_accounts where user_id = p_user_id for update;
  return v_row;
end;
$$;

create function private.account_lifecycle_bump(p_user_id uuid)
returns bigint language sql volatile security definer set search_path = ''
as $$
  update public.common_accounts
     set lifecycle_version = lifecycle_version + 1, updated_at = now()
   where user_id = p_user_id
  returning lifecycle_version
$$;

-- What each service still holds for this person, read from the service's own
-- tables. x_foreign: a workspace that is not the person's own self-service one.
create function private.account_lifecycle_footprint(p_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_workspace text := public.social_mobile_account_deletion_workspace(p_user_id);
begin
  return jsonb_build_object(
    'kabumori', exists (select 1 from public.profiles where id = p_user_id),
    'x_autopost',
      exists (select 1 from public.brands where id = v_workspace)
      or exists (select 1 from public.brand_memberships where user_id = p_user_id and brand_id = v_workspace)
      or exists (select 1 from public.social_accounts where brand_id = v_workspace)
      or exists (select 1 from public.social_account_oauth_states
                  where brand_id = v_workspace or initiated_by_user_id = p_user_id)
      or exists (select 1 from public.social_mobile_account_deletions
                  where user_id = p_user_id or workspace_id = v_workspace),
    'x_foreign',
      exists (select 1 from public.brand_memberships where user_id = p_user_id and brand_id <> v_workspace)
      or exists (select 1 from public.brand_memberships where brand_id = v_workspace and user_id <> p_user_id)
      or exists (select 1 from public.brands
                  where id = v_workspace and code_profile_key is distinct from 'social_mobile_user_v1'),
    'admin', exists (select 1 from public.admin_users where user_id = p_user_id));
end;
$$;

-- I5: why whole-account deletion may not begin or finish. Empty = no blocker.
create function private.account_lifecycle_deletion_blockers(p_user_id uuid, p_account_status text)
returns text[] language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_footprint jsonb := private.account_lifecycle_footprint(p_user_id);
  v_reasons text[] := '{}';
begin
  if (v_footprint ->> 'admin')::boolean then
    v_reasons := v_reasons || 'ADMIN_ACCOUNT'::text;
  end if;
  if p_account_status = 'locked' then
    v_reasons := v_reasons || 'ACCOUNT_LOCKED'::text;
  end if;
  if (v_footprint ->> 'x_foreign')::boolean then
    v_reasons := v_reasons || 'X_WORKSPACE_NOT_SELF_SERVICE'::text;
  end if;
  if ((v_footprint ->> 'kabumori')::boolean and not exists (
        select 1 from public.service_entitlements
         where user_id = p_user_id and service_key = 'kabumori' and status <> 'ended'))
     or ((v_footprint ->> 'x_autopost')::boolean and not exists (
        select 1 from public.service_entitlements
         where user_id = p_user_id and service_key = 'x_autopost' and status <> 'ended')) then
    v_reasons := v_reasons || 'UNREGISTERED_SERVICE_FOOTPRINT'::text;
  end if;
  if exists (
    select 1 from public.service_entitlements
     where user_id = p_user_id and status not in ('active', 'deleting', 'ended')
  ) then
    v_reasons := v_reasons || 'SERVICE_NOT_DELETABLE'::text;
  end if;
  return v_reasons;
end;
$$;

-- I2: register (or re-register) one service for the caller.
create function private.account_lifecycle_start_service(p_user_id uuid, p_service_key text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_entitlement public.service_entitlements;
  v_started boolean := false;
begin
  if p_user_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, true);
  if v_account.status = 'deleting' then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS');
  end if;
  if v_account.status <> 'active' then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_LOCKED');
  end if;
  select * into v_entitlement from public.service_entitlements
   where user_id = p_user_id and service_key = p_service_key for update;
  if not found then
    insert into public.service_entitlements (user_id, service_key, status, source, activated_at)
    values (p_user_id, p_service_key, 'active', 'self_service', now());
    v_started := true;
  elsif v_entitlement.status = 'ended' then
    update public.service_entitlements
       set status = 'active', source = 'self_service', legacy_evidence = null,
           activated_at = now(), ended_at = null, updated_at = now()
     where user_id = p_user_id and service_key = p_service_key;
    v_started := true;
  elsif v_entitlement.status <> 'active' then
    return jsonb_build_object('status', 'blocked', 'reason', case v_entitlement.status
      when 'deleting' then 'SERVICE_DELETION_IN_PROGRESS'
      when 'suspended' then 'SERVICE_SUSPENDED'
      else 'SERVICE_NOT_READY' end);
  end if;
  if v_started then
    perform private.account_lifecycle_bump(p_user_id);
  end if;
  -- The Kabumori service root is created with its entitlement, atomically.
  if p_service_key = 'kabumori' then
    insert into public.profiles (id) values (p_user_id) on conflict (id) do nothing;
  end if;
  return jsonb_build_object('status', 'active', 'service', p_service_key, 'started', v_started);
end;
$$;

-- Auth-delete guard (reached by the cascade from auth.users). Authorized only
-- by an account deletion that finalize moved to step 'auth_delete' in this same
-- transaction; nothing else can make that step visible. 23503 on purpose: the
-- existing X deletion maps a blocked login delete to an operator state.
create function private.account_lifecycle_guard_account_delete()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_mode text;
begin
  if not exists (
    select 1 from private.account_lifecycle_operations o
     where o.user_id = old.user_id and o.operation_type = 'account_deletion'
       and o.status = 'in_progress' and o.current_step = 'auth_delete'
  ) then
    select s.auth_delete_guard into v_mode from private.account_lifecycle_settings s;
    if coalesce(v_mode, 'enforce') <> 'shadow' then
      raise exception 'COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED' using errcode = '23503';
    end if;
    update private.account_lifecycle_operations
       set status = 'aborted', current_step = 'finished', last_error_code = 'ACCOUNT_REMOVED_EXTERNALLY',
           finished_at = now(), updated_at = now()
     where user_id = old.user_id and status = 'in_progress';
  end if;
  update private.account_lifecycle_operations
     set user_id = null, updated_at = now()
   where user_id = old.user_id and status <> 'in_progress';
  return old;
end;
$$;

create trigger account_lifecycle_guard_account_delete
  before delete on public.common_accounts
  for each row execute function private.account_lifecycle_guard_account_delete();

-- 4. Client RPCs (authenticated; the person is always auth.uid()) -----------------

create function public.start_kabumori_service()
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_start_service((select auth.uid()), 'kabumori') $$;

create function public.start_x_autopost_service()
returns jsonb language sql volatile security definer set search_path = ''
as $$ select private.account_lifecycle_start_service((select auth.uid()), 'x_autopost') $$;

-- 5. Backend RPCs (service_role; p_user_id is the id the caller verified from
--    the person's own token, never a value the client supplied) ------------------

-- Read model for a confirmation screen. Takes no lock: it is advice, and
-- begin_common_account_deletion re-evaluates everything under the lock.
create function public.common_account_deletion_eligibility(p_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation uuid;
begin
  if p_user_id is null then raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED'; end if;
  select * into v_account from public.common_accounts where user_id = p_user_id;
  select o.id into v_operation from private.account_lifecycle_operations o
   where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress';
  return jsonb_build_object(
    'account_status', coalesce(v_account.status, 'none'),
    'lifecycle_version', coalesce(v_account.lifecycle_version, 1),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('service_key', e.service_key, 'status', e.status) order by e.service_key)
        from public.service_entitlements e where e.user_id = p_user_id), '[]'::jsonb),
    'blockers', to_jsonb(private.account_lifecycle_deletion_blockers(p_user_id, coalesce(v_account.status, 'none'))),
    'apple_revoke_required', exists (
      select 1 from auth.identities i where i.user_id = p_user_id and i.provider = 'apple'),
    'operation_id', v_operation);
end;
$$;

-- I3: mark one service as being deleted. Its start RPC fails closed from here.
create function public.begin_service_deletion(p_user_id uuid, p_service_key text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_entitlement public.service_entitlements;
  v_footprint jsonb;
  v_operation uuid;
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, true);
  if v_account.status = 'locked' then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_LOCKED');
  end if;
  v_footprint := private.account_lifecycle_footprint(p_user_id);
  select * into v_entitlement from public.service_entitlements
   where user_id = p_user_id and service_key = p_service_key for update;
  if not found then
    if (v_footprint ->> p_service_key)::boolean then
      return jsonb_build_object('status', 'blocked', 'reason', 'UNREGISTERED_SERVICE_FOOTPRINT');
    end if;
    return jsonb_build_object('status', 'not_registered');
  end if;
  if v_entitlement.status = 'ended' then
    return jsonb_build_object('status', 'already_ended');
  end if;
  if v_entitlement.status = 'deleting' then
    select o.id into v_operation from private.account_lifecycle_operations o
     where o.user_id = p_user_id and o.operation_type = 'service_deletion'
       and o.service_key = p_service_key and o.status = 'in_progress';
    if not found then
      return jsonb_build_object('status', 'blocked', 'reason', 'LIFECYCLE_STATE_INCONSISTENT');
    end if;
    return jsonb_build_object('status', 'in_progress', 'operation_id', v_operation);
  end if;
  if v_entitlement.status <> 'active' then
    return jsonb_build_object('status', 'blocked', 'reason', 'SERVICE_NOT_DELETABLE');
  end if;
  if p_service_key = 'x_autopost' and (v_footprint ->> 'x_foreign')::boolean then
    return jsonb_build_object('status', 'blocked', 'reason', 'X_WORKSPACE_NOT_SELF_SERVICE');
  end if;
  update public.service_entitlements set status = 'deleting', updated_at = now()
   where user_id = p_user_id and service_key = p_service_key;
  perform private.account_lifecycle_bump(p_user_id);
  insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type, service_key)
  values (p_user_id, public.social_mobile_account_deletion_subject(p_user_id), 'service_deletion', p_service_key)
  returning id into v_operation;
  return jsonb_build_object('status', 'started', 'operation_id', v_operation);
end;
$$;

-- I3: the service's own cleanup is done; verify it and end the entitlement.
create function public.finish_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_footprint jsonb;
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id
     and operation_type = 'service_deletion' and service_key = p_service_key
   for update;
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.status = 'completed' then
    return jsonb_build_object('status', 'ended');
  end if;
  if v_operation.status = 'aborted' then
    return jsonb_build_object('status', 'aborted');
  end if;
  if not exists (
    select 1 from public.service_entitlements
     where user_id = p_user_id and service_key = p_service_key and status = 'deleting'
  ) then
    return jsonb_build_object('status', 'blocked', 'reason', 'LIFECYCLE_STATE_INCONSISTENT');
  end if;
  v_footprint := private.account_lifecycle_footprint(p_user_id);
  if (v_footprint ->> p_service_key)::boolean
     or (p_service_key = 'x_autopost' and (v_footprint ->> 'x_foreign')::boolean) then
    update private.account_lifecycle_operations
       set last_error_code = 'SERVICE_FOOTPRINT_REMAINS', updated_at = now()
     where id = p_operation_id;
    return jsonb_build_object('status', 'not_ready', 'reason', 'SERVICE_FOOTPRINT_REMAINS');
  end if;
  update public.service_entitlements
     set status = 'ended', ended_at = now(), updated_at = now()
   where user_id = p_user_id and service_key = p_service_key;
  perform private.account_lifecycle_bump(p_user_id);
  update private.account_lifecycle_operations
     set status = 'completed', current_step = 'finished', last_error_code = null,
         finished_at = now(), updated_at = now()
   where id = p_operation_id;
  return jsonb_build_object('status', 'ended');
end;
$$;

-- The service's deletion was cancelled before its data was removed.
create function public.abort_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id
     and operation_type = 'service_deletion' and service_key = p_service_key
   for update;
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.status = 'aborted' then
    return jsonb_build_object('status', 'aborted');
  end if;
  if v_operation.status = 'completed' then
    return jsonb_build_object('status', 'blocked', 'reason', 'SERVICE_ALREADY_ENDED');
  end if;
  update public.service_entitlements set status = 'active', updated_at = now()
   where user_id = p_user_id and service_key = p_service_key and status = 'deleting';
  perform private.account_lifecycle_bump(p_user_id);
  update private.account_lifecycle_operations
     set status = 'aborted', current_step = 'finished', finished_at = now(), updated_at = now()
   where id = p_operation_id;
  return jsonb_build_object('status', 'aborted');
end;
$$;

-- I3 for Kabumori: the service has no external step, so withdrawal is one
-- transaction. Removing the profiles row removes every Kabumori user row by
-- cascade; the login, the X entitlement and the X workspace are not touched.
create function public.withdraw_kabumori_service(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_begin jsonb;
begin
  v_begin := public.begin_service_deletion(p_user_id, 'kabumori');
  if v_begin ->> 'status' not in ('started', 'in_progress') then
    return v_begin;
  end if;
  delete from public.profiles where id = p_user_id;
  return public.finish_service_deletion(p_user_id, 'kabumori', (v_begin ->> 'operation_id')::uuid);
end;
$$;

-- I2 + I5: record the intent to delete the whole account. From the commit of
-- this call no service can be started for this person.
create function public.begin_common_account_deletion(p_user_id uuid, p_expected_lifecycle_version bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_version bigint;
  v_blockers text[];
  v_operation uuid;
  v_apple boolean;
begin
  -- A login without a row yet is a fresh account at version 1, which is also
  -- what the eligibility read model reports for it.
  v_account := private.account_lifecycle_lock(p_user_id, true);
  v_version := v_account.lifecycle_version;
  if v_account.status = 'deleting' then
    select o.id into v_operation from private.account_lifecycle_operations o
     where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress';
    if not found then
      return jsonb_build_object('status', 'blocked', 'reasons', jsonb_build_array('LIFECYCLE_STATE_INCONSISTENT'));
    end if;
    return jsonb_build_object('status', 'in_progress', 'operation_id', v_operation, 'lifecycle_version', v_version);
  end if;
  -- The person confirmed deletion against a previewed state; anything that
  -- changed since (for example a service started meanwhile) needs a new preview.
  if p_expected_lifecycle_version is distinct from v_version then
    return jsonb_build_object('status', 'lifecycle_changed', 'lifecycle_version', v_version);
  end if;
  v_blockers := private.account_lifecycle_deletion_blockers(p_user_id, v_account.status);
  if cardinality(v_blockers) > 0 then
    return jsonb_build_object('status', 'blocked', 'reasons', to_jsonb(v_blockers));
  end if;
  update public.common_accounts
     set status = 'deleting', lifecycle_version = lifecycle_version + 1, updated_at = now()
   where user_id = p_user_id
  returning lifecycle_version into v_version;
  v_apple := exists (select 1 from auth.identities i where i.user_id = p_user_id and i.provider = 'apple');
  insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type, apple_revoke_required)
  values (p_user_id, public.social_mobile_account_deletion_subject(p_user_id), 'account_deletion', v_apple)
  returning id into v_operation;
  return jsonb_build_object(
    'status', 'started', 'operation_id', v_operation, 'lifecycle_version', v_version,
    'apple_revoke_required', v_apple,
    'services_to_end', coalesce((
      select jsonb_agg(e.service_key order by e.service_key)
        from public.service_entitlements e where e.user_id = p_user_id and e.status <> 'ended'), '[]'::jsonb));
end;
$$;

-- Saga checkpoint: the Apple grant was revoked by the caller (external step).
create function public.mark_common_account_apple_revoked(p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
begin
  v_account := private.account_lifecycle_lock(p_user_id, false);
  update private.account_lifecycle_operations
     set apple_revoked_at = coalesce(apple_revoked_at, now()), updated_at = now()
   where id = p_operation_id and user_id = p_user_id
     and operation_type = 'account_deletion' and status = 'in_progress';
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- The person (or an operator) cancelled before the login was removed. Services
-- that already ended stay ended; the account can start services again.
create function public.abort_common_account_deletion(p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  v_account := private.account_lifecycle_lock(p_user_id, false);
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'account_deletion'
   for update;
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.status = 'aborted' then
    return jsonb_build_object('status', 'aborted');
  end if;
  if v_operation.status <> 'in_progress' or v_account.status <> 'deleting' then
    return jsonb_build_object('status', 'blocked', 'reason', 'LIFECYCLE_STATE_INCONSISTENT');
  end if;
  update public.common_accounts
     set status = 'active', lifecycle_version = lifecycle_version + 1, updated_at = now()
   where user_id = p_user_id;
  update private.account_lifecycle_operations
     set status = 'aborted', current_step = 'finished', finished_at = now(), updated_at = now()
   where id = p_operation_id;
  return jsonb_build_object('status', 'aborted');
end;
$$;

-- I4: the only place the login is removed. Everything is re-verified under the
-- exclusive auth.users row lock and the common_accounts lock, then the row is
-- deleted in this same transaction. A workspace or profile being created
-- concurrently either committed before the lock (seen here: blocked) or needs
-- the auth.users row (waits, then fails on its own foreign key).
create function public.finalize_common_account_deletion(p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_remaining jsonb;
  v_blockers text[];
  v_blocked boolean := false;
begin
  if p_user_id is null or p_operation_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false, true);
  if v_account.user_id is null then
    -- Retry after success: the operation survives with its subject hash only.
    if exists (
      select 1 from private.account_lifecycle_operations o
       where o.id = p_operation_id and o.operation_type = 'account_deletion' and o.status = 'completed'
         and o.subject_sha256 = public.social_mobile_account_deletion_subject(p_user_id)
    ) then
      return jsonb_build_object('status', 'completed');
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'account_deletion'
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.status <> 'in_progress' or v_account.status <> 'deleting' then
    return jsonb_build_object('status', 'not_ready', 'reason', 'ACCOUNT_DELETION_NOT_IN_PROGRESS');
  end if;

  select jsonb_agg(e.service_key order by e.service_key) into v_remaining
    from public.service_entitlements e where e.user_id = p_user_id and e.status <> 'ended';
  if v_remaining is not null then
    return jsonb_build_object('status', 'not_ready', 'reason', 'SERVICES_REMAIN', 'services', v_remaining);
  end if;
  -- With every entitlement ended, any remaining service row, admin membership
  -- or foreign workspace is a blocker (UNREGISTERED_SERVICE_FOOTPRINT, ...).
  v_blockers := private.account_lifecycle_deletion_blockers(p_user_id, 'deleting');
  if cardinality(v_blockers) > 0 then
    return jsonb_build_object('status', 'blocked', 'reasons', to_jsonb(v_blockers));
  end if;
  if (v_operation.apple_revoke_required
      or exists (select 1 from auth.identities i where i.user_id = p_user_id and i.provider = 'apple'))
     and v_operation.apple_revoked_at is null then
    return jsonb_build_object('status', 'not_ready', 'reason', 'APPLE_REVOCATION_REQUIRED');
  end if;

  update private.account_lifecycle_operations
     set current_step = 'auth_delete', updated_at = now()
   where id = p_operation_id;
  begin
    delete from auth.users where id = p_user_id;
  exception when foreign_key_violation then
    v_blocked := true;
  end;
  if v_blocked then
    update private.account_lifecycle_operations
       set current_step = 'cleanup', last_error_code = 'AUTH_DELETE_BLOCKED', updated_at = now()
     where id = p_operation_id;
    return jsonb_build_object('status', 'not_ready', 'reason', 'AUTH_DELETE_BLOCKED');
  end if;
  update private.account_lifecycle_operations
     set status = 'completed', current_step = 'finished', user_id = null, last_error_code = null,
         finished_at = now(), updated_at = now()
   where id = p_operation_id;
  return jsonb_build_object('status', 'completed');
end;
$$;

-- 6. Shadow backfill candidate (NOT executed by this migration) -----------------
-- One row per login with what the legacy data says about each service. People
-- are never merged: e-mail is not looked at, one common account per auth.users row.
create view private.account_lifecycle_backfill_plan as
with kabumori as (
  select p.id as user_id, p.created_at,
         (exists (select 1 from public.tracked_stocks t where t.user_id = p.id)
          or exists (select 1 from public.alert_settings t where t.user_id = p.id)
          or exists (select 1 from public.alert_category_settings t where t.user_id = p.id)
          or exists (select 1 from public.notifications t where t.user_id = p.id)
          or exists (select 1 from public.device_push_tokens t where t.user_id = p.id)
          or exists (select 1 from public.personalized_reports t where t.user_id = p.id)) as has_activity
    from public.profiles p
),
x_owner as (
  -- Consumer registration = sole owner of the person's own self-service
  -- workspace. Internal or shared workspaces and admin rights are not consumer use.
  select m.user_id, m.created_at,
         exists (select 1 from public.social_accounts a
                  where a.brand_id = b.id and a.connection_status = 'identity_verified') as verified
    from public.brand_memberships m
    join public.brands b on b.id = m.brand_id
   where m.role = 'owner'
     and b.code_profile_key = 'social_mobile_user_v1'
     and b.id = public.social_mobile_account_deletion_workspace(m.user_id)
     and not exists (select 1 from public.brand_memberships o where o.brand_id = b.id and o.user_id <> m.user_id)
)
select u.id as user_id,
       c.user_id is null as needs_account,
       coalesce(c.status, 'active') as account_status,
       k.user_id is not null as kabumori_candidate,
       coalesce(k.has_activity, false) as kabumori_activity,
       k.created_at as kabumori_since,
       ek.user_id is not null as kabumori_exists,
       x.user_id is not null as x_candidate,
       coalesce(x.verified, false) as x_verified,
       x.created_at as x_since,
       ex.user_id is not null as x_exists
  from auth.users u
  left join public.common_accounts c on c.user_id = u.id
  left join kabumori k on k.user_id = u.id
  left join x_owner x on x.user_id = u.id
  left join public.service_entitlements ek on ek.user_id = u.id and ek.service_key = 'kabumori'
  left join public.service_entitlements ex on ex.user_id = u.id and ex.service_key = 'x_autopost';

revoke all on table private.account_lifecycle_backfill_plan from public, anon, authenticated, service_role;

-- p_apply = false (default) only counts. p_apply = true inserts the missing
-- rows; it is idempotent and never changes an existing entitlement. Accounts
-- that are not 'active' receive no entitlement.
create function private.account_lifecycle_backfill(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_report jsonb;
  v_accounts bigint := 0;
  v_kabumori bigint := 0;
  v_x bigint := 0;
begin
  select jsonb_build_object(
    'auth_users', count(*),
    'common_accounts_to_create', count(*) filter (where needs_account),
    'kabumori_candidates', count(*) filter (where kabumori_candidate),
    'kabumori_with_activity', count(*) filter (where kabumori_candidate and kabumori_activity),
    'kabumori_profile_only', count(*) filter (where kabumori_candidate and not kabumori_activity),
    'kabumori_to_create', count(*) filter (
      where kabumori_candidate and not kabumori_exists and account_status = 'active'),
    'x_autopost_candidates', count(*) filter (where x_candidate),
    'x_autopost_identity_verified', count(*) filter (where x_candidate and x_verified),
    'x_autopost_workspace_pending', count(*) filter (where x_candidate and not x_verified),
    'x_autopost_to_create', count(*) filter (
      where x_candidate and not x_exists and account_status = 'active'),
    'auth_only', count(*) filter (where not kabumori_candidate and not x_candidate),
    'skipped_account_not_active', count(*) filter (
      where account_status <> 'active'
        and ((kabumori_candidate and not kabumori_exists) or (x_candidate and not x_exists)))
  ) into v_report from private.account_lifecycle_backfill_plan;

  v_report := v_report || jsonb_build_object(
    'excluded_admin_users', (select count(*) from public.admin_users),
    'excluded_non_self_service_memberships', (
      select count(*) from public.brand_memberships m
        join public.brands b on b.id = m.brand_id
       where b.code_profile_key is distinct from 'social_mobile_user_v1'
          or b.id <> public.social_mobile_account_deletion_workspace(m.user_id)
          or m.role <> 'owner'
          or exists (select 1 from public.brand_memberships o where o.brand_id = b.id and o.user_id <> m.user_id)));

  if coalesce(p_apply, false) then
    with plan as materialized (
      select * from private.account_lifecycle_backfill_plan
    ),
    accounts as (
      insert into public.common_accounts (user_id)
      select user_id from plan where needs_account
      on conflict (user_id) do nothing
      returning user_id
    ),
    kabumori as (
      insert into public.service_entitlements (user_id, service_key, status, source, legacy_evidence, activated_at)
      select user_id, 'kabumori', 'active', 'legacy_backfill',
             case when kabumori_activity then 'kabumori_activity' else 'kabumori_profile_only' end,
             coalesce(kabumori_since, now())
        from plan where kabumori_candidate and not kabumori_exists and account_status = 'active'
      on conflict (user_id, service_key) do nothing
      returning user_id
    ),
    x_autopost as (
      insert into public.service_entitlements (user_id, service_key, status, source, legacy_evidence, activated_at)
      select user_id, 'x_autopost', 'active', 'legacy_backfill',
             case when x_verified then 'x_identity_verified' else 'x_workspace_pending' end,
             coalesce(x_since, now())
        from plan where x_candidate and not x_exists and account_status = 'active'
      on conflict (user_id, service_key) do nothing
      returning user_id
    ),
    bumped as (
      -- Accounts that already existed and gained an entitlement.
      update public.common_accounts c
         set lifecycle_version = c.lifecycle_version + 1, updated_at = now()
       where c.user_id in (select user_id from kabumori union select user_id from x_autopost)
      returning 1
    )
    select (select count(*) from accounts), (select count(*) from kabumori), (select count(*) from x_autopost)
      into v_accounts, v_kabumori, v_x
      from (select count(*) from bumped) b;
  end if;

  return v_report || jsonb_build_object(
    'applied', coalesce(p_apply, false),
    'created_common_accounts', v_accounts,
    'created_kabumori', v_kabumori,
    'created_x_autopost', v_x);
end;
$$;

-- 7. Function privileges ---------------------------------------------------------
-- Nothing is executable by PUBLIC or anon. Internal helpers are executable by
-- nobody but their owner; they are reached only through the RPCs.

revoke all on function private.account_lifecycle_lock(uuid, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_bump(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_footprint(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_deletion_blockers(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_start_service(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_guard_account_delete() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_backfill(boolean) from public, anon, authenticated, service_role;

revoke all on function public.start_kabumori_service() from public, anon, authenticated, service_role;
revoke all on function public.start_x_autopost_service() from public, anon, authenticated, service_role;
grant execute on function public.start_kabumori_service() to authenticated;
grant execute on function public.start_x_autopost_service() to authenticated;

revoke all on function public.common_account_deletion_eligibility(uuid) from public, anon, authenticated, service_role;
revoke all on function public.begin_service_deletion(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.finish_service_deletion(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.abort_service_deletion(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.withdraw_kabumori_service(uuid) from public, anon, authenticated, service_role;
revoke all on function public.begin_common_account_deletion(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.mark_common_account_apple_revoked(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.abort_common_account_deletion(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.finalize_common_account_deletion(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.common_account_deletion_eligibility(uuid) to service_role;
grant execute on function public.begin_service_deletion(uuid, text) to service_role;
grant execute on function public.finish_service_deletion(uuid, text, uuid) to service_role;
grant execute on function public.abort_service_deletion(uuid, text, uuid) to service_role;
grant execute on function public.withdraw_kabumori_service(uuid) to service_role;
grant execute on function public.begin_common_account_deletion(uuid, bigint) to service_role;
grant execute on function public.mark_common_account_apple_revoked(uuid, uuid) to service_role;
grant execute on function public.abort_common_account_deletion(uuid, uuid) to service_role;
grant execute on function public.finalize_common_account_deletion(uuid, uuid) to service_role;

commit;
