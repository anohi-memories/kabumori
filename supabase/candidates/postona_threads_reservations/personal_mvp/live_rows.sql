-- G3-42 (TEST ONLY, fake data): MVP-bound Threads rows in every state for the 009 rollback refusals (postona_threads_personal_mvp_run.sh,
-- phase LR). Two new people, A = uid(6) and B = uid(7), set up as people.sql does (own workspace, live session, POSTONA started, ONE fake
-- verified Threads account each, listed in G3's G4 TEST DOUBLE), so behavior.sql's people and rows are not touched. Rows of A (MVP-bound:
-- no owner epoch, generation V):
--   lp planned (future) / lc claimed (live lease) / ll claimed, lease run out / lu uncertain (LEASE_EXPIRED) / lpub published / lf failed / lx cancelled
-- and of B: bf planned, re-bound as a FULL-profile row (owner epoch 3) -- the restored pair rule accepts it, so it never blocks the rollback.
-- The states come from the real paths (API create / cancel, worker claim / record, claim_due's lease sweep); only the clock is moved.
\ir helpers.sql

create schema t42;
create table t42.ids (name text primary key, id uuid);
create function pg_temp.keep(p_name text, p_id uuid) returns uuid language sql as $$ insert into t42.ids values (p_name, p_id) returning id $$;
create function pg_temp.id(p_name text) returns uuid language sql stable as $$ select id from t42.ids where name = p_name $$;

select public.fixture_user_with_workspace(u, 's42' || right(u::text, 2)), public.fixture_login(u) from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(6)), pg_temp.ws(pg_temp.uid(7)));
insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at,
  vault_access_token_secret_id, vault_refresh_token_secret_id)
select pg_temp.tacct(u), pg_temp.ws(u), 'threads', '@th42' || right(u::text, 2), (17841400000042000 + right(u::text, 2)::integer)::text, true,
       'identity_verified', now(), gen_random_uuid(), null
from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
select pg_temp.tacct(u), gen_random_uuid(), now() + interval '50 days', u from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;
insert into t_threads.verified select pg_temp.tacct(u) from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;
select pg_temp.expect(postona_threads_resv.fence(u, pg_temp.tacct(u)) = pg_temp.ws(u), 'setup: Threads fence passes ' || u)
from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;

select pg_temp.keep(t.name, pg_temp.reserve(pg_temp.uid(6), 'g42' || t.name, t.h)) is not null
from (values ('lp', 200), ('lc', 210), ('ll', 220), ('lu', 230), ('lpub', 250), ('lf', 260), ('lx', 270)) t(name, h);
select pg_temp.keep('bf', pg_temp.reserve(pg_temp.uid(7), 'g42bf', 200)) is not null;

-- claim_due claims every due row (behavior.sql's too): only ours are checked here
create function pg_temp.claimed(p_names text[]) returns boolean language sql as $$
  with c as (select pg_temp.claim() as v)
  select bool_and(c.v like '%' || pg_temp.id(n) || '=%') from c, unnest(p_names) n $$;
select pg_temp.expect(v = 'cancelled', 'LR lx cancelled ' || v)
from (select pg_temp.api(format('select postona_threads_resv.cancel_reservation(%L)', pg_temp.id('lx')), pg_temp.uid(6)) as v) c;
select pg_temp.make_due(pg_temp.id(n)) from unnest(array['lu', 'lpub', 'lf']) n;
select pg_temp.expect(pg_temp.claimed(array['lu', 'lpub', 'lf']), 'LR lu / lpub / lf claimed');
select pg_temp.expect(pg_temp.record(pg_temp.id('lpub'), 'published', '18042000000000001', null) = 'published', 'LR lpub');
select pg_temp.expect(pg_temp.record(pg_temp.id('lf'), 'failed_before_send', null, 'TEST_STOP') = 'failed_before_send', 'LR lf');
update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('lu');
select pg_temp.claim();  -- the lease sweep: lu -> uncertain
select pg_temp.make_due(pg_temp.id(n)) from unnest(array['lc', 'll']) n;
select pg_temp.expect(pg_temp.claimed(array['lc', 'll']), 'LR lc / ll claimed');
update postona_threads_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('ll');
update postona_threads_resv.reservations set bound_owner_epoch = 3 where id = pg_temp.id('bf');

select pg_temp.expect(string_agg(name || '=' || pg_temp.row_of(id) || '@' || pg_temp.bound_of(id), ' ' order by name)
  = format('bf=planned/-@3/%1$s lc=claimed/-@null/%2$s lf=failed/TEST_STOP@null/%2$s ll=claimed/-@null/%2$s lp=planned/-@null/%2$s '
           'lpub=published/PUBLISHED@null/%2$s lu=uncertain/LEASE_EXPIRED@null/%2$s lx=cancelled/-@null/%2$s', pg_temp.lv(pg_temp.uid(7)), pg_temp.lv(pg_temp.uid(6))),
  'LR rows ' || string_agg(name || '=' || pg_temp.row_of(id) || '@' || pg_temp.bound_of(id), ' ' order by name)) from t42.ids;
select 'G3_THREADS_LIVE_ROWS_SETUP_PASS';
