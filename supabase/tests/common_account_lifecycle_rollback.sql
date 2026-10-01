-- Rollback of 20261001150000_common_account_lifecycle_foundation.sql.
-- SOURCE CANDIDATE ONLY; proven on the disposable database by
-- common_account_lifecycle_run.sh (the schema dump after rollback is identical
-- to the dump taken before the candidate was applied).
--
-- Removes only what the candidate created. No existing table, policy, grant,
-- function or row is touched. Refuses while the guard is enforcing or a
-- deletion is in flight: both must be resolved first, on purpose.
begin;

do $$
begin
  if to_regclass('private.account_lifecycle_settings') is null then
    raise exception 'COMMON_ACCOUNT_FOUNDATION_NOT_APPLIED';
  end if;
  if exists (select 1 from private.account_lifecycle_settings where auth_delete_guard <> 'shadow') then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_GUARD_ENFORCING';
  end if;
  if exists (select 1 from private.account_lifecycle_operations where status = 'in_progress') then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_OPERATION_IN_PROGRESS';
  end if;
end;
$$;

drop function public.finalize_common_account_deletion(uuid, uuid);
drop function public.abort_common_account_deletion(uuid, uuid);
drop function public.mark_common_account_apple_revoked(uuid, uuid);
drop function public.begin_common_account_deletion(uuid, bigint);
drop function public.withdraw_kabumori_service(uuid);
drop function public.abort_service_deletion(uuid, text, uuid);
drop function public.finish_service_deletion(uuid, text, uuid);
drop function public.begin_service_deletion(uuid, text);
drop function public.common_account_deletion_eligibility(uuid);
drop function public.start_x_autopost_service();
drop function public.start_kabumori_service();

drop function private.account_lifecycle_backfill(boolean);
drop view private.account_lifecycle_backfill_plan;
drop function private.account_lifecycle_start_service(uuid, text);
drop function private.account_lifecycle_deletion_blockers(uuid, text);
drop function private.account_lifecycle_footprint(uuid);
drop function private.account_lifecycle_bump(uuid);
drop function private.account_lifecycle_lock(uuid, boolean, boolean);

drop table public.service_entitlements;
drop table public.common_accounts;
drop table private.account_lifecycle_operations;
drop table private.account_lifecycle_settings;
drop function private.account_lifecycle_guard_account_delete();

commit;
