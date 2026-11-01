-- SQL-level behaviour of 005 (single post) that the HTTP end to end does not reach directly: ACL, consent / text /
-- idempotency refusals, the delivery worker never claiming a single post, re-arming a never-sent row, the lease fence.
-- Run by single_post_run.sh as the schema owner after setup_people.sql. Fake data only.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
create function pg_temp.api(p_sql text, p_user uuid, p_session uuid) returns text language sql as $$ select pg_temp.as_person(p_sql, p_user, p_session, 'postona_resv_api') $$;
create function pg_temp.begin_sp(p_account text, p_req uuid, p_text text, p_sha text default null) returns text language sql as $$
  select format('select state || coalesce(''/'' || lease_token::text, '''') || ''/'' || reservation_id from postona_x_resv.post_now_begin(%L, %L::uuid, %L, %L)',
                p_account, p_req, p_text, coalesce(p_sha, encode(sha256(convert_to(p_text, 'UTF8')), 'hex'))) $$;
create function pg_temp.person(p_n integer) returns uuid language sql as $$ select user_id from t_ids.people where n = p_n $$;
create function pg_temp.account(p_n integer) returns text language sql as $$ select account from t_ids.people where n = p_n $$;

select pg_temp.session(pg_temp.person(70)) as s70 \gset
select pg_temp.session(pg_temp.person(71)) as s71 \gset

-- B1: ACL. Only postona_resv_api reaches the four functions; the fence and the row helper are internal.
select pg_temp.expect(pg_temp.as_person(format('select count(*)::text from postona_x_resv.post_now_get(%L::uuid)', gen_random_uuid()), pg_temp.person(70), :'s70', r) like 'ERR:permission denied%', 'B1 closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_worker']) r;
select pg_temp.expect(pg_temp.api(q, pg_temp.person(70), :'s70') like 'ERR:permission denied%', 'B1 internal: ' || q) from unnest(array[
  format('select postona_x_resv.single_post_fence(%L::uuid, %L)', pg_temp.person(70), pg_temp.account(70)),
  format('select (postona_x_resv.own_single_post(%L::uuid, gen_random_uuid())).id::text', pg_temp.person(70))]) q;
select 'B1_ACL_PASS' as result;

-- B2: consent is the SHA-256 of exactly this text; text rules; the same request id with another text is a conflict.
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(70), gen_random_uuid(), 'hello', repeat('a', 64)), pg_temp.person(70), :'s70') = 'ERR:POSTONA_RESV_CONSENT_REQUIRED', 'B2 consent');
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(70), gen_random_uuid(), t), pg_temp.person(70), :'s70') = 'ERR:POSTONA_RESV_TEXT_INVALID', 'B2 text ' || left(t, 10))
  from unnest(array[repeat('あ', 141), 'bell' || chr(7)]) t;
select gen_random_uuid() as req \gset
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(70), :'req', 'first text'), pg_temp.person(70), :'s70') as b2 \gset
select pg_temp.expect(:'b2' like 'claimed/%', 'B2 begin ' || :'b2');
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(70), :'req', 'other text'), pg_temp.person(70), :'s70') = 'ERR:POSTONA_RESV_IDEMPOTENCY_CONFLICT', 'B2 conflict');
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(70), :'req', 'first text'), pg_temp.person(70), :'s70') like 'in_progress/%', 'B2 repeat while in flight');
select 'B2_CONSENT_TEXT_IDEMPOTENCY_PASS' as result;

-- B3: the delivery worker never claims a single post (claimed or never-sent); its sweep fences an expired lease to
-- uncertain, and a repeat then answers uncertain (never a second send).
select split_part(:'b2', '/', 3) as b2id \gset
begin;
set local role postona_resv_worker;
select count(*) as b3claimed from postona_x_resv.claim_due('w1', 120, 50) where reservation_id = :'b2id' \gset
commit;
select pg_temp.expect(:'b3claimed'::int = 0, 'B3 worker never claims a claimed single post');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = :'b2id';
begin;
set local role postona_resv_worker;
select count(*) as b3sweep from postona_x_resv.claim_due('w1', 120, 50) \gset
commit;
select pg_temp.expect((select status from postona_x_resv.reservations where id = :'b2id') = 'uncertain', 'B3 sweep fences to uncertain');
select pg_temp.expect(pg_temp.api(pg_temp.begin_sp(pg_temp.account(70), :'req', 'first text'), pg_temp.person(70), :'s70') like 'uncertain/%', 'B3 repeat answers uncertain');
select 'B3_WORKER_NEVER_CLAIMS_UNCERTAIN_FENCE_PASS' as result;

-- B4: a never-sent row (busy fence -> planned, past its own expires_at) is never claimed by the worker and is re-armed
-- by a repeat of the same request; the re-armed lease is new.
select gen_random_uuid() as req4 \gset
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(71), :'req4', 'retry me'), pg_temp.person(71), :'s71') as b4 \gset
select split_part(:'b4', '/', 2) as b4lease, split_part(:'b4', '/', 3) as b4id \gset
select pg_temp.expect(postona_x_resv.release_claim(:'b4id', :'b4lease', 'SERVICE_BUSY'), 'B4 setup release');
begin;
set local role postona_resv_worker;
select count(*) as b4claimed from postona_x_resv.claim_due('w1', 120, 50) where reservation_id = :'b4id' \gset
commit;
select pg_temp.expect(:'b4claimed'::int = 0, 'B4 worker never claims a never-sent single post');
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(71), :'req4', 'retry me'), pg_temp.person(71), :'s71') as b4b \gset
select pg_temp.expect(:'b4b' like 'claimed/%' and split_part(:'b4b', '/', 2) <> :'b4lease' and split_part(:'b4b', '/', 3) = :'b4id', 'B4 re-armed ' || :'b4b');
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_check(%L, %L)', :'b4id', :'b4lease'), pg_temp.person(71), :'s71') = 'LEASE_LOST', 'B4 the old lease is dead');
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_check(%L, %L)', :'b4id', split_part(:'b4b', '/', 2)), pg_temp.person(70), :'s70') = 'LEASE_LOST', 'B4 another person cannot use it');
select pg_temp.expect(pg_temp.api(format('select state from postona_x_resv.post_now_get(%L)', :'b4id'), pg_temp.person(70), :'s70') = 'ERR:POSTONA_RESV_NOT_FOUND', 'B4 another person cannot read it');
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_finish(%L, %L, ''published'', ''1'', null)', :'b4id', split_part(:'b4b', '/', 2)), pg_temp.person(70), :'s70') = 'ERR:POSTONA_RESV_LEASE_LOST', 'B4 another person cannot record a result');
select pg_temp.expect((select status from postona_x_resv.reservations where id = :'b4id') = 'claimed', 'B4 still claimed');
select 'B4_REARM_NEVER_SENT_PASS' as result;

select 'POSTONA_X_SINGLE_POST_BEHAVIOR_PASS' as result;
