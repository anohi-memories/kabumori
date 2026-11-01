-- G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-49): the X reservation worker's pre-send check answers the credential generation
-- pinned at claim, so the worker (x_bound_delivery.ts) sends only with a token of exactly that generation. NOT applied anywhere.
-- Applied after 014 (G3-48: G4's real X verdict + the claim pin); rolled back with 015_..._rollback.sql BEFORE 014's rollback (014's
-- rollback drops the pinned column; a 015 left behind would only throw, never answer a generation: nothing is sent on a throw).
--   pre_publish_check_bound(reservation, lease) -> (verdict, credential_generation):
--     verdict = 004's pre_publish_check, called unchanged (it locks the row, re-checks G5 and 014's row_publishable: G4 verified, the
--     pinned generation equal to the current one; it records NOT_PUBLISHABLE / hands back RELEASED itself);
--     credential_generation = the row's claim_credential_generation, read in the same transaction under that row lock, only when the
--     verdict is OK (64 hex, or NULL if no pin: the worker then refuses); NULL otherwise.
-- 004, 014 and every other function stay byte-identical. EXECUTE: the owner and postona_resv_worker only (G3's own worker role, as
-- 004's four worker functions); no GRANT on anything of G4's or G5's, no API role.
-- Refuses (nothing changed) when: 004's pre_publish_check / 014's row_publishable are not there byte for byte, 014's column / trigger
-- are missing, the function already exists; the caller is a superuser or does not own the schema, the table and those functions.
-- Postconditions: owners and ACLs of everything else unchanged; the new function's ACL exactly {owner, postona_resv_worker EXECUTE}.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check(uuid,uuid)') is null or pg_catalog.to_regprocedure('postona_x_resv.row_publishable(postona_x_resv.reservations)') is null
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check(uuid,uuid)'))) <> 'db4f69a903f3e0fb82d770b2ae1c6bec'
     or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.row_publishable(postona_x_resv.reservations)'))) <> '8ae093568fdaf130f94ebdeca2ac00bf'
     or not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = 'postona_x_resv.reservations'::pg_catalog.regclass
                    and a.attname = 'claim_credential_generation' and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'postona_x_resv.reservations'::pg_catalog.regclass
                    and t.tgname = 'reservations_claim_credential_pin' and t.tgenabled = 'O')
     or pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check_bound(uuid,uuid)') is not null
     or pg_catalog.to_regrole('postona_resv_worker') is null then
    raise exception 'G3_X_BOUND_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in ('postona_x_resv.pre_publish_check(uuid,uuid)'::pg_catalog.regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::pg_catalog.regprocedure) and p.proowner is distinct from v_owner) then
    raise exception 'G3_X_BOUND_OWNER';
  end if;
  perform pg_catalog.set_config('postona_x_bound.acl', (
    select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'postona_x_resv'
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'postona_x_resv'
      union all
      select n.nspname || ':' || n.nspowner::text || ':' || coalesce(n.nspacl::text, '-') from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') a), true);
end $$;

/** 004's pre-send check, unchanged, plus the generation pinned at claim when it answers OK (G3-49). */
create function postona_x_resv.pre_publish_check_bound(p_reservation_id uuid, p_lease_token uuid)
returns table (verdict text, credential_generation text)
language plpgsql volatile security definer set search_path = '' as $$
declare v_verdict text; v_pin text;
begin
  -- G3_X_BOUND_PRE_PUBLISH (G3-49)
  v_verdict := postona_x_resv.pre_publish_check(p_reservation_id, p_lease_token);
  if v_verdict = 'OK' then
    -- the row lock 004 took is still held (same transaction): the pin cannot move before this read
    select r.claim_credential_generation into v_pin from postona_x_resv.reservations r
    where r.id = p_reservation_id and r.status = 'claimed' and r.lease_token = p_lease_token;
  end if;
  return query select v_verdict, case when v_verdict = 'OK' then v_pin end;
end $$;

revoke all on function postona_x_resv.pre_publish_check_bound(uuid, uuid) from public, anon, authenticated, service_role, postona_resv_api;
grant execute on function postona_x_resv.pre_publish_check_bound(uuid, uuid) to postona_resv_worker;

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user); v_fn oid := 'postona_x_resv.pre_publish_check_bound(uuid,uuid)'::pg_catalog.regprocedure;
begin
  if (select pg_catalog.string_agg(x, '|' order by x) from (
      select p.oid::pg_catalog.regprocedure::text || ':' || p.proowner::text || ':' || coalesce(p.proacl::text, '-') as x from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'postona_x_resv' and p.oid <> v_fn
      union all
      select c.oid::pg_catalog.regclass::text || ':' || c.relowner::text || ':' || coalesce(c.relacl::text, '-') from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'postona_x_resv'
      union all
      select n.nspname || ':' || n.nspowner::text || ':' || coalesce(n.nspacl::text, '-') from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') a)
     is distinct from pg_catalog.current_setting('postona_x_bound.acl', true) then
    raise exception 'G3_X_BOUND_POSTCONDITION: an owner or ACL changed';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_owner
     or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_fn)
     or (select pg_catalog.string_agg(a.grantee::pg_catalog.regrole::text || '=' || a.privilege_type, ',' order by a.grantee::pg_catalog.regrole::text)
         from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee <> v_owner) is distinct from 'postona_resv_worker=EXECUTE'
     or not exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_fn and a.grantee = v_owner and a.privilege_type = 'EXECUTE') then
    raise exception 'G3_X_BOUND_POSTCONDITION: the new function is not owner + worker only';
  end if;
end $$;

commit;
