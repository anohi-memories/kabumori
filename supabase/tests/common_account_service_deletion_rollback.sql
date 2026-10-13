-- Emergency rollback for 20261013120000_common_account_service_deletion_ownership. Disposable proof and
-- reviewed operator use only; never applied automatically.
--
-- Puts the Phase 1 finish / abort back (their bodies were moved verbatim into private functions, which are
-- then dropped), drops the owner-lease functions and restores the old scope constraint. It KEEPS the added
-- columns (provider_results, remote_unverified_ack_*): they are additive and hold the audit of what each
-- provider answered and what the person acknowledged; the apply uses `add column if not exists`, so it can be
-- applied again. Refuses while any service deletion still holds a lease (a running owner must end or release
-- it first): COMMON_ACCOUNT_SERVICE_OWNERSHIP_ROLLBACK_LEASES_OPEN. Never uses CASCADE. Callers of the
-- dropped functions (an Edge function registered against them) fail closed.
begin;

do $$
begin
  if to_regprocedure('public.finish_owned_service_deletion(uuid,text,uuid,uuid)') is null then
    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_ROLLBACK_NOT_APPLIED';
  end if;
  if exists (select 1 from private.account_lifecycle_operations o
              where o.operation_type = 'service_deletion' and o.status = 'in_progress' and o.owner_lease is not null) then
    raise exception 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_ROLLBACK_LEASES_OPEN';
  end if;
end;
$$;

-- The scope constraint first: it is what forbids a lease on a service deletion.
update private.account_lifecycle_operations
   set owner_lease = null, owner_lease_expires_at = null, owner_fence = 0
 where operation_type = 'service_deletion' and (owner_lease is not null or owner_fence <> 0);
alter table private.account_lifecycle_operations drop constraint account_lifecycle_operations_owner_scope;
alter table private.account_lifecycle_operations add constraint account_lifecycle_operations_owner_scope check (
  operation_type = 'account_deletion'
  or (owner_lease is null and owner_fence = 0 and external_step is null and managed_delete_intent_at is null));

-- The Phase 1 bodies, as they were.
create or replace function public.finish_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
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

create or replace function public.abort_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid)
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

drop function public.finish_owned_service_deletion(uuid, text, uuid, uuid);
drop function public.abort_owned_service_deletion(uuid, text, uuid, uuid);
drop function public.acknowledge_owned_remote_unverified(uuid, text, uuid, uuid, text[]);
drop function public.record_owned_service_deletion_provider_result(uuid, text, uuid, uuid, text, text);
drop function public.release_service_deletion_claim(uuid, text, uuid, uuid);
drop function public.renew_service_deletion_claim(uuid, text, uuid, uuid, integer);
drop function public.claim_service_deletion(uuid, text, uuid, uuid, uuid, integer);
drop function public.common_account_provider_snapshot(uuid);
drop function private.account_lifecycle_cleanup_authorized(uuid);
drop function private.account_lifecycle_owned_service_operation(uuid, text, uuid, uuid);
drop function private.account_lifecycle_finish_service_deletion(uuid, text, uuid);
drop function private.account_lifecycle_abort_service_deletion(uuid, text, uuid);

commit;
