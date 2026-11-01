-- TEST DOUBLE (postona_threads_reservations_run.sh only, disposable DB). NOT G4's implementation.
--  * G4 verified-Threads predicate: true only for accounts listed in t_threads.verified.
-- (G5's verdict -- R1 / W1 -- is stood in by g5_verdict_test_double.sql, applied before 007.)
create or replace function postona_threads_resv.g4_threads_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4_TEST_DOUBLE
  select exists (select 1 from t_threads.verified v where v.social_account_id = p_social_account_id)
$$;
revoke all on function postona_threads_resv.g4_threads_account_verified(uuid, text)
  from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
