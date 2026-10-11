-- G4 INTEGRATION SMOKE (SQL) — runs ONLY inside the disposable combined database that
-- supabase/tests/postona_threads_integration_run.sh builds: the H5 parent world (real G5 lifecycle
-- migrations, real deletion + X migrations, Phase 2a-2, MOCK_ONLY T13 of PR #124, fake Vault/Auth),
-- PR #124's candidate and behavior helpers (postona_t), H5's claim candidate, then G4's custody, manual
-- publish and release candidates. Fake data only.
--
-- One person, end to end, on the real source candidates:
--   G5 start_x_autopost_service -> PR #124 begin + H5 remember -> H5 durable code claim ->
--   ONE owner transaction: PR #124 complete (attested) + G4 custody + H5 outcome ->
--   G4 explicit permission -> G4 reserve -> G4 attested release / record x4 -> published (read-back
--   recorded) ; then the K4 P1 checks on the real lifecycle tables: entitlement ended, session revoked.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create schema g4i;
insert into vault.secrets (name, secret) values ('postona_threads_publish_attestation_v1', 'fake_publish_attestation_key_0123456789abcdef0123');

create function g4i.u() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-00000000c401'::uuid $$;
create function g4i.hmac(p_message text) returns text language plpgsql as $$
begin
  return encode(extensions.hmac(convert_to(p_message, 'UTF8'), convert_to('fake_publish_attestation_key_0123456789abcdef0123', 'UTF8'), 'sha256'), 'hex');
end $$;
create function g4i.nonce() returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;
-- A caller-side function as the Data API runs it (the person's claims, role authenticated).
create function g4i.call(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform postona_t.act(g4i.u());
  set local role authenticated;
  execute p_sql into v;
  reset role;
  perform postona_t.act(null, '');
  return v;
end $$;
create function g4i.release(p_attempt uuid, p_step text) returns jsonb language plpgsql as $$
declare i bigint := extract(epoch from clock_timestamp())::bigint; n text := g4i.nonce();
begin
  return g4i.call(format('select public.release_threads_manual_publish_step(%L::uuid, %L, %s, %L, %L)', p_attempt, p_step, i, n,
    g4i.hmac(concat_ws(chr(10), 'postona-threads-publish-release-v1', g4i.u()::text, p_attempt::text, p_step, i::text, n))));
end $$;
create function g4i.record(p_attempt uuid, p_step text, p_grant text, p_to text, p_container text, p_post text, p_permalink text, p_error text)
returns jsonb language plpgsql as $$
declare i bigint := extract(epoch from clock_timestamp())::bigint; n text := g4i.nonce();
begin
  return g4i.call(format('select public.record_threads_manual_publish_result(%L::uuid, %L, %L, %L, %L, %L, %L, %L, %s, %L, %L)',
    p_attempt, p_step, p_grant, p_to, p_container, p_post, p_permalink, p_error, i, n,
    g4i.hmac(concat_ws(chr(10), 'postona-threads-publish-record-v1', g4i.u()::text, p_attempt::text, p_step, p_grant, p_to,
                       coalesce(p_container, ''), coalesce(p_post, ''), coalesce(p_permalink, ''), coalesce(p_error, ''), i::text, n))));
end $$;
create function g4i.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'G4_INTEGRATION_FAIL %', p_label; end if;
end $$;

-- 1. A POSTONA user with a live session (real G5 lifecycle RPC).
begin;
select postona_t.login(g4i.u());
select postona_t.register(g4i.u());
commit;

-- 2. PR #124 begin + H5 remember, as H5's owner transport runs them (verified claims set).
begin;
select postona_t.act(g4i.u());
select postona_threads_runtime.assert_actor(g4i.u(), postona_t.session_of(g4i.u()));
select * from public.begin_social_mobile_threads_oauth_connection(postona_t.h('g4-int'), 'https://postona.example/callback', now() + interval '5 minutes');
select postona_threads_runtime.remember(postona_t.h('g4-int'), g4i.u(), postona_t.session_of(g4i.u()), 'https://postona.example/callback');
commit;

-- 3. H5 durable one-shot claim of the code (before any Meta exchange).
begin;
select postona_t.act(g4i.u());
select postona_threads_runtime.claim(postona_t.h('g4-int'), repeat('e', 64), g4i.u(), postona_t.session_of(g4i.u()), 'https://postona.example/callback');
commit;

-- 4. ONE owner transaction: PR #124 complete + G4 custody + H5 outcome (the statements of
--    THREADS_COMPLETE_TRANSACTION_SQL, after H5's own assert / lock / attempt checks).
begin;
select postona_t.act(g4i.u());
select postona_threads_runtime.assert_actor(g4i.u(), postona_t.session_of(g4i.u()));
select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace(g4i.u()));
select id from public.social_account_oauth_states where state_hash = postona_t.h('g4-int') for update;
select state_hash from postona_threads_runtime.attempts where state_hash = postona_t.h('g4-int') for update;
select public.complete_social_mobile_threads_oauth_connection(s.id, '17841405793187299', 'g4_integration', 'fakeG4IntegrationToken0123456789',
         postona_t.attest(s.id, '17841405793187299', 'g4_integration', 'fakeG4IntegrationToken0123456789'))
  from public.social_account_oauth_states s where s.state_hash = postona_t.h('g4-int');
select public.record_threads_credential_custody(postona_t.threads_id(g4i.u()), now() + interval '60 days');
select postona_threads_runtime.outcome(postona_t.h('g4-int'), g4i.u(), postona_t.session_of(g4i.u()), 'complete', now() + interval '60 days');
commit;

do $$
declare acct text := postona_t.threads_id(g4i.u());
begin
  perform g4i.check(exists (select 1 from public.social_accounts a where a.id = acct and a.platform = 'threads'
                            and a.connection_status = 'identity_verified' and a.publish_enabled = false
                            and a.vault_access_token_secret_id is not null and a.vault_refresh_token_secret_id is null), 'connected by PR #124');
  perform g4i.check(public.threads_account_credential_expires_at(acct) > now() + interval '59 days', 'custody bound to the stored credential');
  perform g4i.check(exists (select 1 from postona_threads_runtime.attempts where state_hash = postona_t.h('g4-int') and status = 'complete'), 'H5 outcome complete');
end $$;

-- 5. Connected is not permitted: no reservation without the explicit permission.
do $$
declare acct text := postona_t.threads_id(g4i.u()); r jsonb;
begin
  r := g4i.call(format('select public.begin_threads_manual_publish(%L, %L::uuid, %L)', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'POSTONAから最初の1件'));
  perform g4i.check(r->>'code' = 'MANUAL_PUBLISH_NOT_PERMITTED', 'connected is not permitted: ' || r::text);
  r := g4i.call(format('select public.set_threads_manual_publish_permission(%L, true, false)', acct));
  perform g4i.check(r->>'permitted' = 'true', 'permission granted: ' || r::text);
end $$;

-- 6. Reserve, then four attested releases with their records: container, ready, publish, read-back.
do $$
declare acct text := postona_t.threads_id(g4i.u()); r jsonb; att uuid; g text;
begin
  r := g4i.call(format('select public.begin_threads_manual_publish(%L, %L::uuid, %L)', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'POSTONAから最初の1件'));
  att := (r->'attempt'->>'attempt_id')::uuid;
  r := g4i.release(att, 'create_container');
  perform g4i.check(r->>'access_token' = 'fakeG4IntegrationToken0123456789' and r->>'threads_user_id' = '17841405793187299', 'release hands the PR #124 credential: ' || coalesce(r->>'code', 'released'));
  g := r->>'grant';
  r := g4i.record(att, 'create_container', g, 'container_created', '17890000000000001', null, null, null);
  r := g4i.release(att, 'check_container');
  perform g4i.check(r->>'container_id' = '17890000000000001', 'check');
  r := g4i.release(att, 'publish');
  g := r->>'grant';
  r := g4i.record(att, 'publish', g, 'publish_returned', null, '17890000000000003', null, null);
  r := g4i.release(att, 'confirm');
  g := r->>'grant';
  r := g4i.record(att, 'confirm', g, 'published', null, '17890000000000003', 'https://www.threads.net/@g4_integration/post/AbC', null);
  perform g4i.check(r->'attempt'->>'status' = 'published', 'published: ' || r::text);
  perform g4i.check(exists (select 1 from public.threads_manual_publish_attempts where id = att and status = 'published' and permalink like 'https://www.threads.net/%'), 'recorded');
end $$;

-- 7. K4 P1 on the real lifecycle tables: the next release re-decides everything.
do $$
declare acct text := postona_t.threads_id(g4i.u()); r jsonb; att uuid; g text;
begin
  r := g4i.call(format('select public.begin_threads_manual_publish(%L, %L::uuid, %L)', acct, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2件目'));
  att := (r->'attempt'->>'attempt_id')::uuid;
  r := g4i.release(att, 'create_container');
  g := r->>'grant';
  r := g4i.record(att, 'create_container', g, 'container_created', '17890000000000011', null, null, null);
  -- The POSTONA entitlement ends (G5 table) after the container: the publish release refuses, no token.
  update public.service_entitlements set status = 'ended', ended_at = now() where user_id = g4i.u() and service_key = 'x_autopost';
  r := g4i.release(att, 'publish');
  perform g4i.check(r->>'code' = 'SERVICE_NOT_ACTIVE' and not (r ? 'access_token'), 'ended entitlement (real G5 table, mock fence): ' || r::text);
  update public.service_entitlements set status = 'active', ended_at = null where user_id = g4i.u() and service_key = 'x_autopost';
  -- The session is signed out: refused, no token.
  update auth.sessions set not_after = now() - interval '1 second' where id = postona_t.session_of(g4i.u());
  r := g4i.release(att, 'publish');
  perform g4i.check(r->>'code' = 'AUTH_REQUIRED' and not (r ? 'access_token'), 'signed-out session: ' || r::text);
  perform g4i.check((select status from public.threads_manual_publish_attempts where id = att) = 'container_created', 'nothing moved');
end $$;

select 'G4_INTEGRATION_SMOKE_SQL_PASS: real PR124 + H5 claim + G4 stack; MOCK_ONLY T13, fake Vault/Auth';
