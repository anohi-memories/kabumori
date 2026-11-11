-- G3 TASK 29 gate self-check (TEST-ONLY, throw-away local database). The owner-row check is made in TWO places today: row_publishable
-- (001:554-557 at PR #392's head) and the G4 TEST DOUBLE g4_x_account_verified (the join on brand_memberships). Weakening only
-- row_publishable leaves E1 refused (the double still refuses: recorded in the docs, a survived single mutant). This patch weakens
-- BOTH -- as if the real G4 predicate (UNKNOWN) did not look at owners -- and run.sh must fail at "INVARIANT E1": proof that the
-- invariant notices when the A -> B refusal is lost. Never a product candidate.
create or replace function postona_x_resv.row_publishable(p_row postona_x_resv.reservations) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_row.origin <> 'user_authored' then
    return false;
  end if;
  if p_row.consent_state <> 'confirmed' or p_row.consent_sha256 is distinct from p_row.content_sha256
     or p_row.consent_scheduled_at is distinct from p_row.scheduled_at or p_row.consent_revision is distinct from p_row.revision then
    return false;
  end if;
  if not exists (select 1 from public.social_accounts sa where sa.id = p_row.social_account_id and sa.brand_id = p_row.brand_id and sa.platform = 'x') then
    return false;
  end if;
  return postona_x_resv.g5_x_autopost_allowed(p_row.user_id) is true
     and postona_x_resv.g4_x_account_verified(p_row.user_id, p_row.social_account_id) is true;
end $$;

create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.social_accounts sa
    join public.brands b on b.id = sa.brand_id and b.code_profile_key = 'social_mobile_user_v1'
    where sa.id = p_social_account_id and sa.platform = 'x'
      and sa.connection_status = 'identity_verified' and sa.platform_user_id is not null and sa.verified_at is not null
      and sa.last_connection_error_code is null
      and sa.vault_access_token_secret_id is not null and sa.vault_refresh_token_secret_id is not null
      and sa.vault_access_token_secret_id <> sa.vault_refresh_token_secret_id
      and not exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id))
$$;
