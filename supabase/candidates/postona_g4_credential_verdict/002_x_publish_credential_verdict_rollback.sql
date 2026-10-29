-- NOT A MIGRATION. Rollback of 002_x_publish_credential_verdict.sql (G4-02 #4). Drops only the X verdict (no CASCADE).
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
begin
  if to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)') is null then
    raise exception 'G4_X_VERDICT_NOT_APPLIED';
  end if;
  if (select proowner from pg_catalog.pg_proc where oid = to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)'))
     <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'G4_VERDICT_ROLLBACK_OWNER';
  end if;
end $$;
drop function postona_g4_credential.x_publish_credential_verdict(uuid, text);
commit;
