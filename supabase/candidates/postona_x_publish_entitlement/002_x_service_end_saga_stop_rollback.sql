-- Rollback of 002_x_service_end_saga_stop.sql (F3 SOURCE CANDIDATE). Re-runnable.
-- Order: roll the saga's Edge code back FIRST (it calls these functions on every attempt and fails closed without
-- them), then let in-flight saga transactions drain -- this file also WAITS for them (below) -- then run this.
-- The durable record of X posts whose result is unknown (R1) is evidence: the rollback REFUSES while it holds rows
-- (acknowledge them through social_mobile_account_deletion_x_unconfirmed_ack, or export them, first).
-- R1b (J3 V3 re-review): the checkpoint tables' ACCESS EXCLUSIVE lock is taken FIRST, so a stop_x transaction that
-- already wrote a checkpoint but has not committed is waited for; the emptiness check then runs in a NEW statement
-- (a fresh READ COMMITTED snapshot after the wait) and sees what that writer committed. A refusal rolls everything
-- back: tables and functions stay exactly as they were.
begin;
do $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'X_SAGA_STOP_ROLLBACK_REQUIRES_READ_COMMITTED';
  end if;
  if to_regclass('public.social_mobile_account_deletion_x_unconfirmed') is not null then
    execute 'lock table public.social_mobile_account_deletion_x_unconfirmed in access exclusive mode';
  end if;
  if to_regclass('public.social_mobile_account_deletion_x_unconfirmed_ack_receipts') is not null then
    execute 'lock table public.social_mobile_account_deletion_x_unconfirmed_ack_receipts in access exclusive mode';
  end if;
end $$;
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
drop function if exists public.social_mobile_account_deletion_x_unconfirmed_ack(uuid, text);
drop function if exists public.social_mobile_account_deletion_x_unconfirmed_snapshot(text);
drop table if exists public.social_mobile_account_deletion_x_unconfirmed;
drop table if exists public.social_mobile_account_deletion_x_unconfirmed_ack_receipts;
commit;
