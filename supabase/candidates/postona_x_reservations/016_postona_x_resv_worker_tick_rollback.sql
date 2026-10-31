-- G3 SOURCE CANDIDATE (2026-10-31, Issue #589 G3-02 #10): rollback of 016 (the worker tick). NOT applied anywhere. Run AFTER the
-- schedule's rollback (016_postona_x_resv_worker_tick_schedule_rollback.sql). Drops only 016's three functions and its tick table
-- (RESTRICT: anything else depending on them refuses); 001-015, pg_net, Vault and their entries stay as they are.
-- Refuses (nothing changed) when the every-minute job still exists (SCHEDULE_PRESENT), 016 is not applied (NOT_APPLIED), or the caller
-- is a superuser or not the schema owner (OWNER).
begin;

set local lock_timeout = '5s';

do $$
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_OWNER';
  end if;
  if pg_catalog.to_regclass('postona_x_resv.worker_ticks') is null then
    raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_NOT_APPLIED';
  end if;
  if pg_catalog.to_regclass('cron.job') is not null and exists (select 1 from cron.job j where j.jobname = 'postona-x-reservation-worker-tick') then
    raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_SCHEDULE_PRESENT';
  end if;
end $$;

drop function postona_x_resv.worker_tick_health(interval) restrict;
drop function postona_x_resv.tick_delivery_worker() restrict;
drop function postona_x_resv.worker_url_allowed(text) restrict;
drop table postona_x_resv.worker_ticks restrict;

commit;
