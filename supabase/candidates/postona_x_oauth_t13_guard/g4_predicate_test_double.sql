-- TEST DOUBLE ONLY -- never a candidate, never applied outside a disposable database (run.sh). It stands in for G4's
-- postona_x_resv.g4_x_account_verified (Issue #131) using ONLY what the live onboarding records, so the onboarding ->
-- reservation -> worker chain can be exercised end to end. It does NOT prove the X identity (the live complete() takes
-- the platform user id as given: that is exactly Issue #131 / G4's attested _v2 in Draft PR #126).
create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4_TEST_DOUBLE (F3 2026-10-17): see the header; not G4's implementation.
  select exists (
    select 1 from public.social_accounts sa
    join public.brands b on b.id = sa.brand_id and b.code_profile_key = 'social_mobile_user_v1'
    join public.brand_memberships m on m.brand_id = sa.brand_id and m.user_id = p_user_id and m.role = 'owner'
    where sa.id = p_social_account_id and sa.platform = 'x'
      and sa.connection_status = 'identity_verified' and sa.platform_user_id is not null and sa.verified_at is not null
      and sa.last_connection_error_code is null
      and sa.vault_access_token_secret_id is not null and sa.vault_refresh_token_secret_id is not null
      and sa.vault_access_token_secret_id <> sa.vault_refresh_token_secret_id
      and not exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id))
$$;
revoke all on function postona_x_resv.g4_x_account_verified(uuid, text) from public, anon, authenticated, service_role;
