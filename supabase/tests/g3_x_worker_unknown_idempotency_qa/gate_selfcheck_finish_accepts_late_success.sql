-- G3 TASK 30 gate self-check (TEST-ONLY, throw-away local database; never a product candidate). The finish of PR #392's head
-- (001:628-671) with ONE change: a row already recorded 'uncertain' accepts a later report (as a careless "reconciliation" would).
-- Applied with UX_PATCH_SQL, run.sh must fail at "INVARIANT U1_success_lost_then_late_success late_published": proof that the
-- invariant notices when an unknown outcome can be turned into a success without a reviewed reconciliation.
create or replace function postona_x_resv.finish(p_reservation_id uuid, p_lease_token uuid, p_outcome text, p_provider_post_id text, p_code text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_x_resv.reservations%rowtype;
begin
  if p_outcome not in ('published', 'failed_before_send', 'uncertain')
     or (p_outcome = 'published') <> (p_provider_post_id is not null)
     or (p_provider_post_id is not null and p_provider_post_id !~ '^[0-9]{1,30}$')
     or (p_code is not null and p_code !~ '^[A-Z][A-Z0-9_]{1,63}$') then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.lease_token is distinct from p_lease_token then
    raise exception 'POSTONA_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  if v_row.status = 'published' and p_outcome = 'published' and v_row.provider_post_id = p_provider_post_id then
    return 'published';  -- idempotent replay
  end if;
  if v_row.status not in ('claimed', 'uncertain') then  -- WEAKENED: a late report may overwrite an uncertain row
    -- Includes a lease swept to 'uncertain': a late success is recorded only by a reviewed reconciliation.
    raise exception 'POSTONA_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  -- The lease deadline is enforced here, at the decision point, on the real clock (not the transaction start)
  -- and independently of any claim_due() sweep. An expired lease is fenced atomically under the row lock:
  -- the row becomes 'uncertain' (never re-claimed, never re-sent, never shown as success) and the late report
  -- is kept in the audit trail only, so a future reviewed reconciliation can verify it with X before any
  -- 'published'. Nothing is raised, so the fence commits; the caller gets 'lease_lost', not its outcome.
  if v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    update postona_x_resv.reservations r
    set status = 'uncertain', outcome_code = 'LEASE_EXPIRED_AT_FINISH', updated_at = pg_catalog.now()
    where r.id = v_row.id;
    insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
    values (v_row.user_id, v_row.id, 'finish_after_lease', pg_catalog.jsonb_build_object(
      'reported_outcome', p_outcome, 'reported_provider_post_id', p_provider_post_id, 'reported_code', p_code));
    return 'lease_lost';
  end if;
  update postona_x_resv.reservations r
  set status = case p_outcome when 'published' then 'published' when 'failed_before_send' then 'failed' else 'uncertain' end,
      provider_post_id = p_provider_post_id, outcome_code = coalesce(p_code, upper(p_outcome)), updated_at = pg_catalog.now()
  where r.id = v_row.id;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_row.user_id, v_row.id, 'finish', pg_catalog.jsonb_build_object('outcome', p_outcome));
  return p_outcome;
end $$;
