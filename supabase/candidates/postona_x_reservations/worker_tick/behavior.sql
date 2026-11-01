-- TEST ONLY (G3-02 #11): 016 on fake catalogs (catalogs.sql), as the schema owner. H4-17's three counterexamples, each now refused, and
-- the tick's other answers. Fake values only; no network.
\set ON_ERROR_STOP on
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'CHECK_FAILED: %', p_what; end if; end $$;
create function pg_temp.expect_error(p_sql text, p_expected text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: % :: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' then raise; end if;
  if position(p_expected in sqlerrm) = 0 then raise exception 'WRONG_ERROR expected % got %', p_expected, sqlerrm; end if;
end $$;
create function pg_temp.last_ticket() returns text language sql as $$
  select headers ->> 'x-postona-worker-tick' from net.http_request_queue order by id desc limit 1 $$;
\set KEY 'g3-fake-worker-secret-0123456789abcdef-0123456789'
\set REF 'g3projectref00000001'

-- T1. not configured: no pin; a pin but no key; a short key. Nothing queued.
select pg_temp.check(postona_x_resv.tick_delivery_worker() = 'NOT_CONFIGURED', 'no pin, no key');
insert into postona_x_resv.worker_target (project_ref) values (:'REF');
select pg_temp.check(postona_x_resv.tick_delivery_worker() = 'NOT_CONFIGURED', 'no key');
insert into vault.secrets values ('postona_resv_worker_secret', 'short-key');
select pg_temp.check(postona_x_resv.tick_delivery_worker() = 'NOT_CONFIGURED', 'short key');
select pg_temp.check((select count(*) from net.http_request_queue) = 0, 'nothing queued');
update vault.secrets set secret = :'KEY' where name = 'postona_resv_worker_secret';
select 'T1_NOT_CONFIGURED_PASS' as result;

-- T2 (H4-17 P2 target). The pin is the only source of the target: one row, the ref's exact shape; a Vault URL for another project or
-- host is ignored.
select pg_temp.expect_error($q$insert into postona_x_resv.worker_target (project_ref) values ('g3projectref00000002')$q$, 'duplicate key');
select pg_temp.expect_error($q$update postona_x_resv.worker_target set project_ref = 'Bad.Ref'$q$, 'worker_target_project_ref_check');
select pg_temp.check(postona_x_resv.worker_url('g3projectref00000001') = 'https://g3projectref00000001.supabase.co/functions/v1/postona-x-reservation-worker', 'url from ref');
select pg_temp.check(postona_x_resv.worker_url(null) is null and postona_x_resv.worker_url('evil.example/x') is null and postona_x_resv.worker_url('abc') is null, 'no url without a ref');
insert into vault.secrets values ('postona_resv_worker_url', 'https://otherprojectref00001.supabase.co/functions/v1/postona-x-reservation-worker');
select pg_temp.check(postona_x_resv.tick_delivery_worker() = 'INVOKED', 'invoked');
select pg_temp.check((select url from net.http_request_queue order by id desc limit 1) = 'https://g3projectref00000001.supabase.co/functions/v1/postona-x-reservation-worker', 'the pinned target, not the Vault URL');
select 'T2_TARGET_PINNED_PASS' as result;

-- T3 (H4-17 P1). The queue never holds the key: another role that can read the queue (PUBLIC, as Supabase's default) finds only the
-- one-use ticket, whose MAC verifies with the key and names the pinned ref.
set role postona_resv_api;
select pg_temp.check(not exists (select 1 from net.http_request_queue q
                                 where position(:'KEY' in coalesce(q.headers::text, '') || q.url || coalesce(convert_from(q.body, 'UTF8'), '')) > 0), 'no key in the queue (api role)');
select pg_temp.check(pg_temp.last_ticket() ~ ('^v1\.' || :'REF' || '\.[0-9]{10}\.[0-9a-f]{64}\.[0-9a-f]{64}$'), 'a ticket for the pinned ref: ' || coalesce(pg_temp.last_ticket(), '-'));
select pg_temp.check((select headers ? 'x-postona-worker-secret' from net.http_request_queue order by id desc limit 1) is false, 'no secret header');
reset role;
select pg_temp.check(split_part(pg_temp.last_ticket(), '.', 5) = encode(extensions.hmac(
  'v1.' || split_part(pg_temp.last_ticket(), '.', 2) || '.' || split_part(pg_temp.last_ticket(), '.', 3) || '.' || split_part(pg_temp.last_ticket(), '.', 4), :'KEY', 'sha256'), 'hex'), 'the MAC verifies with the key');
select pg_temp.check(abs(extract(epoch from now()) - split_part(pg_temp.last_ticket(), '.', 3)::bigint) < 5, 'the ticket carries now');
select pg_temp.check((select nonce_sha256 from postona_x_resv.worker_ticks order by id desc limit 1)
  = encode(sha256(convert_to(split_part(pg_temp.last_ticket(), '.', 4), 'UTF8')), 'hex'), 'only the nonce hash is stored');
select pg_temp.check(not exists (select 1 from postona_x_resv.worker_ticks t where position(split_part(pg_temp.last_ticket(), '.', 4) in t::text) > 0), 'the nonce itself is not stored');
select 'T3_NO_KEY_IN_QUEUE_PASS' as result;

-- T4. One use: the worker role consumes the queued nonce once; again, an unknown, a malformed, and an old (> 120 s) nonce are refused.
select split_part(pg_temp.last_ticket(), '.', 4) as nonce1 \gset
set role postona_resv_worker;
select pg_temp.check(postona_x_resv.consume_worker_tick(:'nonce1') is true, 'first use');
select pg_temp.check(postona_x_resv.consume_worker_tick(:'nonce1') is false, 'replay');
select pg_temp.check(postona_x_resv.consume_worker_tick(repeat('ab', 32)) is false, 'never issued');
select pg_temp.check(postona_x_resv.consume_worker_tick('not-a-nonce') is false and postona_x_resv.consume_worker_tick(null) is false, 'malformed');
reset role;
insert into net._http_response (id, status_code, content) select request_id, 200, '{"ok":true,"report":{"claimed":0}}' from postona_x_resv.worker_ticks order by id desc limit 1;
select pg_temp.check(postona_x_resv.tick_delivery_worker() = 'INVOKED', 'answered: the next tick calls');
select split_part(pg_temp.last_ticket(), '.', 4) as nonce2 \gset
update postona_x_resv.worker_ticks set ticked_at = now() - interval '121 seconds' where id = (select max(id) from postona_x_resv.worker_ticks);  -- SYNTHETIC age
set role postona_resv_worker;
select pg_temp.check(postona_x_resv.consume_worker_tick(:'nonce2') is false, 'older than 120 s');
select pg_temp.expect_error($q$select postona_x_resv.tick_delivery_worker()$q$, 'permission denied');
select pg_temp.expect_error($q$select count(*) from postona_x_resv.worker_ticks$q$, 'permission denied');
reset role;
select 'T4_ONE_USE_PASS' as result;

-- T5. A previous call without an answer (< 70 s) is not stacked.
update postona_x_resv.worker_ticks set ticked_at = now() where id = (select max(id) from postona_x_resv.worker_ticks);
select pg_temp.check(postona_x_resv.tick_delivery_worker() = 'PREVIOUS_IN_FLIGHT', 'in flight');
select 'T5_IN_FLIGHT_PASS' as result;

-- T6. Privileges: the API roles reach none of 016 except the worker role's consume.
select pg_temp.check((select string_agg(r.rolname || ':' || p.proname, ',' order by r.rolname, p.proname) from pg_proc p cross join pg_roles r
  where p.pronamespace = 'postona_x_resv'::regnamespace and p.proname in ('worker_url', 'tick_delivery_worker', 'worker_tick_health', 'consume_worker_tick')
    and r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker') and has_function_privilege(r.oid, p.oid, 'EXECUTE'))
  = 'postona_resv_worker:consume_worker_tick', 'execute set');
set role postona_resv_api;
select pg_temp.expect_error($q$select postona_x_resv.consume_worker_tick(repeat('ab', 32))$q$, 'permission denied');
select pg_temp.expect_error($q$select * from postona_x_resv.worker_target$q$, 'permission denied');
reset role;
select 'T6_PRIVILEGES_PASS' as result;
