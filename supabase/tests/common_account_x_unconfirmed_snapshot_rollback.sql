-- Emergency rollback for 20261015120000_common_account_x_unconfirmed_snapshot_record. Disposable proof and reviewed
-- operator use only; never applied automatically.
--
-- Drops the recorder function. The shape CHECK is handled by what it would destroy:
--   * no operation row carries `x_unconfirmed_snapshots`: the CHECK goes back to Phase 8's exact definition;
--   * some row does: the WIDER CHECK STAYS. Those snapshot names are the audit of which X evidence sets this account
--     has acknowledged; narrowing the constraint would make the table reject its own rows, deleting them would destroy
--     the audit. A widened CHECK with no writer is harmless, and a re-apply of the migration accepts it.
-- Callers of the dropped function fail closed: an end that cannot record a snapshot stops (X `reconciliation_required`,
-- FAILED{x_posts_unconfirmed}); it never acknowledges a snapshot it did not record. Never uses CASCADE.
begin;

do $$
begin
  if to_regprocedure('public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)') is null then
    raise exception 'COMMON_ACCOUNT_X_UNCONFIRMED_ROLLBACK_NOT_APPLIED';
  end if;
end;
$$;

drop function public.record_owned_service_deletion_x_unconfirmed(uuid, text, uuid, uuid, integer, text);

do $$
begin
  if exists (select 1 from private.account_lifecycle_operations o where o.reconciliation ? 'x_unconfirmed_snapshots') then
    raise notice 'COMMON_ACCOUNT_X_UNCONFIRMED_ROLLBACK_KEPT_WIDER_SHAPE';
  else
    alter table private.account_lifecycle_operations drop constraint account_lifecycle_operations_reconciliation_shape;
    alter table private.account_lifecycle_operations
      add constraint account_lifecycle_operations_reconciliation_shape check (
        jsonb_typeof(reconciliation) = 'object'
        and (reconciliation - 'x_posts_unconfirmed') = '{}'::jsonb
        and (not reconciliation ? 'x_posts_unconfirmed' or jsonb_typeof(reconciliation -> 'x_posts_unconfirmed') = 'number'));
  end if;
end;
$$;

commit;
