-- G4-02 #4 (Issue #561): the X publish-credential verdict (postona_g4_credential.x_publish_credential_verdict) through
-- G4's REAL X OAuth SQL (001..005: begin / complete / disconnect / CAS token writer) on the FULL G5 profile world of
-- postona_g4_threads_person_session_run.sh (G4T_VERDICT=1). Disposable local PG17; fake GoTrue claims / Vault; no network.
-- SYNTHETIC steps (labelled) stand in for writers that are not G4's: the refresh core's lease, a service end, a connection
-- error. Every case records expected vs actual; the run fails unless all match.
\set ON_ERROR_STOP 1
select set_config('g4v.profile', :'profile', false);
create schema g4v;
create table g4v.results (n serial, case_id text, expected text, actual text);
create function g4v.u(p int) returns uuid language sql immutable
  as $$ select ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4v.s(p int) returns uuid language sql immutable
  as $$ select ('00000001-0000-4000-9000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4v.h(p_label text) returns text language sql immutable as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g4v.as_person(p int) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', g4v.u(p), 'role', 'authenticated', 'session_id', g4v.s(p),
                                                            'is_anonymous', false)::text, false),
         set_config('request.jwt.claim.sub', g4v.u(p)::text, false), set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claim.session_id', g4v.s(p)::text, false), set_config('request.jwt.claim.is_anonymous', 'false', false)
$$;
create function g4v.person(p int) returns void language plpgsql as $$
begin
  perform public.fixture_login(g4v.u(p));
  insert into auth.sessions (id, user_id) values (g4v.s(p), g4v.u(p));
  perform g4v.as_person(p);
  perform public.start_x_autopost_service();
end $$;
create function g4v.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $$;
create function g4v.begin_(p int, p_label text) returns text language plpgsql as $$
begin
  perform g4v.as_person(p);
  return g4v.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
                        g4v.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
end $$;
create function g4v.complete_(p int, p_label text, p_puid text) returns text language plpgsql as $$
begin
  perform g4v.as_person(p);
  return g4v.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
    (select s.id from public.social_account_oauth_states s where s.state_hash = g4v.h(p_label)), p_puid, '@h_' || p_puid,
    'fakeXat_' || p_label, 'fakeXrt_' || p_label));
end $$;
create function g4v.acct(p int) returns text language sql stable as $$
  select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = public.social_mobile_account_deletion_workspace(g4v.u(p)) $$;
-- the verdict for (asker, account) as 'verified|generation|code'
create function g4v.v(p_asker int, p_account text) returns text language sql stable as $$
  select r.verified::text || '|' || coalesce(r.credential_generation, '-') || '|' || r.code
    from postona_g4_credential.x_publish_credential_verdict(g4v.u(p_asker), p_account) r $$;
create function g4v.gen(p int) returns text language sql stable as $$ select split_part(g4v.v(p, g4v.acct(p)), '|', 2) $$;
create function g4v.check_(p_case text, p_expected text, p_actual text) returns void language sql as $$
  insert into g4v.results (case_id, expected, actual) values (p_case, p_expected, p_actual) $$;

select g4v.person(4801), g4v.person(4802), g4v.person(4803);

-- 1. connect through G4's X SQL -> verified, generation g4x1:<epoch>
select g4v.check_('1 begin', 'OK', g4v.begin_(4801, 'a1'));
select g4v.check_('1 complete', 'OK', g4v.complete_(4801, 'a1', '1001'));
select g4v.check_('1 verdict', 'true|g4x1:' || (select connection_epoch from postona_g4_x_oauth.connections where social_account_id = g4v.acct(4801)) || '|VERIFIED',
                  g4v.v(4801, g4v.acct(4801)));
select set_config('g4v.gen1', g4v.gen(4801), false);
-- 2. another person, an absent account, no input
select g4v.check_('2 another person', 'false|-|NOT_OWN_WORKSPACE', g4v.v(4802, g4v.acct(4801)));
select g4v.check_('2 absent account', 'false|-|NOT_CONNECTED', g4v.v(4801, 'sa_doesnotexist000000000000'));
select g4v.check_('2 null person', 'false|-|INPUT_INVALID', g4v.v(null, g4v.acct(4801)));
-- 3. no credential material in the answer (tokens, secret ids)
select g4v.check_('3 no token or secret id in the answer', 'clean',
  case when g4v.v(4801, g4v.acct(4801)) ~ 'fakeX' or position((select vault_access_token_secret_id::text from public.social_accounts where id = g4v.acct(4801)) in g4v.v(4801, g4v.acct(4801))) > 0
            or position((select vault_refresh_token_secret_id::text from public.social_accounts where id = g4v.acct(4801)) in g4v.v(4801, g4v.acct(4801))) > 0
       then 'LEAK' else 'clean' end);
-- 4. a token refresh keeps the generation (SYNTHETIC: what main's refresh core commits -- new token values in the same
--    Vault secrets, its own counter + 1; G4-40 002 dropped G4's second writer, the core's lease is the only one)
insert into public.x_account_refresh_state_v2 (social_account_id) values (g4v.acct(4801)) on conflict (social_account_id) do nothing;
select g4v.check_('4 refresh write', 'OK', g4v.try(format(
  'select vault.update_secret(%L::uuid, %L), vault.update_secret(%L::uuid, %L); update public.x_account_refresh_state_v2 set generation = generation + 1 where social_account_id = %L',
  (select vault_access_token_secret_id from public.social_accounts where id = g4v.acct(4801)), 'fakeXat_r',
  (select vault_refresh_token_secret_id from public.social_accounts where id = g4v.acct(4801)), 'fakeXrt_r', g4v.acct(4801))));
select g4v.check_('4 same generation after refresh', 'true|' || current_setting('g4v.gen1') || '|VERIFIED', g4v.v(4801, g4v.acct(4801)));
-- 5. refresh states of main's refresh core (SYNTHETIC rows; the core owns these writes)
insert into public.x_account_refresh_state_v2 (social_account_id) values (g4v.acct(4801)) on conflict (social_account_id) do nothing;
update public.x_account_refresh_state_v2 set status = 'reauth_required' where social_account_id = g4v.acct(4801);
select g4v.check_('5 reauth required', 'false|' || current_setting('g4v.gen1') || '|REAUTH_REQUIRED', g4v.v(4801, g4v.acct(4801)));
update public.x_account_refresh_state_v2 set status = 'uncertain' where social_account_id = g4v.acct(4801);
select g4v.check_('5 refresh uncertain', 'false|' || current_setting('g4v.gen1') || '|REFRESH_UNCERTAIN', g4v.v(4801, g4v.acct(4801)));
-- (this world's table is the deletion fixture's shape: status only; on main the core also sets its lease columns)
update public.x_account_refresh_state_v2 set status = 'refreshing' where social_account_id = g4v.acct(4801);
select g4v.check_('5 refresh in progress', 'false|' || current_setting('g4v.gen1') || '|REFRESH_IN_PROGRESS', g4v.v(4801, g4v.acct(4801)));
update public.x_account_refresh_state_v2 set status = 'idle' where social_account_id = g4v.acct(4801);
select g4v.check_('5 idle again', 'true|' || current_setting('g4v.gen1') || '|VERIFIED', g4v.v(4801, g4v.acct(4801)));
-- 6. a begin is open -> CONNECT_PENDING; its completion (the same X user) is a NEW generation
select g4v.check_('6 begin again', 'OK', g4v.begin_(4801, 'a2'));
select g4v.check_('6 pending', 'false|' || current_setting('g4v.gen1') || '|CONNECT_PENDING', g4v.v(4801, g4v.acct(4801)));
select g4v.check_('6 complete', 'OK', g4v.complete_(4801, 'a2', '1001'));
select g4v.check_('6 reconnect verified', 'true|VERIFIED', split_part(g4v.v(4801, g4v.acct(4801)), '|', 1) || '|' || split_part(g4v.v(4801, g4v.acct(4801)), '|', 3));
select g4v.check_('6 reconnect is a new generation', 'changed', case when g4v.gen(4801) <> current_setting('g4v.gen1') then 'changed' else 'same' end);
select set_config('g4v.gen2', g4v.gen(4801), false);
-- 7. a connection error (SYNTHETIC: the error column the live flows set)
update public.social_accounts set last_connection_error_code = 'X_TEST_ERROR' where id = g4v.acct(4801);
select g4v.check_('7 connection error', 'false|' || current_setting('g4v.gen2') || '|CONNECTION_ERROR', g4v.v(4801, g4v.acct(4801)));
update public.social_accounts set last_connection_error_code = null where id = g4v.acct(4801);
-- 8. disconnect through G4's SQL -> DISCONNECTED, the generation moved again (never back)
select g4v.as_person(4801);
select g4v.check_('8 disconnect', 'OK', g4v.try('select postona_g4_x_oauth.disconnect_x_connection()'));
select g4v.check_('8 disconnected', 'false|DISCONNECTED', split_part(g4v.v(4801, g4v.acct(4801)), '|', 1) || '|' || split_part(g4v.v(4801, g4v.acct(4801)), '|', 3));
select g4v.check_('8 the generation moved, never back', 'changed',
  case when g4v.gen(4801) not in (current_setting('g4v.gen1'), current_setting('g4v.gen2')) then 'changed' else 'same' end);
-- 9. the service ends (SYNTHETIC end, as G5's end would leave it) -> SERVICE_NOT_ACTIVE
select g4v.check_('9 connect', 'OK/OK', g4v.begin_(4803, 'c1') || '/' || g4v.complete_(4803, 'c1', '1003'));
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = g4v.u(4803) and service_key = 'x_autopost';
select g4v.check_('9 service ended', 'false|' || g4v.gen(4803) || '|SERVICE_NOT_ACTIVE', g4v.v(4803, g4v.acct(4803)));
-- 10. connected outside G4's lineage (SYNTHETIC: no lineage row) -> LINEAGE_UNKNOWN
select g4v.check_('10 connect', 'OK/OK', g4v.begin_(4802, 'b1') || '/' || g4v.complete_(4802, 'b1', '1002'));
delete from postona_g4_x_oauth.connections where social_account_id = g4v.acct(4802);
select g4v.check_('10 no lineage', 'false|-|LINEAGE_UNKNOWN', g4v.v(4802, g4v.acct(4802)));

-- 11. the service ends and restarts between begin and complete (SYNTHETIC lifecycle_version + 2). G4-02 #5: the personal
--     profile records G5's g5pv generation at begin, so the callback refuses (OWNER_EPOCH_CHANGED: the reviewed body's code
--     for a moved recorded generation); the full profile binds F5's owner epoch, which an end + restart does not move.
select g4v.person(4804);
select g4v.check_('11 begin', 'OK', g4v.begin_(4804, 'd1'));
update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id = g4v.u(4804);
select g4v.check_('11 service end + restart between begin and complete',
  case current_setting('g4v.profile') when 'personal' then 'OWNER_EPOCH_CHANGED' else 'OK' end, g4v.complete_(4804, 'd1', '1004'));
-- personal: the refused callback leaves the begin open (nothing completed): not verified, CONNECT_PENDING
select g4v.check_('11 verdict after', case current_setting('g4v.profile') when 'personal' then 'false|CONNECT_PENDING' else 'true|VERIFIED' end,
  split_part(g4v.v(4804, g4v.acct(4804)), '|', 1) || '|' || split_part(g4v.v(4804, g4v.acct(4804)), '|', 3));

select n, case_id, case when expected = actual then 'ok' else 'FAIL expected ' || expected || ' got ' || actual end from g4v.results order by n;
do $$ begin
  if exists (select 1 from g4v.results where expected is distinct from actual) then raise exception 'G4V_X_VERDICT_FAIL'; end if;
  if (select count(*) from g4v.results) < 20 then raise exception 'G4V_X_VERDICT_INCOMPLETE'; end if;
end $$;
select 'G4V_X_VERDICT_BEHAVIOR_PASS';
