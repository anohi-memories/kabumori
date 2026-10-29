-- G3-45 (TEST ONLY, fake data): the people and rows for the app-near HTTP e2e (personal_mvp_run.sh, phase HE), in the personal MVP world
-- with 008 + 010 + 012. Two new people, H = uid(12) and I = uid(13), set up as personal_mvp/live_rows.sql does. Rows come from the real
-- paths (API create / reschedule, worker claim, claim_due's sweep, G5's service end); only the clock is moved. Then H's service-end saga
-- begins. The ids and the live session ids are left in t45 for http_e2e_test.ts (read by the owner).
\ir ../personal_mvp/helpers.sql

create schema t45;
create table t45.ids (name text primary key, id uuid);
create table t45.people (name text primary key, user_id uuid, session_id uuid, account text);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t45.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t45.ids where name = p_name $$;

select public.fixture_user_with_workspace(u, 's45' || right(u::text, 2)), public.fixture_login(u) from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(12)), pg_temp.ws(pg_temp.uid(13)));
update public.social_accounts set platform = 'x', connection_status = 'identity_verified', verified_at = now(), last_connection_error_code = null,
  platform_user_id = 'fake-x-' || right(brand_id, 6), vault_access_token_secret_id = gen_random_uuid(), vault_refresh_token_secret_id = gen_random_uuid(),
  publish_enabled = true
where brand_id in (pg_temp.ws(pg_temp.uid(12)), pg_temp.ws(pg_temp.uid(13)));
select pg_temp.expect(postona_x_resv.g4_x_account_verified(u, pg_temp.acct(u)), 'setup: fake verified X ' || u) from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
select pg_temp.expect((select bool_and(prosrc ~ 'G3_OWNER_READ') from pg_proc where oid in ('postona_x_resv.get_reservation(uuid)'::regprocedure, 'postona_x_resv.list_reservations(text)'::regprocedure))
  and (select prosrc ~ 'G3_OWNER_CANCEL' from pg_proc where oid = 'postona_x_resv.cancel(uuid,integer)'::regprocedure), 'setup: 010 + 012 applied');

select pg_temp.keep(t.name, pg_temp.reserve(t.u, 'g45' || t.name, t.h)) is not null
from (values ('h1', pg_temp.uid(12), 500), ('h2', pg_temp.uid(12), 510), ('h3', pg_temp.uid(12), 520), ('h4', pg_temp.uid(12), 530),
             ('i1', pg_temp.uid(13), 500)) t(name, u, h);
-- another device reschedules h1 (revision 1 -> 2); h3's lease runs out -> uncertain
select pg_temp.expect(pg_temp.api(format('select revision from postona_x_resv.reschedule(%L, 1, %L)', pg_temp.id('h1'), now() + interval '501 hours'), pg_temp.uid(12)) = '2',
  'setup: h1 rescheduled elsewhere');
select pg_temp.make_due(pg_temp.id('h3'));
select pg_temp.expect(pg_temp.claim() like '%' || pg_temp.id('h3') || '=%', 'setup: h3 claimed');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('h3');
select pg_temp.claim();
select pg_temp.expect(pg_temp.row_of(pg_temp.id('h3')) = 'uncertain/LEASE_EXPIRED', 'setup: h3 uncertain');
-- H's service-end saga begins
select pg_temp.expect(pg_temp.as_role(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')::text', pg_temp.uid(12)), 'service_role') !~ '^ERR', 'setup: H end begins');

insert into t45.people
select p.name, p.u, (select s.id from auth.sessions s where s.user_id = p.u order by s.id limit 1), pg_temp.acct(p.u)
from (values ('h', pg_temp.uid(12)), ('i', pg_temp.uid(13))) p(name, u);
select pg_temp.expect((select count(*) = 2 and bool_and(session_id is not null) from t45.people), 'setup: sessions');
select 'G3_HTTP_E2E_SETUP_PASS';
