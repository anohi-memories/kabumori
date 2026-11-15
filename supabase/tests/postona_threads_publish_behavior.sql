-- Behavior proof for supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql.
-- Run by postona_threads_publish_run.sh as the table owner on a disposable database that has the
-- candidate applied over the fixture. Each DO block is one transaction, like one Data API request.
-- Fake data only.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create temp table ctx (k text primary key, v text);
create function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.get(p_k text) returns text language sql as $$ select v from ctx where k = p_k $$;
create function pg_temp.update_expiry(p_account text, p_expires timestamptz) returns int language sql as $$
  update postona_threads_proof.credential_expiry set expires_at = p_expires where social_account_id = p_account returning 1 $$;

-- Users: A owns workspace A (Threads + X account), B owns workspace B, V is a viewer of A, M is an admin of A.
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  v uuid := '00000000-0000-4000-8000-0000000000c1';
  m uuid := '00000000-0000-4000-8000-0000000000d1';
  brand_a text; brand_b text;
begin
  brand_a := public.fixture_brand(a, 'xa');
  brand_b := public.fixture_brand(b, 'xb');
  perform public.fixture_member(brand_a, v, 'viewer');
  perform public.fixture_member(brand_a, m, 'admin');
  perform pg_temp.put('brand_a', brand_a);
  perform pg_temp.put('brand_b', brand_b);
  perform pg_temp.put('acct_a', postona_threads_proof.threads_account(brand_a, 'a'));
  perform pg_temp.put('acct_b', postona_threads_proof.threads_account(brand_b, 'b', 'authorization_pending'));
  insert into postona_threads_proof.lifecycle values (a, 'active'), (b, 'active'), (v, 'active'), (m, 'active');
end $$;

-- ---- ACL: no direct table access for any app role; each function only for its role --------------------
do $$
begin
  perform postona_threads_proof.check(postona_threads_proof.try_as('authenticated', 'select 1 from public.threads_manual_publish_attempts') = '42501', 'authenticated cannot read attempts');
  perform postona_threads_proof.check(postona_threads_proof.try_as('service_role', 'select 1 from public.threads_manual_publish_attempts') = '42501', 'service_role cannot read attempts');
  perform postona_threads_proof.check(postona_threads_proof.try_as('authenticated', 'insert into public.social_account_manual_publish_permissions values (''sa_th_a'', ''x'', gen_random_uuid())') = '42501', 'authenticated cannot grant directly');
  perform postona_threads_proof.check(postona_threads_proof.try_as('service_role', 'delete from public.social_account_manual_publish_permissions') = '42501', 'service_role cannot touch permissions');
  perform postona_threads_proof.check(postona_threads_proof.try_as('authenticated', 'select public.redeem_threads_manual_publish_step(gen_random_uuid(), ''publish'', repeat(''a'', 64))') = '42501', 'authenticated cannot redeem');
  perform postona_threads_proof.check(postona_threads_proof.try_as('authenticated', 'select public.record_threads_manual_publish_step(gen_random_uuid(), ''publish'', repeat(''a'', 64), ''failed'', null, null, null, ''THREADS_UNAVAILABLE'')') = '42501', 'authenticated cannot record');
  perform postona_threads_proof.check(postona_threads_proof.try_as('anon', 'select public.begin_threads_manual_publish(''sa_th_a'', gen_random_uuid(), ''x'')') = '42501', 'anon cannot begin');
  perform postona_threads_proof.check(postona_threads_proof.try_as('authenticated', 'select public.threads_manual_publish_authorize(gen_random_uuid(), ''sa_th_a'', true)') = '42501', 'authenticated cannot call the internal check');
  perform postona_threads_proof.check(postona_threads_proof.try_as('service_role', 'select public.threads_manual_publish_fence(gen_random_uuid())') = '42501', 'service_role cannot call the fence wrapper');
  perform postona_threads_proof.check(postona_threads_proof.try_as('authenticated', 'select private.account_lifecycle_assert_active_service_write(gen_random_uuid(), ''x_autopost'')') = '42501', 'the G5 fence is not callable by app roles');
end $$;

-- ---- Permission ----------------------------------------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  v uuid := '00000000-0000-4000-8000-0000000000c1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
begin
  r := postona_threads_proof.as_user(null, 'permission', acct, 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'AUTH_REQUIRED', 'anonymous permission');
  r := postona_threads_proof.as_user(b, 'permission', acct, 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'ACCOUNT_NOT_FOUND', 'another user: not found');
  r := postona_threads_proof.as_user(v, 'permission', acct, 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'PUBLISH_FORBIDDEN', 'viewer: forbidden');
  r := postona_threads_proof.as_user(a, 'permission', 'sa_xa', 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'PLATFORM_NOT_SUPPORTED', 'X account: not Threads');
  r := postona_threads_proof.as_user(b, 'permission', pg_temp.get('acct_b'), 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'CONNECTION_NOT_VERIFIED', 'pending Threads account');
  r := postona_threads_proof.as_user(a, 'permission', 'sa_missing', 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'ACCOUNT_NOT_FOUND', 'missing account');
  r := postona_threads_proof.as_user(a, 'permission', acct, 'true', 'true');
  perform postona_threads_proof.check(r = '{"status":"stale","permitted":false}', 'stale expected value');
  perform postona_threads_proof.check(not exists (select 1 from public.social_account_manual_publish_permissions), 'nothing granted so far');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
begin
  update postona_threads_proof.lifecycle set state = 'ended' where user_id = a;
  r := postona_threads_proof.as_user(a, 'permission', acct, 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'SERVICE_NOT_ACTIVE', 'grant needs an active service');
  update postona_threads_proof.lifecycle set state = 'deleting' where user_id = a;
  r := postona_threads_proof.as_user(a, 'permission', acct, 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'ACCOUNT_LIFECYCLE_BLOCKED', 'grant refused while deleting');
  update postona_threads_proof.lifecycle set state = 'fence_broken' where user_id = a;
  r := postona_threads_proof.as_user(a, 'permission', acct, 'true', 'false');
  perform postona_threads_proof.check(r->>'code' = 'ACCOUNT_LIFECYCLE_BLOCKED', 'an unexpected fence failure is fail-closed');
  update postona_threads_proof.lifecycle set state = 'active' where user_id = a;
  r := postona_threads_proof.as_user(a, 'permission', acct, 'true', 'false');
  perform postona_threads_proof.check(r = '{"status":"updated","permitted":true}', 'owner grants');
  r := postona_threads_proof.as_user(a, 'permission', acct, 'true', 'true');
  perform postona_threads_proof.check(r = '{"status":"unchanged","permitted":true}', 'grant again: unchanged');
  perform postona_threads_proof.check((select count(*) from postona_threads_proof.fence_calls where user_id = a and service_key = 'x_autopost') >= 5, 'every grant ran the G5 fence for x_autopost');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
  calls bigint := (select count(*) from postona_threads_proof.fence_calls);
begin
  -- Withdrawing is possible even with the service ended, and runs no fence.
  update postona_threads_proof.lifecycle set state = 'ended' where user_id = a;
  r := postona_threads_proof.as_user(a, 'permission', acct, 'false', 'true');
  perform postona_threads_proof.check(r = '{"status":"updated","permitted":false}', 'withdraw with the service ended');
  perform postona_threads_proof.check((select count(*) from postona_threads_proof.fence_calls) = calls, 'withdraw ran no fence');
  update postona_threads_proof.lifecycle set state = 'active' where user_id = a;
end $$;

-- ---- Begin -----------------------------------------------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  acct text := pg_temp.get('acct_a');
  k1 text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  r jsonb;
begin
  r := postona_threads_proof.as_user(a, 'begin', acct, k1, 'テスト投稿');
  perform postona_threads_proof.check(r->>'code' = 'MANUAL_PUBLISH_NOT_PERMITTED', 'begin needs the permission');
  r := postona_threads_proof.as_user(a, 'permission', acct, 'true', 'false');
  for r in select postona_threads_proof.as_user(a, 'begin', acct, k1, t) from unnest(array['', ' ', E'\n', repeat('あ', 501), E'a\rb', E'a\u0001b']) t loop
    perform postona_threads_proof.check(r->>'code' = 'TEXT_INVALID', 'invalid text: ' || r::text);
  end loop;
  r := postona_threads_proof.as_user(null, 'begin', acct, k1, 'テスト投稿');
  perform postona_threads_proof.check(r->>'code' = 'AUTH_REQUIRED', 'anonymous begin');
  r := postona_threads_proof.as_user(b, 'begin', acct, k1, 'テスト投稿');
  perform postona_threads_proof.check(r->>'code' = 'ACCOUNT_NOT_FOUND', 'another user cannot begin on my account');
  r := postona_threads_proof.as_user(a, 'begin', 'sa_xa', k1, 'テスト投稿');
  perform postona_threads_proof.check(r->>'code' = 'PLATFORM_NOT_SUPPORTED', 'X account routed to Threads');
  perform postona_threads_proof.check(not exists (select 1 from public.threads_manual_publish_attempts), 'nothing reserved by refusals');
  r := postona_threads_proof.as_user(a, 'begin', acct, k1, E'テスト投稿\n2行目 "引用" \\');
  perform postona_threads_proof.check(r->>'status' = 'reserved' and r->'attempt'->>'status' = 'reserved', 'reserved: ' || r::text);
  perform postona_threads_proof.check(not (r->'attempt' ? 'post_text') and r::text not like '%2行目%', 'the text is not echoed');
  perform pg_temp.put('attempt1', r->'attempt'->>'attempt_id');
  perform postona_threads_proof.check((select post_text from public.threads_manual_publish_attempts) = E'テスト投稿\n2行目 "引用" \\', 'stored exactly');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  m uuid := '00000000-0000-4000-8000-0000000000d1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
begin
  r := postona_threads_proof.as_user(a, 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', E'テスト投稿\n2行目 "引用" \\');
  perform postona_threads_proof.check(r->>'status' = 'replayed' and r->'attempt'->>'attempt_id' = pg_temp.get('attempt1'), 'replay: same attempt');
  r := postona_threads_proof.as_user(a, 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ちがう本文');
  perform postona_threads_proof.check(r->>'code' = 'IDEMPOTENCY_CONFLICT', 'same key, other text');
  r := postona_threads_proof.as_user(m, 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', E'テスト投稿\n2行目 "引用" \\');
  perform postona_threads_proof.check(r->>'code' = 'IDEMPOTENCY_CONFLICT', 'same key, another caller');
  r := postona_threads_proof.as_user(a, 'begin', acct, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'もう1件');
  perform postona_threads_proof.check(r->>'code' = 'PUBLISH_IN_PROGRESS', 'one open attempt per account');
  perform postona_threads_proof.check((select count(*) from public.threads_manual_publish_attempts) = 1, 'still one attempt');
end $$;

-- ---- Claim / redeem / record: the golden path ---------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  att text := pg_temp.get('attempt1');
  r jsonb;
  g text;
begin
  r := postona_threads_proof.as_user(b, 'claim', att, 'create_container');
  perform postona_threads_proof.check(r->>'code' = 'ATTEMPT_NOT_FOUND', 'another user cannot claim');
  r := postona_threads_proof.as_user(a, 'claim', att, 'bogus_step');
  perform postona_threads_proof.check(r->>'code' = 'REQUEST_INVALID', 'unknown step');
  r := postona_threads_proof.as_user(a, 'claim', att, 'publish');
  perform postona_threads_proof.check(r->>'code' = 'STALE_STEP', 'publish before a container');
  r := postona_threads_proof.as_user(a, 'claim', att, 'create_container');
  g := r->>'grant';
  perform postona_threads_proof.check(r->>'status' = 'claimed' and g ~ '^[0-9a-f]{64}$' and r->'attempt'->>'status' = 'creating_container', 'claimed: ' || r::text);
  perform postona_threads_proof.check((select grant_hash from public.threads_manual_publish_attempts) = encode(sha256(convert_to(g, 'UTF8')), 'hex'), 'only the hash is stored');
  perform postona_threads_proof.check(not exists (select 1 from public.threads_manual_publish_attempts where grant_hash = g), 'the raw grant is not stored');
  perform pg_temp.put('g1', g);
  r := postona_threads_proof.as_user(a, 'claim', att, 'create_container');
  perform postona_threads_proof.check(r->>'code' = 'STALE_STEP', 'a second claim of the same write is stale');
end $$;

do $$
declare
  att text := pg_temp.get('attempt1');
  g text := pg_temp.get('g1');
  r jsonb;
begin
  r := postona_threads_proof.as_server('record', att, 'create_container', g, 'container_created', '555', null, null, null);
  perform postona_threads_proof.check(r->>'code' = 'GRANT_INVALID', 'record before redeem');
  r := postona_threads_proof.as_server('redeem', att, 'create_container', repeat('0', 64));
  perform postona_threads_proof.check(r->>'code' = 'GRANT_INVALID', 'wrong grant');
  r := postona_threads_proof.as_server('redeem', att, 'publish', g);
  perform postona_threads_proof.check(r->>'code' = 'GRANT_INVALID', 'grant for another step');
  r := postona_threads_proof.as_server('redeem', att, 'create_container', 'not-hex');
  perform postona_threads_proof.check(r->>'code' = 'GRANT_INVALID', 'malformed grant');
  r := postona_threads_proof.as_server('redeem', att, 'create_container', g);
  perform postona_threads_proof.check(r->>'status' = 'redeemed' and r->>'access_token' = 'fake_threads_a_TOKEN_0123456789'
                                      and r->>'text' = E'テスト投稿\n2行目 "引用" \\' and r->>'threads_user_id' ~ '^1784', 'redeemed: token and stored text');
  r := postona_threads_proof.as_server('redeem', att, 'create_container', g);
  perform postona_threads_proof.check(r->>'code' = 'GRANT_INVALID', 'a grant buys the credential once');
  r := postona_threads_proof.as_server('record', att, 'create_container', g, 'published', null, '777', 'https://www.threads.net/@a/post/1', null);
  perform postona_threads_proof.check(r->>'code' = 'STALE_STEP', 'a transition the table does not allow');
  r := postona_threads_proof.as_server('record', att, 'create_container', g, 'container_created', null, null, null, null);
  perform postona_threads_proof.check(r->>'code' = 'REQUEST_INVALID', 'container_created needs its id');
  r := postona_threads_proof.as_server('record', att, 'create_container', g, 'container_created', 'abc', null, null, null);
  perform postona_threads_proof.check(r->>'code' = 'REQUEST_INVALID', 'a non-numeric container id is refused');
  r := postona_threads_proof.as_server('record', att, 'create_container', g, 'container_created', '17890000000000001', null, null, null);
  perform postona_threads_proof.check(r->>'status' = 'recorded' and r->'attempt'->>'status' = 'container_created', 'container recorded');
  r := postona_threads_proof.as_server('record', att, 'create_container', g, 'failed', null, null, null, 'THREADS_UNAVAILABLE');
  perform postona_threads_proof.check(r->>'code' = 'GRANT_INVALID', 'a grant records once');
  perform postona_threads_proof.check((select grant_hash is null and grant_state is null from public.threads_manual_publish_attempts where id = att::uuid), 'grant cleared');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  att text := pg_temp.get('attempt1');
  r jsonb;
  g text;
begin
  -- check_container: a read step, no move.
  r := postona_threads_proof.as_user(a, 'claim', att, 'check_container');
  g := r->>'grant';
  perform postona_threads_proof.check(r->'attempt'->>'status' = 'container_created', 'read step does not move');
  r := postona_threads_proof.as_server('redeem', att, 'check_container', g);
  perform postona_threads_proof.check(r->>'container_id' = '17890000000000001' and r->'text' = 'null'::jsonb, 'the read step gets the container, not the text');
  -- publish
  r := postona_threads_proof.as_user(a, 'claim', att, 'publish');
  g := r->>'grant';
  perform postona_threads_proof.check(r->'attempt'->>'status' = 'publishing', 'publishing');
  r := postona_threads_proof.as_server('redeem', att, 'publish', g);
  r := postona_threads_proof.as_server('record', att, 'publish', g, 'publish_returned', null, '17890000000000003', null, null);
  perform postona_threads_proof.check(r->'attempt'->>'status' = 'publish_returned', 'publish returned');
  -- confirm needs the same id
  r := postona_threads_proof.as_user(a, 'claim', att, 'confirm');
  g := r->>'grant';
  r := postona_threads_proof.as_server('redeem', att, 'confirm', g);
  r := postona_threads_proof.as_server('record', att, 'confirm', g, 'published', null, '17890000000000099', 'https://www.threads.net/@a/post/AbC', null);
  perform postona_threads_proof.check(r->>'code' = 'REQUEST_INVALID', 'confirm with another id');
  r := postona_threads_proof.as_server('record', att, 'confirm', g, 'published', null, '17890000000000003', 'https://evil.example/x', null);
  perform postona_threads_proof.check(r->>'code' = 'REQUEST_INVALID', 'a non-Threads permalink');
  r := postona_threads_proof.as_server('record', att, 'confirm', g, 'published', null, '17890000000000003', 'https://www.threads.net/@a/post/AbC', null);
  perform postona_threads_proof.check(r->'attempt'->>'status' = 'published' and r->'attempt'->>'permalink' = 'https://www.threads.net/@a/post/AbC', 'published');
  r := postona_threads_proof.as_user(a, 'state', pg_temp.get('acct_a'));
  perform postona_threads_proof.check(r->>'permitted' = 'true' and r->'open_attempt' = 'null'::jsonb and r->'last_attempt'->>'status' = 'published', 'state after publish');
  r := postona_threads_proof.as_user(a, 'claim', att, 'confirm');
  perform postona_threads_proof.check(r->>'code' = 'STALE_STEP', 'a terminal attempt cannot be claimed');
  r := postona_threads_proof.as_user(a, 'read', att);
  perform postona_threads_proof.check(r->'attempt'->>'provider_post_id' = '17890000000000003', 'read');
end $$;

-- ---- Uncertain, reconcile, expired, interrupted, revoked ------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
  att text;
  g text;
begin
  r := postona_threads_proof.as_user(a, 'begin', acct, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2件目');
  att := r->'attempt'->>'attempt_id';
  g := postona_threads_proof.as_user(a, 'claim', att, 'create_container')->>'grant';
  perform postona_threads_proof.as_server('redeem', att, 'create_container', g);
  perform postona_threads_proof.as_server('record', att, 'create_container', g, 'container_created', '17890000000000011', null, null, null);
  g := postona_threads_proof.as_user(a, 'claim', att, 'publish')->>'grant';
  perform postona_threads_proof.as_server('redeem', att, 'publish', g);
  r := postona_threads_proof.as_server('record', att, 'publish', g, 'uncertain', null, null, null, 'THREADS_UNAVAILABLE');
  perform postona_threads_proof.check(r->'attempt'->>'status' = 'uncertain', 'uncertain');
  -- Uncertain blocks a new attempt and any publish claim.
  r := postona_threads_proof.as_user(a, 'begin', acct, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '3件目');
  perform postona_threads_proof.check(r->>'code' = 'PUBLISH_IN_PROGRESS', 'uncertain blocks the next attempt');
  r := postona_threads_proof.as_user(a, 'claim', att, 'publish');
  perform postona_threads_proof.check(r->>'code' = 'STALE_STEP', 'no publish claim while uncertain');
  -- Reconcile works even after the permission is withdrawn.
  perform postona_threads_proof.as_user(a, 'permission', acct, 'false', 'true');
  g := postona_threads_proof.as_user(a, 'claim', att, 'reconcile')->>'grant';
  r := postona_threads_proof.as_server('redeem', att, 'reconcile', g);
  perform postona_threads_proof.check(r->>'text' = '2件目' and r->>'container_id' = '17890000000000011', 'reconcile gets text and container');
  r := postona_threads_proof.as_server('record', att, 'reconcile', g, 'uncertain', null, null, null, 'PUBLISH_OUTCOME_UNKNOWN');
  perform postona_threads_proof.check(r->'attempt'->>'error_code' = 'PUBLISH_OUTCOME_UNKNOWN', 'still uncertain, reason updated');
  g := postona_threads_proof.as_user(a, 'claim', att, 'reconcile')->>'grant';
  perform postona_threads_proof.as_server('redeem', att, 'reconcile', g);
  r := postona_threads_proof.as_server('record', att, 'reconcile', g, 'failed', null, null, null, 'CONTAINER_EXPIRED');
  perform postona_threads_proof.check(r->'attempt'->>'status' = 'failed', 'resolved: never published');
  perform postona_threads_proof.as_user(a, 'permission', acct, 'true', 'false');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
  att text;
  g text;
begin
  -- Permission withdrawn between the claim and the credential read: nothing sent, closed as failed.
  att := postona_threads_proof.as_user(a, 'begin', acct, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '4件目')->'attempt'->>'attempt_id';
  g := postona_threads_proof.as_user(a, 'claim', att, 'create_container')->>'grant';
  perform postona_threads_proof.as_user(a, 'permission', acct, 'false', 'true');
  r := postona_threads_proof.as_server('redeem', att, 'create_container', g);
  perform postona_threads_proof.check(r->>'code' = 'MANUAL_PUBLISH_NOT_PERMITTED' and not (r ? 'access_token'), 'no credential after withdrawal');
  perform postona_threads_proof.check((select status = 'failed' and error_code = 'AUTHORIZATION_CHANGED' from public.threads_manual_publish_attempts where id = att::uuid), 'closed as failed');
  perform postona_threads_proof.as_user(a, 'permission', acct, 'true', 'false');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
  att text;
  g text;
begin
  -- An expired grant buys nothing; an attempt older than 15 minutes cannot continue to a write.
  att := postona_threads_proof.as_user(a, 'begin', acct, 'ffffffff-ffff-4fff-8fff-ffffffffffff', '5件目')->'attempt'->>'attempt_id';
  g := postona_threads_proof.as_user(a, 'claim', att, 'create_container')->>'grant';
  update public.threads_manual_publish_attempts set grant_expires_at = clock_timestamp() - interval '1 second' where id = att::uuid;
  r := postona_threads_proof.as_server('redeem', att, 'create_container', g);
  perform postona_threads_proof.check(r->>'code' = 'GRANT_INVALID', 'expired grant');
  -- That attempt is now an abandoned in-flight container step: settled by a later reconcile.
  update public.threads_manual_publish_attempts set updated_at = now() - interval '3 minutes' where id = att::uuid;
  r := postona_threads_proof.as_user(a, 'claim', att, 'reconcile');
  perform postona_threads_proof.check(r->>'code' = 'STALE_STEP', 'settled');
  perform postona_threads_proof.check((select status = 'failed' and error_code = 'STEP_INTERRUPTED' from public.threads_manual_publish_attempts where id = att::uuid), 'interrupted container step: failed');
  att := postona_threads_proof.as_user(a, 'begin', acct, '11111111-1111-4111-8111-aaaaaaaaaaaa', '6件目')->'attempt'->>'attempt_id';
  update public.threads_manual_publish_attempts set created_at = now() - interval '16 minutes' where id = att::uuid;
  r := postona_threads_proof.as_user(a, 'claim', att, 'create_container');
  perform postona_threads_proof.check(r->>'code' = 'ATTEMPT_EXPIRED', 'too old');
  perform postona_threads_proof.check((select status = 'failed' and error_code = 'ATTEMPT_EXPIRED' from public.threads_manual_publish_attempts where id = att::uuid), 'closed as expired');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
  att text;
  g text;
begin
  -- An abandoned publish becomes uncertain on reconcile, and the reconcile grant is issued.
  att := postona_threads_proof.as_user(a, 'begin', acct, '22222222-2222-4222-8222-aaaaaaaaaaaa', '7件目')->'attempt'->>'attempt_id';
  g := postona_threads_proof.as_user(a, 'claim', att, 'create_container')->>'grant';
  perform postona_threads_proof.as_server('redeem', att, 'create_container', g);
  perform postona_threads_proof.as_server('record', att, 'create_container', g, 'container_created', '17890000000000021', null, null, null);
  perform postona_threads_proof.as_user(a, 'claim', att, 'publish');
  r := postona_threads_proof.as_user(a, 'claim', att, 'reconcile');
  perform postona_threads_proof.check(r->>'code' = 'STALE_STEP', 'a fresh publishing step is not settled');
  update public.threads_manual_publish_attempts set updated_at = now() - interval '3 minutes' where id = att::uuid;
  r := postona_threads_proof.as_user(a, 'claim', att, 'reconcile');
  perform postona_threads_proof.check(r->>'status' = 'claimed' and r->'attempt'->>'status' = 'uncertain' and r->'attempt'->>'error_code' = 'STEP_INTERRUPTED', 'publishing -> uncertain: ' || r::text);
  g := r->>'grant';
  perform postona_threads_proof.as_server('redeem', att, 'reconcile', g);
  r := postona_threads_proof.as_server('record', att, 'reconcile', g, 'published_unidentified', null, null, null, 'PUBLISHED_POST_NOT_FOUND');
  perform postona_threads_proof.check(r->'attempt'->>'status' = 'published_unidentified', 'unidentified');
end $$;

-- ---- Credential expiry (unknown, expired, about to expire) ------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
  att text;
  g text;
  e timestamptz;
begin
  foreach e in array array[now() + interval '4 minutes', now() - interval '1 day', null::timestamptz] loop
    perform pg_temp.update_expiry(acct, e);
    r := postona_threads_proof.as_user(a, 'begin', acct, '55555555-5555-4555-8555-aaaaaaaaaaaa', '期限');
    perform postona_threads_proof.check(r->>'code' = 'CREDENTIALS_EXPIRED', 'expiry ' || coalesce(e::text, 'unknown') || ': ' || r::text);
  end loop;
  perform pg_temp.update_expiry(acct, now() + interval '50 days');
  -- Expiry reached between the claim and the credential read: no token, the write step is closed.
  att := postona_threads_proof.as_user(a, 'begin', acct, '66666666-6666-4666-8666-aaaaaaaaaaaa', '期限2')->'attempt'->>'attempt_id';
  g := postona_threads_proof.as_user(a, 'claim', att, 'create_container')->>'grant';
  perform pg_temp.update_expiry(acct, now() + interval '1 minute');
  r := postona_threads_proof.as_server('redeem', att, 'create_container', g);
  perform postona_threads_proof.check(r->>'code' = 'CREDENTIALS_EXPIRED' and not (r ? 'access_token'), 'no token near expiry');
  perform postona_threads_proof.check((select status = 'failed' and error_code = 'AUTHORIZATION_CHANGED' from public.threads_manual_publish_attempts where id = att::uuid), 'closed');
  perform pg_temp.update_expiry(acct, now() + interval '50 days');
end $$;

-- ---- Workspace, fence, deletion guard, cascade -------------------------------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
begin
  update public.brands set publish_mode = 'disabled' where id = pg_temp.get('brand_a');
  r := postona_threads_proof.as_user(a, 'begin', acct, '33333333-3333-4333-8333-aaaaaaaaaaaa', '8件目');
  perform postona_threads_proof.check(r->>'code' = 'WORKSPACE_INACTIVE', 'disabled workspace');
  update public.brands set publish_mode = 'live', is_active = false where id = pg_temp.get('brand_a');
  r := postona_threads_proof.as_user(a, 'begin', acct, '33333333-3333-4333-8333-aaaaaaaaaaaa', '8件目');
  perform postona_threads_proof.check(r->>'code' = 'WORKSPACE_INACTIVE', 'inactive workspace');
  update public.brands set is_active = true where id = pg_temp.get('brand_a');
  update postona_threads_proof.lifecycle set state = 'ended' where user_id = a;
  r := postona_threads_proof.as_user(a, 'begin', acct, '33333333-3333-4333-8333-aaaaaaaaaaaa', '8件目');
  perform postona_threads_proof.check(r->>'code' = 'SERVICE_NOT_ACTIVE', 'ended service');
  update postona_threads_proof.lifecycle set state = 'locked' where user_id = a;
  r := postona_threads_proof.as_user(a, 'begin', acct, '33333333-3333-4333-8333-aaaaaaaaaaaa', '8件目');
  perform postona_threads_proof.check(r->>'code' = 'ACCOUNT_LIFECYCLE_BLOCKED', 'locked account');
  update postona_threads_proof.lifecycle set state = 'active' where user_id = a;
  update public.social_accounts set connection_status = 'failed' where id = acct;
  r := postona_threads_proof.as_user(a, 'begin', acct, '33333333-3333-4333-8333-aaaaaaaaaaaa', '8件目');
  perform postona_threads_proof.check(r->>'code' = 'CONNECTION_NOT_VERIFIED', 'connection failed');
  update public.social_accounts set connection_status = 'identity_verified' where id = acct;
  perform postona_threads_proof.check(not exists (select 1 from public.threads_manual_publish_attempts where post_text = '8件目'), 'none reserved');
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  r jsonb;
begin
  -- POSTONA deletion has started for this workspace: nothing new is written into it.
  insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
  values (a, pg_temp.get('brand_a'), 'started', 'social_only', '[]');
  r := postona_threads_proof.as_user(a, 'begin', acct, '44444444-4444-4444-8444-aaaaaaaaaaaa', '9件目');
  perform postona_threads_proof.check(r->>'code' = 'ACCOUNT_LIFECYCLE_BLOCKED', 'deletion guard: ' || r::text);
  perform postona_threads_proof.check(not exists (select 1 from public.threads_manual_publish_attempts where post_text = '9件目'), 'nothing written during deletion');
  delete from public.social_mobile_account_deletions where user_id = a;
end $$;

do $$
declare
  acct text := pg_temp.get('acct_a');
begin
  perform postona_threads_proof.check((select count(*) from public.threads_manual_publish_attempts where social_account_id = acct) > 0, 'attempts exist before');
  delete from public.social_accounts where id = acct;
  perform postona_threads_proof.check(not exists (select 1 from public.threads_manual_publish_attempts where social_account_id = acct)
                                      and not exists (select 1 from public.social_account_manual_publish_permissions where social_account_id = acct),
                                      'disconnect (row delete) removes the attempts and the permission');
end $$;

select 'BEHAVIOR_OK';
