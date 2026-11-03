-- NOT A MIGRATION. Rollback of 006_x_connect_profile_fence.sql (G4-02 #7). No CASCADE. After it the X Edge entry refuses every start and
-- callback (fail-closed): roll the Edge back, or stop routing to it, first if X connect must keep working.
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
begin
  if to_regprocedure('public.postona_x_connect_profile_v1()') is null then
    raise exception 'G4X_FENCE_NOT_APPLIED';
  end if;
  if (select proowner from pg_catalog.pg_proc where oid = to_regprocedure('public.postona_x_connect_profile_v1()'))
     <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'G4X_FENCE_ROLLBACK_OWNER';
  end if;
end $$;
drop function public.postona_x_connect_profile_v1();
notify pgrst, 'reload schema';
commit;
