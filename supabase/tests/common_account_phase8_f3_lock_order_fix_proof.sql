-- TEST-ONLY PROOF OVERLAY (F5 Phase 8). NOT a migration, NOT a candidate, never applied anywhere but a disposable copy.
-- It shows that the lock-order defect F3-L1 (see docs/common-account/phase8-integrated-security.md) is repaired by ONE
-- change in F3's reservation functions: take G5's decision (login KEY SHARE -> account -> entitlement, the order the
-- G5 contract fixes) BEFORE the reservation row is locked, not after.
--
-- F3's own source is not modified by this file; the handoff to F3 is the same body, applied in F3's candidate.
create or replace function postona_x_resv.lock_own(p_reservation_id uuid, p_expected_revision integer)
returns postona_x_resv.reservations
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype; v_account text; v_owner uuid;
begin
  -- 1. a plain read decides whose row this is (no row lock yet)
  select r.user_id, r.social_account_id into v_owner, v_account from postona_x_resv.reservations r where r.id = p_reservation_id;
  if not found or v_owner <> v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  -- 2. G5's locks and decision FIRST
  perform postona_x_resv.assert_account_access(v_user, v_account);
  -- 3. only then the row, re-verified under its lock
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.user_id <> v_user or v_row.social_account_id is distinct from v_account then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_row.revision <> p_expected_revision then
    raise exception 'POSTONA_RESV_STALE_REVISION' using errcode = 'P0001';
  end if;
  return v_row;
end $$;
