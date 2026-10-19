-- Rollback of 007_postona_threads_reservations.sql (G3 SOURCE CANDIDATE). Re-runnable. Stop the Threads dispatcher
-- first. Drops the postona_threads_resv schema -- only when it holds nothing but 007's own objects -- and with it every
-- Threads reservation row (export them first if they must be kept). postona_x_resv and the two roles are untouched.
begin;
do $$
begin
  if to_regnamespace('postona_threads_resv') is null then
    return;
  end if;
  if exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'postona_threads_resv'::regnamespace
             and c.relname not in ('reservations', 'reservations_pkey', 'reservations_due', 'reservations_user_id_social_account_id_client_request_id_key'))
     or exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_threads_resv'::regnamespace
                and p.proname not in ('g4_threads_account_verified', 'g5_threads_state', 'threads_credential_generation', 'refresh_in_progress',
                                      'fence', 'text_ok', 'create_reservation', 'cancel_reservation', 'receipt', 'claim_due', 'preflight',
                                      'record', 'release_unsent')) then
    raise exception 'POSTONA_THREADS_RESV_ROLLBACK_FOREIGN_OBJECTS';
  end if;
end $$;
drop schema if exists postona_threads_resv cascade;
commit;
