-- Behavior proof for the social-mobile account deletion candidate. Fake data
-- only, disposable database only. Prints SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
end;
$$;

-- Runs p_sql as p_role and returns the error message (null if it succeeded).
create function pg_temp.error_as(p_role text, p_sql text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return null;
exception when others then
  reset role;
  return sqlerrm;
end;
$$;

create function pg_temp.brand_rows(p_brand text) returns bigint language sql as $$
  select (select count(*) from public.brands where id = p_brand)
       + (select count(*) from public.brand_memberships where brand_id = p_brand)
       + (select count(*) from public.social_accounts where brand_id = p_brand)
       + (select count(*) from public.social_account_oauth_states where brand_id = p_brand)
       + (select count(*) from public.scheduled_posts where brand_id = p_brand)
       + (select count(*) from public.post_execution_logs where brand_id = p_brand)
       + (select count(*) from public.posting_windows where brand_id = p_brand)
       + (select count(*) from public.publish_claims where brand_id = p_brand)
       + (select count(*) from public.published_content_fingerprints where brand_id = p_brand)
       + (select count(*) from public.daily_content_plans where brand_id = p_brand)
$$;

create temp table ids as select
  '00000000-0000-4000-8000-00000000000a'::uuid as a, '00000000-0000-4000-8000-00000000000b'::uuid as b,
  '00000000-0000-4000-8000-00000000000c'::uuid as c, '00000000-0000-4000-8000-00000000000d'::uuid as d,
  '00000000-0000-4000-8000-00000000000e'::uuid as e, '00000000-0000-4000-8000-00000000000f'::uuid as f,
  '00000000-0000-4000-8000-000000000001'::uuid as g, '00000000-0000-4000-8000-000000000002'::uuid as h,
  '00000000-0000-4000-8000-000000000003'::uuid as i, '00000000-0000-4000-8000-000000000004'::uuid as j;
grant select on ids to service_role, authenticated, anon;

select public.fixture_user_with_workspace(a, 'A'), public.fixture_user_with_workspace(b, 'B'),
       public.fixture_user_with_workspace(c, 'C'), public.fixture_user_with_workspace(g, 'G'),
       public.fixture_user_with_workspace(h, 'H'), public.fixture_user_with_workspace(i, 'I'),
       public.fixture_user_with_workspace(j, 'J')
from ids;
insert into auth.users select d from ids union all select e from ids union all select f from ids;
-- D is a plain member of C's workspace; E owns a non-derived brand; F is an operator.
insert into public.brand_memberships select 'u_' || substr(md5(c::text), 1, 24), d, 'member' from ids;
insert into public.brands (id, code_profile_key) values ('kabumori', 'kabumori_v1');
insert into public.brand_memberships select 'kabumori', e, 'owner' from ids;
insert into public.admin_users select f from ids;
update public.scheduled_posts set status = 'running' where status = 'pending' and brand_id = (select 'u_' || substr(md5(g::text), 1, 24) from ids);
update public.x_account_refresh_state_v2 set status = 'refreshing'
 where social_account_id in (select id from public.social_accounts where brand_id = (select 'u_' || substr(md5(h::text), 1, 24) from ids));
insert into public.brand_settings select 'u_' || substr(md5(i::text), 1, 24) from ids;
update public.brands set code_profile_key = 'legacy_v1' where id = (select 'u_' || substr(md5(j::text), 1, 24) from ids);

-- 1. Client roles can execute nothing and read no audit.
select pg_temp.expect(pg_temp.error_as(r, format('select public.social_mobile_account_deletion_%s(%L::uuid)', f, (select a from ids))) like '%permission denied%', r || ' ' || f)
from unnest(array['anon', 'authenticated']) r, unnest(array['begin', 'purge']) f;
select pg_temp.expect(pg_temp.error_as('authenticated', format('select * from public.social_mobile_account_deletion_credentials(%L::uuid)', (select a from ids))) like '%permission denied%', 'authenticated credentials');
select pg_temp.expect(pg_temp.error_as('authenticated', 'select * from public.social_mobile_account_deletion_audit') like '%permission denied%', 'authenticated audit read');
select pg_temp.expect(pg_temp.error_as('service_role', 'select * from public.social_mobile_account_deletion_audit') like '%permission denied%', 'service_role audit read is via functions only');
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_blocker(%L::uuid, %L)', (select a from ids), 'x')) like '%permission denied%', 'internal helper not callable');

-- 2. Credentials and purge refuse before begin.
select pg_temp.expect(pg_temp.error_as('service_role', format('select * from public.social_mobile_account_deletion_credentials(%L::uuid)', (select a from ids))) like '%SOCIAL_MOBILE_DELETION_NOT_STARTED%', 'credentials before begin');
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_purge(%L::uuid)', (select a from ids))) like '%SOCIAL_MOBILE_DELETION_NOT_STARTED%', 'purge before begin');

-- 3. Blocked users: nothing changes for them.
create temp table blocked as
select u.label, u.uid, (set_config('role', 'service_role', true) is not null) as _r,
       public.social_mobile_account_deletion_begin(u.uid) as result
from (select 'C' label, c uid from ids union all select 'E', e from ids union all select 'F', f from ids
      union all select 'G', g from ids union all select 'H', h from ids union all select 'J', j from ids) u;
reset role;
select pg_temp.expect((select result from blocked where label = 'C') = '{"status": "blocked", "reason": "SHARED_WORKSPACE"}', 'shared workspace');
select pg_temp.expect((select result from blocked where label = 'E') = '{"status": "blocked", "reason": "OWNS_OTHER_WORKSPACE"}', 'owner of another workspace');
select pg_temp.expect((select result from blocked where label = 'F') = '{"status": "blocked", "reason": "ADMIN_ACCOUNT"}', 'admin');
select pg_temp.expect((select result from blocked where label = 'G') = '{"status": "blocked", "reason": "POSTING_IN_PROGRESS"}', 'running post');
select pg_temp.expect((select result from blocked where label = 'H') = '{"status": "blocked", "reason": "CREDENTIAL_REFRESH_IN_PROGRESS"}', 'refreshing');
select pg_temp.expect((select result from blocked where label = 'J') = '{"status": "blocked", "reason": "WORKSPACE_NOT_SELF_SERVICE"}', 'foreign profile on derived id');
select pg_temp.expect((select bool_and(is_active and publish_mode = 'live') from public.brands where id in (
  select 'u_' || substr(md5(x::text), 1, 24) from ids, unnest(array[c, g, h]) x)), 'blocked workspaces untouched');
select pg_temp.expect((select count(*) from public.brands where id = 'kabumori' and is_active) = 1, 'other workspace untouched');

-- 4. User A: begin disables posting authority first.
set role service_role;
select pg_temp.expect(public.social_mobile_account_deletion_begin(a) = '{"status": "ready", "workspace": true, "x_accounts": 1}', 'A begin') from ids;
reset role;
select pg_temp.expect((select not is_active and publish_mode = 'disabled' from public.brands where id = 'u_' || substr(md5(a::text), 1, 24)), 'A brand disabled') from ids;
select pg_temp.expect((select bool_and(not publish_enabled) from public.social_accounts where brand_id = 'u_' || substr(md5(a::text), 1, 24)), 'A publishing off') from ids;
select pg_temp.expect((select count(*) from public.scheduled_posts where brand_id = 'u_' || substr(md5(a::text), 1, 24) and status = 'pending') = 0, 'A pending posts stopped') from ids;
select pg_temp.expect((select bool_and(mode = 'off' and reason_code = 'ACCOUNT_DELETION') from public.x_account_refresh_rollout r join public.social_accounts s on s.id = r.social_account_id where s.brand_id = 'u_' || substr(md5(a::text), 1, 24)), 'A refresh rollout off') from ids;

-- 5. Credentials: only A's own tokens.
set role service_role;
create temp table creds as select * from public.social_mobile_account_deletion_credentials((select a from ids));
reset role;
select pg_temp.expect((select count(*) = 1 and bool_and(access_token = 'fake_A_ACCESS' and refresh_token = 'fake_A_REFRESH') from creds), 'A credentials exact');

-- 6. Purge A: all of A's workspace data and Vault secrets gone; B intact.
create temp table before_b as select pg_temp.brand_rows('u_' || substr(md5(b::text), 1, 24)) as n, (select count(*) from vault.secrets where secret like 'fake_B_%') as s from ids;
set role service_role;
select pg_temp.expect(public.social_mobile_account_deletion_purge(a) = '{"status": "purged", "x_accounts": 1, "vault_secrets": 3}', 'A purge') from ids;
reset role;
select pg_temp.expect(pg_temp.brand_rows('u_' || substr(md5(a::text), 1, 24)) = 0, 'A workspace rows gone') from ids;
select pg_temp.expect((select count(*) from vault.secrets where secret like 'fake_A_%') = 0, 'A vault secrets gone');
select pg_temp.expect((select count(*) from public.x_account_refresh_state_v2 s left join public.social_accounts a on a.id = s.social_account_id where a.id is null) = 0, 'no orphan refresh state');
select pg_temp.expect(pg_temp.brand_rows('u_' || substr(md5(b::text), 1, 24)) = (select n from before_b) and (select count(*) from vault.secrets where secret like 'fake_B_%') = (select s from before_b), 'B untouched') from ids;
select pg_temp.expect((select is_active and publish_mode = 'live' from public.brands where id = 'u_' || substr(md5(b::text), 1, 24)), 'B still live') from ids;

-- 7. Idempotent repeats.
set role service_role;
select pg_temp.expect(public.social_mobile_account_deletion_begin(a) = '{"status": "ready", "workspace": false, "x_accounts": 0}', 'A begin again') from ids;
select pg_temp.expect(public.social_mobile_account_deletion_purge(a) = '{"status": "nothing_to_purge"}', 'A purge again') from ids;
select pg_temp.expect((select count(*) from public.social_mobile_account_deletion_credentials((select a from ids))) = 0, 'A credentials again');
reset role;

-- 8. D (member only) may proceed without touching C's shared workspace.
set role service_role;
select pg_temp.expect(public.social_mobile_account_deletion_begin(d) = '{"status": "ready", "workspace": false, "x_accounts": 0}', 'D begin') from ids;
select pg_temp.expect(public.social_mobile_account_deletion_purge(d) = '{"status": "nothing_to_purge"}', 'D purge') from ids;
reset role;
select pg_temp.expect((select is_active from public.brands where id = 'u_' || substr(md5(c::text), 1, 24)), 'C workspace untouched by D') from ids;

-- 9. Unexpected dependent data (I has brand_settings): purge aborts atomically.
set role service_role;
select pg_temp.expect(public.social_mobile_account_deletion_begin(i) ->> 'status' = 'ready', 'I begin') from ids;
reset role;
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_purge(%L::uuid)', (select i from ids))) like '%SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA%', 'I purge refused');
select pg_temp.expect((select count(*) from public.social_accounts where brand_id = 'u_' || substr(md5(i::text), 1, 24)) = 1 and (select count(*) from vault.secrets where secret like 'fake_I_%') = 3, 'I rolled back') from ids;

-- 10. Deleting the auth user afterwards cascades memberships/oauth states only.
delete from auth.users where id = (select a from ids);
select pg_temp.expect((select count(*) from public.brand_memberships where user_id = (select a from ids)) = 0, 'A memberships cascade');

-- 11. Audit: hashes, fixed steps/codes only; never the raw id.
select pg_temp.expect((select count(*) from public.social_mobile_account_deletion_audit where subject_sha256 = encode(sha256(convert_to((select a::text from ids), 'UTF8')), 'hex')) >= 4, 'A audited');
select pg_temp.expect((select count(*) from public.social_mobile_account_deletion_audit where step = 'blocked') = 6, 'blocked audited');
select pg_temp.expect(not exists (
  select 1 from public.social_mobile_account_deletion_audit t, ids
  where t.subject_sha256 like '%' || replace(ids.a::text, '-', '') || '%' or t::text like '%' || ids.a::text || '%' or t::text like '%fake_%'
), 'audit has no raw ids or tokens');

select 'SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS';
