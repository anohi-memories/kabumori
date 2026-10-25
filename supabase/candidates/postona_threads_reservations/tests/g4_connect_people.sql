-- People for postona_threads_g4_credential_run.sh (numbers 101-130), connected through G4's REAL connect path exactly as G4-11's
-- behavior proof drives it (postona_threads_credential_atomic_behavior.sql tc.enroll / tc.connect_all): enrol + start x_autopost,
-- PR #124 begin -> G4-09 (PR #367) record_state_generation -> PR #124 complete (fake token, fake HMAC attestation) -> PR #367
-- attest_binding -> G4 custody record. Each person ends with ONE real-shaped Threads account 'sa_<24 hex>' (identity_verified,
-- publish switch OFF as the real 2a-2 requires), a fake Vault token, a binding and a custody row. Then listed in G4's verified
-- predicate TEST DOUBLE. Owner channel with the person's JWT claims; every value is fake.
\set ON_ERROR_STOP 1
set timezone = 'UTC';
create schema g4c;
create function g4c.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function g4c.h(p_tag text) returns text language sql immutable as $$
  select encode(sha256(convert_to('state:' || p_tag, 'UTF8')), 'hex') $$;
create function g4c.claims(p_user uuid, p_session uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    jsonb_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_session, 'is_anonymous', false)::text end, true);
end $$;
create function g4c.session(p_user uuid) returns uuid language sql as $$
  select (select s.id from auth.sessions s where s.user_id = p_user and s.not_after is null order by s.created_at limit 1) $$;
create function g4c.as_person(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform g4c.claims(p_user, g4c.session(p_user));
  execute p_sql into v;
  perform g4c.claims(null, null);
  return coalesce(v, '<null>');
exception when others then
  perform g4c.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function g4c.attest(p_state uuid, p_puid text, p_handle text, p_token text) returns text language sql immutable as $$
  select encode(extensions.hmac(
    convert_to(concat_ws(chr(10), 'postona-threads-connect-v1', p_state::text, p_puid, coalesce(p_handle, ''),
                         encode(sha256(convert_to(p_token, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_attestation_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex') $$;
create function g4c.token(p_n integer) returns text language sql immutable as $$ select 'fakeTHREADSg3p' || p_n || '0123456789ab' $$;
create function g4c.connect(p_n integer) returns text language plpgsql as $$
declare v_user uuid := g4c.uid(p_n); v_account text; v_state uuid; v_puid text := (17841400000000000 + p_n)::text;
begin
  perform public.fixture_login(v_user);
  insert into auth.sessions (user_id) values (v_user);
  if g4c.as_person(v_user, 'select public.start_x_autopost_service() ->> ''status''') <> 'active' then
    raise exception 'SETUP enrol %', p_n;
  end if;
  v_account := g4c.as_person(v_user, format('select social_account_id from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''5 minutes'')',
                                            g4c.h('g3p' || p_n), 'https://app.postona.test/oauth/threads/callback'));
  if v_account like 'ERR:%' then raise exception 'SETUP begin %: %', p_n, v_account; end if;
  select s.id into v_state from public.social_account_oauth_states s where s.state_hash = g4c.h('g3p' || p_n);
  perform postona_threads_binding.record_state_generation(v_user, v_state,
    private.account_lifecycle_brand_owner_epoch(public.social_mobile_account_deletion_workspace(v_user)),
    (select a.lifecycle_version from public.common_accounts a where a.user_id = v_user));
  perform g4c.claims(v_user, g4c.session(v_user));
  perform public.complete_social_mobile_threads_oauth_connection(v_state, v_puid, 'h' || v_puid, g4c.token(p_n),
                                                                 g4c.attest(v_state, v_puid, 'h' || v_puid, g4c.token(p_n)));
  perform g4c.claims(null, null);
  perform postona_threads_binding.attest_binding(v_user, v_state, v_puid);
  perform g4c.claims(v_user, g4c.session(v_user));
  perform public.record_threads_credential_custody(v_account, now() + interval '30 days');
  perform g4c.claims(null, null);
  insert into t_threads.verified values (v_account);
  insert into t_ids.people values (p_n, v_user, v_account, public.social_mobile_account_deletion_workspace(v_user), v_puid, g4c.token(p_n));
  return v_account;
end $$;

create schema t_ids;
create table t_ids.people (n integer primary key, user_id uuid not null, threads_account text not null, brand text not null,
  threads_user_id text not null, token text not null);
select g4c.connect(n) from generate_series(101, 130) n;
do $$
begin
  if (select count(*) from t_ids.people where threads_account ~ '^sa_[0-9a-f]{24}$') <> 30 then raise exception 'SETUP: 30 sa_ accounts'; end if;
  if exists (select 1 from public.social_accounts where platform = 'threads' and publish_enabled) then raise exception 'SETUP: 2a-2 keeps Threads publish OFF'; end if;
  if (select count(*) from postona_threads_binding.bindings) <> 30 then raise exception 'SETUP: 30 bindings'; end if;
  if (select count(*) from postona_threads_credential.credential_row((select threads_account from t_ids.people where n = 101), 'x_autopost')) <> 1 then
    raise exception 'SETUP: G4 credential_row answers for a connected account';
  end if;
end $$;
select 'G4_CONNECT_PEOPLE_READY' as result;
