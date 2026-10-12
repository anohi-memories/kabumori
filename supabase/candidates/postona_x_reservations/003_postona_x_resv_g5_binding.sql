-- POSTONA X reservations — G5 x_autopost binding (F3 SOURCE CANDIDATE, 2026-10-13). NOT in supabase/migrations/.
-- Applies only after 001 (+ 002) AND the G5 common-account Phase 3b guard + Phase 4 fence (Draft PR #121 +
-- PR #152, owner G5/F5), which provide private.account_lifecycle_service_state_refusal(uuid, text). Those are
-- NOT approved for production yet: this file must not be applied anywhere until they are, and until one Sol（高）
-- integrated review and the user's explicit approval. G4 (verified X account, Issue #131) is NOT bound here:
-- postona_x_resv.g4_x_account_verified stays the shipped DENY.
--
-- What it changes: the body of postona_x_resv.g5_x_autopost_allowed(uuid) only. The DENY stub becomes the G5
-- writer decision, evaluated IN THE CALLER'S TRANSACTION with G5's lock order (login KEY SHARE -> account FOR
-- UPDATE -> entitlement FOR UPDATE, held until COMMIT, lock_timeout 3s): a freeze / deletion that commits first
-- makes the reservation write refuse; one that starts later waits for the reservation transaction. Every caller
-- of the predicate (create / list / get / reschedule / reconfirm / cancel through assert_account_access, and the
-- worker's claim_due / pre_publish_check through row_publishable) gets this decision. A lock wait that times out
-- raises POSTONA_RESV_SERVICE_BUSY (retryable; nothing written). Any other refusal is "not allowed".
-- Rollback: 003_postona_x_resv_g5_binding_rollback.sql restores the DENY stub.
begin;

do $$
declare v_fn regprocedure; v_p record;
begin
  if to_regprocedure('postona_x_resv.g5_x_autopost_allowed(uuid)') is null then
    raise exception 'POSTONA_RESV_G5_BINDING_PRECONDITION_001_MISSING';
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.g5_x_autopost_allowed(uuid)'::regprocedure) ~ 'G5_BINDING' then
    raise exception 'POSTONA_RESV_G5_BINDING_ALREADY_APPLIED';
  end if;
  v_fn := to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)');
  if v_fn is null then
    raise exception 'POSTONA_RESV_G5_BINDING_PRECONDITION_G5_MISSING';
  end if;
  select p.prorettype::regtype::text as ret, p.provolatile, p.prosecdef, p.proconfig into v_p from pg_catalog.pg_proc p where p.oid = v_fn;
  if v_p.ret <> 'text' or v_p.provolatile <> 'v' or not v_p.prosecdef or v_p.proconfig is null
     or not ('search_path=""' = any (v_p.proconfig)) then
    raise exception 'POSTONA_RESV_G5_BINDING_PRECONDITION_G5_SHAPE';
  end if;
  if not pg_catalog.has_function_privilege(current_user, v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception 'POSTONA_RESV_G5_BINDING_PRECONDITION_G5_ACL';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv')
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_RESV_G5_BINDING_PRECONDITION_OWNER';
  end if;
end $$;

create or replace function postona_x_resv.g5_x_autopost_allowed(p_user_id uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
-- G5_BINDING (F3 2026-10-13): the G5 writer decision for x_autopost, in the caller's transaction, locks kept.
declare v_refusal text;
begin
  v_refusal := private.account_lifecycle_service_state_refusal(p_user_id, 'x_autopost');
  if v_refusal = 'ACCOUNT_LIFECYCLE_BUSY' then
    raise exception 'POSTONA_RESV_SERVICE_BUSY' using errcode = 'P0001';
  end if;
  return v_refusal is null;
end $$;
revoke all on function postona_x_resv.g5_x_autopost_allowed(uuid) from public, anon, authenticated, service_role;
do $$ begin
  if to_regrole('postona_resv_api') is not null then
    execute 'revoke all on function postona_x_resv.g5_x_autopost_allowed(uuid) from postona_resv_api';
  end if;
end $$;

-- Postconditions: still owner-only and definer with an empty search_path; no API role reaches the predicate or
-- the G5 function; the G4 predicate is still the shipped DENY.
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] || (case when to_regrole('postona_resv_api') is null then array[]::text[] else array['postona_resv_api'] end) loop
    if pg_catalog.has_function_privilege(v_role, 'postona_x_resv.g5_x_autopost_allowed(uuid)', 'EXECUTE')
       or pg_catalog.has_function_privilege(v_role, 'private.account_lifecycle_service_state_refusal(uuid,text)', 'EXECUTE') then
      raise exception 'POSTONA_RESV_G5_BINDING_POSTCONDITION: % reaches the G5 decision', v_role;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.g5_x_autopost_allowed(uuid)'::regprocedure
                 and p.prosecdef and p.provolatile = 'v' and p.proconfig = array['search_path=""']) then
    raise exception 'POSTONA_RESV_G5_BINDING_POSTCONDITION: predicate shape';
  end if;
  if (select p.prosrc from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.g4_x_account_verified(uuid,text)'::regprocedure) !~ 'select false' then
    raise exception 'POSTONA_RESV_G5_BINDING_POSTCONDITION: G4 predicate is not the shipped DENY';
  end if;
end $$;

commit;
