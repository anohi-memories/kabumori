-- Rollback of 007_postona_threads_reservations.sql (G3 SOURCE CANDIDATE). Re-runnable. Stop the Threads dispatcher
-- first. Drops the postona_threads_resv schema -- only when it holds nothing but 007's own objects -- and with it every
-- Threads reservation row (export them first if they must be kept). postona_x_resv and the two roles are untouched.
-- G3-02 #4 (H4-16 P1): no CASCADE. 007's functions, tables and the schema are dropped one by one with RESTRICT, so anything outside
-- the schema that depends on them (a view, a foreign key, a type use, a SQL-body function) makes the whole file refuse with
-- POSTONA_THREADS_RESV_ROLLBACK_FOREIGN_DEPENDENTS and nothing changed (one transaction). The old CASCADE dropped such an object.
begin;
do $$
begin
  if to_regnamespace('postona_threads_resv') is null then
    return;
  end if;
  if exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'postona_threads_resv'::regnamespace
             and c.relname not in ('reservations', 'reservations_pkey', 'reservations_due', 'reservations_user_id_social_account_id_client_request_id_key',
                               'audit', 'audit_pkey', 'audit_id_seq'))
     or exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_threads_resv'::regnamespace
                and p.proname not in ('g4_threads_account_verified', 'parse_owner_epoch_token', 'g5_r1_bound', 'g5_bound_state', 'threads_credential_generation', 'refresh_in_progress',
                                      'fence', 'text_ok', 'create_reservation', 'cancel_reservation', 'receipt', 'claim_due', 'preflight',
                                      'record', 'release_unsent')) then
    raise exception 'POSTONA_THREADS_RESV_ROLLBACK_FOREIGN_OBJECTS';
  end if;
end $$;
do $$
declare v_fn regprocedure;
begin
  if to_regnamespace('postona_threads_resv') is null then
    return;
  end if;
  -- functions first (g5_bound_state takes the reservations row type), then the tables (their indexes, sequence and RLS go with
  -- them), then the empty schema; RESTRICT throughout
  for v_fn in select p.oid::regprocedure from pg_catalog.pg_proc p where p.pronamespace = 'postona_threads_resv'::regnamespace
              order by p.oid::regprocedure::text loop
    execute pg_catalog.format('drop function %s restrict', v_fn);
  end loop;
  drop table postona_threads_resv.audit restrict;
  drop table postona_threads_resv.reservations restrict;
  drop schema postona_threads_resv restrict;
exception when dependent_objects_still_exist then
  raise exception 'POSTONA_THREADS_RESV_ROLLBACK_FOREIGN_DEPENDENTS: %', sqlerrm;
end $$;
commit;
