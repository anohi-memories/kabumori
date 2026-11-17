-- G4-02 #19 (Issue #561): G4's X send credential read (public.postona_x_send_credential_v1, 003) through G4's REAL X OAuth SQL
-- (begin / complete / disconnect) and the reviewed X verdict (002), on the FULL or PERSONAL G5 world of
-- postona_g4_x_send_credential_run.sh. Disposable local PG17; fake GoTrue claims / Vault; the tokens are this test's fake values;
-- no network. SYNTHETIC steps (labelled) stand in for writers that are not G4's: the refresh core's lease and its token write, a
-- service end, a connection error, a second owner, a missing lineage row. Every case records expected vs actual; the run fails
-- unless all match. The read runs as service_role (the only role 003 grants), as the Edge server would.
\set ON_ERROR_STOP 1
select set_config('g4xs.profile', :'profile', false);
create schema g4xs;
create table g4xs.results (n serial, case_id text, expected text, actual text);
create function g4xs.u(p int) returns uuid language sql immutable
  as $$ select ('00000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4xs.s(p int) returns uuid language sql immutable
  as $$ select ('00000001-0000-4000-9000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4xs.h(p_label text) returns text language sql immutable as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g4xs.as_person(p int) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', g4xs.u(p), 'role', 'authenticated', 'session_id', g4xs.s(p),
                                                            'is_anonymous', false)::text, false),
         set_config('request.jwt.claim.sub', g4xs.u(p)::text, false), set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.jwt.claim.session_id', g4xs.s(p)::text, false), set_config('request.jwt.claim.is_anonymous', 'false', false)
$$;
create function g4xs.person(p int) returns void language plpgsql as $$
begin
  perform public.fixture_login(g4xs.u(p));
  insert into auth.sessions (id, user_id) values (g4xs.s(p), g4xs.u(p));
  perform g4xs.as_person(p);
  perform public.start_x_autopost_service();
end $$;
create function g4xs.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $$;
create function g4xs.begin_(p int, p_label text) returns text language plpgsql as $$
begin
  perform g4xs.as_person(p);
  return g4xs.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
                         g4xs.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
end $$;
-- the fake tokens are 'fakeXat_<label>' / 'fakeXrt_<label>' (this test's values only; labels keep them >= 16 characters)
create function g4xs.complete_(p int, p_label text, p_puid text) returns text language plpgsql as $$
begin
  perform g4xs.as_person(p);
  return g4xs.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
    (select s.id from public.social_account_oauth_states s where s.state_hash = g4xs.h(p_label)), p_puid, '@h_' || p_puid,
    'fakeXat_' || p_label, 'fakeXrt_' || p_label));
end $$;
create function g4xs.acct(p int) returns text language sql stable as $$
  select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = public.social_mobile_account_deletion_workspace(g4xs.u(p)) $$;
grant usage on schema g4xs to service_role, anon, authenticated;
grant execute on all functions in schema g4xs to service_role, anon, authenticated;
-- the read as service_role: 'code|generation|token' ('-' for null)
create function g4xs.r(p_account text) returns text language plpgsql as $$
declare v text;
begin
  set local role service_role;
  select r.code || '|' || coalesce(r.credential_generation, '-') || '|' || coalesce(r.access_token, '-') into v
    from public.postona_x_send_credential_v1(p_account) r;
  reset role;
  return v;
end $$;
-- the read as another API role: the error text, or 'REACHED'
create function g4xs.r_as(p_role text, p_account text) returns text language plpgsql as $$
declare v text;
begin
  execute format('set local role %I', p_role);
  begin
    perform 1 from public.postona_x_send_credential_v1(p_account);
    v := 'REACHED';
  exception when others then
    v := sqlerrm;
  end;
  reset role;
  return v;
end $$;
create function g4xs.vgen(p int) returns text language sql stable as $$
  select coalesce(r.credential_generation, '-') from postona_g4_credential.x_publish_credential_verdict(g4xs.u(p), g4xs.acct(p)) r $$;
create function g4xs.check_(p_case text, p_expected text, p_actual text) returns void language sql as $$
  insert into g4xs.results (case_id, expected, actual) values (p_case, p_expected, p_actual) $$;
create function g4xs.refusal(p_code text) returns text language sql immutable as $$ select p_code || '|-|-' $$;

select g4xs.person(4901), g4xs.person(4902), g4xs.person(4903), g4xs.person(4904);

-- 1. connect through G4's X SQL -> VERIFIED, the verdict's generation, the token G4 stored in Vault
select g4xs.check_('1 connect A', 'OK/OK', g4xs.begin_(4901, 'g4xs-a1-label') || '/' || g4xs.complete_(4901, 'g4xs-a1-label', '2001'));
select g4xs.check_('1 read A', 'VERIFIED|' || g4xs.vgen(4901) || '|fakeXat_g4xs-a1-label', g4xs.r(g4xs.acct(4901)));
select g4xs.check_('1 generation is G4''s shape', 'true', (split_part(g4xs.r(g4xs.acct(4901)), '|', 2) ~ '^g4x1:[0-9]{1,19}$')::text);
select set_config('g4xs.genA1', g4xs.vgen(4901), false);
-- 2. API roles other than service_role cannot run it; bad input; an absent account
select g4xs.check_('2 anon', 'permission denied for function postona_x_send_credential_v1', g4xs.r_as('anon', g4xs.acct(4901)));
select g4xs.check_('2 authenticated', 'permission denied for function postona_x_send_credential_v1', g4xs.r_as('authenticated', g4xs.acct(4901)));
select g4xs.check_('2 null', g4xs.refusal('INPUT_INVALID'), g4xs.r(null));
select g4xs.check_('2 malformed', g4xs.refusal('INPUT_INVALID'), g4xs.r('SA_X; select 1'));
select g4xs.check_('2 absent', g4xs.refusal('NOT_CONNECTED'), g4xs.r('sa_doesnotexist000000000000'));
-- 3. another person: B's own account answers B's token, never A's; A's answer never carries B's
select g4xs.check_('3 connect B', 'OK/OK', g4xs.begin_(4902, 'g4xs-b1-label') || '/' || g4xs.complete_(4902, 'g4xs-b1-label', '2002'));
select g4xs.check_('3 read B', 'VERIFIED|' || g4xs.vgen(4902) || '|fakeXat_g4xs-b1-label', g4xs.r(g4xs.acct(4902)));
select g4xs.check_('3 A and B differ', 'differ', case when g4xs.r(g4xs.acct(4901)) <> g4xs.r(g4xs.acct(4902)) and g4xs.r(g4xs.acct(4901)) !~ 'b1' then 'differ' else 'SAME' end);
-- 4. a token refresh (SYNTHETIC: what main's refresh core commits -- new values in the same Vault secrets, its counter + 1)
--    keeps G4's generation and the next read answers the NEW token (nothing cached)
insert into public.x_account_refresh_state_v2 (social_account_id) values (g4xs.acct(4901)) on conflict (social_account_id) do nothing;
select g4xs.check_('4 refresh write', 'OK', g4xs.try(format(
  'select vault.update_secret(%L::uuid, %L), vault.update_secret(%L::uuid, %L); update public.x_account_refresh_state_v2 set generation = generation + 1 where social_account_id = %L',
  (select vault_access_token_secret_id from public.social_accounts where id = g4xs.acct(4901)), 'fakeXat_g4xs-a1-refreshed',
  (select vault_refresh_token_secret_id from public.social_accounts where id = g4xs.acct(4901)), 'fakeXrt_g4xs-a1-refreshed', g4xs.acct(4901))));
select g4xs.check_('4 new token, same generation', 'VERIFIED|' || current_setting('g4xs.genA1') || '|fakeXat_g4xs-a1-refreshed', g4xs.r(g4xs.acct(4901)));
-- 5. the refresh core's states (SYNTHETIC rows): no token while refreshing / uncertain / reauth required
update public.x_account_refresh_state_v2 set status = 'refreshing' where social_account_id = g4xs.acct(4901);
select g4xs.check_('5 refreshing', g4xs.refusal('REFRESH_IN_PROGRESS'), g4xs.r(g4xs.acct(4901)));
update public.x_account_refresh_state_v2 set status = 'uncertain' where social_account_id = g4xs.acct(4901);
select g4xs.check_('5 uncertain', g4xs.refusal('REFRESH_UNCERTAIN'), g4xs.r(g4xs.acct(4901)));
update public.x_account_refresh_state_v2 set status = 'reauth_required' where social_account_id = g4xs.acct(4901);
select g4xs.check_('5 reauth required', g4xs.refusal('REAUTH_REQUIRED'), g4xs.r(g4xs.acct(4901)));
update public.x_account_refresh_state_v2 set status = 'idle' where social_account_id = g4xs.acct(4901);
select g4xs.check_('5 idle again', 'VERIFIED|' || current_setting('g4xs.genA1') || '|fakeXat_g4xs-a1-refreshed', g4xs.r(g4xs.acct(4901)));
-- 6. a token that is not X's shape (SYNTHETIC Vault value) -> CREDENTIAL_UNREADABLE, nothing answered
select g4xs.check_('6 short token write', 'OK', g4xs.try(format('select vault.update_secret(%L::uuid, %L)',
  (select vault_access_token_secret_id from public.social_accounts where id = g4xs.acct(4901)), 'short')));
select g4xs.check_('6 short token', g4xs.refusal('CREDENTIAL_UNREADABLE'), g4xs.r(g4xs.acct(4901)));
select g4xs.check_('6 token with a space write', 'OK', g4xs.try(format('select vault.update_secret(%L::uuid, %L)',
  (select vault_access_token_secret_id from public.social_accounts where id = g4xs.acct(4901)), 'fakeXat with a space inside')));
select g4xs.check_('6 token with a space', g4xs.refusal('CREDENTIAL_UNREADABLE'), g4xs.r(g4xs.acct(4901)));
-- 7. reconnect (logout of X + connect again, the SAME X user): pending -> no token; complete -> a NEW generation and the new
--    token; the old generation never comes back (ABA)
select g4xs.check_('7 begin again', 'OK', g4xs.begin_(4901, 'g4xs-a2-label'));
select g4xs.check_('7 pending', g4xs.refusal('CONNECT_PENDING'), g4xs.r(g4xs.acct(4901)));
select g4xs.check_('7 complete', 'OK', g4xs.complete_(4901, 'g4xs-a2-label', '2001'));
select g4xs.check_('7 new token', 'VERIFIED|fakeXat_g4xs-a2-label', split_part(g4xs.r(g4xs.acct(4901)), '|', 1) || '|' || split_part(g4xs.r(g4xs.acct(4901)), '|', 3));
select g4xs.check_('7 new generation', 'changed', case when split_part(g4xs.r(g4xs.acct(4901)), '|', 2) <> current_setting('g4xs.genA1') then 'changed' else 'same' end);
select set_config('g4xs.genA2', g4xs.vgen(4901), false);
-- 8. disconnect through G4's SQL -> no token; reconnect -> a generation never seen before
select g4xs.as_person(4901);
select g4xs.check_('8 disconnect', 'OK', g4xs.try('select postona_g4_x_oauth.disconnect_x_connection()'));
select g4xs.check_('8 disconnected', g4xs.refusal('DISCONNECTED'), g4xs.r(g4xs.acct(4901)));
select g4xs.check_('8 reconnect', 'OK/OK', g4xs.begin_(4901, 'g4xs-a3-label') || '/' || g4xs.complete_(4901, 'g4xs-a3-label', '2001'));
select g4xs.check_('8 never an old generation', 'fresh',
  case when split_part(g4xs.r(g4xs.acct(4901)), '|', 2) not in (current_setting('g4xs.genA1'), current_setting('g4xs.genA2'), '-') then 'fresh' else 'OLD' end);
-- 9. a connection error (SYNTHETIC)
update public.social_accounts set last_connection_error_code = 'X_TEST_ERROR' where id = g4xs.acct(4901);
select g4xs.check_('9 connection error', g4xs.refusal('CONNECTION_ERROR'), g4xs.r(g4xs.acct(4901)));
update public.social_accounts set last_connection_error_code = null where id = g4xs.acct(4901);
-- 10. the service ends (SYNTHETIC end, as G5's end leaves it)
select g4xs.check_('10 connect C', 'OK/OK', g4xs.begin_(4903, 'g4xs-c1-label') || '/' || g4xs.complete_(4903, 'g4xs-c1-label', '2003'));
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = g4xs.u(4903) and service_key = 'x_autopost';
select g4xs.check_('10 service ended', g4xs.refusal('SERVICE_NOT_ACTIVE'), g4xs.r(g4xs.acct(4903)));
-- 11. owner loss: a second owner on the workspace (SYNTHETIC membership row) -> no single owner -> NOT_OWN_WORKSPACE
select g4xs.check_('11 connect D', 'OK/OK', g4xs.begin_(4904, 'g4xs-d1-label') || '/' || g4xs.complete_(4904, 'g4xs-d1-label', '2004'));
select g4xs.check_('11 D verified', 'VERIFIED', split_part(g4xs.r(g4xs.acct(4904)), '|', 1));
select g4xs.check_('11 second owner row', 'OK', g4xs.try(format('insert into public.brand_memberships (brand_id, user_id, role) values (%L, %L, ''owner'')',
  (select brand_id from public.social_accounts where id = g4xs.acct(4904)), g4xs.u(4902))));
select g4xs.check_('11 owner lost', g4xs.refusal('NOT_OWN_WORKSPACE'), g4xs.r(g4xs.acct(4904)));
-- 12. connected outside G4's lineage (SYNTHETIC: no lineage row)
delete from postona_g4_x_oauth.connections where social_account_id = g4xs.acct(4902);
select g4xs.check_('12 no lineage', g4xs.refusal('LINEAGE_UNKNOWN'), g4xs.r(g4xs.acct(4902)));
-- 13. no refusal above ever carried a token or a Vault id; the function's text has no log / notice
select g4xs.check_('13 refusals carry nothing', '0', (select count(*)::text from g4xs.results where expected ~ '\|-\|-$' and actual !~ '\|-\|-$'));
select g4xs.check_('13 no notice / log in the body', 'clean',
  case when (select prosrc from pg_proc where oid = 'public.postona_x_send_credential_v1(text)'::regprocedure) ~* '\m(raise|notice)\M' then 'LOGS' else 'clean' end);

select n, case_id, case when expected = actual then 'ok' else 'FAIL expected ' || expected || ' got ' || actual end from g4xs.results order by n;
do $$ begin
  if exists (select 1 from g4xs.results where expected is distinct from actual) then raise exception 'G4XS_BEHAVIOR_FAIL'; end if;
  if (select count(*) from g4xs.results) < 35 then raise exception 'G4XS_BEHAVIOR_INCOMPLETE'; end if;
end $$;
select 'G4XS_BEHAVIOR_PASS';
