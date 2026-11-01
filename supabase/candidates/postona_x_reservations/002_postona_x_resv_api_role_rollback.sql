-- G3 SOURCE CANDIDATE (2026-10-29, Issue #318 G3-41): rollback of 002_postona_x_resv_api_role.sql. NOT in supabase/migrations/, NOT applied
-- anywhere, not reviewed. Never run it against a managed project without the reviewed rollout and the user's approval.
--
-- Order: the reverse of the install. Roll back Threads 009 / 007, X 008, 006, 005, 004 and 003 first; this file refuses while any of them is
-- still there. Stop the reservation API (Edge) and revoke the server login's membership in postona_resv_api first: this file refuses while
-- any role is a member (it never cuts a live API login by itself).
--
-- What it removes: get_reservation(uuid), the role's schema usage and EXECUTE on 001's five owner functions, and the role postona_resv_api.
-- 001's tables, rows and functions are untouched (002 created none of them).
-- Refuses (nothing changed) when: 002 is not applied, or only half of it is there; the caller is a superuser or not the schema owner; a
-- later layer is present; the role has a member or belongs to another role; the role owns anything or holds any privilege other than 002's
-- own grants (in this database or another one).
begin;

do $$
declare v_role oid := pg_catalog.to_regrole('postona_resv_api'); v_fn regprocedure := pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)');
        v_later text[] := array[]::text[]; v_bad text;
begin
  if v_role is null and v_fn is null then
    raise exception 'POSTONA_RESV_API_ROLLBACK_NOT_APPLIED';
  end if;
  if pg_catalog.to_regnamespace('postona_x_resv') is null or v_role is null or v_fn is null then
    raise exception 'POSTONA_RESV_API_ROLLBACK_PARTIAL_STATE';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv')
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_RESV_API_ROLLBACK_OWNER';
  end if;

  -- later layers (each one's own marker)
  if (select p.prosrc ~ 'G5_BINDING' from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.g5_x_autopost_allowed(uuid)'::regprocedure) then
    v_later := v_later || '003'::text;
  end if;
  if pg_catalog.to_regrole('postona_resv_worker') is not null or pg_catalog.to_regprocedure('postona_x_resv.release_unsent(uuid,uuid)') is not null then
    v_later := v_later || '004'::text;
  end if;
  if pg_catalog.to_regprocedure('postona_x_resv.post_now_begin(text,uuid,text,text)') is not null then
    v_later := v_later || '005'::text;
  end if;
  if pg_catalog.to_regprocedure('postona_x_resv.post_now_preflight(uuid,uuid)') is not null or pg_catalog.to_regclass('postona_x_resv.single_post_bindings') is not null then
    v_later := v_later || '006'::text;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'postona_x_resv.reservations'::regclass and c.conname = 'reservations_personal_mvp_bound') then
    v_later := v_later || '008'::text;
  end if;
  if pg_catalog.to_regnamespace('postona_threads_resv') is not null then
    v_later := v_later || 'threads_007'::text;
  end if;
  if pg_catalog.cardinality(v_later) > 0 then
    raise exception 'POSTONA_RESV_API_ROLLBACK_LATER_LAYER_PRESENT: %', pg_catalog.array_to_string(v_later, ',');
  end if;

  -- the only membership allowed is the one PostgreSQL 16+ gives the creating owner itself: ADMIN only (cannot SET to or INHERIT the role)
  if exists (select 1 from pg_catalog.pg_auth_members m
             where m.member = v_role
                or (m.roleid = v_role and not (m.member = (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
                                               and m.admin_option and not m.inherit_option and not m.set_option))) then
    raise exception 'POSTONA_RESV_API_ROLLBACK_MEMBERS';
  end if;

  -- every shared dependency of the role must be one of 002's own grants in THIS database: schema usage and EXECUTE on the six owner functions
  select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s', d.dbid, d.classid::regclass, d.objid, d.deptype), ',') into v_bad
  from pg_catalog.pg_shdepend d
  where d.refclassid = 'pg_catalog.pg_authid'::regclass and d.refobjid = v_role
    and not (d.deptype = 'a' and d.dbid = (select db.oid from pg_catalog.pg_database db where db.datname = pg_catalog.current_database())
             and ((d.classid = 'pg_catalog.pg_namespace'::regclass and d.objid = 'postona_x_resv'::regnamespace::oid)
                  or (d.classid = 'pg_catalog.pg_proc'::regclass and d.objid in (
                        'postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb)'::regprocedure::oid,
                        'postona_x_resv.list_reservations(text)'::regprocedure::oid,
                        'postona_x_resv.get_reservation(uuid)'::regprocedure::oid,
                        'postona_x_resv.reschedule(uuid,integer,timestamp with time zone)'::regprocedure::oid,
                        'postona_x_resv.reconfirm(uuid,integer,text)'::regprocedure::oid,
                        'postona_x_resv.cancel(uuid,integer)'::regprocedure::oid))));
  if v_bad is not null then
    raise exception 'POSTONA_RESV_API_ROLLBACK_FOREIGN_PRIVILEGES: %', v_bad;
  end if;
end $$;

drop function postona_x_resv.get_reservation(uuid);
revoke all on function
  postona_x_resv.create_batch(text, uuid, integer, text, jsonb, jsonb),
  postona_x_resv.list_reservations(text),
  postona_x_resv.reschedule(uuid, integer, timestamptz),
  postona_x_resv.reconfirm(uuid, integer, text),
  postona_x_resv.cancel(uuid, integer)
from postona_resv_api;
revoke all on schema postona_x_resv from postona_resv_api;
drop role postona_resv_api;

-- Postconditions: 002 is gone, and the API roles still reach nothing in the schema (001's own postcondition).
do $$
declare v_role text; v_bad text;
begin
  if pg_catalog.to_regrole('postona_resv_api') is not null or pg_catalog.to_regprocedure('postona_x_resv.get_reservation(uuid)') is not null then
    raise exception 'POSTONA_RESV_API_ROLLBACK_POSTCONDITION: 002 still present';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_schema_privilege(v_role, 'postona_x_resv', 'USAGE') then
      raise exception 'POSTONA_RESV_API_ROLLBACK_POSTCONDITION: % has schema usage', v_role;
    end if;
    select pg_catalog.string_agg(p.proname, ',') into v_bad from pg_catalog.pg_proc p
    where p.pronamespace = 'postona_x_resv'::regnamespace and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then raise exception 'POSTONA_RESV_API_ROLLBACK_POSTCONDITION: % executes %', v_role, v_bad; end if;
  end loop;
end $$;

commit;
