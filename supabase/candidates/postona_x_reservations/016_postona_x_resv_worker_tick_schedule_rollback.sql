-- G3 SOURCE CANDIDATE (2026-10-31, Issue #589 G3-02 #10): rollback of the every-minute worker tick job. NOT applied anywhere. Removes
-- only the job named postona-x-reservation-worker-tick; 016's functions, the tick rows, pg_cron's other jobs and its run history stay.
-- A tick already running finishes; no new one starts. Refuses (nothing changed) when the job does not exist (NOT_APPLIED).
begin;

do $$
begin
  if pg_catalog.to_regclass('cron.job') is null or not exists (select 1 from cron.job j where j.jobname = 'postona-x-reservation-worker-tick') then
    raise exception 'POSTONA_X_WORKER_SCHEDULE_ROLLBACK_NOT_APPLIED';
  end if;
  perform cron.unschedule('postona-x-reservation-worker-tick');
end $$;

commit;
