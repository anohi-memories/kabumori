-- Rollback of 002_x_service_end_saga_stop.sql (F3 SOURCE CANDIDATE). The saga's Edge code must be rolled back
-- first (it calls these functions on every attempt and fails closed without them). Re-runnable.
-- The durable record of X posts whose result is unknown (R1) is evidence: the rollback REFUSES while it holds
-- rows (acknowledge them through social_mobile_account_deletion_x_unconfirmed_ack, or export them, first).
begin;
do $$
begin
  if to_regclass('public.social_mobile_account_deletion_x_unconfirmed') is not null
     and exists (select 1 from public.social_mobile_account_deletion_x_unconfirmed) then
    raise exception 'X_SAGA_STOP_ROLLBACK_UNCONFIRMED_PRESENT';
  end if;
end $$;
drop function if exists public.social_mobile_account_deletion_stop_x(uuid, uuid);
drop function if exists public.social_mobile_account_deletion_x_precheck(uuid);
drop function if exists public.social_mobile_account_deletion_x_unconfirmed_ack(uuid, integer);
drop table if exists public.social_mobile_account_deletion_x_unconfirmed;
commit;
