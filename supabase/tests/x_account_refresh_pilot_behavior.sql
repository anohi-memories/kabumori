-- Fake-only Stage 3B proof: AI Lab 'enabled' + a second Vault-backed account
-- ('sa_pilot') under 'pilot', account-bound completion, isolation both ways.
-- Run by x_account_refresh_pilot_run.sh after: production-shaped core fixture
-- + pilot extras -> core -> Stage 3A -> Stage 3B. Never production.
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
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'CHECK_FAILED: %', p_what; end if; end; $$;
create function pg_temp.state(p_account text) returns text language sql as $$
  select coalesce((select status || ':' || generation || ':' || coalesce(last_error_code, '-')
                   from public.x_account_refresh_state_v2 where social_account_id = p_account), 'none') $$;
create function pg_temp.health(p_account text) returns text language sql as $$
  select connection_status || ':' || coalesce(last_connection_error_code, '-') from public.social_accounts where id = p_account $$;
create function pg_temp.vault_reads() returns bigint language sql security definer as $$
  select case when is_called then last_value else 0 end from vault.fixture_read_seq $$;
create function pg_temp.secret(p_account text, p_kind text) returns text language sql security definer as $$
  select s.secret from vault.secrets s join public.social_accounts a
    on s.id = case p_kind when 'access' then a.vault_access_token_secret_id else a.vault_refresh_token_secret_id end
  where a.id = p_account $$;
create function pg_temp.run_post(p_brand text, p_type text default 'brand_post') returns uuid language sql as $$
  insert into public.scheduled_posts (brand_id, post_type, status, attempt_count, started_at) values (p_brand, p_type, 'running', 1, now()) returning id $$;
create function pg_temp.begin_sql(p_post uuid, p_account text, p_brand text) returns text language sql as $$
  select format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p_post, p_account, p_brand) $$;
grant execute on function pg_temp.expect_error(text, text), pg_temp.check(boolean, text), pg_temp.state(text), pg_temp.health(text),
  pg_temp.vault_reads(), pg_temp.run_post(text, text), pg_temp.begin_sql(uuid, text, text) to service_role;

-- 0. Stage 3B completion ACL.
do $$
declare v_oid oid := 'public.complete_vault_account_brand_post(uuid,text,text,text)'::regprocedure;
begin
  perform pg_temp.check((select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = v_oid), 'secdef/search_path');
  perform pg_temp.check(not has_function_privilege('anon', v_oid, 'EXECUTE') and not has_function_privilege('authenticated', v_oid, 'EXECUTE')
                        and has_function_privilege('service_role', v_oid, 'EXECUTE'), 'completion ACL');
  perform pg_temp.check((select string_agg(social_account_id || '=' || mode, ',') from public.x_account_refresh_rollout) = 'ai_salaryman_lab_x=enabled', 'baseline: AI Lab only');
end $$;

set role service_role;

-- 1/3. AI Lab enabled + second account off: only AI Lab refreshes; pilot account reads no Vault.
do $$
declare p_ai uuid := pg_temp.run_post('ai_salaryman_lab');
        p_pi uuid := pg_temp.run_post('u_pilot');
        r record;
        v_reads bigint;
begin
  perform set_config('pl.p_ai', p_ai::text, false);
  perform set_config('pl.p_pi', p_pi::text, false);
  v_reads := pg_temp.vault_reads();
  perform pg_temp.expect_error(pg_temp.begin_sql(p_pi, 'sa_pilot', 'u_pilot'), 'X_REFRESH_ROLLOUT_OFF');
  perform pg_temp.check(pg_temp.vault_reads() = v_reads, 'pilot off: zero vault reads');
  perform pg_temp.check(pg_temp.state('sa_pilot') = 'none', 'pilot off: no state');
  select * into r from public.begin_x_account_refresh_legacy_post(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab');
  perform pg_temp.check(r.refresh_token = 'fake_AI_REFRESH_1', 'AI Lab refreshes its own');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'ai_salaryman_lab_x', 'not_rotated', 'X_REFRESH_RATE_LIMITED') = 'idle', 'AI release');
end $$;
reset role;
update public.x_account_refresh_state_v2 set last_error_code = null where social_account_id = 'ai_salaryman_lab_x';
update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('pl.p_ai')::uuid;
set role service_role;

-- 6. Missing refs cannot be piloted or refreshed.
do $$
declare p uuid := pg_temp.run_post('u_norefs');
begin
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('sa_norefs', 'pilot', 'PILOT_STAGE3B', now() + interval '7 days', 2)$q$, 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED');
  perform pg_temp.expect_error(pg_temp.begin_sql(p, 'sa_norefs', 'u_norefs'), 'X_CREDENTIAL_NOT_CONFIGURED');
end $$;

-- 2/9. Pilot for the exact second account only (7 days, budget 2).
do $$
declare p_ai uuid := current_setting('pl.p_ai')::uuid;
        p_pi uuid := current_setting('pl.p_pi')::uuid;
        ra record;
        rp record;
begin
  perform pg_temp.check(public.set_x_account_refresh_rollout('sa_pilot', 'pilot', 'PILOT_STAGE3B', now() + interval '7 days', 2) = 'pilot', 'pilot set');
  perform pg_temp.check((select string_agg(social_account_id || '=' || mode || ':' || coalesce(pilot_max_generation::text, '-'), ',' order by social_account_id)
    from public.x_account_refresh_rollout) = 'ai_salaryman_lab_x=enabled:-,sa_pilot=pilot:2', 'only the pilot row changed');
  select * into ra from public.begin_x_account_refresh_legacy_post(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab');
  select * into rp from public.begin_x_account_refresh_legacy_post(p_pi, 'sa_pilot', 'u_pilot');
  perform pg_temp.check(ra.refresh_token = 'fake_AI_REFRESH_1' and rp.refresh_token = 'fake_PILOT_REFRESH_1', 'each resolves only itself');
  -- 11/12. Neither lease can touch the other account.
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(rp.lease_token, 'ai_salaryman_lab_x', 'fake_X', null) = 'lease_lost', 'pilot lease cannot commit AI Lab');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(ra.lease_token, 'sa_pilot', 'fake_X', null) = 'lease_lost', 'AI lease cannot commit pilot');
  perform pg_temp.check(public.release_x_account_refresh_v2(rp.lease_token, 'ai_salaryman_lab_x', 'uncertain', 'X_CROSS') = 'lease_lost', 'pilot lease cannot release AI Lab');
  perform pg_temp.check(public.release_x_account_refresh_v2(ra.lease_token, 'sa_pilot', 'uncertain', 'X_CROSS') = 'lease_lost', 'AI lease cannot release pilot');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(rp.lease_token, 'sa_pilot', 'fake_PILOT_access_2', 'fake_PILOT_REFRESH_2', 7200) = 'committed', 'pilot commit');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(ra.lease_token, 'ai_salaryman_lab_x', 'fake_AI_access_2', null, 7200) = 'committed', 'AI commit');
  perform pg_temp.check(pg_temp.state('sa_pilot') = 'idle:1:-' and pg_temp.state('ai_salaryman_lab_x') = 'idle:2:-', 'generations');
end $$;
reset role;
do $$ begin
  perform pg_temp.check(pg_temp.secret('sa_pilot', 'access') = 'fake_PILOT_access_2' and pg_temp.secret('sa_pilot', 'refresh') = 'fake_PILOT_REFRESH_2', 'pilot secrets');
  perform pg_temp.check(pg_temp.secret('ai_salaryman_lab_x', 'access') = 'fake_AI_access_2' and pg_temp.secret('ai_salaryman_lab_x', 'refresh') = 'fake_AI_REFRESH_1', 'AI secrets own');
end $$;
update public.scheduled_posts set attempt_count = attempt_count + 1 where id in (current_setting('pl.p_ai')::uuid, current_setting('pl.p_pi')::uuid);
set role service_role;

-- 9. Generation ceiling: second pilot refresh allowed, third refused.
do $$
declare p_pi uuid := current_setting('pl.p_pi')::uuid;
        rp record;
begin
  select * into rp from public.begin_x_account_refresh_legacy_post(p_pi, 'sa_pilot', 'u_pilot');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(rp.lease_token, 'sa_pilot', 'fake_PILOT_access_3', null, 7200) = 'committed', 'pilot commit 2');
end $$;
reset role;
update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('pl.p_pi')::uuid;
set role service_role;
do $$
declare v_reads bigint := pg_temp.vault_reads();
begin
  perform pg_temp.expect_error(pg_temp.begin_sql(current_setting('pl.p_pi')::uuid, 'sa_pilot', 'u_pilot'), 'X_REFRESH_PILOT_LIMIT_REACHED');
  perform pg_temp.check(pg_temp.vault_reads() = v_reads, 'ceiling: zero vault reads');
end $$;

-- 7. invalid_grant on the second account only.
reset role;
update public.x_account_refresh_rollout set pilot_max_generation = 10 where social_account_id = 'sa_pilot';
set role service_role;
do $$
declare rp record;
        v_ai text := pg_temp.state('ai_salaryman_lab_x') || '|' || pg_temp.health('ai_salaryman_lab_x');
begin
  select * into rp from public.begin_x_account_refresh_legacy_post(current_setting('pl.p_pi')::uuid, 'sa_pilot', 'u_pilot');
  perform pg_temp.check(public.release_x_account_refresh_v2(rp.lease_token, 'sa_pilot', 'reauth_required', 'X_REFRESH_GRANT_REJECTED') = 'reauth_required', 'pilot reauth');
  perform pg_temp.check(pg_temp.health('sa_pilot') = 'failed:X_REFRESH_GRANT_REJECTED', 'pilot failed');
  perform pg_temp.check(pg_temp.state('ai_salaryman_lab_x') || '|' || pg_temp.health('ai_salaryman_lab_x') = v_ai, 'AI Lab untouched');
  perform pg_temp.check((select mode from public.x_account_refresh_rollout where social_account_id = 'ai_salaryman_lab_x') = 'enabled', 'AI rollout untouched');
end $$;

-- 8. Uncertain on the second account: no credential commit (after a re-connect).
reset role;
update public.social_accounts set connection_status = 'identity_verified', last_connection_error_code = null,
  verified_at = now(), updated_at = now() where id = 'sa_pilot';
update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('pl.p_pi')::uuid;
set role service_role;
do $$
declare rp record;
begin
  perform pg_temp.check(pg_temp.state('sa_pilot') = 'idle:2:-', 'reconnect reset');
  select * into rp from public.begin_x_account_refresh_legacy_post(current_setting('pl.p_pi')::uuid, 'sa_pilot', 'u_pilot');
  perform pg_temp.check(public.release_x_account_refresh_v2(rp.lease_token, 'sa_pilot', 'uncertain', 'X_REFRESH_NETWORK_UNCERTAIN') = 'uncertain', 'uncertain');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(rp.lease_token, 'sa_pilot', 'fake_LATE', 'fake_LATE') = 'lease_lost', 'no late commit');
end $$;
reset role;
do $$ begin
  perform pg_temp.check(not exists (select 1 from vault.secrets where secret = 'fake_LATE'), 'no credential committed');
end $$;
update public.social_accounts set verified_at = now() + interval '1 second' where id = 'sa_pilot';  -- re-connect

-- 4/5/13/14. Account-bound completion.
set role service_role;
do $$
declare p_ai uuid := pg_temp.run_post('ai_salaryman_lab');
        p_pi uuid := pg_temp.run_post('u_pilot');
        p_kb uuid := pg_temp.run_post('kabumori');
        p_tip uuid := pg_temp.run_post('u_pilot', 'tip');
        sha text := repeat('a', 64);
        p_pending uuid;
begin
  -- 4. Second account cannot complete AI Lab content; AI Lab account cannot complete the pilot's.
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_ai, 'sa_pilot', '101', sha), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_pi, 'ai_salaryman_lab_x', '102', sha), 'X_CLAIM_ACCOUNT_MISMATCH');
  -- 5. Wrong brand/account pairing for refresh.
  perform pg_temp.expect_error(pg_temp.begin_sql(p_pi, 'sa_pilot', 'ai_salaryman_lab'), 'X_LEGACY_POST_NOT_RUNNING');
  perform pg_temp.expect_error(pg_temp.begin_sql(p_ai, 'sa_pilot', 'ai_salaryman_lab'), 'X_CLAIM_ACCOUNT_MISMATCH');
  -- 13. Kabumori never goes through this path.
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_kb, 'kabumori_x', '103', sha), 'VAULT_BRAND_POST_NOT_FOUND');
  perform pg_temp.expect_error(pg_temp.begin_sql(p_kb, 'kabumori_x', 'kabumori'), 'X_CREDENTIAL_NOT_CONFIGURED');
  -- Non-brand_post rows and bad input.
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_tip, 'sa_pilot', '104', sha), 'VAULT_BRAND_POST_NOT_FOUND');
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_pi, 'sa_pilot', 'x-1', sha), 'VAULT_BRAND_POST_COMPLETION_ARGUMENT_INVALID');
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_pi, 'sa_pilot', '105', 'nothex'), 'VAULT_BRAND_POST_COMPLETION_ARGUMENT_INVALID');
  -- The right account completes its own running post once; re-reporting is idempotent.
  perform pg_temp.check((select fingerprint_persisted from public.complete_vault_account_brand_post(p_pi, 'sa_pilot', '106', sha)), 'pilot completion');
  perform pg_temp.check((select status from public.scheduled_posts where id = p_pi) = 'succeeded', 'row succeeded');
  perform pg_temp.check((select fingerprint_persisted from public.complete_vault_account_brand_post(p_pi, 'sa_pilot', '106', sha)), 'idempotent');
  perform pg_temp.check(not (select fingerprint_persisted from public.complete_vault_account_brand_post(p_pi, 'sa_pilot', '107', sha)), 'other x id on a completed row is not recorded');
  perform pg_temp.check((select count(*) from public.published_content_fingerprints where social_account_id = 'sa_pilot') = 1
                        and (select brand_id from public.published_content_fingerprints where social_account_id = 'sa_pilot') = 'u_pilot', 'one fingerprint, own brand');
  perform pg_temp.check((select count(*) from public.post_execution_logs where scheduled_post_id = p_pi and status = 'succeeded') = 1, 'one success log');
  -- A pending (unclaimed) row cannot be completed.
  insert into public.scheduled_posts (brand_id, post_type) values ('u_pilot', 'brand_post') returning id into p_pending;
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_pending, 'sa_pilot', '108', sha), 'VAULT_BRAND_POST_NOT_RUNNING');
end $$;
reset role;
set role anon;
do $$ begin
  perform pg_temp.expect_error($q$select * from public.complete_vault_account_brand_post(gen_random_uuid(), 'sa_pilot', '1', repeat('a', 64))$q$, '42501');
end $$;
reset role;

select 'PILOT_BEHAVIOR_PASS' as result;
