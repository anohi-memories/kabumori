-- TEST DOUBLES (postona_threads_reservations_run.sh only, disposable DB). NOT G4's or G5's implementation.
--  * G4 verified-Threads predicate: true only for accounts listed in t_threads.verified.
--  * G5 Threads state: the person's common account active, no account deletion in progress (F5's real tables), and a
--    test-only Threads entitlement row 'active' (the real service key is undecided; no service name is invented).
create or replace function postona_threads_resv.g4_threads_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4_TEST_DOUBLE
  select exists (select 1 from t_threads.verified v where v.social_account_id = p_social_account_id)
$$;
create or replace function postona_threads_resv.g5_threads_state(p_user_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  -- G5_TEST_DOUBLE
  select case
    when not exists (select 1 from public.common_accounts a where a.user_id = p_user_id) then 'ACCOUNT_NOT_FOUND'
    when (select a.status from public.common_accounts a where a.user_id = p_user_id) = 'deleting'
      or exists (select 1 from private.account_lifecycle_operations o where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress')
      then 'ACCOUNT_DELETION_IN_PROGRESS'
    when (select a.status from public.common_accounts a where a.user_id = p_user_id) <> 'active' then 'ACCOUNT_LOCKED'
    when (select e.status from t_threads.entitlement e where e.user_id = p_user_id) is distinct from 'active' then 'SERVICE_NOT_ACTIVE'
    else null end
$$;
revoke all on function postona_threads_resv.g4_threads_account_verified(uuid, text), postona_threads_resv.g5_threads_state(uuid)
  from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
