-- G3 TASK 31 gate self-check (TEST-ONLY, throw-away local database; never a product candidate). Candidate 007's cancel_reservation
-- (PR #392's head, 007:254-265) with ONE change: an existing row of ANOTHER person answers NOT_CANCELLABLE instead of NOT_FOUND --
-- an existence oracle. Applied with CR_PATCH_SQL (after 007), run.sh must fail at an "INVARIANT T1_other_person_by_state cancel_..."
-- line: proof that the no-oracle invariant notices.
create or replace function postona_threads_resv.cancel_reservation(p_reservation_id uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller();
begin
  update postona_threads_resv.reservations r set status = 'cancelled', updated_at = pg_catalog.now()
  where r.id = p_reservation_id and r.user_id = v_user and r.status = 'planned';
  if found then return 'cancelled'; end if;
  if exists (select 1 from postona_threads_resv.reservations r where r.id = p_reservation_id) then  -- WEAKENED: any person's row
    raise exception 'POSTONA_THREADS_RESV_NOT_CANCELLABLE' using errcode = 'P0001';
  end if;
  raise exception 'POSTONA_THREADS_RESV_NOT_FOUND' using errcode = 'P0001';
end $$;
