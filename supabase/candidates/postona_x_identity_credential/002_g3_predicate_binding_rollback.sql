-- Rollback of 002_g3_predicate_binding.sql (F4 / G4): F3's shipped DENY back, exactly as F3's 001 shipped it.
begin;

set local search_path = '';

create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G4 contract (Issue #131): true only for an X account whose platform identity was proven by the reviewed
  -- OAuth flow for exactly this user and whose publish permission is on. Not implemented in G3: always false.
  select false
$$;
revoke all on function postona_x_resv.g4_x_account_verified(uuid, text) from public, anon, authenticated, service_role;

commit;
