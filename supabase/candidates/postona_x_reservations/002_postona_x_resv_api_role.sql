-- POSTONA X reservations — API execution role (G3 SOURCE CANDIDATE ONLY, 2026-10-12). NOT in supabase/migrations/.
-- Applies after 001_postona_x_reservations.sql. Never apply to production without the reviewed rollout
-- (G5 x_autopost / lifecycle predicate, G4 verified X account predicate, one Sol（高） integrated review, user
-- approval).
--
-- Why a dedicated role: the owner functions stay unreachable from PostgREST (no grant to anon, authenticated,
-- service_role or PUBLIC). The only caller is the future server-side reservation API (Edge), which
--   1. verifies the caller's access token live with Supabase Auth (never the JWT lifetime alone),
--   2. opens ONE transaction as a login role that is a member of postona_resv_api,
--   3. sets request.jwt.claims / request.jwt.claim.sub to exactly that verified subject (SET LOCAL),
--   4. calls one owner function, which re-checks owner, account, G5 and G4 live in that transaction.
-- The role can execute the six owner functions and nothing else: no table, sequence, worker function or
-- helper. No login, password or membership is created here; granting a server-side login role membership is
-- a separate, approved rollout step, and its credential never reaches a mobile client.
begin;

do $$
begin
  if to_regnamespace('postona_x_resv') is null or to_regprocedure('postona_x_resv.list_reservations(text)') is null then
    raise exception 'POSTONA_RESV_API_PRECONDITION_001_MISSING';
  end if;
  if to_regprocedure('postona_x_resv.get_reservation(uuid)') is not null or to_regrole('postona_resv_api') is not null then
    raise exception 'POSTONA_RESV_API_ALREADY_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv')
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_RESV_API_PRECONDITION_OWNER';
  end if;
end $$;

create role postona_resv_api nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

/** One reservation of the caller (owner, account, G5 and G4 re-checked live). */
create function postona_x_resv.get_reservation(p_reservation_id uuid)
returns setof postona_x_resv.reservation_view
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_x_resv.reservations%rowtype;
begin
  select r.* into v_row from postona_x_resv.reservations r where r.id = p_reservation_id;
  if not found or v_row.user_id <> v_user then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform postona_x_resv.assert_account_access(v_user, v_row.social_account_id);
  return query select r.id, r.batch_id, r.draft_id, r.position, r.origin, r.mode, r.body, r.scheduled_at, r.fixed,
                      r.status, r.revision, r.consent_state from postona_x_resv.reservations r where r.id = v_row.id;
end $$;
revoke all on function postona_x_resv.get_reservation(uuid) from public, anon, authenticated, service_role;

grant usage on schema postona_x_resv to postona_resv_api;
grant execute on function
  postona_x_resv.create_batch(text, uuid, integer, text, jsonb, jsonb),
  postona_x_resv.list_reservations(text),
  postona_x_resv.get_reservation(uuid),
  postona_x_resv.reschedule(uuid, integer, timestamptz),
  postona_x_resv.reconfirm(uuid, integer, text),
  postona_x_resv.cancel(uuid, integer)
to postona_resv_api;

-- Postconditions: the API roles still reach nothing, and postona_resv_api reaches exactly the six owner functions.
do $$
declare v_role text; v_bad text; v_allowed text[] := array[
  'postona_x_resv.cancel(uuid,integer)',
  'postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb)',
  'postona_x_resv.get_reservation(uuid)',
  'postona_x_resv.list_reservations(text)',
  'postona_x_resv.reconfirm(uuid,integer,text)',
  'postona_x_resv.reschedule(uuid,integer,timestamp with time zone)'];
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_schema_privilege(v_role, 'postona_x_resv', 'USAGE') then
      raise exception 'POSTONA_RESV_API_POSTCONDITION: % has schema usage', v_role;
    end if;
    select string_agg(p.proname, ',') into v_bad from pg_catalog.pg_proc p
    where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then raise exception 'POSTONA_RESV_API_POSTCONDITION: % executes %', v_role, v_bad; end if;
    if pg_catalog.pg_has_role(v_role, 'postona_resv_api', 'USAGE') then
      raise exception 'POSTONA_RESV_API_POSTCONDITION: % reaches postona_resv_api', v_role;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'postona_resv_api'
             and (r.rolcanlogin or r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolinherit)) then
    raise exception 'POSTONA_RESV_API_POSTCONDITION: role attributes';
  end if;
  if exists (select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid = m.member
             where m.member = 'postona_resv_api'::regrole) then
    raise exception 'POSTONA_RESV_API_POSTCONDITION: postona_resv_api is a member of another role';
  end if;
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_api', p.oid, 'EXECUTE');
  if v_bad is distinct from array_to_string(v_allowed, ',') then
    raise exception 'POSTONA_RESV_API_POSTCONDITION: postona_resv_api executes %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'postona_x_resv'::regnamespace and c.relkind in ('r', 'S')
             and (pg_catalog.has_table_privilege('postona_resv_api', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                  or (c.relkind = 'S' and pg_catalog.has_sequence_privilege('postona_resv_api', c.oid, 'USAGE,SELECT,UPDATE')))) then
    raise exception 'POSTONA_RESV_API_POSTCONDITION: postona_resv_api reaches a table';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
             and p.prosecdef and p.proconfig is distinct from array['search_path=""']) then
    raise exception 'POSTONA_RESV_API_POSTCONDITION: definer search_path';
  end if;
end $$;

commit;
