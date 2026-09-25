-- Fake-only Phase1I behavior proof (exact-account pre-X refresh lease).
-- Run by x_autopost_phase1i_run.sh after: 1D/1E/1F/1G/1I fixtures ->
-- 1B -> 1D -> 1E -> 1F -> 1G -> 1H -> refresh core -> 1I migrations.
\set ON_ERROR_STOP on
set timezone = 'Asia/Tokyo';

create function pg_temp.expect_error(p_sql text, p_expected text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: % :: %', p_expected, p_sql;
exception when others then
  if sqlerrm like 'EXPECTED_ERROR_NOT_RAISED%' then raise; end if;
  if sqlerrm <> p_expected and sqlstate <> p_expected then
    raise exception 'WRONG_ERROR expected % got % (%) :: %', p_expected, sqlerrm, sqlstate, p_sql;
  end if;
  if sqlerrm like '%fake_%' or sqlerrm like '%00000000-0000%' then raise exception 'SECRET_OR_REF_IN_ERROR: %', sqlerrm; end if;
end;
$$;
-- Test observer only: reads the fake vault as the fixture owner.
create function pg_temp.secret(p_id text) returns text language sql security definer as $$ select secret from vault.secrets where id = p_id::uuid $$;
create function pg_temp.state(p_account text) returns text language sql as $$
  select coalesce((select status || ':' || generation || ':' || coalesce(last_error_code, '-')
                   from public.x_account_refresh_state_v2 where social_account_id = p_account), 'none')
$$;

-- 0. ACL / security.
do $$
declare r record;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('begin_x_account_refresh_v2', 'commit_x_account_refresh_v2',
             'release_x_account_refresh_v2', 'x_v2_block_provider_during_refresh')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then raise exception 'secdef/search_path: %', r.proname; end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'API role can execute %', r.proname; end if;
    if (r.proname like 'x\_v2\_%' escape '\') = has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'service_role ACL wrong for %', r.proname; end if;
  end loop;
  if has_table_privilege('service_role', 'public.x_account_refresh_state_v2', 'UPDATE')
     or has_table_privilege('service_role', 'public.x_account_refresh_state_v2', 'INSERT')
     or has_table_privilege('authenticated', 'public.x_account_refresh_state_v2', 'SELECT')
     or not has_table_privilege('service_role', 'public.x_account_refresh_state_v2', 'SELECT') then
    raise exception 'refresh state table ACL wrong'; end if;
  if has_function_privilege('service_role', 'vault.update_secret(uuid,text,text,text,uuid)', 'EXECUTE') then
    raise exception 'fixture: service_role can write vault directly'; end if;
end $$;

revoke execute on function public.claim_due_post() from service_role;  -- Phase1D activation gate
set role service_role;

-- 1. Seed bound pre-X attempts.
create temporary table plan (label text, brand text, account text, post_type text, slot smallint);
insert into plan values
  ('a1', 'brand_a', 'acct_a', 'useful_tip', 1), ('a2', 'brand_a', 'acct_a', 'useful_tip', 2),
  ('a3', 'brand_a', 'acct_a', 'useful_tip', 3), ('a4', 'brand_a', 'acct_a', 'useful_tip', 4),
  ('a5', 'brand_a', 'acct_a', 'useful_tip', 5), ('a_tip', 'brand_a', 'acct_a', 'tip', 6),
  ('a_started', 'brand_a', 'acct_a', 'useful_tip', 7),
  ('b1', 'brand_b', 'acct_b', 'useful_tip', 1), ('b2', 'brand_b', 'acct_b', 'useful_tip', 2),
  ('b3', 'brand_b', 'acct_b', 'useful_tip', 3),
  ('a2_shared', 'brand_a', 'acct_a2', 'useful_tip', 8),
  ('g_noref', 'brand_g_order', 'acct_brand_g_order', 'useful_tip', 1);
select public.schedule_account_bound_post_v2(p.brand, p.account, current_date, p.post_type, p.slot,
  now() - interval '1 hour' - p.slot * interval '1 second') from plan p;
create temporary table claims (label text primary key, attempt_id uuid, claim_token uuid, account text, brand text);
do $$
declare r record;
begin
  loop
    select * into r from public.claim_due_post_v2();
    exit when r.scheduled_post_id is null;
    insert into claims select p.label, r.attempt_id, r.claim_token, r.social_account_id, r.brand_id
    from plan p join public.scheduled_posts s on s.brand_id = p.brand and s.post_type = p.post_type and s.slot_no = p.slot
    where s.id = r.scheduled_post_id;
  end loop;
  if (select count(*) from claims) <> 12 then raise exception 'setup: expected 12 claims, got %', (select count(*) from claims); end if;
end $$;
create function pg_temp.c(p_label text) returns claims language sql as $$ select * from claims where label = p_label $$;
create function pg_temp.begin_sql(p_label text, p_account text default null, p_brand text default null, p_token uuid default null)
returns text language sql as $$
  select format('select * from public.begin_x_account_refresh_v2(%L,%L,%L,%L)',
    (pg_temp.c(p_label)).attempt_id, coalesce(p_token, (pg_temp.c(p_label)).claim_token),
    coalesce(p_account, (pg_temp.c(p_label)).account), coalesce(p_brand, (pg_temp.c(p_label)).brand))
$$;
select public.mark_post_provider_started_v2(attempt_id, claim_token) from claims where label = 'a_started';
select public.plan_provider_steps_v2(attempt_id, claim_token, 'tip_thread', 2::smallint) from claims where label = 'a_tip';
select public.record_v2_content_snapshot(attempt_id, claim_token,
  '{"tip_id":"00000000-0000-4000-8000-0000000000f1","parts":["p1","p2"]}'::jsonb) from claims where label = 'a_tip';
select public.mark_post_provider_started_v2(attempt_id, claim_token) from claims where label = 'a_tip';

-- 2. Rejections before any lease is taken (no token call would follow).
do $$ begin
  perform pg_temp.expect_error(pg_temp.begin_sql('a1', null, null, gen_random_uuid()), 'X_REFRESH_CLAIM_NOT_PRE_X');
  perform pg_temp.expect_error(pg_temp.begin_sql('a1', 'acct_b', 'brand_b'), 'X_REFRESH_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.begin_sql('a1', 'acct_a', 'brand_b'), 'X_REFRESH_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.begin_sql('b1', 'acct_a', 'brand_a'), 'X_REFRESH_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.begin_sql('a_started'), 'X_REFRESH_CLAIM_NOT_PRE_X');
  perform pg_temp.expect_error(pg_temp.begin_sql('a2_shared'), 'X_REFRESH_SECRET_REF_SHARED');
  perform pg_temp.expect_error(pg_temp.begin_sql('g_noref'), 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED');
  perform pg_temp.expect_error($q$select * from public.begin_x_account_refresh_v2(null, null, 'acct_a', 'brand_a')$q$, 'X_REFRESH_REQUEST_INVALID');
  if pg_temp.state('acct_a') <> 'none' or pg_temp.state('acct_b') <> 'none' then raise exception 'lease taken on rejection'; end if;
end $$;
reset role;
update public.social_accounts set publish_enabled = false where id = 'acct_c';
set role service_role;
select public.schedule_account_bound_post_v2('brand_c', 'acct_c', current_date, 'useful_tip', 1::smallint, now() - interval '1 hour');
insert into claims select 'c1', attempt_id, claim_token, social_account_id, brand_id from public.claim_due_post_v2();
do $$ begin
  -- acct_c publish disabled -> the v2 claim itself never serves it
  if exists (select 1 from claims where label = 'c1') then raise exception 'disabled account was claimed'; end if;
end $$;
reset role;
update public.social_accounts set publish_enabled = true where id = 'acct_c';
set role service_role;
insert into claims select 'c1', attempt_id, claim_token, social_account_id, brand_id from public.claim_due_post_v2();

-- 3. Lease: single-flight per account; returns only this account's refresh token.
do $$
declare r record; r2 record;
begin
  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('a1')).attempt_id, (pg_temp.c('a1')).claim_token, 'acct_a', 'brand_a');
  if r.refresh_token <> 'fake_REFRESH_acct_a' or r.oauth_client_ref <> 'default' or r.lease_token is null then
    raise exception 'lease row wrong'; end if;
  if pg_temp.state('acct_a') <> 'refreshing:0:-' then raise exception 'state not refreshing: %', pg_temp.state('acct_a'); end if;
  perform set_config('phase1i.lease_a1', r.lease_token::text, false);
  -- same account, different attempt: blocked
  perform pg_temp.expect_error(pg_temp.begin_sql('a2'), 'X_REFRESH_IN_PROGRESS');
  -- same account: provider start and provider steps blocked while refreshing
  perform pg_temp.expect_error(format('select public.mark_post_provider_started_v2(%L,%L)', (pg_temp.c('a3')).attempt_id, (pg_temp.c('a3')).claim_token), 'X_REFRESH_IN_PROGRESS');
  perform pg_temp.expect_error(format('select public.begin_planned_provider_step_v2(%L,%L,1::smallint,%L)', (pg_temp.c('a_tip')).attempt_id, (pg_temp.c('a_tip')).claim_token, 'create_post'), 'X_REFRESH_IN_PROGRESS');
  -- other accounts are independent
  select * into r2 from public.begin_x_account_refresh_v2((pg_temp.c('b1')).attempt_id, (pg_temp.c('b1')).claim_token, 'acct_b', 'brand_b');
  if r2.refresh_token <> 'fake_REFRESH_acct_b' then raise exception 'acct_b lease wrong'; end if;
  perform set_config('phase1i.lease_b1', r2.lease_token::text, false);
  perform public.mark_post_provider_started_v2((pg_temp.c('c1')).attempt_id, (pg_temp.c('c1')).claim_token);
end $$;

-- 4. Commit: only the lease holder, only its own account, access-only keeps refresh.
do $$
declare la uuid := current_setting('phase1i.lease_a1')::uuid;
        lb uuid := current_setting('phase1i.lease_b1')::uuid;
begin
  if public.commit_x_account_refresh_v2(gen_random_uuid(), 'acct_a', 'fake_NEW_access', null) <> 'lease_lost'
     or public.commit_x_account_refresh_v2(la, 'acct_b', 'fake_NEW_access', null) <> 'lease_lost'
     or public.commit_x_account_refresh_v2(lb, 'acct_a', 'fake_NEW_access', null) <> 'lease_lost' then
    raise exception 'foreign lease accepted'; end if;
  if pg_temp.secret('00000000-0000-4000-8000-00000000000b') <> 'fake_tok_acct_b' then raise exception 'b touched by foreign commit'; end if;
  perform pg_temp.expect_error(format('select public.commit_x_account_refresh_v2(%L,%L,%L,%L)', la, 'acct_a', ' ', null), 'X_REFRESH_REQUEST_INVALID');
  if public.commit_x_account_refresh_v2(la, 'acct_a', 'fake_A_access_2', null) <> 'committed' then raise exception 'commit failed'; end if;
  if pg_temp.secret('00000000-0000-4000-8000-00000000000a') <> 'fake_A_access_2'
     or pg_temp.secret('00000000-0000-4000-8000-0000000000aa') <> 'fake_REFRESH_acct_a'
     or pg_temp.state('acct_a') <> 'idle:1:-' then
    raise exception 'access-only commit wrong: %', pg_temp.state('acct_a'); end if;
  -- the used lease is gone: replaying the commit does nothing
  if public.commit_x_account_refresh_v2(la, 'acct_a', 'fake_REPLAY', 'fake_REPLAY') <> 'lease_lost'
     or pg_temp.secret('00000000-0000-4000-8000-00000000000a') <> 'fake_A_access_2' then raise exception 'lease replay'; end if;
  -- b: rotated refresh token updates both
  if public.commit_x_account_refresh_v2(lb, 'acct_b', 'fake_B_access_2', 'fake_B_refresh_2') <> 'committed'
     or pg_temp.secret('00000000-0000-4000-8000-00000000000b') <> 'fake_B_access_2'
     or pg_temp.secret('00000000-0000-4000-8000-0000000000bb') <> 'fake_B_refresh_2'
     or pg_temp.state('acct_b') <> 'idle:1:-' then raise exception 'rotated commit wrong'; end if;
  -- unrelated secrets untouched
  if pg_temp.secret('00000000-0000-4000-8000-0000000000c3') <> 'fake_tok_acct_c'
     or pg_temp.secret('00000000-0000-4000-8000-0000000000a2') <> 'fake_tok_acct_a2' then raise exception 'unrelated secret changed'; end if;
  -- after release, provider start is possible again
  perform public.mark_post_provider_started_v2((pg_temp.c('a3')).attempt_id, (pg_temp.c('a3')).claim_token);
end $$;

-- 5. Release outcomes; blocked states refuse new leases; stale lease cannot overwrite.
do $$
declare r record; old_lease uuid;
begin
  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('a2')).attempt_id, (pg_temp.c('a2')).claim_token, 'acct_a', 'brand_a');
  old_lease := r.lease_token;
  perform pg_temp.expect_error(format('select public.release_x_account_refresh_v2(%L,%L,%L,%L)', old_lease, 'acct_a', 'bogus', 'X'), 'X_REFRESH_REQUEST_INVALID');
  if public.release_x_account_refresh_v2(old_lease, 'acct_a', 'not_rotated', 'X_REFRESH_RATE_LIMITED') <> 'idle'
     or pg_temp.state('acct_a') <> 'idle:1:X_REFRESH_RATE_LIMITED' then raise exception 'not_rotated release wrong'; end if;
  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('a4')).attempt_id, (pg_temp.c('a4')).claim_token, 'acct_a', 'brand_a');
  -- stale lease from the earlier attempt cannot write or release
  if public.commit_x_account_refresh_v2(old_lease, 'acct_a', 'fake_STALE', 'fake_STALE') <> 'lease_lost'
     or public.release_x_account_refresh_v2(old_lease, 'acct_a', 'uncertain', 'X_STALE') <> 'lease_lost'
     or pg_temp.secret('00000000-0000-4000-8000-00000000000a') <> 'fake_A_access_2'
     or pg_temp.state('acct_a') <> 'refreshing:1:-' then raise exception 'stale lease effective'; end if;
  if public.release_x_account_refresh_v2(r.lease_token, 'acct_a', 'uncertain', 'X_REFRESH_NETWORK_UNCERTAIN') <> 'uncertain' then
    raise exception 'uncertain release wrong'; end if;
  perform pg_temp.expect_error(pg_temp.begin_sql('a5'), 'X_REFRESH_BLOCKED_UNCERTAIN');
  -- blocked accounts do not block posting with a still-valid token
  perform public.mark_post_provider_started_v2((pg_temp.c('a5')).attempt_id, (pg_temp.c('a5')).claim_token);

  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('b2')).attempt_id, (pg_temp.c('b2')).claim_token, 'acct_b', 'brand_b');
  if public.release_x_account_refresh_v2(r.lease_token, 'acct_b', 'reauth_required', 'X_REFRESH_GRANT_REJECTED') <> 'reauth_required' then
    raise exception 'reauth release wrong'; end if;
  -- Core health mirror: re-authorization required -> connection_status 'failed' + code,
  -- so the account is refused before the refresh state is even consulted.
  perform pg_temp.expect_error(pg_temp.begin_sql('b3'), 'X_ACCOUNT_NOT_VERIFIED');
end $$;
reset role;
do $$ begin
  if (select connection_status || ':' || coalesce(last_connection_error_code, '-') from public.social_accounts where id = 'acct_b')
     <> 'failed:X_REFRESH_GRANT_REJECTED' then raise exception 'reauth health mirror wrong'; end if;
end $$;
set role service_role;

-- 6. Writer failure rolls back; reconnect during refresh turns the lease uncertain.
reset role;
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id = 'acct_b';
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where id = 'acct_b';  -- re-connect  -- operator reset (owner only)
set role service_role;
select public.schedule_account_bound_post_v2('brand_b', 'acct_b', current_date, 'useful_tip', 9::smallint, now() - interval '1 hour');
select public.schedule_account_bound_post_v2('brand_b', 'acct_b', current_date, 'useful_tip', 10::smallint, now() - interval '1 hour');
insert into claims select 'b_w' || row_number() over (), attempt_id, claim_token, social_account_id, brand_id
from (select * from public.claim_due_post_v2() union all select * from public.claim_due_post_v2()) q;
do $$
declare r record; v_gen text := pg_temp.state('acct_b');
begin
  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('b_w1')).attempt_id, (pg_temp.c('b_w1')).claim_token, 'acct_b', 'brand_b');
  perform pg_temp.expect_error(format('select public.commit_x_account_refresh_v2(%L,%L,%L,%L)', r.lease_token, 'acct_b', 'fake_B_ok', 'fake_FORCE_WRITE_FAIL'), 'X_REFRESH_PERSIST_FAILED');
  if pg_temp.secret('00000000-0000-4000-8000-00000000000b') <> 'fake_B_access_2'
     or pg_temp.secret('00000000-0000-4000-8000-0000000000bb') <> 'fake_B_refresh_2'
     or pg_temp.state('acct_b') not like 'refreshing:%' then raise exception 'failed write not rolled back: %', pg_temp.state('acct_b'); end if;
  if public.release_x_account_refresh_v2(r.lease_token, 'acct_b', 'uncertain', 'X_REFRESH_PERSIST_FAILED') <> 'uncertain' then
    raise exception 'post-failure release wrong'; end if;
end $$;
reset role;
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id = 'acct_b';
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where id = 'acct_b';  -- re-connect
set role service_role;
do $$
declare r record;
begin
  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('b_w2')).attempt_id, (pg_temp.c('b_w2')).claim_token, 'acct_b', 'brand_b');
  perform set_config('phase1i.lease_reconnect', r.lease_token::text, false);
end $$;
reset role;
update public.social_accounts set updated_at = now() + interval '1 second' where id = 'acct_b';  -- simulated re-connect
set role service_role;
do $$ begin
  if public.commit_x_account_refresh_v2(current_setting('phase1i.lease_reconnect')::uuid, 'acct_b', 'fake_LATE', 'fake_LATE') <> 'account_changed'
     or pg_temp.secret('00000000-0000-4000-8000-00000000000b') <> 'fake_B_access_2'
     or pg_temp.state('acct_b') not like 'uncertain:%:X_REFRESH_ACCOUNT_CHANGED' then
    raise exception 'reconnect race not fail-closed: %', pg_temp.state('acct_b'); end if;
end $$;

-- 7. A silent Vault-reference swap must never redirect a rotated token into
-- another account's secret, even if updated_at is not maintained by a writer.
reset role;
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id = 'acct_b';
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where id = 'acct_b';  -- re-connect
set role service_role;
select public.schedule_account_bound_post_v2('brand_b', 'acct_b', current_date, 'useful_tip', 11::smallint, now() - interval '1 hour');
insert into claims select 'b_ref', attempt_id, claim_token, social_account_id, brand_id from public.claim_due_post_v2();
do $$
declare r record;
begin
  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('b_ref')).attempt_id, (pg_temp.c('b_ref')).claim_token, 'acct_b', 'brand_b');
  perform set_config('phase1i.lease_ref', r.lease_token::text, false);
end $$;
reset role;
update public.social_accounts set vault_access_token_secret_id = '00000000-0000-4000-8000-00000000000a'
where id = 'acct_b'; -- same updated_at; points to acct_a's access secret
set role service_role;
do $$ begin
  if public.commit_x_account_refresh_v2(current_setting('phase1i.lease_ref')::uuid, 'acct_b', 'fake_CROSS_ACCOUNT', 'fake_CROSS_ACCOUNT') <> 'account_changed'
     or pg_temp.secret('00000000-0000-4000-8000-00000000000a') <> 'fake_A_access_2'
     or pg_temp.secret('00000000-0000-4000-8000-00000000000b') <> 'fake_B_access_2'
     or pg_temp.state('acct_b') not like 'uncertain:%:X_REFRESH_ACCOUNT_CHANGED' then
    raise exception 'silent secret-ref swap crossed account boundary'; end if;
end $$;

-- 8. A pre-X attempt settled while X refresh is in flight must not commit.
reset role;
update public.social_accounts set vault_access_token_secret_id = '00000000-0000-4000-8000-00000000000b'
where id = 'acct_b';
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id = 'acct_b';
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null where id = 'acct_b';  -- re-connect
set role service_role;
select public.schedule_account_bound_post_v2('brand_b', 'acct_b', current_date, 'useful_tip', 12::smallint, now() - interval '1 hour');
insert into claims select 'b_settled', attempt_id, claim_token, social_account_id, brand_id from public.claim_due_post_v2();
do $$
declare r record;
begin
  select * into r from public.begin_x_account_refresh_v2((pg_temp.c('b_settled')).attempt_id, (pg_temp.c('b_settled')).claim_token, 'acct_b', 'brand_b');
  perform set_config('phase1i.lease_settled', r.lease_token::text, false);
end $$;
select public.settle_post_pre_x_v2(attempt_id, claim_token, false, 'FIXTURE_SETTLED')
from claims where label = 'b_settled';
do $$ begin
  if public.commit_x_account_refresh_v2(current_setting('phase1i.lease_settled')::uuid, 'acct_b', 'fake_STALE_ATTEMPT', 'fake_STALE_ATTEMPT') <> 'account_changed'
     or pg_temp.secret('00000000-0000-4000-8000-00000000000b') <> 'fake_B_access_2'
     or pg_temp.state('acct_b') not like 'uncertain:%:X_REFRESH_ACCOUNT_CHANGED' then
    raise exception 'settled attempt wrote refreshed tokens'; end if;
end $$;

-- 9. API roles.
reset role;
set role authenticated;
do $$ begin
  perform pg_temp.expect_error($q$select * from public.begin_x_account_refresh_v2(gen_random_uuid(), gen_random_uuid(), 'acct_a', 'brand_a')$q$, '42501');
  perform pg_temp.expect_error($q$select public.commit_x_account_refresh_v2(gen_random_uuid(), 'acct_a', 'x', null)$q$, '42501');
  perform pg_temp.expect_error($q$select * from public.x_account_refresh_state_v2$q$, '42501');
end $$;
reset role;

select 'PHASE1I_BEHAVIOR_PASS' as result;
