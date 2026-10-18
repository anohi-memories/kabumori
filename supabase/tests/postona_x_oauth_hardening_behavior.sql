-- Behavior proof for the POSTONA X OAuth hardening candidate
-- (supabase/candidates/postona_x_oauth_hardening_candidate.sql), with Stage A first: the live X RPCs
-- (20260919120000 + 20260922003101, as the world applies them) reproduced on fake data. Run by
-- postona_x_oauth_hardening_run.sh as the non-superuser table owner on a disposable database, after
-- PR #124's Threads/T9 candidate, this candidate and the runner's TEST-ONLY grants of EXECUTE on the
-- three X v2 and the three Threads RPCs to authenticated. psql variables: mock (true with the T13
-- stand-in: the call-order checks are MOCK_ONLY), g5 (true with G5's own guard candidate), owner.
-- Fake data only; no X API, no real token.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

\set A '00000000-0000-4000-8000-00000000c001'
\set B '00000000-0000-4000-8000-00000000c002'
\set C '00000000-0000-4000-8000-00000000c003'
\set D '00000000-0000-4000-8000-00000000c004'
\set E '00000000-0000-4000-8000-00000000c005'
\set F '00000000-0000-4000-8000-00000000c006'
\set G '00000000-0000-4000-8000-00000000c007'
\set H '00000000-0000-4000-8000-00000000c008'
\set I '00000000-0000-4000-8000-00000000c009'
\set J '00000000-0000-4000-8000-00000000c00a'
\set K '00000000-0000-4000-8000-00000000c00b'
\set L '00000000-0000-4000-8000-00000000c00c'
\set M '00000000-0000-4000-8000-00000000c00d'
\set N '00000000-0000-4000-8000-00000000c00e'
\set O '00000000-0000-4000-8000-00000000c00f'
\set P '00000000-0000-4000-8000-00000000c010'
\set Pu '00000000-0000-4000-8000-00000000c011'
\set V '00000000-0000-4000-8000-00000000c012'
\set Le '00000000-0000-4000-8000-00000000c013'
\set Dl '00000000-0000-4000-8000-00000000c014'
\set R '00000000-0000-4000-8000-00000000c015'
\set S '00000000-0000-4000-8000-00000000c016'
\set T '00000000-0000-4000-8000-00000000c017'
\set U '00000000-0000-4000-8000-00000000c018'
\set W '00000000-0000-4000-8000-00000000c019'
\set Y '00000000-0000-4000-8000-00000000c01a'
\set Z '00000000-0000-4000-8000-00000000c01b'
\set Q '00000000-0000-4000-8000-00000000c01c'
-- A fake X user id that "belongs" to V (the victim) in this proof.
\set VX '1700000000000000777'

-- 0. Test helpers (test schema of this disposable database only) -------------------------------------
create schema postona_xt;
grant usage on schema postona_xt to anon, authenticated, service_role;
create table postona_xt.config as select :'mock'::boolean as mock;
grant select on postona_xt.config to public;

create function postona_xt.h(p_tag text) returns text language sql immutable
as $$ select encode(sha256(convert_to('xstate:' || p_tag, 'UTF8')), 'hex') $$;
create function postona_xt.ws(p_user uuid) returns text language sql immutable
as $$ select public.social_mobile_account_deletion_workspace(p_user) $$;
create function postona_xt.x_id(p_user uuid) returns text language sql immutable
as $$ select 'sa_' || substr(md5(postona_xt.ws(p_user) || ':x'), 1, 24) $$;
create function postona_xt.session_of(p_user uuid) returns uuid language sql immutable
as $$ select md5('session:' || p_user::text)::uuid $$;

-- The X server attestation, written independently of the candidate (and of the TS module, which checks
-- the same known answers below).
create function postona_xt.attest(p_state uuid, p_puid text, p_handle text, p_access text, p_refresh text) returns text
language sql immutable as $$
  select encode(extensions.hmac(
    convert_to(concat_ws(chr(10), 'postona-x-connect-v1', p_state::text, p_puid, p_handle,
                         encode(sha256(convert_to(p_access, 'UTF8')), 'hex'),
                         encode(sha256(convert_to(p_refresh, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_x_attestation_key_0123456789abcdef0123456789ab', 'UTF8'), 'sha256'), 'hex')
$$;

create function postona_xt.login(p_user uuid) returns void language plpgsql as $$
begin
  perform public.fixture_login(p_user);
  insert into auth.sessions (id, user_id) values (postona_xt.session_of(p_user), p_user) on conflict (id) do nothing;
end $$;
create function postona_xt.act(p_user uuid, p_claim_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(p_claim_role, ''), true);
  perform set_config('request.jwt.claim.session_id', coalesce(postona_xt.session_of(p_user)::text, ''), true);
end $$;
create function postona_xt.register(p_user uuid, p_service text default 'x_autopost') returns text language plpgsql as $$
declare v jsonb;
begin
  perform postona_xt.act(p_user);
  v := case p_service when 'x_autopost' then public.start_x_autopost_service() else public.start_kabumori_service() end;
  perform postona_xt.act(null, '');
  return v::text;
end $$;

-- MOCK_ONLY: in this transaction, the first logged step is the guard.
create function postona_xt.t13_first(p_label text) returns void language plpgsql as $$
declare v_first text;
begin
  select c.what into v_first from postona_mock.calls c where c.tx = pg_current_xact_id() order by c.seq limit 1;
  if v_first is distinct from 'T13' then
    raise exception 'FAIL (MOCK_ONLY) %: first logged step is %, not T13', p_label, coalesce(v_first, '<none>');
  end if;
end $$;

-- Runs one statement as an API role with a person's claims; 'OK' or '<SQLSTATE> <message>'. A
-- successful guarded call must have run the guard first (MOCK_ONLY check); p_guarded => false for the
-- live X RPCs, which have no guard.
create function postona_xt.call(p_user uuid, p_sql text, p_role text default 'authenticated',
                                p_claim_role text default 'authenticated', p_guarded boolean default true)
returns text language plpgsql as $$
declare v_msg text; v_state text;
begin
  perform postona_xt.act(p_user, p_claim_role);
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
  end;
  perform postona_xt.act(null, '');
  if v_state is null and p_guarded and (select c.mock from postona_xt.config c) then
    perform postona_xt.t13_first(p_sql);
  end if;
  return coalesce(v_state || ' ' || v_msg, 'OK');
end $$;

create function postona_xt.snapshot() returns text language sql stable set timezone = 'UTC' as $$
  select md5(concat_ws('|',
    (select string_agg(t::text, ',' order by t.id) from public.brands t),
    (select string_agg(t::text, ',' order by t.brand_id, t.user_id) from public.brand_memberships t),
    (select string_agg(t::text, ',' order by t.id) from public.social_accounts t),
    (select string_agg(t::text, ',' order by t.id) from public.social_account_oauth_states t),
    (select string_agg(t::text, ',' order by t.id) from vault.secrets t),
    (select string_agg(t::text, ',' order by t.user_id) from public.common_accounts t),
    (select string_agg(t::text, ',' order by t.user_id, t.service_key) from public.service_entitlements t),
    (select string_agg(t::text, ',' order by t.id) from private.account_lifecycle_operations t),
    (select string_agg(t::text, ',' order by t.user_id) from public.social_mobile_account_deletions t),
    (select string_agg(t::text, ',' order by t.id) from auth.users t)))
$$;
create function postona_xt.lifecycle(p_users uuid[]) returns text language sql stable set timezone = 'UTC' as $$
  select concat_ws('|',
    (select string_agg(t::text, ',' order by t.user_id) from public.common_accounts t where t.user_id = any (p_users)),
    (select string_agg(t::text, ',' order by t.user_id, t.service_key) from public.service_entitlements t where t.user_id = any (p_users)),
    (select string_agg(t::text, ',' order by t.id) from private.account_lifecycle_operations t where t.user_id = any (p_users)))
$$;
create function postona_xt.refuse(p_user uuid, p_sql text, p_want text, p_label text,
                                  p_role text default 'authenticated', p_claim_role text default 'authenticated')
returns void language plpgsql as $$
declare v_before text := postona_xt.snapshot(); v_got text;
begin
  v_got := postona_xt.call(p_user, p_sql, p_role, p_claim_role);
  if v_got is null or v_got not like p_want then
    raise exception 'FAIL %: got %, want %', p_label, coalesce(v_got, '<null>'), p_want;
  end if;
  if postona_xt.snapshot() is distinct from v_before then
    raise exception 'FAIL %: the refused call changed something', p_label;
  end if;
end $$;
create function postona_xt.accept(p_user uuid, p_sql text, p_label text, p_guarded boolean default true) returns void language plpgsql as $$
declare v_got text := postona_xt.call(p_user, p_sql, p_guarded => p_guarded);
begin
  if v_got is distinct from 'OK' then raise exception 'FAIL %: %', p_label, v_got; end if;
end $$;
create function postona_xt.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL %', p_label; end if;
end $$;

create function postona_xt.state_id(p_tag text) returns uuid language sql stable as $$
  select s.id from public.social_account_oauth_states s where s.state_hash = postona_xt.h(p_tag)
$$;
create function postona_xt.begin_sql(p_tag text, p_ttl interval default '5 minutes',
                                     p_redirect text default 'kabumori-social://oauth-callback')
returns text language sql stable as $$
  select format('select * from public.begin_social_mobile_x_oauth_connection_v2(%L, %L, now() + %L::interval)',
                postona_xt.h(p_tag), p_redirect, p_ttl)
$$;
create function postona_xt.consume_sql(p_tag text) returns text language sql stable as $$
  select format('select * from public.consume_social_mobile_x_oauth_state_v2(%L)', postona_xt.h(p_tag))
$$;
-- complete_v2 for the state of p_tag, attested over exactly what is sent unless an attestation is given.
create function postona_xt.complete_sql(p_tag text, p_puid text, p_handle text, p_access text, p_refresh text,
                                        p_attestation text default null, p_state uuid default null)
returns text language sql stable as $$
  select format('select public.complete_social_mobile_x_oauth_connection_v2(%L, %L, %L, %L, %L, %L)',
                coalesce(p_state, postona_xt.state_id(p_tag)), p_puid, p_handle, p_access, p_refresh,
                coalesce(p_attestation, postona_xt.attest(coalesce(p_state, postona_xt.state_id(p_tag)), p_puid, p_handle, p_access, p_refresh)))
$$;
-- The live RPCs, exactly as the deployed Edge calls them.
create function postona_xt.live_begin_sql(p_tag text, p_ttl interval default '10 minutes',
                                          p_redirect text default 'kabumori-social://oauth-callback')
returns text language sql stable as $$
  select format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + %L::interval)',
                postona_xt.h(p_tag), p_redirect, p_ttl)
$$;
create function postona_xt.live_consume_sql(p_tag text) returns text language sql stable as $$
  select format('select * from public.consume_social_mobile_x_oauth_state(%L)', postona_xt.h(p_tag))
$$;
create function postona_xt.live_complete_sql(p_tag text, p_puid text, p_handle text, p_access text, p_refresh text)
returns text language sql stable as $$
  select format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
                postona_xt.state_id(p_tag), p_puid, p_handle, p_access, p_refresh)
$$;
create function postona_xt.threads_begin_sql(p_tag text) returns text language sql stable as $$
  select format('select * from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''5 minutes'')',
                postona_xt.h(p_tag), 'https://app.postona.test/oauth/threads/callback')
$$;
create function postona_xt.x_row(p_user uuid) returns text language sql stable set timezone = 'UTC' as $$
  select row(sa.brand_id, sa.platform_user_id, sa.handle, sa.publish_enabled, sa.connection_status,
             sa.vault_access_token_secret_id is not null, sa.vault_refresh_token_secret_id is not null, sa.last_connection_error_code)::text
  from public.social_accounts sa join public.brand_memberships m on m.brand_id = sa.brand_id and m.user_id = p_user and m.role = 'owner'
  where sa.platform = 'x'
$$;

-- Known answers shared with x_connect_rpc_contract_test.ts.
select postona_xt.ok(postona_xt.attest('00000000-0000-4000-8000-0000000000bb', '1700000000000000001', 'Postona_X',
                                       'fakeXaccessTOKEN000000000001', 'fakeXrefreshTOKEN00000000001')
                     = '083859c4e51418d24f3c25cbbf94fb58c0b33279579ba02abf0cf6a8c32e0a4f', 'X attestation known answer');

-- 1. The people ------------------------------------------------------------------------------------------
select postona_xt.login(u::uuid) from (values (:'A'), (:'B'), (:'C'), (:'D'), (:'E'), (:'F'), (:'G'), (:'H'), (:'I'), (:'J'),
  (:'K'), (:'L'), (:'M'), (:'N'), (:'O'), (:'P'), (:'Pu'), (:'V'), (:'Le'), (:'Dl'), (:'R'), (:'S'), (:'T'), (:'U'), (:'W'),
  (:'Y'), (:'Q')) v(u);
select postona_xt.register(u::uuid) from (values (:'A'), (:'B'), (:'C'), (:'D'), (:'E'), (:'G'), (:'H'), (:'K'), (:'L'), (:'M'),
  (:'N'), (:'O'), (:'P'), (:'V'), (:'Le'), (:'Dl'), (:'R'), (:'S'), (:'T'), (:'U'), (:'W'), (:'Y'), (:'Q')) v(u);
select postona_xt.register(:'J', 'kabumori');
select postona_xt.ok((select count(*) from public.service_entitlements
                      where service_key = 'x_autopost' and status = 'active' and user_id::text like '00000000-0000-4000-8000-00000000c%') = 23,
                     'setup: 23 x_autopost registrations');
select lifecycle_version as m_version from public.common_accounts where user_id = :'M' \gset
set role service_role;
select postona_xt.ok(public.begin_service_deletion(:'K', 'x_autopost') ->> 'status' = 'started', 'setup K');
select public.begin_service_deletion(:'L', 'x_autopost') ->> 'operation_id' as l_operation \gset
select postona_xt.ok(public.finish_service_deletion(:'L', 'x_autopost', :'l_operation') ->> 'status' = 'ended', 'setup L');
select public.begin_service_deletion(:'Le', 'x_autopost') ->> 'operation_id' as le_operation \gset
select postona_xt.ok(public.finish_service_deletion(:'Le', 'x_autopost', :'le_operation') ->> 'status' = 'ended', 'setup Le');
select postona_xt.ok(public.begin_common_account_deletion(:'M', :'m_version') ->> 'status' = 'started', 'setup M');
reset role;
update public.common_accounts set status = 'locked' where user_id = :'N';
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
values (:'O', postona_xt.ws(:'O'), 'started', 'social_only', '[]');
insert into public.brands (id, code_profile_key) values ('legacy_xd', 'social_mobile_user_v1'), ('legacy_xdl', 'social_mobile_user_v1');
insert into public.brand_memberships values ('legacy_xd', :'D', 'owner'), ('legacy_xdl', :'Dl', 'owner');
insert into public.brands (id, is_active, publish_mode) values (postona_xt.ws(:'E'), false, 'disabled'), (postona_xt.ws(:'H'), false, 'disabled'),
  (postona_xt.ws(:'U'), false, 'disabled');
insert into public.brands (id, code_profile_key) values (postona_xt.ws(:'G'), 'kabumori_v1');
insert into public.brand_memberships values (postona_xt.ws(:'E'), :'E', 'owner'), (postona_xt.ws(:'E'), :'F', 'member'),
  (postona_xt.ws(:'G'), :'G', 'owner'), (postona_xt.ws(:'H'), :'H', 'admin'), (postona_xt.ws(:'U'), :'U', 'owner');
insert into public.social_accounts (id, brand_id, platform, publish_enabled, connection_status)
values ('sa_legacy_x_u', postona_xt.ws(:'U'), 'x', false, 'unconnected');

-- 2. Stage A: the live X RPCs, reproduced (fake data, disposable database) -----------------------------
-- (a) Preclaim. A signed-in person P calls the live RPCs directly (no Edge, no code exchange), with V's
--     X user id and made-up tokens: accepted, and P's row now shows V's identity as verified.
select postona_xt.accept(:'P', postona_xt.live_begin_sql('P1'), 'live begin P1', false);
select postona_xt.accept(:'P', postona_xt.live_consume_sql('P1'), 'live consume P1', false);
select postona_xt.accept(:'P', postona_xt.live_complete_sql('P1', :'VX', '@Victim_Handle', 'not-a-real-access', 'not-a-real-refresh'),
                         'live complete: P binds V''s X id with made-up tokens', false);
select postona_xt.ok(postona_xt.x_row(:'P') = format('(%s,%s,victim_handle,f,identity_verified,t,t,)', postona_xt.ws(:'P'), :'VX'),
                     'Stage A: P''s row shows V''s X id as verified');
-- The same works for a person with no POSTONA registration at all (the live path has no T13).
select postona_xt.accept(:'Pu', postona_xt.live_begin_sql('Pu1'), 'live begin by an unregistered login', false);
select postona_xt.accept(:'Pu', postona_xt.live_complete_sql('Pu1', '1700000000000000778', 'other', 'made-up', 'made-up-2'),
                         'live complete by an unregistered login', false);
-- (b) V now connects for real (the Edge would pass V's genuine identity): refused for good. V's own row
--     is left as it was: the handler's connection_status = 'failed' is rolled back by its own re-raise.
select postona_xt.accept(:'V', postona_xt.live_begin_sql('V1'), 'live begin V1', false);
select postona_xt.refuse(:'V', postona_xt.live_complete_sql('V1', :'VX', 'victim_handle', 'fake-genuine-access', 'fake-genuine-refresh'),
                         'P0001 X_ACCOUNT_ALREADY_CONNECTED', 'Stage A: V cannot connect V''s own X account');
select postona_xt.ok(postona_xt.x_row(:'V') = format('(%s,,pending,f,authorization_pending,f,f,)', postona_xt.ws(:'V'))
                     and (select consumed_at is null from public.social_account_oauth_states where state_hash = postona_xt.h('V1')),
                     'Stage A: no durable ''failed'' status, state not consumed, no secret');
-- (c) The live begin has no guard and no personal-workspace rule: an ended service connects, and a
--     person who owns another brand gets X attached to that brand; any redirect and lifetime are kept.
select postona_xt.accept(:'Le', postona_xt.live_begin_sql('Le1'), 'live begin after the service ended', false);
select postona_xt.accept(:'Dl', postona_xt.live_begin_sql('Dl1'), 'live begin with another owned brand', false);
select postona_xt.ok((select brand_id from public.social_accounts where platform = 'x' and brand_id in ('legacy_xdl', postona_xt.ws(:'Dl'))) = 'legacy_xdl',
                     'Stage A: live X row on the other brand');
select postona_xt.accept(:'Pu', postona_xt.live_begin_sql('Pu2', '365 days', 'http://evil.example/cb'), 'live begin: http, one year', false);
\echo POSTONA_X_OAUTH_STAGE_A_REPRODUCED

select postona_xt.lifecycle(array[:'A', :'B', :'C', :'W', :'Y', :'V']::uuid[]) as lifecycle_before \gset

-- 3. v2 reachability: only by authenticated (TEST-ONLY grant), never the guard or the provisioner. --------
select postona_xt.ok(not exists (
  select 1 from (values ('anon'), ('service_role')) r(role),
       (values ('public.begin_social_mobile_x_oauth_connection_v2(text,text,timestamptz)'),
               ('public.consume_social_mobile_x_oauth_state_v2(text)'),
               ('public.complete_social_mobile_x_oauth_connection_v2(uuid,text,text,text,text,text)')) f(fn)
  where has_function_privilege(r.role, f.fn::regprocedure, 'EXECUTE')), 'anon and service_role reach no v2 RPC');
select postona_xt.ok(not exists (
  select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role),
       (values ('private.social_mobile_ensure_personal_workspace(uuid)'),
               ('private.account_lifecycle_assert_active_service_write(uuid,text)')) f(fn)
  where has_function_privilege(r.role, f.fn::regprocedure, 'EXECUTE')), 'provisioner and guard unreachable');
select postona_xt.ok(not exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role)
                                 where pg_has_role(r.role, :'owner', 'MEMBER') or pg_has_role(r.role, :'owner', 'SET')),
                     'no API role is a member of the owner');
select postona_xt.refuse(:'A', postona_xt.begin_sql('anon'), '42501 permission denied for function begin_social_mobile_x_oauth_connection_v2', 'anon begin', 'anon', 'anon');
select postona_xt.refuse(:'A', postona_xt.complete_sql('none', '1700000000000000001', 'x', 'fakeXaccessTOKENsvc0001', 'fakeXrefreshTOKENsvc001', null, gen_random_uuid()),
                         '42501 permission denied for function complete_social_mobile_x_oauth_connection_v2', 'service_role complete', 'service_role', 'service_role');
select postona_xt.refuse(:'A', postona_xt.begin_sql('svcclaim'), '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'service_role claim', 'authenticated', 'service_role');
select postona_xt.refuse(null, postona_xt.consume_sql('nosub'), '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'no subject');
-- 2a-2's reviewed list of SECURITY DEFINER writers of social_accounts gains exactly the X v2 and the
-- Threads (PR #124) begin and complete.
select postona_xt.ok((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
                      where p.prosecdef and p.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+(public\.)?social_accounts'
                        and p.proname not in ('begin_social_mobile_x_oauth_connection', 'complete_social_mobile_x_oauth_connection',
                                              'record_x_account_access_unauthorized', 'set_social_account_publish_enabled',
                                              'social_mobile_account_deletion_acquire', 'social_mobile_account_deletion_purge',
                                              'x_account_refresh_health_mirror'))
                     = 'begin_social_mobile_threads_oauth_connection,begin_social_mobile_x_oauth_connection_v2,'
                       || 'complete_social_mobile_threads_oauth_connection,complete_social_mobile_x_oauth_connection_v2',
                     'new SECURITY DEFINER writers of social_accounts');
\echo POSTONA_X_OAUTH_REACHABILITY_PASS

-- 4. The guard (T13) decides before anything else, for each v2 RPC; refusals write nothing. --------------
select postona_xt.refuse(p.who::uuid, f.sql, '42501 ' || p.code, 'guard ' || p.code || ' ' || f.rpc)
from (values (:'I', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'), (:'Z', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'),
             (:'J', 'SERVICE_NOT_REGISTERED'), (:'K', 'SERVICE_DELETION_IN_PROGRESS'), (:'L', 'SERVICE_NOT_ACTIVE'),
             (:'M', 'ACCOUNT_DELETION_IN_PROGRESS'), (:'N', 'ACCOUNT_LOCKED')) p(who, code),
     lateral (values ('begin', postona_xt.begin_sql('guard' || p.who)), ('consume', postona_xt.consume_sql('guard' || p.who)),
                     ('complete', postona_xt.complete_sql('guard', '1700000000000000009', 'guard', 'fakeXaccessTOKENguard01',
                                                          'fakeXrefreshTOKENguard1', null, md5(p.who)::uuid))) f(rpc, sql);
select postona_xt.refuse(:'Le', postona_xt.consume_sql('Le1'), '42501 SERVICE_NOT_ACTIVE', 'v2 consume of a live state after the service ended');
begin isolation level repeatable read;
select postona_xt.refuse(:'A', postona_xt.begin_sql('rr'), '42501 ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE', 'repeatable read');
commit;
\if :g5
delete from auth.sessions where user_id = :'Q';
select postona_xt.refuse(:'Q', postona_xt.begin_sql('revoked'), '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'g5: revoked session');
\endif
select postona_xt.refuse(:'O', postona_xt.begin_sql('tomb'), 'P0001 SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS', 'tombstone');
\echo POSTONA_X_OAUTH_GUARD_PASS

-- 5. v2 begin: the one personal workspace (T9, PR #124's provisioner) ------------------------------------
select postona_xt.accept(:'A', postona_xt.begin_sql('A1'), 'v2 begin A1');
select postona_xt.ok(((select count(*) from postona_mock.calls where what = 'T13') > 0) = (:'mock' = 'true'), 'call log is live');
select postona_xt.ok(postona_xt.x_row(:'A') = format('(%s,,pending,f,authorization_pending,f,f,)', postona_xt.ws(:'A'))
                     and (select string_agg(m.user_id || ':' || m.role, ',') from public.brand_memberships m where m.brand_id = postona_xt.ws(:'A')) = :'A' || ':owner'
                     and (select row(s.social_account_id, s.brand_id, s.redirect_uri, s.consumed_at, s.initiated_by_user_id)::text
                          from public.social_account_oauth_states s where s.state_hash = postona_xt.h('A1'))
                         = format('(%s,%s,kabumori-social://oauth-callback,,%s)', postona_xt.x_id(:'A'), postona_xt.ws(:'A'), :'A'),
                     'A: workspace, pending X row, bound state');
select postona_xt.accept(:'A', postona_xt.begin_sql('A2'), 'v2 begin A2');
select postona_xt.accept(:'A', postona_xt.begin_sql('A3', '10 minutes'), 'v2 begin A3 (10 minute limit)');
select postona_xt.ok((select count(*) from public.brand_memberships where user_id = :'A') = 1
                     and (select count(*) from public.social_accounts where brand_id = postona_xt.ws(:'A')) = 1, 'A: idempotent');
-- A workspace and X row made by the live begin are the same ones.
select postona_xt.accept(:'C', postona_xt.live_begin_sql('C0'), 'live begin C0', false);
select postona_xt.accept(:'C', postona_xt.begin_sql('C1'), 'v2 begin after the live begin');
select postona_xt.ok((select count(*) from public.brand_memberships where user_id = :'C') = 1
                     and (select string_agg(id, ',') from public.social_accounts where brand_id = postona_xt.ws(:'C')) = postona_xt.x_id(:'C'),
                     'C: same workspace and X row');
-- X and Threads share the workspace, in either order.
select postona_xt.accept(:'B', postona_xt.threads_begin_sql('B-T1'), 'Threads begin B');
select postona_xt.accept(:'B', postona_xt.begin_sql('B1'), 'v2 begin B after Threads');
select postona_xt.ok((select string_agg(platform, ',' order by platform) from public.social_accounts where brand_id = postona_xt.ws(:'B')) = 'threads,x'
                     and (select count(*) from public.brand_memberships where user_id = :'B') = 1, 'B: one workspace, both rows');
select postona_xt.accept(:'A', postona_xt.threads_begin_sql('A-T1'), 'Threads begin A after X');
-- Never another owned, shared, non-self-service or non-owner workspace, nor another X row.
select postona_xt.refuse(:'D', postona_xt.begin_sql('D1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_CONFLICT', 'D: owns another workspace');
select postona_xt.refuse(:'Dl', postona_xt.begin_sql('Dl2'), 'P0001 SOCIAL_MOBILE_WORKSPACE_CONFLICT', 'Dl: live X row on another brand');
select postona_xt.refuse(:'E', postona_xt.begin_sql('E1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_SHARED', 'E: shared');
select postona_xt.refuse(:'G', postona_xt.begin_sql('G1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_NOT_SELF_SERVICE', 'G: not self-service');
select postona_xt.refuse(:'H', postona_xt.begin_sql('H1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_ROLE_MISMATCH', 'H: admin');
select postona_xt.refuse(:'U', postona_xt.begin_sql('U1'), 'P0001 X_ACCOUNT_CONFLICT', 'U: another X row');
\echo POSTONA_X_OAUTH_WORKSPACE_PASS

-- 6. v2 begin input: shape before the guard ------------------------------------------------------------
select postona_xt.refuse(:'A', s, 'P0001 OAUTH_STATE_INPUT_INVALID', 'v2 begin input ' || s) from (values
  (format('select * from public.begin_social_mobile_x_oauth_connection_v2(%L, %L, now() + interval ''5 minutes'')', upper(postona_xt.h('x')), 'kabumori-social://oauth-callback')),
  (format('select * from public.begin_social_mobile_x_oauth_connection_v2(%L, %L, now() + interval ''5 minutes'')', left(postona_xt.h('x'), 63), 'kabumori-social://oauth-callback')),
  ('select * from public.begin_social_mobile_x_oauth_connection_v2(null, ''kabumori-social://oauth-callback'', now() + interval ''5 minutes'')'),
  (postona_xt.begin_sql('i1', '5 minutes', 'http://evil.example/cb')),
  (postona_xt.begin_sql('i2', '5 minutes', 'kabumori-social://oauth-callback#f')),
  (postona_xt.begin_sql('i3', '5 minutes', 'https://u@a.test/cb')),
  (postona_xt.begin_sql('i4', '5 minutes', 'kabumori-social://oauth callback')),
  (postona_xt.begin_sql('i5', '5 minutes', 'Kabumori-social://oauth-callback')),
  (postona_xt.begin_sql('i6', '5 minutes', 'kabumori-social:/oauth-callback')),
  (postona_xt.begin_sql('i7', '5 minutes', 'https://a.test/' || repeat('p', 2034))),
  (format('select * from public.begin_social_mobile_x_oauth_connection_v2(%L, null, now() + interval ''5 minutes'')', postona_xt.h('i8'))),
  (postona_xt.begin_sql('i9', '-1 second')),
  (postona_xt.begin_sql('i10', '10 minutes 1 second')),
  (postona_xt.begin_sql('i11', '365 days')),
  (format('select * from public.begin_social_mobile_x_oauth_connection_v2(%L, %L, null)', postona_xt.h('i12'), 'kabumori-social://oauth-callback')),
  (postona_xt.begin_sql('A1')), (postona_xt.begin_sql('B1')), (postona_xt.begin_sql('B-T1')), (postona_xt.begin_sql('P1'))) v(s);
select postona_xt.accept(:'A', postona_xt.begin_sql('i13', '5 minutes', 'https://app.postona.test/x/' || repeat('p', 2021)), 'https redirect of 2048');
select postona_xt.refuse(:'L', postona_xt.begin_sql('L9', '5 minutes', 'http://a.test/cb'), 'P0001 OAUTH_STATE_INPUT_INVALID', 'ended person, bad shape');
select postona_xt.refuse(:'L', postona_xt.begin_sql('A1'), '42501 SERVICE_NOT_ACTIVE', 'ended person, used hash');
\echo POSTONA_X_OAUTH_BEGIN_INPUT_PASS

-- 7. v2 consume: read-only, this person's own X state only ----------------------------------------------
select postona_xt.snapshot() as snap_c \gset
begin;
select postona_xt.act(:'A');
set local role authenticated;
select oauth_state_id as c_id, redirect_uri as c_redirect, brand_id as c_brand, social_account_id as c_account
  from public.consume_social_mobile_x_oauth_state_v2(postona_xt.h('A1')) \gset
reset role;
commit;
select postona_xt.ok(:'c_id'::uuid = postona_xt.state_id('A1') and :'c_redirect' = 'kabumori-social://oauth-callback'
                     and :'c_brand' = postona_xt.ws(:'A') and :'c_account' = postona_xt.x_id(:'A'), 'v2 consume A1 returns the state');
select postona_xt.accept(:'A', postona_xt.consume_sql('A1'), 'v2 consume again (read-only)');
select postona_xt.ok(postona_xt.snapshot() = :'snap_c', 'v2 consume wrote nothing');
insert into public.social_account_oauth_states (social_account_id, brand_id, state_hash, redirect_uri, expires_at, initiated_by_user_id)
values (postona_xt.x_id(:'A'), postona_xt.ws(:'A'), postona_xt.h('A-by-B'), 'kabumori-social://oauth-callback', now() + interval '5 minutes', :'B'),
       (postona_xt.x_id(:'B'), postona_xt.ws(:'B'), postona_xt.h('B-by-A'), 'kabumori-social://oauth-callback', now() + interval '5 minutes', :'A');
update public.social_account_oauth_states set expires_at = now() - interval '1 second' where state_hash = postona_xt.h('A3');
select postona_xt.refuse(p.who::uuid, postona_xt.consume_sql(p.tag), 'P0001 OAUTH_STATE_NOT_CONSUMABLE', 'v2 consume ' || p.tag || ' as ' || p.who)
from (values (:'A', 'A-T1'), (:'B', 'A1'), (:'A', 'B1'), (:'B', 'A-by-B'), (:'A', 'A-by-B'), (:'A', 'B-by-A'), (:'A', 'A3'),
             (:'Dl', 'Dl1'), (:'A', 'missing')) p(who, tag);
select postona_xt.refuse(:'A', format('select * from public.consume_social_mobile_x_oauth_state_v2(%L)', s), 'P0001 OAUTH_STATE_NOT_CONSUMABLE', 'v2 consume malformed')
from (values (upper(postona_xt.h('A1'))), (left(postona_xt.h('A1'), 63)), ('')) v(s);
\echo POSTONA_X_OAUTH_CONSUME_PASS

-- 8. v2 complete: attested identity, one irreversible claim ----------------------------------------------
\set AX '1700000000000000101'
\set AT 'fakeXaccessTOKENforA00001'
\set AR 'fakeXrefreshTOKENforA0001'
select postona_xt.refuse(:'A', s, 'P0001 OAUTH_TOKEN_OR_IDENTITY_INVALID', 'v2 complete input ' || s) from (values
  (postona_xt.complete_sql('A1', '01700000000000000101', 'Postona_A', :'AT', :'AR')),
  (postona_xt.complete_sql('A1', '17000x', 'Postona_A', :'AT', :'AR')),
  (postona_xt.complete_sql('A1', '1' || repeat('0', 20), 'Postona_A', :'AT', :'AR')),
  (postona_xt.complete_sql('A1', :'AX', '@Postona_A', :'AT', :'AR')),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A_toolong', :'AT', :'AR')),
  (postona_xt.complete_sql('A1', :'AX', '', :'AT', :'AR')),
  (postona_xt.complete_sql('A1', :'AX', 'post-ona', :'AT', :'AR')),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', 'shortXtoken0015', :'AR')),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', 'fakeX access TOKEN0001', :'AR')),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', 'fakeXrefresh' || chr(10) || 'TOKEN0001')),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', repeat('r', 4097))),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AT')),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR', upper(postona_xt.attest(postona_xt.state_id('A1'), :'AX', 'Postona_A', :'AT', :'AR')))),
  (format('select public.complete_social_mobile_x_oauth_connection_v2(%L, %L, null, %L, %L, %L)', postona_xt.state_id('A1'), :'AX', :'AT', :'AR', repeat('a', 64))),
  (format('select public.complete_social_mobile_x_oauth_connection_v2(null, %L, %L, %L, %L, %L)', :'AX', 'Postona_A', :'AT', :'AR', repeat('a', 64))),
  (format('select public.complete_social_mobile_x_oauth_connection_v2(%L, %L, %L, %L, null, %L)', postona_xt.state_id('A1'), :'AX', 'Postona_A', :'AT', repeat('a', 64))),
  (format('select public.complete_social_mobile_x_oauth_connection_v2(%L, %L, %L, %L, %L, null)', postona_xt.state_id('A1'), :'AX', 'Postona_A', :'AT', :'AR'))) v(s);
-- The preclaim, attempted on v2: without the key, an identity cannot be vouched for (a made-up value,
-- another key, or an attestation of something else).
select postona_xt.accept(:'P', postona_xt.begin_sql('P1v2'), 'v2 begin P1v2');
select postona_xt.refuse(:'P', s, 'P0001 X_CONNECT_ATTESTATION_INVALID', 'v2 preclaim ' || s) from (values
  (postona_xt.complete_sql('P1v2', :'VX', 'victim_handle', 'madeUpAccessToken0001', 'madeUpRefreshToken001', repeat('0', 64))),
  (postona_xt.complete_sql('P1v2', :'VX', 'victim_handle', 'madeUpAccessToken0001', 'madeUpRefreshToken001',
                           encode(extensions.hmac(convert_to(concat_ws(chr(10), 'postona-x-connect-v1', postona_xt.state_id('P1v2')::text, :'VX', 'victim_handle',
                             encode(sha256(convert_to('madeUpAccessToken0001', 'UTF8')), 'hex'), encode(sha256(convert_to('madeUpRefreshToken001', 'UTF8')), 'hex')), 'UTF8'),
                             convert_to('a_guessed_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex'))),
  (postona_xt.complete_sql('P1v2', :'VX', 'victim_handle', 'madeUpAccessToken0001', 'madeUpRefreshToken001',
                           postona_xt.attest(postona_xt.state_id('P1v2'), '1700000000000000999', 'victim_handle', 'madeUpAccessToken0001', 'madeUpRefreshToken001')))) v(s);
select postona_xt.refuse(:'A', s, 'P0001 X_CONNECT_ATTESTATION_INVALID', 'v2 attestation ' || s) from (values
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR', postona_xt.attest(postona_xt.state_id('A1'), :'AX', 'postona_a', :'AT', :'AR'))),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR', postona_xt.attest(postona_xt.state_id('A1'), :'AX', 'Postona_A', :'AT' || 'x', :'AR'))),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR', postona_xt.attest(postona_xt.state_id('A1'), :'AX', 'Postona_A', :'AT', :'AR' || 'x'))),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR', postona_xt.attest(postona_xt.state_id('A1'), :'AR', 'Postona_A', :'AT', :'AT'))),
  (postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR', postona_xt.attest(postona_xt.state_id('A2'), :'AX', 'Postona_A', :'AT', :'AR')))) v(s);
update vault.secrets set name = 'postona_x_connect_attestation_v0' where name = 'postona_x_connect_attestation_v1';
select postona_xt.refuse(:'A', postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR'), 'P0001 X_CONNECT_ATTESTATION_UNAVAILABLE', 'X key missing');
insert into vault.secrets (name, secret) values ('postona_x_connect_attestation_v1', 'fake_short_x_key_31_characters');
select postona_xt.refuse(:'A', postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR'), 'P0001 X_CONNECT_ATTESTATION_UNAVAILABLE', 'X key too short');
delete from vault.secrets where name = 'postona_x_connect_attestation_v1';
update vault.secrets set name = 'postona_x_connect_attestation_v1' where name = 'postona_x_connect_attestation_v0';
-- The Threads key never vouches for X.
select postona_xt.refuse(:'A', postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR',
                           encode(extensions.hmac(convert_to(concat_ws(chr(10), 'postona-x-connect-v1', postona_xt.state_id('A1')::text, :'AX', 'Postona_A',
                             encode(sha256(convert_to(:'AT', 'UTF8')), 'hex'), encode(sha256(convert_to(:'AR', 'UTF8')), 'hex')), 'UTF8'),
                             convert_to('fake_attestation_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex')),
                         'P0001 X_CONNECT_ATTESTATION_INVALID', 'Threads key for X');
-- Not this person's X state (each attested, so only the binding refuses it).
select postona_xt.refuse(p.who::uuid, postona_xt.complete_sql(p.tag, :'AX', 'Postona_A', :'AT', :'AR'), 'P0001 OAUTH_STATE_NOT_CONSUMABLE',
                         'v2 complete ' || p.tag || ' as ' || p.who)
from (values (:'A', 'A-T1'), (:'B', 'A1'), (:'A', 'B1'), (:'B', 'A-by-B'), (:'A', 'A-by-B'), (:'A', 'B-by-A'), (:'A', 'A3')) p(who, tag);
select postona_xt.refuse(:'Dl', postona_xt.complete_sql('Dl1', '1700000000000000140', 'dl', 'fakeXaccessTOKENforDl1', 'fakeXrefreshTOKENforDl'),
                         'P0001 SOCIAL_MOBILE_ACCOUNT_NOT_OWNED', 'v2 complete of a live state on another brand');
select postona_xt.refuse(:'A', postona_xt.complete_sql('none', :'AX', 'Postona_A', :'AT', :'AR', null, gen_random_uuid()),
                         'P0001 OAUTH_STATE_NOT_CONSUMABLE', 'v2 complete unknown state');

-- The success: identity, handle (lower case, as the live RPC stores it), both Vault references; publish off.
select postona_xt.accept(:'A', postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR'), 'v2 complete A1');
select postona_xt.ok(postona_xt.x_row(:'A') = format('(%s,%s,postona_a,f,identity_verified,t,t,)', postona_xt.ws(:'A'), :'AX'), 'A: verified X row');
select postona_xt.ok((select string_agg(s.name || '=' || s.secret, ',' order by s.name) from vault.secrets s join public.social_accounts sa
                        on s.id in (sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id) where sa.id = postona_xt.x_id(:'A'))
                     = format('%1$s_access_token=%2$s,%1$s_refresh_token=%3$s', postona_xt.x_id(:'A'), :'AT', :'AR'), 'A: tokens in Vault under the row''s names');
select vault_access_token_secret_id as a_access, vault_refresh_token_secret_id as a_refresh, verified_at as a_verified
  from public.social_accounts where id = postona_xt.x_id(:'A') \gset
select postona_xt.refuse(:'A', postona_xt.complete_sql('A1', :'AX', 'Postona_A', :'AT', :'AR'), 'P0001 OAUTH_STATE_NOT_CONSUMABLE', 'v2 replay');
select postona_xt.refuse(:'A', postona_xt.consume_sql('A1'), 'P0001 OAUTH_STATE_NOT_CONSUMABLE', 'v2 consume after complete');
select postona_xt.accept(:'A', postona_xt.begin_sql('A4'), 'v2 begin A4 (reconnect)');
select postona_xt.ok((select connection_status from public.social_accounts where id = postona_xt.x_id(:'A')) = 'identity_verified',
                     'A: begin keeps identity_verified');
select postona_xt.refuse(:'A', postona_xt.complete_sql('A4', '1700000000000000102', 'someone', 'fakeXaccessTOKENforA00004', 'fakeXrefreshTOKENforA0004'),
                         'P0001 X_IDENTITY_ACCOUNT_MISMATCH', 'reconnect: another identity');
select postona_xt.accept(:'A', postona_xt.complete_sql('A2', :'AX', 'Postona_A2', 'fakeXaccessTOKENforA00002', 'fakeXrefreshTOKENforA0002'), 'reconnect: same identity');
select postona_xt.ok((select row(sa.vault_access_token_secret_id = :'a_access'::uuid, sa.vault_refresh_token_secret_id = :'a_refresh'::uuid,
                                 sa.verified_at > :'a_verified'::timestamptz, sa.handle,
                                 (select s.secret from vault.secrets s where s.id = sa.vault_access_token_secret_id),
                                 (select s.secret from vault.secrets s where s.id = sa.vault_refresh_token_secret_id))::text
                      from public.social_accounts sa where sa.id = postona_xt.x_id(:'A'))
                     = '(t,t,t,postona_a2,fakeXaccessTOKENforA00002,fakeXrefreshTOKENforA0002)', 'A: tokens updated in place');
-- An identity connected elsewhere: refused as a whole, truthfully (no 'failed', no secret, state kept).
select postona_xt.refuse(:'B', postona_xt.complete_sql('B1', :'AX', 'Postona_A', 'fakeXaccessTOKENforB00001', 'fakeXrefreshTOKENforB0001'),
                         'P0001 X_ACCOUNT_ALREADY_CONNECTED', 'B: identity connected to A');
-- A squat made through the live path before the switch still blocks the real owner on v2; only an
-- operator can clear it (see the rollout plan). After that, V connects.
select postona_xt.accept(:'V', postona_xt.begin_sql('V2'), 'v2 begin V2');
select postona_xt.refuse(:'V', postona_xt.complete_sql('V2', :'VX', 'Victim_Handle', 'fakeXaccessTOKENforV00002', 'fakeXrefreshTOKENforV0002'),
                         'P0001 X_ACCOUNT_ALREADY_CONNECTED', 'V: the earlier live squat still blocks v2');
update public.social_accounts set platform_user_id = null, connection_status = 'failed', last_connection_error_code = 'OPERATOR_IDENTITY_RELEASED'
 where id = postona_xt.x_id(:'P');
select postona_xt.accept(:'V', postona_xt.complete_sql('V2', :'VX', 'Victim_Handle', 'fakeXaccessTOKENforV00002', 'fakeXrefreshTOKENforV0002'),
                         'V connects after the squat is released');
-- A Vault failure leaves nothing behind (TEST-ONLY injected failure, from PR #124's fixture).
select postona_xt.refuse(:'B', postona_xt.complete_sql('B1', '1700000000000000103', 'b', 'fakeFAILVAULT_x_access_b1', 'fakeXrefreshTOKENforB0001'),
                         'P0001 VAULT_UNAVAILABLE', 'B: Vault failure');
-- Credential shapes.
select postona_xt.accept(:'W', postona_xt.begin_sql('W1'), 'v2 begin W1');
insert into vault.secrets (name, secret) values (postona_xt.x_id(:'W') || '_refresh_token', 'fake_leftover');
select postona_xt.refuse(:'W', postona_xt.complete_sql('W1', '1700000000000000104', 'w', 'fakeXaccessTOKENforW00001', 'fakeXrefreshTOKENforW0001'),
                         'P0001 X_CREDENTIAL_SHAPE_INVALID', 'W: leftover named secret');
delete from vault.secrets where name = postona_xt.x_id(:'W') || '_refresh_token';
update public.social_accounts set vault_refresh_token_secret_id = :'a_refresh' where id = postona_xt.x_id(:'W');
select postona_xt.refuse(:'W', postona_xt.complete_sql('W1', '1700000000000000104', 'w', 'fakeXaccessTOKENforW00001', 'fakeXrefreshTOKENforW0001'),
                         'P0001 X_CREDENTIAL_SHAPE_INVALID', 'W: reference shared with A');
update public.social_accounts set vault_refresh_token_secret_id = gen_random_uuid() where id = postona_xt.x_id(:'W');
select postona_xt.refuse(:'W', postona_xt.complete_sql('W1', '1700000000000000104', 'w', 'fakeXaccessTOKENforW00001', 'fakeXrefreshTOKENforW0001'),
                         'P0001 X_CREDENTIAL_SHAPE_INVALID', 'W: dangling reference');
insert into vault.secrets (name, secret) values ('fake_w_both', 'fake_both') returning id as w_both \gset
update public.social_accounts set vault_access_token_secret_id = :'w_both', vault_refresh_token_secret_id = :'w_both' where id = postona_xt.x_id(:'W');
select postona_xt.refuse(:'W', postona_xt.complete_sql('W1', '1700000000000000104', 'w', 'fakeXaccessTOKENforW00001', 'fakeXrefreshTOKENforW0001'),
                         'P0001 X_CREDENTIAL_SHAPE_INVALID', 'W: one secret for both');
update public.social_accounts set vault_access_token_secret_id = null, vault_refresh_token_secret_id = null where id = postona_xt.x_id(:'W');
select postona_xt.accept(:'W', postona_xt.complete_sql('W1', '1700000000000000104', 'w', 'fakeXaccessTOKENforW00001', 'fakeXrefreshTOKENforW0001'), 'W: clean');
-- No longer the owner between begin and complete.
select postona_xt.accept(:'Y', postona_xt.begin_sql('Y1'), 'v2 begin Y1');
update public.brand_memberships set role = 'member' where user_id = :'Y';
select postona_xt.refuse(:'Y', postona_xt.complete_sql('Y1', '1700000000000000105', 'y', 'fakeXaccessTOKENforY00001', 'fakeXrefreshTOKENforY0001'),
                         'P0001 SOCIAL_MOBILE_ACCOUNT_NOT_OWNED', 'Y: no longer owner');
select postona_xt.refuse(:'Y', postona_xt.consume_sql('Y1'), 'P0001 OAUTH_STATE_NOT_CONSUMABLE', 'Y: consume no longer owner');
update public.brand_memberships set role = 'owner' where user_id = :'Y';
-- A connection made through the live path keeps working and reconnects through v2 in place.
select postona_xt.accept(:'C', postona_xt.live_complete_sql('C0', '1700000000000000106', 'Postona_C', 'fakeXaccessTOKENforC00000', 'fakeXrefreshTOKENforC0000'),
                         'live complete C0', false);
select vault_access_token_secret_id as c_access, vault_refresh_token_secret_id as c_refresh from public.social_accounts where id = postona_xt.x_id(:'C') \gset
select postona_xt.accept(:'C', postona_xt.complete_sql('C1', '1700000000000000106', 'Postona_C', 'fakeXaccessTOKENforC00001', 'fakeXrefreshTOKENforC0001'),
                         'v2 reconnect of a live connection');
select postona_xt.ok((select vault_access_token_secret_id = :'c_access'::uuid and vault_refresh_token_secret_id = :'c_refresh'::uuid
                      from public.social_accounts where id = postona_xt.x_id(:'C')), 'C: same references');
\echo POSTONA_X_OAUTH_COMPLETE_PASS

-- 9. The lifecycle moves between v2 begin and complete -------------------------------------------------
select postona_xt.accept(:'R', postona_xt.begin_sql('R1'), 'v2 begin R1');
set role service_role;
select postona_xt.ok(public.begin_service_deletion(:'R', 'x_autopost') ->> 'status' = 'started', 'R: service deletion begins');
reset role;
select postona_xt.refuse(:'R', postona_xt.consume_sql('R1'), '42501 SERVICE_DELETION_IN_PROGRESS', 'R: consume');
select postona_xt.refuse(:'R', postona_xt.complete_sql('R1', '1700000000000000107', 'r', 'fakeXaccessTOKENforR00001', 'fakeXrefreshTOKENforR0001'),
                         '42501 SERVICE_DELETION_IN_PROGRESS', 'R: complete');
select postona_xt.accept(:'S', postona_xt.begin_sql('S1'), 'v2 begin S1');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'S' and service_key = 'x_autopost';
select postona_xt.refuse(:'S', postona_xt.complete_sql('S1', '1700000000000000108', 's', 'fakeXaccessTOKENforS00001', 'fakeXrefreshTOKENforS0001'),
                         '42501 SERVICE_NOT_ACTIVE', 'S: complete after the service ended');
select postona_xt.accept(:'T', postona_xt.begin_sql('T1'), 'v2 begin T1');
select lifecycle_version as t_version from public.common_accounts where user_id = :'T' \gset
set role service_role;
select postona_xt.ok(public.begin_common_account_deletion(:'T', :'t_version') ->> 'status' = 'started', 'T: account deletion begins');
reset role;
select postona_xt.refuse(:'T', postona_xt.complete_sql('T1', '1700000000000000109', 't', 'fakeXaccessTOKENforT00001', 'fakeXrefreshTOKENforT0001'),
                         '42501 ACCOUNT_DELETION_IN_PROGRESS', 'T: complete');
\echo POSTONA_X_OAUTH_LIFECYCLE_PASS

-- 10. The switch, simulated: revoke the live RPCs from authenticated. The preclaim path closes; existing
--     connections are untouched; v2 keeps working.
select string_agg(sa::text, ',' order by sa.id) as accounts_before from public.social_accounts sa where sa.platform = 'x' \gset
revoke execute on function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz),
                           public.consume_social_mobile_x_oauth_state(text),
                           public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) from authenticated;
select postona_xt.ok((select string_agg(sa::text, ',' order by sa.id) from public.social_accounts sa where sa.platform = 'x') = :'accounts_before',
                     'switch: X rows unchanged');
select postona_xt.refuse(:'P', postona_xt.live_begin_sql('P9'), '42501 permission denied for function begin_social_mobile_x_oauth_connection',
                         'switch: live begin closed');
select postona_xt.refuse(:'P', postona_xt.live_complete_sql('P1', '1700000000000000999', 'x', 'made-up', 'made-up-2'),
                         '42501 permission denied for function complete_social_mobile_x_oauth_connection', 'switch: live complete closed');
select postona_xt.accept(:'A', postona_xt.begin_sql('A5'), 'switch: v2 begin still works');
\echo POSTONA_X_OAUTH_SWITCH_PASS

-- 11. Nothing in the lifecycle changed for the people who connected; nothing publishes. -----------------
select postona_xt.ok(postona_xt.lifecycle(array[:'A', :'B', :'C', :'W', :'Y', :'V']::uuid[]) = :'lifecycle_before', 'lifecycle untouched');
select postona_xt.ok((select count(*) from public.social_accounts where publish_enabled) = 0, 'nothing publishes');
\echo POSTONA_X_OAUTH_BEHAVIOR_PASS
