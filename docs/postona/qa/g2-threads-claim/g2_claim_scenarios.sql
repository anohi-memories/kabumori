-- G2 independent QA (2026-10-20, Issue #317 generation 8): claim / lease / uncertain cross-step scenarios on G3's
-- candidate 007 (PR #360 HEAD). Runs inside G3's own disposable local PostgreSQL harness (see run.sh: it is spliced in
-- just before G3's rollback stage, on the same database, after G3's L / R / E stages passed). Fake data only (G3's
-- test people + G4/G5 test doubles). Every check raises on failure; markers are written to the file given by :g2out.
-- Only the gaps G3's behavior.sql / e2e do not walk end to end are covered here (see README).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create function pg_temp.g2_expect(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'G2_EXPECT_FAILED: %', p_what; end if;
end $$;

create function pg_temp.g2_new(p_text text) returns uuid language sql as $$
  insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at,
    bound_owner_epoch, bound_lifecycle_version)
  select p.user_id, p.brand, p.threads_account, gen_random_uuid(), p_text, encode(sha256(convert_to(p_text, 'UTF8')), 'hex'), now() - interval '1 second',
    (select e.v from t_g5.owner_epoch e where e.brand_id = p.brand), (select l.v from t_g5.lifecycle l where l.user_id = p.user_id)
  from t_ids.people p where p.n = 98
  returning id $$;

/** claim_due as a given worker; returns 'id lease' for each row claimed, comma separated (empty = nothing). */
create function pg_temp.g2_claim(p_worker text) returns text language sql as $$
  select coalesce(string_agg(reservation_id || ' ' || lease_token, ','), '') from postona_threads_resv.claim_due(p_worker, 30, 50) $$;
create function pg_temp.g2_pre(p_rid uuid, p_lease uuid) returns text language sql as $$
  select verdict from postona_threads_resv.preflight(p_rid, p_lease) $$;
create function pg_temp.g2_st(p_rid uuid) returns text language sql as $$
  select status || '/' || coalesce(outcome_code, '-') || '/' || coalesce(provider_post_id, '-') from postona_threads_resv.reservations where id = p_rid $$;
create function pg_temp.g2_expire(p_rid uuid) returns void language sql as $$
  update postona_threads_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = p_rid $$;
/** record; a raised refusal is returned as 'ERR:<message>'. */
create function pg_temp.g2_rec(p_rid uuid, p_lease uuid, p_outcome text, p_post text) returns text language plpgsql as $$
begin
  return postona_threads_resv.record(p_rid, p_lease, p_outcome, p_post, null, 'simulated');
exception when others then return 'ERR:' || sqlerrm;
end $$;

-- Isolate: nothing else may be due while these scenarios claim.
update postona_threads_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where status in ('planned', 'claimed');

\o :g2out

-- C1: published, then the lease ran out before the record; another worker's claim sweeps the row to uncertain first.
--     The late 'published' record is refused (the post is NOT claimed as sent), the row stays uncertain with no post id,
--     and it is never claimed again (no second publish).
do $$
declare r uuid := pg_temp.g2_new('C1'); a text; lease uuid;
begin
  a := pg_temp.g2_claim('wa'); lease := split_part(a, ' ', 2)::uuid;
  perform pg_temp.g2_expect(split_part(a, ' ', 1)::uuid = r, 'C1 claimed by A');
  perform pg_temp.g2_expect(pg_temp.g2_pre(r, lease) = 'OK', 'C1 A preflight #1');
  perform pg_temp.g2_expect(pg_temp.g2_pre(r, lease) = 'OK', 'C1 A beforePublish re-check');
  -- (A's publish request goes out here and succeeds; A is slow to record)
  perform pg_temp.g2_expire(r);
  perform pg_temp.g2_expect(pg_temp.g2_claim('wb') = '', 'C1 B claims nothing');
  perform pg_temp.g2_expect(pg_temp.g2_st(r) = 'uncertain/LEASE_EXPIRED/-', 'C1 swept to uncertain: ' || pg_temp.g2_st(r));
  perform pg_temp.g2_expect(pg_temp.g2_rec(r, lease, 'published', '18000000000000901') like 'ERR:POSTONA_THREADS_RESV_LEASE_LOST%', 'C1 late published record refused');
  perform pg_temp.g2_expect(pg_temp.g2_st(r) = 'uncertain/LEASE_EXPIRED/-', 'C1 still uncertain, no post id');
  perform pg_temp.g2_expect(pg_temp.g2_claim('wc') = '' and pg_temp.g2_claim('wa') = '', 'C1 never claimed again (any worker, restart)');
end $$;
select 'G2_C1_SWEEP_BEFORE_LATE_RECORD_STAYS_UNCERTAIN_PASS';

-- C2: the lease ran out during the container wait (before the re-check): the re-check hands the row back (RELEASED,
--     nothing was sent). B re-claims it with a NEW lease; A's late record and late re-check with the old lease are
--     refused; B publishes once. Total: 2 claims, 1 published record.
do $$
declare r uuid := pg_temp.g2_new('C2'); a text; la uuid; b text; lb uuid;
begin
  a := pg_temp.g2_claim('wa'); la := split_part(a, ' ', 2)::uuid;
  perform pg_temp.g2_expect(pg_temp.g2_pre(r, la) = 'OK', 'C2 A preflight #1');
  perform pg_temp.g2_expire(r);                                   -- container wait outlives the lease
  perform pg_temp.g2_expect(pg_temp.g2_pre(r, la) = 'RELEASED', 'C2 A re-check -> RELEASED (no publish)');
  perform pg_temp.g2_expect(pg_temp.g2_st(r) = 'planned/-/-', 'C2 handed back: ' || pg_temp.g2_st(r));
  b := pg_temp.g2_claim('wb'); lb := split_part(b, ' ', 2)::uuid;
  perform pg_temp.g2_expect(split_part(b, ' ', 1)::uuid = r and lb <> la, 'C2 B re-claims with a new lease');
  perform pg_temp.g2_expect(pg_temp.g2_pre(r, la) = 'LEASE_LOST', 'C2 A old lease re-check -> LEASE_LOST');
  perform pg_temp.g2_expect(pg_temp.g2_rec(r, la, 'failed_before_send', null) like 'ERR:POSTONA_THREADS_RESV_LEASE_LOST%', 'C2 A late record refused');
  perform pg_temp.g2_expect(pg_temp.g2_pre(r, lb) = 'OK', 'C2 B preflight');
  perform pg_temp.g2_expect(pg_temp.g2_pre(r, lb) = 'OK', 'C2 B re-check');
  perform pg_temp.g2_expect(pg_temp.g2_rec(r, lb, 'published', '18000000000000902') = 'published', 'C2 B published');
  perform pg_temp.g2_expect(pg_temp.g2_rec(r, lb, 'published', '18000000000000902') = 'published', 'C2 identical replay is idempotent');
  perform pg_temp.g2_expect(pg_temp.g2_rec(r, lb, 'published', '18000000000000903') like 'ERR:%', 'C2 a different post id is refused');
  perform pg_temp.g2_expect(pg_temp.g2_claim('wc') = '', 'C2 never claimed again');
end $$;
select 'G2_C2_EXPIRY_IN_CONTAINER_WAIT_RELEASED_RECLAIMED_ONCE_PASS';

-- C3: a worker restart while the lease is still live: claim_due does not hand the claimed row to anyone (no second send).
do $$
declare r uuid := pg_temp.g2_new('C3'); a text; la uuid;
begin
  a := pg_temp.g2_claim('wa'); la := split_part(a, ' ', 2)::uuid;
  perform pg_temp.g2_expect(pg_temp.g2_claim('wa') = '' and pg_temp.g2_claim('wb') = '', 'C3 live claim is not re-selected');
  perform pg_temp.g2_expect(pg_temp.g2_rec(r, la, 'uncertain', null) = 'uncertain', 'C3 A records uncertain');
  perform pg_temp.g2_expect(pg_temp.g2_claim('wa') = '', 'C3 uncertain never claimed again');
end $$;
select 'G2_C3_RESTART_LIVE_LEASE_NOT_RESELECTED_PASS';

-- C4 (source scan): no function of 007 moves an uncertain / failed / published row back to planned or claimed.
do $$
declare v text;
begin
  select string_agg(p.proname, ',' order by p.proname) into v
  from pg_proc p where p.pronamespace = 'postona_threads_resv'::regnamespace and p.prosrc ~ $re$status\s*=\s*'planned'$re$;
  -- the only writers of 'planned' are the two that hand back THEIR OWN still-claimed row
  perform pg_temp.g2_expect(v = 'cancel_reservation,claim_due,preflight,release_unsent', 'C4 planned writers/readers: ' || coalesce(v, '-'));
  perform pg_temp.g2_expect((select prosrc from pg_proc where oid = 'postona_threads_resv.release_unsent(uuid,uuid)'::regprocedure) ~ $re$r\.status\s*=\s*'claimed'\s+and\s+r\.lease_token\s*=\s*p_lease_token$re$, 'C4 release_unsent only for its own claimed lease');
  perform pg_temp.g2_expect((select prosrc from pg_proc where oid = 'postona_threads_resv.preflight(uuid,uuid)'::regprocedure) ~ $re$v_row\.status\s*<>\s*'claimed'\s+or\s+v_row\.lease_token\s+is\s+distinct\s+from\s+p_lease_token$re$, 'C4 preflight hands back only its own claimed lease');
  perform pg_temp.g2_expect(not exists (select 1 from pg_proc p where p.pronamespace = 'postona_threads_resv'::regnamespace
    and p.prosrc ~ $re$status\s+in\s*\([^)]*'uncertain'$re$ and p.proname in ('claim_due')), 'C4 claim_due never selects uncertain');
end $$;
select 'G2_C4_NO_PATH_BACK_FROM_UNCERTAIN_PASS';

-- Negative controls (inside a savepoint each; the real functions are restored by rolling back):
--   NC1 claim_due also selects uncertain rows  -> C1-style re-claim must be detected
--   NC2 preflight treats an expired lease as OK -> C2's RELEASED expectation must be detected
--   NC3 record accepts a late 'published' on a non-claimed row -> C1's refusal must be detected
do $$
declare caught int := 0; r uuid; a text; la uuid; src text;
begin
  -- NC1
  begin
    -- keep the earlier scenarios' finished rows out of this control (the mutation would pick them up too)
    update postona_threads_resv.reservations set scheduled_at = now() + interval '1 day' where status <> 'planned';
    select pg_get_functiondef('postona_threads_resv.claim_due(text,integer,integer)'::regprocedure) into src;
    execute replace(replace(src, 'CREATE OR REPLACE', 'CREATE OR REPLACE'), $q$where r.status = 'planned' and r.scheduled_at$q$, $q$where r.status in ('planned', 'uncertain') and r.scheduled_at$q$);
    r := pg_temp.g2_new('NC1'); a := pg_temp.g2_claim('wa'); la := split_part(a, ' ', 2)::uuid;
    perform pg_temp.g2_rec(r, la, 'uncertain', null);
    perform pg_temp.g2_expect(pg_temp.g2_claim('wb') = '', 'NC1 uncertain never claimed again');
    raise exception 'G2_NC_SURVIVED NC1';
  exception when others then
    if sqlerrm like 'G2_EXPECT_FAILED%' then caught := caught + 1; elsif sqlerrm like 'G2_NC_SURVIVED%' then raise notice 'NC1 survived'; else raise; end if;
  end;
  -- NC2
  begin
    select pg_get_functiondef('postona_threads_resv.preflight(uuid,uuid)'::regprocedure) into src;
    execute replace(src, $q$if v_row.lease_expires_at <= pg_catalog.clock_timestamp() or postona_threads_resv.refresh_in_progress$q$, $q$if postona_threads_resv.refresh_in_progress$q$);
    r := pg_temp.g2_new('NC2'); a := pg_temp.g2_claim('wa'); la := split_part(a, ' ', 2)::uuid;
    perform pg_temp.g2_expire(r);
    perform pg_temp.g2_expect(pg_temp.g2_pre(r, la) = 'RELEASED', 'NC2 expired lease re-check -> RELEASED');
    raise exception 'G2_NC_SURVIVED NC2';
  exception when others then
    if sqlerrm like 'G2_EXPECT_FAILED%' then caught := caught + 1; elsif sqlerrm like 'G2_NC_SURVIVED%' then raise notice 'NC2 survived'; else raise; end if;
  end;
  -- NC3
  begin
    select pg_get_functiondef('postona_threads_resv.record(uuid,uuid,text,text,text,text)'::regprocedure) into src;
    execute replace(src, $q$if v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token then$q$,
      $q$if v_row.status not in ('claimed', 'uncertain') then$q$);
    r := pg_temp.g2_new('NC3'); a := pg_temp.g2_claim('wa'); la := split_part(a, ' ', 2)::uuid;
    perform pg_temp.g2_expire(r); perform pg_temp.g2_claim('wb');
    perform pg_temp.g2_expect(pg_temp.g2_rec(r, la, 'published', '18000000000000904') like 'ERR:POSTONA_THREADS_RESV_LEASE_LOST%', 'NC3 late published refused');
    raise exception 'G2_NC_SURVIVED NC3';
  exception when others then
    if sqlerrm like 'G2_EXPECT_FAILED%' then caught := caught + 1; elsif sqlerrm like 'G2_NC_SURVIVED%' then raise notice 'NC3 survived'; else raise; end if;
  end;
  perform pg_temp.g2_expect(caught = 3, 'negative controls detected ' || caught || '/3');
end $$;
select 'G2_NEGATIVE_CONTROLS_3_OF_3_DETECTED_PASS';
select 'G2_THREADS_CLAIM_SCENARIOS_ALL_PASS';
\o
