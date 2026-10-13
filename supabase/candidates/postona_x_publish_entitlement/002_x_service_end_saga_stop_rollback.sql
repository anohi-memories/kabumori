-- Rollback of 002_x_service_end_saga_stop.sql (F3 SOURCE CANDIDATE). The saga's Edge code must be rolled back
-- first (it calls this function on every attempt and fails closed without it). Data is not touched. Re-runnable.
begin;
drop function if exists public.social_mobile_account_deletion_stop_x(uuid, uuid);
drop function if exists public.social_mobile_account_deletion_x_precheck(uuid);
commit;
