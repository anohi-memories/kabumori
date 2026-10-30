-- G3-51 (TEST ONLY, fake data): smoke of the rollout bundle right after `rollout.sh install`, in G4's PERSONAL world (rollout_test_run.sh,
-- phase RS). Helpers are G3-48's g4_verdict/behavior.sql helpers (renamed g51). X connects through G4's REAL X SQL; the Threads binding /
-- custody rows are SYNTHETIC (labelled, G4's binding_row shape). U8 is in force (the bundle refuses to install without it), so Threads
-- create is refused. No provider is called anywhere.
\set ON_ERROR_STOP 1
set timezone = 'UTC';
create schema g51;
create table g51.results (n serial, case_id text, expected text, actual text);
create table g51.ids (name text primary key, id uuid);
create function g51.u(p int) returns uuid language sql immutable as $$ select ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g51.s(p int) returns uuid language sql immutable as $$ select ('00000001-0000-4000-9000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g51.h(p_label text) returns text language sql immutable as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g51.ws(p int) returns text language sql stable as $$ select public.social_mobile_account_deletion_workspace(g51.u(p)) $$;
create function g51.as_person(p int) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', g51.u(p), 'role', 'authenticated', 'session_id', g51.s(p), 'is_anonymous', false)::text, false),
         set_config('request.jwt.claim.sub', g51.u(p)::text, false), set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claim.session_id', g51.s(p)::text, false), set_config('request.jwt.claim.is_anonymous', 'false', false) $$;
create function g51.nobody() returns void language sql as $$
  select set_config('request.jwt.claims', '', false), set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false),
         set_config('request.jwt.claim.session_id', '', false), set_config('request.jwt.claim.is_anonymous', '', false) $$;
create function g51.person(p int) returns void language plpgsql as $$
begin
  perform public.fixture_login(g51.u(p));
  insert into auth.sessions (id, user_id) values (g51.s(p), g51.u(p));
  perform g51.as_person(p);
  perform public.start_x_autopost_service();
  update public.brands set code_profile_key = 'social_mobile_user_v1' where id = g51.ws(p);
end $$;
create function g51.try(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, 'OK');
exception when others then
  return 'ERR:' || sqlerrm;
end $$;
-- one statement as a role (API / worker), with the person's claims (or none)
create function g51.as_role(p_role text, p int, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p is null then perform g51.nobody(); else perform g51.as_person(p); end if;
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  return coalesce(v, '<null>');
exception when others then
  reset role;
  return 'ERR:' || sqlerrm;
end $$;
create function g51.check_(p_case text, p_expected text, p_actual text) returns void language sql as $$
  insert into g51.results (case_id, expected, actual) values (p_case, p_expected, p_actual) $$;
create function g51.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into g51.ids values (p_name, p_id) returning id $$;
create function g51.id(p_name text) returns uuid language sql stable as $$ select id from g51.ids where name = p_name $$;
create function g51.sha(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- ---------------------------------------------------------------- X ------------------------------------------------------------
create function g51.xacct(p int) returns text language sql stable as $$ select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = g51.ws(p) $$;
create function g51.xbegin(p int, p_label text) returns text language plpgsql as $$
begin
  perform g51.as_person(p);
  return g51.try(format('select ''OK'' from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)', g51.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
end $$;
create function g51.xcomplete(p int, p_label text, p_puid text) returns text language plpgsql as $$
begin
  perform g51.as_person(p);
  return g51.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)::text',
    (select s.id from public.social_account_oauth_states s where s.state_hash = g51.h(p_label)), p_puid, '@h_' || p_puid, 'fakeXat_' || p_label, 'fakeXrt_' || p_label));
end $$;
create function g51.xconnect(p int, p_label text, p_puid text) returns text language sql as $$
  select g51.xbegin(p, p_label) || ' / ' || g51.xcomplete(p, p_label, p_puid) $$;
create function g51.xdisconnect(p int) returns text language plpgsql as $$
begin
  perform g51.as_person(p);
  return g51.try('select postona_g4_x_oauth.disconnect_x_connection()::text');
end $$;
-- G4's own answer, 'verified|code', and the generation G3 derives from it
create function g51.xv(p int) returns text language sql stable as $$
  select r.verified::text || '|' || r.code from postona_g4_credential.x_publish_credential_verdict(g51.u(p), g51.xacct(p)) r $$;
create function g51.xgen4(p int) returns text language sql stable as $$
  select r.credential_generation from postona_g4_credential.x_publish_credential_verdict(g51.u(p), g51.xacct(p)) r $$;
create function g51.xreserve(p int, p_name text, p_hours int, p_account text default null) returns text language plpgsql as $$
declare v text; b text := 'G3-51 本文 ' || p_name;
begin
  v := g51.as_role('postona_resv_api', p, format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    coalesce(p_account, g51.xacct(p)), jsonb_build_array(jsonb_build_object('draft_id', 'g51' || p_name, 'scheduled_at', now() + make_interval(hours => p_hours), 'body', b,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', g51.sha(b))))));
  if v !~ '^ERR' and v <> '<null>' then perform g51.keep(p_name, v::uuid); end if;
  return v;
end $$;
create function g51.xdue(p_name text) returns void language sql as $$
  update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
         expires_at = now() + interval '6 hours' where id = g51.id(p_name) $$;
create function g51.xclaim() returns text language sql as $$
  select g51.as_role('postona_resv_worker', null, 'select coalesce(string_agg(reservation_id::text, '','' order by reservation_id), '''') from postona_x_resv.claim_due(''w48'', 120, 50)') $$;
create function g51.xrow(p_name text) returns text language sql stable as $$
  select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = g51.id(p_name) $$;
create function g51.xpin(p_name text) returns text language sql stable as $$
  select coalesce(claim_credential_generation, 'null') from postona_x_resv.reservations where id = g51.id(p_name) $$;
create function g51.xcheck(p_name text) returns text language sql as $$
  select g51.as_role('postona_resv_worker', null, format('select postona_x_resv.pre_publish_check(%L, %L)', g51.id(p_name),
    (select lease_token from postona_x_resv.reservations where id = g51.id(p_name)))) $$;


create function g51.tacct(p int) returns text language sql immutable as $$ select 'th48_' || p $$;
-- SYNTHETIC connected Threads account (the shape G4's binding_row reads): account, custody, binding with a fresh oauth_state_id
create function g51.tconnect(p int, p_state uuid) returns void language plpgsql as $$
declare v_secret uuid := gen_random_uuid(); v_lv bigint := (select ca.lifecycle_version from public.common_accounts ca where ca.user_id = g51.u(p));
begin
  insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at, vault_access_token_secret_id)
  values (g51.tacct(p), g51.ws(p), 'threads', '@th48_' || p, (17841400000048000 + p % 1000)::text, false, 'identity_verified', now(), v_secret)
  on conflict (id) do update set connection_status = 'identity_verified', verified_at = now(), vault_access_token_secret_id = v_secret, last_connection_error_code = null,
    publish_enabled = public.social_accounts.publish_enabled;
  delete from public.threads_account_credential_custody where social_account_id = g51.tacct(p);
  insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by) values (g51.tacct(p), v_secret, now() + interval '50 days', g51.u(p));
  delete from postona_threads_binding.bindings where social_account_id = g51.tacct(p);
  insert into postona_threads_binding.bindings (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, connect_proof, lifecycle_version, bound_at)
  values (g51.tacct(p), g51.ws(p), (17841400000048000 + p % 1000)::text, g51.u(p), p_state, gen_random_uuid(), v_lv, now());
end $$;
create function g51.tv(p int) returns text language sql stable as $$
  select r.verified::text || '|' || r.code from postona_g4_credential.threads_publish_credential_verdict(g51.u(p), g51.tacct(p)) r $$;
create function g51.tcreate(p int, p_name text, p_hours int, p_account text default null) returns text language plpgsql as $$
declare v text; b text := 'G3-51 Threads ' || p_name;
begin
  v := g51.as_role('postona_resv_api', p, format('select reservation_id::text from postona_threads_resv.create_reservation(%L, gen_random_uuid(), %L, %L, now() + make_interval(hours => %s))',
    coalesce(p_account, g51.tacct(p)), b, g51.sha(b), p_hours));
  if v !~ '^ERR' and v <> '<null>' then perform g51.keep(p_name, v::uuid); end if;
  return v;
end $$;
select g51.person(5101), g51.person(5102);
select public.fixture_user_with_workspace(g51.u(5111), 's515111');
select g51.person(5111);
select g51.check_('S1 X connect (G4 real SQL)', 'ok', case when g51.xconnect(5101, 's1', '51001') !~ 'ERR' then 'ok' else 'err' end);
select g51.check_('S1 G4 verdict', 'true|VERIFIED', g51.xv(5101));
-- S2 the person reserves, reads it back, another person sees nothing, the person cancels it
select g51.check_('S2 reserve', 'uuid', case when g51.xreserve(5101, 'r1', 3) ~ '^[0-9a-f-]{36}$' then 'uuid' else g51.xreserve(5101, 'r1x', 5) end);
select g51.check_('S2 list (owner)', '1', g51.as_role('postona_resv_api', 5101, format('select count(*)::text from postona_x_resv.list_reservations(%L) where reservation_id = %L', g51.xacct(5101), g51.id('r1'))));
select g51.check_('S2 get (another person)', 'ERR:POSTONA_RESV_NOT_FOUND', g51.as_role('postona_resv_api', 5102, format('select reservation_id::text from postona_x_resv.get_reservation(%L)', g51.id('r1'))));
select g51.check_('S2 cancel (owner)', 'cancelled', g51.as_role('postona_resv_api', 5101, format('select status from postona_x_resv.cancel(%L, 1)', g51.id('r1'))));
-- S3 due -> claim pins G3's generation of G4's verdict -> the bound pre-send check answers it -> outcome recorded
select g51.check_('S3 reserve', 'uuid', case when g51.xreserve(5101, 'r2', 5) ~ '^[0-9a-f-]{36}$' then 'uuid' else 'err' end);
select g51.xdue('r2');
select g51.check_('S3 claimed', 'yes', case when g51.xclaim() like '%' || g51.id('r2') || '%' then 'yes' else 'no' end);
select g51.check_('S3 pinned = current', 'yes', case when g51.xpin('r2') = postona_x_resv.x_credential_generation(g51.xacct(5101)) then 'yes' else 'no' end);
select g51.check_('S3 bound check', 'OK|pinned', g51.as_role('postona_resv_worker', null, format(
  'select verdict || ''|'' || case when credential_generation = %L then ''pinned'' else coalesce(credential_generation, ''null'') end from postona_x_resv.pre_publish_check_bound(%L, %L)',
  g51.xpin('r2'), g51.id('r2'), (select lease_token from postona_x_resv.reservations where id = g51.id('r2')))));
select g51.check_('S3 finish', 'published', g51.as_role('postona_resv_worker', null, format('select postona_x_resv.finish(%L, %L, ''published'', ''1851000'', null)',
  g51.id('r2'), (select lease_token from postona_x_resv.reservations where id = g51.id('r2')))));
-- S4 Threads: G4 verified, but U8 keeps the account publish-disabled -> create refused (the product state; the CHECK's owner decides)
select g51.tconnect(5111, '00000051-0000-4000-8000-000000000001');
select g51.check_('S4 Threads G4 verdict', 'true|VERIFIED', g51.tv(5111));
select g51.check_('S4 Threads create (U8)', 'ERR:POSTONA_THREADS_RESV_PUBLISH_DISABLED', g51.tcreate(5111, 't1', 300));
-- S5 default deny: authenticated / anon reach nothing of G3's
select g51.check_('S5 authenticated create', 'denied', case when g51.as_role('authenticated', 5101, format('select count(*)::text from postona_x_resv.list_reservations(%L)', g51.xacct(5101))) ~ '^ERR:permission denied for (function|schema|table|relation)' then 'denied' else 'reached' end);
select g51.check_('S5 anon threads', 'denied', case when g51.as_role('anon', null, 'select count(*)::text from postona_threads_resv.reservations') ~ '^ERR:permission denied for (function|schema|table|relation)' then 'denied' else 'reached' end);

select n || '|' || case_id || '|' || case when expected = actual then 'ok' else 'FAIL expected=' || expected || ' actual=' || coalesce(actual, '<null>') end from g51.results order by n;
select case when count(*) filter (where expected is distinct from actual) = 0 then 'G3_ROLLOUT_SMOKE_PASS' else 'G3_ROLLOUT_SMOKE_FAIL' end from g51.results;
