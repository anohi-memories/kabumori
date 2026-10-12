-- Rollback of 003_postona_x_resv_g5_binding.sql (F3 SOURCE CANDIDATE): restores the shipped DENY stub of
-- postona_x_resv.g5_x_autopost_allowed(uuid) (every reservation action and claim is refused again). Idempotent.
begin;
create or replace function postona_x_resv.g5_x_autopost_allowed(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- G5 contract: true only while the user's common account is active (not deleting / locked) AND the
  -- x_autopost service entitlement is 'active', evaluated in the caller's transaction with G5's T13 writer
  -- fence. Not implemented in G3: always false.
  select false
$$;
revoke all on function postona_x_resv.g5_x_autopost_allowed(uuid) from public, anon, authenticated, service_role;
do $$ begin
  if to_regrole('postona_resv_api') is not null then
    execute 'revoke all on function postona_x_resv.g5_x_autopost_allowed(uuid) from postona_resv_api';
  end if;
end $$;
commit;
