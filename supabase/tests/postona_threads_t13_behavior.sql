-- Behavior proof (F4, postona-f4-threads-t13-authenticated-writer-integration-20261013), run by
-- postona_threads_t13_run.sh as the table owner on the REAL G5 world (T13 writer guard, Phase 4, F5) with
-- PR #124's OAuth candidate, the G4 publish stack, the Threads cleanup and disconnect candidates and the F4
-- guards candidate applied. PR #124's functions are called through the owner channel with the person's claims
-- (as H5's owner transport does); the publish / disconnect functions as the Data API does (role
-- authenticated). Each DO block is one transaction. Fake data only.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create temp table ids (k text primary key, v text);
create function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into ids values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.get(p_k text) returns text language sql as $$ select v from ids where k = p_k $$;
create function pg_temp.u(p_tag text) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000000' || p_tag)::uuid $$;
-- An OAuth call through the owner channel: 'OK' or '<SQLSTATE> <message>'.
create function pg_temp.oauth(p_user uuid, p_sql text, p_session uuid default null, p_claim_role text default 'authenticated') returns text
language sql as $$ select t13.call(p_user, p_sql, 'owner', p_session, p_claim_role) $$;
create function pg_temp.begin_sql(p_tag text) returns text language sql immutable as $$
  select format('select * from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''9 minutes'')',
                t13.h(p_tag), 'https://postona.example/threads/callback') $$;
create function pg_temp.verified(p_user uuid) returns bigint language sql as $$
  select count(*) from public.social_accounts a
  where a.brand_id = public.social_mobile_account_deletion_workspace(p_user) and a.platform = 'threads'
    and a.connection_status = 'identity_verified' $$;

-- ---- People (all connected while active; states are set later) ---------------------------------------------
do $$
declare t text;
begin
  perform pg_temp.put('acct_a', t13.person(pg_temp.u('a1'), 'alice'));
  foreach t in array array['d1', 'e1', 'f1', 'c2', 'c3'] loop
    perform pg_temp.put('acct_' || t, t13.person(pg_temp.u(t), 'p' || t));
  end loop;
  perform pg_temp.put('acct_z', t13.person(pg_temp.u('f9'), 'zed'));
  -- B: registered, an ADMIN of A's workspace (added after A connected: PR #124 refuses a shared workspace).
  perform t13.login(pg_temp.u('b1'));
  perform t13.check(t13.register(pg_temp.u('b1')) = 'active', 'B registered');
  insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace(pg_temp.u('a1')), pg_temp.u('b1'), 'admin');
  -- C: a login that never registered POSTONA.
  perform t13.login(pg_temp.u('c1'));
end $$;

-- ---- ACL: no API role reaches a lifecycle decision or the new fence ------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['select private.account_lifecycle_assert_brand_service_active(''x'', ''x_autopost'')',
                           'select private.account_lifecycle_service_state_refusal(gen_random_uuid(), ''x_autopost'')',
                           'select private.account_lifecycle_assert_active_service_write(gen_random_uuid(), ''x_autopost'')',
                           'select public.threads_manual_publish_owner_fence(''x'')',
                           'select public.threads_manual_publish_authorize(gen_random_uuid(), ''x'', true)',
                           'select public.cleanup_threads_provider_footprint(gen_random_uuid())',
                           'select * from public.begin_social_mobile_threads_oauth_connection(''x'', ''x'', now())'] loop
    perform t13.check(t13.try_as('authenticated', f) = '42501', 'authenticated: ' || f);
    perform t13.check(t13.try_as('anon', f) = '42501', 'anon: ' || f);
  end loop;
end $$;

-- ---- OAuth begin: the REAL T13 refuses every state that is not an active POSTONA, before anything is written --
do $$
declare r text; s text; tag text; expect text; before bigint := (select count(*) from public.social_account_oauth_states);
begin
  -- A login with no common account at all, then the same person with Kabumori only (no POSTONA).
  r := pg_temp.oauth(pg_temp.u('c1'), pg_temp.begin_sql('c'));
  perform t13.check(r = '42501 ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'no common account: ' || r);
  perform t13.act(pg_temp.u('c1'));
  perform public.start_kabumori_service();
  perform t13.act(null);
  r := pg_temp.oauth(pg_temp.u('c1'), pg_temp.begin_sql('c'));
  perform t13.check(r = '42501 SERVICE_NOT_REGISTERED', 'Kabumori only, POSTONA never registered: ' || r);
  foreach s in array array['d1:suspended:SERVICE_NOT_ACTIVE', 'e1:ended:SERVICE_NOT_ACTIVE', 'f1:account_deleting:ACCOUNT_DELETION_IN_PROGRESS',
                           'c2:service_deleting:SERVICE_DELETION_IN_PROGRESS', 'c3:locked:ACCOUNT_LOCKED'] loop
    tag := split_part(s, ':', 1); expect := split_part(s, ':', 3);
    perform t13.state(pg_temp.u(tag), split_part(s, ':', 2));
    r := pg_temp.oauth(pg_temp.u(tag), pg_temp.begin_sql('re' || tag));
    perform t13.check(r = '42501 ' || expect, split_part(s, ':', 2) || ' (reconnect): ' || r);
    r := pg_temp.oauth(pg_temp.u(tag), format('select * from public.consume_social_mobile_threads_oauth_state(%L)', t13.h('re' || tag)));
    perform t13.check(r = '42501 ' || expect, split_part(s, ':', 2) || ' (consume): ' || r);
  end loop;
  perform t13.check((select count(*) from public.social_account_oauth_states) = before, 'no OAuth state was written');
end $$;
-- G's POSTONA deletion also moves its entitlement, as G5's begin does.
update public.service_entitlements set status = 'deleting' where user_id = pg_temp.u('c2');

-- ---- OAuth: stale / foreign sessions and the wrong role claim ------------------------------------------------
do $$
declare j uuid := pg_temp.u('a9'); r text;
begin
  perform t13.login(j);
  perform t13.check(t13.register(j) = 'active', 'J registered');
  update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id = t13.session_of(j);
  r := pg_temp.oauth(j, pg_temp.begin_sql('j1'));
  perform t13.check(r = '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'expired session: ' || r);
  update auth.sessions set not_after = null where id = t13.session_of(j);
  r := pg_temp.oauth(j, pg_temp.begin_sql('j2'), t13.session_of(pg_temp.u('a1')));
  perform t13.check(r = '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'someone else''s session: ' || r);
  r := pg_temp.oauth(j, pg_temp.begin_sql('j3'), null, 'anon');
  perform t13.check(r = '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'anon claim: ' || r);
  delete from auth.sessions where id = t13.session_of(j);
  r := pg_temp.oauth(j, pg_temp.begin_sql('j4'));
  perform t13.check(r = '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'signed out: ' || r);
  perform t13.check(pg_temp.verified(j) = 0, 'nothing connected');
end $$;

-- ---- OAuth begin vs completion: a lifecycle change between them stops the credential write ---------------------
do $$
declare i uuid := pg_temp.u('a8'); st uuid; r text; secrets bigint;
begin
  perform t13.login(i);
  perform t13.check(t13.register(i) = 'active', 'I registered');
  st := t13.begin_oauth(i, 'ione');
  perform pg_temp.put('state_i', st::text);
  perform t13.state(i, 'suspended');
  secrets := (select count(*) from vault.secrets);
  r := pg_temp.oauth(i, format('select t13.complete_oauth(%L, %L, %L)', i, st, 'ione'));
  perform t13.check(r = '42501 SERVICE_NOT_ACTIVE', 'suspended before completion: ' || r);
  perform t13.check(pg_temp.verified(i) = 0 and (select count(*) from vault.secrets) = secrets, 'no credential, no verified identity');
  perform t13.check((select consumed_at from public.social_account_oauth_states where id = st) is null, 'the state was not spent');
end $$;
do $$
declare i uuid := pg_temp.u('a8'); k uuid := pg_temp.u('a7'); st uuid := pg_temp.get('state_i')::uuid; r text;
begin
  -- Another active person cannot complete I's state.
  perform t13.login(k);
  perform t13.check(t13.register(k) = 'active', 'K registered');
  r := pg_temp.oauth(k, format('select t13.complete_oauth(%L, %L, %L)', k, st, 'kone'));
  perform t13.check(r like 'P0001 THREADS_%', 'another person: ' || r);
  -- A duplicate begin of the same state is refused.
  r := pg_temp.oauth(k, pg_temp.begin_sql('kdup'));
  perform t13.check(r = 'OK', 'K begin: ' || r);
  r := pg_temp.oauth(k, pg_temp.begin_sql('kdup'));
  perform t13.check(r = 'P0001 THREADS_OAUTH_STATE_INPUT_INVALID', 'duplicate state: ' || r);
  -- Vault refuses the credential: the whole completion fails, nothing written, the state not spent.
  perform t13.state(i, 'active');
  r := pg_temp.oauth(i, format('select t13.complete_oauth(%L, %L, %L, %L)', i, st, 'ione', 'fakeFAILVAULT_0123456789abcdef'));
  perform t13.check(r like '% VAULT_UNAVAILABLE', 'Vault error: ' || r);
  perform t13.check(pg_temp.verified(i) = 0 and (select consumed_at from public.social_account_oauth_states where id = st) is null, 'Vault error wrote nothing');
  -- Active again: the same state completes once (it was the guard that refused, not the state).
  r := pg_temp.oauth(i, format('select t13.complete_oauth(%L, %L, %L)', i, st, 'ione'));
  perform t13.check(r = 'OK' and pg_temp.verified(i) = 1, 'completed once active: ' || r);
  r := pg_temp.oauth(i, format('select t13.complete_oauth(%L, %L, %L)', i, st, 'ione'));
  perform t13.check(r = 'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'no second completion: ' || r);
end $$;

-- ---- Publish: the CALLER (T13) and the WORKSPACE OWNER (F5, new) must both be active -------------------------
do $$
declare a uuid := pg_temp.u('a1'); b uuid := pg_temp.u('b1'); acct text := pg_temp.get('acct_a'); att uuid; r jsonb; g text;
begin
  -- Both active: the admin can publish (reserve -> release hands the step out), then settles it.
  r := t13.as_user(b, 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '管理者の投稿');
  perform t13.check(r->>'status' = 'reserved', 'both active: reserved: ' || r::text);
  att := (r->'attempt'->>'attempt_id')::uuid;
  r := t13.release(b, att, 'create_container');
  perform t13.check(r->>'status' = 'released', 'both active: released: ' || r::text);
  g := r->>'grant';
  -- The owner's POSTONA ends while the step is out: the facts are still recorded (no lifecycle refusal).
  perform t13.state(a, 'ended');
  r := t13.record(b, att, 'create_container', g, 'failed', 'THREADS_UNAVAILABLE');
  perform t13.check(r->>'status' = 'recorded', 'facts recorded after the owner ended: ' || r::text);
  perform t13.state(a, 'active');
end $$;

do $$
declare a uuid := pg_temp.u('a1'); b uuid := pg_temp.u('b1'); acct text := pg_temp.get('acct_a'); r jsonb; s text; n int := 0;
        attempts bigint := (select count(*) from public.threads_manual_publish_attempts where social_account_id = pg_temp.get('acct_a'));
begin
  foreach s in array array['suspended:SERVICE_NOT_ACTIVE', 'ended:SERVICE_NOT_ACTIVE', 'service_deleting:ACCOUNT_LIFECYCLE_BLOCKED',
                           'account_deleting:ACCOUNT_LIFECYCLE_BLOCKED', 'locked:ACCOUNT_LIFECYCLE_BLOCKED'] loop
    n := n + 1;
    perform t13.state(a, split_part(s, ':', 1));
    r := t13.as_user(b, 'begin', acct, format('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab%s', lpad(n::text, 2, '0')), '止まるべき投稿');
    perform t13.check(r = jsonb_build_object('status', 'refused', 'code', split_part(s, ':', 2)), 'owner ' || split_part(s, ':', 1) || ' (admin begin): ' || r::text);
    perform t13.state(a, 'active');
  end loop;
  perform t13.check((select count(*) from public.threads_manual_publish_attempts where social_account_id = acct) = attempts, 'no attempt was reserved');
  -- The caller's own POSTONA still matters (T13): an active owner does not cover a suspended admin.
  perform t13.state(b, 'suspended');
  r := t13.as_user(b, 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac01', 'x');
  perform t13.check(r->>'code' = 'SERVICE_NOT_ACTIVE', 'caller suspended: ' || r::text);
  perform t13.state(b, 'active');
  -- An ambiguous owner (two owner memberships) is a refusal, never a guess.
  update public.brand_memberships set role = 'owner' where brand_id = public.social_mobile_account_deletion_workspace(a) and user_id = b;
  r := t13.as_user(b, 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac02', 'x');
  perform t13.check(r->>'code' = 'WORKSPACE_INACTIVE', 'two owners: ' || r::text);
  update public.brand_memberships set role = 'admin' where brand_id = public.social_mobile_account_deletion_workspace(a) and user_id = b;
  -- A non-member is refused (and never asks the owner's lifecycle; see the runner's queue race).
  r := t13.as_user(pg_temp.u('f9'), 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac03', 'x');
  perform t13.check(r->>'code' = 'ACCOUNT_NOT_FOUND', 'non-member: ' || r::text);
  -- The owner's own POSTONA ended: the owner cannot publish either (T13 and F5 agree).
  perform t13.state(a, 'ended');
  r := t13.as_user(a, 'begin', acct, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac04', 'x');
  perform t13.check(r->>'code' = 'SERVICE_NOT_ACTIVE', 'owner ended: ' || r::text);
  perform t13.state(a, 'active');
end $$;

do $$
declare a uuid := pg_temp.u('a1'); b uuid := pg_temp.u('b1'); acct text := pg_temp.get('acct_a'); r jsonb;
begin
  -- Withdrawing stays possible while the owner is suspended; enabling does not.
  perform t13.state(a, 'suspended');
  r := t13.as_user(b, 'permission', acct, 'false', 'true');
  perform t13.check(r = '{"status": "updated", "permitted": false}', 'withdraw while the owner is suspended: ' || r::text);
  r := t13.as_user(b, 'permission', acct, 'true', 'false');
  perform t13.check(r->>'code' = 'SERVICE_NOT_ACTIVE', 'enable while the owner is suspended: ' || r::text);
  perform t13.check(not exists (select 1 from public.social_account_manual_publish_permissions where social_account_id = acct), 'still off');
  perform t13.state(a, 'active');
  r := t13.as_user(b, 'permission', acct, 'true', 'false');
  perform t13.check(r = '{"status": "updated", "permitted": true}', 'enable once the owner is active: ' || r::text);
end $$;

-- ---- Disconnect: the removal policy on the REAL G5 decision ---------------------------------------------------
create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as $$ select true $$;
do $$
declare r jsonb; s text;
begin
  -- D suspended, E ended: they can still remove their Threads credential.
  foreach s in array array['d1', 'e1'] loop
    r := t13.as_user(pg_temp.u(s), 'disconnect', pg_temp.get('acct_' || s), 'p' || s);
    perform t13.check(r->>'status' = 'disconnected' and r->>'local_credentials' = 'removed', s || ' removes: ' || r::text);
    perform t13.check(public.threads_provider_connection_state(pg_temp.u(s)) = 'not_connected', s || ' nothing left');
  end loop;
  -- F (account deletion), G (POSTONA deletion), H (locked): G5's flow owns it / nothing changes.
  foreach s in array array['f1', 'c2', 'c3'] loop
    r := t13.as_user(pg_temp.u(s), 'disconnect', pg_temp.get('acct_' || s), 'p' || s);
    perform t13.check(r = '{"code": "ACCOUNT_LIFECYCLE_BLOCKED", "status": "refused"}', s || ' refused: ' || r::text);
    perform t13.check(public.threads_provider_connection_state(pg_temp.u(s)) = 'connected', s || ' untouched');
  end loop;
end $$;

-- ---- The deletion cleanup is lawful although the service is no longer active -----------------------------------
do $$
declare r jsonb;
begin
  -- F: the account deletion's owner holds its lease; G: ending POSTONA (entitlement 'deleting').
  update private.account_lifecycle_operations set owner_lease = gen_random_uuid(), owner_lease_expires_at = clock_timestamp() + interval '10 minutes'
   where user_id = pg_temp.u('f1') and operation_type = 'account_deletion' and status = 'in_progress';
  r := public.cleanup_threads_provider_footprint(pg_temp.u('f1'));
  perform t13.check(r = '{"code": "LOCAL_REMOVED", "outcome": "local_removed_remote_unverified"}', 'account deletion cleanup: ' || r::text);
  -- G: ending POSTONA needs its owner's live lease too (F4 live-lease fix): unclaimed -> nothing removed; claimed
  -- through F5's own claim_service_deletion (the real Phase 6) -> removed.
  r := public.cleanup_threads_provider_footprint(pg_temp.u('c2'));
  perform t13.check(r = '{"code": "DELETION_NOT_IN_PROGRESS", "outcome": "blocked"}', 'POSTONA deletion, unclaimed: ' || r::text);
  perform t13.check(public.threads_provider_connection_state(pg_temp.u('c2')) = 'connected', 'nothing removed before the claim');
  r := public.claim_service_deletion(pg_temp.u('c2'), 'x_autopost',
         (select o.id from private.account_lifecycle_operations o
           where o.user_id = pg_temp.u('c2') and o.operation_type = 'service_deletion' and o.status = 'in_progress'));
  perform t13.check(r->>'status' = 'acquired', 'POSTONA deletion claimed: ' || r::text);
  r := public.cleanup_threads_provider_footprint(pg_temp.u('c2'));
  perform t13.check(r = '{"code": "LOCAL_REMOVED", "outcome": "local_removed_remote_unverified"}', 'POSTONA deletion cleanup: ' || r::text);
  -- H is only locked (no deletion): the cleanup does nothing.
  r := public.cleanup_threads_provider_footprint(pg_temp.u('c3'));
  perform t13.check(r->>'outcome' = 'blocked', 'locked, no deletion: ' || r::text);
  -- A is untouched by all of the above.
  perform t13.check(public.threads_provider_connection_state(pg_temp.u('a1')) = 'connected', 'A untouched');
end $$;

select 'T13_BEHAVIOR_OK';
