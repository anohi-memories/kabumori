-- Behavior proof for the social-mobile account deletion candidate (phase 4b).
-- Fake data only, disposable database only. The real onboarding RPCs
-- (begin/complete_social_mobile_x_oauth_connection) are applied from their
-- migrations by the runner. Prints SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
end;
$$;

-- Runs p_sql as p_role (optionally as JWT subject p_sub); returns the error message or null.
create function pg_temp.error_as(p_role text, p_sql text, p_sub uuid default null) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return null;
exception when others then
  reset role;
  return sqlerrm;
end;
$$;

-- Runs a service_role call that returns jsonb.
create function pg_temp.svc(p_sql text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v;
  reset role;
  return v;
end;
$$;

create function pg_temp.acquire(p_user uuid, p_scope text default 'social_and_login', p_apple boolean default false) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.social_mobile_account_deletion_acquire(%L::uuid, %L, %L)', p_user, p_scope, p_apple))
$$;
create function pg_temp.step(p_fn text, p_user uuid, p_lease text, p_extra jsonb default null) returns jsonb language sql as $$
  select pg_temp.svc(case when p_extra is null
    then format('select public.social_mobile_account_deletion_%s(%L::uuid, %L::uuid)', p_fn, p_user, p_lease)
    else format('select public.social_mobile_account_deletion_%s(%L::uuid, %L::uuid, %L::jsonb)', p_fn, p_user, p_lease, p_extra) end)
$$;
-- What the Edge Function reports after revoking exactly what credentials() returned.
create function pg_temp.revoked_from(p_creds jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a ->> 'id',
    'access_sha256', encode(sha256(convert_to(a ->> 'access_token', 'UTF8')), 'hex'),
    'refresh_sha256', encode(sha256(convert_to(a ->> 'refresh_token', 'UTF8')), 'hex')) order by a ->> 'id'), '[]'::jsonb)
  from jsonb_array_elements(p_creds -> 'accounts') a where (a ->> 'revoke_required')::boolean
$$;
create function pg_temp.ws(p_user uuid) returns text language sql as $$ select 'u_' || substr(md5(p_user::text), 1, 24) $$;
create function pg_temp.ws_rows(p_brand text) returns bigint language sql as $$
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
create function pg_temp.state(p_user uuid) returns text language sql as $$
  select coalesce((select state from public.social_mobile_account_deletions where user_id = p_user), 'none')
$$;

create temp table u (label text primary key, id uuid not null);
insert into u values
  ('a', '00000000-0000-4000-8000-00000000000a'), ('b', '00000000-0000-4000-8000-00000000000b'),
  ('c', '00000000-0000-4000-8000-00000000000c'), ('d', '00000000-0000-4000-8000-00000000000d'),
  ('e', '00000000-0000-4000-8000-00000000000e'), ('f', '00000000-0000-4000-8000-00000000000f'),
  ('g', '00000000-0000-4000-8000-000000000001'), ('h', '00000000-0000-4000-8000-000000000002'),
  ('i', '00000000-0000-4000-8000-000000000003'), ('j', '00000000-0000-4000-8000-000000000004'),
  ('k', '00000000-0000-4000-8000-000000000005'), ('m', '00000000-0000-4000-8000-000000000006'),
  ('n', '00000000-0000-4000-8000-000000000007'), ('p', '00000000-0000-4000-8000-000000000008'),
  ('r1', '00000000-0000-4000-8000-000000000009'), ('r2', '00000000-0000-4000-8000-000000000010'),
  ('s1', '00000000-0000-4000-8000-000000000011'), ('s2', '00000000-0000-4000-8000-000000000012'),
  ('t', '00000000-0000-4000-8000-000000000013'), ('v', '00000000-0000-4000-8000-000000000014'),
  ('w', '00000000-0000-4000-8000-000000000015');
create function pg_temp.uid(p_label text) returns uuid language sql as $$ select id from u where label = p_label $$;
grant select on u to service_role, authenticated, anon;

select public.fixture_user_with_workspace(id, upper(label)) from u where label in ('a', 'b', 'c', 'g', 'h', 'i', 'j', 'k', 'm', 'p', 'r1', 'r2', 's1', 's2', 't', 'v');
insert into auth.users select id from u where label in ('d', 'e', 'f', 'n', 'w');
insert into public.brand_memberships values (pg_temp.ws(pg_temp.uid('c')), pg_temp.uid('d'), 'member');
insert into public.brands (id, code_profile_key) values ('kabumori', 'kabumori_v1');
insert into public.brand_memberships values ('kabumori', pg_temp.uid('e'), 'owner');
insert into public.admin_users values (pg_temp.uid('f'));
update public.scheduled_posts set status = 'running' where status = 'pending' and brand_id = pg_temp.ws(pg_temp.uid('g'));
update public.x_account_refresh_state_v2 set status = 'refreshing'
 where social_account_id in (select id from public.social_accounts where brand_id = pg_temp.ws(pg_temp.uid('h')));
insert into public.brand_settings values (pg_temp.ws(pg_temp.uid('i')));
update public.brands set code_profile_key = 'legacy_v1' where id = pg_temp.ws(pg_temp.uid('j'));
insert into public.profiles values (pg_temp.uid('k'), 'k main app');
-- R3 fixtures: s1's access secret is s2's; t's access and refresh are one secret; v's verifier is b's token.
update public.social_accounts set vault_access_token_secret_id =
  (select vault_access_token_secret_id from public.social_accounts where brand_id = pg_temp.ws(pg_temp.uid('s2')))
 where brand_id = pg_temp.ws(pg_temp.uid('s1'));
update public.social_accounts set vault_refresh_token_secret_id = vault_access_token_secret_id where brand_id = pg_temp.ws(pg_temp.uid('t'));
update public.social_account_oauth_states set code_verifier_vault_secret_id =
  (select vault_access_token_secret_id from public.social_accounts where brand_id = pg_temp.ws(pg_temp.uid('b')))
 where brand_id = pg_temp.ws(pg_temp.uid('v'));
-- R4 fixtures: m's access token material is gone; w is a never-connected user.
delete from vault.secrets where id = (select vault_access_token_secret_id from public.social_accounts where brand_id = pg_temp.ws(pg_temp.uid('m')));
select set_config('request.jwt.claim.sub', pg_temp.uid('w')::text, false);
set role authenticated;
select * from public.begin_social_mobile_x_oauth_connection(repeat('1', 64), 'kabumori-social://oauth-callback', now() + interval '10 minutes');
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 1. ACL: clients execute nothing; service_role reads no table and no internal helper.
select pg_temp.expect(pg_temp.error_as(r, format('select public.social_mobile_account_deletion_%s', f)) like '%permission denied%', r || ' ' || f)
from unnest(array['anon', 'authenticated']) r,
     unnest(array['preview(''00000000-0000-4000-8000-00000000000a'')',
                  'acquire(''00000000-0000-4000-8000-00000000000a'', ''social_and_login'', false)',
                  'purge(''00000000-0000-4000-8000-00000000000a'', gen_random_uuid())',
                  'finalize(''00000000-0000-4000-8000-00000000000a'', gen_random_uuid())',
                  'operator_resolve(''00000000-0000-4000-8000-00000000000a'', ''cancel'')']) f;
select pg_temp.expect(pg_temp.error_as(r, format('select * from public.%s', t)) like '%permission denied%', r || ' reads ' || t)
from unnest(array['authenticated', 'service_role']) r, unnest(array['social_mobile_account_deletions', 'social_mobile_account_deletion_audit']) t;
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_%s', f)) like '%permission denied%', 'helper ' || f)
from unnest(array['blocker(''00000000-0000-4000-8000-00000000000a'', ''x'')', 'hold(''00000000-0000-4000-8000-00000000000a'', gen_random_uuid())',
                  'ownership_problem(''x'')', 'fingerprint(gen_random_uuid())', 'to_operator(''00000000-0000-4000-8000-00000000000a'', ''X'')']) f;

-- 2. Blocked users: fixed codes, no tombstone, nothing changed.
select pg_temp.expect(pg_temp.acquire(pg_temp.uid(label)) = jsonb_build_object('status', 'blocked', 'reason', reason), label || ' ' || reason)
from (values ('c', 'SHARED_WORKSPACE'), ('e', 'OWNS_OTHER_WORKSPACE'), ('f', 'ADMIN_ACCOUNT'), ('g', 'POSTING_IN_PROGRESS'),
             ('h', 'CREDENTIAL_REFRESH_IN_PROGRESS'), ('j', 'WORKSPACE_NOT_SELF_SERVICE'),
             ('s1', 'CREDENTIAL_OWNERSHIP_AMBIGUOUS'), ('t', 'CREDENTIAL_OWNERSHIP_AMBIGUOUS'), ('v', 'CREDENTIAL_OWNERSHIP_AMBIGUOUS')) x(label, reason);
select pg_temp.expect((select count(*) from public.social_mobile_account_deletions) = 0, 'no tombstone for blocked users');
select pg_temp.expect((select bool_and(is_active and publish_mode = 'live') from public.brands where id in (
  select pg_temp.ws(id) from u where label in ('c', 'g', 'h', 's1', 's2', 't', 'v'))), 'blocked workspaces untouched');
-- H2_SHARED_SECRET_REFERENCE_CROSS_TENANT: s2's secret is never touched.
select pg_temp.expect((select count(*) from vault.secrets where secret = 'fake_S2_ACCESS') = 1, 'R3 s2 secret intact');

-- 3. Scope: a user with Kabumori main-app data can only remove social data.
select pg_temp.expect(pg_temp.svc(format('select public.social_mobile_account_deletion_preview(%L::uuid)', pg_temp.uid('k'))) ->> 'scope' = 'social_only', 'k preview');
select pg_temp.expect(pg_temp.acquire(pg_temp.uid('k'), 'social_and_login') = '{"status": "scope_changed", "scope": "social_only"}', 'k scope mismatch');
select pg_temp.expect(pg_temp.state(pg_temp.uid('k')) = 'none', 'k no tombstone');

-- 4. User a (no main-app data): full deletion including the login.
create temp table run (label text primary key, lease text, creds jsonb);
insert into run select 'a', pg_temp.acquire(pg_temp.uid('a')) ->> 'lease', null;
select pg_temp.expect((select lease from run where label = 'a') is not null, 'a acquired');
select pg_temp.expect(pg_temp.acquire(pg_temp.uid('a')) = '{"status": "in_progress"}', 'a second acquire refused while leased');
select pg_temp.expect((select not is_active and publish_mode = 'disabled' from public.brands where id = pg_temp.ws(pg_temp.uid('a'))), 'a posting off first');
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_purge(%L::uuid, gen_random_uuid())', pg_temp.uid('a'))) like '%SOCIAL_MOBILE_DELETION_LEASE_LOST%', 'a wrong lease');
select pg_temp.expect(pg_temp.step('purge', pg_temp.uid('a'), (select lease from run where label = 'a')) ->> 'status' = 'not_ready', 'a purge before revoke');
update run set creds = pg_temp.step('credentials', pg_temp.uid('a'), lease) where label = 'a';
select pg_temp.expect((select creds -> 'accounts' -> 0 ->> 'access_token' = 'fake_A_ACCESS' and (creds -> 'accounts' -> 0 ->> 'revoke_required')::boolean from run where label = 'a'), 'a credentials');
select pg_temp.expect(pg_temp.step('mark_x_revoked', pg_temp.uid('a'), (select lease from run where label = 'a'), '[]') = '{"status": "credentials_changed"}', 'a incomplete revoke report refused');
select pg_temp.expect(pg_temp.step('mark_x_revoked', pg_temp.uid('a'), lease, pg_temp.revoked_from(creds)) = '{"status": "x_revoked"}', 'a x revoked') from run where label = 'a';
create temp table before_b as select pg_temp.ws_rows(pg_temp.ws(pg_temp.uid('b'))) as n, (select count(*) from vault.secrets where secret like 'fake_B_%') as s;
select pg_temp.expect(pg_temp.step('purge', pg_temp.uid('a'), lease) = '{"status": "purged"}', 'a purged') from run where label = 'a';
select pg_temp.expect(pg_temp.ws_rows(pg_temp.ws(pg_temp.uid('a'))) = 0 and (select count(*) from vault.secrets where secret like 'fake_A_%') = 0, 'a data and secrets gone');
select pg_temp.expect(pg_temp.ws_rows(pg_temp.ws(pg_temp.uid('b'))) = (select n from before_b) and (select count(*) from vault.secrets where secret like 'fake_B_%') = (select s from before_b), 'b untouched');
select pg_temp.expect(pg_temp.step('purge', pg_temp.uid('a'), lease) = '{"status": "purged"}', 'a purge idempotent') from run where label = 'a';
select pg_temp.expect(pg_temp.step('finalize', pg_temp.uid('a'), lease) = '{"reason": null, "status": "completed", "login_deleted": true}', 'a completed') from run where label = 'a';
select pg_temp.expect(not exists (select 1 from auth.users where id = pg_temp.uid('a')) and pg_temp.state(pg_temp.uid('a')) = 'none', 'a login and tombstone gone');
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_finalize(%L::uuid, %L::uuid)', pg_temp.uid('a'), lease)) like '%LEASE_LOST%', 'a finalize after completion') from run where label = 'a';

-- 5. H2_RECONNECT_AFTER_CREDENTIAL_SNAPSHOT: reconnect cannot install new credentials.
insert into run select 'r1', pg_temp.acquire(pg_temp.uid('r1')) ->> 'lease', null;
update run set creds = pg_temp.step('credentials', pg_temp.uid('r1'), lease) where label = 'r1';
select pg_temp.expect(pg_temp.error_as('authenticated', format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')', repeat('2', 64), 'kabumori-social://oauth-callback'), pg_temp.uid('r1'))
  like '%SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS%', 'r1 reconnect begin refused');
select pg_temp.expect(pg_temp.error_as('authenticated', format('select public.complete_social_mobile_x_oauth_connection(%L::uuid, %L, %L, %L, %L)',
  (select id from public.social_account_oauth_states where brand_id = pg_temp.ws(pg_temp.uid('r1')) limit 1), 'x_R1', 'r1', 'fake_R1_NEW_ACCESS', 'fake_R1_NEW_REFRESH'), pg_temp.uid('r1'))
  like '%SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS%', 'r1 reconnect complete refused');
select pg_temp.expect((select count(*) from vault.secrets where secret like 'fake_R1_NEW%') = 0, 'r1 no new credentials');
-- Every other writer of the workspace fails closed too.
select pg_temp.expect(pg_temp.error_as('service_role', stmt) like '%SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS%', stmt)
from (select unnest(array[
  format('insert into public.scheduled_posts (brand_id) values (%L)', pg_temp.ws(pg_temp.uid('r1'))),
  format('update public.brands set publish_mode = ''live'', is_active = true where id = %L', pg_temp.ws(pg_temp.uid('r1'))),
  format('update public.social_accounts set publish_enabled = true where brand_id = %L', pg_temp.ws(pg_temp.uid('r1'))),
  format('update public.x_account_refresh_state_v2 set generation = generation + 1 where social_account_id in (select id from public.social_accounts where brand_id = %L)', pg_temp.ws(pg_temp.uid('r1'))),
  format('update public.x_account_refresh_rollout set mode = ''enabled'' where social_account_id in (select id from public.social_accounts where brand_id = %L)', pg_temp.ws(pg_temp.uid('r1'))),
  format('insert into public.publish_claims (status, brand_id) values (''publishing'', %L)', pg_temp.ws(pg_temp.uid('r1'))),
  format('insert into public.post_execution_logs (status, brand_id) values (''started'', %L)', pg_temp.ws(pg_temp.uid('r1'))),
  format('insert into public.posting_windows (brand_id) values (%L)', pg_temp.ws(pg_temp.uid('r1')))]) stmt) x;
-- Other users are unaffected.
select pg_temp.expect(pg_temp.error_as('service_role', format('insert into public.scheduled_posts (brand_id) values (%L)', pg_temp.ws(pg_temp.uid('b')))) is null, 'b can still write');
-- A writer outside the guarded tables rotates the Vault material: the stale report is refused.
update vault.secrets set secret = 'fake_R1_ROTATED_ACCESS' where secret = 'fake_R1_ACCESS';
select pg_temp.expect(pg_temp.step('mark_x_revoked', pg_temp.uid('r1'), lease, pg_temp.revoked_from(creds)) = '{"status": "credentials_changed"}', 'r1 stale snapshot refused') from run where label = 'r1';
update run set creds = pg_temp.step('credentials', pg_temp.uid('r1'), lease) where label = 'r1';
select pg_temp.expect(pg_temp.step('mark_x_revoked', pg_temp.uid('r1'), lease, pg_temp.revoked_from(creds)) = '{"status": "x_revoked"}', 'r1 fresh material revoked') from run where label = 'r1';
-- Rotation after the revoke report: purge refuses and hands over to an operator.
update vault.secrets set secret = 'fake_R1_ROTATED_AGAIN' where secret = 'fake_R1_ROTATED_ACCESS';
select pg_temp.expect(pg_temp.step('purge', pg_temp.uid('r1'), lease) = '{"reason": "CREDENTIALS_CHANGED", "status": "operator_required"}', 'r1 purge refused after rotation') from run where label = 'r1';
select pg_temp.expect(pg_temp.ws_rows(pg_temp.ws(pg_temp.uid('r1'))) > 0, 'r1 nothing deleted');
select pg_temp.expect(pg_temp.acquire(pg_temp.uid('r1')) = '{"reason": "CREDENTIALS_CHANGED", "status": "operator_required"}', 'r1 stays with operator');
select pg_temp.expect(pg_temp.error_as('authenticated', format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')', repeat('3', 64), 'kabumori-social://oauth-callback'), pg_temp.uid('r1'))
  like '%SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS%', 'r1 still guarded while operator_required');
select pg_temp.expect(pg_temp.svc(format('select public.social_mobile_account_deletion_operator_resolve(%L::uuid, ''retry'')', pg_temp.uid('r1'))) = '{"status": "resolved"}', 'r1 operator retry');
select pg_temp.expect(pg_temp.state(pg_temp.uid('r1')) = 'x_revoked', 'r1 resumes at x_revoked');

-- 6. H2_PURGE_AUTH_DELETE_GAP: after purge, nothing can recreate the workspace before finalize.
insert into run select 'r2', pg_temp.acquire(pg_temp.uid('r2')) ->> 'lease', null;
update run set creds = pg_temp.step('credentials', pg_temp.uid('r2'), lease) where label = 'r2';
select pg_temp.step('mark_x_revoked', pg_temp.uid('r2'), lease, pg_temp.revoked_from(creds)) from run where label = 'r2';
select pg_temp.expect(pg_temp.step('purge', pg_temp.uid('r2'), lease) = '{"status": "purged"}', 'r2 purged') from run where label = 'r2';
select pg_temp.expect(pg_temp.error_as('authenticated', format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')', repeat('4', 64), 'kabumori-social://oauth-callback'), pg_temp.uid('r2'))
  like '%SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS%', 'r2 recreation refused in the gap');
select pg_temp.expect(pg_temp.ws_rows(pg_temp.ws(pg_temp.uid('r2'))) = 0, 'r2 no orphan');
-- A finalize failure/lost lease keeps the tombstone; a re-acquire resumes at purged.
select pg_temp.svc(format('select to_jsonb(public.social_mobile_account_deletion_release(%L::uuid, %L::uuid))', pg_temp.uid('r2'), lease)) from run where label = 'r2';
update run set lease = pg_temp.acquire(pg_temp.uid('r2')) ->> 'lease' where label = 'r2';
select pg_temp.expect(pg_temp.state(pg_temp.uid('r2')) = 'purged', 'r2 resumes at purged');
select pg_temp.expect(pg_temp.step('finalize', pg_temp.uid('r2'), lease) ->> 'login_deleted' = 'true', 'r2 completed') from run where label = 'r2';
select pg_temp.expect(pg_temp.error_as('authenticated', format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')', repeat('5', 64), 'kabumori-social://oauth-callback'), pg_temp.uid('r2')) is not null
  and pg_temp.ws_rows(pg_temp.ws(pg_temp.uid('r2'))) = 0, 'r2 cannot recreate after login deletion');

-- 7. Kabumori data is never cascaded: social-only deletion keeps the login and profile.
insert into run select 'k', pg_temp.acquire(pg_temp.uid('k'), 'social_only') ->> 'lease', null;
update run set creds = pg_temp.step('credentials', pg_temp.uid('k'), lease) where label = 'k';
select pg_temp.step('mark_x_revoked', pg_temp.uid('k'), lease, pg_temp.revoked_from(creds)) from run where label = 'k';
select pg_temp.step('purge', pg_temp.uid('k'), lease) from run where label = 'k';
select pg_temp.expect(pg_temp.step('finalize', pg_temp.uid('k'), lease) = '{"reason": null, "status": "completed", "login_deleted": false}', 'k social only') from run where label = 'k';
select pg_temp.expect(exists (select 1 from auth.users where id = pg_temp.uid('k')) and exists (select 1 from public.profiles where id = pg_temp.uid('k')), 'k login and main-app data kept');
select pg_temp.expect(pg_temp.error_as('authenticated', format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, now() + interval ''10 minutes'')', repeat('6', 64), 'kabumori-social://oauth-callback'), pg_temp.uid('k')) is null, 'k may start over after completion');
-- p had no main-app data at start; a profile appears before finalize: the login is kept.
insert into run select 'p', pg_temp.acquire(pg_temp.uid('p')) ->> 'lease', null;
update run set creds = pg_temp.step('credentials', pg_temp.uid('p'), lease) where label = 'p';
select pg_temp.step('mark_x_revoked', pg_temp.uid('p'), lease, pg_temp.revoked_from(creds)) from run where label = 'p';
select pg_temp.step('purge', pg_temp.uid('p'), lease) from run where label = 'p';
insert into public.profiles values (pg_temp.uid('p'), 'late');
select pg_temp.expect(pg_temp.step('finalize', pg_temp.uid('p'), lease) = '{"reason": "MAIN_APP_ACCOUNT_PRESENT", "status": "completed", "login_deleted": false}', 'p kept login') from run where label = 'p';
select pg_temp.expect(exists (select 1 from public.profiles where id = pg_temp.uid('p')), 'p profile kept');

-- 8. R4: connected account with missing material -> operator; never-connected -> no revoke needed.
insert into run select 'm', pg_temp.acquire(pg_temp.uid('m')) ->> 'lease', null;
select pg_temp.expect(pg_temp.step('credentials', pg_temp.uid('m'), lease) = '{"reason": "CREDENTIAL_MATERIAL_MISSING", "status": "operator_required"}', 'm material missing') from run where label = 'm';
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_purge(%L::uuid, %L::uuid)', pg_temp.uid('m'), lease)) like '%LEASE_LOST%', 'm cannot purge') from run where label = 'm';
select pg_temp.expect(pg_temp.ws_rows(pg_temp.ws(pg_temp.uid('m'))) > 0, 'm nothing deleted');
select pg_temp.expect(pg_temp.svc(format('select public.social_mobile_account_deletion_operator_resolve(%L::uuid, ''x_revoked_out_of_band'')', pg_temp.uid('m'))) = '{"status": "resolved"}', 'm operator confirms revoke');
select pg_temp.expect(pg_temp.state(pg_temp.uid('m')) = 'x_revoked', 'm resumes after operator');
insert into run select 'w', pg_temp.acquire(pg_temp.uid('w')) ->> 'lease', null;
update run set creds = pg_temp.step('credentials', pg_temp.uid('w'), lease) where label = 'w';
select pg_temp.expect((select (creds -> 'accounts' -> 0 ->> 'revoke_required')::boolean = false and creds -> 'accounts' -> 0 ->> 'access_token' is null from run where label = 'w'), 'w nothing to revoke');
select pg_temp.expect(pg_temp.step('mark_x_revoked', pg_temp.uid('w'), lease, '[]') = '{"status": "x_revoked"}', 'w proceeds without revoke') from run where label = 'w';
-- n: identity verified but no stored material at all -> operator, not a skip.
insert into public.brands (id) values (pg_temp.ws(pg_temp.uid('n')));
insert into public.brand_memberships values (pg_temp.ws(pg_temp.uid('n')), pg_temp.uid('n'), 'owner');
insert into public.social_accounts (id, brand_id, platform_user_id) values ('sa_n_fixture', pg_temp.ws(pg_temp.uid('n')), 'x_N');
insert into run select 'n', pg_temp.acquire(pg_temp.uid('n')) ->> 'lease', null;
select pg_temp.expect(pg_temp.step('credentials', pg_temp.uid('n'), lease) ->> 'reason' = 'CREDENTIAL_MATERIAL_MISSING', 'n missing material') from run where label = 'n';
select pg_temp.expect(pg_temp.svc(format('select public.social_mobile_account_deletion_operator_resolve(%L::uuid, ''cancel'')', pg_temp.uid('n'))) = '{"status": "resolved"}', 'n operator cancel');
select pg_temp.expect(pg_temp.state(pg_temp.uid('n')) = 'none' and (select not is_active from public.brands where id = pg_temp.ws(pg_temp.uid('n'))), 'n cancelled, posting stays off');

-- 9. R5: Apple checkpoint is durable and required before purge.
insert into run select 'i', pg_temp.acquire(pg_temp.uid('i'), 'social_and_login', true) ->> 'lease', null;
update run set creds = pg_temp.step('credentials', pg_temp.uid('i'), lease) where label = 'i';
select pg_temp.step('mark_x_revoked', pg_temp.uid('i'), lease, pg_temp.revoked_from(creds)) from run where label = 'i';
select pg_temp.expect(pg_temp.step('purge', pg_temp.uid('i'), lease) = '{"status": "apple_revoke_required"}', 'i apple first') from run where label = 'i';
select pg_temp.expect(pg_temp.step('mark_apple_revoked', pg_temp.uid('i'), lease) = '{"status": "apple_revoked"}', 'i apple checkpoint') from run where label = 'i';
select pg_temp.svc(format('select to_jsonb(public.social_mobile_account_deletion_release(%L::uuid, %L::uuid))', pg_temp.uid('i'), lease)) from run where label = 'i';
create temp table i_retry as select pg_temp.acquire(pg_temp.uid('i'), 'social_and_login', true) as r;
select pg_temp.expect((select r ->> 'apple_revoked' = 'true' and r ->> 'state' = 'x_revoked' from i_retry), 'i checkpoint survives retry');
update run set lease = (select r ->> 'lease' from i_retry) where label = 'i';
-- Unexpected dependent (brand_settings): the purge aborts atomically and can be retried.
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.social_mobile_account_deletion_purge(%L::uuid, %L::uuid)', pg_temp.uid('i'), lease)) like '%SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA%', 'i purge aborted') from run where label = 'i';
select pg_temp.expect(pg_temp.state(pg_temp.uid('i')) = 'x_revoked' and (select count(*) from vault.secrets where secret like 'fake_I_%') = 3, 'i rolled back');

-- 10. Audit: hashes and fixed codes only.
select pg_temp.expect((select count(*) from public.social_mobile_account_deletion_audit where subject_sha256 = encode(sha256(convert_to(pg_temp.uid('a')::text, 'UTF8')), 'hex')) >= 4, 'a audited');
select pg_temp.expect(not exists (
  select 1 from public.social_mobile_account_deletion_audit t, u where t::text like '%' || u.id::text || '%' or t::text like '%fake_%'), 'audit has no raw ids or tokens');

select 'SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS';
