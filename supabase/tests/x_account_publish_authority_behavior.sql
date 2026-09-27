-- Fake-only Stage 3B publish-authority proof (valid token != permission to
-- publish). Run by x_account_refresh_pilot_run.sh after the pilot behavior,
-- with 20260927124300 applied. Never production.
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
end;
$$;
create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'CHECK_FAILED: %', p_what; end if; end; $$;
create function pg_temp.run_post(p_brand text) returns uuid language sql as $$
  insert into public.scheduled_posts (brand_id, post_type, status, attempt_count, started_at) values (p_brand, 'brand_post', 'running', 1, now()) returning id $$;
create function pg_temp.chk(p_post uuid, p_account text, p_brand text) returns text language sql as $$
  select format('select public.check_x_account_publish_authority(%L,%L,%L)', p_post, p_account, p_brand) $$;
grant execute on function pg_temp.expect_error(text, text), pg_temp.check(boolean, text), pg_temp.run_post(text),
  pg_temp.chk(uuid, text, text) to service_role;

-- 0. ACL.
do $$
declare r record;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('check_x_account_publish_authority', 'set_x_account_publish_authority')
  loop
    perform pg_temp.check('search_path=""' = any(r.proconfig), 'search_path ' || r.proname);
    perform pg_temp.check(r.prosecdef = (r.proname = 'set_x_account_publish_authority'), 'definer only for the setter: ' || r.proname);
    perform pg_temp.check(not has_function_privilege('anon', r.oid, 'EXECUTE') and not has_function_privilege('authenticated', r.oid, 'EXECUTE')
                          and has_function_privilege('service_role', r.oid, 'EXECUTE'), 'ACL ' || r.proname);
  end loop;
  perform pg_temp.check((select relrowsecurity from pg_class where oid = 'public.x_account_publish_authority'::regclass), 'RLS');
  perform pg_temp.check(has_table_privilege('service_role', 'public.x_account_publish_authority', 'SELECT')
    and not has_table_privilege('service_role', 'public.x_account_publish_authority', 'INSERT')
    and not has_table_privilege('service_role', 'public.x_account_publish_authority', 'UPDATE')
    and not has_table_privilege('service_role', 'public.x_account_publish_authority', 'DELETE')
    and not has_table_privilege('authenticated', 'public.x_account_publish_authority', 'SELECT')
    and not has_table_privilege('anon', 'public.x_account_publish_authority', 'SELECT'), 'authority table ACL');
end $$;

-- Admin enablement for the pilot brand (and AI Lab live, to prove it is still excluded).
update public.brands set is_active = true, publish_mode = 'live' where id in ('u_pilot', 'ai_salaryman_lab', 'kabumori');
insert into public.brand_settings (brand_id, enabled_post_types) values
  ('u_pilot', '["brand_post"]'), ('ai_salaryman_lab', '["brand_post"]'), ('kabumori', '["tip"]');
update public.social_accounts set connection_status = 'identity_verified', publish_enabled = true, last_connection_error_code = null
where id in ('sa_pilot', 'ai_salaryman_lab_x');

set role service_role;
-- 1. Valid token is irrelevant: no authority row -> refused before anything.
do $$
declare p uuid := pg_temp.run_post('u_pilot');
begin
  perform set_config('pa.p', p::text, false);
  perform pg_temp.expect_error(pg_temp.chk(p, 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_AUTHORITY_OFF');
  -- Setter validation.
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('sa_pilot', 'on', 'OPS')$q$, 'VAULT_PUBLISH_AUTHORITY_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('sa_pilot', 'enabled', 'OPS')$q$, 'VAULT_PUBLISH_AUTHORITY_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('sa_pilot', 'enabled', 'OPS', now(), now() + interval '31 days')$q$, 'VAULT_PUBLISH_AUTHORITY_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('sa_pilot', 'enabled', 'OPS', now() - interval '2 days', now() - interval '1 day')$q$, 'VAULT_PUBLISH_AUTHORITY_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('sa_pilot', 'off', 'OPS', now(), now() + interval '1 day')$q$, 'VAULT_PUBLISH_AUTHORITY_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('no_such', 'off', 'OPS')$q$, 'X_ACCOUNT_NOT_FOUND');
  -- 9/10. Specialised brands can never be given generic publish authority.
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('ai_salaryman_lab_x', 'enabled', 'OPS', now(), now() + interval '1 day')$q$, 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE');
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('kabumori_x', 'enabled', 'OPS', now(), now() + interval '1 day')$q$, 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE');
  perform pg_temp.expect_error($q$update public.x_account_publish_authority set state = 'enabled'$q$, '42501');
  perform pg_temp.check(public.set_x_account_publish_authority('sa_pilot', 'enabled', 'PILOT_STAGE3B', now() - interval '1 minute', now() + interval '7 days') = 'enabled', 'enable');
  -- 5. Consent store not deployed = no consent.
  perform pg_temp.expect_error(pg_temp.chk(p, 'sa_pilot', 'u_pilot'), 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED');
end $$;
reset role;
create table public.social_mobile_content_settings (brand_id text primary key references public.brands (id), settings jsonb not null);
grant select on public.social_mobile_content_settings to service_role;
set role service_role;
do $$ begin
  perform pg_temp.expect_error(pg_temp.chk(current_setting('pa.p')::uuid, 'sa_pilot', 'u_pilot'), 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED');  -- no row
end $$;
reset role;
insert into public.social_mobile_content_settings values ('u_pilot', '{"approvalMode": "manual_review"}');
set role service_role;
do $$ begin
  perform pg_temp.expect_error(pg_temp.chk(current_setting('pa.p')::uuid, 'sa_pilot', 'u_pilot'), 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED');  -- manual review
end $$;
reset role;
update public.social_mobile_content_settings set settings = '{"approvalMode": "auto_post_preference"}' where brand_id = 'u_pilot';
set role service_role;
do $$ begin
  perform pg_temp.check(public.check_x_account_publish_authority(current_setting('pa.p')::uuid, 'sa_pilot', 'u_pilot') = 'allowed', 'all gates open');
end $$;

-- 2/13. off / revoked alone stop publishing (rollback first step); re-enable restores.
do $$
declare p uuid := current_setting('pa.p')::uuid;
begin
  perform pg_temp.check(public.set_x_account_publish_authority('sa_pilot', 'revoked', 'PILOT_STAGE3B_ROLLBACK') = 'revoked', 'revoke');
  perform pg_temp.expect_error(pg_temp.chk(p, 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_AUTHORITY_REVOKED');
  perform pg_temp.check((select starts_at is not null and expires_at is not null from public.x_account_publish_authority where social_account_id = 'sa_pilot'), 'window kept for audit');
  perform pg_temp.check(public.set_x_account_publish_authority('sa_pilot', 'off', 'OPS_PAUSE') = 'off', 'off');
  perform pg_temp.expect_error(pg_temp.chk(p, 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_AUTHORITY_OFF');
  perform pg_temp.check(public.set_x_account_publish_authority('sa_pilot', 'enabled', 'PILOT_STAGE3B', now() - interval '1 minute', now() + interval '7 days') = 'enabled', 're-enable');
  perform pg_temp.check(public.check_x_account_publish_authority(p, 'sa_pilot', 'u_pilot') = 'allowed', 'allowed again');
end $$;

-- 3. Window: expired / not started.
reset role;
update public.x_account_publish_authority set starts_at = now() - interval '8 days', expires_at = now() - interval '1 second' where social_account_id = 'sa_pilot';
set role service_role;
do $$ begin perform pg_temp.expect_error(pg_temp.chk(current_setting('pa.p')::uuid, 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_AUTHORITY_EXPIRED'); end $$;
reset role;
update public.x_account_publish_authority set starts_at = now() + interval '1 hour', expires_at = now() + interval '2 days' where social_account_id = 'sa_pilot';
set role service_role;
do $$ begin perform pg_temp.expect_error(pg_temp.chk(current_setting('pa.p')::uuid, 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_AUTHORITY_NOT_STARTED'); end $$;
reset role;
update public.x_account_publish_authority set starts_at = now() - interval '1 minute', expires_at = now() + interval '7 days' where social_account_id = 'sa_pilot';

-- 4. Refresh ceiling exhausted but publish authority valid: publishing is governed by the
--    publish policy only (allowed while the token is valid); the refresh itself is refused
--    by the Stage 3A ceiling, so once the token expires the post fails without a token request.
update public.x_account_refresh_state_v2 set status = 'idle', last_error_code = null where social_account_id = 'sa_pilot';
update public.x_account_refresh_rollout set mode = 'pilot', pilot_expires_at = now() + interval '7 days',
  pilot_max_generation = (select generation from public.x_account_refresh_state_v2 where social_account_id = 'sa_pilot')
where social_account_id = 'sa_pilot';
set role service_role;
do $$
declare p uuid := current_setting('pa.p')::uuid;
begin
  perform pg_temp.check(public.check_x_account_publish_authority(p, 'sa_pilot', 'u_pilot') = 'allowed', 'publish policy independent of refresh ceiling');
  perform pg_temp.check((select refresh_block_code from public.get_x_account_refresh_health('sa_pilot')) = 'X_REFRESH_PILOT_LIMIT_REACHED', 'refresh still ceiling-blocked');
  -- ...and the reverse: refresh allowed does not grant publishing.
end $$;
reset role;
update public.x_account_refresh_rollout set mode = 'enabled', pilot_expires_at = null, pilot_max_generation = null where social_account_id = 'sa_pilot';
update public.x_account_publish_authority set state = 'off' where social_account_id = 'sa_pilot';
set role service_role;
do $$ begin
  perform pg_temp.check((select refresh_block_code from public.get_x_account_refresh_health('sa_pilot')) is null, 'refresh enabled');
  perform pg_temp.expect_error(pg_temp.chk(current_setting('pa.p')::uuid, 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_AUTHORITY_OFF');
end $$;
reset role;
update public.x_account_publish_authority set state = 'enabled' where social_account_id = 'sa_pilot';

-- 5/6/7. Consent revoked, brand disabled/dry-run, account disabled/unverified, post type off.
create temporary table gate_cases (label text, breaker text, fixer text, code text);
insert into gate_cases values
  ('consent', $m$update public.social_mobile_content_settings set settings = '{"approvalMode": "manual_review"}' where brand_id = 'u_pilot'$m$,
              $m$update public.social_mobile_content_settings set settings = '{"approvalMode": "auto_post_preference"}' where brand_id = 'u_pilot'$m$, 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED'),
  ('brand_inactive', $m$update public.brands set is_active = false where id = 'u_pilot'$m$, $m$update public.brands set is_active = true where id = 'u_pilot'$m$, 'VAULT_PUBLISH_BRAND_DISABLED'),
  ('brand_dry_run', $m$update public.brands set publish_mode = 'dry_run' where id = 'u_pilot'$m$, $m$update public.brands set publish_mode = 'live' where id = 'u_pilot'$m$, 'VAULT_PUBLISH_BRAND_DISABLED'),
  ('account_publish', $m$update public.social_accounts set publish_enabled = false where id = 'sa_pilot'$m$, $m$update public.social_accounts set publish_enabled = true where id = 'sa_pilot'$m$, 'X_ACCOUNT_PUBLISH_DISABLED'),
  ('account_failed', $m$update public.social_accounts set connection_status = 'failed' where id = 'sa_pilot'$m$, $m$update public.social_accounts set connection_status = 'identity_verified' where id = 'sa_pilot'$m$, 'X_ACCOUNT_NOT_VERIFIED'),
  ('post_type', $m$update public.brand_settings set enabled_post_types = '[]' where brand_id = 'u_pilot'$m$, $m$update public.brand_settings set enabled_post_types = '["brand_post"]' where brand_id = 'u_pilot'$m$, 'VAULT_PUBLISH_POST_TYPE_NOT_ENABLED');
grant select on gate_cases to service_role;
do $$
declare c record;
        p uuid := current_setting('pa.p')::uuid;
begin
  for c in select * from gate_cases loop
    execute c.breaker;
    set local role service_role;
    perform pg_temp.expect_error(pg_temp.chk(p, 'sa_pilot', 'u_pilot'), c.code);
    reset role;
    execute c.fixer;
    set local role service_role;
    perform pg_temp.check(public.check_x_account_publish_authority(p, 'sa_pilot', 'u_pilot') = 'allowed', 'restored after ' || c.label);
    reset role;
  end loop;
end $$;

-- 8/9/10/11. Wrong account/brand, AI Lab and Kabumori never enter; exact AI Lab pair cannot complete here.
set role service_role;
do $$
declare p uuid := current_setting('pa.p')::uuid;
        p_ai uuid := pg_temp.run_post('ai_salaryman_lab');
        v_fp bigint;
        v_logs bigint;
begin
  perform pg_temp.expect_error(pg_temp.chk(p, 'ai_salaryman_lab_x', 'u_pilot'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.expect_error(pg_temp.chk(p, 'sa_pilot', 'u_norefs'), 'VAULT_PUBLISH_POST_NOT_RUNNING');
  perform pg_temp.expect_error(pg_temp.chk(gen_random_uuid(), 'sa_pilot', 'u_pilot'), 'VAULT_PUBLISH_POST_NOT_RUNNING');
  perform pg_temp.expect_error(pg_temp.chk(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE');
  perform pg_temp.expect_error(pg_temp.chk(p_ai, 'sa_pilot', 'ai_salaryman_lab'), 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE');
  perform pg_temp.expect_error(pg_temp.chk(gen_random_uuid(), 'kabumori_x', 'kabumori'), 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE');
  -- H1 P2 regression: the exact matching AI Lab row + ai_salaryman_lab_x must not complete here, and writes nothing.
  select count(*) into v_fp from public.published_content_fingerprints;
  select count(*) into v_logs from public.post_execution_logs;
  perform pg_temp.expect_error(format('select * from public.complete_vault_account_brand_post(%L,%L,%L,%L)', p_ai, 'ai_salaryman_lab_x', '555', repeat('b', 64)), 'VAULT_BRAND_POST_NOT_FOUND');
  perform pg_temp.check((select count(*) from public.published_content_fingerprints) = v_fp
                        and (select count(*) from public.post_execution_logs) = v_logs
                        and (select status from public.scheduled_posts where id = p_ai) = 'running', 'AI Lab row untouched');
end $$;
reset role;
set role authenticated;
do $$ begin
  perform pg_temp.expect_error($q$select public.check_x_account_publish_authority(gen_random_uuid(), 'sa_pilot', 'u_pilot')$q$, '42501');
  perform pg_temp.expect_error($q$select public.set_x_account_publish_authority('sa_pilot', 'enabled', 'SELF', now(), now() + interval '1 day')$q$, '42501');
end $$;
reset role;

select 'PUBLISH_AUTHORITY_BEHAVIOR_PASS' as result;
