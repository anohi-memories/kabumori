-- G3 SOURCE CANDIDATE (2026-10-31, Issue #589 G3-02 #12, H4-18 P2): the administrator's read-back before 016's rollback. NOT applied
-- anywhere. Read only, except the one record it leaves when nothing is found. pg_cron shows a non-superuser only its own jobs, so 016's
-- owner cannot prove that no hidden job (a superuser's, say) still calls the tick; this file is run by a role that sees every job.
--   NOT_ADMIN         the caller is neither a superuser nor a BYPASSRLS role able to read cron.job -> refused, nothing recorded;
--   NO_PG_CRON        pg_cron is absent: nothing to check (016's rollback needs no record then);
--   JOBS_PRESENT      a job of ANY owner calls the tick, under any name or spelling -> refused with each job's name and owner, nothing
--                     recorded. Nothing is unscheduled here: each job's owner stops it knowingly first;
--   otherwise         ALTER DATABASE <this database> SET postona_x_resv.worker_tick_rollback_check = '<unix s>:<all jobs seen>', which 016's
--                     rollback (a new session of the owner) accepts for 15 minutes.
-- It grants nothing, bypasses nothing for anyone else and changes no job. Afterwards the administrator may
-- ALTER DATABASE <db> RESET postona_x_resv.worker_tick_rollback_check (the record also expires on its own).
do $$
declare v_jobs text; v_total bigint; v_record text;
begin
  if (select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) is not true then
    raise exception 'POSTONA_X_WORKER_TICK_ADMIN_CHECK_NOT_ADMIN';
  end if;
  if pg_catalog.to_regclass('cron.job') is null then
    raise exception 'POSTONA_X_WORKER_TICK_ADMIN_CHECK_NO_PG_CRON';
  end if;
  if not pg_catalog.has_table_privilege('cron.job', 'SELECT') then
    raise exception 'POSTONA_X_WORKER_TICK_ADMIN_CHECK_NOT_ADMIN';
  end if;
  execute $q$select pg_catalog.string_agg(coalesce(j.jobname, '#' || j.jobid) || '@' || j.username, ',' order by j.jobid) from cron.job j
            where pg_catalog.lower(j.command) ~ 'tick_delivery_worker'$q$ into v_jobs;
  if v_jobs is not null then
    raise exception 'POSTONA_X_WORKER_TICK_ADMIN_CHECK_JOBS_PRESENT: %', v_jobs;
  end if;
  execute $q$select pg_catalog.count(*) from cron.job$q$ into v_total;
  v_record := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint || ':' || v_total;
  execute pg_catalog.format('alter database %I set postona_x_resv.worker_tick_rollback_check = %L', pg_catalog.current_database(), v_record);
  raise notice 'POSTONA_X_WORKER_TICK_ADMIN_CHECK_RECORDED %', v_record;
end $$;
