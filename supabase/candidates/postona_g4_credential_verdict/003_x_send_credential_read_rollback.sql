-- NOT A MIGRATION. Rollback of 003_x_send_credential_read.sql (G4-02 #19, #20). Run as the same owner. Removes only the function 003
-- created, and only when its body is the one 003 installs (anything else: refuse, nothing changed). 002, G3's schema and everything
-- else stay.
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
declare
  v_fn regprocedure := to_regprocedure('public.postona_x_send_credential_for_claim_v1(uuid,uuid,text,uuid)');
begin
  if v_fn is null then
    raise exception 'G4XS_ROLLBACK_NOT_APPLIED';
  end if;
  if (select proowner from pg_catalog.pg_proc where oid = v_fn) <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'G4XS_ROLLBACK_OWNER';
  end if;
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = v_fn) <> 'b77e72fdf707b8bff48e47b5014f99b3' then
    raise exception 'G4XS_ROLLBACK_BODY_DRIFT';
  end if;
end $$;
drop function public.postona_x_send_credential_for_claim_v1(uuid, uuid, text, uuid);
commit;
