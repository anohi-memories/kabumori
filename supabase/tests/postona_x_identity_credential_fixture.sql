-- Fake-only test support for supabase/tests/postona_x_identity_credential_run.sh (F4 / G4,
-- postona-f4-m1-x-identity-verified-credential-port-source-20261018). Applied on the world the runner builds (G5/F5's
-- REAL lifecycle, the live X onboarding with F3's T13 guard, F3's reservation candidates 001-004, PR #124's
-- provisioner, G4's X v2 with its attestation record, G4's 001 and 002). The Edge code exchange is faked by computing
-- its attestation with the fixture's fake key (PR #126's test fixture). Every value is fake. Disposable local DB only.
set timezone = 'UTC';

create schema xg;
create table xg.ids (k text primary key, v text not null);

create function xg.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function xg.h(p_tag text) returns text language sql immutable as $$
  select encode(sha256(convert_to('state:' || p_tag, 'UTF8')), 'hex') $$;
create function xg.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL %', p_label; end if; end $$;

-- The person's verified JWT claims, as PostgREST / an owner channel carrying them sets them.
create function xg.claims(p_user uuid, p_session uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', case when p_user is null then '' else
    jsonb_build_object('sub', p_user, 'role', 'authenticated', 'session_id', p_session)::text end, true);
end $$;
create function xg.session(p_user uuid) returns uuid language sql as $$
  select coalesce((select s.id from auth.sessions s where s.user_id = p_user and s.not_after is null order by s.created_at limit 1),
                  (select null::uuid)) $$;
-- One statement for a person (their claims, the owner channel). Its text, or 'ERR:' || message.
create function xg.as_person(p_user uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform xg.claims(p_user, xg.session(p_user));
  execute p_sql into v;
  perform xg.claims(null, null);
  return coalesce(v, '<null>');
exception when others then
  perform xg.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
-- A login with POSTONA (x_autopost) started through G5's real RPC and a live session.
create function xg.enroll(p_n integer) returns uuid language plpgsql as $$
declare v_user uuid := xg.uid(p_n);
begin
  perform public.fixture_login(v_user);
  insert into auth.sessions (user_id) values (v_user);
  perform xg.check(xg.as_person(v_user, 'select public.start_x_autopost_service() ->> ''status''') = 'active', 'enroll ' || p_n);
  return v_user;
end $$;
-- The Edge code exchange's attestation (PR #126 message, fake key).
create function xg.attest(p_state uuid, p_puid text, p_handle text, p_access text, p_refresh text) returns text language sql immutable as $$
  select encode(extensions.hmac(convert_to(concat_ws(chr(10), 'postona-x-connect-v1', p_state::text, p_puid, p_handle,
    encode(sha256(convert_to(p_access, 'UTF8')), 'hex'), encode(sha256(convert_to(p_refresh, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_x_attestation_key_0123456789abcdef0123456789ab', 'UTF8'), 'sha256'), 'hex') $$;
create function xg.access(p_tag text) returns text language sql immutable as $$ select 'fake-x-access-' || p_tag || '-0123456789' $$;
create function xg.refresh(p_tag text) returns text language sql immutable as $$ select 'fake-x-refresh-' || p_tag || '-0123456789' $$;

-- G4's attested connect (v2 begin -> consume -> complete with the server attestation). The account id, or 'ERR:...'.
create function xg.connect_v2(p_user uuid, p_tag text, p_puid text, p_token_tag text default null,
                              p_attestation text default null) returns text language plpgsql as $$
declare v_account text; v_state text; v_out text; v_tt text := coalesce(p_token_tag, p_tag);
begin
  v_account := xg.as_person(p_user, format('select social_account_id from public.begin_social_mobile_x_oauth_connection_v2(%L, %L, now() + interval ''5 minutes'')',
                                           xg.h(p_tag), 'kabumori://oauth/x'));
  if v_account like 'ERR:%' then return v_account; end if;
  v_state := xg.as_person(p_user, format('select oauth_state_id::text from public.consume_social_mobile_x_oauth_state_v2(%L)', xg.h(p_tag)));
  if v_state like 'ERR:%' then return v_state; end if;
  v_out := xg.as_person(p_user, format('select public.complete_social_mobile_x_oauth_connection_v2(%L::uuid, %L, %L, %L, %L, %L)::text',
    v_state, p_puid, 'h' || p_puid, xg.access(v_tt), xg.refresh(v_tt),
    coalesce(p_attestation, xg.attest(v_state::uuid, p_puid, 'h' || p_puid, xg.access(v_tt), xg.refresh(v_tt)))));
  if v_out like 'ERR:%' then return v_out; end if;
  return v_account;
end $$;
-- The live (v1) onboarding, as F3's guarded RPCs run it: the client states the X id and the tokens.
create function xg.connect_v1(p_user uuid, p_tag text, p_puid text, p_token_tag text default null) returns text language plpgsql as $$
declare v_account text; v_state text; v_out text; v_tt text := coalesce(p_token_tag, p_tag);
begin
  v_account := xg.as_person(p_user, format('select social_account_id from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')',
                                           xg.h(p_tag), 'kabumori://oauth/x'));
  if v_account like 'ERR:%' then return v_account; end if;
  v_state := xg.as_person(p_user, format('select oauth_state_id::text from public.consume_social_mobile_x_oauth_state(%L)', xg.h(p_tag)));
  if v_state like 'ERR:%' then return v_state; end if;
  v_out := xg.as_person(p_user, format('select public.complete_social_mobile_x_oauth_connection(%L::uuid, %L, %L, %L, %L)::text',
                                       v_state, p_puid, '@fake' || p_puid, xg.access(v_tt), xg.refresh(v_tt)));
  if v_out like 'ERR:%' then return v_out; end if;
  return v_account;
end $$;

-- What G4 answers about one account, for one person: 'verified=<t|f> token=<tag|null> gen=<set|null>'.
create function xg.view(p_user uuid, p_account text) returns text language sql as $$
  select format('verified=%s token=%s gen=%s', public.x_account_g4_verified(p_user, p_account)::text,
    coalesce(public.x_posting_access_token_for(p_account), 'null'),
    case when public.x_account_credential_generation(p_account) is null then 'null' else 'set' end) $$;
create function xg.ok_view(p_user uuid, p_account text, p_tag text) returns text language sql as $$
  select format('verified=true token=%s gen=set', xg.access(p_tag)) $$;
create function xg.denied() returns text language sql immutable as $$ select 'verified=false token=null gen=null' $$;

-- G5's lifecycle state of a person, as G5's rows hold it.
create function xg.state(p_user uuid, p_state text) returns void language plpgsql as $$
begin
  case p_state
    when 'active' then
      delete from private.account_lifecycle_operations o where o.user_id = p_user and o.status = 'in_progress';
      update public.common_accounts set status = 'active' where user_id = p_user and status <> 'active';
      update public.service_entitlements set status = 'active', ended_at = null where user_id = p_user and service_key = 'x_autopost' and status <> 'active';
    when 'suspended' then update public.service_entitlements set status = 'suspended' where user_id = p_user and service_key = 'x_autopost';
    when 'ended' then update public.service_entitlements set status = 'ended', ended_at = now() where user_id = p_user and service_key = 'x_autopost';
    when 'locked' then update public.common_accounts set status = 'locked' where user_id = p_user;
    when 'account_deleting' then
      insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type)
      values (p_user, encode(sha256(convert_to(p_user::text, 'UTF8')), 'hex'), 'account_deletion');
    when 'service_deleting' then
      insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type, service_key)
      values (p_user, encode(sha256(convert_to(p_user::text, 'UTF8')), 'hex'), 'service_deletion', 'x_autopost');
  end case;
end $$;

-- 'ok' or the SQLSTATE a role gets.
create function xg.try_as(p_role text, p_sql text) returns text language plpgsql as $$
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
