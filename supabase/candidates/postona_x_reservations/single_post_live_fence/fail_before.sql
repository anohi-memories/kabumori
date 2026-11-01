-- FAIL-BEFORE on 005 alone (PR #272's single post, before 006): each M1-F1 gap is shown to let a send through. Run by
-- single_post_live_fence_run.sh BEFORE 006 is applied; every marker here means "the gap exists on 005". Fake data only.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
create function pg_temp.api(p_sql text, p_user uuid, p_session uuid) returns text language sql as $$ select pg_temp.as_person(p_sql, p_user, p_session, 'postona_resv_api') $$;
create function pg_temp.begin_sp(p_account text, p_text text) returns text language sql as $$
  select format('select state || coalesce(''/'' || lease_token::text, '''') || ''/'' || reservation_id from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)',
                p_account, p_text, encode(sha256(convert_to(p_text, 'UTF8')), 'hex')) $$;
create function pg_temp.person(p_n integer) returns uuid language sql as $$ select user_id from t_ids.people where n = p_n $$;
create function pg_temp.account(p_n integer) returns text language sql as $$ select account from t_ids.people where n = p_n $$;
create function pg_temp.brand(p_n integer) returns text language sql as $$ select brand from t_ids.people where n = p_n $$;
-- G3-38: 005's begin (PR #272) binds no owner epoch, so the new W1 check would refuse every 005 row first and hide the gap each FB
-- shows. TEST ONLY: bind the row to the workspace's CURRENT epoch (g5_r1_w1_test_double.sql) right before its check, as 006's begin does.
create function pg_temp.bind_now(p_rid uuid) returns void language sql as $$
  update postona_x_resv.reservations r set bound_owner_epoch = coalesce((select e.v from t_g5x.owner_epoch e where e.brand_id = r.brand_id), 1),
         bound_lifecycle_version = 1 where r.id = p_rid $$;
select pg_temp.session(pg_temp.person(n)) as s79, pg_temp.session(pg_temp.person(n + 1)) as s80, pg_temp.session(pg_temp.person(n + 3)) as s82 from (select 79 n) x \gset

-- FB1 (B6): the publish switch is OFF (as the onboarding leaves it) -- 005 claims the post for sending anyway.
select pg_temp.expect((select publish_enabled from public.social_accounts where id = pg_temp.account(79)) = false, 'FB1 setup');
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(79), 'switch off'), pg_temp.person(79), :'s79') as fb1 \gset
select pg_temp.expect(:'fb1' like 'claimed/%', 'FB1 ' || :'fb1');
select pg_temp.bind_now(split_part(:'fb1', '/', 3)::uuid);
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_check(%L, %L)', split_part(:'fb1', '/', 3), split_part(:'fb1', '/', 2)), pg_temp.person(79), :'s79') = 'OK', 'FB1 check OK');
select 'FB1_GAP_005_SENDS_WITH_PUBLISH_SWITCH_OFF' as result;

-- FB2 (B4 / M1-F1): the workspace gets a second owner, so F5's brand state is WORKSPACE_OWNER_UNKNOWN -- 005 still sends.
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.brand(80), pg_temp.person(81), 'owner');
select pg_temp.expect(public.common_account_brand_service_state(pg_temp.brand(80), 'x_autopost') = 'WORKSPACE_OWNER_UNKNOWN', 'FB2 F5 says not active');
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(80), 'two owners'), pg_temp.person(80), :'s80') as fb2 \gset
select pg_temp.expect(:'fb2' like 'claimed/%', 'FB2 ' || :'fb2');
select pg_temp.bind_now(split_part(:'fb2', '/', 3)::uuid);
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_check(%L, %L)', split_part(:'fb2', '/', 3), split_part(:'fb2', '/', 2)), pg_temp.person(80), :'s80') = 'OK', 'FB2 check OK');
delete from public.brand_memberships where brand_id = pg_temp.brand(80) and user_id = pg_temp.person(81);
select 'FB2_GAP_005_IGNORES_F5_BRAND_STATE' as result;

-- FB3: the credential needs re-authorization (refresh state) -- 005 sends with it.
insert into public.x_account_refresh_state_v2 (social_account_id, status, generation) values (pg_temp.account(82), 'reauth_required', 3);
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(82), 'degraded'), pg_temp.person(82), :'s82') as fb3 \gset
select pg_temp.expect(:'fb3' like 'claimed/%', 'FB3 ' || :'fb3');
delete from public.x_account_refresh_state_v2 where social_account_id = pg_temp.account(82);
select 'FB3_GAP_005_SENDS_WITH_DEGRADED_CREDENTIAL' as result;

-- FB4: the credential changes between begin and the check (Vault reference swapped, refresh generation bumped) -- 005's
-- check still answers OK, so the token read after it may belong to another generation.
select pg_temp.api(pg_temp.begin_sp(pg_temp.account(79), 'generation'), pg_temp.person(79), :'s79') as fb4 \gset
update public.social_accounts set vault_access_token_secret_id = vault_refresh_token_secret_id, vault_refresh_token_secret_id = vault_access_token_secret_id,
  updated_at = now() where id = pg_temp.account(79);
select pg_temp.bind_now(split_part(:'fb4', '/', 3)::uuid);
select pg_temp.expect(pg_temp.api(format('select postona_x_resv.post_now_check(%L, %L)', split_part(:'fb4', '/', 3), split_part(:'fb4', '/', 2)), pg_temp.person(79), :'s79') = 'OK', 'FB4 check OK');
update public.social_accounts set vault_access_token_secret_id = vault_refresh_token_secret_id, vault_refresh_token_secret_id = vault_access_token_secret_id
  where id = pg_temp.account(79);
select 'FB4_GAP_005_NO_CREDENTIAL_GENERATION' as result;

-- FB5 (M1-F3 / simulated): 005 keeps neither an after-freeze mark nor the transport.
select pg_temp.expect(not exists (select 1 from information_schema.columns where table_schema = 'postona_x_resv' and column_name in ('after_freeze', 'transport')), 'FB5');
select 'FB5_GAP_005_NO_AFTER_FREEZE_OR_TRANSPORT' as result;
select 'LIVE_FENCE_FAIL_BEFORE_ALL_GAPS_CONFIRMED' as result;
