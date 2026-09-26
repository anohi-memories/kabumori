-- Fake-only Stage 3A behavior proof (per-account rollout authority). Run by
-- x_account_refresh_rollout_run.sh after: production-shaped core fixture ->
-- refresh core -> pre-3A state seed -> Stage 3A. Never production.
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
-- Vault reads are counted by a sequence (non-transactional), so reads inside a
-- refused, rolled-back begin still show up.
create function pg_temp.vault_reads() returns bigint language sql security definer as $$
  select case when is_called then last_value else 0 end from vault.fixture_read_seq $$;
create function pg_temp.run_post(p_brand text) returns uuid language sql as $$
  insert into public.scheduled_posts (brand_id, status, attempt_count, started_at) values (p_brand, 'running', 1, now()) returning id $$;
create function pg_temp.begin_sql(p_post uuid, p_account text, p_brand text) returns text language sql as $$
  select format('select * from public.begin_x_account_refresh_legacy_post(%L,%L,%L)', p_post, p_account, p_brand) $$;
grant execute on function pg_temp.expect_error(text, text), pg_temp.check(boolean, text), pg_temp.state(text),
  pg_temp.health(text), pg_temp.vault_reads(), pg_temp.run_post(text), pg_temp.begin_sql(uuid, text, text) to service_role;

-- 0. ACL / security of the Stage 3A objects; begin keeps its grants.
do $$
declare r record;
begin
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('x_account_refresh_authority', 'set_x_account_refresh_rollout',
             'get_x_account_refresh_health', 'resolve_stale_x_account_refresh_lease', 'begin_x_account_refresh_legacy_post')
  loop
    if not r.prosecdef or not ('search_path=""' = any(r.proconfig)) then raise exception 'secdef/search_path: %', r.proname; end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception 'API role can execute %', r.proname; end if;
    if (r.proname in ('x_account_refresh_authority', 'resolve_stale_x_account_refresh_lease')) = has_function_privilege('service_role', r.oid, 'EXECUTE') then
      raise exception 'service_role ACL wrong for %', r.proname; end if;
  end loop;
  if has_table_privilege('service_role', 'public.x_account_refresh_rollout', 'INSERT')
     or has_table_privilege('service_role', 'public.x_account_refresh_rollout', 'UPDATE')
     or has_table_privilege('service_role', 'public.x_account_refresh_rollout', 'DELETE')
     or has_table_privilege('authenticated', 'public.x_account_refresh_rollout', 'SELECT')
     or has_table_privilege('anon', 'public.x_account_refresh_rollout', 'SELECT')
     or not has_table_privilege('service_role', 'public.x_account_refresh_rollout', 'SELECT') then
    raise exception 'rollout table ACL wrong'; end if;
  if (select relrowsecurity from pg_class where oid = 'public.x_account_refresh_rollout'::regclass) is not true then
    raise exception 'rollout table RLS off'; end if;
  -- Health contract never exposes secret ids, tokens or lease tokens.
  if exists (select 1 from pg_proc p, unnest(p.proargnames) a where p.proname = 'get_x_account_refresh_health'
             and (a like '%secret_id%' or a like '%token%' or a like '%lease_token%')) then
    raise exception 'health exposes sensitive column'; end if;
end $$;

-- 1. Grandfathering: only accounts with a proven, clean committed refresh.
do $$ begin
  perform pg_temp.check((select string_agg(social_account_id || '=' || mode || ':' || reason_code, ',' order by social_account_id)
                         from public.x_account_refresh_rollout) = 'acct_i=enabled:GRANDFATHERED_PROVEN_REFRESH', 'grandfathered set');
end $$;

set role service_role;

-- 2. Missing rollout row = off: zero Vault reads, zero lease; posting unaffected.
do $$
declare p uuid := pg_temp.run_post('ai_salaryman_lab');
        v_reads bigint;
begin
  perform set_config('ro.p_ai', p::text, false);
  v_reads := pg_temp.vault_reads();
  perform pg_temp.expect_error(pg_temp.begin_sql(p, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_REFRESH_ROLLOUT_OFF');
  perform pg_temp.check(pg_temp.vault_reads() = v_reads, 'off: no vault read');
  perform pg_temp.check(pg_temp.state('ai_salaryman_lab_x') = 'none', 'off: no state row');
  perform pg_temp.check((select access_token from public.read_x_publish_credential_for_legacy_post(p, 'ai_salaryman_lab_x', 'ai_salaryman_lab')) = 'fake_AI_access_1', 'posting read unaffected');
  -- Publish-disabled account: refused before Vault and before rollout is even consulted.
  p := pg_temp.run_post('u_disabled');
  v_reads := pg_temp.vault_reads();
  perform pg_temp.expect_error(pg_temp.begin_sql(p, 'sa_disabled', 'u_disabled'), 'X_ACCOUNT_PUBLISH_DISABLED');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p, 'sa_disabled', 'u_disabled'), 'X_ACCOUNT_PUBLISH_DISABLED');
  perform pg_temp.check(pg_temp.vault_reads() = v_reads, 'disabled: no vault read');
end $$;

-- 3. The only mutation path: validated setter.
do $$ begin
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'on', 'OPS')$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'enabled', 'lower case')$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'pilot', 'OPS')$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'pilot', 'OPS', now() + interval '31 days', 1)$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'pilot', 'OPS', now() - interval '1 minute', 1)$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'pilot', 'OPS', now() + interval '1 day', 0)$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'pilot', 'OPS', now() + interval '1 day', 25)$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'enabled', 'OPS', now() + interval '1 day', 1)$q$, 'X_REFRESH_ROLLOUT_REQUEST_INVALID');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('no_such_account', 'enabled', 'OPS')$q$, 'X_ACCOUNT_NOT_FOUND');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('kabumori_x', 'enabled', 'OPS')$q$, 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('acct_g', 'pilot', 'OPS', now() + interval '1 day', 1)$q$, 'X_REFRESH_CREDENTIAL_NOT_CONFIGURED');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('acct_e', 'enabled', 'OPS')$q$, 'X_REFRESH_SECRET_REF_SHARED');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('acct_h', 'enabled', 'OPS')$q$, 'X_REFRESH_CLIENT_NOT_CONFIGURED');
  perform pg_temp.check(public.set_x_account_refresh_rollout('kabumori_x', 'off', 'KABUMORI_LEGACY_PATH') = 'off', 'off always allowed');
  perform pg_temp.check(public.set_x_account_refresh_rollout('ai_salaryman_lab_x', 'enabled', 'OPS_STAGE2_PROVEN') = 'enabled', 'enable ai');
  perform pg_temp.expect_error($q$update public.x_account_refresh_rollout set mode = 'enabled'$q$, '42501');
  perform pg_temp.expect_error($q$insert into public.x_account_refresh_rollout values ('acct_d', 'enabled', null, null, 'X', now())$q$, '42501');
end $$;

-- 4. Isolation: A enabled / B off; A enabled / B pilot.
do $$
declare p_ai uuid := current_setting('ro.p_ai')::uuid;
        p_d uuid := pg_temp.run_post('brand_d');
        r record;
        v_reads bigint;
begin
  perform set_config('ro.p_d', p_d::text, false);
  select * into r from public.begin_x_account_refresh_legacy_post(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab');
  perform pg_temp.check(r.refresh_token = 'fake_AI_REFRESH_1', 'enabled A leases its own token');
  v_reads := pg_temp.vault_reads();
  perform pg_temp.expect_error(pg_temp.begin_sql(p_d, 'acct_d', 'brand_d'), 'X_REFRESH_ROLLOUT_OFF');
  perform pg_temp.check(pg_temp.vault_reads() = v_reads, 'B off while A enabled: no vault read');
  -- A's rollout never transfers: naming A with B's post is an account mismatch.
  perform pg_temp.expect_error(pg_temp.begin_sql(p_d, 'ai_salaryman_lab_x', 'brand_d'), 'X_CLAIM_ACCOUNT_MISMATCH');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(r.lease_token, 'ai_salaryman_lab_x', 'fake_AI_access_2', 'fake_AI_REFRESH_2', 7200) = 'committed', 'A commit');
  perform pg_temp.check(pg_temp.state('acct_d') = 'none', 'B untouched');
  -- B pilot (budget 1, 1 day), A stays enabled.
  perform pg_temp.check(public.set_x_account_refresh_rollout('acct_d', 'pilot', 'PILOT_STAGE3B', now() + interval '1 day', 1) = 'pilot', 'pilot set');
  perform pg_temp.check((select pilot_max_generation from public.x_account_refresh_rollout where social_account_id = 'acct_d') = 1, 'pilot ceiling = gen + budget');
  select * into r from public.begin_x_account_refresh_legacy_post(p_d, 'acct_d', 'brand_d');
  perform pg_temp.check(r.refresh_token = 'fake_D_REFRESH_1', 'pilot B leases its own token');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(r.lease_token, 'acct_d', 'fake_D_access_2', null, 7200) = 'committed', 'B pilot commit');
end $$;
reset role;
update public.scheduled_posts set attempt_count = attempt_count + 1 where id in (current_setting('ro.p_ai')::uuid, current_setting('ro.p_d')::uuid);
set role service_role;
do $$
declare p_ai uuid := current_setting('ro.p_ai')::uuid;
        p_d uuid := current_setting('ro.p_d')::uuid;
        r record;
        v_reads bigint;
begin
  -- Pilot budget exhausted for B; A (enabled) keeps refreshing.
  v_reads := pg_temp.vault_reads();
  perform pg_temp.expect_error(pg_temp.begin_sql(p_d, 'acct_d', 'brand_d'), 'X_REFRESH_PILOT_LIMIT_REACHED');
  perform pg_temp.check(pg_temp.vault_reads() = v_reads, 'pilot limit: no vault read');
  select * into r from public.begin_x_account_refresh_legacy_post(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab');
  perform pg_temp.check(r.refresh_token = 'fake_AI_REFRESH_2', 'A still enabled');
  -- invalid_grant on A: exact account only.
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'ai_salaryman_lab_x', 'reauth_required', 'X_REFRESH_GRANT_REJECTED') = 'reauth_required', 'A reauth');
  perform pg_temp.check(pg_temp.health('ai_salaryman_lab_x') = 'failed:X_REFRESH_GRANT_REJECTED', 'A failed');
  perform pg_temp.check(pg_temp.health('acct_d') = 'identity_verified:-' and pg_temp.state('acct_d') = 'idle:1:-', 'B untouched by A reauth');
  perform pg_temp.check(pg_temp.health('acct_i') = 'identity_verified:-', 'I untouched by A reauth');
  perform pg_temp.expect_error(pg_temp.begin_sql(p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_ACCOUNT_NOT_VERIFIED');
  perform pg_temp.expect_error(format('select * from public.read_x_publish_credential_for_legacy_post(%L,%L,%L)', p_ai, 'ai_salaryman_lab_x', 'ai_salaryman_lab'), 'X_ACCOUNT_NOT_VERIFIED');
  select * into r from public.get_x_account_refresh_health('ai_salaryman_lab_x');
  perform pg_temp.check(r.reauth_required and r.refresh_status = 'reauth_required' and r.refresh_block_code = 'X_ACCOUNT_NOT_VERIFIED'
                        and r.rollout_mode = 'enabled' and r.generation = 1, 'health: reauth visible');
end $$;

-- 5. Pilot blocked by an unresolved error; pilot expiry.
reset role;
update public.x_account_refresh_rollout set pilot_max_generation = 5 where social_account_id = 'acct_d';
set role service_role;
do $$
declare p_d uuid := current_setting('ro.p_d')::uuid;
        r record;
begin
  select * into r from public.begin_x_account_refresh_legacy_post(p_d, 'acct_d', 'brand_d');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'acct_d', 'not_rotated', 'X_REFRESH_RATE_LIMITED') = 'idle', 'not rotated');
  perform pg_temp.check((select refresh_block_code from public.get_x_account_refresh_health('acct_d')) = 'X_REFRESH_PILOT_BLOCKED_BY_ERROR', 'pilot blocked by error');
end $$;
reset role;
update public.x_account_refresh_state_v2 set last_error_code = null where social_account_id = 'acct_d';
update public.x_account_refresh_rollout set pilot_expires_at = now() - interval '1 second' where social_account_id = 'acct_d';
set role service_role;
do $$ begin
  perform pg_temp.check((select refresh_block_code from public.get_x_account_refresh_health('acct_d')) = 'X_REFRESH_PILOT_EXPIRED', 'pilot expired');
  perform pg_temp.check(public.set_x_account_refresh_rollout('acct_d', 'enabled', 'PILOT_PROMOTED') = 'enabled', 'promote');
  perform pg_temp.check((select pilot_expires_at is null and pilot_max_generation is null from public.x_account_refresh_rollout where social_account_id = 'acct_d'), 'pilot fields cleared');
  perform pg_temp.check((select refresh_block_code from public.get_x_account_refresh_health('acct_d')) is null, 'enabled D allowed');
  perform pg_temp.check(public.set_x_account_refresh_rollout('acct_d', 'off', 'OPS_PAUSE') = 'off', 'back off');
  perform pg_temp.check((select refresh_block_code from public.get_x_account_refresh_health('acct_d')) = 'X_REFRESH_ROLLOUT_OFF', 'off again');
  perform pg_temp.check(public.set_x_account_refresh_rollout('acct_d', 'enabled', 'OPS_RESUME') = 'enabled', 'enabled again');
end $$;

-- 6. Uncertain token result: nothing committed; blocked until re-connect.
reset role;
update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('ro.p_d')::uuid;
set role service_role;
do $$
declare p_d uuid := current_setting('ro.p_d')::uuid;
        r record;
begin
  select * into r from public.begin_x_account_refresh_legacy_post(p_d, 'acct_d', 'brand_d');
  perform pg_temp.check(public.release_x_account_refresh_v2(r.lease_token, 'acct_d', 'uncertain', 'X_REFRESH_NETWORK_UNCERTAIN') = 'uncertain', 'uncertain');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(r.lease_token, 'acct_d', 'fake_LATE', 'fake_LATE') = 'lease_lost', 'no late commit');
  perform pg_temp.check((select refresh_block_code from public.get_x_account_refresh_health('acct_d')) = 'X_REFRESH_BLOCKED_UNCERTAIN', 'uncertain blocks');
end $$;
reset role;
do $$ begin
  perform pg_temp.check(not exists (select 1 from vault.secrets where secret = 'fake_LATE'), 'nothing committed');
end $$;
update public.social_accounts set verified_at = now() where id = 'acct_d';  -- re-connect
update public.scheduled_posts set attempt_count = attempt_count + 1 where id = current_setting('ro.p_d')::uuid;

-- 7. Stale lease: detection, owner-only resolution to 'uncertain' (never idle).
set role service_role;
do $$
declare p_d uuid := current_setting('ro.p_d')::uuid;
        r record;
begin
  select * into r from public.begin_x_account_refresh_legacy_post(p_d, 'acct_d', 'brand_d');
  perform set_config('ro.stale_lease', r.lease_token::text, false);
  perform pg_temp.check((select not stuck_refreshing and lease_age_seconds >= 0 from public.get_x_account_refresh_health('acct_d')), 'fresh lease not stuck');
  perform pg_temp.expect_error($q$select public.resolve_stale_x_account_refresh_lease('acct_d')$q$, '42501');
end $$;
reset role;
do $$ begin
  perform pg_temp.check(public.resolve_stale_x_account_refresh_lease('acct_d') = 'not_stale', 'fresh lease kept');
  perform pg_temp.expect_error($q$select public.resolve_stale_x_account_refresh_lease('acct_d', interval '1 minute')$q$, 'X_REFRESH_REQUEST_INVALID');
end $$;
update public.x_account_refresh_state_v2 set leased_at = now() - interval '20 minutes' where social_account_id = 'acct_d';
do $$ begin
  perform pg_temp.check((select stuck_refreshing and lease_age_seconds >= 1200 from public.get_x_account_refresh_health('acct_d')), 'stuck detected');
  perform pg_temp.check(public.resolve_stale_x_account_refresh_lease('acct_d') = 'uncertain', 'resolved to uncertain');
  perform pg_temp.check(pg_temp.state('acct_d') = 'uncertain:1:X_REFRESH_LEASE_STALE', 'stale state');
  perform pg_temp.check(pg_temp.health('acct_d') = 'identity_verified:X_REFRESH_LEASE_STALE', 'stale visible');
  perform pg_temp.check(public.resolve_stale_x_account_refresh_lease('acct_d') = 'not_refreshing', 'idempotent');
  perform pg_temp.check(public.commit_x_account_refresh_legacy_post(current_setting('ro.stale_lease')::uuid, 'acct_d', 'fake_STALE', null) = 'lease_lost', 'stale lease cannot commit');
end $$;

-- 8. Health contract for every X account; API roles denied.
set role service_role;
do $$ begin
  perform pg_temp.check((select count(*) from public.get_x_account_refresh_health()) = (select count(*) from public.social_accounts where platform = 'x'), 'all x accounts');
  perform pg_temp.check((select string_agg(social_account_id || '=' || rollout_mode || '/' || coalesce(refresh_block_code, 'ok'), ',' order by social_account_id)
    from public.get_x_account_refresh_health()) =
    'acct_d=enabled/X_REFRESH_BLOCKED_UNCERTAIN,acct_e=off/X_REFRESH_SECRET_REF_SHARED,acct_f=off/X_REFRESH_SECRET_REF_SHARED,'
    || 'acct_g=off/X_REFRESH_CREDENTIAL_NOT_CONFIGURED,acct_h=off/X_REFRESH_CLIENT_NOT_CONFIGURED,acct_i=enabled/ok,'
    || 'ai_salaryman_lab_x=enabled/X_ACCOUNT_NOT_VERIFIED,kabumori_x=off/X_REFRESH_CREDENTIAL_NOT_CONFIGURED,'
    || 'sa_disabled=off/X_ACCOUNT_PUBLISH_DISABLED', 'health block codes');
end $$;
reset role;
set role authenticated;
do $$ begin
  perform pg_temp.expect_error($q$select * from public.get_x_account_refresh_health()$q$, '42501');
  perform pg_temp.expect_error($q$select public.set_x_account_refresh_rollout('acct_d', 'enabled', 'SELF')$q$, '42501');
  perform pg_temp.expect_error($q$select * from public.x_account_refresh_rollout$q$, '42501');
end $$;
reset role;

select 'ROLLOUT_BEHAVIOR_PASS' as result;
