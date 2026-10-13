-- Emergency rollback for 20261013140000_common_account_service_reconciliation_facts. Disposable proof and reviewed
-- operator use only; never applied automatically.
--
-- Drops the two functions. KEEPS the `reconciliation` column and its shape constraint: they hold the audit of what an
-- end could not confirm (X posts whose result was never known) and are additive; a re-apply after this rollback
-- finds the column in exactly the shape it creates and adds only the two functions (any other same-named column is
-- refused with COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_SHAPE, a re-apply while the functions exist with
-- COMMON_ACCOUNT_RECONCILIATION_ALREADY_APPLIED, never silently).
-- Callers of the dropped functions fail closed: an end that cannot record an unconfirmed count stops
-- (SERVICE_CLEANUP_INCOMPLETE / FAILED), it never ends without it. Never uses CASCADE.
begin;

do $$
begin
  if to_regprocedure('public.record_owned_service_deletion_reconciliation(uuid,text,uuid,uuid,text,integer)') is null
     and to_regprocedure('public.common_account_service_end_result(uuid,text)') is null then
    raise exception 'COMMON_ACCOUNT_RECONCILIATION_ROLLBACK_NOT_APPLIED';
  end if;
end;
$$;

drop function if exists public.record_owned_service_deletion_reconciliation(uuid, text, uuid, uuid, text, integer);
drop function if exists public.common_account_service_end_result(uuid, text);

commit;
