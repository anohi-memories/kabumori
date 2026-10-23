-- TEST-ONLY weakened guard (NOT a candidate; the boundary self-check of run.sh): row_publishable keeps only the consent rule and
-- forgets the owner / account / G5 / G4 checks, and the claim no longer asks G5 first. run.sh must then FAIL at B1.
create or replace function postona_x_resv.row_publishable(p_row postona_x_resv.reservations) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return p_row.origin = 'user_authored' and p_row.consent_state = 'confirmed' and p_row.consent_sha256 is not distinct from p_row.content_sha256
     and p_row.consent_scheduled_at is not distinct from p_row.scheduled_at and p_row.consent_revision is not distinct from p_row.revision;
end $$;
create or replace function postona_x_resv.g5_x_autopost_allowed(p_user_id uuid) returns boolean
language sql volatile security definer set search_path = '' as $$ select true $$;
