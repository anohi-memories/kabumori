-- Rollback of 001_publish_enabled_t13_guard.sql (F3 SOURCE CANDIDATE). Re-runnable. Restores the live switch's name and
-- today's grant exactly (authenticated EXECUTE; public / anon / service_role none). Its body was never changed.
begin;
do $$
begin
  if to_regprocedure('public.set_social_account_publish_enabled_unguarded_v1(text,boolean,boolean)') is null then
    return;  -- not applied (or already rolled back)
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'public.set_social_account_publish_enabled(text,boolean,boolean)'::regprocedure) !~ 'PUBLISH_ENABLED_T13_GUARD_V1' then
    raise exception 'PUBLISH_ENABLED_T13_ROLLBACK_NOT_OURS';
  end if;
  drop function public.set_social_account_publish_enabled(text, boolean, boolean);
  alter function public.set_social_account_publish_enabled_unguarded_v1(text, boolean, boolean) rename to set_social_account_publish_enabled;
  revoke all on function public.set_social_account_publish_enabled(text, boolean, boolean) from public, anon, service_role;
  grant execute on function public.set_social_account_publish_enabled(text, boolean, boolean) to authenticated;
end $$;
commit;
