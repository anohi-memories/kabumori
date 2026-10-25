-- G5-40 NEW FILE (not a copy of an earlier candidate): a READ-ONLY guard to run immediately before the base rollbacks R30 / R20 / R10 of this
-- bundle. Those three (copied verbatim from the G5 stack 21a5cad4) are unconditional `drop function if exists`: they would drop R1 / R0 / SV
-- (and W1 / W2) while D1 / S2-3 / S2-2 / S2-1 still sit on top, or while a consumer still calls them (shown by the bundle suite). This guard
-- refuses, and changes nothing, unless:
--   * the layers above are rolled back already: no S2-2 gate, no S2-3 predicate, T13 / R1 / R0 / SV with exactly their reviewed bodies;
--   * no other function's source text names R1 / R0 / SV / W1 / W2 (lower-cased; PL/pgSQL calls are not recorded dependencies), and no recorded
--     dependency (a view, a BEGIN ATOMIC body) points at them.
-- It cannot see dynamic SQL, another database or callers outside the database (Edge / app): those consumers are removed first, by procedure.
-- It writes nothing, takes no lock beyond the catalog reads, and grants nothing. Its own review is part of the bundle's one review (G5-40).
do $$
declare
  v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_r1 regprocedure := pg_catalog.to_regprocedure('public.common_account_authorization_verdict(text,text,text)');
  v_r0 regprocedure := pg_catalog.to_regprocedure('public.common_account_bootstrap_verdict(text,text)');
  v_sv regprocedure := pg_catalog.to_regprocedure('private.account_lifecycle_session_verdict()');
  v_w1 regprocedure := pg_catalog.to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)');
  v_w2 regprocedure := pg_catalog.to_regprocedure('public.common_account_worker_brand_verdict(text,text,bigint,bigint)');
  v_t13 regprocedure := pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)');
  v_set oid[];
  v_md5 text;
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'BUNDLE_ROLLBACK_GUARD_OWNER_IS_SUPERUSER';
  end if;
  -- the layers above first (R70, R60, R50, R40 of this bundle)
  if pg_catalog.to_regprocedure('private.postona_personal_session()') is not null then
    raise exception 'BUNDLE_ROLLBACK_GUARD_S2_2_PRESENT';
  end if;
  if pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)') is not null then
    raise exception 'BUNDLE_ROLLBACK_GUARD_S2_3_PRESENT';
  end if;
  if v_t13 is not null and (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_t13) is distinct from '08840016794a973225be767952265e79' then
    raise exception 'BUNDLE_ROLLBACK_GUARD_T13_NOT_REVIEWED';
  end if;
  foreach v_md5 in array array[
      coalesce((select '781b00e342e29b709df967571922d27f' = pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_r1), true)::text,
      coalesce((select 'e999adeb6cb877b2b3001501d58397a4' = pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_r0), true)::text,
      coalesce((select '69840800118ab8d66ceabfa81fbc93dd' = pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_sv), true)::text] loop
    if v_md5 is distinct from 'true' then
      raise exception 'BUNDLE_ROLLBACK_GUARD_VERDICT_NOT_REVIEWED';  -- D1 still applied, or someone else's change
    end if;
  end loop;
  -- nothing else may still use them
  v_set := array_remove(array[v_r1::oid, v_r0::oid, v_sv::oid, v_w1::oid, v_w2::oid], null);
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid <> all (v_set)
                and pg_catalog.lower(p.prosrc) ~ '(common_account_authorization_verdict|common_account_bootstrap_verdict|account_lifecycle_session_verdict|account_lifecycle_worker_brand_verdict|common_account_worker_brand_verdict)') then
    raise exception 'BUNDLE_ROLLBACK_GUARD_CALLERS';
  end if;
  if exists (select 1 from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass and d.refobjid = any (v_set)) then
    raise exception 'BUNDLE_ROLLBACK_GUARD_DEPENDENTS';
  end if;
end $$;
