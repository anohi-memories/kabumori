-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is mandatory before any apply; apply as a
-- single reviewed file (never db push), after Phase 9 (20261015090000, PR #206) and BEFORE any Edge build that records
-- or acknowledges an X unconfirmed-post snapshot.
--
-- Common account Phase 10 (F5): the durable record of the X unconfirmed-post EVIDENCE SET, not only its size.
--
-- Why. F3's saga (PR #204, J3 V3 R1a) answers `done` with the pair (x_posts_unconfirmed, x_unconfirmed_snapshot): the
-- count of X posts whose result was never known AND an opaque SHA-256 name of the exact evidence set. The caller must
-- RECORD both in its own durable state and then acknowledge THAT snapshot (service_role RPC
-- social_mobile_account_deletion_x_unconfirmed_ack(user, snapshot)); a count-only acknowledgement clears nothing
-- (`snapshot_required`) because a count cannot tell two different sets of the same size apart (ABA). Phase 8 recorded the
-- count only (`record_owned_service_deletion_reconciliation`), which is not enough to bind an acknowledgement.
--
-- What this file does (additive; nothing existing is replaced or removed):
--   1. widens the shape of private.account_lifecycle_operations.reconciliation (Phase 8's CHECK) by ONE more key,
--      `x_unconfirmed_snapshots`: a JSON array of 1..16 distinct-by-construction 64-hex snapshot names, allowed only
--      together with `x_posts_unconfirmed` (>= 1). Every row that is valid today stays valid.
--   2. public.record_owned_service_deletion_x_unconfirmed(user, service, operation, lease, count, snapshot): the OWNER
--      records the pair it is about to acknowledge. The count is sticky at its maximum (as in Phase 8: evidence never
--      disappears); the snapshot is APPENDED (an acknowledgement of a set that is not on record is never sent);
--      the same snapshot twice is a no-op; a 17th distinct snapshot of one operation is refused (something is wrong).
--      Lease checked on the wall clock after the locks, exactly like the other owner recorders.
--   The read-back function of Phase 8 (common_account_service_end_result) already returns the whole `reconciliation`
--   object, so the snapshots are readable without changing it. The Phase 8 count-only recorder stays as it is (the
--   Phase 10 Edge code no longer calls it).
--
-- Lock order is unchanged (login KEY SHARE -> account FOR UPDATE -> operation row, via private.account_lifecycle_lock).
-- Not done: nothing calls X, Threads or Meta; no existing function, grant or trigger is touched.
begin;

do $$
begin
  if to_regprocedure('public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer)') is null
     or to_regprocedure('public.common_account_service_end_result(uuid,text)') is null
     or to_regprocedure('private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)') is null
     or to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)') is null
     or not exists (select 1 from pg_attribute a
                     where a.attrelid = to_regclass('private.account_lifecycle_operations') and a.attname = 'reconciliation'
                       and not a.attisdropped and a.atttypid = 'jsonb'::regtype and a.attnotnull) then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_PHASE8_MISSING';
  end if;
  if to_regprocedure('public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)') is not null then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_ALREADY_APPLIED';
  end if;
  -- The Phase 8 shape check must be there (either its own definition or this file's, left by a rollback that had to
  -- keep audit data); nothing else is ever overwritten.
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'private.account_lifecycle_operations'::regclass
                    and c.conname = 'account_lifecycle_operations_reconciliation_shape' and c.contype = 'c'
                    and pg_get_constraintdef(c.oid) like '%x_posts_unconfirmed%') then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_SHAPE';
  end if;
  if exists (select 1 from private.account_lifecycle_operations o
              where o.reconciliation - 'x_posts_unconfirmed' - 'x_unconfirmed_snapshots' <> '{}'::jsonb) then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_SHAPE';
  end if;
  if (select r.rolsuper from pg_roles r where r.rolname = current_user) is distinct from false
     or (select c.relowner from pg_class c where c.oid = 'private.account_lifecycle_operations'::regclass)
          is distinct from (select r.oid from pg_roles r where r.rolname = current_user) then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_OWNER';
  end if;
  -- The Phase 6 owner check this file builds on must still be owner-only.
  if exists (select 1 from pg_roles r
              where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                and has_function_privilege(r.oid, 'private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)'::regprocedure, 'EXECUTE')) then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_OWNER_CHECK_ACL';
  end if;
end;
$$;

-- 1. The shape: one more key, tied to the count ------------------------------------------------------------------
alter table private.account_lifecycle_operations drop constraint account_lifecycle_operations_reconciliation_shape;
alter table private.account_lifecycle_operations
  add constraint account_lifecycle_operations_reconciliation_shape check (
    jsonb_typeof(reconciliation) = 'object'
    and (reconciliation - 'x_posts_unconfirmed' - 'x_unconfirmed_snapshots') = '{}'::jsonb
    and (not reconciliation ? 'x_posts_unconfirmed' or jsonb_typeof(reconciliation -> 'x_posts_unconfirmed') = 'number')
    and (not reconciliation ? 'x_unconfirmed_snapshots' or coalesce(jsonb_path_match(reconciliation,
          'strict ($.x_posts_unconfirmed.type() == "number" && $.x_unconfirmed_snapshots.type() == "array" && $.x_unconfirmed_snapshots.size() >= 1 && $.x_unconfirmed_snapshots.size() <= 16 && !exists($.x_unconfirmed_snapshots[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{64}$"))))',
          '{}'::jsonb, true), false)));

-- 2. The owner records the pair it is about to acknowledge --------------------------------------------------------
create function public.record_owned_service_deletion_x_unconfirmed(
  p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid, p_count integer, p_snapshot text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_snapshots jsonb;
  v_count integer;
begin
  if p_service_key is distinct from 'x_autopost' then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_count is null or p_count < 1 or p_count > 100000 or p_snapshot is null or p_snapshot !~ '^[0-9a-f]{64}$' then
    raise exception 'ACCOUNT_LIFECYCLE_X_UNCONFIRMED_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  v_count := greatest(coalesce((v_operation.reconciliation ->> 'x_posts_unconfirmed')::integer, 0), p_count);
  v_snapshots := coalesce(v_operation.reconciliation -> 'x_unconfirmed_snapshots', '[]'::jsonb);
  if not (v_snapshots ? p_snapshot) then
    if jsonb_array_length(v_snapshots) >= 16 then
      raise exception 'ACCOUNT_LIFECYCLE_X_UNCONFIRMED_TOO_MANY';
    end if;
    v_snapshots := v_snapshots || to_jsonb(p_snapshot);
  end if;
  update private.account_lifecycle_operations
     set reconciliation = reconciliation || jsonb_build_object('x_posts_unconfirmed', v_count, 'x_unconfirmed_snapshots', v_snapshots),
         updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'recorded', 'count', v_count, 'snapshots', jsonb_array_length(v_snapshots));
end;
$$;

-- 3. Grants ------------------------------------------------------------------------------------------------------
revoke all on function public.record_owned_service_deletion_x_unconfirmed(uuid, text, uuid, uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.record_owned_service_deletion_x_unconfirmed(uuid, text, uuid, uuid, integer, text) to service_role;

do $$
declare
  v_fn regprocedure := 'public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)'::regprocedure;
begin
  if not has_function_privilege('service_role', v_fn, 'EXECUTE')
     or exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated', 'authenticator')
                  and (has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_has_role(r.oid, current_user, 'USAGE')))
     or has_function_privilege('public', v_fn, 'EXECUTE')
     or not exists (select 1 from pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_POSTCONDITION_ACL';
  end if;
end;
$$;

commit;
