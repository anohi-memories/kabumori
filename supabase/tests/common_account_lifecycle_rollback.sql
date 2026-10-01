-- Rollback of 20261001150000_common_account_lifecycle_foundation.sql.
-- SOURCE CANDIDATE ONLY; proven on the disposable database by
-- common_account_lifecycle_run.sh (the schema dump after rollback is identical
-- to the dump taken before the candidate was applied).
--
-- Removes only what the candidate created, in one transaction (no partial
-- teardown). No existing table, policy, grant, function or row is touched. It
-- is a pre-integration rollback: it runs only from an affirmatively safe
-- shadow state. A missing or unexpected settings row is NOT that state (the
-- guard treats it as "refuse every login delete").
--   * exactly one settings row, guard 'shadow', integration 'not_started'
--   * the checkpoint registry is exactly the built-in contract: the three
--     built-in rows with their own meaning, and nothing else
--   * no lifecycle operation at all, open or finished: one would mean the
--     lifecycle RPCs (deletion intent, readiness) are already in use
--   * no account that is not 'active'
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
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_GUARD_NOT_SHADOW';
  end if;
  if (select integration_state from private.account_lifecycle_settings) is distinct from 'not_started' then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_INTEGRATION_STARTED';
  end if;
  -- The contract is spelled out here on purpose, not read from the candidate.
  if exists (
    select 1
      from (values ('apple_revocation', 'apple_identity'), ('session_revocation', 'always'),
                   ('storage_cleanup', 'always')) b (checkpoint_key, requirement)
      full join private.account_lifecycle_managed_checkpoints c on c.checkpoint_key = b.checkpoint_key
     where c.requirement is distinct from b.requirement
  ) then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_REQUIREMENTS_NOT_AFFIRMED';
  end if;
  if exists (select 1 from private.account_lifecycle_operations) then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_OPERATIONS_EXIST';
  end if;
  if exists (select 1 from public.common_accounts where status <> 'active') then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_ACCOUNT_NOT_ACTIVE';
  end if;
  if exists (select 1 from public.service_entitlements where source = 'self_service') then
    raise exception 'COMMON_ACCOUNT_ROLLBACK_REFUSED_SELF_SERVICE_ENTITLEMENTS_EXIST';
  end if;
end;
$$;

drop function public.prepare_common_account_auth_delete(uuid, uuid);
drop function public.abort_common_account_deletion(uuid, uuid);
drop function public.clear_common_account_deletion_checkpoint(uuid, uuid, text);
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
drop function private.account_lifecycle_authorization_problems(uuid, uuid);
drop function private.account_lifecycle_readiness_refusal(uuid, jsonb);
drop function private.account_lifecycle_required_checkpoints(uuid);
drop function private.account_lifecycle_requirements_valid();
drop function private.account_lifecycle_managed_ownership(uuid);
drop function private.account_lifecycle_deletion_blockers(uuid, text);
drop function private.account_lifecycle_footprint(uuid);
drop function private.account_lifecycle_lock(uuid, boolean, boolean);

drop table public.service_entitlements;
drop table public.common_accounts;
drop table private.account_lifecycle_operations;
drop table private.account_lifecycle_managed_checkpoints;
drop table private.account_lifecycle_settings;
drop function private.account_lifecycle_settings_changed();
drop function private.account_lifecycle_touch_settings();
drop function private.account_lifecycle_requirements_changed();
drop function private.account_lifecycle_guard_checkpoint_registry();
drop function private.account_lifecycle_builtin_checkpoints();
drop function private.account_lifecycle_touch_entitlement();
drop function private.account_lifecycle_guard_entitlement_identity();
drop function private.account_lifecycle_account_changed();
drop function private.account_lifecycle_touch_account();
drop function private.account_lifecycle_invalidate_readiness(uuid, text);
drop function private.account_lifecycle_guard_account_delete();

commit;
