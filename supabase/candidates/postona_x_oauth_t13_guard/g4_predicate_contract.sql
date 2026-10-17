-- G4 contract for postona_x_resv.g4_x_account_verified(user, account) -- what F3's reservation API / worker need from
-- G4's verified-X-account predicate (Issue #131). F3 does NOT implement it: the shipped body stays `select false`.
-- Any G4 implementation must pass this file; run.sh runs it against a TEST DOUBLE (g4_predicate_test_double.sql, never
-- a candidate) built only from what the live onboarding records, to prove the onboarding -> reservation chain.
-- Expects: the caller has applied the predicate under test; helpers.sql loaded; the people below are set up here.
--   K1 the person's own X row, identity verified by the onboarding (status identity_verified, platform user id,
--      verified_at, two distinct Vault references), owner of a self-service workspace          -> true
--   K2 the same row asked for another person                                                     -> false
--   K3 authorization pending / failed / last connection error / a Vault reference missing          -> false
--   K4 the row's workspace is being deleted (X deletion saga tombstone)                            -> false
--   K5 not an X row; an unknown row                                                                 -> false
--   K6 shape: SECURITY DEFINER, empty search_path, no EXECUTE for anon / authenticated / service_role
\ir helpers.sql
create function pg_temp.g4(p_user uuid, p_account text) returns boolean language sql as $$
  select postona_x_resv.g4_x_account_verified(p_user, p_account) $$;
create function pg_temp.connected(p_n integer, p_platform_id text) returns text language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('k' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('k' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, p_platform_id), v_user, v_session) not like 'ERR:%', 'K setup complete ' || p_n);
  return v_account;
end $$;

select pg_temp.connected(91, '9101') as k91 \gset
select pg_temp.expect(pg_temp.g4(pg_temp.uid(91), :'k91') is true, 'K1 verified own account');
select pg_temp.enrolled(92) is not null as k_setup_92;
select pg_temp.expect(pg_temp.g4(pg_temp.uid(92), :'k91') is false, 'K2 another person');
select pg_temp.connected(93, '9301') as k93 \gset
update public.social_accounts set connection_status = 'authorization_pending' where id = :'k93';
select pg_temp.expect(pg_temp.g4(pg_temp.uid(93), :'k93') is false, 'K3 pending');
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = 'X_ACCOUNT_ALREADY_CONNECTED' where id = :'k93';
select pg_temp.expect(pg_temp.g4(pg_temp.uid(93), :'k93') is false, 'K3 connection error');
update public.social_accounts set last_connection_error_code = null, vault_refresh_token_secret_id = null where id = :'k93';
select pg_temp.expect(pg_temp.g4(pg_temp.uid(93), :'k93') is false, 'K3 refresh reference missing');
select pg_temp.connected(94, '9401') as k94 \gset
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
values (pg_temp.uid(94), public.social_mobile_account_deletion_workspace(pg_temp.uid(94)), 'started', 'social_only', '[]'::jsonb);
select pg_temp.expect(pg_temp.g4(pg_temp.uid(94), :'k94') is false, 'K4 workspace being deleted');
select pg_temp.expect(pg_temp.g4(pg_temp.uid(91), 'sa_no_such_account') is false, 'K5 unknown row');
select pg_temp.expect(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
                                  where has_function_privilege(r, 'postona_x_resv.g4_x_account_verified(uuid,text)', 'EXECUTE'))
                      and exists (select 1 from pg_proc p where p.oid = 'postona_x_resv.g4_x_account_verified(uuid,text)'::regprocedure
                                  and p.prosecdef and p.proconfig = array['search_path=""']), 'K6 shape');
select 'G4_PREDICATE_CONTRACT_PASS' as result;
