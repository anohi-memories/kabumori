-- Fake-only behavior proof for the universal refresh core, applied STANDALONE
-- on the production-shaped fixture (no Phase1B..1I). Run by
-- x_account_refresh_core_run.sh. Never production.
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
create function pg_temp.secret(p_id text) returns text language sql security definer as $$
  select secret from vault.secrets where id = ('00000000-0000-4000-8000-0000' || p_id)::uuid $$;
create function pg_temp.state(p_account text) returns text language sql as $$
  select coalesce((select status || ':' || generation || ':' || coalesce(last_error_code, '-')
                   from public.x_account_refresh_state_v2 where social_account_id = p_account), 'none') $$;
create function pg_temp.health(p_account text) returns text language sql as $$
  select connection_status || ':' || coalesce(last_connection_error_code, '-') from public.social_accounts where id = p_account $$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'CHECK_FAILED: %', p_what; end if; end; $$;
-- A running legacy post (as the live claim leaves it: status running, attempt_count bumped).
create function pg_temp.run_post(p_brand text) returns uuid language sql as $$
  insert into public.scheduled_posts (brand_id, status, attempt_count, started_at) values (p_brand, 'running', 1, now()) returning id $$;
grant execute on function pg_temp.expect_error(text, text), pg_temp.state(text), pg_temp.health(text),
  pg_temp.check(boolean, text), pg_temp.run_post(text) to service_role;

-- 0. ACL / security.
do $$
declare r record;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('x_legacy_post_account', 'read_x_publish_credential_for_legacy_post',
             'begin_x_account_refresh_legacy_post', 'commit_x_account_refresh_legacy_post', 'release_x_account_refresh_v2',
             'record_x_account_rejected_after_refresh', 'record_x_account_access_unauthorized',
             'x_account_refresh_health_mirror', 'x_account_refresh_reset_on_reconnect')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then raise exception 'secdef/search_path: %', r.proname; end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'API role can execute %', r.proname; end if;
    if (r.proname in ('x_legacy_post_account', 'x_account_refresh_health_mirror', 'x_account_refresh_reset_on_reconnect')) = has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'service_role ACL wrong for %', r.proname; end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and (p.proname like '%x\_account\_refresh%' escape '\' or p.proname like '%x\_account\_%unauthorized' escape '\'
        or p.proname like '%rejected\_after\_refresh' escape '\' or p.proname like '%legacy\_post%' escape '\')) <> 9 then raise exception 'function set wrong'; end if;
  if has_table_privilege('service_role', 'public.x_account_refresh_state_v2', 'UPDATE')
     or has_table_privilege('service_role', 'public.x_account_refresh_state_v2', 'INSERT')
     or has_table_privilege('service_role', 'public.x_account_refresh_state_v2', 'DELETE')
     or has_table_privilege('authenticated', 'public.x_account_refresh_state_v2', 'SELECT')
     or has_table_privilege('anon', 'public.x_account_refresh_state_v2', 'SELECT')
     or not has_table_privilege('service_role', 'public.x_account_refresh_state_v2', 'SELECT') then
    raise exception 'refresh state table ACL wrong'; end if;
  -- No secret id parameter anywhere in the API.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
             and p.proname like '%x_account_refresh%' and pg_get_function_arguments(p.oid) ~ 'secret') then
    raise exception 'secret id parameter exposed'; end if;
end $$;

set role service_role;

-- 1. Exact-account reader for the running legacy post.
do $$
declare p_ai uuid := pg_temp.run_post('ai_salaryman_lab');
        r record;
        p uuid;
begin
  perform set_config('core.p_ai', p_ai::text, false);
  select * into r from public.read_x_publish_credential_for_legacy_post(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab');
  perform pg_temp.check(r.access_token = 'fake_AI_access_1' and r.platform_user_id = 'x_ai_lab'
    and r.social_account_id = 'ai_salaryman_lab_x' and r.access_expires_at is null, 'ai lab read');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p_ai, 'acct_d', 'ai_salaryman_lab'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p_ai, 'ai_salaryman_lab_x', 'brand_d'), 'X_LEGACY_POST_NOT_RUNNING');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', gen_random_uuid(), 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_LEGACY_POST_NOT_RUNNING');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', null, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_CREDENTIAL_REQUEST_INVALID');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p_ai, ' ', 'ai_salaryman_lab'), 'X_CREDENTIAL_REQUEST_INVALID');
  insert into public.scheduled_posts (brand_id) values ('ai_salaryman_lab') returning id into p;  -- pending
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_LEGACY_POST_NOT_RUNNING');
  p := pg_temp.run_post('kabumori');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p, 'kabumori_x', 'kabumori'), 'X_CREDENTIAL_NOT_CONFIGURED');
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p, 'kabumori_x', 'kabumori'), 'X_CREDENTIAL_NOT_CONFIGURED');
  p := pg_temp.run_post('u_disabled');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p, 'sa_disabled', 'u_disabled'), 'X_ACCOUNT_PUBLISH_DISABLED');
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p, 'sa_disabled', 'u_disabled'), 'X_ACCOUNT_PUBLISH_DISABLED');
  p := pg_temp.run_post('brand_e');
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p, 'acct_e', 'brand_e'), 'X_REFRESH_SECRET_REF_SHARED');
  p := pg_temp.run_post('brand_f');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p, 'acct_f', 'brand_f'), 'X_REFRESH_SECRET_REF_SHARED');
  p := pg_temp.run_post('brand_g');
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p, 'acct_g', 'brand_g'), 'X_CREDENTIAL_NOT_CONFIGURED');
  p := pg_temp.run_post('brand_h');
  perform pg_temp.check((select access_token from public.read_x_publish_credential_for_legacy_post(p, 'acct_h', 'brand_h')) = 'fake_H_access_1', 'blank client still reads');
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p, 'acct_h', 'brand_h'), 'X_REFRESH_CLIENT_NOT_CONFIGURED');
  perform pg_temp.check(pg_temp.state('acct_h') = 'none', 'no lease for unconfigured client');
end $$;

-- 2. Begin: only that account's refresh token and client ref; single flight.
do $$
declare p_ai uuid := current_setting('core.p_ai')::uuid;
        r record;
        l uuid;
        p_i uuid := pg_temp.run_post('brand_i');
begin
  select * into r from public.begin_x_account_refresh_legacy_post(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab');
  perform pg_temp.check(r.refresh_token = 'fake_AI_REFRESH_1' and r.oauth_client_ref = 'default' and r.lease_token is not null, 'ai lease');
  perform set_config('core.l_ai', r.lease_token::text, false);
  perform pg_temp.check(pg_temp.state('ai_salaryman_lab_x') = 'refreshing:0:-', 'refreshing');
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_REFRESH_IN_PROGRESS');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_REFRESH_IN_PROGRESS');
  -- A future account with its own client ref routes by that ref.
  select * into r from public.begin_x_account_refresh_legacy_post(p_i, 'acct_i', 'brand_i');
  perform pg_temp.check(r.oauth_client_ref = 'secondary' and r.refresh_token = 'fake_I_REFRESH_1', 'client ref routing');
  perform set_config('core.l_i', r.lease_token::text, false);
  perform set_config('core.p_i', p_i::text, false);
end $$;

-- 3. Commit: lease holder only, same account only, access-only keeps refresh.
do $$
declare l uuid := current_setting('core.l_ai')::uuid;
        li uuid := current_setting('core.l_i')::uuid;
        v_exp timestamptz;
begin
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(gen_random_uuid(), 'ai_salaryman_lab_x', 'fake_NEW', null) = 'lease_lost', 'foreign lease');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(l, 'acct_i', 'fake_NEW', null) = 'lease_lost', 'lease for other account');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(li, 'ai_salaryman_lab_x', 'fake_NEW', null) = 'lease_lost', 'other lease on this account');
  perform pg_temp.expect_error(format('select public.commit_x_account_refresh_legacy_post(%L,%L,%L,%L)', l, 'ai_salaryman_lab_x', ' ', null), 'X_REFRESH_REQUEST_INVALID');
  perform pg_temp.expect_error(format('select public.commit_x_account_refresh_legacy_post(%L,%L,%L,%L,%s)', l, 'ai_salaryman_lab_x', 'fake_X', null, 0), 'X_REFRESH_REQUEST_INVALID');
  perform pg_temp.expect_error(format('select public.commit_x_account_refresh_legacy_post(%L,%L,%L,%L)', l, 'ai_salaryman_lab_x', 'fake_X', ''), 'X_REFRESH_REQUEST_INVALID');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(l, 'ai_salaryman_lab_x', 'fake_AI_access_2', null, 7200) = 'committed', 'commit');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(l, 'ai_salaryman_lab_x', 'fake_REPLAY', 'fake_REPLAY') = 'lease_lost', 'replay');
  perform pg_temp.check(pg_temp.state('ai_salaryman_lab_x') = 'idle:1:-', 'idle gen1');
  select access_expires_at into v_exp from public.x_account_refresh_state_v2 where social_account_id = 'ai_salaryman_lab_x';
  perform pg_temp.check(v_exp between now() + interval '7190 seconds' and now() + interval '7210 seconds', 'expiry recorded');
  perform pg_temp.check(pg_temp.health('ai_salaryman_lab_x') = 'identity_verified:-', 'health unchanged');
  perform pg_temp.check((select access_token from public.read_x_publish_credential_for_legacy_post(current_setting('core.p_ai')::uuid, 'ai_salaryman_lab_x', 'ai_salaryman_lab')) = 'fake_AI_access_2', 'new token read');
  perform pg_temp.check((select access_expires_at from public.read_x_publish_credential_for_legacy_post(current_setting('core.p_ai')::uuid, 'ai_salaryman_lab_x', 'ai_salaryman_lab')) = v_exp, 'expiry returned');
  -- Rotated refresh token for acct_i.
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(li, 'acct_i', 'fake_I_access_2', 'fake_I_REFRESH_2', 3600) = 'committed', 'rotated commit');
end $$;
reset role;
do $$ begin
  perform pg_temp.check(pg_temp.secret('0000a1a1') = 'fake_AI_access_2' and pg_temp.secret('0000a1a2') = 'fake_AI_REFRESH_1', 'ai secrets');
  perform pg_temp.check(pg_temp.secret('0000a0a1') = 'fake_I_access_2' and pg_temp.secret('0000a0a2') = 'fake_I_REFRESH_2', 'i secrets');
  perform pg_temp.check((select count(*) from vault.secrets where secret like 'fake\_%\_1' escape '\') = 11, 'other secrets untouched');
end $$;
set role service_role;

-- 4. At most one refresh per post attempt; a later attempt may refresh again.
do $$
declare p_ai uuid := current_setting('core.p_ai')::uuid;
        r record;
begin
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_REFRESH_ALREADY_USED_FOR_ATTEMPT');
  -- Freshly refreshed token rejected in the same attempt -> re-authorization required.
  perform pg_temp.check(public.record_x_account_rejected_after_refresh(current_setting('core.p_i')::uuid, 'acct_i', 'brand_i') = 'reauth_required', 'rejected after refresh');
  perform pg_temp.check(pg_temp.state('acct_i') = 'reauth_required:1:X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH', 'i reauth state');
  perform pg_temp.check(pg_temp.health('acct_i') = 'failed:X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH', 'i health failed');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', current_setting('core.p_i'), 'acct_i', 'brand_i'), 'X_ACCOUNT_NOT_VERIFIED');
  -- Not applicable without a refresh in this attempt.
  update public.scheduled_posts set attempt_count = attempt_count + 1 where id = p_ai;  -- retry claim
  perform pg_temp.check(public.record_x_account_rejected_after_refresh(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab') = 'not_applicable', 'not applicable');
  perform pg_temp.check(pg_temp.state('ai_salaryman_lab_x') = 'idle:1:-', 'unchanged');
  select * into r from public.begin_x_account_refresh_legacy_post(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab');
  perform pg_temp.check(r.refresh_token = 'fake_AI_REFRESH_1', 'second attempt lease');
  -- 5. Releases: not_rotated keeps idle and mirrors the code; uncertain blocks.
  perform pg_temp.expect_error(format('select public.release_x_account_refresh_v2(%L,%L,%L,%L)', r.lease_token, 'ai_salaryman_lab_x', 'bogus', 'X'), 'X_REFRESH_REQUEST_INVALID');
  perform pg_temp.check(public.release_x_account_refresh_v2(gen_random_uuid(), 'ai_salaryman_lab_x', 'uncertain', 'X_STALE') = 'lease_lost', 'foreign release');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'ai_salaryman_lab_x', 'not_rotated', 'X_REFRESH_RATE_LIMITED') = 'idle', 'not rotated');
  perform pg_temp.check(pg_temp.health('ai_salaryman_lab_x') = 'identity_verified:X_REFRESH_RATE_LIMITED', 'rate limit visible');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(r.lease_token, 'ai_salaryman_lab_x', 'fake_STALE', 'fake_STALE') = 'lease_lost', 'stale commit');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'ai_salaryman_lab_x', 'uncertain', 'X_STALE') = 'lease_lost', 'stale release');
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_REFRESH_ALREADY_USED_FOR_ATTEMPT');
end $$;

do $$
declare p uuid := pg_temp.run_post('brand_d');
        r record;
begin
  select * into r from public.begin_x_account_refresh_legacy_post(p, 'acct_d', 'brand_d');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'acct_d', 'uncertain', 'X_REFRESH_NETWORK_UNCERTAIN') = 'uncertain', 'uncertain');
  perform pg_temp.check(pg_temp.health('acct_d') = 'identity_verified:X_REFRESH_NETWORK_UNCERTAIN', 'uncertain visible');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p, 'acct_d', 'brand_d'), 'X_REFRESH_BLOCKED_UNCERTAIN');
  p := pg_temp.run_post('brand_d');  -- a new post/attempt is blocked too
  perform pg_temp.expect_error(format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p, 'acct_d', 'brand_d'), 'X_REFRESH_BLOCKED_UNCERTAIN');
  perform pg_temp.check(pg_temp.state('acct_d') = 'uncertain:0:X_REFRESH_NETWORK_UNCERTAIN', 'd uncertain');
end $$;

-- 6. Operator recovery (owner only): re-connect then reset the refresh state.
reset role;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null, updated_at = now()
where id in ('acct_d', 'acct_i');
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id in ('acct_d', 'acct_i');
set role service_role;
do $$
declare p uuid := pg_temp.run_post('brand_d');
        r record;
begin
  perform set_config('core.p_d', p::text, false);
  perform pg_temp.check((select access_token from public.read_x_publish_credential_for_legacy_post(p, 'acct_d', 'brand_d')) = 'fake_D_access_1', 'd recovered');
  -- reauth via grant rejection
  select * into r from public.begin_x_account_refresh_legacy_post(p, 'acct_d', 'brand_d');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'acct_d', 'reauth_required', 'X_REFRESH_GRANT_REJECTED') = 'reauth_required', 'reauth');
  perform pg_temp.check(pg_temp.health('acct_d') = 'failed:X_REFRESH_GRANT_REJECTED', 'reauth -> failed');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p, 'acct_d', 'brand_d'), 'X_ACCOUNT_NOT_VERIFIED');
end $$;
reset role;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null, updated_at = now() where id = 'acct_d';
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id = 'acct_d';
update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('core.p_d')::uuid;
set role service_role;

-- 7. Vault write failure: nothing is written, never committed; operator sees uncertain.
do $$
declare p uuid := current_setting('core.p_d')::uuid;
        r record;
begin
  select * into r from public.begin_x_account_refresh_legacy_post(p, 'acct_d', 'brand_d');
  perform pg_temp.expect_error(format('select public.commit_x_account_refresh_legacy_post(%L,%L,%L,%L)', r.lease_token, 'acct_d', 'fake_D_ok', 'fake_FORCE_WRITE_FAIL'), 'X_REFRESH_PERSIST_FAILED');
  perform pg_temp.check(pg_temp.state('acct_d') = 'refreshing:0:-', 'still leased');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'acct_d', 'uncertain', 'X_REFRESH_PERSIST_FAILED') = 'uncertain', 'persist uncertain');
end $$;
reset role;
do $$ begin
  perform pg_temp.check(pg_temp.secret('0000d0d1') = 'fake_D_access_1' and pg_temp.secret('0000d0d2') = 'fake_D_REFRESH_1', 'rolled back');
end $$;

-- 7b. Re-connection (a completed OAuth flow stamps verified_at) resolves 'uncertain';
--     other account updates do not; a still-failed account is not reset.
update public.social_accounts set handle = 'd_renamed' where id = 'acct_d';
do $$ begin perform pg_temp.check(pg_temp.state('acct_d') like 'uncertain:%', 'plain update keeps uncertain'); end $$;
update public.social_accounts set verified_at = now() where id = 'acct_d';
do $$ begin perform pg_temp.check(pg_temp.state('acct_d') = 'idle:0:-', 'reconnect resets uncertain'); end $$;
update public.x_account_refresh_state_v2 set status = 'reauth_required', last_error_code = 'X_REFRESH_GRANT_REJECTED' where social_account_id = 'acct_d';
do $$ begin perform pg_temp.check(pg_temp.health('acct_d') = 'failed:X_REFRESH_GRANT_REJECTED', 'reauth mirrored'); end $$;
update public.social_accounts set verified_at = now() + interval '1 second' where id = 'acct_d';  -- still 'failed'
do $$ begin perform pg_temp.check(pg_temp.state('acct_d') like 'reauth_required:%', 'failed account not reset'); end $$;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null,
  verified_at = now() + interval '2 seconds', updated_at = now() where id = 'acct_d';
do $$ begin perform pg_temp.check(pg_temp.state('acct_d') = 'idle:0:-', 'reconnect resets reauth'); end $$;
update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('core.p_d')::uuid;

-- 7c. A 401 that may not be refreshed is recorded on the account (never while leased,
--     never changing connection_status); the next committed refresh clears it.
set role service_role;
do $$
declare p uuid := current_setting('core.p_d')::uuid;
        r record;
begin
  perform pg_temp.check(public.record_x_account_access_unauthorized(p, 'acct_d', 'brand_d') = 'recorded', 'unauthorized recorded');
  perform pg_temp.check(pg_temp.health('acct_d') = 'identity_verified:X_ACCESS_TOKEN_UNAUTHORIZED', 'unauthorized visible');
  perform pg_temp.check(pg_temp.state('acct_d') = 'idle:0:-', 'refresh state untouched');
  perform pg_temp.expect_error(format('select public.record_x_account_access_unauthorized(%L,%L,%L)', p, 'acct_i', 'brand_d'), 'X_CLAIM_ACCOUNT_MISMATCH');
  select * into r from public.begin_x_account_refresh_legacy_post(p, 'acct_d', 'brand_d');
  perform pg_temp.check(public.record_x_account_access_unauthorized(p, 'acct_d', 'brand_d') = 'not_applicable', 'not while leased');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(r.lease_token, 'acct_d', 'fake_D_access_2', 'fake_D_REFRESH_2', 7200) = 'committed', 'd commit');
  perform pg_temp.check(pg_temp.health('acct_d') = 'identity_verified:-', 'healthy after committed refresh');
end $$;
reset role;

-- 8. Account changed during the external refresh -> account_changed / uncertain.
create function pg_temp.reset_d() returns void language sql as $$
  update public.social_accounts set connection_status = 'identity_verified', publish_enabled = true, last_connection_error_code = null,
    vault_access_token_secret_id = '00000000-0000-4000-8000-00000000d0d1', vault_refresh_token_secret_id = '00000000-0000-4000-8000-00000000d0d2',
    oauth_client_ref = 'default', updated_at = now() where id = 'acct_d';
  update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id = 'acct_d';
  update public.scheduled_posts set attempt_count = attempt_count + 1, status = 'running' where id = current_setting('core.p_d')::uuid;
$$;
create temporary table changes (label text, mutation text);
insert into changes values
  ('reconnect', $m$update public.social_accounts set updated_at = now() + interval '1 second' where id = 'acct_d'$m$),
  ('silent_ref_swap', $m$update public.social_accounts set vault_access_token_secret_id = '00000000-0000-4000-8000-00000000e0e2' where id = 'acct_d'$m$),
  ('client_change', $m$update public.social_accounts set oauth_client_ref = 'secondary' where id = 'acct_d'$m$),
  ('publish_disabled', $m$update public.social_accounts set publish_enabled = false where id = 'acct_d'$m$),
  ('identity_change', $m$update public.social_accounts set platform_user_id = 'x_other' where id = 'acct_d'$m$),
  ('post_finished', $m$update public.scheduled_posts set status = 'failed' where id = current_setting('core.p_d')::uuid$m$),
  ('post_reclaimed', $m$update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('core.p_d')::uuid$m$),
  ('foreign_account_takes_ref', $m$update public.social_accounts set vault_refresh_token_secret_id = '00000000-0000-4000-8000-00000000d0d2', updated_at = updated_at where id = 'acct_h'$m$);
do $$
declare c record;
        r record;
        v text;
begin
  for c in select * from changes loop
    perform pg_temp.reset_d();
    update public.social_accounts set vault_refresh_token_secret_id = '00000000-0000-4000-8000-00000000b0b2' where id = 'acct_h';
    set local role service_role;
    select * into r from public.begin_x_account_refresh_legacy_post(current_setting('core.p_d')::uuid, 'acct_d', 'brand_d');
    reset role;
    execute c.mutation;
    set local role service_role;
    v := public.commit_x_account_refresh_legacy_post(r.lease_token, 'acct_d', 'fake_LATE', 'fake_LATE');
    reset role;
    if v <> 'account_changed' or pg_temp.state('acct_d') not like 'uncertain:%:X_REFRESH_ACCOUNT_CHANGED'
       or exists (select 1 from vault.secrets where secret = 'fake_LATE') then
      raise exception 'account change % not detected: % %', c.label, v, pg_temp.state('acct_d');
    end if;
  end loop;
end $$;
update public.social_accounts set vault_refresh_token_secret_id = '00000000-0000-4000-8000-00000000b0b2' where id = 'acct_h';
select pg_temp.reset_d();

-- 9. API roles denied; service_role cannot write the state table.
set role anon;
do $$ begin
  perform pg_temp.expect_error($q$select * from public.read_x_publish_credential_for_legacy_post(gen_random_uuid(), 'acct_d', 'brand_d')$q$, '42501');
  perform pg_temp.expect_error($q$select * from public.begin_x_account_refresh_legacy_post(gen_random_uuid(), 'acct_d', 'brand_d')$q$, '42501');
  perform pg_temp.expect_error($q$select public.release_x_account_refresh_v2(gen_random_uuid(), 'acct_d', 'uncertain', 'X')$q$, '42501');
  perform pg_temp.expect_error($q$select * from public.x_account_refresh_state_v2$q$, '42501');
end $$;
reset role;
set role service_role;
do $$ begin
  perform pg_temp.expect_error($q$update public.x_account_refresh_state_v2 set status = 'idle'$q$, '42501');
  perform pg_temp.expect_error($q$select public.x_legacy_post_account(gen_random_uuid(), 'acct_d', 'brand_d', false)$q$, '42501');
end $$;
reset role;

select 'CORE_BEHAVIOR_PASS' as result;
