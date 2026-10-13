-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is mandatory before any apply;
-- apply as a single reviewed file (never db push), after Phase 1/2/3a, the Phase 3b guard (20261010051938), the
-- Phase 4 fence (20261012130000) and the Phase 5 workspace state (20261012230000).
--
-- Common account Phase 6 (F5): an owner lease for the POSTONA-only service deletion, and a durable account of what
-- every provider answered.
--
-- Why. Phase 3a gave the WHOLE-ACCOUNT deletion one owner (a durable lease with a fence that the database re-checks
-- in the transaction of every write). The deletion of ONE service had none: begin_service_deletion /
-- finish_service_deletion were callable by any holder of the service role, so a request that lost its place (a
-- crash, a slow external call) could still end the `x_autopost` entitlement, and POSTONA's provider cleanup (X
-- through its saga, Threads through its adapter) had no owner to be fenced by. Two further gaps: nothing durable
-- said which providers were involved and what each answered (a result of "the remote grant was NOT verified
-- revoked" vanished with the request), and nothing tied a person's acknowledgement of that to the deletion.
--
-- What this file does.
--   1. service_deletion operations may carry an owner lease and fence (the scope constraint no longer forbids it;
--      external steps and the managed-delete intent stay account-deletion only).
--   2. public.claim_service_deletion / renew_service_deletion_claim / release_service_deletion_claim: the same
--      lease semantics as the account deletion's (unguessable lease, expiry by the WALL clock, a fence that
--      grows with every acquisition), for service `x_autopost`. Inside a whole-account deletion the claim
--      must present that deletion's own live lease (one chain of ownership); a POSTONA-only claim is refused
--      while an account deletion is open.
--   3. provider results (operations.provider_results): at the claim every platform connected in the person's
--      workspace, and always `x`, is recorded `pending`; the owner records each answer; a settled answer that
--      says the remote grant is unverified or confirmed revoked is never overwritten by a later "not
--      connected" (a retry must not erase the fact).
--   4. the acknowledgement: the person's explicit acceptance that a provider's remote authorization could not
--      be revoked by this system is recorded (when, which providers) BEFORE the cleanup that makes it so.
--   5. public.finish_owned_service_deletion: ends the entitlement only for the current owner, only when every
--      recorded provider is settled (no `pending`, no `blocked`, no `reconciliation_required`), `x` is among
--      them, and every remote grant reported unverified is acknowledged (a provider that answered
--      `local_removed_remote_unverified`, and a provider the person acknowledged whose only recorded answer is
--      "not connected": the removal committed and its answer was lost in a crash); then the unchanged Phase 1
--      finish (footprint read-back). abort_owned_service_deletion likewise.
--   6. public.finish_service_deletion / abort_service_deletion REFUSE `x_autopost` (OWNED_FINISH_REQUIRED /
--      OWNED_ABORT_REQUIRED): the only way to end or abort POSTONA is the owned path. Their Kabumori behavior is
--      unchanged (the Phase 1 bodies moved verbatim into private functions; the replaced bodies are pinned by
--      md5, drift refuses the apply).
--   7. public.common_account_provider_snapshot(user): which platforms the person's workspace holds (read only).
--   8. private.account_lifecycle_cleanup_authorized(user): the one predicate "a deletion of this person is in its
--      cleanup step and its owner's lease is live (wall clock)", for the owners of provider cleanup SQL to use
--      instead of reading the operations table themselves.
--
-- Not done here: it does not call X, Threads or Meta; it does not change the X saga or any Threads function; it
-- does not apply a grant to another owner's function; nothing touches Auth, Storage or Vault. A lease check is
-- still not a lock: an adapter's external call cannot be made atomic with it (see account-delete/provider_cleanup.ts).
--
-- Codes: claim -> acquired | in_progress | not_found | not_in_progress | lease_lost | blocked(reason);
-- record/ack -> recorded | lease_lost | not_found; finish -> ended | not_ready(reason) | lease_lost | the Phase 1 answers.

begin;

do $$
begin
  if to_regprocedure('public.begin_service_deletion(uuid,text)') is null
     or to_regprocedure('public.finish_service_deletion(uuid,text,uuid)') is null
     or to_regprocedure('public.abort_service_deletion(uuid,text,uuid)') is null
     or to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)') is null
     or to_regprocedure('private.account_lifecycle_owned_operation(uuid,uuid,uuid)') is null
     or to_regprocedure('public.social_mobile_account_deletion_workspace(uuid)') is null
     or to_regclass('private.account_lifecycle_operations') is null
     or to_regclass('public.social_accounts') is null then
    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  if (select count(*) from pg_attribute a
       where a.attrelid = 'private.account_lifecycle_operations'::regclass and not a.attisdropped
         and a.attname in ('owner_lease', 'owner_lease_expires_at', 'owner_fence', 'status', 'operation_type', 'service_key')) <> 6
     or not exists (select 1 from pg_attribute a where a.attrelid = 'public.social_accounts'::regclass
                      and a.attname in ('platform') and not a.attisdropped) then
    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_SHAPE';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname in ('claim_service_deletion', 'renew_service_deletion_claim',
                       'release_service_deletion_claim', 'record_owned_service_deletion_provider_result',
                       'acknowledge_owned_remote_unverified', 'finish_owned_service_deletion',
                       'abort_owned_service_deletion', 'common_account_provider_snapshot'))
                 or (n.nspname = 'private' and p.proname in ('account_lifecycle_cleanup_authorized',
                       'account_lifecycle_owned_service_operation', 'account_lifecycle_finish_service_deletion',
                       'account_lifecycle_abort_service_deletion'))) then
    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_ALREADY_APPLIED';
  end if;
  -- The two bodies this file replaces are the Phase 1 originals, byte for byte (copied verbatim below).
  if md5(pg_get_functiondef('public.finish_service_deletion(uuid,text,uuid)'::regprocedure)) <> 'c0384c8018d1d43e896223a279d0c510'
     or md5(pg_get_functiondef('public.abort_service_deletion(uuid,text,uuid)'::regprocedure)) <> '51e41e4d5006d9452311968ec8e4a70f' then
    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_LEGACY_DRIFT';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid = 'private.account_lifecycle_operations'::regclass
                  and c.conname = 'account_lifecycle_operations_owner_scope') then
    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_SCOPE_CONSTRAINT';
  end if;
end;
$$;

-- 1. Columns and the scope constraint ---------------------------------------------------------------

alter table private.account_lifecycle_operations
  drop constraint account_lifecycle_operations_owner_scope,
  drop constraint if exists account_lifecycle_operations_provider_results_shape,
  drop constraint if exists account_lifecycle_operations_ack_shape,
  add column if not exists provider_results jsonb not null default '{}'::jsonb,
  add column if not exists remote_unverified_ack_at timestamptz,
  add column if not exists remote_unverified_ack_providers text[],
  add constraint account_lifecycle_operations_owner_scope check (
    operation_type in ('account_deletion', 'service_deletion')
    and (operation_type = 'account_deletion' or (external_step is null and managed_delete_intent_at is null))),
  add constraint account_lifecycle_operations_provider_results_shape check (jsonb_typeof(provider_results) = 'object'),
  add constraint account_lifecycle_operations_ack_shape check (
    (remote_unverified_ack_at is null) = (remote_unverified_ack_providers is null));

-- 2. The Phase 1 finish / abort bodies, moved verbatim -------------------------------------------------

create function private.account_lifecycle_finish_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
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

create function private.account_lifecycle_abort_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
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

-- The legacy entry points keep Kabumori exactly as before and refuse POSTONA: it ends only through the owner.
create or replace function public.finish_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_service_key = 'x_autopost' then
    return jsonb_build_object('status', 'blocked', 'reason', 'OWNED_FINISH_REQUIRED');
  end if;
  return private.account_lifecycle_finish_service_deletion(p_user_id, p_service_key, p_operation_id);
end;
$$;

create or replace function public.abort_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_service_key = 'x_autopost' then
    return jsonb_build_object('status', 'blocked', 'reason', 'OWNED_ABORT_REQUIRED');
  end if;
  return private.account_lifecycle_abort_service_deletion(p_user_id, p_service_key, p_operation_id);
end;
$$;

-- 3. Ownership of a service deletion ------------------------------------------------------------------------

-- The person's open service deletion, locked, when p_lease is its current unexpired lease (WALL clock, so a
-- lease that ran out while this call waited for a lock is seen); null otherwise. The caller holds the account
-- lock already (lock order: login -> account -> operation).
create function private.account_lifecycle_owned_service_operation(p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid)
returns private.account_lifecycle_operations language plpgsql security definer set search_path = ''
as $$
declare
  v_operation private.account_lifecycle_operations;
begin
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'service_deletion'
     and service_key = p_service_key and status = 'in_progress'
   for update;
  if not found or p_lease is null or v_operation.owner_lease is distinct from p_lease
     or v_operation.owner_lease_expires_at <= clock_timestamp() then
    return null;
  end if;
  return v_operation;
end;
$$;

create function public.claim_service_deletion(
  p_user_id uuid, p_service_key text, p_operation_id uuid,
  p_account_operation_id uuid default null, p_account_lease uuid default null, p_lease_seconds integer default 600)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 600), 60), 900);
  v_lease uuid := gen_random_uuid();
  v_fence bigint;
  v_workspace text;
  v_pending jsonb;
begin
  if p_user_id is null or p_operation_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED';
  end if;
  if p_service_key is distinct from 'x_autopost' then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  select * into v_operation from private.account_lifecycle_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'service_deletion' and service_key = p_service_key
   for update;
  if not found or v_account.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_operation.status <> 'in_progress' then
    return jsonb_build_object('status', 'not_in_progress');
  end if;
  if p_account_operation_id is not null then
    -- Inside a whole-account deletion: the caller presents that deletion's own live lease.
    if private.account_lifecycle_owned_operation(p_user_id, p_account_operation_id, p_account_lease) is null then
      return jsonb_build_object('status', 'lease_lost');
    end if;
  elsif v_account.status <> 'active'
        or exists (select 1 from private.account_lifecycle_operations o
                    where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then
    return jsonb_build_object('status', 'blocked', 'reason', 'ACCOUNT_DELETION_IN_PROGRESS');
  end if;
  if not exists (select 1 from public.service_entitlements e
                  where e.user_id = p_user_id and e.service_key = p_service_key and e.status = 'deleting') then
    return jsonb_build_object('status', 'blocked', 'reason', 'LIFECYCLE_STATE_INCONSISTENT');
  end if;
  if v_operation.owner_lease is not null and v_operation.owner_lease_expires_at > clock_timestamp() then
    return jsonb_build_object('status', 'in_progress');
  end if;
  -- The providers involved: X always, and every other platform connected in the person's workspace.
  v_workspace := public.social_mobile_account_deletion_workspace(p_user_id);
  select coalesce(jsonb_object_agg(x.platform, 'pending'), '{}'::jsonb) into v_pending
    from (select 'x' as platform
          union
          select a.platform from public.social_accounts a where a.brand_id = v_workspace and a.platform is not null) x;
  update private.account_lifecycle_operations
     set owner_lease = v_lease, owner_lease_expires_at = clock_timestamp() + make_interval(secs => v_seconds),
         owner_fence = owner_fence + 1,
         provider_results = v_pending || provider_results,   -- what was already answered wins
         updated_at = now()
   where id = v_operation.id
  returning owner_fence into v_fence;
  return jsonb_build_object('status', 'acquired', 'lease', v_lease, 'fence', v_fence,
    'provider_results', (select provider_results from private.account_lifecycle_operations where id = v_operation.id));
end;
$$;

create function public.renew_service_deletion_claim(
  p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid, p_lease_seconds integer default 600)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update private.account_lifecycle_operations
     set owner_lease_expires_at = clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 600), 60), 900)),
         updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'owned', 'fence', v_operation.owner_fence);
end;
$$;

create function public.release_service_deletion_claim(p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if p_user_id is null or p_operation_id is null or p_lease is null then
    raise exception 'ACCOUNT_LIFECYCLE_USER_REQUIRED';
  end if;
  update private.account_lifecycle_operations
     set owner_lease = null, owner_lease_expires_at = null, updated_at = now()
   where id = p_operation_id and operation_type = 'service_deletion' and service_key = p_service_key
     and owner_lease = p_lease and subject_sha256 = public.social_mobile_account_deletion_subject(p_user_id);
  return jsonb_build_object('status', case when found then 'released' else 'not_owned' end);
end;
$$;

-- 4. What each provider answered, and the person's acknowledgement ------------------------------------------

create function public.record_owned_service_deletion_provider_result(
  p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid, p_provider text, p_result text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_existing text;
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,31}$'
     or p_result is null or p_result not in ('pending', 'done', 'not_connected', 'confirmed_remote_revoked',
                                            'local_removed_remote_unverified', 'reconciliation_required', 'blocked') then
    raise exception 'ACCOUNT_LIFECYCLE_PROVIDER_RESULT_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  v_existing := v_operation.provider_results ->> p_provider;
  -- A fact is not erased by a later answer: after the local data is gone a retry can only say "not connected"
  -- (or even something worse), and "the remote grant was not verified revoked" must stay on the record. The
  -- only change allowed to such a fact is the upgrade of "unverified" to "confirmed revoked".
  if v_existing in ('local_removed_remote_unverified', 'confirmed_remote_revoked')
     and p_result is distinct from 'confirmed_remote_revoked' then
    return jsonb_build_object('status', 'recorded', 'kept', v_existing);
  end if;
  update private.account_lifecycle_operations
     set provider_results = provider_results || jsonb_build_object(p_provider, p_result), updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'recorded');
end;
$$;

create function public.acknowledge_owned_remote_unverified(
  p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid, p_providers text[])
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
begin
  if p_providers is null or cardinality(p_providers) = 0 or exists (
       select 1 from unnest(p_providers) p where p is null or p !~ '^[a-z][a-z0-9_]{1,31}$' or p = 'x') then
    raise exception 'ACCOUNT_LIFECYCLE_PROVIDER_RESULT_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  update private.account_lifecycle_operations
     set remote_unverified_ack_at = coalesce(remote_unverified_ack_at, now()),
         remote_unverified_ack_providers = (select array_agg(distinct p order by p)
                                              from unnest(coalesce(remote_unverified_ack_providers, '{}'::text[]) || p_providers) p),
         updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'recorded');
end;
$$;

-- 5. The owned end ------------------------------------------------------------------------------------------

create function public.finish_owned_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_unsettled text[];
  v_unverified text[];
  v_answer jsonb;
begin
  if p_service_key is distinct from 'x_autopost' then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  -- X is always accounted for, and no recorded provider may be pending, blocked or unreconciled.
  if not (v_operation.provider_results ? 'x') then
    return jsonb_build_object('status', 'not_ready', 'reason', 'PROVIDER_RESULTS_UNSETTLED', 'providers', jsonb_build_array('x'));
  end if;
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_unsettled
    from jsonb_each_text(v_operation.provider_results) r(k, v)
   where v not in ('done', 'not_connected', 'confirmed_remote_revoked', 'local_removed_remote_unverified');
  if cardinality(v_unsettled) > 0 then
    return jsonb_build_object('status', 'not_ready', 'reason', 'PROVIDER_RESULTS_UNSETTLED', 'providers', to_jsonb(v_unsettled));
  end if;
  -- What stays unverified at the remote: every provider that answered "local removed, remote unverified", and
  -- every provider the person acknowledged for which only "not connected" is on record: the removal committed and
  -- its answer was never recorded (a crash in between), so a retry could say nothing more. Never "revoked".
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_unverified
    from jsonb_each_text(v_operation.provider_results) r(k, v)
   where v = 'local_removed_remote_unverified'
      or (v = 'not_connected' and k = any (coalesce(v_operation.remote_unverified_ack_providers, '{}'::text[])));
  if cardinality(v_unverified) > 0
     and (v_operation.remote_unverified_ack_at is null
          or not (v_unverified <@ coalesce(v_operation.remote_unverified_ack_providers, '{}'::text[]))) then
    return jsonb_build_object('status', 'not_ready', 'reason', 'REMOTE_UNVERIFIED_NOT_ACKNOWLEDGED', 'providers', to_jsonb(v_unverified));
  end if;
  v_answer := private.account_lifecycle_finish_service_deletion(p_user_id, p_service_key, p_operation_id);
  if v_answer ->> 'status' = 'ended' then
    update private.account_lifecycle_operations
       set owner_lease = null, owner_lease_expires_at = null, updated_at = now()
     where id = p_operation_id;
    return v_answer || jsonb_build_object('provider_results', v_operation.provider_results,
                                          'remote_unverified', to_jsonb(v_unverified));
  end if;
  return v_answer;
end;
$$;

create function public.abort_owned_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_answer jsonb;
begin
  if p_service_key is distinct from 'x_autopost' then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  v_answer := private.account_lifecycle_abort_service_deletion(p_user_id, p_service_key, p_operation_id);
  if v_answer ->> 'status' = 'aborted' then
    update private.account_lifecycle_operations
       set owner_lease = null, owner_lease_expires_at = null, updated_at = now()
     where id = p_operation_id;
  end if;
  return v_answer;
end;
$$;

-- 6. Reads ---------------------------------------------------------------------------------------------------

create function public.common_account_provider_snapshot(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'workspace', public.social_mobile_account_deletion_workspace(p_user_id),
    'platforms', coalesce((select jsonb_agg(distinct a.platform order by a.platform)
                             from public.social_accounts a
                            where a.brand_id = public.social_mobile_account_deletion_workspace(p_user_id)
                              and a.platform is not null), '[]'::jsonb))
$$;

-- "A deletion of this person is in its cleanup step and its owner's lease is live" -- for the owners of
-- provider cleanup SQL (Threads, later others). The wall clock, not the transaction start.
create function private.account_lifecycle_cleanup_authorized(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from private.account_lifecycle_operations o
     where o.user_id = p_user_id and o.status = 'in_progress'
       and o.owner_lease is not null and o.owner_lease_expires_at > clock_timestamp()
       and ((o.operation_type = 'account_deletion' and o.current_step = 'cleanup')
            or (o.operation_type = 'service_deletion' and o.service_key = 'x_autopost')))
$$;

-- 7. Grants ----------------------------------------------------------------------------------------------------

revoke all on function private.account_lifecycle_finish_service_deletion(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_abort_service_deletion(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_owned_service_operation(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_cleanup_authorized(uuid) from public, anon, authenticated, service_role;
revoke all on function public.claim_service_deletion(uuid, text, uuid, uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.renew_service_deletion_claim(uuid, text, uuid, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.release_service_deletion_claim(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_owned_service_deletion_provider_result(uuid, text, uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_owned_remote_unverified(uuid, text, uuid, uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.finish_owned_service_deletion(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.abort_owned_service_deletion(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.common_account_provider_snapshot(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_service_deletion(uuid, text, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.renew_service_deletion_claim(uuid, text, uuid, uuid, integer) to service_role;
grant execute on function public.release_service_deletion_claim(uuid, text, uuid, uuid) to service_role;
grant execute on function public.record_owned_service_deletion_provider_result(uuid, text, uuid, uuid, text, text) to service_role;
grant execute on function public.acknowledge_owned_remote_unverified(uuid, text, uuid, uuid, text[]) to service_role;
grant execute on function public.finish_owned_service_deletion(uuid, text, uuid, uuid) to service_role;
grant execute on function public.abort_owned_service_deletion(uuid, text, uuid, uuid) to service_role;
grant execute on function public.common_account_provider_snapshot(uuid) to service_role;

-- Postcondition: the private functions are owner-only, the public ones service_role only (no other API role,
-- no membership), the replaced legacy functions keep service_role and nobody else.
do $$
declare
  v_private regprocedure[] := array[
    'private.account_lifecycle_finish_service_deletion(uuid,text,uuid)'::regprocedure,
    'private.account_lifecycle_abort_service_deletion(uuid,text,uuid)'::regprocedure,
    'private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)'::regprocedure,
    'private.account_lifecycle_cleanup_authorized(uuid)'::regprocedure];
  v_public regprocedure[] := array[
    'public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)'::regprocedure,
    'public.renew_service_deletion_claim(uuid,text,uuid,uuid,integer)'::regprocedure,
    'public.release_service_deletion_claim(uuid,text,uuid,uuid)'::regprocedure,
    'public.record_owned_service_deletion_provider_result(uuid,text,uuid,uuid,text,text)'::regprocedure,
    'public.acknowledge_owned_remote_unverified(uuid,text,uuid,uuid,text[])'::regprocedure,
    'public.finish_owned_service_deletion(uuid,text,uuid,uuid)'::regprocedure,
    'public.abort_owned_service_deletion(uuid,text,uuid,uuid)'::regprocedure,
    'public.common_account_provider_snapshot(uuid)'::regprocedure,
    'public.finish_service_deletion(uuid,text,uuid)'::regprocedure,
    'public.abort_service_deletion(uuid,text,uuid)'::regprocedure];
  v_fn regprocedure;
begin
  foreach v_fn in array v_private loop
    if (select array_to_string(p.proacl::text[], ',') from pg_proc p where p.oid = v_fn)
         is distinct from format('%s=X/%s', quote_ident(current_user), quote_ident(current_user))
       or exists (select 1 from pg_roles r
                   where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                     and (has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_has_role(r.oid, current_user, 'USAGE')))
       or not exists (select 1 from pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_POSTCONDITION_ACL';
    end if;
  end loop;
  foreach v_fn in array v_public loop
    if not has_function_privilege('service_role', v_fn, 'EXECUTE')
       or exists (select 1 from pg_roles r
                   where r.rolname in ('anon', 'authenticated', 'authenticator') and has_function_privilege(r.oid, v_fn, 'EXECUTE'))
       or has_function_privilege('public', v_fn, 'EXECUTE')
       or not exists (select 1 from pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_POSTCONDITION_PUBLIC_ACL';
    end if;
  end loop;
end;
$$;

commit;
