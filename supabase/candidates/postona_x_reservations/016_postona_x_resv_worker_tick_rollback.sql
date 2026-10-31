-- G3 SOURCE CANDIDATE (2026-10-31, Issue #589 G3-02 #10, repaired in #11 after H4-17 P2): rollback of 016 (the worker tick). NOT applied
-- anywhere. Run AFTER the schedule's rollback (016_postona_x_resv_worker_tick_schedule_rollback.sql). Drops only 016's four functions and
-- its two tables (RESTRICT: anything else depending on them refuses); 001-015, pg_net, pg_cron, Vault and their entries stay as they are.
-- Refuses with nothing changed when:
--   OWNER                  the caller is a superuser or not the schema owner;
--   NOT_APPLIED            016 is not applied;
--   CRON_CATALOG_UNREADABLE pg_cron is present but its job list cannot be read (it cannot prove that no job calls the tick);
--   SCHEDULE_PRESENT       ANY job the owner can see calls the tick, under any name or spelling (the canonical job, an alias, a
--                          schema-qualified, quoted or differently cased call); no job is unscheduled here -- the operator removes
--                          each one knowingly first;
--   CRON_JOBS_NOT_ALL_VISIBLE (G3-02 #12, H4-18 P2) pg_cron's row-level security shows this caller only its own jobs (cron.job has
--                          RLS and the caller neither owns it nor bypasses RLS), so "no visible job calls the tick" is not "no job
--                          does": a superuser's job (which may EXECUTE the tick whatever its ACL says) stays hidden. The rollback then
--                          needs an administrator's read-back from the last 15 minutes: 016_postona_x_resv_worker_tick_rollback_admin_check
--                          .sql, run by a superuser / BYPASSRLS role that sees every job, found none calling the tick and recorded
--                          postona_x_resv.worker_tick_rollback_check = '<unix s>:<all jobs it saw>' on this database. Missing, malformed,
--                          older than 15 minutes, or counting fewer jobs than this caller can see -> refused;
--   TICK_REFERENCED        a function outside 016 names the tick (a wrapper a job could call).
-- Every check runs before the first DROP, so a refusal leaves 016 whole. Limits (stated): a call built from pieces at run time is beyond a
-- catalog check; a job scheduled after the administrator's read-back and within its 15 minutes is the operator's to prevent (stop the
-- scheduler's changes for the window). The record expires on its own; the administrator may RESET it afterwards.
begin;

set local lock_timeout = '5s';

do $$
declare v_jobs text; v_fns text; v_visible bigint; v_check text; v_parts text[];
begin
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_OWNER';
  end if;
  if pg_catalog.to_regclass('postona_x_resv.worker_ticks') is null then
    raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_NOT_APPLIED';
  end if;
  if pg_catalog.to_regclass('cron.job') is not null then
    if not pg_catalog.has_table_privilege('cron.job', 'SELECT') then
      raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_CRON_CATALOG_UNREADABLE';
    end if;
    execute $q$select pg_catalog.string_agg(j.jobname, ',' order by j.jobname) from cron.job j
              where pg_catalog.lower(j.command) ~ 'tick_delivery_worker'$q$ into v_jobs;
    if v_jobs is not null then
      raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_SCHEDULE_PRESENT: %', v_jobs;
    end if;
    -- H4-18 P2: jobs this caller cannot see need an administrator's fresh read-back
    if exists (select 1 from pg_catalog.pg_class c where c.oid = 'cron.job'::regclass and c.relrowsecurity
                 and (c.relforcerowsecurity or c.relowner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)))
       and (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user) is not true then
      execute $q$select pg_catalog.count(*) from cron.job$q$ into v_visible;
      v_check := pg_catalog.current_setting('postona_x_resv.worker_tick_rollback_check', true);
      v_parts := pg_catalog.regexp_match(coalesce(v_check, ''), '^([0-9]{10}):([0-9]{1,9})$');
      if v_parts is null
         or pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint - v_parts[1]::bigint not between 0 and 900
         or v_parts[2]::bigint < v_visible then
        raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_CRON_JOBS_NOT_ALL_VISIBLE';
      end if;
    end if;
  end if;
  select pg_catalog.string_agg(p.oid::regprocedure::text, ',') into v_fns
  from pg_catalog.pg_proc p
  where pg_catalog.lower(p.prosrc) ~ 'tick_delivery_worker'
    and p.oid not in ('postona_x_resv.tick_delivery_worker()'::regprocedure);
  if v_fns is not null then
    raise exception 'POSTONA_X_WORKER_TICK_ROLLBACK_TICK_REFERENCED: %', v_fns;
  end if;
end $$;

drop function postona_x_resv.worker_tick_health(interval) restrict;
drop function postona_x_resv.consume_worker_tick(text) restrict;
drop function postona_x_resv.tick_delivery_worker() restrict;
drop function postona_x_resv.worker_url(text) restrict;
drop table postona_x_resv.worker_ticks restrict;
drop table postona_x_resv.worker_target restrict;

commit;
