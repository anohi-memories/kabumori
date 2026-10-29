-- NOT A MIGRATION. Rollback of 001_threads_publish_credential_verdict.sql (G4-02 #4). Roll back 002 first. No CASCADE:
-- the schema must hold exactly the Threads verdict, so a G3 consumer (or anything else) depending on it stays a refusal.
begin;
set local lock_timeout = '2s';
set local search_path = '';
do $$
begin
  if to_regnamespace('postona_g4_credential') is null then
    raise exception 'G4_VERDICT_NOT_APPLIED';
  end if;
  if (select nspowner from pg_catalog.pg_namespace where nspname = 'postona_g4_credential')
     <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'G4_VERDICT_ROLLBACK_OWNER';
  end if;
  if to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)') is not null then
    raise exception 'G4_VERDICT_ROLLBACK_002_FIRST';
  end if;
end $$;
drop function postona_g4_credential.threads_publish_credential_verdict(uuid, text);
drop schema postona_g4_credential;
commit;
