-- G3 SOURCE CANDIDATE (2026-10-31, Issue #589 G3-02 #10, repaired in #11 after H4-17): the scheduler's call of the X reservation
-- delivery worker. NOT applied anywhere, NOT in supabase/migrations/ or the rollout MANIFEST. Applies after the rollout bundle (001-015)
-- on a project that has pg_net, Vault and pgcrypto (schema `extensions`). The every-minute pg_cron job is a separate step
-- (016_postona_x_resv_worker_tick_schedule.sql). Never apply before the worker's release gate, G4's generation-bound credential source,
-- the reviewed rollout and the user's explicit approval.
--
-- The project's shape for scheduled Edge calls (pg_cron -> net.http_post, the key read from Vault by NAME at call time), with what
-- H4-17 found missing:
--   P1 no reusable secret in pg_net's queue. pg_net keeps a request's headers in net.http_request_queue until it is sent, and other
--      database roles may read that table. The tick therefore never puts POSTONA_RESV_WORKER_SECRET there. It sends ONE signed, one-use
--      ticket: x-postona-worker-tick: v1.<project ref>.<unix seconds>.<nonce: 64 hex>.<HMAC-SHA256(secret, "v1.<ref>.<s>.<nonce>")>.
--      The worker (postona-x-reservation-worker/http.ts) checks the signature with its own copy of the secret, that the ref is its own
--      project, that the time is within 120 s, and then consume_worker_tick(nonce): true exactly once, for a nonce this tick issued
--      less than 120 s ago (only the nonce's SHA-256 is stored). Whoever reads the queue gets at most that one ticket, good for one run
--      of the worker -- the run the scheduler asked for anyway -- and never the secret.
--   P2 the target is pinned, not read. Vault holds no URL. worker_target holds this project's ref (written once by the owner during the
--      reviewed rollout); worker_url(ref) builds https://<ref>.supabase.co/functions/v1/postona-x-reservation-worker from it. No pin, or a
--      Vault-supplied URL, never redirects a tick, and the ticket is bound to the pinned ref (another project's worker refuses it).
-- tick_delivery_worker() answers, and leaves one worker_ticks row (outcome, request id, nonce hash, time; no secret, no URL):
--   TICK_BUSY           another tick holds the tick lock right now (two cron runs at once);
--   PREVIOUS_IN_FLIGHT  the previous call has no answer yet and is younger than 70 s (the worker's 45 s budget + margin);
--   NOT_CONFIGURED      no pinned ref, or the Vault key postona_resv_worker_secret is missing / shorter than 32 characters;
--   INVOKED             one net.http_post with the ticket (body {}, timeout 55 s).
-- Re-sending is never the tick's business: the worker claims due rows under row locks and never re-sends an uncertain one.
-- worker_tick_health(since): per outcome and HTTP status the count, last time and last worker report (counts only), from pg_net.
-- Privileges: owner only, except consume_worker_tick (SECURITY DEFINER, EXECUTE for postona_resv_worker only: the worker's own login
-- proves a ticket once). Ticks older than 7 days are removed by the tick itself.
-- Rollback: 016_postona_x_resv_worker_tick_rollback.sql (after the schedule's rollback; refuses while any visible job calls the tick).
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
  if pg_catalog.to_regprocedure('extensions.hmac(text,text,text)') is null or pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'POSTONA_X_WORKER_TICK_PRECONDITION_PGCRYPTO_MISSING';
  end if;
  if pg_catalog.to_regrole('postona_resv_worker') is null then
    raise exception 'POSTONA_X_WORKER_TICK_PRECONDITION_WORKER_ROLE_MISSING';
  end if;
  if pg_catalog.to_regclass('postona_x_resv.worker_ticks') is not null then
    raise exception 'POSTONA_X_WORKER_TICK_ALREADY_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'POSTONA_X_WORKER_TICK_OWNER';
  end if;
end $$;

/** This project's ref: one row, written by the owner during the reviewed rollout. */
create table postona_x_resv.worker_target (
  singleton boolean primary key default true check (singleton),
  project_ref text not null check (project_ref ~ '^[a-z0-9]{20}$'),
  pinned_at timestamptz not null default pg_catalog.now()
);
alter table postona_x_resv.worker_target enable row level security;

create table postona_x_resv.worker_ticks (
  id bigint generated always as identity primary key,
  ticked_at timestamptz not null default pg_catalog.now(),
  outcome text not null check (outcome in ('INVOKED', 'TICK_BUSY', 'PREVIOUS_IN_FLIGHT', 'NOT_CONFIGURED')),
  request_id bigint,
  nonce_sha256 text unique check (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz,
  check ((outcome = 'INVOKED') = (request_id is not null) and (outcome = 'INVOKED') = (nonce_sha256 is not null)),
  check (consumed_at is null or outcome = 'INVOKED')
);
alter table postona_x_resv.worker_ticks enable row level security;

/** The only target a tick calls: this project's worker entry over https, from the pinned ref. */
create function postona_x_resv.worker_url(p_ref text) returns text
language sql immutable set search_path = '' as $$
  select case when p_ref ~ '^[a-z0-9]{20}$' then 'https://' || p_ref || '.supabase.co/functions/v1/postona-x-reservation-worker' end
$$;

create function postona_x_resv.tick_delivery_worker() returns text
language plpgsql volatile set search_path = '' as $$
declare v_ref text; v_url text; v_key text; v_last postona_x_resv.worker_ticks%rowtype; v_nonce text; v_message text; v_request bigint;
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
  select w.project_ref into v_ref from postona_x_resv.worker_target w;
  v_url := postona_x_resv.worker_url(v_ref);
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'postona_resv_worker_secret' limit 1;
  if v_url is null or v_key is null or pg_catalog.length(v_key) < 32 then
    insert into postona_x_resv.worker_ticks (outcome) values ('NOT_CONFIGURED');
    return 'NOT_CONFIGURED';
  end if;
  v_nonce := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_message := 'v1.' || v_ref || '.' || pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()))::bigint || '.' || v_nonce;
  v_request := net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json',
      'x-postona-worker-tick', v_message || '.' || pg_catalog.encode(extensions.hmac(v_message, v_key, 'sha256'), 'hex')),
    timeout_milliseconds := 55000);
  v_key := null;
  insert into postona_x_resv.worker_ticks (outcome, request_id, nonce_sha256)
  values ('INVOKED', v_request, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_nonce, 'UTF8')), 'hex'));
  return 'INVOKED';
end $$;

/** The worker proves a ticket once: true only for a nonce a tick issued < 120 s ago and nobody consumed yet. */
create function postona_x_resv.consume_worker_tick(p_nonce text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  update postona_x_resv.worker_ticks t set consumed_at = pg_catalog.clock_timestamp()
  where t.nonce_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_nonce, 'UTF8')), 'hex')
    and t.consumed_at is null and t.ticked_at > pg_catalog.now() - interval '120 seconds';
  return found;
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

revoke all on table postona_x_resv.worker_target, postona_x_resv.worker_ticks from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.worker_url(text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.tick_delivery_worker() from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.worker_tick_health(interval) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
revoke all on function postona_x_resv.consume_worker_tick(text) from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
grant execute on function postona_x_resv.consume_worker_tick(text) to postona_resv_worker;

-- Postconditions: of the API roles only postona_resv_worker reaches anything (consume_worker_tick, nothing else); no table privilege;
-- consume_worker_tick is the only SECURITY DEFINER.
do $$
declare v_bad text;
begin
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ',' order by r.rolname, p.proname) into v_bad
  from pg_catalog.pg_proc p cross join pg_catalog.pg_roles r
  where p.oid in ('postona_x_resv.worker_url(text)'::regprocedure, 'postona_x_resv.tick_delivery_worker()'::regprocedure,
                  'postona_x_resv.worker_tick_health(interval)'::regprocedure, 'postona_x_resv.consume_worker_tick(text)'::regprocedure)
    and r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker')
    and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_resv_worker:consume_worker_tick' then
    raise exception 'POSTONA_X_WORKER_TICK_POSTCONDITION: %', v_bad;
  end if;
  if (select pg_catalog.string_agg(p.proname, ',') from pg_catalog.pg_proc p where p.pronamespace = 'postona_x_resv'::regnamespace
      and p.proname in ('worker_url', 'tick_delivery_worker', 'worker_tick_health', 'consume_worker_tick') and p.prosecdef) is distinct from 'consume_worker_tick' then
    raise exception 'POSTONA_X_WORKER_TICK_POSTCONDITION: security definer';
  end if;
  if exists (select 1 from pg_catalog.pg_roles r cross join (values ('postona_x_resv.worker_ticks'), ('postona_x_resv.worker_target')) as t(rel)
             where r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker')
               and pg_catalog.has_table_privilege(r.oid, t.rel, 'SELECT,INSERT,UPDATE,DELETE')) then
    raise exception 'POSTONA_X_WORKER_TICK_POSTCONDITION: table privilege';
  end if;
end $$;

commit;
