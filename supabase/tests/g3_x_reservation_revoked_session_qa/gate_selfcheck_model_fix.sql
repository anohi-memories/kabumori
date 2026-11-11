-- TEST-ONLY model fix (NOT the G5 contract, NOT a candidate): caller() refuses a dead / foreign / unknown / missing / anonymous session.
create or replace function postona_x_resv.caller() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid(); c jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb; s uuid;
begin
  if v is null then raise exception 'POSTONA_RESV_AUTH_REQUIRED' using errcode = 'P0001'; end if;
  s := nullif(c ->> 'session_id', '')::uuid;
  if s is null or coalesce(c ->> 'is_anonymous', 'false') <> 'false'
     or not exists (select 1 from auth.sessions x where x.id = s and x.user_id = v and (x.not_after is null or x.not_after > clock_timestamp())) then
    raise exception 'POSTONA_RESV_AUTH_REQUIRED' using errcode = 'P0001';
  end if;
  return v;
end $$;
