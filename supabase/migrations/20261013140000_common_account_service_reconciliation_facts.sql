-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is mandatory before any apply; apply as a
-- single reviewed file (never db push), after Phase 6 (20261013120000, PR #178).
--
-- Common account Phase 8 (F5): a durable place for facts that a service end must not lose, and a way to read the
-- result of an end back.
--
-- Why. F3's X saga (PR #189) answers `done` together with `x_posts_unconfirmed: n` -- X posts whose result was never
-- known (the person may have to check X). Phase 6 recorded only a word per provider (`done`): the count lived in one
-- request's memory, so a crash between the saga's answer and the end, or a retry that found the entitlement already
-- ended, hid it (J3 V3: "an apparently clean completion after an unknown publish result"). Phase 6 also had no read
-- of what an end finally said once the request was gone.
--
-- What this file does (additive; nothing existing is replaced):
--   1. private.account_lifecycle_operations.reconciliation jsonb (object, default {}): durable facts of an operation.
--   2. public.record_owned_service_deletion_reconciliation(user, service, operation, lease, fact, count): the OWNER
--      records a fact (only `x_posts_unconfirmed` exists), as a count 1..100000, sticky at its maximum: a later
--      attempt that sees a smaller number (the saga forgot) can never lower it. Lease checked on the wall clock
--      after the locks, exactly like the provider results.
--   3. public.common_account_service_end_result(user, service): STABLE, service_role only. What the person's latest
--      end of that service says -- status, provider results, which remote grants stay UNVERIFIED (the same rule the
--      end applied), the acknowledgement, the reconciliation facts -- or {status:'none'}. It never decides anything;
--      it lets a retry, a second device and an operator read the same answer.
--
-- Lock order is unchanged (login KEY SHARE -> account FOR UPDATE -> operation row, via private.account_lifecycle_lock).
-- Not done: nothing calls X, Threads or Meta; no existing function, grant or constraint is touched.
begin;

do $$
begin
  if to_regprocedure('public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)') is null
     or to_regprocedure('public.finish_owned_service_deletion(uuid,text,uuid,uuid)') is null
     or to_regprocedure('private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)') is null
     or to_regprocedure('private.account_lifecycle_lock(uuid,boolean,boolean)') is null
     or to_regclass('private.account_lifecycle_operations') is null then
    raise exception 'COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_PHASE6_MISSING';
  end if;
  if (select count(*) from pg_attribute a
       where a.attrelid = 'private.account_lifecycle_operations'::regclass and not a.attisdropped
         and a.attname in ('provider_results', 'remote_unverified_ack_at', 'remote_unverified_ack_providers',
                           'owner_lease', 'owner_lease_expires_at', 'service_key', 'operation_type', 'status')) <> 8 then
    raise exception 'COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_SHAPE';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('record_owned_service_deletion_reconciliation', 'common_account_service_end_result')) then
    raise exception 'COMMON_ACCOUNT_RECONCILIATION_ALREADY_APPLIED';
  end if;
  -- A `reconciliation` column that is already there is accepted only in exactly the shape this file creates (what a
  -- rollback of this file leaves behind, with its audit data): any other same-named column is refused, never adopted.
  if exists (select 1 from pg_attribute a where a.attrelid = 'private.account_lifecycle_operations'::regclass
                and a.attname = 'reconciliation' and not a.attisdropped)
     and not (exists (select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                       where a.attrelid = 'private.account_lifecycle_operations'::regclass and a.attname = 'reconciliation'
                         and not a.attisdropped and a.atttypid = 'jsonb'::regtype and a.attnotnull
                         and pg_get_expr(d.adbin, d.adrelid) = '''{}''::jsonb')
              and exists (select 1 from pg_constraint c where c.conrelid = 'private.account_lifecycle_operations'::regclass
                            and c.conname = 'account_lifecycle_operations_reconciliation_shape' and c.contype = 'c')) then
    raise exception 'COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_SHAPE';
  end if;
  -- The Phase 6 owner check this file builds on must still be owner-only (an API role reaching it would let a
  -- caller present someone else's lease).
  if exists (select 1 from pg_roles r
              where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
                and has_function_privilege(r.oid, 'private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)'::regprocedure, 'EXECUTE')) then
    raise exception 'COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_OWNER_CHECK_ACL';
  end if;
end;
$$;

-- 1. The durable facts -------------------------------------------------------------------------------------------

do $$
begin
  -- Added once; a rollback of this file keeps the column (and its audit data), so a re-apply finds it (shape checked above).
  if not exists (select 1 from pg_attribute a where a.attrelid = 'private.account_lifecycle_operations'::regclass
                   and a.attname = 'reconciliation' and not a.attisdropped) then
    alter table private.account_lifecycle_operations
      add column reconciliation jsonb not null default '{}'::jsonb,
      add constraint account_lifecycle_operations_reconciliation_shape check (
        jsonb_typeof(reconciliation) = 'object'
        and (reconciliation - 'x_posts_unconfirmed') = '{}'::jsonb
        and (not reconciliation ? 'x_posts_unconfirmed' or jsonb_typeof(reconciliation -> 'x_posts_unconfirmed') = 'number'));
  end if;
end;
$$;

-- 2. The owner records a fact ------------------------------------------------------------------------------------

create function public.record_owned_service_deletion_reconciliation(
  p_user_id uuid, p_service_key text, p_operation_id uuid, p_lease uuid, p_fact text, p_count integer)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_account public.common_accounts;
  v_operation private.account_lifecycle_operations;
  v_existing integer;
begin
  if p_service_key is distinct from 'x_autopost' then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';
  end if;
  if p_fact is distinct from 'x_posts_unconfirmed' or p_count is null or p_count < 1 or p_count > 100000 then
    raise exception 'ACCOUNT_LIFECYCLE_RECONCILIATION_FACT_INVALID';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  v_operation := private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease);
  if v_operation.id is null or v_account.user_id is null then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  v_existing := coalesce((v_operation.reconciliation ->> p_fact)::integer, 0);
  update private.account_lifecycle_operations
     set reconciliation = reconciliation || jsonb_build_object(p_fact, greatest(v_existing, p_count)), updated_at = now()
   where id = v_operation.id;
  return jsonb_build_object('status', 'recorded', 'count', greatest(v_existing, p_count));
end;
$$;

-- 3. What an end said, readable afterwards -----------------------------------------------------------------------

create function public.common_account_service_end_result(p_user_id uuid, p_service_key text default 'x_autopost')
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_operation private.account_lifecycle_operations;
begin
  if p_service_key is distinct from 'x_autopost' then
    return jsonb_build_object('status', 'none');
  end if;
  select * into v_operation from private.account_lifecycle_operations o
   where o.user_id = p_user_id and o.operation_type = 'service_deletion' and o.service_key = p_service_key
   order by o.updated_at desc, o.id limit 1;
  if v_operation.id is null then
    return jsonb_build_object('status', 'none');
  end if;
  return jsonb_build_object(
    'status', v_operation.status,
    'operation_id', v_operation.id,
    'provider_results', v_operation.provider_results,
    -- the rule of finish_owned_service_deletion: an answer of "unverified", and an acknowledged provider whose only
    -- recorded answer is "not connected" (the removal's answer was lost)
    'remote_unverified', coalesce((
      select jsonb_agg(r.k order by r.k)
        from jsonb_each_text(v_operation.provider_results) r(k, v)
       where r.v = 'local_removed_remote_unverified'
          or (r.v = 'not_connected' and r.k = any (coalesce(v_operation.remote_unverified_ack_providers, '{}'::text[])))), '[]'::jsonb),
    'acknowledged', to_jsonb(coalesce(v_operation.remote_unverified_ack_providers, '{}'::text[])),
    'reconciliation', v_operation.reconciliation,
    'finished_at', v_operation.finished_at);
end;
$$;

-- 4. Grants ----------------------------------------------------------------------------------------------------

revoke all on function public.record_owned_service_deletion_reconciliation(uuid, text, uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.common_account_service_end_result(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.record_owned_service_deletion_reconciliation(uuid, text, uuid, uuid, text, integer) to service_role;
grant execute on function public.common_account_service_end_result(uuid, text) to service_role;

do $$
declare
  v_fn regprocedure;
begin
  foreach v_fn in array array[
    'public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer)'::regprocedure,
    'public.common_account_service_end_result(uuid,text)'::regprocedure] loop
    if not has_function_privilege('service_role', v_fn, 'EXECUTE')
       or exists (select 1 from pg_roles r where r.rolname in ('anon', 'authenticated', 'authenticator')
                    and (has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_has_role(r.oid, current_user, 'USAGE')))
       or has_function_privilege('public', v_fn, 'EXECUTE')
       or not exists (select 1 from pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'COMMON_ACCOUNT_RECONCILIATION_POSTCONDITION_ACL';
    end if;
  end loop;
end;
$$;

commit;
