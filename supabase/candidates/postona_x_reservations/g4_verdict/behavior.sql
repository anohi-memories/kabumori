-- G3-48 (TEST ONLY, fake data): G3's X / Threads reservation consumers on G4's REAL publish-credential verdicts, in the PERSONAL world
-- G4's own runner builds (G5 MVP + G4's Threads g5pv binding + G4's personal X OAuth 001-005 + G4's verdict 001 / 002, G4 head
-- c6df19cc), with G3 001-006 + 008 + 010 + 012 + 014 and 007 + 009 + 011 + 013 installed on top (g4_verdict_run.sh, phase VB).
--   X: connect / disconnect / reconnect through G4's REAL X SQL (begin / complete / disconnect_x_connection); SYNTHETIC (labelled): main's
--      refresh-core state, a lineage row removed, a service end.
--   Threads: G4's binding is written by G4's H5 entry, which this world does not run, so the binding / custody / account rows are
--      SYNTHETIC (labelled) in exactly the shape G4's binding_row reads; G4 proved those lifecycles itself (app e2e scenario 19).
-- No provider is called anywhere (no network): "published" below is the worker's recorded outcome of a send that did not happen.
\set ON_ERROR_STOP 1
set timezone = 'UTC';
create schema g48;
create table g48.results (n serial, case_id text, expected text, actual text);
create table g48.ids (name text primary key, id uuid);
create function g48.u(p int) returns uuid language sql immutable as $$ select ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g48.s(p int) returns uuid language sql immutable as $$ select ('00000001-0000-4000-9000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g48.h(p_label text) returns text language sql immutable as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g48.ws(p int) returns text language sql stable as $$ select public.social_mobile_account_deletion_workspace(g48.u(p)) $$;
create function g48.as_person(p int) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', g48.u(p), 'role', 'authenticated', 'session_id', g48.s(p), 'is_anonymous', false)::text, false),
         set_config('request.jwt.claim.sub', g48.u(p)::text, false), set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claim.session_id', g48.s(p)::text, false), set_config('request.jwt.claim.is_anonymous', 'false', false) $$;
create function g48.nobody() returns void language sql as $$
  select set_config('request.jwt.claims', '', false), set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false),
         set_config('request.jwt.claim.session_id', '', false), set_config('request.jwt.claim.is_anonymous', '', false) $$;
create function g48.person(p int) returns void language plpgsql as $$
begin
  perform public.fixture_login(g48.u(p));
  insert into auth.sessions (id, user_id) values (g48.s(p), g48.u(p));
  perform g48.as_person(p);
  perform public.start_x_autopost_service();
  update public.brands set code_profile_key = 'social_mobile_user_v1' where id = g48.ws(p);
end $$;
create function g48.try(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, 'OK');
exception when others then
  return 'ERR:' || sqlerrm;
end $$;
-- one statement as a role (API / worker), with the person's claims (or none)
create function g48.as_role(p_role text, p int, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p is null then perform g48.nobody(); else perform g48.as_person(p); end if;
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  return coalesce(v, '<null>');
exception when others then
  reset role;
  return 'ERR:' || sqlerrm;
end $$;
create function g48.check_(p_case text, p_expected text, p_actual text) returns void language sql as $$
  insert into g48.results (case_id, expected, actual) values (p_case, p_expected, p_actual) $$;
create function g48.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into g48.ids values (p_name, p_id) returning id $$;
create function g48.id(p_name text) returns uuid language sql stable as $$ select id from g48.ids where name = p_name $$;
create function g48.sha(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- ---------------------------------------------------------------- X ------------------------------------------------------------
create function g48.xacct(p int) returns text language sql stable as $$ select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = g48.ws(p) $$;
create function g48.xbegin(p int, p_label text) returns text language plpgsql as $$
begin
  perform g48.as_person(p);
  return g48.try(format('select ''OK'' from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)', g48.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
end $$;
create function g48.xcomplete(p int, p_label text, p_puid text) returns text language plpgsql as $$
begin
  perform g48.as_person(p);
  return g48.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)::text',
    (select s.id from public.social_account_oauth_states s where s.state_hash = g48.h(p_label)), p_puid, '@h_' || p_puid, 'fakeXat_' || p_label, 'fakeXrt_' || p_label));
end $$;
create function g48.xconnect(p int, p_label text, p_puid text) returns text language sql as $$
  select g48.xbegin(p, p_label) || ' / ' || g48.xcomplete(p, p_label, p_puid) $$;
create function g48.xdisconnect(p int) returns text language plpgsql as $$
begin
  perform g48.as_person(p);
  return g48.try('select postona_g4_x_oauth.disconnect_x_connection()::text');
end $$;
-- G4's own answer, 'verified|code', and the generation G3 derives from it
create function g48.xv(p int) returns text language sql stable as $$
  select r.verified::text || '|' || r.code from postona_g4_credential.x_publish_credential_verdict(g48.u(p), g48.xacct(p)) r $$;
create function g48.xgen4(p int) returns text language sql stable as $$
  select r.credential_generation from postona_g4_credential.x_publish_credential_verdict(g48.u(p), g48.xacct(p)) r $$;
create function g48.xreserve(p int, p_name text, p_hours int, p_account text default null) returns text language plpgsql as $$
declare v text; b text := 'G3-48 本文 ' || p_name;
begin
  v := g48.as_role('postona_resv_api', p, format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    coalesce(p_account, g48.xacct(p)), jsonb_build_array(jsonb_build_object('draft_id', 'g48' || p_name, 'scheduled_at', now() + make_interval(hours => p_hours), 'body', b,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', g48.sha(b))))));
  if v !~ '^ERR' and v <> '<null>' then perform g48.keep(p_name, v::uuid); end if;
  return v;
end $$;
create function g48.xdue(p_name text) returns void language sql as $$
  update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
         expires_at = now() + interval '6 hours' where id = g48.id(p_name) $$;
create function g48.xclaim() returns text language sql as $$
  select g48.as_role('postona_resv_worker', null, 'select coalesce(string_agg(reservation_id::text, '','' order by reservation_id), '''') from postona_x_resv.claim_due(''w48'', 120, 50)') $$;
create function g48.xrow(p_name text) returns text language sql stable as $$
  select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = g48.id(p_name) $$;
create function g48.xpin(p_name text) returns text language sql stable as $$
  select coalesce(claim_credential_generation, 'null') from postona_x_resv.reservations where id = g48.id(p_name) $$;
create function g48.xcheck(p_name text) returns text language sql as $$
  select g48.as_role('postona_resv_worker', null, format('select postona_x_resv.pre_publish_check(%L, %L)', g48.id(p_name),
    (select lease_token from postona_x_resv.reservations where id = g48.id(p_name)))) $$;

select g48.person(4801), g48.person(4802);
-- XV1 connected through G4's real X SQL: G4 verified; G3's consumer agrees and derives sha256('g3x1|' || G4's generation)
select g48.check_('XV1 connect', 'ok', case when g48.xconnect(4801, 'a1', '48001') !~ 'ERR' then 'ok' else g48.xconnect(4801, 'a1', '48001') end);
select g48.check_('XV1 G4 verdict', 'true|VERIFIED', g48.xv(4801));
select g48.check_('XV1 G3 verified', 'true', postona_x_resv.g4_x_account_verified(g48.u(4801), g48.xacct(4801))::text);
select g48.check_('XV1 G3 generation', g48.sha('g3x1|' || g48.xgen4(4801)), coalesce(postona_x_resv.x_credential_generation(g48.xacct(4801)), 'null'));
-- XV2 another person / an unknown account: G4 refuses, G3 refuses (create through the API too)
select g48.check_('XV2 other person', 'false', postona_x_resv.g4_x_account_verified(g48.u(4802), g48.xacct(4801))::text);
select g48.check_('XV2 unknown account', 'false|null', postona_x_resv.g4_x_account_verified(g48.u(4801), 'sa_none')::text || '|' || coalesce(postona_x_resv.x_credential_generation('sa_none'), 'null'));
select g48.check_('XV2 other person create', 'ERR:POSTONA_RESV_ACCOUNT_NOT_FOUND', g48.xreserve(4802, 'x0', 300, g48.xacct(4801)));
-- (x6, for XV10, is made now: once rows are moved to "due" below, they sit within 60 minutes of each other and G3's slot rule would
-- refuse any later create of this account -- a test-clock effect, not a product one)
select g48.check_('XV10 create', 'ok', case when g48.xreserve(4801, 'x6', 380) ~ '^ERR' then 'err' else 'ok' end);
-- XV3 reserve -> claim pins the generation -> the pre-send check passes -> the worker records the (simulated) outcome
select g48.check_('XV3 create', 'ok', case when g48.xreserve(4801, 'x1', 300) ~ '^ERR' then 'err' else 'ok' end);
select g48.xdue('x1');
select g48.xclaim();
select g48.check_('XV3 claimed', 'claimed/-', g48.xrow('x1'));
select g48.check_('XV3 pinned', postona_x_resv.x_credential_generation(g48.xacct(4801)), g48.xpin('x1'));
select g48.check_('XV3 pre-send', 'OK', g48.xcheck('x1'));
select g48.check_('XV3 recorded', 'published', g48.as_role('postona_resv_worker', null, format('select postona_x_resv.finish(%L, %L, ''published'', ''1048000000000000001'', null)',
  g48.id('x1'), (select lease_token from postona_x_resv.reservations where id = g48.id('x1')))));
-- XV4 disconnect between claim and send (G4's real disconnect): G4 DISCONNECTED -> not publishable, failed, never sent
select g48.xreserve(4801, 'x2', 310); select g48.xdue('x2'); select g48.xclaim();
select g48.check_('XV4 claimed', 'claimed/-', g48.xrow('x2'));
select g48.check_('XV4 disconnect', 'ok', case when g48.xdisconnect(4801) ~ 'ERR' then 'err' else 'ok' end);
select g48.check_('XV4 G4 verdict', 'false|DISCONNECTED', g48.xv(4801));
select g48.check_('XV4 G3 generation', 'null', coalesce(postona_x_resv.x_credential_generation(g48.xacct(4801)), 'null'));
select g48.check_('XV4 pre-send', 'NOT_PUBLISHABLE', g48.xcheck('x2'));
select g48.check_('XV4 row', 'failed/NOT_PUBLISHABLE_AT_SEND', g48.xrow('x2'));
select g48.check_('XV4 create refused', 'ERR:POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED', g48.xreserve(4801, 'x2b', 320));
-- XV5 A -> B -> A: reconnect (a NEW generation), claim pins it; disconnect + reconnect again before the send: verified again, but the
-- pinned generation is gone -> not publishable (the old claim never sends on the new connection)
select g48.check_('XV5 reconnect', 'ok', case when g48.xconnect(4801, 'a2', '48001') ~ 'ERR' then 'err' else 'ok' end);
select g48.check_('XV5 verified again', 'true|VERIFIED', g48.xv(4801));
select g48.xreserve(4801, 'x3', 330); select g48.xdue('x3'); select g48.xclaim();
select g48.check_('XV5 claimed + pinned', 'claimed/-|' || postona_x_resv.x_credential_generation(g48.xacct(4801)), g48.xrow('x3') || '|' || g48.xpin('x3'));
select g48.xdisconnect(4801);
select g48.check_('XV5 connect again', 'ok', case when g48.xconnect(4801, 'a3', '48001') ~ 'ERR' then 'err' else 'ok' end);
select g48.check_('XV5 verified, a newer generation', 'true|VERIFIED|moved', g48.xv(4801) || '|' || case when g48.xpin('x3') <> postona_x_resv.x_credential_generation(g48.xacct(4801)) then 'moved' else 'same' end);
select g48.check_('XV5 pre-send', 'NOT_PUBLISHABLE', g48.xcheck('x3'));
select g48.check_('XV5 row', 'failed/NOT_PUBLISHABLE_AT_SEND', g48.xrow('x3'));
-- XV6 a refresh in progress (SYNTHETIC: main's refresh core state) between claim and send: G4 REFRESH_IN_PROGRESS -> not sent
select g48.xreserve(4801, 'x4', 340); select g48.xdue('x4'); select g48.xclaim();
insert into public.x_account_refresh_state_v2 (social_account_id) values (g48.xacct(4801)) on conflict (social_account_id) do nothing;
update public.x_account_refresh_state_v2 set status = 'refreshing' where social_account_id = g48.xacct(4801);
select g48.check_('XV6 G4 verdict', 'false|REFRESH_IN_PROGRESS', g48.xv(4801));
select g48.check_('XV6 pre-send', 'NOT_PUBLISHABLE', g48.xcheck('x4'));
update public.x_account_refresh_state_v2 set status = 'idle' where social_account_id = g48.xacct(4801);
select g48.check_('XV6 idle again: verified, same generation', 'true|VERIFIED', g48.xv(4801));
-- XV7 a claimed row whose lease ran out: uncertain, never claimed again (no re-send)
select g48.xreserve(4801, 'x5', 350); select g48.xdue('x5'); select g48.xclaim();
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = g48.id('x5');
select g48.xclaim();
select g48.check_('XV7 uncertain', 'uncertain/LEASE_EXPIRED', g48.xrow('x5'));
select g48.check_('XV7 never re-claimed', 'no', case when g48.xclaim() like '%' || g48.id('x5') || '%' then 'yes' else 'no' end);
-- XV8 single post: the generation bound at begin is G3's value of G4's verdict; a reconnect before the send refuses it
create function g48.sp_begin(p int, p_text text) returns text language sql as $$
  select g48.as_role('postona_resv_api', p, format('select reservation_id || '','' || coalesce(lease_token::text, '''') || '','' || state from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
    g48.xacct(p), p_text, g48.sha(p_text))) $$;
create function g48.sp_pre(p int, p_begin text) returns text language sql as $$
  select g48.as_role('postona_resv_api', p, format('select verdict from postona_x_resv.post_now_preflight(%L, %L)', split_part(p_begin, ',', 1), split_part(p_begin, ',', 2))) $$;
create table g48.sp (name text primary key, b text);
-- SYNTHETIC: the person turns their X publish switch on (U8 gate; the app's own write, not G4's)
update public.social_accounts set publish_enabled = true where id = g48.xacct(4801);
insert into g48.sp values ('s1', g48.sp_begin(4801, 'G3-48 単発 s1'));
select g48.check_('XV8 begin', 'claimed', split_part((select b from g48.sp where name = 's1'), ',', 3));
select g48.check_('XV8 bound = G3 value of G4', postona_x_resv.x_credential_generation(g48.xacct(4801)),
  (select credential_generation from postona_x_resv.single_post_bindings where reservation_id = split_part((select b from g48.sp where name = 's1'), ',', 1)::uuid));
select g48.check_('XV8 preflight', 'OK', g48.sp_pre(4801, (select b from g48.sp where name = 's1')));
insert into g48.sp values ('s2', g48.sp_begin(4801, 'G3-48 単発 s2'));
select g48.xdisconnect(4801); select g48.xconnect(4801, 'a4', '48001');
select g48.check_('XV8 reconnected: preflight refused', 'NOT_PUBLISHABLE', g48.sp_pre(4801, (select b from g48.sp where name = 's2')));
-- XV9 a connection outside G4's lineage (SYNTHETIC: the lineage row removed): G4 LINEAGE_UNKNOWN -> G3 refuses
select g48.person(4803);
select g48.xconnect(4803, 'c1', '48003');
select g48.check_('XV9 verified first', 'true|VERIFIED', g48.xv(4803));
delete from postona_g4_x_oauth.connections where social_account_id = g48.xacct(4803);
select g48.check_('XV9 G4 verdict', 'false|LINEAGE_UNKNOWN', g48.xv(4803));
select g48.check_('XV9 G3', 'false|null', postona_x_resv.g4_x_account_verified(g48.u(4803), g48.xacct(4803))::text || '|' || coalesce(postona_x_resv.x_credential_generation(g48.xacct(4803)), 'null'));
-- XV10 the service ends (SYNTHETIC, as G5's end leaves it): G4 SERVICE_NOT_ACTIVE; a due row of that person is never claimed
select g48.xdue('x6');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = g48.u(4801) and service_key = 'x_autopost';
select g48.check_('XV10 G4 verdict', 'false|SERVICE_NOT_ACTIVE', g48.xv(4801));
select g48.check_('XV10 not claimed', 'no', case when g48.xclaim() like '%' || g48.id('x6') || '%' then 'yes' else 'no' end);
select g48.check_('XV10 row', 'planned/-', g48.xrow('x6'));

-- ---------------------------------------------------------------- Threads ------------------------------------------------------
create function g48.tacct(p int) returns text language sql immutable as $$ select 'th48_' || p $$;
-- SYNTHETIC connected Threads account (the shape G4's binding_row reads): account, custody, binding with a fresh oauth_state_id
create function g48.tconnect(p int, p_state uuid) returns void language plpgsql as $$
declare v_secret uuid := gen_random_uuid(); v_lv bigint := (select ca.lifecycle_version from public.common_accounts ca where ca.user_id = g48.u(p));
begin
  insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at, vault_access_token_secret_id)
  values (g48.tacct(p), g48.ws(p), 'threads', '@th48_' || p, (17841400000048000 + p % 1000)::text, false, 'identity_verified', now(), v_secret)
  on conflict (id) do update set connection_status = 'identity_verified', verified_at = now(), vault_access_token_secret_id = v_secret, last_connection_error_code = null,
    publish_enabled = public.social_accounts.publish_enabled;
  delete from public.threads_account_credential_custody where social_account_id = g48.tacct(p);
  insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by) values (g48.tacct(p), v_secret, now() + interval '50 days', g48.u(p));
  delete from postona_threads_binding.bindings where social_account_id = g48.tacct(p);
  insert into postona_threads_binding.bindings (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, connect_proof, lifecycle_version, bound_at)
  values (g48.tacct(p), g48.ws(p), (17841400000048000 + p % 1000)::text, g48.u(p), p_state, gen_random_uuid(), v_lv, now());
end $$;
create function g48.tv(p int) returns text language sql stable as $$
  select r.verified::text || '|' || r.code from postona_g4_credential.threads_publish_credential_verdict(g48.u(p), g48.tacct(p)) r $$;
create function g48.tcreate(p int, p_name text, p_hours int, p_account text default null) returns text language plpgsql as $$
declare v text; b text := 'G3-48 Threads ' || p_name;
begin
  v := g48.as_role('postona_resv_api', p, format('select reservation_id::text from postona_threads_resv.create_reservation(%L, gen_random_uuid(), %L, %L, now() + make_interval(hours => %s))',
    coalesce(p_account, g48.tacct(p)), b, g48.sha(b), p_hours));
  if v !~ '^ERR' and v <> '<null>' then perform g48.keep(p_name, v::uuid); end if;
  return v;
end $$;
create function g48.tdue(p_name text) returns void language sql as $$ update postona_threads_resv.reservations set scheduled_at = now() - interval '1 minute' where id = g48.id(p_name) $$;
create function g48.tclaim() returns text language sql as $$
  select g48.as_role('postona_resv_worker', null, 'select coalesce(string_agg(reservation_id::text, '','' order by reservation_id), '''') from postona_threads_resv.claim_due(''w48'', 120, 50)') $$;
create function g48.trow(p_name text) returns text language sql stable as $$
  select status || '/' || coalesce(outcome_code, '-') from postona_threads_resv.reservations where id = g48.id(p_name) $$;
create function g48.tpre(p_name text) returns text language sql as $$
  select g48.as_role('postona_resv_worker', null, format('select verdict from postona_threads_resv.preflight(%L, %L)', g48.id(p_name),
    (select lease_token from postona_threads_resv.reservations where id = g48.id(p_name)))) $$;

-- the Threads people get their own workspace first (the fixture G3's personal MVP suites use); X people get theirs from G4's X connect
select public.fixture_user_with_workspace(g48.u(p), 's48' || p) from unnest(array[4811, 4812]) p;
select g48.person(4811), g48.person(4812);
select g48.check_('TV setup workspace', 'u_ok', (select case when bool_and(b.id = 'u_' || substr(md5(g48.u(p)::text), 1, 24)) then 'u_ok' else 'other' end
  from unnest(array[4811, 4812]) p join public.brands b on b.id = g48.ws(p)));
select g48.tconnect(4811, '00000048-0000-4000-8000-000000000001');
-- TV0 the real 2a-2 CHECK (social_accounts_meta_publish_disabled) is in force in this world: a VERIFIED Threads account still cannot be
-- publish-enabled, so G3 refuses the create (PUBLISH_DISABLED). This is the product state today (U8: the CHECK's owner decides).
select g48.check_('TV0 CHECK in force', '1', (select count(*)::text from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled'));
select g48.check_('TV0 verified', 'true|VERIFIED', g48.tv(4811));
select g48.check_('TV0 create refused', 'ERR:POSTONA_THREADS_RESV_PUBLISH_DISABLED', g48.tcreate(4811, 't00', 300));
-- TEST STAND-IN (U8): the CHECK is dropped in THIS disposable world only, and the person's publish switch turned on, to exercise G3's
-- verdict wiring below. Nothing here says the CHECK may be dropped in a real environment.
alter table public.social_accounts drop constraint social_accounts_meta_publish_disabled;
update public.social_accounts set publish_enabled = true where platform = 'threads';
-- TV1 G4 verified; G3 agrees; G3's generation = sha256('g3t1|g4t1:<oauth_state_id>')
select g48.check_('TV1 G4 verdict', 'true|VERIFIED', g48.tv(4811));
select g48.check_('TV1 G3 verified', 'true', postona_threads_resv.g4_threads_account_verified(g48.u(4811), g48.tacct(4811))::text);
select g48.check_('TV1 G3 generation', g48.sha('g3t1|g4t1:00000048-0000-4000-8000-000000000001'), coalesce(postona_threads_resv.threads_credential_generation(g48.tacct(4811)), 'null'));
-- TV2 another person: G4 NOT_OWN_WORKSPACE; G3 refuses the create on that account
select g48.check_('TV2 other person', 'false', postona_threads_resv.g4_threads_account_verified(g48.u(4812), g48.tacct(4811))::text);
select g48.check_('TV2 other person create', 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND', g48.tcreate(4812, 't0', 300, g48.tacct(4811)));
-- TV3 create -> claim stores the generation -> preflight OK -> the worker records the (simulated) outcome
select g48.check_('TV3 create', 'ok', case when g48.tcreate(4811, 't1', 300) ~ '^ERR' then 'err' else 'ok' end);
select g48.tdue('t1'); select g48.tclaim();
select g48.check_('TV3 claimed + bound', 'claimed/-|' || postona_threads_resv.threads_credential_generation(g48.tacct(4811)),
  g48.trow('t1') || '|' || (select bound_generation from postona_threads_resv.reservations where id = g48.id('t1')));
select g48.check_('TV3 preflight', 'OK', g48.tpre('t1'));
-- TV4 reconnect between claim and send (SYNTHETIC: a new binding, new oauth_state_id): verified again, generation moved -> CREDENTIAL_CHANGED
select g48.tcreate(4811, 't2', 310); select g48.tdue('t2'); select g48.tclaim();
select g48.tconnect(4811, '00000048-0000-4000-8000-000000000002');
select g48.check_('TV4 verified again', 'true|VERIFIED', g48.tv(4811));
select g48.check_('TV4 preflight', 'NOT_PUBLISHABLE', g48.tpre('t2'));
select g48.check_('TV4 row', 'failed/CREDENTIAL_CHANGED', g48.trow('t2'));
-- TV5 custody expired (SYNTHETIC): G4 CREDENTIAL_EXPIRED -> G3 not verified, a claimed row never sends
select g48.tcreate(4811, 't3', 320); select g48.tdue('t3'); select g48.tclaim();
update public.threads_account_credential_custody set expires_at = now() - interval '1 second' where social_account_id = g48.tacct(4811);
select g48.check_('TV5 G4 verdict', 'false|CREDENTIAL_EXPIRED', g48.tv(4811));
select g48.check_('TV5 G3', 'false|null', postona_threads_resv.g4_threads_account_verified(g48.u(4811), g48.tacct(4811))::text || '|' || coalesce(postona_threads_resv.threads_credential_generation(g48.tacct(4811)), 'null'));
select g48.check_('TV5 preflight', 'NOT_PUBLISHABLE', g48.tpre('t3'));
-- TV6 disconnect (SYNTHETIC: G4's disconnect removes the binding and custody): NOT_CONNECTED -> create refused
select g48.tconnect(4811, '00000048-0000-4000-8000-000000000003');
select g48.tcreate(4811, 't4', 330); select g48.tdue('t4'); select g48.tclaim();
delete from postona_threads_binding.bindings where social_account_id = g48.tacct(4811);
delete from public.threads_account_credential_custody where social_account_id = g48.tacct(4811);
select g48.check_('TV6 G4 verdict', 'false|NOT_BOUND', g48.tv(4811));
select g48.check_('TV6 preflight', 'NOT_PUBLISHABLE', g48.tpre('t4'));
select g48.check_('TV6 create refused', 'ERR:POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED', g48.tcreate(4811, 't5', 340));
-- TV7 A -> B -> A: connect again with the FIRST state id's account shape but a new state: the old claim's generation never comes back
select g48.tconnect(4811, '00000048-0000-4000-8000-000000000004');
select g48.check_('TV7 a generation never seen before', 'new', case when postona_threads_resv.threads_credential_generation(g48.tacct(4811))
  in (select bound_generation from postona_threads_resv.reservations where user_id = g48.u(4811) and bound_generation is not null) then 'reused' else 'new' end);
-- TV8 the service ends (SYNTHETIC): G4 SERVICE_NOT_ACTIVE -> G3 not verified
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = g48.u(4811) and service_key = 'x_autopost';
select g48.check_('TV8 G4 verdict', 'false|SERVICE_NOT_ACTIVE', g48.tv(4811));
select g48.check_('TV8 G3', 'false', postona_threads_resv.g4_threads_account_verified(g48.u(4811), g48.tacct(4811))::text);

-- ---------------------------------------------------------------- summary ------------------------------------------------------
select n, case_id, case when expected = actual then 'ok' else 'FAIL expected ' || coalesce(expected, '<null>') || ' got ' || coalesce(actual, '<null>') end from g48.results order by n;
do $$ begin
  if exists (select 1 from g48.results where expected is distinct from actual) then raise exception 'G3_G4_VERDICT_BEHAVIOR_FAIL'; end if;
  if (select count(*) from g48.results) < 40 then raise exception 'G3_G4_VERDICT_BEHAVIOR_INCOMPLETE %', (select count(*) from g48.results); end if;
end $$;
select 'G3_G4_VERDICT_BEHAVIOR_PASS';
