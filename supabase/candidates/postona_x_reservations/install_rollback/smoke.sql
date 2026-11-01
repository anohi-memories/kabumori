-- G3-41 smoke AFTER the full reverse rollback and the re-apply of X 001-006 + 008 and Threads 007 + 009 (personal MVP world). Fake data; the
-- "send" is a recorded outcome (no SNS call). The people of personal_mvp/people.sql are still there; their rows are not (001's rollback).
\ir ../personal_mvp/helpers.sql

create schema t41;
create table t41.ids (name text primary key, id uuid);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t41.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t41.ids where name = p_name $$;

select pg_temp.expect((select count(*) from postona_x_resv.reservations) = 0 and (select count(*) from postona_x_resv.audit) = 0, 'S0 no row came back');
select pg_temp.expect(private.postona_personal_worker_verdict(pg_temp.uid(1), pg_temp.ws(pg_temp.uid(1)), 'x_autopost', pg_temp.lv(pg_temp.uid(1))) = 'active', 'S0 A active');

-- S1: create -> claim -> pre-send OK -> published, once
select pg_temp.keep('s1', pg_temp.reserve(pg_temp.uid(1), 's1', 30));
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('s1')) = 'null/' || pg_temp.lv(pg_temp.uid(1)), 'S1 bound null/V');
select pg_temp.make_due(pg_temp.id('s1'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('s1') || '=%', 'S1 claimed');
select pg_temp.expect(pg_temp.check_send(pg_temp.id('s1')) = 'OK', 'S1 pre-send OK');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''published'', ''1041000000000000001'', null)', pg_temp.id('s1'), pg_temp.lease_of(pg_temp.id('s1')))) = 'published', 'S1 recorded');
select pg_temp.expect(pg_temp.claim() = '', 'S1 no second claim');

-- S2: the lease runs out -> uncertain, never claimed again, the pre-send check answers LEASE_LOST
select pg_temp.keep('s2', pg_temp.reserve(pg_temp.uid(1), 's2', 38));
select pg_temp.make_due(pg_temp.id('s2'));
-- keep the 60-minute gap to s1 (both would sit at now - 1 minute), or the next create meets SLOT_CONFLICT
update postona_x_resv.reservations set scheduled_at = now() - interval '2 hours', consent_scheduled_at = now() - interval '2 hours' where id = pg_temp.id('s2');
select pg_temp.expect(pg_temp.claim() like pg_temp.id('s2') || '=%', 'S2 claimed');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('s2');
select pg_temp.expect(pg_temp.claim() = '', 'S2 not claimed again');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('s2')) = 'uncertain/LEASE_EXPIRED', 'S2 row ' || pg_temp.row_of(pg_temp.id('s2')));
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.pre_publish_check(%L, %L)', pg_temp.id('s2'), pg_temp.lease_of(pg_temp.id('s2')))) = 'LEASE_LOST', 'S2 pre-send LEASE_LOST');

-- S3: the generation moves after the claim -> the pre-send check refuses, nothing is published
select pg_temp.keep('s3', pg_temp.reserve(pg_temp.uid(1), 's3', 45));
select pg_temp.make_due(pg_temp.id('s3'));
select pg_temp.expect(pg_temp.claim() like pg_temp.id('s3') || '=%', 'S3 claimed');
select pg_temp.restart(pg_temp.uid(1));
select pg_temp.expect(pg_temp.check_send(pg_temp.id('s3')) <> 'OK', 'S3 pre-send refused');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('s3')) like 'failed/%', 'S3 row ' || pg_temp.row_of(pg_temp.id('s3')));
select pg_temp.expect((select count(*) from postona_x_resv.reservations where status = 'published') = 1, 'S published exactly once');

drop schema t41 cascade;
select 'G3_INSTALL_ROLLBACK_SMOKE_PASS';
