-- G3 SOURCE CANDIDATE (2026-10-31, Issue #589 G3-02 #10): the every-minute pg_cron job that calls tick_delivery_worker() (016).
-- NOT applied anywhere. A separate step from 016 so the tick can be installed, configured (Vault) and checked by hand before
-- anything runs on its own. Needs pg_cron. Run as the owner of 016 (the job runs as the role that scheduled it).
-- Every minute: the worker's run budget (45 s) ends before the next tick; an overlapping tick is answered by the tick itself
-- (PREVIOUS_IN_FLIGHT / TICK_BUSY) and, if one ever got through, by the worker's own row locks (each due row claimed once).
-- Refuses (nothing changed) when 016 is missing, pg_cron is missing, or the job already exists.
-- Rollback: 016_postona_x_resv_worker_tick_schedule_rollback.sql.
begin;

do $$
begin
  if pg_catalog.to_regprocedure('postona_x_resv.tick_delivery_worker()') is null then
    raise exception 'POSTONA_X_WORKER_SCHEDULE_PRECONDITION_016_MISSING';
  end if;
  if pg_catalog.to_regclass('cron.job') is null then
    raise exception 'POSTONA_X_WORKER_SCHEDULE_PRECONDITION_PG_CRON_MISSING';
  end if;
  if exists (select 1 from cron.job j where j.jobname = 'postona-x-reservation-worker-tick') then
    raise exception 'POSTONA_X_WORKER_SCHEDULE_ALREADY_APPLIED';
  end if;
  perform cron.schedule('postona-x-reservation-worker-tick', '* * * * *', 'select postona_x_resv.tick_delivery_worker()');
end $$;

commit;
