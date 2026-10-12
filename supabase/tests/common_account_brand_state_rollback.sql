-- Emergency rollback for 20261012230000_common_account_service_brand_state. Disposable proof and reviewed
-- operator use only; never applied automatically.
--
-- Removes the four functions, unless another function's source names one of them (a POSTONA worker that was
-- wired to the predicate): PostgreSQL does not track calls inside function bodies, so a DROP would break that
-- caller at runtime. In that case nothing is dropped, the callers are listed (NOTICE) and the file succeeds;
-- once the owners detach their calls, running it again removes the functions. Repeatable; refuses with
-- COMMON_ACCOUNT_BRAND_STATE_ROLLBACK_NOT_APPLIED when there is nothing left. Never uses CASCADE.
begin;

do $$
declare
  v_names text[] := array['account_lifecycle_brand_owner', 'account_lifecycle_service_state_readonly',
                          'account_lifecycle_assert_brand_service_active', 'common_account_brand_service_state'];
  v_present int;
  v_callers text;
begin
  select count(*) into v_present from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('private', 'public') and p.proname = any (v_names);
  if v_present = 0 then
    raise exception 'COMMON_ACCOUNT_BRAND_STATE_ROLLBACK_NOT_APPLIED';
  end if;
  select string_agg(format('function %s', p.oid::regprocedure), '; ' order by p.oid::regprocedure::text)
    into v_callers
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prokind in ('f', 'p')
     and not (p.proname = any (v_names) and n.nspname in ('private', 'public'))
     and (p.prosrc like '%account_lifecycle_brand_owner%' or p.prosrc like '%account_lifecycle_service_state_readonly%'
          or p.prosrc like '%account_lifecycle_assert_brand_service_active%' or p.prosrc like '%common_account_brand_service_state%');
  if v_callers is not null then
    raise notice 'COMMON_ACCOUNT_BRAND_STATE_ROLLBACK_PARTIAL: kept because other functions use them (%). Detach them in their own reviewed step; run this file again afterwards.', v_callers;
    return;
  end if;
  drop function if exists public.common_account_brand_service_state(text, text);
  drop function if exists private.account_lifecycle_assert_brand_service_active(text, text);
  drop function if exists private.account_lifecycle_service_state_readonly(uuid, text);
  drop function if exists private.account_lifecycle_brand_owner(text);
end;
$$;

commit;
