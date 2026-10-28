-- G3-39 FB: the G5 personal MVP world WITHOUT 008. 001-006 bind the FULL profile (g5oe:<epoch>:<lifecycle>, W1): R1-MVP's 'g5pv:<V>'
-- is not a token they accept, so every create and every single post is refused and nothing is written (fail-closed, but unusable).
\ir helpers.sql

select pg_temp.expect((pg_temp.r1(pg_temp.uid(1), pg_temp.ws(pg_temp.uid(1))) ->> 'owner_epoch')
  = 'g5pv:' || pg_temp.lv(pg_temp.uid(1)), 'FB0 R1-MVP allows A with g5pv:<V>');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(1), 'fb1', 30) = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'FB1 create refused without 008');
select pg_temp.expect(pg_temp.api(format('select state from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)', pg_temp.acct(pg_temp.uid(1)),
  'G3-39 fb2', pg_temp.body_sha('G3-39 fb2')), pg_temp.uid(1)) = 'ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE', 'FB2 single post refused without 008');
select pg_temp.expect((select count(*) from postona_x_resv.reservations) = 0, 'FB3 nothing written');
