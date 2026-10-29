-- G3-46 (TEST ONLY, fake data): the people and rows for the Threads HTTP e2e (postona_threads_personal_mvp_run.sh, phase HT), in the
-- personal MVP world with 007 + 009. Two new people, H = uid(12) and I = uid(13), set up as personal_mvp/live_rows.sql does (own
-- workspace, live session, POSTONA started, ONE fake verified Threads account each, listed in G3's G4 TEST DOUBLE). Rows come from the
-- real paths (API create, worker claim, claim_due's lease sweep); only the clock is moved. The ids, client request ids and live session
-- ids are left in t46 for http_e2e_test.ts (read by the owner).
\ir ../personal_mvp/helpers.sql

create schema t46;
create table t46.ids (name text primary key, id uuid, client_request_id uuid);
create table t46.people (name text primary key, user_id uuid, session_id uuid, account text);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$
  insert into t46.ids select p_name, r.id, r.client_request_id from postona_threads_resv.reservations r where r.id = p_id returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t46.ids where name = p_name $$;

select public.fixture_user_with_workspace(u, 's46' || right(u::text, 2)), public.fixture_login(u) from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(12)), pg_temp.ws(pg_temp.uid(13)));
insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at,
  vault_access_token_secret_id, vault_refresh_token_secret_id)
select pg_temp.tacct(u), pg_temp.ws(u), 'threads', '@th46' || right(u::text, 2), (17841400000046000 + right(u::text, 2)::integer)::text, true,
       'identity_verified', now(), gen_random_uuid(), null
from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
select pg_temp.tacct(u), gen_random_uuid(), now() + interval '50 days', u from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
insert into t_threads.verified select pg_temp.tacct(u) from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;
select pg_temp.expect(postona_threads_resv.fence(u, pg_temp.tacct(u)) = pg_temp.ws(u), 'setup: Threads fence passes ' || u)
from unnest(array[pg_temp.uid(12), pg_temp.uid(13)]) u;

select pg_temp.keep(t.name, pg_temp.reserve(t.u, 'g46' || t.name, t.h)) is not null
from (values ('h1', pg_temp.uid(12), 500), ('h2', pg_temp.uid(12), 510), ('h3', pg_temp.uid(12), 520), ('h4', pg_temp.uid(12), 530),
             ('i1', pg_temp.uid(13), 500)) t(name, u, h);
-- h3's lease runs out -> uncertain (it may have reached Threads: never claimed again)
select pg_temp.make_due(pg_temp.id('h3'));
select pg_temp.expect(pg_temp.claim() like '%' || pg_temp.id('h3') || '=%', 'setup: h3 claimed');
update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('h3');
select pg_temp.claim();
select pg_temp.expect(pg_temp.row_of(pg_temp.id('h3')) = 'uncertain/LEASE_EXPIRED', 'setup: h3 uncertain');

insert into t46.people
select p.name, p.u, (select s.id from auth.sessions s where s.user_id = p.u order by s.id limit 1), pg_temp.tacct(p.u)
from (values ('h', pg_temp.uid(12)), ('i', pg_temp.uid(13))) p(name, u);
select pg_temp.expect((select count(*) = 2 and bool_and(session_id is not null) from t46.people)
  and (select count(*) = 5 and bool_and(client_request_id is not null) from t46.ids), 'setup: sessions / client request ids');
select 'G3_THREADS_HTTP_E2E_SETUP_PASS';
