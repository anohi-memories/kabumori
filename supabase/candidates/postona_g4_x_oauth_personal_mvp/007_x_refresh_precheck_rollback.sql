-- NOT A MIGRATION. Rollback of 007_x_refresh_precheck.sql (G4-02 #8). No CASCADE. After it a refresh worker wired through the fence refuses
-- every account (fail-closed, no provider call): unwire the worker first if refresh must keep working.
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
begin
  if to_regprocedure('public.postona_x_refresh_precheck_v1(text)') is null then
    raise exception 'G4X_PRECHECK_NOT_APPLIED';
  end if;
  if (select proowner from pg_catalog.pg_proc where oid = to_regprocedure('public.postona_x_refresh_precheck_v1(text)'))
     <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'G4X_PRECHECK_ROLLBACK_OWNER';
  end if;
end $$;
drop function public.postona_x_refresh_precheck_v1(text);
notify pgrst, 'reload schema';
commit;
