-- G3-40 people (TEST ONLY, fake ids): A and D = POSTONA x_autopost started (the Threads service key too), own workspace, a live session,
-- ONE fake "verified Threads account" each (identity_verified, publish switch ON, a fake access reference, custody recorded, listed in
-- G3's G4 TEST DOUBLE; no token, no Vault, no SNS); B = another login without the service.
\ir helpers.sql

select public.fixture_user_with_workspace(u, 's40' || right(u::text, 2)), public.fixture_login(u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(2), pg_temp.uid(4)]) u;
insert into auth.sessions (user_id, not_after) select u, null from unnest(array[pg_temp.uid(1), pg_temp.uid(2), pg_temp.uid(4)]) u;
select pg_temp.expect(pg_temp.as_role('select public.start_x_autopost_service() ->> ''status''', 'authenticated', u) = 'active', 'setup: start ' || u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
update public.brands set code_profile_key = 'social_mobile_user_v1' where id in (pg_temp.ws(pg_temp.uid(1)), pg_temp.ws(pg_temp.uid(4)));
insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at,
  vault_access_token_secret_id, vault_refresh_token_secret_id)
select pg_temp.tacct(u), pg_temp.ws(u), 'threads', '@th40' || right(u::text, 2), (17841400000040000 + right(u::text, 2)::integer)::text, true,
       'identity_verified', now(), gen_random_uuid(), null
from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
select pg_temp.tacct(u), gen_random_uuid(), now() + interval '50 days', u from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
insert into t_threads.verified select pg_temp.tacct(u) from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
select pg_temp.expect(postona_threads_resv.fence(u, pg_temp.tacct(u)) = pg_temp.ws(u), 'setup: Threads fence passes ' || u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
select pg_temp.expect(private.postona_personal_worker_verdict(u, pg_temp.ws(u), 'x_autopost', pg_temp.lv(u)) = 'active', 'setup: MV active ' || u)
from unnest(array[pg_temp.uid(1), pg_temp.uid(4)]) u;
