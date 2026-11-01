-- G3-40 FB: the G5 personal MVP world WITHOUT 009. 007 binds the FULL profile (g5oe:<epoch>:<lifecycle>, W1): R1-MVP's 'g5pv:<V>' is not a
-- token it accepts, so every create is refused and nothing is written; a row that somehow carries a full pair is never claimed (no W1 here).
\ir helpers.sql

select pg_temp.expect((pg_temp.r1(pg_temp.uid(1), pg_temp.ws(pg_temp.uid(1))) ->> 'owner_epoch')
  = 'g5pv:' || pg_temp.lv(pg_temp.uid(1)), 'FB0 R1-MVP allows A (threads_publish) with g5pv:<V>');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'fb1', 30) = 'ERR:POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE', 'FB1 create refused without 009');
select pg_temp.expect((select count(*) from postona_threads_resv.reservations) = 0, 'FB2 nothing written');
-- TEST STAND-IN row written by the owner with a full-profile pair: the FULL adapter has no W1 to ask -> SERVICE_STATE_UNKNOWN, never claimed
insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at,
  bound_owner_epoch, bound_lifecycle_version)
values (pg_temp.uid(1), pg_temp.ws(pg_temp.uid(1)), pg_temp.tacct(pg_temp.uid(1)), gen_random_uuid(), 'G3-40 fb3', pg_temp.body_sha('G3-40 fb3'),
        now() - interval '1 minute', 1, pg_temp.lv(pg_temp.uid(1)));
select pg_temp.expect(pg_temp.claim() = '', 'FB3 full-pair row not claimed without W1');
select pg_temp.expect((select status || '/' || outcome_code from postona_threads_resv.reservations) = 'failed/SERVICE_STATE_UNKNOWN', 'FB3 row');
