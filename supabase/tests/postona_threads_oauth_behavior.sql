-- Behavior proof for the POSTONA Threads OAuth / workspace candidate
-- (supabase/candidates/postona_threads_oauth_workspace_candidate.sql). Run by postona_threads_oauth_run.sh
-- as the non-superuser table owner on a disposable database, after the candidate and the runner's
-- TEST-ONLY grant of EXECUTE on the three RPCs to authenticated. psql variables: mock (true when the
-- T13 stand-in is in place: the call-order checks are MOCK_ONLY), g5 (true with G5's own guard
-- candidate), owner (this run's owner role). Fake data only.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

\set A '00000000-0000-4000-8000-00000000a001'
\set B '00000000-0000-4000-8000-00000000a002'
\set C '00000000-0000-4000-8000-00000000a003'
\set D '00000000-0000-4000-8000-00000000a004'
\set E '00000000-0000-4000-8000-00000000a005'
\set F '00000000-0000-4000-8000-00000000a006'
\set G '00000000-0000-4000-8000-00000000a007'
\set H '00000000-0000-4000-8000-00000000a008'
\set I '00000000-0000-4000-8000-00000000a009'
\set J '00000000-0000-4000-8000-00000000a00a'
\set K '00000000-0000-4000-8000-00000000a00b'
\set L '00000000-0000-4000-8000-00000000a00c'
\set M '00000000-0000-4000-8000-00000000a00d'
\set N '00000000-0000-4000-8000-00000000a00e'
\set O '00000000-0000-4000-8000-00000000a00f'
\set R '00000000-0000-4000-8000-00000000a010'
\set S '00000000-0000-4000-8000-00000000a011'
\set T '00000000-0000-4000-8000-00000000a012'
\set U '00000000-0000-4000-8000-00000000a013'
\set V '00000000-0000-4000-8000-00000000a014'
\set W '00000000-0000-4000-8000-00000000a015'
\set Y '00000000-0000-4000-8000-00000000a016'
\set Z '00000000-0000-4000-8000-00000000a017'
\set Q '00000000-0000-4000-8000-00000000a018'

-- 0. Test helpers (test schema of this disposable database only) -------------------------------------
create schema postona_t;
grant usage on schema postona_t to anon, authenticated, service_role;
-- The T13 mode, for this and later sessions (the runner's races).
create table postona_t.config as select :'mock'::boolean as mock;
grant select on postona_t.config to public;

create function postona_t.h(p_tag text) returns text language sql immutable
as $$ select encode(sha256(convert_to('state:' || p_tag, 'UTF8')), 'hex') $$;
create function postona_t.ws(p_user uuid) returns text language sql immutable
as $$ select public.social_mobile_account_deletion_workspace(p_user) $$;
create function postona_t.threads_id(p_user uuid) returns text language sql immutable
as $$ select 'sa_' || substr(md5(postona_t.ws(p_user) || ':threads'), 1, 24) $$;
create function postona_t.session_of(p_user uuid) returns uuid language sql immutable
as $$ select md5('session:' || p_user::text)::uuid $$;

-- The server attestation, written independently of the candidate (and of the TS module, which checks
-- the same known answer below).
create function postona_t.attest(p_state uuid, p_puid text, p_handle text, p_token text) returns text language sql immutable
as $$
  select encode(extensions.hmac(
    convert_to(concat_ws(chr(10), 'postona-threads-connect-v1', p_state::text, p_puid, coalesce(p_handle, ''),
                         encode(sha256(convert_to(p_token, 'UTF8')), 'hex')), 'UTF8'),
    convert_to('fake_attestation_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex')
$$;

-- A login with a live session (the session is what G5's guard reads; the stand-in ignores it).
create function postona_t.login(p_user uuid) returns void language plpgsql as $$
begin
  perform public.fixture_login(p_user);
  insert into auth.sessions (id, user_id) values (postona_t.session_of(p_user), p_user) on conflict (id) do nothing;
end $$;

-- The JWT claims as an older PostgREST sets them (auth.uid() reads these first).
create function postona_t.act(p_user uuid, p_claim_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(p_claim_role, ''), true);
  perform set_config('request.jwt.claim.session_id', coalesce(postona_t.session_of(p_user)::text, ''), true);
end $$;

create function postona_t.register(p_user uuid, p_service text default 'x_autopost') returns text language plpgsql as $$
declare v jsonb;
begin
  perform postona_t.act(p_user);
  v := case p_service when 'x_autopost' then public.start_x_autopost_service() else public.start_kabumori_service() end;
  perform postona_t.act(null, '');
  return v::text;
end $$;

-- MOCK_ONLY: in this transaction, the first logged step is the guard (the stand-in logs each call;
-- the zz_postona_mock_log triggers log every row written to the candidate's tables).
create function postona_t.t13_first(p_label text) returns void language plpgsql as $$
declare v_first text; v_t13 integer; v_writes integer;
begin
  select c.what into v_first from postona_mock.calls c where c.tx = pg_current_xact_id() order by c.seq limit 1;
  select count(*) filter (where c.what = 'T13'), count(*) filter (where c.what like 'write:%')
    into v_t13, v_writes from postona_mock.calls c where c.tx = pg_current_xact_id();
  if v_first is distinct from 'T13' then
    raise exception 'FAIL (MOCK_ONLY) %: first logged step is %, not T13', p_label, coalesce(v_first, '<none>');
  end if;
end $$;

-- Runs one statement as an API role with a person's claims; 'OK' or '<SQLSTATE> <message>'. A
-- successful guarded call (the candidate's RPCs) must have run the guard first (MOCK_ONLY check);
-- p_guarded => false for the existing X RPCs, which have no guard.
create function postona_t.call(p_user uuid, p_sql text, p_role text default 'authenticated',
                               p_claim_role text default 'authenticated', p_guarded boolean default true)
returns text language plpgsql as $$
declare v_msg text; v_state text;
begin
  perform postona_t.act(p_user, p_claim_role);
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
  end;
  perform postona_t.act(null, '');
  if v_state is null and p_guarded and (select c.mock from postona_t.config c) then
    perform postona_t.t13_first(p_sql);
  end if;
  return coalesce(v_state || ' ' || v_msg, 'OK');
end $$;

-- Every row the candidate or the lifecycle could touch, as one comparable value.
create function postona_t.snapshot() returns text language sql stable set timezone = 'UTC' as $$
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
create function postona_t.lifecycle(p_users uuid[]) returns text language sql stable set timezone = 'UTC' as $$
  select concat_ws('|',
    (select string_agg(t::text, ',' order by t.user_id) from public.common_accounts t where t.user_id = any (p_users)),
    (select string_agg(t::text, ',' order by t.user_id, t.service_key) from public.service_entitlements t where t.user_id = any (p_users)),
    (select string_agg(t::text, ',' order by t.id) from private.account_lifecycle_operations t where t.user_id = any (p_users)))
$$;

create function postona_t.refuse(p_user uuid, p_sql text, p_want text, p_label text,
                                 p_role text default 'authenticated', p_claim_role text default 'authenticated')
returns void language plpgsql as $$
declare v_before text := postona_t.snapshot(); v_got text;
begin
  v_got := postona_t.call(p_user, p_sql, p_role, p_claim_role);
  if v_got is null or v_got not like p_want then
    raise exception 'FAIL %: got %, want %', p_label, coalesce(v_got, '<null>'), p_want;
  end if;
  if postona_t.snapshot() is distinct from v_before then
    raise exception 'FAIL %: the refused call changed something', p_label;
  end if;
end $$;
create function postona_t.accept(p_user uuid, p_sql text, p_label text) returns void language plpgsql as $$
declare v_got text := postona_t.call(p_user, p_sql);
begin
  if v_got is distinct from 'OK' then raise exception 'FAIL %: %', p_label, v_got; end if;
end $$;
create function postona_t.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL %', p_label; end if;
end $$;

create function postona_t.begin_sql(p_tag text, p_ttl interval default '5 minutes',
                                    p_redirect text default 'https://app.postona.test/oauth/threads/callback')
returns text language sql stable as $$
  select format('select * from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + %L::interval)',
                postona_t.h(p_tag), p_redirect, p_ttl)
$$;
create function postona_t.consume_sql(p_tag text) returns text language sql stable as $$
  select format('select * from public.consume_social_mobile_threads_oauth_state(%L)', postona_t.h(p_tag))
$$;
create function postona_t.state_id(p_tag text) returns uuid language sql stable as $$
  select s.id from public.social_account_oauth_states s where s.state_hash = postona_t.h(p_tag)
$$;
-- complete() for the state of p_tag, attested over exactly what is sent unless an attestation is given.
create function postona_t.complete_sql(p_tag text, p_puid text, p_handle text, p_token text, p_attestation text default null,
                                       p_state uuid default null)
returns text language sql stable as $$
  select format('select public.complete_social_mobile_threads_oauth_connection(%L, %L, %L, %L, %L)',
                coalesce(p_state, postona_t.state_id(p_tag)), p_puid, p_handle, p_token,
                coalesce(p_attestation, postona_t.attest(coalesce(p_state, postona_t.state_id(p_tag)), p_puid, p_handle, p_token)))
$$;
create function postona_t.x_begin_sql(p_tag text) returns text language sql stable as $$
  select format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')',
                postona_t.h(p_tag), 'kabumori-social://oauth-callback')
$$;
-- Known answer shared with threads_connect_rpc_contract_test.ts.
select postona_t.ok(postona_t.attest('00000000-0000-4000-8000-0000000000aa', '17841400000000001', 'postona.test',
                                     'fakeTHREADSaccessTOKEN0001')
                    = 'f13d6e3ec49ed569b7d63ba2c565136b9d5bcd39eeedf60b032c88cb564e60a9', 'attestation known answer (handle)');
select postona_t.ok(postona_t.attest('00000000-0000-4000-8000-0000000000aa', '17841400000000001', null,
                                     'fakeTHREADSaccessTOKEN0001')
                    = '04722f619c1cca7ca60ec8c804a30253016ddb21f7a9a950b5462fefbf3859cd', 'attestation known answer (no handle)');

-- 1. The people ------------------------------------------------------------------------------------------
select postona_t.login(u::uuid) from (values (:'A'), (:'B'), (:'C'), (:'D'), (:'E'), (:'F'), (:'G'), (:'H'), (:'I'), (:'J'),
  (:'K'), (:'L'), (:'M'), (:'N'), (:'O'), (:'R'), (:'S'), (:'T'), (:'U'), (:'V'), (:'W'), (:'Y'), (:'Q')) v(u);
select postona_t.register(u::uuid) from (values (:'A'), (:'B'), (:'C'), (:'D'), (:'E'), (:'G'), (:'H'), (:'K'), (:'L'), (:'M'),
  (:'N'), (:'O'), (:'R'), (:'S'), (:'T'), (:'U'), (:'V'), (:'W'), (:'Y'), (:'Q')) v(u);
select postona_t.register(:'J', 'kabumori');
select postona_t.ok((select count(*) from public.service_entitlements
                     where service_key = 'x_autopost' and status = 'active' and user_id::text like '00000000-0000-4000-8000-00000000a%') = 20,
                    'setup: 20 x_autopost registrations');
-- K: a service deletion in progress; L: the service ended; M: an account deletion in progress; N: locked.
-- (Each through the real lifecycle RPCs, as the backend calls them.)
select lifecycle_version as m_version from public.common_accounts where user_id = :'M' \gset
set role service_role;
select postona_t.ok(public.begin_service_deletion(:'K', 'x_autopost') ->> 'status' = 'started', 'setup K');
select public.begin_service_deletion(:'L', 'x_autopost') ->> 'operation_id' as l_operation \gset
select postona_t.ok(public.finish_service_deletion(:'L', 'x_autopost', :'l_operation') ->> 'status' = 'ended', 'setup L end');
select postona_t.ok(public.begin_common_account_deletion(:'M', :'m_version') ->> 'status' = 'started', 'setup M');
reset role;
update public.common_accounts set status = 'locked' where user_id = :'N';
-- O: a social-mobile deletion tombstone. D owns another workspace. E's workspace has a second member;
-- V's is owned by someone else; G's is not self-service; H is only an admin of its own; U's has another
-- Threads row.
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
values (:'O', postona_t.ws(:'O'), 'started', 'social_only', '[]');
insert into public.brands (id, code_profile_key) values ('legacy_d', 'social_mobile_user_v1');
insert into public.brand_memberships values ('legacy_d', :'D', 'owner');
insert into public.brands (id, is_active, publish_mode) values (postona_t.ws(:'E'), false, 'disabled'), (postona_t.ws(:'V'), false, 'disabled'),
  (postona_t.ws(:'H'), false, 'disabled'), (postona_t.ws(:'U'), false, 'disabled');
insert into public.brands (id, code_profile_key) values (postona_t.ws(:'G'), 'kabumori_v1');
insert into public.brand_memberships values (postona_t.ws(:'E'), :'E', 'owner'), (postona_t.ws(:'E'), :'F', 'member'),
  (postona_t.ws(:'V'), :'F', 'owner'), (postona_t.ws(:'G'), :'G', 'owner'), (postona_t.ws(:'H'), :'H', 'admin'),
  (postona_t.ws(:'U'), :'U', 'owner');
insert into public.social_accounts (id, brand_id, platform, publish_enabled, connection_status)
values ('sa_legacy_threads_u', postona_t.ws(:'U'), 'threads', false, 'unconnected');

select postona_t.lifecycle(array[:'A', :'B', :'C', :'W', :'Y']::uuid[]) as lifecycle_before \gset

-- 2. Reachability: only the three RPCs, only by authenticated (TEST-ONLY grant), never the provisioner or
--    the guard; anon and service_role nothing; no way to become the owner. -----------------------------
select postona_t.ok(has_function_privilege('authenticated', 'public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz)', 'EXECUTE')
                    and has_function_privilege('authenticated', 'public.consume_social_mobile_threads_oauth_state(text)', 'EXECUTE')
                    and has_function_privilege('authenticated', 'public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)', 'EXECUTE'),
                    'test grant in place');
select postona_t.ok(not exists (
  select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role),
       (values ('private.social_mobile_ensure_personal_workspace(uuid)'),
               ('private.account_lifecycle_assert_active_service_write(uuid,text)')) f(fn)
  where has_function_privilege(r.role, f.fn::regprocedure, 'EXECUTE')), 'provisioner and guard unreachable');
select postona_t.ok(not exists (
  select 1 from (values ('anon'), ('service_role')) r(role),
       (values ('public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz)'),
               ('public.consume_social_mobile_threads_oauth_state(text)'),
               ('public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text)')) f(fn)
  where has_function_privilege(r.role, f.fn::regprocedure, 'EXECUTE')), 'anon and service_role reach no RPC');
select postona_t.refuse(:'A', postona_t.begin_sql('anon'), '42501 permission denied for function begin_social_mobile_threads_oauth_connection', 'anon begin', 'anon', 'anon');
select postona_t.refuse(:'A', postona_t.consume_sql('anon'), '42501 permission denied for function consume_social_mobile_threads_oauth_state', 'anon consume', 'anon', 'anon');
select postona_t.refuse(:'A', postona_t.begin_sql('svc'), '42501 permission denied for function begin_social_mobile_threads_oauth_connection', 'service_role begin', 'service_role', 'service_role');
select postona_t.refuse(:'A', postona_t.complete_sql('none', '17841400000000001', null, 'fakeTHREADStokenSVC01', null, gen_random_uuid()),
                        '42501 permission denied for function complete_social_mobile_threads_oauth_connection', 'service_role complete', 'service_role', 'service_role');
select postona_t.refuse(:'A', format('select private.social_mobile_ensure_personal_workspace(%L)', :'A'),
                        '42501 permission denied for function social_mobile_ensure_personal_workspace', 'authenticated provisioner');
select postona_t.refuse(:'A', format('select private.account_lifecycle_assert_active_service_write(%L, %L)', :'A', 'x_autopost'),
                        '42501 permission denied for function account_lifecycle_assert_active_service_write', 'authenticated guard');
-- No API role can become the owner (SET ROLE is decided by the session's login role, so this is a
-- catalog fact here, not a call).
select postona_t.ok(not exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role)
                                where pg_has_role(r.role, :'owner', 'MEMBER') or pg_has_role(r.role, :'owner', 'SET')),
                    'no API role is a member of the owner');
-- The claims must name an authenticated person: a service-role token, no subject, or no claims at all.
select postona_t.refuse(:'A', postona_t.begin_sql('svcclaim'), '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'service_role claim', 'authenticated', 'service_role');
select postona_t.refuse(null, postona_t.begin_sql('nosub'), '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'no subject');
select postona_t.refuse(:'A', postona_t.consume_sql('anonclaim'), '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'anon claim', 'authenticated', 'anon');
-- Even the owner cannot provision outside a guarded call: the provisioner calls the guard itself.
select postona_t.refuse(null, format('select private.social_mobile_ensure_personal_workspace(%L)', :'A'),
                        '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'owner provisioner without claims', :'owner', '');
select postona_t.refuse(:'B', format('select private.social_mobile_ensure_personal_workspace(%L)', :'A'),
                        '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'provisioner for another person', :'owner');
select postona_t.refuse(:'A', 'select private.social_mobile_ensure_personal_workspace(null)',
                        'P0001 SOCIAL_MOBILE_WORKSPACE_USER_REQUIRED', 'provisioner without a person', :'owner');
-- 2a-2's reviewed list of SECURITY DEFINER writers of social_accounts gains exactly the Threads begin and
-- complete (the provisioner is SECURITY INVOKER and writes no social account): the activation migration
-- must extend that list with these two and nothing else.
select postona_t.ok((select string_agg(p.proname, ',' order by p.proname) from pg_proc p
                     where p.prosecdef and p.prosrc ~* '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+(public\.)?social_accounts'
                       and p.proname not in ('begin_social_mobile_x_oauth_connection', 'complete_social_mobile_x_oauth_connection',
                                             'record_x_account_access_unauthorized', 'set_social_account_publish_enabled',
                                             'social_mobile_account_deletion_acquire', 'social_mobile_account_deletion_purge',
                                             'x_account_refresh_health_mirror'))
                    = 'begin_social_mobile_threads_oauth_connection,complete_social_mobile_threads_oauth_connection',
                    'new SECURITY DEFINER writers of social_accounts: exactly the Threads begin and complete');
\echo POSTONA_THREADS_OAUTH_REACHABILITY_PASS

-- 3. The guard (T13) decides before anything else: every refusal, for each RPC, writes nothing. ------------
select postona_t.refuse(p.who::uuid, f.sql, '42501 ' || p.code, 'guard ' || p.code || ' ' || f.rpc)
from (values (:'I', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'), (:'Z', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'),
             (:'J', 'SERVICE_NOT_REGISTERED'), (:'K', 'SERVICE_DELETION_IN_PROGRESS'), (:'L', 'SERVICE_NOT_ACTIVE'),
             (:'M', 'ACCOUNT_DELETION_IN_PROGRESS'), (:'N', 'ACCOUNT_LOCKED')) p(who, code),
     lateral (values ('begin', postona_t.begin_sql('guard' || p.who)), ('consume', postona_t.consume_sql('guard' || p.who)),
                     ('complete', postona_t.complete_sql('guard', '17841400000000009', null, 'fakeTHREADSguardTOKEN', null,
                                                         md5(p.who)::uuid))) f(rpc, sql);
select postona_t.ok((select count(*) from public.brands where id in (postona_t.ws(:'I'), postona_t.ws(:'J'), postona_t.ws(:'K'),
                     postona_t.ws(:'L'), postona_t.ws(:'M'), postona_t.ws(:'N'), postona_t.ws(:'Z'))) = 0, 'no workspace for a refused person');
-- READ COMMITTED only.
begin isolation level repeatable read;
select postona_t.refuse(:'A', postona_t.begin_sql('rr'), '42501 ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE', 'repeatable read');
commit;
begin isolation level serializable;
select postona_t.refuse(:'A', postona_t.consume_sql('ser'), '42501 ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE', 'serializable');
commit;
\if :g5
-- G5's guard only: a revoked session (logout) refuses even an otherwise valid person.
delete from auth.sessions where user_id = :'Q';
select postona_t.refuse(:'Q', postona_t.begin_sql('revoked'), '42501 ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'g5: revoked session');
\endif
-- After the guard, a social-mobile deletion in progress (tombstone) refuses provisioning.
select postona_t.refuse(:'O', postona_t.begin_sql('tomb'), 'P0001 SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS', 'tombstone');
\echo POSTONA_THREADS_OAUTH_GUARD_PASS

-- 4. T9: the one personal workspace ----------------------------------------------------------------------
select postona_t.accept(:'A', postona_t.begin_sql('A1'), 'begin A1');
select postona_t.ok(((select count(*) from postona_mock.calls where what = 'T13') > 0) = (:'mock' = 'true')
                    and (select count(*) from postona_mock.calls where what like 'write:%') > 0, 'call log is live');
select postona_t.ok((select row(b.display_name, b.is_active, b.publish_mode, b.code_profile_key)::text from public.brands b where b.id = postona_t.ws(:'A'))
                    = '("My Workspace",f,disabled,social_mobile_user_v1)', 'A: workspace shape');
select postona_t.ok((select string_agg(m.user_id || ':' || m.role, ',') from public.brand_memberships m where m.brand_id = postona_t.ws(:'A'))
                    = :'A' || ':owner', 'A: one owner membership');
select postona_t.ok((select row(sa.id, sa.platform, sa.handle, sa.publish_enabled, sa.connection_status, sa.platform_user_id,
                                sa.vault_access_token_secret_id, sa.vault_refresh_token_secret_id)::text
                     from public.social_accounts sa where sa.brand_id = postona_t.ws(:'A'))
                    = format('(%s,threads,pending,f,authorization_pending,,,)', postona_t.threads_id(:'A')), 'A: pending Threads row');
select postona_t.ok((select row(s.social_account_id, s.brand_id, s.code_verifier_vault_secret_id, s.redirect_uri, s.consumed_at,
                                s.initiated_by_user_id, s.expires_at > now(), s.expires_at <= now() + interval '10 minutes')::text
                     from public.social_account_oauth_states s where s.state_hash = postona_t.h('A1'))
                    = format('(%s,%s,,https://app.postona.test/oauth/threads/callback,,%s,t,t)', postona_t.threads_id(:'A'), postona_t.ws(:'A'), :'A'),
                    'A: state bound to person, workspace and Threads row');
-- Idempotent: the same workspace, membership and row; one more state.
select postona_t.accept(:'A', postona_t.begin_sql('A2'), 'begin A2');
select postona_t.accept(:'A', postona_t.begin_sql('A3', '10 minutes'), 'begin A3 (10 minute limit)');
select postona_t.ok((select count(*) from public.brands where id = postona_t.ws(:'A')) = 1
                    and (select count(*) from public.brand_memberships where user_id = :'A') = 1
                    and (select count(*) from public.social_accounts where brand_id = postona_t.ws(:'A')) = 1
                    and (select count(*) from public.social_account_oauth_states where initiated_by_user_id = :'A') = 3, 'A: idempotent');
-- The X flow's workspace is the same workspace, in either order.
select postona_t.ok(postona_t.call(:'C', postona_t.x_begin_sql('CX1'), p_guarded => false) = 'OK', 'C: X begin');
select postona_t.accept(:'C', postona_t.begin_sql('C1'), 'begin C1 after X');
select postona_t.ok((select count(*) from public.brand_memberships where user_id = :'C') = 1
                    and (select string_agg(platform, ',' order by platform) from public.social_accounts where brand_id = postona_t.ws(:'C')) = 'threads,x',
                    'C: Threads joins the X workspace');
select postona_t.accept(:'B', postona_t.begin_sql('B1'), 'begin B1');
select postona_t.ok(postona_t.call(:'B', postona_t.x_begin_sql('BX1'), p_guarded => false) = 'OK', 'B: X begin after Threads');
select postona_t.ok((select count(*) from public.brand_memberships where user_id = :'B') = 1
                    and (select string_agg(platform, ',' order by platform) from public.social_accounts where brand_id = postona_t.ws(:'B')) = 'threads,x',
                    'B: X joins the Threads workspace');
-- Never another person's, a shared, a foreign, a non-self-service or a non-owned workspace.
select postona_t.refuse(:'D', postona_t.begin_sql('D1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_CONFLICT', 'D: owns another workspace');
select postona_t.refuse(:'E', postona_t.begin_sql('E1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_SHARED', 'E: shared workspace');
select postona_t.refuse(:'V', postona_t.begin_sql('V1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_SHARED', 'V: workspace owned by someone else');
select postona_t.refuse(:'G', postona_t.begin_sql('G1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_NOT_SELF_SERVICE', 'G: not self-service');
select postona_t.refuse(:'H', postona_t.begin_sql('H1'), 'P0001 SOCIAL_MOBILE_WORKSPACE_ROLE_MISMATCH', 'H: admin, not owner');
select postona_t.refuse(:'U', postona_t.begin_sql('U1'), 'P0001 THREADS_ACCOUNT_CONFLICT', 'U: another Threads row');
\echo POSTONA_THREADS_OAUTH_WORKSPACE_PASS

-- 5. begin(): input shape, before the guard --------------------------------------------------------------
select postona_t.refuse(:'A', s, 'P0001 THREADS_OAUTH_STATE_INPUT_INVALID', 'begin input ' || s) from (values
  (format('select * from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''5 minutes'')', upper(postona_t.h('x')), 'https://a.test/cb')),
  (format('select * from public.begin_social_mobile_threads_oauth_connection(%L, %L, now() + interval ''5 minutes'')', left(postona_t.h('x'), 63), 'https://a.test/cb')),
  ('select * from public.begin_social_mobile_threads_oauth_connection(null, ''https://a.test/cb'', now() + interval ''5 minutes'')'),
  (postona_t.begin_sql('i1', '5 minutes', 'http://a.test/cb')),
  (postona_t.begin_sql('i2', '5 minutes', 'https://a.test/cb#frag')),
  (postona_t.begin_sql('i3', '5 minutes', 'https://user@a.test/cb')),
  (postona_t.begin_sql('i4', '5 minutes', 'https://a.test/c b')),
  (postona_t.begin_sql('i5', '5 minutes', 'https://*.a.test/cb')),
  (postona_t.begin_sql('i6', '5 minutes', 'kabumori-social://oauth-callback')),
  (postona_t.begin_sql('i7', '5 minutes', 'https://a.test/' || repeat('p', 2034))),
  (format('select * from public.begin_social_mobile_threads_oauth_connection(%L, null, now() + interval ''5 minutes'')', postona_t.h('i8'))),
  (postona_t.begin_sql('i9', '-1 second')),
  (postona_t.begin_sql('i10', '10 minutes 1 second')),
  (format('select * from public.begin_social_mobile_threads_oauth_connection(%L, %L, null)', postona_t.h('i11'), 'https://a.test/cb')),
  -- a state hash already used: this person's, another person's (as a probe) or an X state's
  (postona_t.begin_sql('A1')), (postona_t.begin_sql('B1')), (postona_t.begin_sql('CX1'))) v(s);
select postona_t.accept(:'A', postona_t.begin_sql('i12', '5 minutes', 'https://a.test/' || repeat('p', 2033)), 'redirect of 2048');
-- Shape is checked before the guard; whether a hash is in use is decided only after it, so a refused
-- person cannot probe for states.
select postona_t.refuse(:'L', postona_t.begin_sql('L9', '5 minutes', 'http://a.test/cb'), 'P0001 THREADS_OAUTH_STATE_INPUT_INVALID', 'ended person, bad shape');
select postona_t.refuse(:'L', postona_t.begin_sql('A1'), '42501 SERVICE_NOT_ACTIVE', 'ended person, used hash');
\echo POSTONA_THREADS_OAUTH_BEGIN_INPUT_PASS

-- 6. consume(): read-only, this person's own Threads state only -------------------------------------------
select postona_t.snapshot() as snap_c \gset
begin;
select postona_t.act(:'A');
set local role authenticated;
select oauth_state_id as c_id, redirect_uri as c_redirect, brand_id as c_brand, social_account_id as c_account
  from public.consume_social_mobile_threads_oauth_state(postona_t.h('A1')) \gset
reset role;
commit;
select postona_t.ok(:'c_id'::uuid = postona_t.state_id('A1') and :'c_redirect' = 'https://app.postona.test/oauth/threads/callback'
                    and :'c_brand' = postona_t.ws(:'A') and :'c_account' = postona_t.threads_id(:'A'), 'consume A1 returns the state');
select postona_t.accept(:'A', postona_t.consume_sql('A1'), 'consume again (read-only)');
select postona_t.ok(postona_t.snapshot() = :'snap_c', 'consume wrote nothing');
-- X state in this person's own workspace, another person's state, a state of this person's workspace
-- started by someone else, a state pointing at another workspace, expired, malformed.
select postona_t.ok(postona_t.call(:'A', postona_t.x_begin_sql('AX1'), p_guarded => false) = 'OK', 'A: X begin');
insert into public.social_account_oauth_states (social_account_id, brand_id, state_hash, redirect_uri, expires_at, initiated_by_user_id)
values (postona_t.threads_id(:'A'), postona_t.ws(:'A'), postona_t.h('A-by-B'), 'https://a.test/cb', now() + interval '5 minutes', :'B'),
       (postona_t.threads_id(:'B'), postona_t.ws(:'B'), postona_t.h('B-by-A'), 'https://a.test/cb', now() + interval '5 minutes', :'A');
update public.social_account_oauth_states set expires_at = now() - interval '1 second' where state_hash = postona_t.h('A3');
-- A Threads row and state in a workspace the person owns that is not their personal one (legacy).
insert into public.social_accounts (id, brand_id, platform, publish_enabled, connection_status)
values ('sa_legacy_threads_d', 'legacy_d', 'threads', false, 'authorization_pending');
insert into public.social_account_oauth_states (social_account_id, brand_id, state_hash, redirect_uri, expires_at, initiated_by_user_id)
values ('sa_legacy_threads_d', 'legacy_d', postona_t.h('D-legacy'), 'https://a.test/cb', now() + interval '5 minutes', :'D');
select postona_t.refuse(:'D', postona_t.consume_sql('D-legacy'), 'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'consume in a legacy workspace');
select postona_t.refuse(:'D', postona_t.complete_sql('D-legacy', '17841400000000010', null, 'fakeTHREADSaccessTOKENd1'),
                        'P0001 THREADS_ACCOUNT_NOT_OWNED', 'complete in a legacy workspace');
select postona_t.refuse(p.who::uuid, postona_t.consume_sql(p.tag), 'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'consume ' || p.tag || ' as ' || p.who)
from (values (:'A', 'AX1'), (:'B', 'A1'), (:'A', 'B1'), (:'B', 'A-by-B'), (:'A', 'A-by-B'), (:'A', 'B-by-A'), (:'A', 'A3'),
             (:'A', 'missing')) p(who, tag);
select postona_t.refuse(:'A', format('select * from public.consume_social_mobile_threads_oauth_state(%L)', s), 'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'consume malformed')
from (values (upper(postona_t.h('A1'))), (left(postona_t.h('A1'), 63)), ('')) v(s);
select postona_t.refuse(:'A', 'select * from public.consume_social_mobile_threads_oauth_state(null)', 'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'consume null');
\echo POSTONA_THREADS_OAUTH_CONSUME_PASS

-- 7. complete(): attested identity, one irreversible claim -----------------------------------------------
-- Shape first (before the guard).
select postona_t.refuse(:'A', s, 'P0001 THREADS_CONNECT_INPUT_INVALID', 'complete input ' || s) from (values
  (postona_t.complete_sql('A1', '0178414', 'postona.test', 'fakeTHREADSaccessTOKENa1')),
  (postona_t.complete_sql('A1', '1784a', 'postona.test', 'fakeTHREADSaccessTOKENa1')),
  (postona_t.complete_sql('A1', '1' || repeat('7', 32), 'postona.test', 'fakeTHREADSaccessTOKENa1')),
  (postona_t.complete_sql('A1', '17841400000000001', '@postona', 'fakeTHREADSaccessTOKENa1')),
  (postona_t.complete_sql('A1', '17841400000000001', repeat('h', 31), 'fakeTHREADSaccessTOKENa1')),
  (postona_t.complete_sql('A1', '17841400000000001', '', 'fakeTHREADSaccessTOKENa1')),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'shortTOKEN15chr')),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADS access TOKEN')),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKEN' || chr(10))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', repeat('t', 4097))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1',
                          upper(postona_t.attest(postona_t.state_id('A1'), '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1')))),
  (format('select public.complete_social_mobile_threads_oauth_connection(%L, %L, %L, %L, null)', postona_t.state_id('A1'), '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1')),
  (format('select public.complete_social_mobile_threads_oauth_connection(null, %L, %L, %L, %L)', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1', repeat('a', 64))),
  (format('select public.complete_social_mobile_threads_oauth_connection(%L, null, %L, %L, %L)', postona_t.state_id('A1'), 'postona.test', 'fakeTHREADSaccessTOKENa1', repeat('a', 64))),
  (format('select public.complete_social_mobile_threads_oauth_connection(%L, %L, %L, null, %L)', postona_t.state_id('A1'), '17841400000000001', 'postona.test', repeat('a', 64)))) v(s);
-- Not vouched for by the code exchange: wrong key, another identity, handle, token or state.
select postona_t.refuse(:'A', s, 'P0001 THREADS_CONNECT_ATTESTATION_INVALID', 'attestation ' || s) from (values
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1', repeat('0', 64))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1',
                          postona_t.attest(postona_t.state_id('A1'), '17841400000000002', 'postona.test', 'fakeTHREADSaccessTOKENa1'))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1',
                          postona_t.attest(postona_t.state_id('A1'), '17841400000000001', 'other.handle', 'fakeTHREADSaccessTOKENa1'))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1',
                          postona_t.attest(postona_t.state_id('A1'), '17841400000000001', null, 'fakeTHREADSaccessTOKENa1'))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1',
                          postona_t.attest(postona_t.state_id('A1'), '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENzz'))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1',
                          postona_t.attest(postona_t.state_id('A2'), '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1'))),
  (postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1',
                          encode(extensions.hmac(convert_to(concat_ws(chr(10), 'postona-threads-connect-v1', postona_t.state_id('A1')::text,
                            '17841400000000001', 'postona.test', encode(sha256(convert_to('fakeTHREADSaccessTOKENa1', 'UTF8')), 'hex')), 'UTF8'),
                            convert_to('another_key_0123456789abcdef0123456789abcdef', 'UTF8'), 'sha256'), 'hex')))) v(s);
-- No usable key in Vault: refused before anything is locked or written.
update vault.secrets set name = 'postona_threads_connect_attestation_v0' where name = 'postona_threads_connect_attestation_v1';
select postona_t.refuse(:'A', postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1'),
                        'P0001 THREADS_CONNECT_ATTESTATION_UNAVAILABLE', 'attestation key missing');
insert into vault.secrets (name, secret) values ('postona_threads_connect_attestation_v1', 'fake_short_key_31_characters_xx');
select postona_t.refuse(:'A', postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1'),
                        'P0001 THREADS_CONNECT_ATTESTATION_UNAVAILABLE', 'attestation key too short');
delete from vault.secrets where name = 'postona_threads_connect_attestation_v1';
update vault.secrets set name = 'postona_threads_connect_attestation_v1' where name = 'postona_threads_connect_attestation_v0';
-- Not this person's Threads state (each attested, so only the binding refuses it).
select postona_t.refuse(p.who::uuid, postona_t.complete_sql(p.tag, '17841400000000001', null, 'fakeTHREADSaccessTOKENa1'),
                        'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'complete ' || p.tag || ' as ' || p.who)
from (values (:'A', 'AX1'), (:'B', 'A1'), (:'A', 'B1'), (:'B', 'A-by-B'), (:'A', 'A-by-B'), (:'A', 'B-by-A'), (:'A', 'A3')) p(who, tag);
select postona_t.refuse(:'A', postona_t.complete_sql('none', '17841400000000001', null, 'fakeTHREADSaccessTOKENa1', null, gen_random_uuid()),
                        'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'complete unknown state');

-- The success: identity, handle and the token's Vault reference; never publishing.
select postona_t.accept(:'A', postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1'), 'complete A1');
select postona_t.ok((select row(sa.platform_user_id, sa.handle, sa.publish_enabled, sa.connection_status, sa.verified_at is not null,
                                sa.vault_access_token_secret_id is not null, sa.vault_refresh_token_secret_id, sa.last_connection_error_code)::text
                     from public.social_accounts sa where sa.id = postona_t.threads_id(:'A'))
                    = '(17841400000000001,postona.test,f,identity_verified,t,t,,)', 'A: verified Threads row');
select postona_t.ok((select s.secret || '|' || s.name from vault.secrets s join public.social_accounts sa on sa.vault_access_token_secret_id = s.id
                     where sa.id = postona_t.threads_id(:'A')) = 'fakeTHREADSaccessTOKENa1|' || postona_t.threads_id(:'A') || '_access_token',
                    'A: token in Vault under the row''s name');
select postona_t.ok((select consumed_at is not null from public.social_account_oauth_states where state_hash = postona_t.h('A1')), 'A1 consumed');
select vault_access_token_secret_id as a_secret, verified_at as a_verified from public.social_accounts where id = postona_t.threads_id(:'A') \gset
-- Replay of the same state, also after consume.
select postona_t.refuse(:'A', postona_t.complete_sql('A1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENa1'),
                        'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'replay');
select postona_t.refuse(:'A', postona_t.consume_sql('A1'), 'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'consume after complete');
-- A new attempt keeps the verified identity until its own callback succeeds.
select postona_t.accept(:'A', postona_t.begin_sql('A4'), 'begin A4 (reconnect)');
select postona_t.ok((select connection_status from public.social_accounts where id = postona_t.threads_id(:'A')) = 'identity_verified',
                    'A: begin keeps identity_verified');
-- Reconnect: another identity is refused as a whole (state kept, token kept).
select postona_t.refuse(:'A', postona_t.complete_sql('A4', '17841400000000002', 'someone.else', 'fakeTHREADSaccessTOKENa4'),
                        'P0001 THREADS_IDENTITY_ACCOUNT_MISMATCH', 'reconnect: other identity');
-- Reconnect: the same identity refreshes the token in place (same reference), handle kept when absent.
select postona_t.accept(:'A', postona_t.complete_sql('A2', '17841400000000001', null, 'fakeTHREADSaccessTOKENa2'), 'reconnect: same identity');
select postona_t.ok((select row(sa.vault_access_token_secret_id = :'a_secret'::uuid, sa.verified_at > :'a_verified'::timestamptz, sa.handle,
                                sa.connection_status, (select s.secret from vault.secrets s where s.id = sa.vault_access_token_secret_id),
                                (select count(*) from vault.secrets s where s.name = sa.id || '_access_token'))::text
                     from public.social_accounts sa where sa.id = postona_t.threads_id(:'A'))
                    = '(t,t,postona.test,identity_verified,fakeTHREADSaccessTOKENa2,1)', 'A: token updated in place');
-- The same Threads identity connected elsewhere: refused as a whole.
select postona_t.refuse(:'B', postona_t.complete_sql('B1', '17841400000000001', 'postona.test', 'fakeTHREADSaccessTOKENb1'),
                        'P0001 THREADS_ACCOUNT_ALREADY_CONNECTED', 'B: identity connected to A');
-- A Vault failure leaves nothing behind (TEST-ONLY injected failure).
select postona_t.refuse(:'B', postona_t.complete_sql('B1', '17841400000000003', 'b.test', 'fakeFAILVAULTb1token'),
                        'P0001 VAULT_UNAVAILABLE', 'B: Vault failure');
-- Credential shapes: a leftover secret of the row's name, a reference shared with another row, a
-- reference to no secret.
select postona_t.accept(:'W', postona_t.begin_sql('W1'), 'begin W1');
insert into vault.secrets (name, secret) values (postona_t.threads_id(:'W') || '_access_token', 'fake_leftover');
select postona_t.refuse(:'W', postona_t.complete_sql('W1', '17841400000000004', null, 'fakeTHREADSaccessTOKENw1'),
                        'P0001 THREADS_CREDENTIAL_SHAPE_INVALID', 'W: leftover named secret');
delete from vault.secrets where name = postona_t.threads_id(:'W') || '_access_token';
update public.social_accounts set vault_access_token_secret_id = :'a_secret' where id = postona_t.threads_id(:'W');
select postona_t.refuse(:'W', postona_t.complete_sql('W1', '17841400000000004', null, 'fakeTHREADSaccessTOKENw1'),
                        'P0001 THREADS_CREDENTIAL_SHAPE_INVALID', 'W: shared reference');
update public.social_accounts set vault_access_token_secret_id = gen_random_uuid() where id = postona_t.threads_id(:'W');
select postona_t.refuse(:'W', postona_t.complete_sql('W1', '17841400000000004', null, 'fakeTHREADSaccessTOKENw1'),
                        'P0001 THREADS_CREDENTIAL_SHAPE_INVALID', 'W: dangling reference');
update public.social_accounts set vault_access_token_secret_id = null where id = postona_t.threads_id(:'W');
select postona_t.accept(:'W', postona_t.complete_sql('W1', '17841400000000004', null, 'fakeTHREADSaccessTOKENw1'), 'W: clean complete');
-- No longer the owner of the workspace between begin and complete.
select postona_t.accept(:'Y', postona_t.begin_sql('Y1'), 'begin Y1');
update public.brand_memberships set role = 'member' where user_id = :'Y';
select postona_t.refuse(:'Y', postona_t.complete_sql('Y1', '17841400000000005', null, 'fakeTHREADSaccessTOKENy1'),
                        'P0001 THREADS_ACCOUNT_NOT_OWNED', 'Y: no longer owner');
select postona_t.refuse(:'Y', postona_t.consume_sql('Y1'), 'P0001 THREADS_OAUTH_STATE_NOT_CONSUMABLE', 'Y: consume no longer owner');
update public.brand_memberships set role = 'owner' where user_id = :'Y';
\echo POSTONA_THREADS_OAUTH_COMPLETE_PASS

-- 8. The lifecycle moves between begin and complete -----------------------------------------------------
select postona_t.accept(:'R', postona_t.begin_sql('R1'), 'begin R1');
set role service_role;
select postona_t.ok(public.begin_service_deletion(:'R', 'x_autopost') ->> 'status' = 'started', 'R: service deletion begins');
reset role;
select postona_t.refuse(:'R', postona_t.consume_sql('R1'), '42501 SERVICE_DELETION_IN_PROGRESS', 'R: consume during service deletion');
select postona_t.refuse(:'R', postona_t.complete_sql('R1', '17841400000000006', null, 'fakeTHREADSaccessTOKENr1'),
                        '42501 SERVICE_DELETION_IN_PROGRESS', 'R: complete during service deletion');
select postona_t.accept(:'S', postona_t.begin_sql('S1'), 'begin S1');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'S' and service_key = 'x_autopost';
select postona_t.refuse(:'S', postona_t.complete_sql('S1', '17841400000000007', null, 'fakeTHREADSaccessTOKENs1'),
                        '42501 SERVICE_NOT_ACTIVE', 'S: complete after the service ended');
select postona_t.accept(:'T', postona_t.begin_sql('T1'), 'begin T1');
select lifecycle_version as t_version from public.common_accounts where user_id = :'T' \gset
set role service_role;
select postona_t.ok(public.begin_common_account_deletion(:'T', :'t_version') ->> 'status' = 'started', 'T: account deletion begins');
reset role;
select postona_t.refuse(:'T', postona_t.complete_sql('T1', '17841400000000008', null, 'fakeTHREADSaccessTOKENt1'),
                        '42501 ACCOUNT_DELETION_IN_PROGRESS', 'T: complete during account deletion');
select postona_t.ok((select count(*) from public.social_account_oauth_states where state_hash in (postona_t.h('R1'), postona_t.h('S1'), postona_t.h('T1'))
                     and consumed_at is null) = 3, 'R/S/T: states not consumed');
\echo POSTONA_THREADS_OAUTH_LIFECYCLE_PASS

-- 9. The X flow next to Threads -------------------------------------------------------------------------
-- The existing X RPCs do not check the provider. X consume returns a Threads state of the same person
-- (read-only); X complete on it fails as a whole: on a verified Threads row by the identity check, on an
-- unverified one only by 2a-2's credential CHECK (an X refresh token on a Threads row). Recorded for the
-- X delegation task.
select postona_t.accept(:'A', postona_t.begin_sql('A5'), 'begin A5');
select postona_t.accept(:'B', postona_t.begin_sql('B2'), 'begin B2');
select postona_t.ok(postona_t.call(:'B', format('select * from public.consume_social_mobile_x_oauth_state(%L)', postona_t.h('B2')), p_guarded => false)
                    = 'OK', 'X consume of a Threads state is read-only');
select postona_t.refuse(:'A', format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)', postona_t.state_id('A5'),
                                     'x_user_1', 'xhandle', 'fake_x_access', 'fake_x_refresh'),
                        'P0001 X_IDENTITY_ACCOUNT_MISMATCH', 'X complete on a verified Threads state');
select postona_t.refuse(:'B', format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)', postona_t.state_id('B2'),
                                     'x_user_2', 'xhandle', 'fake_x_access', 'fake_x_refresh'),
                        '23514 %social_accounts_provider_credential_profile%', 'X complete on an unverified Threads state');
-- The X happy path still works in the same workspace, and leaves the Threads row alone.
select sa.*::text as a_threads_row from public.social_accounts sa where sa.id = postona_t.threads_id(:'A') \gset
select postona_t.ok(postona_t.call(:'A', format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
                                               postona_t.state_id('AX1'), 'x_user_1', 'xhandle', 'fake_x_access', 'fake_x_refresh'),
                                   p_guarded => false) = 'OK', 'X complete');
select postona_t.ok((select connection_status from public.social_accounts where brand_id = postona_t.ws(:'A') and platform = 'x') = 'identity_verified'
                    and (select sa.*::text from public.social_accounts sa where sa.id = postona_t.threads_id(:'A')) = :'a_threads_row',
                    'X verified, Threads untouched');
\echo POSTONA_THREADS_OAUTH_X_PASS

-- 10. Nothing in the lifecycle was created or changed for the people who connected ---------------------
select postona_t.ok(postona_t.lifecycle(array[:'A', :'B', :'C', :'W', :'Y']::uuid[]) = :'lifecycle_before', 'lifecycle untouched');
select postona_t.ok((select count(*) from public.social_accounts where platform = 'threads' and publish_enabled) = 0
                    and (select count(*) from public.social_accounts where platform = 'threads' and vault_refresh_token_secret_id is not null) = 0,
                    'no Threads row publishes or holds a refresh token');
\echo POSTONA_THREADS_OAUTH_BEHAVIOR_PASS
