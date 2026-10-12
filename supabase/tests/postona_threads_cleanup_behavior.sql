-- Behavior proof for supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql,
-- run by postona_threads_cleanup_run.sh as the table owner on the G4 publish world (release fixture +
-- custody -> manual publish -> release) with a stand-in of G5's private.account_lifecycle_operations.
-- Each DO block is one transaction. Fake data only.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create temp table ctx (k text primary key, v text);
create function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.get(p_k text) returns text language sql as $$ select v from ctx where k = p_k $$;
-- What a person's Threads footprint looks like right now, as one comparable value.
create function pg_temp.footprint(p_account text) returns text language sql as $$
  select concat_ws('|',
    (select count(*) from public.social_accounts where id = p_account),
    (select count(*) from public.social_account_manual_publish_permissions where social_account_id = p_account),
    (select count(*) from public.threads_manual_publish_attempts where social_account_id = p_account),
    (select count(*) from public.threads_manual_publish_nonces n join public.threads_manual_publish_attempts t on t.id = n.attempt_id where t.social_account_id = p_account),
    (select count(*) from public.threads_account_credential_custody where social_account_id = p_account),
    (select count(*) from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = p_account)) $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  brand_a text; brand_b text; acct_a text; acct_b text; att text; g text; r jsonb;
begin
  brand_a := public.fixture_brand(a, 'xa');
  brand_b := public.fixture_brand(b, 'xb');
  perform postona_rel.login(a); perform postona_rel.login(b);
  insert into postona_rel.lifecycle (user_id, state) values (a, 'active'), (b, 'active');
  acct_a := postona_rel.connect_threads(a, brand_a, 'a');
  acct_b := postona_rel.connect_threads(b, brand_b, 'b');
  perform postona_rel.as_user(a, 'permission', acct_a, 'true', 'false');
  perform postona_rel.as_user(b, 'permission', acct_b, 'true', 'false');
  -- A finished post for a (attempt + nonces), so the cascade has something to remove.
  att := postona_rel.as_user(a, 'begin', acct_a, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '公開済みの投稿')->'attempt'->>'attempt_id';
  r := postona_rel.release(a, att::uuid, 'create_container'); g := r->>'grant';
  perform postona_rel.record(a, att::uuid, 'create_container', g, 'failed', p_error => 'THREADS_UNAVAILABLE');
  perform pg_temp.put('acct_a', acct_a); perform pg_temp.put('acct_b', acct_b);
  perform pg_temp.put('secret_a', (select vault_access_token_secret_id::text from public.social_accounts where id = acct_a));
  perform pg_temp.put('secret_b', (select vault_access_token_secret_id::text from public.social_accounts where id = acct_b));
end $$;

-- ---- ACL: owner only (G5's registration grants its own role later) --------------------------------------
do $$
begin
  perform postona_rel.check(postona_rel.try_as('service_role', 'select public.cleanup_threads_provider_footprint(gen_random_uuid())') = '42501', 'service_role cannot clean (not registered yet)');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select public.cleanup_threads_provider_footprint(gen_random_uuid())') = '42501', 'authenticated cannot clean');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select public.threads_provider_connection_state(gen_random_uuid())') = '42501', 'authenticated cannot probe');
  perform postona_rel.check(postona_rel.try_as('anon', 'select public.threads_cleanup_authorized(gen_random_uuid())') = '42501', 'anon cannot probe');
end $$;

-- ---- hasConnection ------------------------------------------------------------------------------------
do $$
begin
  perform postona_rel.check(public.threads_provider_connection_state('00000000-0000-4000-8000-0000000000a1') = 'connected', 'a connected');
  perform postona_rel.check(public.threads_provider_connection_state('00000000-0000-4000-8000-0000000000c1') = 'not_connected', 'stranger not connected');
  perform postona_rel.check(public.threads_provider_connection_state(null) = 'invalid', 'null id');
end $$;

-- ---- No deletion in progress: nothing is removed --------------------------------------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; before text := pg_temp.footprint(pg_temp.get('acct_a')); r jsonb;
begin
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r = '{"code": "DELETION_NOT_IN_PROGRESS", "outcome": "blocked"}', 'no deletion: ' || r::text);
  -- A deletion past its cleanup step, or already finished, does not authorize either.
  insert into private.account_lifecycle_operations (user_id, operation_type, status, current_step) values (a, 'account_deletion', 'in_progress', 'ready_for_managed_auth_delete');
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r->>'outcome' = 'blocked', 'past the cleanup step: ' || r::text);
  -- Ending another service (kabumori) does not authorize removing POSTONA's Threads data.
  insert into private.account_lifecycle_operations (user_id, operation_type, service_key, status, current_step) values (a, 'service_deletion', 'kabumori', 'in_progress', 'cleanup');
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r->>'outcome' = 'blocked', 'kabumori service deletion: ' || r::text);
  delete from private.account_lifecycle_operations where user_id = a;
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_a')) = before, 'nothing removed');
end $$;

-- ---- F4: an account deletion authorizes only while an owner holds its live lease ---------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; before text := pg_temp.footprint(pg_temp.get('acct_a')); r jsonb;
begin
  -- In its cleanup step, but nobody owns it (released, or never claimed).
  insert into private.account_lifecycle_operations (user_id, operation_type, status, current_step) values (a, 'account_deletion', 'in_progress', 'cleanup');
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r = '{"code": "DELETION_NOT_IN_PROGRESS", "outcome": "blocked"}', 'no owner lease: ' || r::text);
  -- The owner's lease ran out (by the wall clock).
  update private.account_lifecycle_operations set owner_lease = gen_random_uuid(), owner_lease_expires_at = clock_timestamp() - interval '1 second' where user_id = a;
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r->>'outcome' = 'blocked', 'expired lease: ' || r::text);
  -- A lease that expires DURING this transaction: now() is the transaction start, clock_timestamp() is not.
  update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '300 milliseconds' where user_id = a;
  perform pg_sleep(0.5);
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r->>'outcome' = 'blocked', 'lease expired by the wall clock within one transaction: ' || r::text);
  perform postona_rel.check(public.threads_provider_connection_state(a) = 'connected', 'still connected');
  delete from private.account_lifecycle_operations where user_id = a;
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_a')) = before, 'nothing removed without a live lease');
end $$;

-- ---- A post that may be in flight blocks the removal (reconcile first) ------------------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; att uuid; r jsonb; before text;
begin
  insert into private.account_lifecycle_operations (user_id, operation_type, status, current_step, owner_lease, owner_lease_expires_at)
  values (a, 'account_deletion', 'in_progress', 'cleanup', gen_random_uuid(), clock_timestamp() + interval '10 minutes');
  att := (postona_rel.as_user(a, 'begin', pg_temp.get('acct_a'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '送信中かもしれない投稿')->'attempt'->>'attempt_id')::uuid;
  r := postona_rel.release(a, att, 'create_container');
  perform pg_temp.put('inflight', att::text);
  before := pg_temp.footprint(pg_temp.get('acct_a'));
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r = '{"code": "PUBLISH_IN_FLIGHT", "outcome": "reconciliation_required"}', 'in flight: ' || r::text);
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_a')) = before, 'nothing removed while in flight');
end $$;

do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; att uuid := pg_temp.get('inflight')::uuid; s text; r jsonb;
begin
  -- Every "may have posted" status blocks; reserved / container_created (no post possible) do not.
  foreach s in array array['publishing', 'publish_returned', 'uncertain'] loop
    update public.threads_manual_publish_attempts set status = s, container_id = '17890000000000001',
           provider_post_id = case when s = 'publish_returned' then '17890000000000003' end,
           error_code = case when s = 'uncertain' then 'PUBLISH_OUTCOME_UNKNOWN' end,
           grant_hash = null, grant_step = null, grant_state = null, grant_expires_at = null, grant_user_id = null, grant_session_id = null
     where id = att;
    r := public.cleanup_threads_provider_footprint(a);
    perform postona_rel.check(r->>'code' = 'PUBLISH_IN_FLIGHT', s || ': ' || r::text);
  end loop;
  -- Reconciled (here: settled as not published) -> the removal may proceed.
  update public.threads_manual_publish_attempts set status = 'failed', error_code = 'CONTAINER_EXPIRED', provider_post_id = null where id = att;
end $$;

-- F4: the connection's OAuth states as PR #124 leaves them (no cascade), one with a verifier secret, and another
-- person's state that must stay.
do $$
declare v uuid;
begin
  insert into vault.secrets (secret) values ('fake_verifier_a') returning id into v;
  perform pg_temp.put('verifier_a', v::text);
  insert into public.social_account_oauth_states (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, consumed_at)
  select pg_temp.get('acct_a'), a.brand_id, repeat('a', 64), null, now() from public.social_accounts a where a.id = pg_temp.get('acct_a')
  union all select pg_temp.get('acct_a'), a.brand_id, repeat('b', 64), v, null from public.social_accounts a where a.id = pg_temp.get('acct_a')
  union all select pg_temp.get('acct_b'), a.brand_id, repeat('c', 64), null, now() from public.social_accounts a where a.id = pg_temp.get('acct_b');
end $$;

-- ---- The removal: one person's Threads footprint, nothing else; idempotent --------------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  v_secret uuid := pg_temp.get('secret_a')::uuid;
  b_before text := pg_temp.footprint(pg_temp.get('acct_b'));
  x_before text := (select md5(string_agg(to_jsonb(s)::text, ',' order by s.id)) from public.social_accounts s where s.platform = 'x');
  r jsonb;
begin
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r = '{"code": "LOCAL_REMOVED", "outcome": "local_removed_remote_unverified"}', 'removed: ' || r::text);
  perform postona_rel.check(pg_temp.footprint(acct) = '0|0|0|0|0|0', 'no Threads row, permission, attempts, nonces or custody left: ' || pg_temp.footprint(acct));
  perform postona_rel.check(not exists (select 1 from vault.secrets s where s.id = v_secret), 'the Threads secret is gone');
  perform postona_rel.check(not exists (select 1 from public.social_account_oauth_states s where s.social_account_id = acct), 'its OAuth states are gone');
  perform postona_rel.check(not exists (select 1 from vault.secrets s where s.id = pg_temp.get('verifier_a')::uuid), 'their verifier secret is gone');
  perform postona_rel.check(exists (select 1 from public.social_account_oauth_states s where s.social_account_id = pg_temp.get('acct_b')), 'another person''s OAuth state stays');
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_b')) = b_before, 'another person untouched');
  perform postona_rel.check((select md5(string_agg(to_jsonb(s)::text, ',' order by s.id)) from public.social_accounts s where s.platform = 'x') = x_before, 'X rows untouched');
  perform postona_rel.check(public.threads_provider_connection_state(a) = 'not_connected', 'no connection any more');
  r := public.cleanup_threads_provider_footprint(a);
  perform postona_rel.check(r = '{"code": "ALREADY_REMOVED", "outcome": "local_removed_remote_unverified"}', 'idempotent: ' || r::text);
  perform postona_rel.check(r->>'outcome' <> 'confirmed_remote_revoked', 'never a confirmed remote revoke');
end $$;

-- ---- A secret shared with another row is not deleted (reconcile); ending POSTONA only also cleans --------
do $$
declare b uuid := '00000000-0000-4000-8000-0000000000b1'; before text := pg_temp.footprint(pg_temp.get('acct_b')); r jsonb; x_ref uuid;
begin
  insert into private.account_lifecycle_operations (user_id, operation_type, service_key, status, current_step) values (b, 'service_deletion', 'x_autopost', 'in_progress', 'cleanup');
  select vault_access_token_secret_id into x_ref from public.social_accounts where id = 'sa_xb';
  update public.social_accounts set vault_access_token_secret_id = pg_temp.get('secret_b')::uuid where id = 'sa_xb';
  r := public.cleanup_threads_provider_footprint(b);
  perform postona_rel.check(r = '{"code": "SECRET_SHARED", "outcome": "reconciliation_required"}', 'shared secret: ' || r::text);
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_b')) = before, 'nothing removed');
  update public.social_accounts set vault_access_token_secret_id = x_ref where id = 'sa_xb';
  r := public.cleanup_threads_provider_footprint(b);
  perform postona_rel.check(r->>'code' = 'LOCAL_REMOVED', 'POSTONA-only end removes Threads: ' || r::text);
  perform postona_rel.check(exists (select 1 from public.social_accounts where id = 'sa_xb'), 'the X account itself is not this adapter''s to remove');
end $$;

select 'CLEANUP_BEHAVIOR_OK';
