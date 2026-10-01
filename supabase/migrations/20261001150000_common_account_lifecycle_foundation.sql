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
--   * private.account_lifecycle_managed_checkpoints  which managed-service
--                                  cleanups an account deletion must attest
--   * private.account_lifecycle_settings    one row: guard mode, integration
--                                  state, requirement epoch
--   * the RPC boundary that is the only writer of the above
--
-- What this deliberately does NOT do: it never deletes a login. No statement
-- here writes to auth.users, Storage or Vault. The only existing service row it
-- ever writes is the Kabumori profile: created by the Kabumori start, removed
-- by Kabumori's own withdrawal. Whole-account deletion stops at the
-- durable state 'ready_for_managed_auth_delete'. Removing the login, Storage
-- objects, sessions and provider grants is the job of a later orchestrator
-- that uses the managed APIs; this file only gives it a contract to stand on.
--
-- Unchanged on purpose: public.profiles stays the Kabumori root,
-- brand_memberships stays the X workspace authorization, every existing RLS
-- policy and RPC keeps its behaviour. Nothing reads the new tables yet.
--
-- Lifecycle invariants (docs/common-account/phase1-lifecycle-foundation.md):
--   I1 One serialization point per person: every lifecycle RPC first locks the
--      person's auth.users row (KEY SHARE; the readiness check: FOR UPDATE) and
--      then the common_accounts row FOR UPDATE, before it reads anything else.
--   I2 A service can be started only while the account is 'active'. Once
--      whole-account deletion has begun ('deleting'), every start fails closed.
--   I3 Service-only deletion ends one entitlement and never touches the login
--      or the other service.
--   I4 An account deletion becomes 'ready_for_managed_auth_delete' only when,
--      under the locks, every entitlement is 'ended', no service row, admin
--      membership or foreign workspace remains, every required managed-service
--      checkpoint is recorded, and no managed ownership is visible. Ready is
--      not "deleted", and a recorded checkpoint is the orchestrator's
--      attestation, not something the database verified.
--   I5 Anything unknown fails closed: admin accounts, shared or internal
--      workspaces, service data without an entitlement, entitlement states
--      that are neither active, deleting nor ended, an unreadable Storage shape.
--   I6 All lifecycle RPCs require READ COMMITTED, so the state read after a
--      lock wait is the committed state.
--   I7 lifecycle_version changes with every account-state or entitlement
--      change, by trigger, whatever wrote it. 0 means "no account row yet".
--      An entitlement can never move to another person or another service.
--   I8 Readiness is a durable authorization bound to what it was decided
--      against: the person's lifecycle_version, the requirement_epoch (which
--      moves with every change of the checkpoint requirements or settings) and
--      the exact set of checkpoints that was required. It is valid only while
--      all three still match and a fresh evaluation still passes. Changes this
--      file can see also drop the operation back to 'cleanup' at once.
--   I9 The built-in checkpoints and their meaning are fixed: session_revocation
--      and storage_cleanup always, apple_revocation for a person with an Apple
--      identity. They cannot be changed or removed by ordinary maintenance,
--      and a registry that does not match them exactly makes nothing ready.
--
-- Lock order (outermost first): auth.users row -> common_accounts row ->
-- entitlement / operation rows -> service rows. This is the direction a login
-- delete cascades in, so a lifecycle call and a hard delete of the same person
-- queue behind each other instead of deadlocking.
--
-- Auth-delete guard: a BEFORE DELETE trigger on common_accounts (reached by
-- the cascade from auth.users). In Phase 1 it has one mode, 'shadow': every
-- delete is allowed, so existing deletion routes behave exactly as before. It
-- observes; it does NOT make them safe. There is no 'enforce' in Phase 1 and
-- no path on which this trigger authorizes a delete: it runs after other
-- cascades may already have removed admin and membership rows, so it cannot
-- rediscover blockers, and several things that must invalidate a readiness
-- (admin and workspace membership changes, a new Apple identity, Storage
-- uploads) are not wired to the lifecycle yet. A later phase that wires them
-- adds an enforcing mode that validates the durable authorization of I8.
-- Settings that are missing or not 'shadow' refuse every login delete.

begin;

do $$
declare
  v_name text;
  v_spec jsonb;
begin
  if to_regclass('public.common_accounts') is not null
     or to_regclass('public.service_entitlements') is not null
     or to_regclass('private.account_lifecycle_operations') is not null
     or to_regclass('private.account_lifecycle_managed_checkpoints') is not null
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
    'public.social_account_oauth_states', 'public.social_mobile_account_deletions',
    'storage.objects', 'storage.buckets'
  ] loop
    if to_regclass(v_name) is null then
      raise exception 'COMMON_ACCOUNT_PREFLIGHT_MISSING_TABLE:%', v_name;
    end if;
  end loop;

  -- Every column an invariant reads, with its exact type.
  for v_spec in select value from jsonb_array_elements('[
    {"t": "auth.users", "c": "id", "type": "uuid"},
    {"t": "auth.identities", "c": "user_id", "type": "uuid"},
    {"t": "auth.identities", "c": "provider", "type": "text"},
    {"t": "public.profiles", "c": "id", "type": "uuid"},
    {"t": "public.profiles", "c": "created_at", "type": "timestamp with time zone"},
    {"t": "public.admin_users", "c": "user_id", "type": "uuid"},
    {"t": "public.tracked_stocks", "c": "user_id", "type": "uuid"},
    {"t": "public.alert_settings", "c": "user_id", "type": "uuid"},
    {"t": "public.alert_category_settings", "c": "user_id", "type": "uuid"},
    {"t": "public.notifications", "c": "user_id", "type": "uuid"},
    {"t": "public.device_push_tokens", "c": "user_id", "type": "uuid"},
    {"t": "public.personalized_reports", "c": "user_id", "type": "uuid"},
    {"t": "public.brands", "c": "id", "type": "text"},
    {"t": "public.brands", "c": "code_profile_key", "type": "text"},
    {"t": "public.brand_memberships", "c": "brand_id", "type": "text"},
    {"t": "public.brand_memberships", "c": "user_id", "type": "uuid"},
    {"t": "public.brand_memberships", "c": "role", "type": "text"},
    {"t": "public.brand_memberships", "c": "created_at", "type": "timestamp with time zone"},
    {"t": "public.social_accounts", "c": "brand_id", "type": "text"},
    {"t": "public.social_accounts", "c": "connection_status", "type": "text"},
    {"t": "public.social_account_oauth_states", "c": "brand_id", "type": "text"},
    {"t": "public.social_account_oauth_states", "c": "initiated_by_user_id", "type": "uuid"},
    {"t": "public.social_mobile_account_deletions", "c": "user_id", "type": "uuid"},
    {"t": "public.social_mobile_account_deletions", "c": "workspace_id", "type": "text"},
    {"t": "storage.objects", "c": "owner_id", "type": "text"},
    {"t": "storage.buckets", "c": "owner_id", "type": "text"}
  ]'::jsonb) loop
    if not exists (
      select 1 from pg_attribute a
       where a.attrelid = (v_spec ->> 't')::regclass and a.attname = v_spec ->> 'c'
         and a.attnum > 0 and not a.attisdropped
         and format_type(a.atttypid, a.atttypmod) = v_spec ->> 'type'
    ) then
      raise exception 'COMMON_ACCOUNT_PREFLIGHT_COLUMN_MISMATCH:%.% (%)', v_spec ->> 't', v_spec ->> 'c', v_spec ->> 'type';
    end if;
  end loop;

  -- Every foreign key an invariant relies on, bound to its exact columns:
  -- referencing table and column(s), referenced table and column(s), equal
  -- column types, delete action, validated, and checked immediately.
  for v_spec in select value from jsonb_array_elements('[
    {"t": "public.profiles", "c": ["id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "public.admin_users", "c": ["user_id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "auth.identities", "c": ["user_id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "public.tracked_stocks", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.alert_settings", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.alert_category_settings", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.notifications", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.device_push_tokens", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.personalized_reports", "c": ["user_id"], "r": "public.profiles", "rc": ["id"], "del": "c"},
    {"t": "public.brand_memberships", "c": ["user_id"], "r": "auth.users", "rc": ["id"], "del": "c"},
    {"t": "public.brand_memberships", "c": ["brand_id"], "r": "public.brands", "rc": ["id"], "del": "c"},
    {"t": "public.social_accounts", "c": ["brand_id"], "r": "public.brands", "rc": ["id"], "del": "a"},
    {"t": "public.social_account_oauth_states", "c": ["brand_id"], "r": "public.brands", "rc": ["id"], "del": "a"},
    {"t": "public.social_account_oauth_states", "c": ["initiated_by_user_id"], "r": "auth.users", "rc": ["id"], "del": "c"}
  ]'::jsonb) loop
    if not exists (
      select 1 from pg_constraint c
       where c.contype = 'f'
         and c.conrelid = (v_spec ->> 't')::regclass
         and c.confrelid = (v_spec ->> 'r')::regclass
         and c.confdeltype::text = v_spec ->> 'del'
         and c.convalidated
         and not c.condeferrable
         and (select array_agg(a.attname::text order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
             = array(select jsonb_array_elements_text(v_spec -> 'c'))
         and (select array_agg(a.attname::text order by k.ord)
                from unnest(c.confkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
             = array(select jsonb_array_elements_text(v_spec -> 'rc'))
         and not exists (
           select 1 from unnest(c.conkey, c.confkey) p(fk_attnum, pk_attnum)
             join pg_attribute fa on fa.attrelid = c.conrelid and fa.attnum = p.fk_attnum
             join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = p.pk_attnum
            where fa.atttypid <> pa.atttypid)
    ) then
      raise exception 'COMMON_ACCOUNT_PREFLIGHT_FK_MISMATCH:%(%)->%(%)',
        v_spec ->> 't', v_spec -> 'c' ->> 0, v_spec ->> 'r', v_spec -> 'rc' ->> 0;
    end if;
  end loop;
  -- Kabumori withdrawal removes the profiles row and relies on the cascade
  -- reaching every table that hangs off it, including ones not listed above.
  if exists (
    select 1 from pg_constraint c
     where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass and c.confdeltype <> 'c'
  ) then
    raise exception 'COMMON_ACCOUNT_PREFLIGHT_PROFILES_CHILD_NOT_CASCADE';
  end if;

  -- Existing helpers reused as the single source of the workspace id and the
  -- subject hash, with their exact signatures.
  foreach v_name in array array[
    'public.social_mobile_account_deletion_workspace(uuid)',
    'public.social_mobile_account_deletion_subject(uuid)'
  ] loop
    if to_regprocedure(v_name) is null
       or (select p.prorettype from pg_proc p where p.oid = to_regprocedure(v_name)) <> 'text'::regtype then
      raise exception 'COMMON_ACCOUNT_PREFLIGHT_FUNCTION_MISMATCH:%', v_name;
    end if;
  end loop;
end;
$$;

-- 1. Tables ------------------------------------------------------------------

create table public.common_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'deleting', 'locked')),
  -- I7. A deletion is begun against the version the person confirmed.
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
-- exists; it is cleared when the login row disappears (subject hash remains).
create table private.account_lifecycle_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  subject_sha256 text not null check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  operation_type text not null check (operation_type in ('service_deletion', 'account_deletion')),
  service_key text check (service_key in ('kabumori', 'x_autopost')),
  -- 'login_removed': the login row disappeared while this was in progress.
  -- That is an observation by the guard trigger, not a verified deletion.
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'aborted', 'login_removed')),
  current_step text not null default 'cleanup' check (current_step in ('cleanup', 'ready_for_managed_auth_delete')),
  -- Saga checkpoints attested by the orchestrator: {checkpoint_key: recorded_at}.
  checkpoints jsonb not null default '{}'::jsonb check (jsonb_typeof(checkpoints) = 'object'),
  -- I8: what a readiness was decided against. All null unless ready.
  ready_at timestamptz,
  ready_lifecycle_version bigint,
  ready_requirement_epoch bigint,
  ready_required_checkpoints text[],
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((operation_type = 'service_deletion') = (service_key is not null)),
  check ((status = 'in_progress') = (finished_at is null)),
  check (status <> 'in_progress' or user_id is not null),
  -- Phase 1 has no state that says a whole account was deleted.
  check (status <> 'completed' or operation_type = 'service_deletion'),
  check (current_step = 'cleanup' or operation_type = 'account_deletion'),
  check ((current_step = 'ready_for_managed_auth_delete') = (ready_at is not null)),
  check ((ready_at is null) = (ready_lifecycle_version is null)),
  check ((ready_at is null) = (ready_requirement_epoch is null)),
  check ((ready_at is null) = (ready_required_checkpoints is null))
);
create unique index account_lifecycle_operations_one_in_progress
  on private.account_lifecycle_operations (user_id, operation_type, coalesce(service_key, ''))
  where status = 'in_progress';

create table private.account_lifecycle_settings (
  id boolean primary key default true check (id),
  -- Phase 1 has exactly one mode. An enforcing mode is added only by the later
  -- phase that wires every readiness invalidator (see the header).
  auth_delete_guard text not null default 'shadow' check (auth_delete_guard = 'shadow'),
  -- Set to 'started' by the first integration phase (existing creators and
  -- deletion routes wired to the lifecycle). Rollback is refused afterwards.
  integration_state text not null default 'not_started' check (integration_state in ('not_started', 'started')),
  -- I8: moves whenever the checkpoint requirements or these settings change.
  requirement_epoch bigint not null default 1 check (requirement_epoch >= 1),
  updated_at timestamptz not null default now()
);
insert into private.account_lifecycle_settings default values;

-- I9: the built-in checkpoints and what each one means. This is the contract;
-- the registry rows below must match it exactly.
create function private.account_lifecycle_builtin_checkpoints()
returns table (checkpoint_key text, requirement text)
language sql immutable security definer set search_path = ''
as $$
  values ('apple_revocation', 'apple_identity'), ('session_revocation', 'always'), ('storage_cleanup', 'always')
$$;

-- Managed-service cleanups that the database cannot do or verify itself. An
-- account deletion is not ready until each applicable one is recorded. The
-- built-in rows are fixed (I9). A newly discovered kind of managed ownership is
-- added as an extra row; every deletion then fails closed until an
-- orchestrator attests it.
create table private.account_lifecycle_managed_checkpoints (
  checkpoint_key text primary key check (checkpoint_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  requirement text not null check (requirement in ('always', 'apple_identity'))
);
insert into private.account_lifecycle_managed_checkpoints (checkpoint_key, requirement)
select b.checkpoint_key, b.requirement from private.account_lifecycle_builtin_checkpoints() b;

-- 2. RLS / grants on the new tables --------------------------------------------
-- Clients read their own rows; every write goes through the RPCs below.

alter table public.common_accounts enable row level security;
alter table public.service_entitlements enable row level security;
alter table private.account_lifecycle_operations enable row level security;
alter table private.account_lifecycle_managed_checkpoints enable row level security;
alter table private.account_lifecycle_settings enable row level security;

revoke all on table public.common_accounts from public, anon, authenticated, service_role;
revoke all on table public.service_entitlements from public, anon, authenticated, service_role;
revoke all on table private.account_lifecycle_operations from public, anon, authenticated, service_role;
revoke all on table private.account_lifecycle_managed_checkpoints from public, anon, authenticated, service_role;
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
-- p_exclusive is for the readiness check: nothing may be referencing the login
-- for a new service row while it decides.
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
    -- The login no longer exists (a still-valid token of a removed person).
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

-- I8: drops every still-ready operation (of one person, or of everyone when
-- p_user_id is null) back to cleanup. A readiness is never left standing
-- across a change that this file can see.
create function private.account_lifecycle_invalidate_readiness(p_user_id uuid, p_reason text)
returns void language sql volatile security definer set search_path = ''
as $$
  update private.account_lifecycle_operations
     set current_step = 'cleanup', ready_at = null, ready_lifecycle_version = null,
         ready_requirement_epoch = null, ready_required_checkpoints = null,
         last_error_code = p_reason, updated_at = now()
   where status = 'in_progress' and current_step = 'ready_for_managed_auth_delete'
     and (p_user_id is null or user_id = p_user_id)
$$;

-- I7: the version moves with the state, whoever changes it (RPC, backfill or an
-- operator's SQL), so a confirmation taken before the change cannot be reused.
create function private.account_lifecycle_touch_account()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.lifecycle_version < old.lifecycle_version then
    raise exception 'ACCOUNT_LIFECYCLE_VERSION_CANNOT_DECREASE';
  end if;
  if new.status is distinct from old.status and new.lifecycle_version = old.lifecycle_version then
    new.lifecycle_version := old.lifecycle_version + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger account_lifecycle_touch_account
  before update on public.common_accounts
  for each row execute function private.account_lifecycle_touch_account();

create function private.account_lifecycle_account_changed()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.lifecycle_version <> old.lifecycle_version or new.status <> old.status then
    perform private.account_lifecycle_invalidate_readiness(new.user_id, 'LIFECYCLE_VERSION_CHANGED');
  end if;
  return null;
end;
$$;

create trigger account_lifecycle_account_changed
  after update on public.common_accounts
  for each row execute function private.account_lifecycle_account_changed();

-- An entitlement belongs to one person and one service for its whole life. A
-- transfer would change two accounts while moving only one version; it is
-- refused. Moving a service means ending it here and starting it there.
create function private.account_lifecycle_guard_entitlement_identity()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id or new.service_key is distinct from old.service_key then
    raise exception 'ACCOUNT_LIFECYCLE_ENTITLEMENT_OWNER_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger account_lifecycle_guard_entitlement_identity
  before update on public.service_entitlements
  for each row execute function private.account_lifecycle_guard_entitlement_identity();

create function private.account_lifecycle_touch_entitlement()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  -- No row is updated when the account itself is being removed (cascade).
  update public.common_accounts
     set lifecycle_version = lifecycle_version + 1
   where user_id = coalesce(new.user_id, old.user_id);
  return null;
end;
$$;

create trigger account_lifecycle_touch_entitlement
  after insert or update or delete on public.service_entitlements
  for each row execute function private.account_lifecycle_touch_entitlement();

-- I9: a built-in row can be neither changed nor removed, and its name cannot
-- be given another meaning. Restoring a missing built-in row is allowed.
create function private.account_lifecycle_guard_checkpoint_registry()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'ACCOUNT_LIFECYCLE_BUILTIN_CHECKPOINT_IMMUTABLE';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and exists (
    select 1 from private.account_lifecycle_builtin_checkpoints() b where b.checkpoint_key = old.checkpoint_key
  ) then
    raise exception 'ACCOUNT_LIFECYCLE_BUILTIN_CHECKPOINT_IMMUTABLE';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1 from private.account_lifecycle_builtin_checkpoints() b
     where b.checkpoint_key = new.checkpoint_key and b.requirement <> new.requirement
  ) then
    raise exception 'ACCOUNT_LIFECYCLE_BUILTIN_CHECKPOINT_IMMUTABLE';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger account_lifecycle_guard_checkpoint_registry
  before insert or update or delete on private.account_lifecycle_managed_checkpoints
  for each row execute function private.account_lifecycle_guard_checkpoint_registry();
create trigger account_lifecycle_guard_checkpoint_registry_truncate
  before truncate on private.account_lifecycle_managed_checkpoints
  for each statement execute function private.account_lifecycle_guard_checkpoint_registry();

-- I8: any change of the requirements moves the epoch (and, through the
-- settings trigger below, drops every ready operation).
create function private.account_lifecycle_requirements_changed()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update private.account_lifecycle_settings set requirement_epoch = requirement_epoch + 1;
  return null;
end;
$$;

create trigger account_lifecycle_requirements_changed
  after insert or update or delete on private.account_lifecycle_managed_checkpoints
  for each statement execute function private.account_lifecycle_requirements_changed();

create function private.account_lifecycle_touch_settings()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.requirement_epoch < old.requirement_epoch then
    raise exception 'ACCOUNT_LIFECYCLE_EPOCH_CANNOT_DECREASE';
  end if;
  if (new.integration_state is distinct from old.integration_state
      or new.auth_delete_guard is distinct from old.auth_delete_guard)
     and new.requirement_epoch = old.requirement_epoch then
    new.requirement_epoch := old.requirement_epoch + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger account_lifecycle_touch_settings
  before update on private.account_lifecycle_settings
  for each row execute function private.account_lifecycle_touch_settings();

-- A removed or re-created settings row restarts the epoch, so no readiness may
-- survive it either.
create function private.account_lifecycle_settings_changed()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE' or new.requirement_epoch <> old.requirement_epoch then
    perform private.account_lifecycle_invalidate_readiness(null, 'REQUIREMENT_EPOCH_CHANGED');
  end if;
  return null;
end;
$$;

create trigger account_lifecycle_settings_changed
  after insert or update or delete on private.account_lifecycle_settings
  for each row execute function private.account_lifecycle_settings_changed();

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

-- I5: why whole-account deletion may not begin or become ready. Empty = none.
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

-- Ownership that lives in a managed service and is NOT tied to the login by a
-- foreign key (Storage records its owner as plain text). A read-only probe: a
-- reason to refuse, never proof of absence -- an object can be uploaded right
-- after it, and the objects themselves are only removable through the Storage
-- API. Nothing here writes to Storage. An unreadable shape fails closed.
create function private.account_lifecycle_managed_ownership(p_user_id uuid)
returns text[] language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_relation text;
  v_owned boolean;
begin
  foreach v_relation in array array['storage.objects', 'storage.buckets'] loop
    if to_regclass(v_relation) is null or not exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass(v_relation) and a.attname = 'owner_id'
         and a.attnum > 0 and not a.attisdropped
    ) then
      return array['MANAGED_STORAGE_SHAPE_UNKNOWN'];
    end if;
  end loop;
  if exists (select 1 from storage.objects o where o.owner_id = p_user_id::text)
     or exists (select 1 from storage.buckets b where b.owner_id = p_user_id::text) then
    return array['MANAGED_STORAGE_OWNED'];
  end if;
  -- The deprecated uuid "owner" column, where it still exists.
  foreach v_relation in array array['storage.objects', 'storage.buckets'] loop
    if exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass(v_relation) and a.attname = 'owner'
         and a.attnum > 0 and not a.attisdropped
    ) then
      execute format('select exists (select 1 from %s x where x.owner::text = $1)', v_relation)
        into v_owned using p_user_id::text;
      if v_owned then
        return array['MANAGED_STORAGE_OWNED'];
      end if;
    end if;
  end loop;
  return '{}'::text[];
exception when others then
  -- Could not read Storage (privilege, changed column type, ...): not clean.
  return array['MANAGED_STORAGE_PROBE_FAILED'];
end;
$$;

-- I9: the registry matches the built-in contract exactly (every built-in row
-- present, with its own meaning). Extra rows are allowed.
create function private.account_lifecycle_requirements_valid()
returns boolean language sql volatile security definer set search_path = ''
as $$
  select not exists (
    select 1 from private.account_lifecycle_builtin_checkpoints() b
      left join private.account_lifecycle_managed_checkpoints c on c.checkpoint_key = b.checkpoint_key
     where c.requirement is distinct from b.requirement)
$$;

-- Which managed checkpoints this person's deletion needs. Null when the
-- registry does not match the built-in contract: the caller treats that as
-- not ready.
create function private.account_lifecycle_required_checkpoints(p_user_id uuid)
returns text[] language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_apple boolean := exists (
    select 1 from auth.identities i where i.user_id = p_user_id and i.provider = 'apple');
begin
  if not private.account_lifecycle_requirements_valid() then
    return null;
  end if;
  return coalesce((
    select array_agg(c.checkpoint_key order by c.checkpoint_key)
      from private.account_lifecycle_managed_checkpoints c
     where c.requirement = 'always' or (c.requirement = 'apple_identity' and v_apple)), '{}'::text[]);
end;
$$;

-- I4: everything a readiness depends on, evaluated now. Null = nothing stands
-- in the way; otherwise the answer to give (with non-secret next steps).
create function private.account_lifecycle_readiness_refusal(p_user_id uuid, p_checkpoints jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_remaining jsonb;
  v_blockers text[];
  v_required text[];
  v_missing text[];
  v_managed text[];
begin
  select jsonb_agg(e.service_key order by e.service_key) into v_remaining
    from public.service_entitlements e where e.user_id = p_user_id and e.status <> 'ended';
  if v_remaining is not null then
    return jsonb_build_object('status', 'not_ready', 'reason', 'SERVICES_REMAIN', 'services', v_remaining,
      'next_steps', jsonb_build_array('end_remaining_services'));
  end if;
  -- With every entitlement ended, any remaining service row, admin membership
  -- or foreign workspace is a blocker (UNREGISTERED_SERVICE_FOOTPRINT, ...).
  v_blockers := private.account_lifecycle_deletion_blockers(p_user_id, 'deleting');
  if cardinality(v_blockers) > 0 then
    return jsonb_build_object('status', 'blocked', 'reasons', to_jsonb(v_blockers),
      'next_steps', jsonb_build_array('operator_review'));
  end if;
  if not exists (select 1 from private.account_lifecycle_settings s where s.auth_delete_guard = 'shadow') then
    return jsonb_build_object('status', 'not_ready', 'reason', 'LIFECYCLE_SETTINGS_INVALID',
      'next_steps', jsonb_build_array('operator_review'));
  end if;
  v_required := private.account_lifecycle_required_checkpoints(p_user_id);
  if v_required is null then
    return jsonb_build_object('status', 'not_ready', 'reason', 'MANAGED_CHECKPOINT_REGISTRY_INVALID',
      'next_steps', jsonb_build_array('operator_review'));
  end if;
  v_missing := array(select k from unnest(v_required) k where not p_checkpoints ? k order by k);
  if cardinality(v_missing) > 0 then
    return jsonb_build_object('status', 'not_ready', 'reason', 'MANAGED_CHECKPOINTS_MISSING',
      'missing_checkpoints', to_jsonb(v_missing),
      'next_steps', jsonb_build_array('complete_managed_cleanup_and_record_checkpoints'));
  end if;
  v_managed := private.account_lifecycle_managed_ownership(p_user_id);
  if cardinality(v_managed) > 0 then
    return jsonb_build_object('status', 'not_ready', 'reason', 'MANAGED_OWNERSHIP_REMAINS',
      'managed_ownership', to_jsonb(v_managed),
      'next_steps', jsonb_build_array('clean_managed_ownership_through_its_api_and_record_again'));
  end if;
  return null;
end;
$$;

-- I8: why a readiness may not be relied on right now. Empty = still valid.
-- The first three checks compare durable state only (nothing a cascade can
-- erase); the last one re-evaluates everything, so it must run BEFORE any
-- destructive step, never after.
create function private.account_lifecycle_authorization_problems(p_user_id uuid, p_operation_id uuid)
returns text[] language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_operation private.account_lifecycle_operations;
  v_account public.common_accounts;
  v_epoch bigint;
  v_refusal jsonb;
  v_problems text[] := '{}';
begin
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'account_deletion';
  if not found or v_operation.status <> 'in_progress'
     or v_operation.current_step <> 'ready_for_managed_auth_delete' then
    return array['NOT_READY'];
  end if;
  select * into v_account from public.common_accounts where user_id = p_user_id;
  select s.requirement_epoch into v_epoch from private.account_lifecycle_settings s;
  if v_account.status is distinct from 'deleting' then
    v_problems := v_problems || 'ACCOUNT_DELETION_NOT_IN_PROGRESS'::text;
  end if;
  if v_account.lifecycle_version is distinct from v_operation.ready_lifecycle_version then
    v_problems := v_problems || 'LIFECYCLE_VERSION_CHANGED'::text;
  end if;
  if v_epoch is distinct from v_operation.ready_requirement_epoch then
    v_problems := v_problems || 'REQUIREMENT_EPOCH_CHANGED'::text;
  end if;
  if private.account_lifecycle_required_checkpoints(p_user_id) is distinct from v_operation.ready_required_checkpoints then
    v_problems := v_problems || 'REQUIRED_CHECKPOINTS_CHANGED'::text;
  end if;
  v_refusal := private.account_lifecycle_readiness_refusal(p_user_id, v_operation.checkpoints);
  if v_refusal is not null then
    v_problems := v_problems || coalesce(v_refusal ->> 'reason', v_refusal -> 'reasons' ->> 0);
  end if;
  return v_problems;
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
  -- The Kabumori service root is created with its entitlement, atomically.
  if p_service_key = 'kabumori' then
    insert into public.profiles (id) values (p_user_id) on conflict (id) do nothing;
  end if;
  return jsonb_build_object('status', 'active', 'service', p_service_key, 'started', v_started);
end;
$$;

-- Auth-delete guard (reached by the cascade from auth.users). Phase 1 only
-- observes: in 'shadow' it allows the delete, closes the person's open
-- operations and clears their raw id. It authorizes nothing and is no safety
-- for the existing deletion routes. It deliberately does not look at admin,
-- membership or identity rows: other cascades of the same delete may already
-- have removed them. Missing or unexpected settings refuse every delete.
-- 23503 on purpose: the existing X deletion maps a blocked login delete to its
-- operator state.
create function private.account_lifecycle_guard_account_delete()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_mode text;
begin
  select s.auth_delete_guard into v_mode from private.account_lifecycle_settings s;
  if v_mode is distinct from 'shadow' then
    raise exception 'COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED' using errcode = '23503';
  end if;
  -- A direct maintenance DELETE of the application row is not removal of a
  -- managed login. During the real Auth cascade the parent row is already
  -- absent in this transaction; refuse anything else without falsifying the
  -- durable observation or clearing its subject link.
  if exists (select 1 from auth.users u where u.id = old.user_id) then
    raise exception 'COMMON_ACCOUNT_ROW_DELETE_REQUIRES_LOGIN_REMOVAL' using errcode = '23503';
  end if;
  update private.account_lifecycle_operations
     set status = 'login_removed',
         last_error_code = case
           when current_step = 'ready_for_managed_auth_delete' then 'LOGIN_REMOVED_WHILE_READY_UNVERIFIED'
           else 'ACCOUNT_REMOVED_EXTERNALLY' end,
         finished_at = now(), updated_at = now()
   where user_id = old.user_id and status = 'in_progress';
  update private.account_lifecycle_operations
     set user_id = null, updated_at = now()
   where user_id = old.user_id;
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

-- Read model for a confirmation screen and for the orchestrator. Takes no
-- lock: it is advice, and begin / prepare re-evaluate everything under the
-- locks. lifecycle_version 0 = no account row. It is never a valid version of
-- a row. authorization.state: 'none' (not ready), 'valid', or 'stale'.
create function public.common_account_deletion_eligibility(p_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_problems text[];
begin
  if p_user_id is null then raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED'; end if;
  select * into v_account from public.common_accounts where user_id = p_user_id;
  select * into v_operation from private.account_lifecycle_operations o
   where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress';
  if v_operation.id is not null then
    v_problems := private.account_lifecycle_authorization_problems(p_user_id, v_operation.id);
  end if;
  return jsonb_build_object(
    'account_status', coalesce(v_account.status, 'none'),
    'lifecycle_version', coalesce(v_account.lifecycle_version, 0),
    'requirement_epoch', (select s.requirement_epoch from private.account_lifecycle_settings s),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('service_key', e.service_key, 'status', e.status) order by e.service_key)
        from public.service_entitlements e where e.user_id = p_user_id), '[]'::jsonb),
    'blockers', to_jsonb(private.account_lifecycle_deletion_blockers(p_user_id, coalesce(v_account.status, 'none'))),
    'required_checkpoints', to_jsonb(private.account_lifecycle_required_checkpoints(p_user_id)),
    'managed_ownership', to_jsonb(private.account_lifecycle_managed_ownership(p_user_id)),
    'operation', case when v_operation.id is null then null else jsonb_build_object(
      'operation_id', v_operation.id, 'step', v_operation.current_step,
      'recorded_checkpoints', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
                                 from jsonb_object_keys(v_operation.checkpoints) k)) end,
    'authorization', case
      when v_operation.id is null or v_problems = array['NOT_READY'] then jsonb_build_object('state', 'none')
      when cardinality(v_problems) = 0 then jsonb_build_object('state', 'valid',
        'lifecycle_version', v_operation.ready_lifecycle_version,
        'requirement_epoch', v_operation.ready_requirement_epoch,
        'required_checkpoints', to_jsonb(v_operation.ready_required_checkpoints))
      else jsonb_build_object('state', 'stale', 'problems', to_jsonb(v_problems)) end);
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
  if v_operation.status <> 'in_progress' then
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
  update private.account_lifecycle_operations
     set status = 'completed', last_error_code = null, finished_at = now(), updated_at = now()
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
  if v_operation.status <> 'in_progress' then
    return jsonb_build_object('status', 'blocked', 'reason', 'SERVICE_ALREADY_ENDED');
  end if;
  update public.service_entitlements set status = 'active', updated_at = now()
   where user_id = p_user_id and service_key = p_service_key and status = 'deleting';
  update private.account_lifecycle_operations
     set status = 'aborted', finished_at = now(), updated_at = now()
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
begin
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_version := coalesce(v_account.lifecycle_version, 0);
  if v_account.status = 'deleting' then
    select o.id into v_operation from private.account_lifecycle_operations o
     where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress';
    if not found then
      return jsonb_build_object('status', 'blocked', 'reasons', jsonb_build_array('LIFECYCLE_STATE_INCONSISTENT'));
    end if;
    return jsonb_build_object('status', 'in_progress', 'operation_id', v_operation, 'lifecycle_version', v_version);
  end if;
  -- The person confirmed deletion against a previewed state. 0 is valid only
  -- while there is still no account row; any row, however new, has moved on.
  if p_expected_lifecycle_version is distinct from v_version then
    return jsonb_build_object('status', 'lifecycle_changed', 'lifecycle_version', v_version);
  end if;
  if v_account.user_id is null then
    -- No row existed, so nothing was locked above. Create it and make sure it
    -- is exactly the fresh row: someone else may have created and changed it.
    v_account := private.account_lifecycle_lock(p_user_id, true);
    if v_account.lifecycle_version <> 1 or v_account.status <> 'active' or exists (
      select 1 from public.service_entitlements e where e.user_id = p_user_id
    ) then
      return jsonb_build_object('status', 'lifecycle_changed', 'lifecycle_version', v_account.lifecycle_version);
    end if;
  end if;
  v_blockers := private.account_lifecycle_deletion_blockers(p_user_id, v_account.status);
  if cardinality(v_blockers) > 0 then
    return jsonb_build_object('status', 'blocked', 'reasons', to_jsonb(v_blockers));
  end if;
  update public.common_accounts set status = 'deleting'
   where user_id = p_user_id
  returning lifecycle_version into v_version;
  insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type)
  values (p_user_id, public.social_mobile_account_deletion_subject(p_user_id), 'account_deletion')
  returning id into v_operation;
  return jsonb_build_object(
    'status', 'started', 'operation_id', v_operation, 'lifecycle_version', v_version,
    'required_checkpoints', to_jsonb(private.account_lifecycle_required_checkpoints(p_user_id)),
    'services_to_end', coalesce((
      select jsonb_agg(e.service_key order by e.service_key)
        from public.service_entitlements e where e.user_id = p_user_id and e.status <> 'ended'), '[]'::jsonb));
end;
$$;

-- Saga checkpoint: the orchestrator attests that one managed cleanup is done
-- (sessions revoked, Storage emptied through its API, Apple grant revoked).
-- Recording again refreshes the time. The database does not verify the claim.
create function public.record_common_account_deletion_checkpoint(p_user_id uuid, p_operation_id uuid, p_checkpoint text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
begin
  if p_checkpoint is null or not exists (
    select 1 from private.account_lifecycle_managed_checkpoints c where c.checkpoint_key = p_checkpoint
  ) then
    raise exception 'ACCOUNT_LIFECYCLE_CHECKPOINT_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  update private.account_lifecycle_operations
     set checkpoints = checkpoints || jsonb_build_object(p_checkpoint, now()), updated_at = now()
   where id = p_operation_id and user_id = p_user_id
     and operation_type = 'account_deletion' and status = 'in_progress';
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'recorded', 'checkpoint', p_checkpoint);
end;
$$;

-- The orchestrator found that a cleanup no longer holds (for example Storage
-- objects appeared again). The checkpoint is withdrawn and any readiness with it.
create function public.clear_common_account_deletion_checkpoint(p_user_id uuid, p_operation_id uuid, p_checkpoint text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
begin
  if p_checkpoint is null then
    raise exception 'ACCOUNT_LIFECYCLE_CHECKPOINT_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  update private.account_lifecycle_operations
     set checkpoints = checkpoints - p_checkpoint,
         current_step = 'cleanup', ready_at = null, ready_lifecycle_version = null,
         ready_requirement_epoch = null, ready_required_checkpoints = null,
         last_error_code = 'MANAGED_CHECKPOINT_CLEARED', updated_at = now()
   where id = p_operation_id and user_id = p_user_id
     and operation_type = 'account_deletion' and status = 'in_progress';
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'cleared', 'checkpoint', p_checkpoint);
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
  update public.common_accounts set status = 'active' where user_id = p_user_id;
  update private.account_lifecycle_operations
     set status = 'aborted', finished_at = now(), updated_at = now()
   where id = p_operation_id;
  return jsonb_build_object('status', 'aborted');
end;
$$;

-- I4 + I8: the last database step of an account deletion, and the only way to
-- obtain (or refresh) its authorization. Under the exclusive auth.users row
-- lock, the common_accounts lock and a share lock on the settings row, it
-- evaluates everything and, if clean, moves the operation to
-- 'ready_for_managed_auth_delete' bound to the lifecycle_version, the
-- requirement_epoch and the exact required checkpoints it was decided against.
-- It does NOT delete the login, Storage objects, sessions or provider grants
-- and never reports a deletion as completed: it tells the orchestrator what is
-- next. Calling it again re-evaluates; a state that is no longer clean drops
-- the operation back to 'cleanup'. The orchestrator must call it immediately
-- before the managed delete: what this file cannot see changing (admin and
-- workspace membership, identities, Storage) is only caught by evaluating.
create function public.prepare_common_account_auth_delete(p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_epoch bigint;
  v_required text[];
  v_refusal jsonb;
begin
  if p_user_id is null or p_operation_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false, true);
  -- Before the operation row: a requirement change waits for this decision,
  -- or this decision waits for it (same order as the change itself takes).
  select s.requirement_epoch into v_epoch from private.account_lifecycle_settings s for share;
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'account_deletion'
   for update;
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.status <> 'in_progress' or v_account.status <> 'deleting' then
    return jsonb_build_object('status', 'not_ready', 'reason', 'ACCOUNT_DELETION_NOT_IN_PROGRESS');
  end if;

  v_refusal := private.account_lifecycle_readiness_refusal(p_user_id, v_operation.checkpoints);
  if v_refusal is not null then
    update private.account_lifecycle_operations
       set current_step = 'cleanup', ready_at = null, ready_lifecycle_version = null,
           ready_requirement_epoch = null, ready_required_checkpoints = null,
           last_error_code = coalesce(v_refusal ->> 'reason', v_refusal -> 'reasons' ->> 0), updated_at = now()
     where id = p_operation_id;
    return v_refusal;
  end if;
  v_required := private.account_lifecycle_required_checkpoints(p_user_id);
  update private.account_lifecycle_operations
     set current_step = 'ready_for_managed_auth_delete', ready_at = now(),
         ready_lifecycle_version = v_account.lifecycle_version,
         ready_requirement_epoch = v_epoch,
         ready_required_checkpoints = v_required,
         last_error_code = null, updated_at = now()
   where id = p_operation_id;
  return jsonb_build_object(
    'status', 'ready_for_managed_auth_delete', 'operation_id', p_operation_id,
    'login_deleted', false,
    'authorization', jsonb_build_object(
      'lifecycle_version', v_account.lifecycle_version,
      'requirement_epoch', v_epoch,
      'required_checkpoints', to_jsonb(v_required)),
    'next_steps', jsonb_build_array(
      'revalidate_managed_ownership', 'managed_auth_admin_delete', 'post_delete_read_back_and_audit'));
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
  -- Sole owner of the person's own self-service workspace. Internal or shared
  -- workspaces are not consumer use.
  select m.user_id, m.created_at,
         exists (select 1 from public.social_accounts a
                  where a.brand_id = b.id and a.connection_status = 'identity_verified') as verified,
         exists (select 1 from public.admin_users au where au.user_id = m.user_id) as is_admin
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
       -- An admin is an operator, never a consumer of X autopost, even when
       -- the same login also owns a self-service workspace.
       x.user_id is not null and not x.is_admin as x_candidate,
       x.user_id is not null and x.is_admin as x_excluded_admin,
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

-- p_apply = false (default) only counts, from one unlocked snapshot.
-- p_apply = true goes login by login in id order: it takes the lifecycle lock
-- (auth.users, then common_accounts), re-reads that login's plan row after
-- the lock, and only then inserts what is still missing. A login whose account
-- is not 'active' at that moment gains nothing. Idempotent; never changes an
-- existing entitlement. Every inserted entitlement moves lifecycle_version (I7).
create function private.account_lifecycle_backfill(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_report jsonb;
  v_user uuid;
  v_account public.common_accounts;
  v_plan private.account_lifecycle_backfill_plan;
  v_accounts bigint := 0;
  v_kabumori bigint := 0;
  v_x bigint := 0;
  v_skipped bigint := 0;
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
    'x_autopost_excluded_admin', count(*) filter (where x_excluded_admin),
    'auth_only', count(*) filter (where not kabumori_candidate and not x_candidate),
    'not_active_accounts_with_candidates', count(*) filter (
      where account_status <> 'active'
        and ((kabumori_candidate and not kabumori_exists) or (x_candidate and not x_exists)))
  ) into v_report from private.account_lifecycle_backfill_plan;

  v_report := v_report || jsonb_build_object(
    'admin_users', (select count(*) from public.admin_users),
    'excluded_non_self_service_memberships', (
      select count(*) from public.brand_memberships m
        join public.brands b on b.id = m.brand_id
       where b.code_profile_key is distinct from 'social_mobile_user_v1'
          or b.id <> public.social_mobile_account_deletion_workspace(m.user_id)
          or m.role <> 'owner'
          or exists (select 1 from public.brand_memberships o where o.brand_id = b.id and o.user_id <> m.user_id)));

  if coalesce(p_apply, false) then
    for v_user in select u.id from auth.users u order by u.id loop
      begin
        v_account := private.account_lifecycle_lock(v_user, true);
      exception when insufficient_privilege then
        -- Only "the login disappeared between the listing and the lock".
        if sqlerrm <> 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' then
          raise;
        end if;
        continue;
      end;
      if v_account.created_at = now() then
        v_accounts := v_accounts + 1;
      end if;
      -- Read after the lock: this is the committed state of this login now.
      select * into v_plan from private.account_lifecycle_backfill_plan p where p.user_id = v_user;
      if v_account.status <> 'active' then
        if (v_plan.kabumori_candidate and not v_plan.kabumori_exists)
           or (v_plan.x_candidate and not v_plan.x_exists) then
          v_skipped := v_skipped + 1;
        end if;
        continue;
      end if;
      if v_plan.kabumori_candidate and not v_plan.kabumori_exists then
        insert into public.service_entitlements (user_id, service_key, status, source, legacy_evidence, activated_at)
        values (v_user, 'kabumori', 'active', 'legacy_backfill',
                case when v_plan.kabumori_activity then 'kabumori_activity' else 'kabumori_profile_only' end,
                coalesce(v_plan.kabumori_since, now()));
        v_kabumori := v_kabumori + 1;
      end if;
      if v_plan.x_candidate and not v_plan.x_exists then
        insert into public.service_entitlements (user_id, service_key, status, source, legacy_evidence, activated_at)
        values (v_user, 'x_autopost', 'active', 'legacy_backfill',
                case when v_plan.x_verified then 'x_identity_verified' else 'x_workspace_pending' end,
                coalesce(v_plan.x_since, now()));
        v_x := v_x + 1;
      end if;
    end loop;
  end if;

  return v_report || jsonb_build_object(
    'applied', coalesce(p_apply, false),
    'created_common_accounts', v_accounts,
    'created_kabumori', v_kabumori,
    'created_x_autopost', v_x,
    'skipped_account_not_active', v_skipped);
end;
$$;

-- 7. Function privileges ---------------------------------------------------------
-- Nothing is executable by PUBLIC or anon. Internal helpers are executable by
-- nobody but their owner; they are reached only through the RPCs.

revoke all on function private.account_lifecycle_lock(uuid, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_invalidate_readiness(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_touch_account() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_account_changed() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_guard_entitlement_identity() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_touch_entitlement() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_footprint(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_deletion_blockers(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_managed_ownership(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_builtin_checkpoints() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_guard_checkpoint_registry() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_requirements_changed() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_touch_settings() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_settings_changed() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_requirements_valid() from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_required_checkpoints(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_readiness_refusal(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_authorization_problems(uuid, uuid) from public, anon, authenticated, service_role;
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
revoke all on function public.record_common_account_deletion_checkpoint(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.clear_common_account_deletion_checkpoint(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.abort_common_account_deletion(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.prepare_common_account_auth_delete(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.common_account_deletion_eligibility(uuid) to service_role;
grant execute on function public.begin_service_deletion(uuid, text) to service_role;
grant execute on function public.finish_service_deletion(uuid, text, uuid) to service_role;
grant execute on function public.abort_service_deletion(uuid, text, uuid) to service_role;
grant execute on function public.withdraw_kabumori_service(uuid) to service_role;
grant execute on function public.begin_common_account_deletion(uuid, bigint) to service_role;
grant execute on function public.record_common_account_deletion_checkpoint(uuid, uuid, text) to service_role;
grant execute on function public.clear_common_account_deletion_checkpoint(uuid, uuid, text) to service_role;
grant execute on function public.abort_common_account_deletion(uuid, uuid) to service_role;
grant execute on function public.prepare_common_account_auth_delete(uuid, uuid) to service_role;

-- 8. Postflight: what was just installed is the affirmed starting state.
do $$
begin
  if not private.account_lifecycle_requirements_valid()
     or (select count(*) from private.account_lifecycle_managed_checkpoints) <> 3
     or (select count(*) from private.account_lifecycle_settings
          where auth_delete_guard = 'shadow' and integration_state = 'not_started' and requirement_epoch = 1) <> 1
     or exists (select 1 from public.common_accounts)
     or exists (select 1 from private.account_lifecycle_operations) then
    raise exception 'COMMON_ACCOUNT_POSTFLIGHT_UNEXPECTED_STATE';
  end if;
end;
$$;

commit;
