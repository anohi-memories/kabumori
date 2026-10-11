-- Behavior proof for the G4 publish stack: threads_credential_custody_candidate.sql ->
-- threads_manual_publish_candidate.sql -> threads_publish_release_candidate.sql. Run by
-- postona_threads_release_run.sh as the table owner. Each DO block is one transaction (one request).
-- Fake data only. Focus: the K4 P1 (authorization and credential release are one decision), the
-- server attestation, the session, the account-scoped expiry, and recording the truth.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create temp table ctx (k text primary key, v text);
create function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.get(p_k text) returns text language sql as $$ select v from ctx where k = p_k $$;
-- One attempt driven to container_created by the honest server; returns its id.
create function pg_temp.to_container(p_user uuid, p_acct text, p_key text, p_text text) returns text language plpgsql as $$
declare r jsonb; att text; g text;
begin
  att := postona_rel.as_user(p_user, 'begin', p_acct, p_key, p_text)->'attempt'->>'attempt_id';
  r := postona_rel.release(p_user, att::uuid, 'create_container');
  if r->>'status' is distinct from 'released' then raise exception 'FAIL to_container release: %', r; end if;
  g := r->>'grant';
  r := postona_rel.record(p_user, att::uuid, 'create_container', g, 'container_created', '17890000000000001');
  if r->'attempt'->>'status' is distinct from 'container_created' then raise exception 'FAIL to_container record: %', r; end if;
  return att;
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  m uuid := '00000000-0000-4000-8000-0000000000d1';
  brand_a text; brand_b text;
begin
  brand_a := public.fixture_brand(a, 'xa');
  brand_b := public.fixture_brand(b, 'xb');
  perform public.fixture_member(brand_a, m, 'admin');
  perform postona_rel.login(a); perform postona_rel.login(b); perform postona_rel.login(m);
  insert into postona_rel.lifecycle (user_id, state) values (a, 'active'), (b, 'active'), (m, 'active');
  -- As PR #124 and the X onboarding create every self-service workspace: automatic publishing off.
  update public.brands set is_active = false, publish_mode = 'disabled' where id in (brand_a, brand_b);
  perform pg_temp.put('brand_a', brand_a);
  perform pg_temp.put('brand_b', brand_b);
  perform pg_temp.put('acct', postona_rel.connect_threads(a, brand_a, 'a'));
end $$;

do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; r jsonb;
begin
  r := postona_rel.as_user(a, 'permission', pg_temp.get('acct'), 'true', 'false');
  perform postona_rel.check(r = '{"status":"updated","permitted":true}', 'grant: ' || r::text);
end $$;

-- ---- The attestation known answer, shared with the Edge test (http_test.ts) ------------------------------
do $$
begin
  perform postona_rel.check(postona_rel.hmac(concat_ws(chr(10), 'postona-threads-publish-release-v1', '00000000-0000-4000-8000-0000000000a1',
    '11111111-2222-4333-8444-555555555555', 'publish', '1760000000', repeat('ab', 32)))
    = 'c7cf793b40c12170cb179ecac087cd65978177e99bb0b157cac70360eee7d7b3', 'attestation known answer');
end $$;

-- ---- ACL: the superseded service_role path is gone; nobody but the attested release gets a token --------
do $$
begin
  perform postona_rel.check(to_regprocedure('public.redeem_threads_manual_publish_step(uuid,text,text)') is null, 'redeem dropped');
  perform postona_rel.check(to_regprocedure('public.claim_threads_manual_publish_step(uuid,text)') is null, 'claim dropped');
  perform postona_rel.check(postona_rel.try_as('service_role', 'select public.release_threads_manual_publish_step(gen_random_uuid(), ''publish'', 1, repeat(''a'',64), repeat(''a'',64))') = '42501', 'service_role cannot release');
  perform postona_rel.check(postona_rel.try_as('anon', 'select public.release_threads_manual_publish_step(gen_random_uuid(), ''publish'', 1, repeat(''a'',64), repeat(''a'',64))') = '42501', 'anon cannot release');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select public.threads_manual_publish_attestation_valid(''x'', ''y'')') = '42501', 'no attestation oracle');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select 1 from public.threads_manual_publish_nonces') = '42501', 'nonces hidden');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select 1 from public.threads_account_credential_custody') = '42501', 'custody hidden');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select public.threads_account_credential_expires_at(''sa_th_a'')') = '42501', 'expiry reader owner-only');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select public.record_threads_credential_custody(''sa_th_a'', now())') = '42501', 'custody writer owner-only');
  perform postona_rel.check(postona_rel.try_as('service_role', 'select public.record_threads_manual_publish_result(gen_random_uuid(), ''publish'', repeat(''a'',64), ''failed'', null, null, null, ''THREADS_UNAVAILABLE'', 1, repeat(''a'',64), repeat(''a'',64))') = '42501', 'service_role cannot record');
end $$;

-- ---- Attestation: a signed-in client without the server key gets nothing and locks nothing ---------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  att text;
  r jsonb;
  calls bigint;
  n text := postona_rel.nonce();
begin
  att := postona_rel.as_user(a, 'begin', pg_temp.get('acct'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '本番の1件目')->'attempt'->>'attempt_id';
  perform pg_temp.put('att1', att);
  calls := (select count(*) from postona_rel.fence_calls);
  r := postona_rel.release(a, att::uuid, 'create_container', p_key => 'a_guessed_key_that_is_long_enough_0123456789');
  perform postona_rel.check(r->>'code' = 'ATTESTATION_INVALID' and not (r ? 'access_token'), 'forged attestation: ' || r::text);
  perform postona_rel.check((select count(*) from postona_rel.fence_calls) = calls, 'a forged call does not even reach the fence');
  r := postona_rel.release(a, att::uuid, 'create_container', p_issued => extract(epoch from clock_timestamp())::bigint - 120);
  perform postona_rel.check(r->>'code' = 'ATTESTATION_INVALID', 'stale attestation');
  r := postona_rel.release(a, att::uuid, 'create_container', p_nonce => n);
  perform postona_rel.check(r->>'status' = 'released', 'honest release: ' || coalesce(r->>'code', ''));
  perform postona_rel.check(r->>'access_token' = 'fake_threads_a_TOKEN_0123456789' and r->>'text' = '本番の1件目' and r->>'grant' ~ '^[0-9a-f]{64}$', 'token, stored text, grant');
  perform pg_temp.put('g1', r->>'grant');
  perform pg_temp.put('n1', n);
  perform postona_rel.check((select status from public.threads_manual_publish_attempts where id = att::uuid) = 'creating_container', 'moved in the same transaction');
end $$;

do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; r jsonb;
begin
  -- A captured attestation is single use: the same nonce again is refused before anything else.
  r := postona_rel.release(a, pg_temp.get('att1')::uuid, 'create_container', p_nonce => pg_temp.get('n1'));
  perform postona_rel.check(r->>'code' = 'ATTESTATION_INVALID', 'replayed nonce: ' || r::text);
end $$;

do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; att uuid := pg_temp.get('att1')::uuid; r jsonb;
begin
  -- A second write release is stale (compare-and-set); a replayed nonce is refused.
  r := postona_rel.release(a, att, 'create_container');
  perform postona_rel.check(r->>'code' = 'STALE_STEP', 'second release of the same write');
  -- Recording needs the attestation, the grant, the same user AND the same session.
  r := postona_rel.record(a, att, 'create_container', pg_temp.get('g1'), 'container_created', '17890000000000001', p_key => 'a_guessed_key_that_is_long_enough_0123456789');
  perform postona_rel.check(r->>'code' = 'ATTESTATION_INVALID', 'forged record');
  r := postona_rel.record(a, att, 'create_container', repeat('0', 64), 'container_created', '17890000000000001');
  perform postona_rel.check(r->>'code' = 'GRANT_INVALID', 'wrong grant');
  r := postona_rel.record(a, att, 'create_container', pg_temp.get('g1'), 'container_created', '17890000000000001', p_session => gen_random_uuid());
  perform postona_rel.check(r->>'code' = 'GRANT_INVALID', 'another session cannot record');
  r := postona_rel.record('00000000-0000-4000-8000-0000000000d1', att, 'create_container', pg_temp.get('g1'), 'container_created', '17890000000000001');
  perform postona_rel.check(r->>'code' = 'GRANT_INVALID', 'another user (even an admin) cannot record');
  r := postona_rel.record(a, att, 'create_container', pg_temp.get('g1'), 'published', null, '1', 'https://www.threads.net/@a/post/1');
  perform postona_rel.check(r->>'code' = 'STALE_STEP', 'a transition the table does not allow');
  r := postona_rel.record(a, att, 'create_container', pg_temp.get('g1'), 'container_created', '17890000000000001');
  perform postona_rel.check(r->'attempt'->>'status' = 'container_created', 'recorded: ' || r::text);
  r := postona_rel.record(a, att, 'create_container', pg_temp.get('g1'), 'failed', p_error => 'THREADS_UNAVAILABLE');
  perform postona_rel.check(r->>'code' = 'GRANT_INVALID', 'a grant records once');
end $$;

-- ---- The P1: every change between steps is seen at the NEXT release; no token, nothing moves -------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  att uuid := pg_temp.get('att1')::uuid;
  acct text := pg_temp.get('acct');
  r jsonb;
  before_status text;
  cases text[][] := array[
    ['service ended', 'update postona_rel.lifecycle set state = ''ended'' where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'SERVICE_NOT_ACTIVE'],
    ['service ended (42501)', 'update postona_rel.lifecycle set state = ''ended'', sqlstate = ''42501'' where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'SERVICE_NOT_ACTIVE'],
    ['deletion started', 'update postona_rel.lifecycle set state = ''deleting'' where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'ACCOUNT_LIFECYCLE_BLOCKED'],
    ['account locked', 'update postona_rel.lifecycle set state = ''locked'' where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'ACCOUNT_LIFECYCLE_BLOCKED'],
    ['demoted to member', 'update public.brand_memberships set role = ''member'' where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'PUBLISH_FORBIDDEN'],
    ['membership removed', 'delete from public.brand_memberships where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'ATTEMPT_NOT_FOUND'],
    ['manual consent withdrawn', 'delete from public.social_account_manual_publish_permissions', 'MANUAL_PUBLISH_NOT_PERMITTED'],
    ['session signed out', 'delete from auth.sessions where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'AUTH_REQUIRED'],
    ['session expired', 'update auth.sessions set not_after = now() - interval ''1 second'' where user_id = ''00000000-0000-4000-8000-0000000000a1''', 'AUTH_REQUIRED'],
    ['token expiring in 2 minutes', 'update public.threads_account_credential_custody set expires_at = now() + interval ''2 minutes''', 'CREDENTIALS_EXPIRED'],
    ['custody missing', 'delete from public.threads_account_credential_custody', 'CREDENTIALS_EXPIRED'],
    ['reconnected without new custody', 'update public.social_accounts set verified_at = now() + interval ''1 second'' where platform = ''threads''', 'CREDENTIALS_EXPIRED'],
    ['connection failed', 'update public.social_accounts set connection_status = ''failed'' where platform = ''threads''', 'CONNECTION_NOT_VERIFIED'],
    ['not a self-service workspace', 'update public.brands set code_profile_key = ''kabumori_operator''', 'WORKSPACE_INACTIVE']];
  i int;
begin
  before_status := (select status from public.threads_manual_publish_attempts where id = att);
  for i in 1 .. array_length(cases, 1) loop
    -- Each case in a savepoint: the change, the release, then the change undone.
    begin
      execute cases[i][2];
      r := postona_rel.release(a, att, 'publish');
      perform postona_rel.check(r->>'code' = cases[i][3] and not (r ? 'access_token'), cases[i][1] || ': ' || r::text);
      perform postona_rel.check((select status from public.threads_manual_publish_attempts where id = att) = before_status, cases[i][1] || ': nothing moved');
      raise exception 'UNDO';
    exception when raise_exception then
      if sqlerrm <> 'UNDO' then raise; end if;
    end;
  end loop;
  -- And with nothing changed, the publish is released.
  r := postona_rel.release(a, att, 'publish');
  perform postona_rel.check(r->>'status' = 'released' and r->>'container_id' = '17890000000000001' and r->'text' = 'null'::jsonb, 'publish released: ' || r::text);
  perform pg_temp.put('g2', r->>'grant');
end $$;

do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; att uuid := pg_temp.get('att1')::uuid; r jsonb; g text;
begin
  -- The service ends while the post is in flight: the provider's answer is still recorded (the truth).
  update postona_rel.lifecycle set state = 'ended' where user_id = a;
  update public.threads_manual_publish_attempts set grant_expires_at = clock_timestamp() - interval '1 second' where id = att;
  r := postona_rel.record(a, att, 'publish', pg_temp.get('g2'), 'publish_returned', p_post => '17890000000000003');
  perform postona_rel.check(r->'attempt'->>'status' = 'publish_returned', 'late answer recorded after the service ended: ' || r::text);
  -- But the read-back needs a fresh release, which the ended service refuses.
  r := postona_rel.release(a, att, 'confirm');
  perform postona_rel.check(r->>'code' = 'SERVICE_NOT_ACTIVE', 'no confirm while ended');
  update postona_rel.lifecycle set state = 'active' where user_id = a;
  -- Withdrawn consent does not block the read-back (the person may learn whether it went out).
  delete from public.social_account_manual_publish_permissions;
  r := postona_rel.release(a, att, 'confirm');
  g := r->>'grant';
  perform postona_rel.check(r->>'status' = 'released' and r->>'provider_post_id' = '17890000000000003', 'confirm without consent');
  r := postona_rel.record(a, att, 'confirm', g, 'published', p_post => '17890000000000003', p_permalink => 'https://www.threads.net/@a/post/AbC');
  perform postona_rel.check(r->'attempt'->>'status' = 'published', 'published');
  perform postona_rel.as_user(a, 'permission', pg_temp.get('acct'), 'true', 'false');
end $$;

-- ---- A forged result never lands; a record grant does not unlock another attempt -------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; att uuid; att2 uuid; r jsonb; g text;
begin
  att := pg_temp.to_container(a, pg_temp.get('acct'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2件目')::uuid;
  r := postona_rel.release(a, att, 'publish');
  g := r->>'grant';
  -- The attestation covers the result: changing the post id after signing is refused.
  r := postona_rel.record(a, att, 'publish', g, 'publish_returned', p_post => '17890000000000099', p_key => 'fake_publish_attestation_key_0123456789abcdef0124');
  perform postona_rel.check(r->>'code' = 'ATTESTATION_INVALID', 'a result signed with another key');
  r := postona_rel.record(a, att, 'publish', g, 'uncertain', p_error => 'THREADS_UNAVAILABLE');
  perform postona_rel.check(r->'attempt'->>'status' = 'uncertain', 'uncertain recorded');
  r := postona_rel.release(a, att, 'publish');
  perform postona_rel.check(r->>'code' = 'STALE_STEP', 'never a second publish');
  r := postona_rel.as_user(a, 'begin', pg_temp.get('acct'), 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '3件目');
  perform postona_rel.check(r->>'code' = 'PUBLISH_IN_PROGRESS', 'uncertain blocks the next attempt');
  r := postona_rel.release(a, att, 'reconcile');
  g := r->>'grant';
  perform postona_rel.check(r->>'status' = 'released' and r->>'text' = '2件目', 'reconcile gets text');
  r := postona_rel.record(a, att, 'reconcile', g, 'failed', p_error => 'CONTAINER_EXPIRED');
  perform postona_rel.check(r->'attempt'->>'status' = 'failed', 'resolved');
end $$;

-- ---- Abandoned steps and expiry of the attempt ---------------------------------------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; att uuid; r jsonb;
begin
  att := (postona_rel.as_user(a, 'begin', pg_temp.get('acct'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '4件目')->'attempt'->>'attempt_id')::uuid;
  r := postona_rel.release(a, att, 'create_container'); -- the server dies here
  update public.threads_manual_publish_attempts set updated_at = now() - interval '3 minutes' where id = att;
  r := postona_rel.release(a, att, 'reconcile');
  perform postona_rel.check(r->>'code' = 'STALE_STEP', 'settled');
  perform postona_rel.check((select status = 'failed' and error_code = 'STEP_INTERRUPTED' from public.threads_manual_publish_attempts where id = att), 'abandoned container step: failed');
  att := (postona_rel.as_user(a, 'begin', pg_temp.get('acct'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '5件目')->'attempt'->>'attempt_id')::uuid;
  update public.threads_manual_publish_attempts set created_at = now() - interval '16 minutes' where id = att;
  r := postona_rel.release(a, att, 'create_container');
  perform postona_rel.check(r->>'code' = 'ATTEMPT_EXPIRED', 'too old');
end $$;

-- ---- Custody: only inside the connecting transaction, bound to the stored credential ----------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; got text;
begin
  perform postona_rel.act(a);
  begin
    perform public.record_threads_credential_custody(pg_temp.get('acct'), now() + interval '30 days');
    got := 'accepted';
  exception when others then got := sqlerrm;
  end;
  perform postona_rel.check(got = 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION', 'custody outside the connect transaction: ' || got);
  perform postona_rel.act(null);
end $$;
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; b uuid := '00000000-0000-4000-8000-0000000000b1'; got text;
begin
  update public.social_accounts set verified_at = now() where id = pg_temp.get('acct');
  foreach got in array array['62 days', '-1 minute'] loop
    perform postona_rel.act(a);
    begin
      perform public.record_threads_credential_custody(pg_temp.get('acct'), now() + got::interval);
      got := 'accepted';
    exception when others then got := sqlerrm;
    end;
    perform postona_rel.check(got = 'THREADS_CUSTODY_EXPIRY_INVALID', 'expiry bound: ' || got);
  end loop;
  perform postona_rel.act(b);
  begin
    perform public.record_threads_credential_custody(pg_temp.get('acct'), now() + interval '30 days');
    got := 'accepted';
  exception when others then got := sqlerrm;
  end;
  perform postona_rel.check(got = 'THREADS_CUSTODY_ACCOUNT_INVALID', 'another user cannot record custody: ' || got);
  perform postona_rel.act(a);
  perform public.record_threads_credential_custody(pg_temp.get('acct'), now() + interval '30 days');
  perform postona_rel.act(null);
  perform postona_rel.check(public.threads_account_credential_expires_at(pg_temp.get('acct')) = now() + interval '30 days', 'reconnect with new custody reads the new expiry');
  -- Another secret behind the same account: the old custody no longer describes it.
  update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid();
  perform postona_rel.check(public.threads_account_credential_expires_at(pg_temp.get('acct')) is null, 'custody of another secret reads NULL');
end $$;

-- ---- T10 (fake): removing the account and its secret leaves no G4 row and no orphan credential -----------
do $$
declare acct text := pg_temp.get('acct'); v_secret uuid;
begin
  select vault_access_token_secret_id into v_secret from public.social_accounts where id = acct;
  perform postona_rel.check(exists (select 1 from public.threads_manual_publish_attempts where social_account_id = acct), 'attempts exist');
  -- The G5 T10 contract: the provider cleanup deletes the Vault secret and the account row together.
  delete from public.social_accounts where id = acct;
  delete from vault.secrets where id = v_secret;
  perform postona_rel.check(not exists (select 1 from public.threads_manual_publish_attempts where social_account_id = acct)
                            and not exists (select 1 from public.social_account_manual_publish_permissions where social_account_id = acct)
                            and not exists (select 1 from public.threads_account_credential_custody where social_account_id = acct)
                            and not exists (select 1 from public.threads_manual_publish_nonces)
                            and not exists (select 1 from vault.secrets where id = v_secret), 'nothing left behind');
end $$;

select 'RELEASE_BEHAVIOR_OK';
