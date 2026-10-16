-- POSTONA X reservations — worker dispatch boundary + G5-first lock order (F3 SOURCE CANDIDATE, 2026-10-16).
-- NOT in supabase/migrations/. Applies only after 001 + 002 + 003 (G5 x_autopost binding). Never apply anywhere until
-- G5/F5's common-account candidates and G4's verified-X-account predicate (Issue #131; still the shipped DENY) are
-- approved and applied, one Sol（高） integrated review, and the user's explicit approval.
--
-- What it changes (F3-owned reservation functions only; no G5/F5, G4, Kabumori / AI Lab object is touched):
--   A. postona_resv_worker: a dedicated NOLOGIN role for the future delivery worker. It executes exactly the four
--      worker functions (claim_due, pre_publish_check, finish, release_unsent) and nothing else: no owner
--      function, no table, no helper. Granting a server-side login role membership is a separate approved
--      rollout step (as for postona_resv_api); its credential never reaches a mobile build.
--   B. F3-L1 (F5 Phase 8 finding): lock_own (owner cancel / reschedule / reconfirm), pre_publish_check and
--      claim_due locked the reservation ROW first and took G5's locks (login KEY SHARE -> account FOR UPDATE ->
--      entitlement FOR UPDATE, held to COMMIT) after it -- the reverse of the G5 contract -- and closed a cycle
--      with a lifecycle step that holds G5's locks and then needs the reservation rows (the X stop functions).
--      Now each of them takes G5's decision FIRST from a plain read, and locks the row only afterwards,
--      re-verifying it under the lock. lock_own is F5's verified body (common_account_phase8_f3_lock_order_fix_proof).
--   C. A delivery that never reached the provider is never left to age into 'uncertain':
--      * pre_publish_check hands the row back to 'planned' (answer RELEASED) when G5's fence is busy or when its
--        own lease ran out before the send -- the check runs strictly BEFORE any provider IO;
--      * release_unsent(reservation, lease) lets the worker hand back a row it claimed but did not send
--        (graceful shutdown); revision and consent stay as they were.
--      A row that may have been sent still only ever becomes 'published' (provider post id) or 'uncertain'.
-- Rollback: 004_postona_x_resv_dispatch_rollback.sql (restores 001's bodies, drops release_unsent and the role).
begin;

do $$
begin
  if to_regprocedure('postona_x_resv.claim_due(text,integer,integer)') is null
     or to_regprocedure('postona_x_resv.lock_own(uuid,integer)') is null
     or to_regrole('postona_resv_api') is null then
    raise exception 'POSTONA_RESV_DISPATCH_PRECONDITION_001_002_MISSING';
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.g5_x_autopost_allowed(uuid)'::regprocedure) !~ 'G5_BINDING' then
    raise exception 'POSTONA_RESV_DISPATCH_PRECONDITION_G5_BINDING_MISSING';
  end if;
  if to_regrole('postona_resv_worker') is not null or to_regprocedure('postona_x_resv.release_unsent(uuid,uuid)') is not null then
    raise exception 'POSTONA_RESV_DISPATCH_ALREADY_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv')
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_RESV_DISPATCH_PRECONDITION_OWNER';
  end if;
end $$;

create role postona_resv_worker nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- B. Owner actions: G5's locks and decision first, then the row (F5's verified body).
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
  -- 2. G5's locks and decision FIRST (with owner, account, G4)
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

/** Hands a claimed row that was NOT sent back to 'planned' (the caller proves the lease; no G5 lock needed). */
create function postona_x_resv.release_claim(p_reservation_id uuid, p_lease_token uuid, p_reason text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid;
begin
  update postona_x_resv.reservations r
  set status = 'planned', lease_token = null, lease_expires_at = null, claimed_by = null, updated_at = pg_catalog.now()
  where r.id = p_reservation_id and r.status = 'claimed' and r.lease_token = p_lease_token
  returning r.user_id into v_user;
  if not found then
    return false;
  end if;
  insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
  values (v_user, p_reservation_id, 'release', pg_catalog.jsonb_build_object('reason', p_reason));
  return true;
end $$;

/**
 * Immediately before provider IO: G5's decision first (its locks held to COMMIT), then the row under its lock.
 *   OK              -> the lease is ours and live, and the row is publishable: send now
 *   RELEASED        -> G5's fence was busy, or this lease ran out before the send: handed back to 'planned'
 *   NOT_PUBLISHABLE -> no longer publishable (owner, account, G5, G4, consent): recorded as failed, not sent
 *   LEASE_LOST      -> not this worker's row (any more): do nothing
 */
create or replace function postona_x_resv.pre_publish_check(p_reservation_id uuid, p_lease_token uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_peek postona_x_resv.reservations%rowtype; v_row postona_x_resv.reservations%rowtype;
begin
  select r.* into v_peek from postona_x_resv.reservations r where r.id = p_reservation_id;
  if not found or v_peek.status <> 'claimed' or v_peek.lease_token is distinct from p_lease_token then
    return 'LEASE_LOST';
  end if;
  begin
    perform postona_x_resv.g5_x_autopost_allowed(v_peek.user_id);
  exception when others then
    if sqlerrm <> 'POSTONA_RESV_SERVICE_BUSY' then
      raise;
    end if;
    -- A lifecycle step holds the fence: nothing is sent; the row goes back to 'planned' (never 'uncertain').
    return case when postona_x_resv.release_claim(p_reservation_id, p_lease_token, 'SERVICE_BUSY') then 'RELEASED' else 'LEASE_LOST' end;
  end;
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id for update;
  if not found or v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token then
    return 'LEASE_LOST';
  end if;
  if v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    -- Still ours, and this check runs before any send: hand it back instead of letting it age into 'uncertain'.
    return case when postona_x_resv.release_claim(p_reservation_id, p_lease_token, 'LEASE_EXPIRED_BEFORE_SEND') then 'RELEASED' else 'LEASE_LOST' end;
  end if;
  if not postona_x_resv.row_publishable(v_row) then
    update postona_x_resv.reservations r set status = 'failed', outcome_code = 'NOT_PUBLISHABLE_AT_SEND', updated_at = pg_catalog.now()
    where r.id = v_row.id;
    return 'NOT_PUBLISHABLE';
  end if;
  return 'OK';
end $$;

/**
 * G5's decisions first, for the owners of due rows (plain read; at most p_limit owners, in user-id order, each
 * in its own subtransaction so a busy fence skips only that owner this round), then the sweeps, then the claims
 * under row locks (FOR UPDATE SKIP LOCKED), each row re-checked by row_publishable (G5 already held: no new wait).
 *   planned past expires_at                 -> expired
 *   claimed with an expired lease           -> uncertain (never re-claimed: the X outcome is unknown)
 */
create or replace function postona_x_resv.claim_due(p_worker text, p_lease_seconds integer, p_limit integer)
returns table (reservation_id uuid, lease_token uuid, social_account_id text, body text, scheduled_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid; v_allowed uuid[] := '{}'; v_row postona_x_resv.reservations%rowtype; v_token uuid; v_count integer := 0;
begin
  if p_worker is null or p_worker !~ '^[a-z0-9_-]{1,40}$' or p_lease_seconds not between 30 and 900 or p_limit not between 1 and 50 then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  for v_user in
    select o.user_id from (
      select r.user_id, min(r.scheduled_at) as first_due from postona_x_resv.reservations r
      where r.status = 'planned' and r.scheduled_at <= pg_catalog.now() and r.expires_at > pg_catalog.now()
      group by r.user_id order by first_due, r.user_id limit p_limit) o
    order by o.user_id
  loop
    begin
      if postona_x_resv.g5_x_autopost_allowed(v_user) is true then
        v_allowed := v_allowed || v_user;
      end if;
    exception when others then
      if sqlerrm <> 'POSTONA_RESV_SERVICE_BUSY' then
        raise;
      end if;  -- that owner's fence is busy: none of their rows this round
    end;
  end loop;
  update postona_x_resv.reservations r set status = 'expired', updated_at = pg_catalog.now()
  where r.status = 'planned' and r.expires_at <= pg_catalog.now();
  update postona_x_resv.reservations r set status = 'uncertain', outcome_code = 'LEASE_EXPIRED', updated_at = pg_catalog.now()
  where r.status = 'claimed' and r.lease_expires_at <= pg_catalog.now();
  for v_row in
    select r.* from postona_x_resv.reservations r
    where r.status = 'planned' and r.scheduled_at <= pg_catalog.now() and r.expires_at > pg_catalog.now()
      and r.user_id = any (v_allowed)
    order by r.scheduled_at, r.id
    for update skip locked
  loop
    exit when v_count >= p_limit;
    continue when not postona_x_resv.row_publishable(v_row);
    v_token := gen_random_uuid();
    update postona_x_resv.reservations r
    set status = 'claimed', lease_token = v_token, claimed_by = p_worker,
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds), updated_at = pg_catalog.now()
    where r.id = v_row.id;
    insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
    values (v_row.user_id, v_row.id, 'claim', pg_catalog.jsonb_build_object('worker', p_worker));
    reservation_id := v_row.id; lease_token := v_token; social_account_id := v_row.social_account_id;
    body := v_row.body; scheduled_at := v_row.scheduled_at;
    v_count := v_count + 1;
    return next;
  end loop;
end $$;

/** C. The worker hands back a row it claimed and did NOT send (graceful shutdown). */
create function postona_x_resv.release_unsent(p_reservation_id uuid, p_lease_token uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_reservation_id is null or p_lease_token is null then
    raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  return case when postona_x_resv.release_claim(p_reservation_id, p_lease_token, 'WORKER_SHUTDOWN') then 'released' else 'lease_lost' end;
end $$;

revoke all on function postona_x_resv.lock_own(uuid, integer) from public, anon, authenticated, service_role, postona_resv_api;
revoke all on function postona_x_resv.release_claim(uuid, uuid, text) from public, anon, authenticated, service_role, postona_resv_api;
revoke all on function postona_x_resv.pre_publish_check(uuid, uuid) from public, anon, authenticated, service_role, postona_resv_api;
revoke all on function postona_x_resv.claim_due(text, integer, integer) from public, anon, authenticated, service_role, postona_resv_api;
revoke all on function postona_x_resv.release_unsent(uuid, uuid) from public, anon, authenticated, service_role, postona_resv_api;

grant usage on schema postona_x_resv to postona_resv_worker;
grant execute on function
  postona_x_resv.claim_due(text, integer, integer),
  postona_x_resv.pre_publish_check(uuid, uuid),
  postona_x_resv.finish(uuid, uuid, text, text, text),
  postona_x_resv.release_unsent(uuid, uuid)
to postona_resv_worker;

-- Postconditions: the worker role reaches exactly the four worker functions; the API role still exactly its six;
-- the API roles reach nothing; every definer keeps an empty search_path.
do $$
declare v_role text; v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_worker', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_x_resv.claim_due(text,integer,integer),postona_x_resv.finish(uuid,uuid,text,text,text),'
                            'postona_x_resv.pre_publish_check(uuid,uuid),postona_x_resv.release_unsent(uuid,uuid)' then
    raise exception 'POSTONA_RESV_DISPATCH_POSTCONDITION: postona_resv_worker executes %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_api', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_x_resv.cancel(uuid,integer),postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb),'
                            'postona_x_resv.get_reservation(uuid),postona_x_resv.list_reservations(text),'
                            'postona_x_resv.reconfirm(uuid,integer,text),postona_x_resv.reschedule(uuid,integer,timestamp with time zone)' then
    raise exception 'POSTONA_RESV_DISPATCH_POSTCONDITION: postona_resv_api executes %', v_bad;
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_schema_privilege(v_role, 'postona_x_resv', 'USAGE') or pg_catalog.pg_has_role(v_role, 'postona_resv_worker', 'USAGE') then
      raise exception 'POSTONA_RESV_DISPATCH_POSTCONDITION: % reaches the schema or the worker role', v_role;
    end if;
    select string_agg(p.proname, ',') into v_bad from pg_catalog.pg_proc p
    where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then raise exception 'POSTONA_RESV_DISPATCH_POSTCONDITION: % executes %', v_role, v_bad; end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'postona_resv_worker'
             and (r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolinherit))
     or exists (select 1 from pg_catalog.pg_auth_members m where m.member = 'postona_resv_worker'::regrole) then
    raise exception 'POSTONA_RESV_DISPATCH_POSTCONDITION: worker role attributes';
  end if;
  if exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'postona_x_resv'::regnamespace and c.relkind in ('r', 'S')
             and (pg_catalog.has_table_privilege('postona_resv_worker', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                  or (c.relkind = 'S' and pg_catalog.has_sequence_privilege('postona_resv_worker', c.oid, 'USAGE,SELECT,UPDATE')))) then
    raise exception 'POSTONA_RESV_DISPATCH_POSTCONDITION: postona_resv_worker reaches a table';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
             and p.prosecdef and p.proconfig is distinct from array['search_path=""']) then
    raise exception 'POSTONA_RESV_DISPATCH_POSTCONDITION: definer search_path';
  end if;
end $$;

commit;
