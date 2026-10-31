-- G3 SOURCE CANDIDATE (2026-10-31, Issue #589 G3-02 #10): the scheduler's call of the X reservation delivery worker. NOT applied anywhere,
-- NOT in supabase/migrations/. Applies after the rollout bundle (001-015) on a project that has pg_net and Vault. The every-minute
-- pg_cron job is a separate step (016_postona_x_resv_worker_tick_schedule.sql). Never apply before the worker's release gate, G4's
-- generation-bound credential source, the reviewed rollout and the user's explicit approval.
--
-- The same shape as the project's other scheduled Edge calls (pg_cron -> net.http_post, the secret read from Vault by NAME at call time,
-- never written into SQL, the repo or an ordinary table), plus what a delivery worker needs:
--   tick_delivery_worker()   one call of the worker entry: POST <postona_resv_worker_url> with header x-postona-worker-secret =
--                            <postona_resv_worker_secret>, body {}, no user token. It does NOT call when
--                              TICK_BUSY           another tick holds the tick lock right now (two cron runs at once),
--                              PREVIOUS_IN_FLIGHT  the previous call has no answer yet and is younger than 70 s (the worker's 45 s
--                                                  run budget + margin; pg_net's 55 s timeout answers it in any case),
--                              NOT_CONFIGURED      either Vault entry is missing / empty or the secret is shorter than 32 characters,
--                              URL_REFUSED         the URL is not exactly https://<project ref>.supabase.co/functions/v1/postona-x-
--                                                  reservation-worker (worker_url_allowed);
--                            otherwise INVOKED with pg_net's request id. Every tick leaves one row (outcome, request id, time; no
--                            secret, no URL). Re-sending is never this function's business: the worker claims only due rows under row
--                            locks and never re-sends an uncertain one, so an overlapping or repeated call cannot post twice.
--   worker_tick_health(since)  what the calls answered, read from pg_net's responses: per outcome and HTTP status the count, the last
--                            time and the last worker report (counts only). HTTP 200 / 401 WORKER_AUTH_REQUIRED / 503 NOT_AVAILABLE /
--                            NOT_CONFIGURED / STORE_UNAVAILABLE, TIMED_OUT, TRANSPORT_ERROR, PENDING (< 70 s), NO_RESPONSE (none
--                            arrived or pg_net's own retention removed it).
-- Privileges: owner only. No EXECUTE for PUBLIC, anon, authenticated, service_role, postona_resv_api or postona_resv_worker; no
-- SECURITY DEFINER (the cron job runs as the owner that scheduled it). Ticks older than 7 days are removed by the tick itself.
-- Rollback: 016_postona_x_resv_worker_tick_rollback.sql (after the schedule's rollback).
begin;

set local lock_timeout = '5s';

do $$
begin
  if pg_catalog.to_regprocedure('postona_x_resv.claim_due(text,integer,integer)') is null
     or pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check_bound(uuid,uuid)') is null then
    raise exception 'POSTONA_X_WORKER_TICK_PRECONDITION_015_MISSING';
  end if;
  if pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null or pg_catalog.to_regclass('net._http_response') is null then
    raise exception 'POSTONA_X_WORKER_TICK_PRECONDITION_PG_NET_MISSING';
  end if;
  if pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    raise exception 'POSTONA_X_WORKER_TICK_PRECONDITION_VAULT_MISSING';
  end if;
  if pg_catalog.to_regclass('postona_x_resv.worker_ticks') is not null then
    raise exception 'POSTONA_X_WORKER_TICK_ALREADY_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_X_WORKER_TICK_OWNER';
  end if;
end $$;

create table postona_x_resv.worker_ticks (
  id bigint generated always as identity primary key,
  ticked_at timestamptz not null default pg_catalog.now(),
  outcome text not null check (outcome in ('INVOKED', 'TICK_BUSY', 'PREVIOUS_IN_FLIGHT', 'NOT_CONFIGURED', 'URL_REFUSED')),
  request_id bigint,
  check ((outcome = 'INVOKED') = (request_id is not null))
);
alter table postona_x_resv.worker_ticks enable row level security;

/** The only worker URL a tick calls: the project's own worker entry over https. */
create function postona_x_resv.worker_url_allowed(p_url text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_url ~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/postona-x-reservation-worker$', false)
$$;

create function postona_x_resv.tick_delivery_worker() returns text
language plpgsql volatile set search_path = '' as $$
declare v_url text; v_secret text; v_last postona_x_resv.worker_ticks%rowtype; v_request bigint;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('postona_x_resv:worker_tick', 0)) then
    insert into postona_x_resv.worker_ticks (outcome) values ('TICK_BUSY');
    return 'TICK_BUSY';
  end if;
  delete from postona_x_resv.worker_ticks t where t.ticked_at < pg_catalog.now() - interval '7 days';
  select t.* into v_last from postona_x_resv.worker_ticks t where t.outcome = 'INVOKED' order by t.id desc limit 1;
  if found and v_last.ticked_at > pg_catalog.now() - interval '70 seconds'
     and not exists (select 1 from net._http_response r where r.id = v_last.request_id) then
    insert into postona_x_resv.worker_ticks (outcome) values ('PREVIOUS_IN_FLIGHT');
    return 'PREVIOUS_IN_FLIGHT';
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'postona_resv_worker_url' limit 1;
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = 'postona_resv_worker_secret' limit 1;
  if v_url is null or v_url = '' or v_secret is null or pg_catalog.length(v_secret) < 32 then
    insert into postona_x_resv.worker_ticks (outcome) values ('NOT_CONFIGURED');
    return 'NOT_CONFIGURED';
  end if;
  if not postona_x_resv.worker_url_allowed(v_url) then
    insert into postona_x_resv.worker_ticks (outcome) values ('URL_REFUSED');
    return 'URL_REFUSED';
  end if;
  v_request := net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'x-postona-worker-secret', v_secret),
    timeout_milliseconds := 55000);
  insert into postona_x_resv.worker_ticks (outcome, request_id) values ('INVOKED', v_request);
  return 'INVOKED';
end $$;

create function postona_x_resv.worker_tick_health(p_since interval default interval '1 hour')
returns table (outcome text, http_status integer, ticks bigint, last_at timestamptz, last_report jsonb)
language sql stable set search_path = '' as $$
  with k as (
    select t.id, t.ticked_at,
           case when t.outcome <> 'INVOKED' then t.outcome
                when r.id is null then case when t.ticked_at > pg_catalog.now() - interval '70 seconds' then 'PENDING' else 'NO_RESPONSE' end
                when r.timed_out then 'TIMED_OUT'
                when r.status_code is null then 'TRANSPORT_ERROR'
                else 'HTTP' end as outcome,
           r.status_code,
           case when r.status_code = 200 and r.content is not null then (r.content::jsonb) -> 'report' end as report
    from postona_x_resv.worker_ticks t left join net._http_response r on t.outcome = 'INVOKED' and r.id = t.request_id
    where t.ticked_at > pg_catalog.now() - p_since)
  select k.outcome, k.status_code, pg_catalog.count(*), pg_catalog.max(k.ticked_at),
         (pg_catalog.array_agg(k.report order by k.id desc) filter (where k.report is not null))[1]
  from k group by k.outcome, k.status_code order by k.outcome, k.status_code
$$;

revoke all on table postona_x_resv.worker_ticks from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.worker_url_allowed(text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.tick_delivery_worker() from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.worker_tick_health(interval) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

-- Postconditions: nobody but the owner reaches the three functions or the table; none is SECURITY DEFINER.
do $$
declare v_bad text;
begin
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ',') into v_bad
  from pg_catalog.pg_proc p cross join pg_catalog.pg_roles r
  where p.oid in ('postona_x_resv.worker_url_allowed(text)'::regprocedure, 'postona_x_resv.tick_delivery_worker()'::regprocedure,
                  'postona_x_resv.worker_tick_health(interval)'::regprocedure)
    and r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker')
    and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'POSTONA_X_WORKER_TICK_POSTCONDITION: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
             and p.proname in ('worker_url_allowed', 'tick_delivery_worker', 'worker_tick_health') and p.prosecdef) then
    raise exception 'POSTONA_X_WORKER_TICK_POSTCONDITION: security definer';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker')
             and pg_catalog.has_table_privilege(r.oid, 'postona_x_resv.worker_ticks', 'SELECT,INSERT,UPDATE,DELETE')) then
    raise exception 'POSTONA_X_WORKER_TICK_POSTCONDITION: table privilege';
  end if;
end $$;

commit;
