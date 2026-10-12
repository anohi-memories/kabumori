-- Behavior proof for supabase/candidates/postona_threads_disconnect/threads_disconnect_candidate.sql, run by
-- postona_threads_disconnect_run.sh as the table owner on the G4 publish world (release fixture + custody ->
-- manual publish -> release) with the stand-in of G5's lifecycle table and the Threads cleanup candidate.
-- The person calls exactly as the Data API would (JWT claims sub / role / session_id, role authenticated).
-- Each DO block is one transaction. Fake data only.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create temp table ctx (k text primary key, v text);
create function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into ctx values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.get(p_k text) returns text language sql as $$ select v from ctx where k = p_k $$;
create function pg_temp.footprint(p_account text) returns text language sql as $$
  select concat_ws('|',
    (select count(*) from public.social_accounts where id = p_account),
    (select count(*) from public.social_account_manual_publish_permissions where social_account_id = p_account),
    (select count(*) from public.threads_manual_publish_attempts where social_account_id = p_account),
    (select count(*) from public.threads_manual_publish_nonces n join public.threads_manual_publish_attempts t on t.id = n.attempt_id where t.social_account_id = p_account),
    (select count(*) from public.threads_account_credential_custody where social_account_id = p_account),
    (select count(*) from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = p_account)) $$;
-- Everything that is NOT this feature's to touch, as one value: X rows and their secrets, workspaces,
-- memberships, the POSTONA registration stand-in.
create function pg_temp.untouchable() returns text language sql as $$
  select md5(concat_ws('#',
    (select string_agg(to_jsonb(s)::text, ',' order by s.id) from public.social_accounts s where s.platform = 'x'),
    (select string_agg(v.id::text || v.secret, ',' order by v.id) from vault.secrets v
      where v.id in (select vault_access_token_secret_id from public.social_accounts where platform = 'x'
                     union select vault_refresh_token_secret_id from public.social_accounts where platform = 'x')),
    (select string_agg(b.id, ',' order by b.id) from public.brands b),
    (select string_agg(m.brand_id || m.user_id::text || m.role, ',' order by m.brand_id, m.user_id) from public.brand_memberships m),
    (select string_agg(l.user_id::text || l.state, ',' order by l.user_id) from postona_rel.lifecycle l))) $$;
-- The person's call, as the Data API would make it.
create function pg_temp.disc(p_user uuid, p_account text, p_handle text, p_session uuid default null) returns jsonb
language plpgsql as $$
declare v_out jsonb;
begin
  perform postona_rel.act(p_user, p_session);
  set local role authenticated;
  v_out := public.disconnect_threads_account(p_account, p_handle);
  reset role;
  perform postona_rel.act(null);
  return v_out;
end $$;
create function pg_temp.refused(p_code text) returns jsonb language sql as $$
  select jsonb_build_object('status', 'refused', 'code', p_code) $$;

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
  acct_a := postona_rel.connect_threads(a, brand_a, 'alice');
  acct_b := postona_rel.connect_threads(b, brand_b, 'bob');
  perform postona_rel.as_user(a, 'permission', acct_a, 'true', 'false');
  perform postona_rel.as_user(b, 'permission', acct_b, 'true', 'false');
  -- A finished post for a (attempt + nonces), so the cascade has something to remove.
  att := postona_rel.as_user(a, 'begin', acct_a, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '公開済みの投稿')->'attempt'->>'attempt_id';
  r := postona_rel.release(a, att::uuid, 'create_container'); g := r->>'grant';
  perform postona_rel.record(a, att::uuid, 'create_container', g, 'failed', p_error => 'THREADS_UNAVAILABLE');
  perform pg_temp.put('acct_a', acct_a); perform pg_temp.put('acct_b', acct_b);
  perform pg_temp.put('brand_a', brand_a); perform pg_temp.put('brand_b', brand_b);
  perform pg_temp.put('secret_a', (select vault_access_token_secret_id::text from public.social_accounts where id = acct_a));
end $$;

-- ---- Access: the person only (authenticated); the deletion cleanup is NOT loosened ------------------------
do $$
begin
  perform postona_rel.check(postona_rel.try_as('anon', 'select public.disconnect_threads_account(''sa_th_alice'', ''alice'')') = '42501', 'anon cannot call');
  perform postona_rel.check(postona_rel.try_as('service_role', 'select public.disconnect_threads_account(''sa_th_alice'', ''alice'')') = '42501', 'service_role cannot call');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select public.cleanup_threads_provider_footprint(gen_random_uuid())') = '42501', 'the person still cannot run the deletion cleanup');
  perform postona_rel.check(postona_rel.try_as('authenticated', 'select public.threads_disconnect_gate_open()') = '42501', 'the gate is not callable');
end $$;

-- ---- The release gate ships CLOSED: nothing is locked, read or changed ---------------------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; before text := pg_temp.footprint(pg_temp.get('acct_a'));
        calls bigint := (select count(*) from postona_rel.fence_calls); r jsonb;
begin
  r := pg_temp.disc(a, pg_temp.get('acct_a'), 'alice');
  perform postona_rel.check(r = pg_temp.refused('DISCONNECT_DISABLED'), 'gate closed: ' || r::text);
  perform postona_rel.check((select count(*) from postona_rel.fence_calls) = calls, 'not even the fence ran');
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_a')) = before, 'nothing changed');
  perform postona_rel.check(public.threads_disconnect_gate_open() = false, 'the shipped gate is false');
end $$;

-- From here on: the gate opened by a reviewed replacement (owner only), as a release would do.
create or replace function public.threads_disconnect_gate_open() returns boolean
language sql immutable set search_path = '' as $$ select true $$;

-- ---- Who may call: a signed-in person on a live session ------------------------------------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text := pg_temp.get('acct_a'); before text := pg_temp.footprint(acct); r jsonb;
begin
  r := pg_temp.disc(null, acct, 'alice');
  perform postona_rel.check(r = pg_temp.refused('AUTH_REQUIRED'), 'no caller: ' || r::text);
  -- A session that never existed, one that expired, one that was signed out (deleted).
  r := pg_temp.disc(a, acct, 'alice', gen_random_uuid());
  perform postona_rel.check(r = pg_temp.refused('AUTH_REQUIRED'), 'unknown session: ' || r::text);
  update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id = postona_rel.session_of(a);
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = pg_temp.refused('AUTH_REQUIRED'), 'expired session: ' || r::text);
  update auth.sessions set not_after = null where id = postona_rel.session_of(a);
  -- Another person's session id with this person's user id.
  r := pg_temp.disc(a, acct, 'alice', postona_rel.session_of('00000000-0000-4000-8000-0000000000b1'));
  perform postona_rel.check(r = pg_temp.refused('AUTH_REQUIRED'), 'someone else''s session: ' || r::text);
  perform postona_rel.check(pg_temp.footprint(acct) = before, 'nothing changed');
end $$;

do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text := pg_temp.get('acct_a'); r jsonb;
begin
  foreach r in array array[pg_temp.disc(a, 'SA_BAD', 'alice'), pg_temp.disc(a, acct, ''), pg_temp.disc(a, acct, 'al ice'),
                           pg_temp.disc(a, acct, repeat('a', 65)), pg_temp.disc(a, null, 'alice'), pg_temp.disc(a, acct, null)] loop
    perform postona_rel.check(r = pg_temp.refused('REQUEST_INVALID'), 'invalid request: ' || r::text);
  end loop;
end $$;

-- ---- POSTONA must be active and no deletion of this person may be running (G5 owns that removal) -----------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text := pg_temp.get('acct_a'); before text := pg_temp.footprint(acct); r jsonb; s text;
begin
  foreach s in array array['not_registered', 'ended'] loop
    update postona_rel.lifecycle set state = s where user_id = a;
    r := pg_temp.disc(a, acct, 'alice');
    perform postona_rel.check(r = pg_temp.refused('SERVICE_NOT_ACTIVE'), s || ': ' || r::text);
  end loop;
  foreach s in array array['deleting', 'locked'] loop
    update postona_rel.lifecycle set state = s where user_id = a;
    r := pg_temp.disc(a, acct, 'alice');
    perform postona_rel.check(r = pg_temp.refused('ACCOUNT_LIFECYCLE_BLOCKED'), s || ': ' || r::text);
  end loop;
  update postona_rel.lifecycle set state = 'active' where user_id = a;
  -- G5's table: an account deletion (with or without a lease), or ending POSTONA, is in progress.
  insert into private.account_lifecycle_operations (user_id, operation_type, status, current_step, owner_lease, owner_lease_expires_at)
  values (a, 'account_deletion', 'in_progress', 'cleanup', gen_random_uuid(), clock_timestamp() + interval '10 minutes');
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_LIFECYCLE_BLOCKED'), 'account deletion running: ' || r::text);
  update private.account_lifecycle_operations set owner_lease = null, owner_lease_expires_at = null, current_step = 'ready_for_managed_auth_delete' where user_id = a;
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_LIFECYCLE_BLOCKED'), 'account deletion past cleanup, unowned: ' || r::text);
  delete from private.account_lifecycle_operations where user_id = a;
  insert into private.account_lifecycle_operations (user_id, operation_type, service_key) values (a, 'service_deletion', 'x_autopost');
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_LIFECYCLE_BLOCKED'), 'POSTONA ending: ' || r::text);
  -- Ending Kabumori does not concern POSTONA: the call gets past the lifecycle (stopped here by a stale handle).
  update private.account_lifecycle_operations set service_key = 'kabumori' where user_id = a;
  r := pg_temp.disc(a, acct, 'someone_else');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_CHANGED'), 'Kabumori ending is not a blocker: ' || r::text);
  update private.account_lifecycle_operations set status = 'completed' where user_id = a;
  delete from private.account_lifecycle_operations where user_id = a;
  perform postona_rel.check(pg_temp.footprint(acct) = before, 'nothing changed');
end $$;

-- ---- Only the caller's OWN workspace and Threads account, as confirmed on screen -----------------------------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000b1';
  acct text := pg_temp.get('acct_a'); before text := pg_temp.footprint(acct); b_before text := pg_temp.footprint(pg_temp.get('acct_b')); r jsonb;
begin
  -- b's Threads account, even with a made an admin of b's workspace.
  r := pg_temp.disc(a, pg_temp.get('acct_b'), 'bob');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_NOT_FOUND'), 'another person''s account: ' || r::text);
  insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.get('brand_b'), a, 'admin');
  r := pg_temp.disc(a, pg_temp.get('acct_b'), 'bob');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_NOT_FOUND'), 'admin of another workspace: ' || r::text);
  delete from public.brand_memberships where brand_id = pg_temp.get('brand_b') and user_id = a;
  -- An X account id of their own.
  r := pg_temp.disc(a, 'sa_xa', 'xa');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_NOT_FOUND'), 'own X account: ' || r::text);
  -- The handle the person confirmed is not the connected one any more (reconnected in between).
  r := pg_temp.disc(a, acct, 'mallory');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_CHANGED'), 'stale confirmation: ' || r::text);
  r := pg_temp.disc(a, acct, '@mallory');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_CHANGED'), 'stale confirmation with @: ' || r::text);
  -- Not owner / admin of their own workspace; a workspace that is not self-service.
  update public.brand_memberships set role = 'member' where brand_id = pg_temp.get('brand_a') and user_id = a;
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = pg_temp.refused('DISCONNECT_FORBIDDEN'), 'member: ' || r::text);
  update public.brand_memberships set role = 'owner' where brand_id = pg_temp.get('brand_a') and user_id = a;
  update public.brands set code_profile_key = 'kabumori_operator' where id = pg_temp.get('brand_a');
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = pg_temp.refused('ACCOUNT_NOT_FOUND'), 'operator workspace: ' || r::text);
  update public.brands set code_profile_key = 'social_mobile_user_v1' where id = pg_temp.get('brand_a');
  perform postona_rel.check(pg_temp.footprint(acct) = before, 'nothing changed for a');
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_b')) = b_before, 'nothing changed for b');
end $$;

-- ---- A post that may be in flight: publishing stops, the credential stays for reconciliation ----------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text := pg_temp.get('acct_a'); att uuid; r jsonb;
begin
  att := (postona_rel.as_user(a, 'begin', acct, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '送信中かもしれない投稿')->'attempt'->>'attempt_id')::uuid;
  r := postona_rel.release(a, att, 'create_container');
  perform postona_rel.check(r->>'status' = 'released', 'a step was released: ' || r::text);
  perform pg_temp.put('inflight', att::text);
  r := pg_temp.disc(a, acct, '@alice');
  perform postona_rel.check(r = '{"code": "PUBLISH_IN_FLIGHT", "status": "stopped", "remote_access": "not_revoked_by_app", "local_credentials": "kept", "publish_permission": "withdrawn"}',
                            'in flight: ' || r::text);
  -- Kept: account, attempt, custody, secret. Gone: the permission.
  perform postona_rel.check(split_part(pg_temp.footprint(acct), '|', 1) = '1' and split_part(pg_temp.footprint(acct), '|', 2) = '0'
                            and split_part(pg_temp.footprint(acct), '|', 5) = '1' and split_part(pg_temp.footprint(acct), '|', 6) = '1',
                            'credential kept, permission gone: ' || pg_temp.footprint(acct));
end $$;

do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text := pg_temp.get('acct_a'); att uuid := pg_temp.get('inflight')::uuid; r jsonb; s text;
begin
  -- No new post can start; the reconciliation steps (which never need the permission) still can.
  r := postona_rel.as_user(a, 'begin', acct, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '新しい投稿');
  perform postona_rel.check(r->>'code' in ('MANUAL_PUBLISH_NOT_PERMITTED', 'ATTEMPT_OPEN'), 'no new post: ' || r::text);
  perform postona_rel.act(a);
  perform postona_rel.check(public.threads_manual_publish_authorize(a, acct, false) is null, 'reconciliation is still authorized');
  perform postona_rel.check(public.threads_manual_publish_authorize(a, acct, true) = 'MANUAL_PUBLISH_NOT_PERMITTED', 'publishing is not');
  perform postona_rel.act(null);
  foreach s in array array['publishing', 'publish_returned', 'uncertain'] loop
    update public.threads_manual_publish_attempts set status = s, container_id = '17890000000000001',
           provider_post_id = case when s = 'publish_returned' then '17890000000000003' end,
           error_code = case when s = 'uncertain' then 'PUBLISH_OUTCOME_UNKNOWN' end,
           grant_hash = null, grant_step = null, grant_state = null, grant_expires_at = null, grant_user_id = null, grant_session_id = null
     where id = att;
    r := pg_temp.disc(a, acct, 'alice');
    perform postona_rel.check(r = '{"code": "PUBLISH_IN_FLIGHT", "status": "stopped", "remote_access": "not_revoked_by_app", "local_credentials": "kept", "publish_permission": "already_off"}',
                              s || ': ' || r::text);
  end loop;
  perform postona_rel.check(split_part(pg_temp.footprint(acct), '|', 1) = '1', 'still connected while a post may exist');
  -- Reconciled (here: settled as not published).
  update public.threads_manual_publish_attempts set status = 'failed', error_code = 'CONTAINER_EXPIRED', provider_post_id = null where id = att;
end $$;

-- ---- A secret shared with another row is never deleted ------------------------------------------------------
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text := pg_temp.get('acct_a'); x_ref uuid; before text := pg_temp.footprint(acct); r jsonb;
begin
  select vault_access_token_secret_id into x_ref from public.social_accounts where id = 'sa_xa';
  update public.social_accounts set vault_access_token_secret_id = pg_temp.get('secret_a')::uuid where id = 'sa_xa';
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r->>'status' = 'stopped' and r->>'code' = 'SECRET_SHARED' and r->>'local_credentials' = 'kept', 'shared secret: ' || r::text);
  perform postona_rel.check(pg_temp.footprint(acct) = before, 'nothing removed');
  update public.social_accounts set vault_access_token_secret_id = x_ref where id = 'sa_xa';
end $$;

-- ---- Vault refuses the delete: only the removal block rolls back; publishing stays stopped ------------------
create function pg_temp.vault_refuses() returns trigger language plpgsql as $$
begin raise exception 'FAKE_VAULT_FAILURE'; end $$;
create trigger fake_vault_failure before delete on vault.secrets for each row execute function pg_temp.vault_refuses();
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text := pg_temp.get('acct_a'); before text := pg_temp.footprint(acct); r jsonb;
begin
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r->>'status' = 'stopped' and r->>'code' = 'DISCONNECT_FAILED' and r->>'local_credentials' = 'kept'
                            and r->>'remote_access' = 'not_revoked_by_app', 'vault failure: ' || r::text);
  perform postona_rel.check(pg_temp.footprint(acct) = before, 'the account, attempts, custody and secret are all still there');
end $$;
drop trigger fake_vault_failure on vault.secrets;

-- ---- The disconnect: this person's Threads only; X, POSTONA, the other person untouched; idempotent ---------
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  acct text := pg_temp.get('acct_a');
  v_secret uuid := pg_temp.get('secret_a')::uuid;
  b_before text := pg_temp.footprint(pg_temp.get('acct_b'));
  kept text := pg_temp.untouchable();
  r jsonb;
begin
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = '{"code": "LOCAL_REMOVED", "status": "disconnected", "remote_access": "not_revoked_by_app", "local_credentials": "removed", "publish_permission": "already_off"}',
                            'disconnected: ' || r::text);
  perform postona_rel.check(pg_temp.footprint(acct) = '0|0|0|0|0|0', 'no Threads row, permission, attempts, nonces or custody left: ' || pg_temp.footprint(acct));
  perform postona_rel.check(not exists (select 1 from vault.secrets s where s.id = v_secret), 'the Threads secret is gone');
  perform postona_rel.check(pg_temp.untouchable() = kept, 'X rows and secrets, workspaces, memberships and the POSTONA registration untouched');
  perform postona_rel.check(pg_temp.footprint(pg_temp.get('acct_b')) = b_before, 'the other person untouched');
  r := pg_temp.disc(a, acct, 'alice');
  perform postona_rel.check(r = '{"code": "ALREADY_REMOVED", "status": "not_connected", "remote_access": "not_revoked_by_app", "local_credentials": "none", "publish_permission": "already_off"}',
                            'twice: ' || r::text);
end $$;

-- ---- The person can connect Threads again afterwards; a fresh connection disconnects with its permission ----
do $$
declare a uuid := '00000000-0000-4000-8000-0000000000a1'; acct text; r jsonb;
begin
  acct := postona_rel.connect_threads(a, pg_temp.get('brand_a'), 'alice2');
  perform postona_rel.as_user(a, 'permission', acct, 'true', 'false');
  r := pg_temp.disc(a, acct, 'alice2');
  perform postona_rel.check(r->>'status' = 'disconnected' and r->>'publish_permission' = 'withdrawn', 'reconnected then disconnected: ' || r::text);
  perform postona_rel.check(public.threads_provider_connection_state(a) = 'not_connected', 'the deletion cleanup sees nothing left');
end $$;

select 'DISCONNECT_BEHAVIOR_OK';
