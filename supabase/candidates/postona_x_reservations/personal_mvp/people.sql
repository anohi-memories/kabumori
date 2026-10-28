-- G3-39 people (TEST ONLY, fake ids): A and D = POSTONA x_autopost started, own workspace, a live session, a fake "verified X account"
-- (G3's G4 TEST DOUBLE reads these columns; no token, no Vault, no SNS) with publishing switched on; B = another login.
\ir helpers.sql

select public.fixture_user_with_workspace(u, 's39' || right(u::text, 2)), public.fixture_login(u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(2), pg_temp.uid(4)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(1), pg_temp.uid(2), pg_temp.uid(4)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(1)), pg_temp.ws(pg_temp.uid(4)));
update public.social_accounts set platform = 'x', connection_status = 'identity_verified', verified_at = now(), last_connection_error_code = null,
  platform_user_id = 'fake-x-' || right(brand_id, 6), vault_access_token_secret_id = gen_random_uuid(), vault_refresh_token_secret_id = gen_random_uuid(),
  publish_enabled = true
where brand_id in (pg_temp.ws(pg_temp.uid(1)), pg_temp.ws(pg_temp.uid(4)));
select pg_temp.expect(pg_temp.acct(u) is not null and postona_x_resv.g4_x_account_verified(u, pg_temp.acct(u)), 'setup: fake verified X ' || u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
select pg_temp.expect(private.postona_personal_worker_verdict(u, pg_temp.ws(u), 'x_autopost', pg_temp.lv(u)) = 'active', 'setup: MV active ' || u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
