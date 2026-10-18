-- F5 M2: a TEST-ONLY probe. NOT a migration. It lets the test ask F5's real T13 guard what it would answer for the person in the JWT claims,
-- as text (a refusal is a value here, not an exception). Owned by the lifecycle owner, SECURITY DEFINER, empty search path.
create schema m2_fixture;
revoke all on schema m2_fixture from public;
create function m2_fixture.guard_probe(p_user_id uuid, p_service_key text)
returns text language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
begin
  perform private.account_lifecycle_assert_active_service_write(p_user_id, p_service_key);
  return 'allowed';
exception
  when lock_not_available then return 'ACCOUNT_LIFECYCLE_BUSY';
  when insufficient_privilege then return sqlerrm;
end $$;
revoke all on all functions in schema m2_fixture from public, anon, authenticated, service_role;
