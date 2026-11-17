-- G4-02 #19, #20 (Issue #561): G4's X send credential read (public.postona_x_send_credential_for_claim_v1, 003) through G4's REAL X
-- OAuth SQL (begin / complete / disconnect) and the reviewed X verdict (002), on the FULL or PERSONAL G5 world of
-- postona_g4_x_send_credential_run.sh, with G3's claim tables (G3 PR #699's DDL, applied by the runner). Disposable local PG17; fake
-- GoTrue claims / Vault; the tokens are this test's fake values; no network. SYNTHETIC steps (labelled) stand in for writers that are
-- not G4's: G3's claim rows (as post_now_begin / claim_due leave them), the publish switch, the refresh core's lease and its token
-- write, a service end, a connection error, a second owner, a missing lineage row, Vault reference damage. Every case records
-- expected vs actual; the run fails unless all match. The read runs as service_role (the only role 003 grants), as the Edge would.
\set ON_ERROR_STOP 1
\o /dev/null
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
declare v text;
begin
  perform g4xs.as_person(p);
  v := g4xs.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
    (select s.id from public.social_account_oauth_states s where s.state_hash = g4xs.h(p_label)), p_puid, '@h_' || p_puid,
    'fakeXat_' || p_label, 'fakeXrt_' || p_label));
  if v = 'OK' then  -- SYNTHETIC: the person turns publishing on (G4's complete leaves it off; the control is G1 / G4's)
    update public.social_accounts set publish_enabled = true where platform = 'x' and brand_id = public.social_mobile_account_deletion_workspace(g4xs.u(p));
  end if;
  return v;
end $$;
create function g4xs.acct(p int) returns text language sql stable as $$
  select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = public.social_mobile_account_deletion_workspace(g4xs.u(p)) $$;
grant usage on schema g4xs to service_role, anon, authenticated;
grant execute on all functions in schema g4xs to service_role, anon, authenticated;
-- the person whose own workspace holds the account (the claim's user; also when G5 no longer answers an owner)
create function g4xs.p_of(p_account text) returns int language sql stable as $$
  select p from generate_series(4900, 4999) p
   where public.social_mobile_account_deletion_workspace(g4xs.u(p)) = (select sa.brand_id from public.social_accounts sa where sa.id = p_account)
   limit 1 $$;
-- G3's generation of the account as 014 derives it from G4's verdict generation (the verdict answers one for most refusals too)
create function g4xs.g3gen(p_account text) returns text language sql stable as $$
  select encode(sha256(convert_to('g3x1|' || v.credential_generation, 'UTF8')), 'hex')
    from postona_g4_credential.x_publish_credential_verdict(g4xs.u(g4xs.p_of(p_account)), p_account) v where v.credential_generation is not null $$;
-- SYNTHETIC G3 claim: the row G3's post_now_begin ('manual': claimed_by single_post + 006's binding) or claim_due ('worker': 014's pin)
-- leaves, in G3's own table shape. The generation bound is the account's current one unless p_bound is given. Answers 'id|lease'.
create function g4xs.claim(p_kind text, p_account text, p_user int default null, p_bound text default null) returns text
language plpgsql as $$
declare v_user uuid := g4xs.u(coalesce(p_user, g4xs.p_of(p_account)));
        v_brand text := (select sa.brand_id from public.social_accounts sa where sa.id = p_account);
        v_batch uuid := gen_random_uuid(); v_id uuid; v_lease uuid := gen_random_uuid();
        v_body text := 'g4xs claim ' || gen_random_uuid()::text; v_sha text; v_now timestamptz := now();
        v_gen text := coalesce(p_bound, g4xs.g3gen(p_account), md5('g4xs-none') || md5('g4xs-none#'));
begin
  v_sha := encode(sha256(convert_to(v_body, 'UTF8')), 'hex');
  insert into postona_x_resv.batches (id, user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, payload_sha256)
  values (v_batch, v_user, v_brand, p_account, gen_random_uuid(), 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', v_sha);
  insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
    scheduled_at, fixed, status, revision, consent_state, consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at,
    lease_token, lease_expires_at, claimed_by, claim_credential_generation)
  values (v_batch, v_user, v_brand, p_account, case p_kind when 'manual' then 'single:' || replace(v_batch::text, '-', '') else 'd1' end, 0,
    'user_authored', 'manual_exact', v_body, v_sha, v_now, true, 'claimed', 1, 'confirmed', v_sha, v_now, 1, v_now,
    case p_kind when 'manual' then v_now else v_now + interval '1 hour' end, v_lease, clock_timestamp() + interval '60 seconds',
    case p_kind when 'manual' then 'single_post' else 'g4xs_worker' end, case p_kind when 'manual' then null else v_gen end)
  returning id into v_id;
  if p_kind = 'manual' then
    insert into postona_x_resv.single_post_bindings (reservation_id, owner_user_id, brand_id, credential_generation) values (v_id, v_user, v_brand, v_gen);
  end if;
  return v_id || '|' || v_lease;
end $$;
-- the read as service_role with an attempt: 'code|generation|token' ('-' for null)
create function g4xs.rc(p_claim text, p_account text, p_session uuid) returns text language plpgsql as $$
declare v text;
begin
  set local role service_role;
  select r.code || '|' || coalesce(r.credential_generation, '-') || '|' || coalesce(r.access_token, '-') into v
    from public.postona_x_send_credential_for_claim_v1(nullif(split_part(p_claim, '|', 1), '')::uuid, nullif(split_part(p_claim, '|', 2), '')::uuid,
                                                        p_account, p_session) r;
  reset role;
  return v;
end $$;
-- the manual send's read: a fresh claim of the account's person, with that person's session (the 40 state cases of G4-02 #19)
create function g4xs.r(p_account text) returns text language plpgsql as $$
begin
  if p_account is null or p_account !~ '^sa_' or g4xs.p_of(p_account) is null then
    return g4xs.rc(gen_random_uuid() || '|' || gen_random_uuid(), p_account, g4xs.s(4901));
  end if;
  return g4xs.rc(g4xs.claim('manual', p_account), p_account, g4xs.s(g4xs.p_of(p_account)));
end $$;
-- the read as another API role: the error text, or 'REACHED'
create function g4xs.r_as(p_role text, p_account text) returns text language plpgsql as $$
declare v text; v_claim text := g4xs.claim('manual', p_account);
begin
  execute format('set local role %I', p_role);
  begin
    perform 1 from public.postona_x_send_credential_for_claim_v1(split_part(v_claim, '|', 1)::uuid, split_part(v_claim, '|', 2)::uuid,
                                                                  p_account, g4xs.s(g4xs.p_of(p_account)));
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
select g4xs.check_('2 anon', 'permission denied for function postona_x_send_credential_for_claim_v1', g4xs.r_as('anon', g4xs.acct(4901)));
select g4xs.check_('2 authenticated', 'permission denied for function postona_x_send_credential_for_claim_v1', g4xs.r_as('authenticated', g4xs.acct(4901)));
select g4xs.check_('2 null', g4xs.refusal('INPUT_INVALID'), g4xs.r(null));
select g4xs.check_('2 malformed', g4xs.refusal('INPUT_INVALID'), g4xs.r('SA_X; select 1'));
select g4xs.check_('2 absent', g4xs.refusal('CLAIM_INVALID'), g4xs.r('sa_doesnotexist000000000000'));
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
-- ---- G4-02 #20 (H1 #50 P2-1): the read is bound to a live send attempt of G3 ----
select g4xs.person(4905), g4xs.person(4906);
select g4xs.check_('14 connect E', 'OK/OK', g4xs.begin_(4905, 'g4xs-e1-label') || '/' || g4xs.complete_(4905, 'g4xs-e1-label', '2005'));
select g4xs.check_('14 connect F', 'OK/OK', g4xs.begin_(4906, 'g4xs-f1-label') || '/' || g4xs.complete_(4906, 'g4xs-f1-label', '2006'));
select set_config('g4xs.e', g4xs.acct(4905), false), set_config('g4xs.f', g4xs.acct(4906), false);
select set_config('g4xs.ce', g4xs.claim('manual', current_setting('g4xs.e')), false);
select g4xs.check_('14 manual attempt: VERIFIED', 'VERIFIED|' || g4xs.vgen(4905) || '|fakeXat_g4xs-e1-label', g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), g4xs.s(4905)));
select g4xs.check_('14 the account id alone (no attempt)', g4xs.refusal('INPUT_INVALID'), g4xs.rc('|', current_setting('g4xs.e'), g4xs.s(4905)));
select g4xs.check_('14 forged attempt (unknown id)', g4xs.refusal('CLAIM_INVALID'), g4xs.rc(gen_random_uuid() || '|' || gen_random_uuid(), current_setting('g4xs.e'), g4xs.s(4905)));
select g4xs.check_('14 forged lease', g4xs.refusal('CLAIM_INVALID'), g4xs.rc(split_part(current_setting('g4xs.ce'), '|', 1) || '|' || gen_random_uuid(), current_setting('g4xs.e'), g4xs.s(4905)));
select g4xs.check_('14 E''s attempt for F''s account', g4xs.refusal('CLAIM_INVALID'), g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.f'), g4xs.s(4905)));
select g4xs.check_('14 no session (manual)', g4xs.refusal('SESSION_REQUIRED'), g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), null));
select g4xs.check_('14 another person''s session', g4xs.refusal('SESSION_NOT_ACTIVE'), g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), g4xs.s(4906)));
select g4xs.check_('14 unknown session', g4xs.refusal('SESSION_NOT_ACTIVE'), g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), gen_random_uuid()));
update auth.sessions set not_after = now() - interval '1 second' where id = g4xs.s(4905);
select g4xs.check_('14 expired session', g4xs.refusal('SESSION_NOT_ACTIVE'), g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), g4xs.s(4905)));
update auth.sessions set not_after = null where id = g4xs.s(4905);
insert into auth.sessions (id, user_id) values ('00000002-0000-4000-9000-000000004905', g4xs.u(4905));
delete from auth.sessions where id = '00000002-0000-4000-9000-000000004905';
select g4xs.check_('14 signed-out session', g4xs.refusal('SESSION_NOT_ACTIVE'), g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), '00000002-0000-4000-9000-000000004905'));
select g4xs.check_('14 same attempt again (still claimed)', 'VERIFIED', split_part(g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), g4xs.s(4905)), '|', 1));
-- the attempt ends (SYNTHETIC: the states G3's finish / cancel / sweep leave) -> never again (no reuse)
update postona_x_resv.reservations set status = 'published', provider_post_id = '123' where id = split_part(current_setting('g4xs.ce'), '|', 1)::uuid;
select g4xs.check_('15 reuse after published', g4xs.refusal('CLAIM_NOT_ACTIVE'), g4xs.rc(current_setting('g4xs.ce'), current_setting('g4xs.e'), g4xs.s(4905)));
select set_config('g4xs.c2', g4xs.claim('manual', current_setting('g4xs.e')), false);
update postona_x_resv.reservations set status = 'failed', outcome_code = 'X_REJECTED_401' where id = split_part(current_setting('g4xs.c2'), '|', 1)::uuid;
select g4xs.check_('15 after failed', g4xs.refusal('CLAIM_NOT_ACTIVE'), g4xs.rc(current_setting('g4xs.c2'), current_setting('g4xs.e'), g4xs.s(4905)));
select set_config('g4xs.c3', g4xs.claim('manual', current_setting('g4xs.e')), false);
update postona_x_resv.reservations set status = 'uncertain', outcome_code = 'OUTCOME_UNKNOWN' where id = split_part(current_setting('g4xs.c3'), '|', 1)::uuid;
select g4xs.check_('15 after uncertain (never re-sent)', g4xs.refusal('CLAIM_NOT_ACTIVE'), g4xs.rc(current_setting('g4xs.c3'), current_setting('g4xs.e'), g4xs.s(4905)));
select set_config('g4xs.c4', g4xs.claim('worker', current_setting('g4xs.e')), false);
update postona_x_resv.reservations set status = 'cancelled', lease_token = null, lease_expires_at = null where id = split_part(current_setting('g4xs.c4'), '|', 1)::uuid;
select g4xs.check_('15 cancelled', g4xs.refusal('CLAIM_INVALID'), g4xs.rc(current_setting('g4xs.c4'), current_setting('g4xs.e'), null));
select set_config('g4xs.c5', g4xs.claim('manual', current_setting('g4xs.e')), false);
update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = split_part(current_setting('g4xs.c5'), '|', 1)::uuid;
select g4xs.check_('15 lease expired', g4xs.refusal('CLAIM_EXPIRED'), g4xs.rc(current_setting('g4xs.c5'), current_setting('g4xs.e'), g4xs.s(4905)));
select set_config('g4xs.c6', g4xs.claim('manual', current_setting('g4xs.e')), false);
update postona_x_resv.reservations set body = body || ' changed', content_sha256 = md5('x') || md5('y') where id = split_part(current_setting('g4xs.c6'), '|', 1)::uuid;
select g4xs.check_('15 text changed after consent', g4xs.refusal('CLAIM_NOT_PUBLISHABLE'), g4xs.rc(current_setting('g4xs.c6'), current_setting('g4xs.e'), g4xs.s(4905)));
select set_config('g4xs.c7', g4xs.claim('manual', current_setting('g4xs.e')), false);
update postona_x_resv.single_post_bindings set transport = 'x' where reservation_id = split_part(current_setting('g4xs.c7'), '|', 1)::uuid;
select g4xs.check_('15 result already recorded', g4xs.refusal('CLAIM_INVALID'), g4xs.rc(current_setting('g4xs.c7'), current_setting('g4xs.e'), g4xs.s(4905)));
-- the worker's attempt: no session; its claim pin
select set_config('g4xs.cw', g4xs.claim('worker', current_setting('g4xs.e')), false);
select g4xs.check_('16 worker attempt: VERIFIED', 'VERIFIED|' || g4xs.vgen(4905) || '|fakeXat_g4xs-e1-label', g4xs.rc(current_setting('g4xs.cw'), current_setting('g4xs.e'), null));
select g4xs.check_('16 worker attempt with a session', g4xs.refusal('INPUT_INVALID'), g4xs.rc(current_setting('g4xs.cw'), current_setting('g4xs.e'), g4xs.s(4905)));
update postona_x_resv.reservations set claim_credential_generation = null where id = split_part(current_setting('g4xs.cw'), '|', 1)::uuid;
select g4xs.check_('16 worker attempt without a pin', g4xs.refusal('CLAIM_INVALID'), g4xs.rc(current_setting('g4xs.cw'), current_setting('g4xs.e'), null));
-- another owner / another workspace on the attempt
select set_config('g4xs.c8', g4xs.claim('manual', current_setting('g4xs.e'), 4906), false);
select g4xs.check_('17 attempt of another person on E''s account', g4xs.refusal('NOT_OWN_WORKSPACE'), g4xs.rc(current_setting('g4xs.c8'), current_setting('g4xs.e'), g4xs.s(4906)));
select set_config('g4xs.c9', g4xs.claim('worker', current_setting('g4xs.e')), false);
update postona_x_resv.reservations set brand_id = (select brand_id from public.social_accounts where id = current_setting('g4xs.f'))
 where id = split_part(current_setting('g4xs.c9'), '|', 1)::uuid;
select g4xs.check_('17 attempt in another workspace', g4xs.refusal('CLAIM_INVALID'), g4xs.rc(current_setting('g4xs.c9'), current_setting('g4xs.e'), null));
-- publishing OFF / a recorded stop
select set_config('g4xs.c10', g4xs.claim('manual', current_setting('g4xs.e')), false);
update public.social_accounts set publish_enabled = false where id = current_setting('g4xs.e');
select g4xs.check_('18 publishing off', g4xs.refusal('PUBLISH_DISABLED'), g4xs.rc(current_setting('g4xs.c10'), current_setting('g4xs.e'), g4xs.s(4905)));
update public.social_accounts set publish_enabled = true where id = current_setting('g4xs.e');
create table if not exists public.x_account_publish_authority (social_account_id text primary key, state text not null);  -- SYNTHETIC (Stage 3B shape)
insert into public.x_account_publish_authority values (current_setting('g4xs.e'), 'revoked');
select g4xs.check_('18 stop recorded', g4xs.refusal('PUBLISH_AUTHORITY_REVOKED'), g4xs.rc(current_setting('g4xs.c10'), current_setting('g4xs.e'), g4xs.s(4905)));
delete from public.x_account_publish_authority;
select g4xs.check_('18 stop lifted', 'VERIFIED', split_part(g4xs.rc(current_setting('g4xs.c10'), current_setting('g4xs.e'), g4xs.s(4905)), '|', 1));
-- the generation the attempt bound: a reconnect / A->B->A since the claim refuses; a refresh does not (same generation, new token)
select set_config('g4xs.c11', g4xs.claim('manual', current_setting('g4xs.e')), false);
select set_config('g4xs.c12', g4xs.claim('worker', current_setting('g4xs.e')), false);
select g4xs.check_('19 refresh write (SYNTHETIC)', 'OK', g4xs.try(format(
  'select vault.update_secret(%L::uuid, %L); insert into public.x_account_refresh_state_v2 (social_account_id) values (%L) on conflict (social_account_id) do nothing; update public.x_account_refresh_state_v2 set generation = generation + 1 where social_account_id = %L',
  (select vault_access_token_secret_id from public.social_accounts where id = current_setting('g4xs.e')), 'fakeXat_g4xs-e1-refreshed', current_setting('g4xs.e'), current_setting('g4xs.e'))));
select g4xs.check_('19 refresh keeps the attempt (new token)', 'VERIFIED|fakeXat_g4xs-e1-refreshed', split_part(g4xs.rc(current_setting('g4xs.c11'), current_setting('g4xs.e'), g4xs.s(4905)), '|', 1) || '|' || split_part(g4xs.rc(current_setting('g4xs.c11'), current_setting('g4xs.e'), g4xs.s(4905)), '|', 3));
select g4xs.check_('19 refresh generation answered', '1', (select r.refresh_generation::text from public.postona_x_send_credential_for_claim_v1(split_part(current_setting('g4xs.c12'), '|', 1)::uuid, split_part(current_setting('g4xs.c12'), '|', 2)::uuid, current_setting('g4xs.e'), null) r));
select g4xs.as_person(4905);
select g4xs.check_('19 disconnect + reconnect E', 'OK/OK/OK', g4xs.try('select postona_g4_x_oauth.disconnect_x_connection()') || '/' || g4xs.begin_(4905, 'g4xs-e2-label') || '/' || g4xs.complete_(4905, 'g4xs-e2-label', '2005'));
select g4xs.check_('19 manual attempt across a reconnect (ABA)', g4xs.refusal('CREDENTIAL_GENERATION_CHANGED'), g4xs.rc(current_setting('g4xs.c11'), current_setting('g4xs.e'), g4xs.s(4905)));
select g4xs.check_('19 worker attempt across a reconnect (ABA)', g4xs.refusal('CREDENTIAL_GENERATION_CHANGED'), g4xs.rc(current_setting('g4xs.c12'), current_setting('g4xs.e'), null));
select g4xs.check_('19 a new attempt after the reconnect', 'VERIFIED|fakeXat_g4xs-e2-label', split_part(g4xs.r(current_setting('g4xs.e')), '|', 1) || '|' || split_part(g4xs.r(current_setting('g4xs.e')), '|', 3));
-- service_role cannot read G3's claims (the lease is a capability) and cannot reach the verdict / Vault directly
select g4xs.check_('20 service_role reads no lease', 'permission denied for schema postona_x_resv', g4xs.try('set local role service_role; select lease_token from postona_x_resv.reservations limit 1'));
select g4xs.check_('20 service_role reads no Vault', 'denied', case when g4xs.try('set local role service_role; select decrypted_secret from vault.decrypted_secrets limit 1') ~ 'permission denied' then 'denied' else 'REACHED' end);
reset role;

-- ---- G4-02 #20 (H1 #50 P2-2): Vault references bound to the account and the purpose ----
-- SYNTHETIC damage (as a migration / restore / data error could leave it); each step is undone before the next
select set_config('g4xs.ea', (select vault_access_token_secret_id::text from public.social_accounts where id = current_setting('g4xs.e')), false),
       set_config('g4xs.er', (select vault_refresh_token_secret_id::text from public.social_accounts where id = current_setting('g4xs.e')), false),
       set_config('g4xs.fa', (select vault_access_token_secret_id::text from public.social_accounts where id = current_setting('g4xs.f')), false),
       set_config('g4xs.fr', (select vault_refresh_token_secret_id::text from public.social_accounts where id = current_setting('g4xs.f')), false);
select g4xs.check_('21 E verified before damage', 'VERIFIED', split_part(g4xs.r(current_setting('g4xs.e')), '|', 1));
update public.social_accounts set vault_refresh_token_secret_id = vault_access_token_secret_id where id = current_setting('g4xs.e');
select g4xs.check_('21 access = refresh (alias)', g4xs.refusal('CREDENTIAL_REF_ALIASED'), g4xs.r(current_setting('g4xs.e')));
update public.social_accounts set vault_refresh_token_secret_id = current_setting('g4xs.er')::uuid where id = current_setting('g4xs.e');
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.ea')::uuid where id = current_setting('g4xs.f');
select g4xs.check_('21 F points at E''s access secret: E refused', g4xs.refusal('CREDENTIAL_REF_SHARED'), g4xs.r(current_setting('g4xs.e')));
select g4xs.check_('21 F points at E''s access secret: F refused', g4xs.refusal('CREDENTIAL_REF_SHARED'), g4xs.r(current_setting('g4xs.f')));
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.fa')::uuid where id = current_setting('g4xs.f');
update public.social_accounts set vault_refresh_token_secret_id = current_setting('g4xs.er')::uuid where id = current_setting('g4xs.f');
select g4xs.check_('21 F''s refresh = E''s refresh: E refused', g4xs.refusal('CREDENTIAL_REF_SHARED'), g4xs.r(current_setting('g4xs.e')));
update public.social_accounts set vault_refresh_token_secret_id = current_setting('g4xs.fr')::uuid where id = current_setting('g4xs.f');
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.fr')::uuid, vault_refresh_token_secret_id = current_setting('g4xs.fa')::uuid where id = current_setting('g4xs.f');
select g4xs.check_('21 F''s access / refresh swapped (purpose)', g4xs.refusal('CREDENTIAL_REF_PURPOSE'), g4xs.r(current_setting('g4xs.f')));
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.fa')::uuid, vault_refresh_token_secret_id = current_setting('g4xs.fr')::uuid where id = current_setting('g4xs.f');
-- a restore that re-points E at a copy of F's secret (not shared any more, but another account's credential)
update public.social_accounts set vault_access_token_secret_id = vault.create_secret('fakeXat_g4xs-f1-label', current_setting('g4xs.f') || '_restored_access_token') where id = current_setting('g4xs.e');
select g4xs.check_('21 E points at a copy of another account''s secret (purpose)', g4xs.refusal('CREDENTIAL_REF_PURPOSE'), g4xs.r(current_setting('g4xs.e')));
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.ea')::uuid where id = current_setting('g4xs.e');
update vault.secrets set name = null where id = current_setting('g4xs.ea')::uuid;
select g4xs.check_('21 unnamed access secret (purpose unknown)', g4xs.refusal('CREDENTIAL_UNREADABLE'), g4xs.r(current_setting('g4xs.e')));
update vault.secrets set name = current_setting('g4xs.e') || '_access_token' where id = current_setting('g4xs.ea')::uuid;
update public.social_accounts set vault_access_token_secret_id = gen_random_uuid() where id = current_setting('g4xs.e');
select g4xs.check_('21 dangling access reference', g4xs.refusal('CREDENTIAL_UNREADABLE'), g4xs.r(current_setting('g4xs.e')));
update public.social_accounts set vault_access_token_secret_id = null where id = current_setting('g4xs.e');
select g4xs.check_('21 no access reference', g4xs.refusal('CREDENTIAL_MISSING'), g4xs.r(current_setting('g4xs.e')));
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.ea')::uuid where id = current_setting('g4xs.e');
select g4xs.check_('21 restored: E verified again', 'VERIFIED|fakeXat_g4xs-e2-label', split_part(g4xs.r(current_setting('g4xs.e')), '|', 1) || '|' || split_part(g4xs.r(current_setting('g4xs.e')), '|', 3));
select g4xs.check_('21 F untouched', 'VERIFIED|fakeXat_g4xs-f1-label', split_part(g4xs.r(current_setting('g4xs.f')), '|', 1) || '|' || split_part(g4xs.r(current_setting('g4xs.f')), '|', 3));

-- 13. no refusal above ever carried a token or a Vault id; the function's text has no log / notice
select g4xs.check_('13 refusals carry nothing', '0', (select count(*)::text from g4xs.results where expected ~ '\|-\|-$' and actual !~ '\|-\|-$'));
select g4xs.check_('13 no notice / log in the body', 'clean',
  case when (select prosrc from pg_proc where oid = 'public.postona_x_send_credential_for_claim_v1(uuid,uuid,text,uuid)'::regprocedure) ~* '\m(raise|notice)\M' then 'LOGS' else 'clean' end);

\o
select n, case_id, case when expected = actual then 'ok' else 'FAIL expected ' || expected || ' got ' || actual end from g4xs.results order by n;
do $$ begin
  if exists (select 1 from g4xs.results where expected is distinct from actual) then raise exception 'G4XS_BEHAVIOR_FAIL'; end if;
  if (select count(*) from g4xs.results) < 89 then raise exception 'G4XS_BEHAVIOR_INCOMPLETE'; end if;
end $$;
select 'G4XS_BEHAVIOR_PASS';
