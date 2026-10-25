-- Shared helpers for the X OAuth T13 guard proof (fail_before.sql / behavior.sql). Disposable local DB only; fake data.
-- A person acts as role authenticated with JSON claims {sub, role, session_id} (as PostgREST sets them); the session
-- is a row of the fixture's auth.sessions (GoTrue shape).
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if; end $$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pg_temp.claims(p_sub uuid, p_session uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', case when p_sub is null then '' else
    -- is_anonymous false: Auth refused anonymous sign-ins before the Edge sets the claims (G3-34: G5's S2-2 requires the proven false)
    jsonb_strip_nulls(jsonb_build_object('sub', p_sub, 'role', 'authenticated', 'session_id', p_session, 'is_anonymous', false))::text end, true);
end $$;
-- One statement as `p_role` (default authenticated) for a person and session; returns its text or 'ERR:' || message.
create function pg_temp.as_person(p_sql text, p_sub uuid, p_session uuid, p_role text default 'authenticated') returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.claims(p_sub, p_session);
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  perform pg_temp.claims(null, null);
  return coalesce(v, '<null>');
exception when others then
  reset role;
  perform pg_temp.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function pg_temp.session(p_user uuid) returns uuid language sql as $$
  insert into auth.sessions (user_id) values (p_user) returning id $$;
-- A login with POSTONA x_autopost started through G5's real RPC, and a live session.
create function pg_temp.enrolled(p_n integer) returns uuid language plpgsql as $$
declare v_user uuid := pg_temp.uid(p_n); v_session uuid;
begin
  perform public.fixture_login(v_user);
  v_session := pg_temp.session(v_user);
  perform pg_temp.expect(pg_temp.as_person('select public.start_x_autopost_service() ->> ''status''', v_user, v_session) = 'active', 'setup: x_autopost ' || p_n);
  return v_user;
end $$;
create function pg_temp.state_hash(p_label text) returns text language sql immutable as $$
  select encode(sha256(convert_to('state:' || p_label, 'UTF8')), 'hex') $$;
create function pg_temp.begin_sql(p_label text) returns text language sql as $$
  select format('select social_account_id from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')',
                pg_temp.state_hash(p_label), 'kabumori://oauth/x') $$;
create function pg_temp.consume_sql(p_label text) returns text language sql as $$
  select format('select oauth_state_id::text from public.consume_social_mobile_x_oauth_state(%L)', pg_temp.state_hash(p_label)) $$;
create function pg_temp.complete_sql(p_state uuid, p_platform_user_id text) returns text language sql as $$
  select format('select public.complete_social_mobile_x_oauth_connection(%L::uuid, %L, %L, %L, %L)::text',
                p_state, p_platform_user_id, '@fake_' || p_platform_user_id, 'fake-access-' || p_platform_user_id, 'fake-refresh-' || p_platform_user_id) $$;
create function pg_temp.state_id(p_label text) returns uuid language sql as $$
  select id from public.social_account_oauth_states where state_hash = pg_temp.state_hash(p_label) $$;
create function pg_temp.footprint(p_user uuid) returns text language sql as $$
  select format('states=%s consumed=%s secrets=%s accounts=%s verified=%s',
    (select count(*) from public.social_account_oauth_states s where s.initiated_by_user_id = p_user),
    (select count(*) from public.social_account_oauth_states s where s.initiated_by_user_id = p_user and s.consumed_at is not null),
    (select count(*) from vault.secrets),
    (select count(*) from public.social_accounts a join public.brand_memberships m on m.brand_id = a.brand_id where m.user_id = p_user),
    (select count(*) from public.social_accounts a join public.brand_memberships m on m.brand_id = a.brand_id
      where m.user_id = p_user and a.connection_status = 'identity_verified')) $$;
create function pg_temp.end_service(p_user uuid) returns void language sql as $$
  update public.service_entitlements set status = 'ended', ended_at = now() where user_id = p_user and service_key = 'x_autopost' $$;
