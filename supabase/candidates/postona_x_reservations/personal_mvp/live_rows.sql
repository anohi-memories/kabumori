-- G3-42 (TEST ONLY, fake data): MVP-bound rows in every state for the 008 rollback refusals (personal_mvp_run.sh, phase LR). Two new
-- people, A = uid(6) and B = uid(7), set up as people.sql does (own workspace, live session, POSTONA started, fake verified X account),
-- so behavior.sql's people and rows are not touched. Rows of A (all MVP-bound: no owner epoch, generation V):
--   lp planned (future) / lc claimed (live lease) / ll claimed, lease run out / lu uncertain (LEASE_EXPIRED) / le expired
--   ls (G3-43) an expired single post (`single:` draft: single post re-arms it, so it still refuses the rollback; le does not)
--   lpub published / lf failed / lx cancelled
-- and of B: bf planned, re-bound as a FULL-profile row (owner epoch 3) -- the restored pair rule accepts it, so it never blocks the rollback.
-- The states come from the real paths (API create / cancel, worker claim / finish, claim_due's sweeps); only the clock is moved.
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
update public.social_accounts set platform = 'x', connection_status = 'identity_verified', verified_at = now(), last_connection_error_code = null,
  platform_user_id = 'fake-x-' || right(brand_id, 6), vault_access_token_secret_id = gen_random_uuid(), vault_refresh_token_secret_id = gen_random_uuid(),
  publish_enabled = true
where brand_id in (pg_temp.ws(pg_temp.uid(6)), pg_temp.ws(pg_temp.uid(7)));
select pg_temp.expect(postona_x_resv.g4_x_account_verified(u, pg_temp.acct(u)), 'setup: fake verified X ' || u) from unnest(array[pg_temp.uid(6), pg_temp.uid(7)]) u;

select pg_temp.keep(t.name, pg_temp.reserve(pg_temp.uid(6), 'g42' || t.name, t.h)) is not null
from (values ('lp', 200), ('lc', 210), ('ll', 220), ('lu', 230), ('le', 240), ('lpub', 250), ('lf', 260), ('lx', 270)) t(name, h);
select pg_temp.keep('bf', pg_temp.reserve(pg_temp.uid(7), 'g42bf', 200)) is not null;

-- claim_due claims every due row (behavior.sql's too): only ours are checked here
create function pg_temp.claimed(p_names text[]) returns boolean language sql as $$
  with c as (select pg_temp.claim() as v)
  select bool_and(c.v like '%' || pg_temp.id(n) || '=%') from c, unnest(p_names) n $$;
select pg_temp.expect(pg_temp.api(format('select status from postona_x_resv.cancel(%L, 1)', pg_temp.id('lx')), pg_temp.uid(6)) = 'cancelled', 'LR lx cancelled');
select pg_temp.make_due(pg_temp.id(n)) from unnest(array['lu', 'lpub', 'lf']) n;
select pg_temp.expect(pg_temp.claimed(array['lu', 'lpub', 'lf']), 'LR lu / lpub / lf claimed');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''published'', ''1042000000000000001'', null)', pg_temp.id('lpub'), pg_temp.lease_of(pg_temp.id('lpub')))) = 'published', 'LR lpub');
select pg_temp.expect(pg_temp.worker(format('select postona_x_resv.finish(%L, %L, ''failed_before_send'', null, ''TEST_STOP'')', pg_temp.id('lf'), pg_temp.lease_of(pg_temp.id('lf')))) = 'failed_before_send', 'LR lf');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('lu');
-- ls: single post begins (claimed), its lease runs out before the send (handed back to planned), its expiry passes (claim_due's sweep)
select pg_temp.keep('ls', split_part(pg_temp.api(format('select reservation_id || '','' || state from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
  pg_temp.acct(pg_temp.uid(6)), 'G3-43 単発 ls', pg_temp.body_sha('G3-43 単発 ls')), pg_temp.uid(6)), ',', 1)::uuid) is not null;
select pg_temp.expect(pg_temp.row_of(pg_temp.id('ls')) = 'claimed/-', 'LR ls claimed by single post');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('ls');
select pg_temp.expect(pg_temp.api(format('select verdict from postona_x_resv.post_now_preflight(%L, %L)', pg_temp.id('ls'), pg_temp.lease_of(pg_temp.id('ls'))), pg_temp.uid(6))
  = 'RELEASED', 'LR ls released');
update postona_x_resv.reservations set scheduled_at = now() - interval '3 hours', consent_scheduled_at = now() - interval '3 hours', expires_at = now() - interval '1 second'
where id = pg_temp.id('ls');
select pg_temp.make_due(pg_temp.id('le'));
update postona_x_resv.reservations set scheduled_at = now() - interval '3 hours', consent_scheduled_at = now() - interval '3 hours', expires_at = now() - interval '1 second'
where id = pg_temp.id('le');
select pg_temp.claim();  -- the sweeps: lu -> uncertain, le / ls -> expired
select pg_temp.make_due(pg_temp.id(n)) from unnest(array['lc', 'll']) n;
update postona_x_resv.reservations set scheduled_at = now() - interval '5 hours', consent_scheduled_at = now() - interval '5 hours' where id = pg_temp.id('ll');
select pg_temp.expect(pg_temp.claimed(array['lc', 'll']), 'LR lc / ll claimed');
update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('ll');
update postona_x_resv.reservations set bound_owner_epoch = 3 where id = pg_temp.id('bf');

select pg_temp.expect(string_agg(name || '=' || pg_temp.row_of(id) || '@' || pg_temp.bound_of(id), ' ' order by name)
  = format('bf=planned/-@3/%1$s lc=claimed/-@null/%2$s le=expired/-@null/%2$s lf=failed/TEST_STOP@null/%2$s ll=claimed/-@null/%2$s lp=planned/-@null/%2$s '
           'lpub=published/PUBLISHED@null/%2$s ls=expired/-@null/%2$s lu=uncertain/LEASE_EXPIRED@null/%2$s lx=cancelled/-@null/%2$s', pg_temp.lv(pg_temp.uid(7)), pg_temp.lv(pg_temp.uid(6))),
  'LR rows ' || string_agg(name || '=' || pg_temp.row_of(id) || '@' || pg_temp.bound_of(id), ' ' order by name)) from t42.ids;
select 'G3_LIVE_ROWS_SETUP_PASS';
