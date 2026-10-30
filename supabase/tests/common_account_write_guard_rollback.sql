-- Emergency rollback for 20261010051938_common_account_service_write_guard. Disposable proof and reviewed
-- operator use only; never applied automatically.
--
-- Removes the guard and nothing else. A writer that already calls it then FAILS CLOSED (the call raises
-- "function ... does not exist" and the writer's transaction writes nothing): rolling the guard back
-- closes its callers, it never reopens them. Reopening a writer without the guard is that writer
-- owner's separate, reviewed change.
begin;

do $$
begin
  if to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)') is null then
    raise exception 'COMMON_ACCOUNT_WRITE_GUARD_ROLLBACK_NOT_APPLIED';
  end if;
end;
$$;

drop function private.account_lifecycle_assert_active_service_write(uuid, text);

commit;
