-- Behaviour of the X OAuth T13 guard (001) on G5's production-shaped disposable baseline (real G5 candidate SQL: the
-- lifecycle, enrollment and the Phase 3b service-write guard) with the live v1 onboarding RPCs underneath, plus the
-- F3 reservation candidate (001-004) for the onboarding -> reservation chain. Run by run.sh as the schema owner.
-- MOCK_ONLY: G4's verified-X-account predicate is the t_mock.verified allow list (G4 not delivered, Issue #131); the
-- X identity and tokens are fake strings. TEST STAND-INS: owner UPDATEs set lifecycle states no client reaches.
\ir helpers.sql
create function pg_temp.err(p_text text) returns text language sql immutable as $$
  select case when p_text like 'ERR:%' then substr(p_text, 5) else '<ok>' end $$;
create function pg_temp.api(p_sql text, p_sub uuid) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  set local role postona_resv_api;
  execute p_sql into v;
  reset role;
  perform pg_temp.claims(null, null);
  return coalesce(v, '<null>');
exception when others then
  reset role;
  perform pg_temp.claims(null, null);
  return 'ERR:' || sqlerrm;
end $$;
create function pg_temp.reserve_sql(p_user uuid, p_account text, p_draft text) returns text language sql as $$
  select format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    p_account, jsonb_build_array(jsonb_build_object('draft_id', p_draft,
      'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '10:00') at time zone 'Asia/Tokyo', 'body', 'onboarded ' || p_draft,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('onboarded ' || p_draft, 'UTF8')), 'hex'))))) $$;

-- G1: an enrolled person with a live session: begin -> consume -> complete; then a reconnect keeps the verified identity.
select pg_temp.enrolled(71) is not null as setup_71;
select pg_temp.session(pg_temp.uid(71)) as s71 \gset
select pg_temp.as_person(pg_temp.begin_sql('g1'), pg_temp.uid(71), :'s71') as a71 \gset
select pg_temp.expect(:'a71' ~ '^sa_', 'G1 begin ' || :'a71');
select pg_temp.as_person(pg_temp.consume_sql('g1'), pg_temp.uid(71), :'s71') as st71 \gset
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.complete_sql(:'st71'::uuid, '7101'), pg_temp.uid(71), :'s71')) = '<ok>', 'G1 complete');
select pg_temp.expect((select connection_status = 'identity_verified' and platform_user_id = '7101' and publish_enabled = false
                       and vault_access_token_secret_id is not null from public.social_accounts where id = :'a71'), 'G1 verified, publishing still off');
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.begin_sql('g1b'), pg_temp.uid(71), :'s71')) = '<ok>', 'G1 reconnect begin');
select pg_temp.expect((select connection_status from public.social_accounts where id = :'a71') = 'identity_verified', 'G1 reconnect keeps the verified identity');
select pg_temp.as_person(pg_temp.consume_sql('g1b'), pg_temp.uid(71), :'s71') as st71b \gset
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.complete_sql(:'st71b'::uuid, '7101'), pg_temp.uid(71), :'s71')) = '<ok>', 'G1 reconnect complete');
select 'G1_ENROLLED_CONNECT_RECONNECT_PASS' as result;

-- G2: x_autopost ended -> begin, consume and complete all refuse SERVICE_NOT_ACTIVE; nothing is written.
select pg_temp.enrolled(72) is not null as setup_72;
select pg_temp.session(pg_temp.uid(72)) as s72 \gset
select pg_temp.as_person(pg_temp.begin_sql('g2'), pg_temp.uid(72), :'s72') as a72 \gset
select pg_temp.end_service(pg_temp.uid(72));
select pg_temp.footprint(pg_temp.uid(72)) as fp72 \gset
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.begin_sql('g2b'), pg_temp.uid(72), :'s72')) = 'SERVICE_NOT_ACTIVE', 'G2 begin refused');
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.consume_sql('g2'), pg_temp.uid(72), :'s72')) = 'SERVICE_NOT_ACTIVE', 'G2 consume refused (before the X code exchange)');
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.complete_sql(pg_temp.state_id('g2'), '7201'), pg_temp.uid(72), :'s72')) = 'SERVICE_NOT_ACTIVE', 'G2 complete refused');
select pg_temp.expect(pg_temp.footprint(pg_temp.uid(72)) = :'fp72', 'G2 nothing written: ' || pg_temp.footprint(pg_temp.uid(72)));
select pg_temp.expect((select connection_status = 'authorization_pending' and platform_user_id is null from public.social_accounts where id = :'a72'), 'G2 account untouched');
select 'G2_SERVICE_ENDED_REFUSED_NOTHING_WRITTEN_PASS' as result;

-- G3: account being deleted, account locked, x_autopost not started, service being deleted: refused with the guard's code.
select pg_temp.enrolled(73) is not null as setup_73;
select pg_temp.session(pg_temp.uid(73)) as s73 \gset
update public.common_accounts set status = 'deleting' where user_id = pg_temp.uid(73);
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.begin_sql('g3a'), pg_temp.uid(73), :'s73')) = 'ACCOUNT_DELETION_IN_PROGRESS', 'G3 deleting');
select pg_temp.enrolled(74) is not null as setup_74;
select pg_temp.session(pg_temp.uid(74)) as s74 \gset
update public.common_accounts set status = 'locked' where user_id = pg_temp.uid(74);
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.begin_sql('g3b'), pg_temp.uid(74), :'s74')) = 'ACCOUNT_LOCKED', 'G3 locked');
select public.fixture_login(pg_temp.uid(75)) is null as setup_75;
select pg_temp.session(pg_temp.uid(75)) as s75 \gset
select pg_temp.as_person('select public.start_kabumori_service() ->> ''status''', pg_temp.uid(75), :'s75') as k75 \gset
select pg_temp.as_person(pg_temp.begin_sql('g3c'), pg_temp.uid(75), :'s75') as g3c \gset
select pg_temp.expect(pg_temp.err(:'g3c') = 'SERVICE_NOT_REGISTERED', 'G3 x_autopost never started: ' || :'g3c');
select pg_temp.enrolled(76) is not null as setup_76;
select pg_temp.session(pg_temp.uid(76)) as s76 \gset
update public.service_entitlements set status = 'deleting' where user_id = pg_temp.uid(76) and service_key = 'x_autopost';
select pg_temp.as_person(pg_temp.begin_sql('g3d'), pg_temp.uid(76), :'s76') as g3d \gset
select pg_temp.expect(pg_temp.err(:'g3d') in ('SERVICE_NOT_ACTIVE', 'SERVICE_DELETION_IN_PROGRESS'), 'G3 service being deleted: ' || :'g3d');
select pg_temp.expect((select count(*) from public.social_account_oauth_states where initiated_by_user_id in (pg_temp.uid(73), pg_temp.uid(74), pg_temp.uid(75), pg_temp.uid(76))) = 0, 'G3 no state written');
select pg_temp.expect((select count(*) from public.brands where id in (select public.social_mobile_account_deletion_workspace(pg_temp.uid(n)) from generate_series(73, 76) n)) = 0, 'G3 no workspace created');
select 'G3_LIFECYCLE_STATES_REFUSED_PASS' as result;

-- G4: a signed-out (old) JWT: the session row is gone -> refused, even with a valid subject; a new session works.
select pg_temp.enrolled(77) is not null as setup_77;
select pg_temp.session(pg_temp.uid(77)) as s77 \gset
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.begin_sql('g4'), pg_temp.uid(77), :'s77')) = '<ok>', 'G4 begin');
delete from auth.sessions where id = :'s77';
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.consume_sql('g4'), pg_temp.uid(77), :'s77')) = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'G4 old session refused');
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.consume_sql('g4'), pg_temp.uid(77), null)) = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'G4 no session id refused');
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.consume_sql('g4'), null, null)) = 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED', 'G4 no caller keeps the live code');
select pg_temp.session(pg_temp.uid(77)) as s77b \gset
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.consume_sql('g4'), pg_temp.uid(77), :'s77b')) = '<ok>', 'G4 new session works');
select 'G4_SIGNED_OUT_JWT_REFUSED_PASS' as result;

-- G5: another enrolled person cannot consume / complete this person's state (the live checks, now behind T13).
select pg_temp.enrolled(78) is not null as setup_78;
select pg_temp.session(pg_temp.uid(78)) as s78 \gset
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.consume_sql('g4'), pg_temp.uid(78), :'s78')) = 'OAUTH_STATE_NOT_CONSUMABLE', 'G5 other consume');
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.complete_sql(pg_temp.state_id('g4'), '7801'), pg_temp.uid(78), :'s78')) = 'OAUTH_STATE_NOT_CONSUMABLE', 'G5 other complete');
select pg_temp.expect((select consumed_at is null from public.social_account_oauth_states where id = pg_temp.state_id('g4')), 'G5 state still open');
-- ... and a session of person 78 cannot act as person 77 (subject and session belong together).
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.consume_sql('g4'), pg_temp.uid(77), :'s78')) = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED', 'G5 foreign session');
select 'G5_OTHER_PERSON_REFUSED_PASS' as result;

-- G6: the service ends during the X code exchange (between consume and complete): complete refuses, the state stays
-- unconsumed, no Vault secret and no identity are written.
select pg_temp.enrolled(79) is not null as setup_79;
select pg_temp.session(pg_temp.uid(79)) as s79 \gset
select pg_temp.as_person(pg_temp.begin_sql('g6'), pg_temp.uid(79), :'s79') as a79 \gset
select pg_temp.as_person(pg_temp.consume_sql('g6'), pg_temp.uid(79), :'s79') as st79 \gset
select pg_temp.end_service(pg_temp.uid(79));
select (select count(*) from vault.secrets) as secrets_before \gset
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.complete_sql(:'st79'::uuid, '7901'), pg_temp.uid(79), :'s79')) = 'SERVICE_NOT_ACTIVE', 'G6 complete refused');
select pg_temp.expect((select count(*) from vault.secrets) = :'secrets_before'::int, 'G6 no secret');
select pg_temp.expect((select consumed_at is null from public.social_account_oauth_states where id = :'st79'::uuid), 'G6 state not consumed');
select pg_temp.expect((select platform_user_id is null and connection_status = 'authorization_pending' from public.social_accounts where id = :'a79'), 'G6 no identity');
select 'G6_SERVICE_ENDED_DURING_EXCHANGE_PASS' as result;

-- G7: ACL. anon / service_role cannot call the wrappers; authenticated cannot call the unguarded functions or the guard.
select pg_temp.expect(pg_temp.as_person(pg_temp.begin_sql('g7'), pg_temp.uid(71), :'s71', r) like 'ERR:permission denied%', 'G7 wrapper closed to ' || r)
  from unnest(array['anon', 'service_role']) r;
select pg_temp.expect(pg_temp.as_person(q, pg_temp.uid(71), :'s71') like 'ERR:permission denied%', 'G7 authenticated refused: ' || q) from unnest(array[
  format('select count(*)::text from public.begin_social_mobile_x_oauth_connection_unguarded_v1(%L, %L, now() + interval ''5 minutes'')', pg_temp.state_hash('g7u'), 'kabumori://oauth/x'),
  format('select count(*)::text from public.consume_social_mobile_x_oauth_state_unguarded_v1(%L)', pg_temp.state_hash('g1')),
  format('select public.complete_social_mobile_x_oauth_connection_unguarded_v1(%L::uuid, ''1'', ''h'', ''a'', ''r'')::text', :'st71'),
  format('select private.account_lifecycle_assert_active_service_write(%L::uuid, ''x_autopost'')::text', pg_temp.uid(71))]) q;
select 'G7_ACL_PASS' as result;

-- R: onboarding -> reservation. The connected person reserves (G5 + mocked G4); once x_autopost ends, the reconnect, the
-- reservation API and the worker all refuse, and the earlier planned row is never claimed.
insert into t_mock.verified values (pg_temp.uid(71), :'a71');
select pg_temp.api(pg_temp.reserve_sql(pg_temp.uid(71), :'a71', 'r71'), pg_temp.uid(71)) as r71 \gset
select pg_temp.expect(:'r71' ~ '^[0-9a-f-]{36}$', 'R reservation after onboarding ' || :'r71');
select pg_temp.end_service(pg_temp.uid(71));
select pg_temp.expect(pg_temp.err(pg_temp.as_person(pg_temp.begin_sql('r71'), pg_temp.uid(71), :'s71')) = 'SERVICE_NOT_ACTIVE', 'R reconnect refused');
select pg_temp.expect(pg_temp.err(pg_temp.api(pg_temp.reserve_sql(pg_temp.uid(71), :'a71', 'r71b'), pg_temp.uid(71))) = 'POSTONA_RESV_SERVICE_NOT_ACTIVE', 'R new reservation refused');
update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute', expires_at = now() + interval '6 hours' where id = :'r71';
begin;
set local role postona_resv_worker;
select count(*) as r71claimed from postona_x_resv.claim_due('w1', 120, 50) where reservation_id = :'r71' \gset
commit;
select pg_temp.expect(:'r71claimed'::int = 0, 'R worker skips the ended person');
select pg_temp.expect((select status from postona_x_resv.reservations where id = :'r71') = 'planned', 'R stays planned');
select 'R_ONBOARDING_TO_RESERVATION_FENCED_PASS' as result;

select 'POSTONA_X_OAUTH_T13_BEHAVIOR_PASS' as result;
