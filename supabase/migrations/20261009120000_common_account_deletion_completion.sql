-- SOURCE CANDIDATE ONLY. NOT applied to production. Apply as a single reviewed file (never db push),
-- after Phase 1 (20261001150000) and Phase 2 (20261006230000), and BEFORE the lifecycle-aware
-- `account-delete` Edge Function is deployed (that function calls the RPCs added here).
--
-- Common account Phase 3a: the database half of the whole-account deletion orchestrator.
-- Design: docs/common-account/phase3a-deletion-orchestrator.md.
--
--   1. Verified completion (Phase 1 doc, section 10 step 9). Phase 1 has no state that says a whole
--      account was deleted: its operations table refuses status 'completed' for an account deletion,
--      and the Auth-delete guard records a removed login only as an unverified observation
--      ('login_removed'). This file allows 'completed' for an account deletion ONLY together with a
--      verification time, a cleared user id and a readiness that was standing when the login
--      disappeared, and adds the one function that writes it:
--      public.complete_common_account_deletion(user, operation) -- a post-delete read-back.
--   2. Storage inventory. Storage records an object's owner as plain text and its API cannot list by
--      owner. public.common_account_deletion_storage_objects(user, limit) returns the (bucket, name)
--      of the person's objects, read-only, so the orchestrator can remove them THROUGH THE STORAGE API
--      and list again until nothing is left.
--   3. Operator visibility. public.record_common_account_deletion_error(user, operation, code) keeps a
--      fixed error code on an open account deletion (no message, no personal data).
--
-- Every function is SECURITY DEFINER with an empty search_path and executable by service_role only;
-- p_user_id is the id the Edge Function verified from the person's own token. Nothing here writes to
-- auth, storage or vault, removes a login, or changes the Auth-delete guard (it stays 'shadow').
-- Lock order is unchanged (auth.users -> common_accounts -> settings -> operation).

begin;

do $$
declare
  v_matches integer;
begin
  if to_regprocedure('public.prepare_common_account_auth_delete(uuid,uuid)') is null
     or to_regprocedure('public.record_common_account_deletion_checkpoint(uuid,uuid,text)') is null
     or to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)') is null
     or to_regprocedure('private.account_lifecycle_footprint(uuid)') is null
     or to_regprocedure('private.account_lifecycle_managed_ownership(uuid)') is null
     or to_regprocedure('private.account_lifecycle_guard_account_delete()') is null
     or to_regprocedure('public.social_mobile_account_deletion_subject(uuid)') is null
     or to_regprocedure('public.reactivate_kabumori_service(bigint)') is null
     or to_regclass('private.account_lifecycle_operations') is null
     or to_regclass('private.account_lifecycle_settings') is null then
    raise exception 'COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING';
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'private.account_lifecycle_operations'::regclass and a.attname = 'verified_at'
                and a.attnum > 0 and not a.attisdropped)
     or to_regprocedure('public.complete_common_account_deletion(uuid,uuid)') is not null
     or to_regprocedure('public.common_account_deletion_storage_objects(uuid,integer)') is not null
     or to_regprocedure('public.record_common_account_deletion_error(uuid,uuid,text)') is not null
     or to_regprocedure('private.account_lifecycle_storage_inventory(uuid,integer)') is not null then
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

-- 1. Verified completion --------------------------------------------------------------------------

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
  -- When the post-delete read-back confirmed the deletion. Set only by complete_common_account_deletion.
  add column verified_at timestamptz,
  -- A whole-account deletion is 'completed' only after verification, only once the login is gone
  -- (the guard cleared the raw id), and only if it was ready when the login disappeared. The
  -- readiness binding (ready_*) is kept as the audit of what the removal was decided against.
  add constraint account_lifecycle_operations_completed_shape check (
    status <> 'completed' or operation_type = 'service_deletion'
    or (user_id is null and verified_at is not null and current_step = 'ready_for_managed_auth_delete')),
  add constraint account_lifecycle_operations_verified_shape check (
    verified_at is null or (operation_type = 'account_deletion' and status = 'completed'));

-- The post-delete read-back (orchestrator step 10). The only writer of a completed account deletion.
-- The operation is found by its id AND the subject hash of the verified person, so naming another
-- person's operation finds nothing. It reports 'completed' only when the login is gone, the guard
-- closed the operation while its readiness was standing, and nothing of the person remains that this
-- database can see: no account or entitlement row, no Kabumori or X service data, no admin row, no
-- Storage ownership. Anything else is 'not_verified' with a fixed reason; it is never completed and
-- the reason is kept on the operation for an operator. Calling it again is safe.
create function public.complete_common_account_deletion(p_user_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_operation private.account_lifecycle_operations;
  v_footprint jsonb;
  v_managed text[];
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
  if v_operation.status = 'completed' then
    return jsonb_build_object('status', 'completed', 'operation_id', v_operation.id, 'login_deleted', true);
  end if;
  if exists (select 1 from auth.users u where u.id = p_user_id) then
    return jsonb_build_object('status', 'login_present', 'login_deleted', false);
  end if;

  if v_operation.status <> 'login_removed' or v_operation.user_id is not null then
    -- The login is gone but the guard never closed this operation (or left its raw id behind).
    v_reason := 'LIFECYCLE_STATE_INCONSISTENT';
  elsif v_operation.current_step <> 'ready_for_managed_auth_delete' then
    -- Removed while not ready: not by the orchestrator's authorized path (a legacy route, an operator).
    v_reason := 'LOGIN_REMOVED_BEFORE_READY';
  elsif exists (select 1 from public.common_accounts where user_id = p_user_id)
     or exists (select 1 from public.service_entitlements where user_id = p_user_id) then
    v_reason := 'RESIDUAL_ACCOUNT_STATE';
  else
    v_footprint := private.account_lifecycle_footprint(p_user_id);
    if (v_footprint ->> 'kabumori')::boolean or (v_footprint ->> 'x_autopost')::boolean
       or (v_footprint ->> 'x_foreign')::boolean or (v_footprint ->> 'admin')::boolean then
      v_reason := 'RESIDUAL_SERVICE_DATA';
    else
      -- MANAGED_STORAGE_OWNED, MANAGED_STORAGE_SHAPE_UNKNOWN or MANAGED_STORAGE_PROBE_FAILED.
      v_managed := private.account_lifecycle_managed_ownership(p_user_id);
      if cardinality(v_managed) > 0 then
        v_reason := v_managed[1];
      end if;
    end if;
  end if;

  if v_reason is not null then
    update private.account_lifecycle_operations
       set last_error_code = v_reason, updated_at = now()
     where id = v_operation.id;
    return jsonb_build_object('status', 'not_verified', 'reason', v_reason, 'login_deleted', true);
  end if;
  update private.account_lifecycle_operations
     set status = 'completed', verified_at = now(), last_error_code = null, updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'completed', 'operation_id', v_operation.id, 'login_deleted', true);
end;
$$;

-- 2. Storage inventory ----------------------------------------------------------------------------

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

-- 3. Operator visibility --------------------------------------------------------------------------

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

-- 4. Grants ---------------------------------------------------------------------------------------

revoke all on function private.account_lifecycle_storage_inventory(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_common_account_deletion(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.common_account_deletion_storage_objects(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.record_common_account_deletion_error(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.complete_common_account_deletion(uuid, uuid) to service_role;
grant execute on function public.common_account_deletion_storage_objects(uuid, integer) to service_role;
grant execute on function public.record_common_account_deletion_error(uuid, uuid, text) to service_role;

commit;
