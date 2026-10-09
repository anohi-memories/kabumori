-- SOURCE CANDIDATE ONLY. NOT applied to production. Apply as a single reviewed file (never db push),
-- after Phase 1 (20261001150000) and Phase 2 (20261006230000), and BEFORE the lifecycle-aware
-- `account-delete` Edge Function is deployed (that function calls the RPCs added here).
--
-- Common account Phase 3a (with the PR112 H2 R1-R4 corrective): the database half of the whole-account
-- deletion orchestrator. Design: docs/common-account/phase3a-deletion-orchestrator.md.
--
--   1. Ownership (R1). One durable owner per open account deletion: a lease (unguessable token, expiry)
--      plus a monotonic fence, taken after `begin` and before any external action. Every owned step,
--      checkpoint and readiness call re-checks it in the same transaction; a second request answers
--      'in_progress'; a stale owner (expired or taken-over lease) is refused before it acts.
--   2. External-step intent (R1/R2). The two steps that cannot be blindly repeated -- the Apple grant
--      revocation (single-use code) and the managed Auth delete -- are recorded as in flight BEFORE the
--      call and settled AFTER it. A takeover never replays an unsettled one: an Apple step whose outcome
--      is unknown becomes 'reconciliation_required' (operator), and an Auth delete is retried only while
--      the login is provably still there.
--   3. Release gate (R3). The managed Auth delete is decided under the exclusive login lock with a full
--      re-evaluation and a snapshot of the required checkpoints and identity providers. That still
--      cannot see an identity linked after the decision and erased by the Auth cascade, and Phase 1's
--      guard is shadow. So the managed Auth delete is RELEASE-BLOCKED by a schema-level gate that this
--      file can only create as 'blocked'; opening it is a later reviewed migration together with the
--      missing prerequisite (an identity-change fence on the Auth side).
--   4. Verified completion (R3/R4). An account deletion is 'completed' only with a recorded managed
--      delete intent, a standing readiness, every required checkpoint and a fresh residue check. Asking
--      again re-checks the residue now ('residue_found'), keeping the historical verification.
--   5. Storage inventory for removal through the Storage API, and 6. an operator error-code recorder.
--
-- Every function is SECURITY DEFINER with an empty search_path; the public ones are executable by
-- service_role only, and p_user_id is the id the Edge Function verified from the person's own token.
-- Nothing here writes to auth, storage or vault, removes a login, or changes the Auth-delete guard (it
-- stays 'shadow'). Lock order is unchanged (auth.users -> common_accounts -> settings -> operation).

begin;

do $$
declare
  v_matches integer;
begin
  if to_regprocedure('public.prepare_common_account_auth_delete(uuid,uuid)') is null
     or to_regprocedure('public.record_common_account_deletion_checkpoint(uuid,uuid,text)') is null
     or to_regprocedure('public.clear_common_account_deletion_checkpoint(uuid,uuid,text)') is null
     or to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)') is null
     or to_regprocedure('private.account_lifecycle_footprint(uuid)') is null
     or to_regprocedure('private.account_lifecycle_managed_ownership(uuid)') is null
     or to_regprocedure('private.account_lifecycle_required_checkpoints(uuid)') is null
     or to_regprocedure('private.account_lifecycle_authorization_problems(uuid,uuid)') is null
     or to_regprocedure('private.account_lifecycle_guard_account_delete()') is null
     or to_regprocedure('public.social_mobile_account_deletion_subject(uuid)') is null
     or to_regprocedure('public.reactivate_kabumori_service(bigint)') is null
     or to_regclass('private.account_lifecycle_operations') is null
     or to_regclass('private.account_lifecycle_settings') is null then
    raise exception 'COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'private.account_lifecycle_operations'::regclass
                and a.attname in ('verified_at', 'owner_lease', 'external_step', 'managed_delete_intent_at')
                and a.attnum > 0 and not a.attisdropped)
     or to_regclass('private.account_lifecycle_release_gates') is not null
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where (n.nspname = 'public' and p.proname in (
                          'complete_common_account_deletion', 'common_account_deletion_storage_objects',
                          'record_common_account_deletion_error', 'claim_common_account_deletion',
                          'renew_common_account_deletion_claim', 'release_common_account_deletion_claim',
                          'begin_common_account_deletion_external_step', 'settle_common_account_deletion_external_step',
                          'resolve_common_account_deletion_external_step', 'set_owned_common_account_deletion_checkpoint',
                          'prepare_owned_common_account_auth_delete', 'common_account_deletion_release_gate'))
                    or (n.nspname = 'private' and p.proname in (
                          'account_lifecycle_storage_inventory', 'account_lifecycle_owned_operation',
                          'account_lifecycle_residue', 'account_lifecycle_gate_open'))) then
    raise exception 'COMMON_ACCOUNT_DELETION_COMPLETION_ALREADY_APPLIED';
  end if;
  -- The Phase 1 rule this file replaces must be there exactly once, unchanged.
  select count(*) into v_matches from pg_constraint c
   where c.conrelid = 'private.account_lifecycle_operations'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) = 'CHECK (((status <> ''completed''::text) OR (operation_type = ''service_deletion''::text)))';
  if v_matches <> 1 then
    raise exception 'COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_COMPLETED_RULE_CHANGED';
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from private.account_lifecycle_settings where auth_delete_guard = 'shadow') then
    raise exception 'COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING';
  end if;
end;
$$;

-- 1. Operation columns ------------------------------------------------------------------------------

do $$
declare
  v_name text;
begin
  select c.conname into strict v_name from pg_constraint c
   where c.conrelid = 'private.account_lifecycle_operations'::regclass and c.contype = 'c'
     and pg_get_constraintdef(c.oid) = 'CHECK (((status <> ''completed''::text) OR (operation_type = ''service_deletion''::text)))';
  execute format('alter table private.account_lifecycle_operations drop constraint %I', v_name);
end;
$$;

alter table private.account_lifecycle_operations
  -- When the post-delete read-back first confirmed the deletion (historical; never rewritten).
  add column verified_at timestamptz,
  -- R1: the one owner of an open account deletion. The lease is unguessable and expires; the fence
  -- grows with every acquisition, so an older owner can always be told apart.
  add column owner_lease uuid,
  add column owner_lease_expires_at timestamptz,
  add column owner_fence bigint not null default 0 check (owner_fence >= 0),
  -- R1/R2: an external step that must not be repeated blindly, recorded before it is called.
  add column external_step text check (external_step in ('apple_revocation', 'managed_auth_delete')),
  add column external_step_started_at timestamptz,
  add column external_step_fence bigint,
  -- R3: what the managed Auth delete was decided against (kept after the login is gone).
  add column managed_delete_intent_at timestamptz,
  add column managed_delete_required_checkpoints text[],
  add column managed_delete_identity_providers text[],
  add constraint account_lifecycle_operations_lease_shape check ((owner_lease is null) = (owner_lease_expires_at is null)),
  add constraint account_lifecycle_operations_external_step_shape check (
    (external_step is null) = (external_step_started_at is null)
    and (external_step is null) = (external_step_fence is null)),
  add constraint account_lifecycle_operations_intent_shape check (
    (managed_delete_intent_at is null) = (managed_delete_required_checkpoints is null)
    and (managed_delete_intent_at is null) = (managed_delete_identity_providers is null)),
  add constraint account_lifecycle_operations_owner_scope check (
    operation_type = 'account_deletion'
    or (owner_lease is null and owner_fence = 0 and external_step is null and managed_delete_intent_at is null)),
  -- A whole-account deletion is 'completed' only after verification, only once the login is gone (the
  -- guard cleared the raw id), only if it was ready when the login disappeared, only with a recorded
  -- managed delete intent, and with no owner or step left open.
  add constraint account_lifecycle_operations_completed_shape check (
    status <> 'completed' or operation_type = 'service_deletion'
    or (user_id is null and verified_at is not null and current_step = 'ready_for_managed_auth_delete'
        and managed_delete_intent_at is not null and external_step is null and owner_lease is null)),
  add constraint account_lifecycle_operations_verified_shape check (
    verified_at is null or (operation_type = 'account_deletion' and status = 'completed'));

-- 2. Release gate (R3) ------------------------------------------------------------------------------

-- The managed Auth delete stays blocked until its prerequisite exists. This file can only create the
-- gate as 'blocked': opening it requires a later reviewed migration that replaces this rule together
-- with that prerequisite. No operator setting opens it.
create table private.account_lifecycle_release_gates (
  gate text primary key check (gate = 'managed_auth_delete'),
  state text not null constraint account_lifecycle_release_gates_blocked_only check (state = 'blocked'),
  reason text not null check (reason ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
insert into private.account_lifecycle_release_gates (gate, state, reason)
values ('managed_auth_delete', 'blocked', 'IDENTITY_CHANGE_FENCE_MISSING');
alter table private.account_lifecycle_release_gates enable row level security;
revoke all on table private.account_lifecycle_release_gates from public, anon, authenticated, service_role;

create function private.account_lifecycle_gate_open(p_gate text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from private.account_lifecycle_release_gates g where g.gate = p_gate and g.state = 'open') $$;

-- Read model for the Edge Function's pre-check (before anything changes). A missing row is blocked.
create function public.common_account_deletion_release_gate()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('managed_auth_delete', coalesce(
    (select jsonb_build_object('state', g.state, 'reason', g.reason)
       from private.account_lifecycle_release_gates g where g.gate = 'managed_auth_delete'),
    jsonb_build_object('state', 'blocked', 'reason', 'GATE_MISSING')))
$$;

-- 3. Ownership (R1) ---------------------------------------------------------------------------------

-- The person's open account deletion, locked, when p_lease is its current unexpired lease; a null row
-- otherwise. The caller holds the account lock already (lock order).
create function private.account_lifecycle_owned_operation(p_user_id uuid, p_operation_id uuid, p_lease uuid)
returns private.account_lifecycle_operations language plpgsql security definer set search_path = ''
as $$
declare
  v_operation private.account_lifecycle_operations;
begin
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'account_deletion' and status = 'in_progress'
   for update;
  if not found or p_lease is null or v_operation.owner_lease is distinct from p_lease
     or v_operation.owner_lease_expires_at <= now() then
    return null;
  end if;
  return v_operation;
end;
$$;

-- Takes ownership of the person's open account deletion. 'in_progress' while another owner's lease is
-- unexpired, or while an external step it started may still be running (900 s, longer than any Edge
-- request). After that: an unsettled Apple step is never replayed ('reconciliation_required'); an
-- unsettled managed Auth delete did not happen (the login is still here, locked above) and is cleared.
create function public.claim_common_account_deletion(p_user_id uuid, p_operation_id uuid, p_lease_seconds integer default 600)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 600), 60), 900);
  v_lease uuid := gen_random_uuid();
  v_fence bigint;
begin
  if p_user_id is null or p_operation_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'account_deletion'
   for update;
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.status <> 'in_progress' then
    return jsonb_build_object('status', 'not_in_progress');
  end if;
  if v_operation.owner_lease is not null and v_operation.owner_lease_expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;
  if v_operation.external_step is not null then
    if v_operation.external_step_started_at > now() - interval '900 seconds' then
      return jsonb_build_object('status', 'in_progress', 'step', v_operation.external_step);
    end if;
    if v_operation.external_step = 'apple_revocation' then
      update private.account_lifecycle_operations
         set owner_lease = null, owner_lease_expires_at = null,
             last_error_code = 'APPLE_REVOCATION_OUTCOME_UNKNOWN', updated_at = now()
       where id = v_operation.id;
      return jsonb_build_object('status', 'reconciliation_required', 'step', 'apple_revocation');
    end if;
    update private.account_lifecycle_operations
       set external_step = null, external_step_started_at = null, external_step_fence = null,
           last_error_code = 'MANAGED_AUTH_DELETE_NOT_APPLIED', updated_at = now()
     where id = v_operation.id;
  end if;
  update private.account_lifecycle_operations
     set owner_lease = v_lease, owner_lease_expires_at = now() + make_interval(secs => v_seconds),
         owner_fence = owner_fence + 1, updated_at = now()
   where id = v_operation.id
  returning owner_fence into v_fence;
  return jsonb_build_object(
    'status', 'acquired', 'lease', v_lease, 'fence', v_fence,
    'recorded_checkpoints', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
                               from jsonb_object_keys(v_operation.checkpoints) k));
end;
$$;

-- Re-checks ownership before a step and extends the lease. 'lease_lost' = stop now, do nothing.
create function public.renew_common_account_deletion_claim(p_user_id uuid, p_operation_id uuid, p_lease uuid, p_lease_seconds integer default 600)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update private.account_lifecycle_operations
     set owner_lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 600), 60), 900)),
         updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'owned', 'fence', v_operation.owner_fence);
end;
$$;

-- Gives ownership back (any outcome). Found by id, subject and lease, so it also works once the login
-- is gone. An unsettled external step stays recorded.
create function public.release_common_account_deletion_claim(p_user_id uuid, p_operation_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if p_user_id is null or p_operation_id is null or p_lease is null then
    raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED';
  end if;
  update private.account_lifecycle_operations
     set owner_lease = null, owner_lease_expires_at = null, updated_at = now()
   where id = p_operation_id and operation_type = 'account_deletion' and owner_lease = p_lease
     and subject_sha256 = public.social_mobile_account_deletion_subject(p_user_id);
  return jsonb_build_object('status', case when found then 'released' else 'not_owned' end);
end;
$$;

-- Owned checkpoint (session_revocation / storage_cleanup only; the Apple checkpoint is written only by
-- settling its intent). Ownership and the Phase 1 write happen in one transaction.
create function public.set_owned_common_account_deletion_checkpoint(
  p_user_id uuid, p_operation_id uuid, p_lease uuid, p_checkpoint text, p_recorded boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  if p_checkpoint is null or p_checkpoint not in ('session_revocation', 'storage_cleanup') or p_recorded is null then
    raise exception 'ACCOUNT_LIFECYCLE_CHECKPOINT_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if p_recorded then
    return public.record_common_account_deletion_checkpoint(p_user_id, p_operation_id, p_checkpoint);
  end if;
  return public.clear_common_account_deletion_checkpoint(p_user_id, p_operation_id, p_checkpoint);
end;
$$;

-- Owned readiness: the Phase 1 decision, only for the current owner (same exclusive lock order).
create function public.prepare_owned_common_account_auth_delete(p_user_id uuid, p_operation_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  v_account := private.account_lifecycle_lock(p_user_id, false, true);
  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  return public.prepare_common_account_auth_delete(p_user_id, p_operation_id);
end;
$$;

-- 4. External-step intent (R1/R2/R3) -----------------------------------------------------------------

-- Records that the owner is about to call an external step that must not be repeated blindly.
--   apple_revocation    : refused once its checkpoint exists ('already_recorded').
--   managed_auth_delete : under the exclusive login lock -- refused while the release gate is blocked;
--                         otherwise the readiness is re-evaluated in full (any problem drops it, like
--                         prepare) and what the delete is decided against is kept as evidence.
create function public.begin_common_account_deletion_external_step(p_user_id uuid, p_operation_id uuid, p_lease uuid, p_step text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_problems text[];
  v_reason text;
begin
  if p_step is null or p_step not in ('apple_revocation', 'managed_auth_delete') then
    raise exception 'ACCOUNT_LIFECYCLE_STEP_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false, p_step = 'managed_auth_delete');
  if p_step = 'managed_auth_delete' then
    perform 1 from private.account_lifecycle_settings s for share;
  end if;
  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if v_operation.external_step is not null then
    return jsonb_build_object('status', 'step_in_flight', 'step', v_operation.external_step);
  end if;
  if p_step = 'apple_revocation' then
    if v_operation.checkpoints ? 'apple_revocation' then
      return jsonb_build_object('status', 'already_recorded');
    end if;
  else
    if not private.account_lifecycle_gate_open('managed_auth_delete') then
      select coalesce((select g.reason from private.account_lifecycle_release_gates g where g.gate = 'managed_auth_delete'), 'GATE_MISSING')
        into v_reason;
      update private.account_lifecycle_operations
         set last_error_code = 'MANAGED_AUTH_DELETE_RELEASE_BLOCKED', updated_at = now()
       where id = v_operation.id;
      return jsonb_build_object('status', 'release_blocked', 'reason', v_reason);
    end if;
    v_problems := private.account_lifecycle_authorization_problems(p_user_id, p_operation_id);
    if cardinality(v_problems) > 0 then
      update private.account_lifecycle_operations
         set current_step = 'cleanup', ready_at = null, ready_lifecycle_version = null,
             ready_requirement_epoch = null, ready_required_checkpoints = null,
             last_error_code = v_problems[1], updated_at = now()
       where id = v_operation.id;
      return jsonb_build_object('status', 'not_ready', 'reasons', to_jsonb(v_problems));
    end if;
    update private.account_lifecycle_operations
       set managed_delete_intent_at = now(),
           managed_delete_required_checkpoints = private.account_lifecycle_required_checkpoints(p_user_id),
           managed_delete_identity_providers = array(
             select distinct i.provider from auth.identities i where i.user_id = p_user_id order by 1),
           updated_at = now()
     where id = v_operation.id;
  end if;
  update private.account_lifecycle_operations
     set external_step = p_step, external_step_started_at = now(), external_step_fence = owner_fence,
         owner_lease_expires_at = now() + interval '600 seconds', updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'owned', 'fence', v_operation.owner_fence);
end;
$$;

-- Records the outcome the owner observed. Apple 'succeeded' writes the apple_revocation checkpoint and
-- clears the intent in one transaction; 'failed' (the provider said no) clears it so a new code may be
-- used. A managed Auth delete is settled here only as 'failed' (the login is still here: it was found
-- by its raw id under the lock); a successful one is settled by the read-back. A lost lease records
-- nothing, so the intent stays and is never replayed.
create function public.settle_common_account_deletion_external_step(
  p_user_id uuid, p_operation_id uuid, p_lease uuid, p_step text, p_outcome text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  if p_step is null or p_outcome is null
     or not ((p_step = 'apple_revocation' and p_outcome in ('succeeded', 'failed'))
             or (p_step = 'managed_auth_delete' and p_outcome = 'failed')) then
    raise exception 'ACCOUNT_LIFECYCLE_STEP_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if v_operation.external_step is distinct from p_step then
    return jsonb_build_object('status', 'step_mismatch');
  end if;
  update private.account_lifecycle_operations
     set checkpoints = case when p_outcome = 'succeeded' then checkpoints || jsonb_build_object('apple_revocation', now()) else checkpoints end,
         external_step = null, external_step_started_at = null, external_step_fence = null,
         last_error_code = case
           when p_outcome = 'succeeded' then null
           when p_step = 'apple_revocation' then 'APPLE_REVOKE_FAILED'
           else 'MANAGED_AUTH_DELETE_FAILED' end,
         updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', case when p_outcome = 'succeeded' then 'recorded' else 'cleared' end);
end;
$$;

-- Operator reconciliation of an Apple step whose outcome is unknown (never called by the Edge
-- Function): after checking with Apple out of band, record it as revoked, or clear it so the person can
-- re-authenticate with Apple and send a new code. Refused while an owner holds the deletion.
create function public.resolve_common_account_deletion_external_step(p_user_id uuid, p_operation_id uuid, p_resolution text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  if p_resolution is null or p_resolution not in ('apple_revoked', 'apple_not_revoked') then
    raise exception 'ACCOUNT_LIFECYCLE_RESOLUTION_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'account_deletion' and status = 'in_progress'
   for update;
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.owner_lease is not null and v_operation.owner_lease_expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;
  if v_operation.external_step is distinct from 'apple_revocation' then
    return jsonb_build_object('status', 'nothing_to_resolve');
  end if;
  update private.account_lifecycle_operations
     set checkpoints = case when p_resolution = 'apple_revoked' then checkpoints || jsonb_build_object('apple_revocation', now()) else checkpoints end,
         external_step = null, external_step_started_at = null, external_step_fence = null,
         owner_lease = null, owner_lease_expires_at = null,
         last_error_code = case when p_resolution = 'apple_revoked' then null else 'APPLE_REVOKE_FAILED' end,
         updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'resolved', 'resolution', p_resolution);
end;
$$;

-- 5. Verified completion (R3/R4) --------------------------------------------------------------------

-- What of the person this database can still see: an account or entitlement row, Kabumori / X / admin
-- data, or Storage ownership (an unreadable Storage shape counts too). Null = nothing.
create function private.account_lifecycle_residue(p_user_id uuid)
returns text language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_footprint jsonb;
  v_managed text[];
begin
  if exists (select 1 from public.common_accounts where user_id = p_user_id)
     or exists (select 1 from public.service_entitlements where user_id = p_user_id) then
    return 'RESIDUAL_ACCOUNT_STATE';
  end if;
  v_footprint := private.account_lifecycle_footprint(p_user_id);
  if (v_footprint ->> 'kabumori')::boolean or (v_footprint ->> 'x_autopost')::boolean
     or (v_footprint ->> 'x_foreign')::boolean or (v_footprint ->> 'admin')::boolean then
    return 'RESIDUAL_SERVICE_DATA';
  end if;
  -- MANAGED_STORAGE_OWNED, MANAGED_STORAGE_SHAPE_UNKNOWN or MANAGED_STORAGE_PROBE_FAILED.
  v_managed := private.account_lifecycle_managed_ownership(p_user_id);
  if cardinality(v_managed) > 0 then
    return v_managed[1];
  end if;
  return null;
end;
$$;

-- The post-delete read-back (orchestrator step 10). The only writer of a completed account deletion.
-- The operation is found by its id AND the subject hash of the verified person. First verification:
-- the login is gone; the guard closed the operation while its readiness was standing; the managed
-- delete intent was recorded (the orchestrator's path, not another route) against the same required
-- checkpoints as the readiness, and every one of them is recorded; nothing of the person remains. A
-- later call re-checks the residue NOW: 'completed' only when still clean, otherwise 'residue_found'
-- (the historical verification is kept). Anything else is 'not_verified' with a fixed reason kept on
-- the operation for an operator; it is never completed.
create function public.complete_common_account_deletion(p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_operation private.account_lifecycle_operations;
  v_reason text;
begin
  if p_user_id is null or p_operation_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ACCOUNT_LIFECYCLE_REQUIRES_READ_COMMITTED';
  end if;
  -- Only the operation row is locked: the login and the account row are expected to be gone. A login
  -- removal that is still uncommitted holds this row (its guard updated it), so this waits for it.
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and operation_type = 'account_deletion'
     and subject_sha256 = public.social_mobile_account_deletion_subject(p_user_id)
   for update;
  if not found or v_operation.status = 'aborted' then
    return jsonb_build_object('status', 'not_found');
  end if;
  if exists (select 1 from auth.users u where u.id = p_user_id) then
    return jsonb_build_object('status', 'login_present', 'login_deleted', false);
  end if;

  if v_operation.status = 'completed' then
    v_reason := private.account_lifecycle_residue(p_user_id);
    if v_reason is null then
      return jsonb_build_object('status', 'completed', 'operation_id', v_operation.id, 'login_deleted', true);
    end if;
    update private.account_lifecycle_operations
       set last_error_code = v_reason, updated_at = now()
     where id = v_operation.id;
    return jsonb_build_object('status', 'residue_found', 'reason', v_reason, 'login_deleted', true);
  end if;

  if v_operation.status <> 'login_removed' or v_operation.user_id is not null then
    -- The login is gone but the guard never closed this operation (or left its raw id behind).
    v_reason := 'LIFECYCLE_STATE_INCONSISTENT';
  elsif v_operation.managed_delete_intent_at is null or v_operation.external_step is distinct from 'managed_auth_delete' then
    -- Removed without the orchestrator's recorded managed delete (a legacy route, an operator).
    v_reason := 'LOGIN_REMOVED_WITHOUT_MANAGED_INTENT';
  elsif v_operation.current_step <> 'ready_for_managed_auth_delete' then
    v_reason := 'LOGIN_REMOVED_BEFORE_READY';
  elsif v_operation.ready_required_checkpoints is distinct from v_operation.managed_delete_required_checkpoints then
    v_reason := 'REQUIRED_CHECKPOINTS_CHANGED';
  elsif exists (select 1 from unnest(v_operation.managed_delete_required_checkpoints) k where not v_operation.checkpoints ? k) then
    v_reason := 'MANAGED_CHECKPOINTS_MISSING';
  else
    v_reason := private.account_lifecycle_residue(p_user_id);
  end if;

  if v_reason is not null then
    update private.account_lifecycle_operations
       set last_error_code = v_reason, updated_at = now()
     where id = v_operation.id;
    return jsonb_build_object('status', 'not_verified', 'reason', v_reason, 'login_deleted', true);
  end if;
  update private.account_lifecycle_operations
     set status = 'completed', verified_at = now(), last_error_code = null,
         external_step = null, external_step_started_at = null, external_step_fence = null,
         owner_lease = null, owner_lease_expires_at = null, updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'completed', 'operation_id', v_operation.id, 'login_deleted', true);
end;
$$;

-- 6. Storage inventory ------------------------------------------------------------------------------

-- What the person owns in Storage, for removal through the Storage API (never here). Read-only, like
-- private.account_lifecycle_managed_ownership: owner_id (text) and, where it still exists, the
-- deprecated uuid "owner" column. At most p_limit objects per call; `more` says that the caller must
-- remove these and call again. A bucket owned by the person is reported, not listed: the
-- orchestrator refuses it (operator). An unexpected shape or any read failure is never "empty".
create function private.account_lifecycle_storage_inventory(p_user_id uuid, p_limit integer)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_relation text;
  v_object_owner text := 'o.owner_id = $1';
  v_bucket_owner text := 'b.owner_id = $1';
  v_objects jsonb;
  v_more boolean;
  v_buckets boolean;
begin
  foreach v_relation in array array['storage.objects', 'storage.buckets'] loop
    if to_regclass(v_relation) is null or not exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass(v_relation) and a.attname = 'owner_id' and a.attnum > 0 and not a.attisdropped
    ) then
      return jsonb_build_object('status', 'unknown_shape');
    end if;
  end loop;
  if (select count(*) from pg_attribute a
       where a.attrelid = to_regclass('storage.objects') and a.attname in ('bucket_id', 'name')
         and a.attnum > 0 and not a.attisdropped) <> 2 then
    return jsonb_build_object('status', 'unknown_shape');
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = to_regclass('storage.objects') and a.attname = 'owner' and a.attnum > 0 and not a.attisdropped) then
    v_object_owner := v_object_owner || ' or o.owner::text = $1';
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = to_regclass('storage.buckets') and a.attname = 'owner' and a.attnum > 0 and not a.attisdropped) then
    v_bucket_owner := v_bucket_owner || ' or b.owner::text = $1';
  end if;
  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''bucket_id'', x.bucket_id, ''name'', x.name) order by x.bucket_id, x.name), ''[]''::jsonb)
       from (select o.bucket_id, o.name from storage.objects o where %s order by o.bucket_id, o.name limit $2) x',
    v_object_owner) into v_objects using p_user_id::text, p_limit;
  execute format('select count(*) > $2 from (select 1 from storage.objects o where %s limit $2 + 1) c', v_object_owner)
    into v_more using p_user_id::text, p_limit;
  execute format('select exists (select 1 from storage.buckets b where %s)', v_bucket_owner)
    into v_buckets using p_user_id::text;
  return jsonb_build_object('status', 'ok', 'objects', v_objects, 'more', v_more, 'buckets_owned', v_buckets);
exception when others then
  -- Could not read Storage (privilege, changed column type, ...): not empty.
  return jsonb_build_object('status', 'probe_failed');
end;
$$;

create function public.common_account_deletion_storage_objects(p_user_id uuid, p_limit integer default 1000)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_user_id is null then raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED'; end if;
  return private.account_lifecycle_storage_inventory(p_user_id, least(greatest(coalesce(p_limit, 1000), 1), 1000));
end;
$$;

-- 7. Operator visibility ----------------------------------------------------------------------------

-- Keeps the orchestrator's last fixed error code on the person's open account deletion. The code is
-- the only thing stored (^[A-Z][A-Z0-9_]{1,63}$, the column's own rule). It changes no step and no
-- readiness.
create function public.record_common_account_deletion_error(p_user_id uuid, p_operation_id uuid, p_error_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    raise exception 'ACCOUNT_LIFECYCLE_ERROR_CODE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  update private.account_lifecycle_operations
     set last_error_code = p_error_code, updated_at = now()
   where id = p_operation_id and user_id = p_user_id
     and operation_type = 'account_deletion' and status = 'in_progress';
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- 8. Grants -----------------------------------------------------------------------------------------

revoke all on function private.account_lifecycle_gate_open(text) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_owned_operation(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_residue(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_storage_inventory(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.common_account_deletion_release_gate() from public, anon, authenticated, service_role;
revoke all on function public.claim_common_account_deletion(uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.renew_common_account_deletion_claim(uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.release_common_account_deletion_claim(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_owned_common_account_deletion_checkpoint(uuid, uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.prepare_owned_common_account_auth_delete(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.begin_common_account_deletion_external_step(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.settle_common_account_deletion_external_step(uuid, uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.resolve_common_account_deletion_external_step(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.complete_common_account_deletion(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.common_account_deletion_storage_objects(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.record_common_account_deletion_error(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.common_account_deletion_release_gate() to service_role;
grant execute on function public.claim_common_account_deletion(uuid, uuid, integer) to service_role;
grant execute on function public.renew_common_account_deletion_claim(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.release_common_account_deletion_claim(uuid, uuid, uuid) to service_role;
grant execute on function public.set_owned_common_account_deletion_checkpoint(uuid, uuid, uuid, text, boolean) to service_role;
grant execute on function public.prepare_owned_common_account_auth_delete(uuid, uuid, uuid) to service_role;
grant execute on function public.begin_common_account_deletion_external_step(uuid, uuid, uuid, text) to service_role;
grant execute on function public.settle_common_account_deletion_external_step(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.resolve_common_account_deletion_external_step(uuid, uuid, text) to service_role;
grant execute on function public.complete_common_account_deletion(uuid, uuid) to service_role;
grant execute on function public.common_account_deletion_storage_objects(uuid, integer) to service_role;
grant execute on function public.record_common_account_deletion_error(uuid, uuid, text) to service_role;

commit;
