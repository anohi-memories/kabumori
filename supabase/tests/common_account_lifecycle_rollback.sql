-- Rollback of 20261001150000_common_account_lifecycle_foundation.sql.
-- SOURCE CANDIDATE ONLY; proven on the disposable database by
-- common_account_lifecycle_run.sh (the schema dump after rollback is identical
-- to the dump taken before the candidate was applied).
--
-- Removes only what the candidate created. No existing table, policy, grant,
-- function or row is touched. It is a pre-integration rollback: it runs only
-- from an affirmatively safe shadow state. A missing or unexpected settings row
-- is NOT that state (the guard treats a missing row as enforcing).
--   * exactly one settings row, guard 'shadow', integration 'not_started'
--   * the built-in managed checkpoints are all present
--   * no lifecycle operation in flight
--   * no self-registered entitlement (a client is already using the start RPCs)
--   * nothing else depends on these objects: every DROP below is without
--     CASCADE, so a dependent object aborts the whole transaction
begin;

do $$
begin
  if to_regclass('private.account_lifecycle_settings') is null then
    raise exception 'COMMON_ACCOUNT_FOUNDATION_NOT_APPLIED';
  end if;
  if (select count(*) from private.account_lifecycle_settings) <> 1 then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_SETTINGS_NOT_AFFIRMED';
  end if;
  if (select auth_delete_guard from private.account_lifecycle_settings) is distinct from 'shadow' then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_GUARD_ENFORCING';
  end if;
  if (select integration_state from private.account_lifecycle_settings) is distinct from 'not_started' then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_INTEGRATION_STARTED';
  end if;
  if (select count(*) from private.account_lifecycle_managed_checkpoints
       where checkpoint_key in ('session_revocation', 'storage_cleanup', 'apple_revocation')) <> 3 then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_SETTINGS_NOT_AFFIRMED';
  end if;
  if exists (select 1 from private.account_lifecycle_operations where status = 'in_progress') then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_OPERATION_IN_PROGRESS';
  end if;
  if exists (select 1 from public.common_accounts where status <> 'active') then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_ACCOUNT_NOT_ACTIVE';
  end if;
  if exists (select 1 from public.service_entitlements where source = 'self_service') then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_INTEGRATION_STARTED';
  end if;
end;
$$;

drop function public.prepare_common_account_auth_delete(uuid, uuid);
drop function public.abort_common_account_deletion(uuid, uuid);
drop function public.record_common_account_deletion_checkpoint(uuid, uuid, text);
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
drop function private.account_lifecycle_required_checkpoints(uuid);
drop function private.account_lifecycle_managed_ownership(uuid);
drop function private.account_lifecycle_deletion_blockers(uuid, text);
drop function private.account_lifecycle_footprint(uuid);
drop function private.account_lifecycle_lock(uuid, boolean, boolean);

drop table public.service_entitlements;
drop table public.common_accounts;
drop table private.account_lifecycle_operations;
drop table private.account_lifecycle_managed_checkpoints;
drop table private.account_lifecycle_settings;
drop function private.account_lifecycle_touch_entitlement();
drop function private.account_lifecycle_touch_account();
drop function private.account_lifecycle_guard_account_delete();

commit;
