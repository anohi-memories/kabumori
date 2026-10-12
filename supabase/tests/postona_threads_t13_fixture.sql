-- Fake-only test support for supabase/tests/postona_threads_t13_run.sh (F4,
-- postona-f4-threads-t13-authenticated-writer-integration-20261013). Applied on the REAL G5 world (Phase 1,
-- Phase 2, Phase 3a, the Phase 3b writer guard (T13), Phase 4 and F5's workspace service state, all real
-- migrations), after PR #124's OAuth candidate and test fixture and the G4 publish stack. Nothing here
-- stands in for G5: the lifecycle state is changed the way G5's own rows hold it. Disposable local database
-- only; every value is fake.
set timezone = 'UTC';

-- The publish attestation key (fake; the publish Edge would hold the same one).
insert into vault.secrets (name, secret) values ('postona_threads_publish_attestation_v1', 'fake_publish_attestation_key_0123456789abcdef0123');

create schema t13;

create function t13.session_of(p_user uuid) returns uuid language sql immutable
as $$ select md5('session:' || p_user::text)::uuid $$;
create function t13.h(p_tag text) returns text language sql immutable
as $$ select encode(sha256(convert_to('state:' || p_tag, 'UTF8')), 'hex') $$;
create function t13.puid(p_tag text) returns text language sql immutable
as $$ select '178414' || lpad((abs(hashtext(p_tag)) % 100000000)::text, 8, '0') $$;

-- A login with a live session (what G5's guard reads).
create function t13.login(p_user uuid) returns void language plpgsql as $$
begin
  perform public.fixture_login(p_user);
  insert into auth.sessions (id, user_id) values (t13.session_of(p_user), p_user) on conflict (id) do nothing;
end $$;

-- The JWT claims as PostgREST sets them (auth.uid() and G5's guard read the per-claim settings first).
create function t13.act(p_user uuid, p_session uuid default null, p_claim_role text default 'authenticated') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then '' else coalesce(p_claim_role, '') end, true);
  perform set_config('request.jwt.claim.session_id', coalesce(coalesce(p_session, t13.session_of(p_user))::text, ''), true);
end $$;

-- POSTONA registration through G5's own public start (the person's call).
create function t13.register(p_user uuid) returns text language plpgsql as $$
declare v jsonb;
begin
  perform t13.act(p_user);
  set local role authenticated;
  v := public.start_x_autopost_service();
  reset role;
  perform t13.act(null);
  return v ->> 'status';
end $$;

-- G5's lifecycle state of a person, as G5's rows hold it.
create function t13.state(p_user uuid, p_state text) returns void language plpgsql as $$
begin
  case p_state
    when 'active' then
      delete from private.account_lifecycle_operations o where o.user_id = p_user and o.status = 'in_progress';
      update public.common_accounts set status = 'active' where user_id = p_user and status <> 'active';
      update public.service_entitlements set status = 'active', ended_at = null
       where user_id = p_user and service_key = 'x_autopost' and status <> 'active';
    when 'suspended' then
      update public.service_entitlements set status = 'suspended' where user_id = p_user and service_key = 'x_autopost';
    when 'ended' then
      update public.service_entitlements set status = 'ended', ended_at = now() where user_id = p_user and service_key = 'x_autopost';
    when 'locked' then
      update public.common_accounts set status = 'locked' where user_id = p_user;
    when 'account_deleting' then
      insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type)
      values (p_user, encode(sha256(convert_to(p_user::text, 'UTF8')), 'hex'), 'account_deletion');
    when 'service_deleting' then
      insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type, service_key)
      values (p_user, encode(sha256(convert_to(p_user::text, 'UTF8')), 'hex'), 'service_deletion', 'x_autopost');
  end case;
end $$;

-- One statement with a person's claims, as the given DB role ('owner' = the owner channel H5 uses for
-- PR #124's functions; 'authenticated' = the Data API). 'OK' or '<SQLSTATE> <message>'.
create function t13.call(p_user uuid, p_sql text, p_role text default 'authenticated', p_session uuid default null,
                         p_claim_role text default 'authenticated') returns text language plpgsql as $$
declare v_msg text; v_state text;
begin
  perform t13.act(p_user, p_session, p_claim_role);
  begin
    if p_role <> 'owner' then execute format('set local role %I', p_role); end if;
    execute p_sql;
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    reset role;
  end;
  perform t13.act(null);
  return coalesce(v_state || ' ' || v_msg, 'OK');
end $$;

-- PR #124's code-exchange attestation, computed independently with the fake connect key.
create function t13.attest(p_state uuid, p_puid text, p_handle text, p_token text) returns text language sql immutable
as $$
  select encode(extensions.hmac(
    convert_to(concat_ws(chr(10), 'postona-threads-connect-v1', p_state::text, p_puid, coalesce(p_handle, ''),
                         encode(sha256(convert_to(p_token, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_attestation_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex')
$$;

-- begin + consume (the owner channel, the person's claims): the oauth state id.
create function t13.begin_oauth(p_user uuid, p_tag text) returns uuid language plpgsql as $$
declare v_state uuid;
begin
  perform t13.act(p_user);
  perform * from public.begin_social_mobile_threads_oauth_connection(t13.h(p_tag), 'https://postona.example/threads/callback', now() + interval '9 minutes');
  select c.oauth_state_id into v_state from public.consume_social_mobile_threads_oauth_state(t13.h(p_tag)) c;
  perform t13.act(null);
  return v_state;
end $$;

-- complete + custody in ONE transaction (as H5's owner transport does): the Threads account id.
create function t13.complete_oauth(p_user uuid, p_state uuid, p_tag text, p_token text default null) returns text
language plpgsql as $$
declare v_token text := coalesce(p_token, 'fake_threads_' || p_tag || '_TOKEN_0123456789'); v_account text;
begin
  perform t13.act(p_user);
  perform public.complete_social_mobile_threads_oauth_connection(p_state, t13.puid(p_tag), p_tag, v_token,
                                                                 t13.attest(p_state, t13.puid(p_tag), p_tag, v_token));
  select a.id into v_account from public.social_accounts a
   where a.brand_id = public.social_mobile_account_deletion_workspace(p_user) and a.platform = 'threads';
  perform public.record_threads_credential_custody(v_account, now() + interval '50 days');
  perform t13.act(null);
  return v_account;
end $$;

-- A registered person with a verified Threads connection and manual publishing ON.
create function t13.person(p_user uuid, p_tag text) returns text language plpgsql as $$
declare v_account text;
begin
  perform t13.login(p_user);
  if t13.register(p_user) is distinct from 'active' then raise exception 'FIXTURE_REGISTER_FAILED'; end if;
  v_account := t13.complete_oauth(p_user, t13.begin_oauth(p_user, p_tag), p_tag);
  if t13.as_user(p_user, 'permission', v_account, 'true', 'false') ->> 'permitted' is distinct from 'true' then
    raise exception 'FIXTURE_PERMISSION_FAILED';
  end if;
  return v_account;
end $$;

-- The publish caller functions, as the person through the Data API (role authenticated).
create function t13.as_user(p_user uuid, p_call text, variadic p_args text[] default '{}') returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  perform t13.act(p_user);
  set local role authenticated;
  case p_call
    when 'permission' then v_out := public.set_threads_manual_publish_permission(p_args[1], p_args[2]::boolean, p_args[3]::boolean);
    when 'begin' then v_out := public.begin_threads_manual_publish(p_args[1], p_args[2]::uuid, p_args[3]);
    when 'disconnect' then v_out := public.disconnect_threads_account(p_args[1], p_args[2]);
  end case;
  reset role;
  perform t13.act(null);
  return v_out;
end $$;

-- A begin by p_user and how long it took: '<code or status> <took less than one second>'.
create function t13.timed_begin(p_user uuid, p_account text, p_key uuid) returns text language plpgsql as $$
declare v_t0 timestamptz := clock_timestamp(); v_out jsonb;
begin
  v_out := t13.as_user(p_user, 'begin', p_account, p_key::text, 'timed');
  return coalesce(v_out ->> 'code', v_out ->> 'status') || ' ' || (clock_timestamp() - v_t0 < interval '1 second')::text;
end $$;

-- The publish server's attested release / record, computed independently with the fake publish key.
create function t13.hmac(p_message text) returns text language sql immutable as $$
  select encode(extensions.hmac(convert_to(p_message, 'UTF8'), convert_to('fake_publish_attestation_key_0123456789abcdef0123', 'UTF8'), 'sha256'), 'hex') $$;
create function t13.nonce() returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') $$;
create function t13.release(p_user uuid, p_attempt uuid, p_step text) returns jsonb language plpgsql as $$
declare v_issued bigint := extract(epoch from clock_timestamp())::bigint; v_nonce text := t13.nonce(); v_out jsonb; v_att text;
begin
  -- The attestation is the server's, computed before acting as the person.
  v_att := t13.hmac(concat_ws(chr(10), 'postona-threads-publish-release-v1', p_user::text, p_attempt::text, p_step, v_issued::text, v_nonce));
  perform t13.act(p_user);
  set local role authenticated;
  v_out := public.release_threads_manual_publish_step(p_attempt, p_step, v_issued, v_nonce, v_att);
  reset role;
  perform t13.act(null);
  return v_out;
end $$;
create function t13.record(p_user uuid, p_attempt uuid, p_step text, p_grant text, p_to text, p_error text) returns jsonb
language plpgsql as $$
declare v_issued bigint := extract(epoch from clock_timestamp())::bigint; v_nonce text := t13.nonce(); v_out jsonb; v_att text;
begin
  v_att := t13.hmac(concat_ws(chr(10), 'postona-threads-publish-record-v1', p_user::text, p_attempt::text, p_step, p_grant, p_to,
                              '', '', '', coalesce(p_error, ''), v_issued::text, v_nonce));
  perform t13.act(p_user);
  set local role authenticated;
  v_out := public.record_threads_manual_publish_result(p_attempt, p_step, p_grant, p_to, null, null, null, p_error, v_issued, v_nonce, v_att);
  reset role;
  perform t13.act(null);
  return v_out;
end $$;

-- 'ok' or the SQLSTATE a role gets.
create function t13.try_as(p_role text, p_sql text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
  exception when others then
    reset role;
    return sqlstate;
  end;
  reset role;
  return 'ok';
end $$;

create function t13.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL %', p_label; end if;
end $$;
