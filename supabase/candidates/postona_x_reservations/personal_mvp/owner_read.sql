-- G3-44 (TEST ONLY, fake data): the person reads their own reservations without the service gate (012) and recovers a stale revision to
-- cancel (010), in the personal MVP world with 008 (personal_mvp_run.sh, phase RD). Two new people, F = uid(10) and G = uid(11), set up as
-- live_rows.sql does. Every state comes from the real paths (API create / reschedule / list / get / cancel, worker claim, claim_due's
-- sweep, G5's service end / restart); only the clock is moved. F's f9 stays planned for the runner's 012 rollback check.
\ir helpers.sql

create schema t44;
create table t44.ids (name text primary key, id uuid);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t44.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t44.ids where name = p_name $$;
-- the person's reads through the API role: status@revision, or ERR:<code>
create function pg_temp.get(p_name text, p_sub uuid) returns text language sql as $$
  select pg_temp.api(format('select status || ''@'' || revision from postona_x_resv.get_reservation(%L)', pg_temp.id(p_name)), p_sub) $$;
create function pg_temp.list(p_account text, p_sub uuid) returns text language sql as $$
  select pg_temp.api(format('select coalesce(string_agg(draft_id || ''='' || status || ''@'' || revision, '' '' order by draft_id), '''') from postona_x_resv.list_reservations(%L)', p_account), p_sub) $$;
create function pg_temp.cancel(p_name text, p_sub uuid, p_rev integer) returns text language sql as $$
  select pg_temp.api(format('select status || ''@'' || revision from postona_x_resv.cancel(%L, %s)', pg_temp.id(p_name), p_rev), p_sub) $$;
-- a read with hand-made claims (anonymous / unknown anonymity): the API role, the person's live session
create function pg_temp.get_with(p_name text, p_sub uuid, p_claims jsonb) returns text language plpgsql as $$
declare v text; v_session uuid; v_id uuid := pg_temp.id(p_name);
begin
  select s.id into v_session from auth.sessions s where s.user_id = p_sub and (s.not_after is null or s.not_after > clock_timestamp()) order by s.id limit 1;
  perform set_config('request.jwt.claims', (jsonb_build_object('sub', p_sub, 'role', 'authenticated', 'session_id', v_session) || p_claims)::text, true);
  execute 'set local role postona_resv_api';
  execute format('select status from postona_x_resv.get_reservation(%L)', v_id) into v;
  reset role; perform set_config('request.jwt.claims', '', true);
  return coalesce(v, '<null>');
exception when others then
  reset role; perform set_config('request.jwt.claims', '', true);
  return 'ERR:' || sqlerrm;
end $$;

select public.fixture_user_with_workspace(u, 's44' || right(u::text, 2)), public.fixture_login(u) from unnest(array[pg_temp.uid(10), pg_temp.uid(11)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(10), pg_temp.uid(11)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(10), pg_temp.uid(11)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(10)), pg_temp.ws(pg_temp.uid(11)));
update public.social_accounts set platform = 'x', connection_status = 'identity_verified', verified_at = now(), last_connection_error_code = null,
  platform_user_id = 'fake-x-' || right(brand_id, 6), vault_access_token_secret_id = gen_random_uuid(), vault_refresh_token_secret_id = gen_random_uuid(),
  publish_enabled = true
where brand_id in (pg_temp.ws(pg_temp.uid(10)), pg_temp.ws(pg_temp.uid(11)));
select pg_temp.expect(postona_x_resv.g4_x_account_verified(u, pg_temp.acct(u)), 'setup: fake verified X ' || u) from unnest(array[pg_temp.uid(10), pg_temp.uid(11)]) u;
select pg_temp.expect((select bool_and(prosrc ~ 'G3_OWNER_READ') from pg_proc
                       where oid in ('postona_x_resv.get_reservation(uuid)'::regprocedure, 'postona_x_resv.list_reservations(text)'::regprocedure)), 'setup: 012 applied');

select pg_temp.keep(t.name, pg_temp.reserve(t.u, 'g44' || t.name, t.h)) is not null
from (values ('f1', pg_temp.uid(10), 400), ('f2', pg_temp.uid(10), 410), ('f3', pg_temp.uid(10), 420), ('f9', pg_temp.uid(10), 430),
             ('g1', pg_temp.uid(11), 400)) t(name, u, h);

-- setup while F's service is active: another device reschedules f1 (revision 1 -> 2; the app still holds 1); f3's lease runs out -> uncertain
select pg_temp.expect(pg_temp.api(format('select revision from postona_x_resv.reschedule(%L, 1, %L)', pg_temp.id('f1'), now() + interval '401 hours'), pg_temp.uid(10)) = '2',
  'setup: f1 rescheduled elsewhere');
select pg_temp.make_due(pg_temp.id('f3'));
select pg_temp.expect(pg_temp.claim() like '%' || pg_temp.id('f3') || '=%', 'setup: f3 claimed');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('f3');
select pg_temp.claim();
select pg_temp.expect(pg_temp.row_of(pg_temp.id('f3')) = 'uncertain/LEASE_EXPIRED', 'setup: f3 uncertain');

-- F's service is being ended: create / reschedule stay refused
select pg_temp.expect(pg_temp.as_role(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')::text', pg_temp.uid(10)), 'service_role') !~ '^ERR', 'setup: F end begins');
select pg_temp.expect(pg_temp.create_raw(pg_temp.uid(10), 'g44f5', 450) like 'ERR:POSTONA_RESV_%', 'RD0 create refused');
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.reschedule(%L, 1, %L)', pg_temp.id('f2'), now() + interval '411 hours'), pg_temp.uid(10))
  like 'ERR:POSTONA_RESV_%', 'RD0 reschedule refused');

-- RD1 after the end F reads their own rows: the list (current states and revisions) and one row
select pg_temp.expect(pg_temp.list(pg_temp.acct(pg_temp.uid(10)), pg_temp.uid(10)) = 'g44f1=planned@2 g44f2=planned@1 g44f3=uncertain@1 g44f9=planned@1',
  'RD1 list ' || pg_temp.list(pg_temp.acct(pg_temp.uid(10)), pg_temp.uid(10)));
select pg_temp.expect(pg_temp.get('f1', pg_temp.uid(10)) = 'planned@2', 'RD1 get f1');
-- RD2 the stale revision is recovered: cancel with 1 -> STALE_REVISION; read 2; cancel with 2 -> cancelled@3; reads agree
select pg_temp.expect(pg_temp.cancel('f1', pg_temp.uid(10), 1) = 'ERR:POSTONA_RESV_STALE_REVISION', 'RD2 stale revision refused');
select pg_temp.expect(pg_temp.cancel('f1', pg_temp.uid(10), split_part(pg_temp.get('f1', pg_temp.uid(10)), '@', 2)::integer) = 'cancelled@3', 'RD2 cancelled with the read revision');
select pg_temp.expect(pg_temp.get('f1', pg_temp.uid(10)) = 'cancelled@3', 'RD2 get after cancel');
select pg_temp.expect(pg_temp.claim() not like '%' || pg_temp.id('f2') || '%', 'RD2 F''s rows never claimed');
-- RD3 the uncertain row reads as uncertain and stays so (not cancellable, never claimed, never re-sent)
select pg_temp.expect(pg_temp.get('f3', pg_temp.uid(10)) = 'uncertain@1', 'RD3 get uncertain');
select pg_temp.expect(pg_temp.cancel('f3', pg_temp.uid(10), 1) = 'ERR:POSTONA_RESV_ALREADY_FINAL', 'RD3 uncertain: final');
select pg_temp.expect(pg_temp.row_of(pg_temp.id('f3')) = 'uncertain/LEASE_EXPIRED', 'RD3 unchanged');

-- RD4 another person: F's row is NOT_FOUND (as an unknown id); F's account lists nothing for G (no error: no oracle); G's own list is G's
select pg_temp.expect(pg_temp.get('f2', pg_temp.uid(11)) = 'ERR:POSTONA_RESV_NOT_FOUND', 'RD4 G cannot read F''s row');
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.get_reservation(%L)', gen_random_uuid()), pg_temp.uid(11)) = 'ERR:POSTONA_RESV_NOT_FOUND', 'RD4 unknown id');
select pg_temp.expect(pg_temp.list(pg_temp.acct(pg_temp.uid(10)), pg_temp.uid(11)) = '', 'RD4 F''s account lists nothing for G');
select pg_temp.expect(pg_temp.list('sa_no_such_account', pg_temp.uid(11)) = '', 'RD4 unknown account lists nothing');
select pg_temp.expect(pg_temp.list(pg_temp.acct(pg_temp.uid(11)), pg_temp.uid(11)) = 'g44g1=planned@1', 'RD4 G''s own list');
select pg_temp.expect(pg_temp.list(pg_temp.acct(pg_temp.uid(11)), pg_temp.uid(10)) = '', 'RD4 G''s account lists nothing for F');
select pg_temp.expect(pg_temp.cancel('f2', pg_temp.uid(11), 1) = 'ERR:POSTONA_RESV_NOT_FOUND', 'RD4 G cannot cancel F''s row');

-- RD5 no subject, an ended session, an anonymous sign-in, an unknown anonymity: refused (the same gate as the cancel)
select pg_temp.expect(pg_temp.get('f2', null) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'RD5 no subject');
select pg_temp.expect(pg_temp.list(pg_temp.acct(pg_temp.uid(10)), null) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'RD5 list, no subject');
select pg_temp.expect(pg_temp.get_with('f2', pg_temp.uid(10), '{"is_anonymous": false}') = 'planned', 'RD5 control: proven non-anonymous reads ' || pg_temp.get_with('f2', pg_temp.uid(10), '{"is_anonymous": false}'));
select pg_temp.expect(pg_temp.get_with('f2', pg_temp.uid(10), '{"is_anonymous": true}') = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'RD5 anonymous');
select pg_temp.expect(pg_temp.get_with('f2', pg_temp.uid(10), '{}') = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'RD5 unknown anonymity');
select pg_temp.expect(pg_temp.get_with('f2', pg_temp.uid(10), '{"is_anonymous": "false"}') = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'RD5 string "false"');
update auth.sessions set not_after = now() - interval '1 second' where user_id = pg_temp.uid(10);
select pg_temp.expect(pg_temp.get('f2', pg_temp.uid(10)) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'RD5 ended session');
select pg_temp.expect(pg_temp.list(pg_temp.acct(pg_temp.uid(10)), pg_temp.uid(10)) = 'ERR:POSTONA_RESV_AUTH_REQUIRED', 'RD5 list, ended session');
update auth.sessions set not_after = null where user_id = pg_temp.uid(10);

-- RD6 G's service restarts (a NEW generation): g1 is of the old one; G reads it and cancels with the read revision
select pg_temp.restart(pg_temp.uid(11)) is not null;
select pg_temp.expect(pg_temp.bound_of(pg_temp.id('g1')) <> 'null/' || pg_temp.lv(pg_temp.uid(11)), 'RD6 g1 is of the old generation');
select pg_temp.expect(pg_temp.get('g1', pg_temp.uid(11)) = 'planned@1', 'RD6 get old-generation row');
select pg_temp.expect(pg_temp.cancel('g1', pg_temp.uid(11), 1) = 'cancelled@2', 'RD6 cancelled');

-- RD7 F cancels f2 too; f9 stays planned for the rollback check
select pg_temp.expect(pg_temp.cancel('f2', pg_temp.uid(10), 1) = 'cancelled@2', 'RD7 f2 cancelled');
select pg_temp.expect(pg_temp.list(pg_temp.acct(pg_temp.uid(10)), pg_temp.uid(10)) = 'g44f1=cancelled@3 g44f2=cancelled@2 g44f3=uncertain@1 g44f9=planned@1', 'RD7 final list');
select 'G3_OWNER_READ_BEHAVIOR_PASS';
