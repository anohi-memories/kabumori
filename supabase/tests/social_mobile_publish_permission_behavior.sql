-- Behavior proof for the publish-permission boundary (single session; the
-- concurrency proofs are in social_mobile_publish_permission_run.sh).
-- Results are captured with \gset and asserted in the NEXT statement: a call
-- and a check of its effect in one statement would read the pre-call snapshot.
\set ON_ERROR_STOP 1
\set owner   '00000000-0000-4000-8000-000000000001'
\set admin   '00000000-0000-4000-8000-000000000002'
\set member  '00000000-0000-4000-8000-000000000003'
\set viewer  '00000000-0000-4000-8000-000000000004'
\set other   '00000000-0000-4000-8000-000000000005'
\set kowner  '00000000-0000-4000-8000-000000000006'
\set fn 'public.set_social_account_publish_enabled(text,boolean,boolean)'
\set chk 'public.assert_x_publish_permission_for_legacy_post(uuid,text,text)'

select public.fixture_brand(:'owner', 'main') as ws \gset
select public.fixture_member(:'ws', :'admin', 'admin');
select public.fixture_member(:'ws', :'member', 'member');
select public.fixture_member(:'ws', :'viewer', 'viewer');
select public.fixture_brand(:'other', 'other', 'brand_b');
-- Kabumori-like legacy account: its token lives outside Vault (no references).
insert into auth.users values (:'kowner');
insert into public.brands (id, code_profile_key) values ('kabumori', 'kabumori_v1');
insert into public.brand_memberships (brand_id, user_id, role) values ('kabumori', :'kowner', 'owner');
insert into public.social_accounts (id, brand_id, handle, platform_user_id, publish_enabled, connection_status, verified_at)
values ('kabumori_x', 'kabumori', 'kabumori', 'x_kabumori', true, 'identity_verified', now());

-- ---- 1. privileges and definition ---------------------------------------------
select public.fixture_check(
  has_function_privilege('authenticated', :'fn', 'execute')
  and not has_function_privilege('anon', :'fn', 'execute')
  and not has_function_privilege('service_role', :'fn', 'execute'),
  'the switch is executable by authenticated only');
select public.fixture_check(
  has_function_privilege('service_role', :'chk', 'execute')
  and not has_function_privilege('anon', :'chk', 'execute')
  and not has_function_privilege('authenticated', :'chk', 'execute'),
  'the permission check is executable by service_role only');
select public.fixture_check(
  (select count(*) from pg_proc p, aclexplode(p.proacl) a
   where p.oid in ((:'fn')::regprocedure, (:'chk')::regprocedure) and a.grantee = 0) = 0,
  'no PUBLIC execute on either function');
select public.fixture_check(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
   where p.oid in ((:'fn')::regprocedure, (:'chk')::regprocedure)),
  'both functions are SECURITY DEFINER with an empty search_path');
select public.fixture_check(
  (select p.proconfig @> array['lock_timeout=3s'] from pg_proc p where p.oid = (:'fn')::regprocedure),
  'the switch bounds its lock waits');
select public.fixture_check(
  (select pg_get_function_identity_arguments((:'fn')::regprocedure))
    = 'p_social_account_id text, p_desired_enabled boolean, p_expected_current_enabled boolean',
  'the switch takes no user id and no brand id');

-- ---- 2. authentication / input ------------------------------------------------
select public.fixture_toggle(null, 'sa_main', true, false) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'auth_required', 'no JWT subject -> auth_required');
select public.fixture_toggle(:'owner', 'sa main', true, false) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'invalid', 'malformed account id -> invalid');
select public.fixture_toggle(:'owner', 'sa_main', null, false) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'invalid', 'null desired -> invalid');
select public.fixture_toggle(:'owner', 'sa_main', true, null) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'invalid', 'null expected -> invalid');

-- ---- 3. tenant isolation ------------------------------------------------------
select public.fixture_untouched() as before \gset
select public.fixture_toggle(:'other', 'sa_does_not_exist', true, false)::text as missing \gset
select public.fixture_toggle(:'other', 'sa_main', true, false)::text as foreign_on \gset
select public.fixture_toggle(:'other', 'sa_main', false, false)::text as foreign_same \gset
select public.fixture_toggle(:'other', 'sa_main', false, true)::text as foreign_stale \gset
select public.fixture_check(
  :'missing' = '{"status": "not_found"}' and :'foreign_on' = :'missing' and :'foreign_same' = :'missing'
  and :'foreign_stale' = :'missing',
  'a foreign account is indistinguishable from a missing one, whatever is asked (no state oracle)');
select public.fixture_toggle(:'viewer', 'sa_main', true, false)::text as v_on \gset
select public.fixture_toggle(:'member', 'sa_main', true, false)::text as m_on \gset
select public.fixture_toggle(:'member', 'sa_main', false, false)::text as m_same \gset
select public.fixture_toggle(:'viewer', 'sa_main', false, true)::text as v_stale \gset
select public.fixture_check(
  :'v_on' = '{"status": "forbidden"}' and :'m_on' = :'v_on' and :'m_same' = :'v_on' and :'v_stale' = :'v_on',
  'viewer and member are refused for every request and learn no state');
select public.fixture_check(
  not (select publish_enabled from public.social_accounts where id = 'sa_main')
  and public.fixture_untouched() = :'before', 'refused requests changed nothing');

-- ---- 4. owner / admin: ON, OFF, compare-and-set, exact mutation ----------------
select public.fixture_toggle(:'admin', 'sa_main', true, false)::text as r \gset
select public.fixture_check(:'r' = '{"status": "updated", "publish_enabled": true}', 'admin ON -> updated');
select public.fixture_check(
  (select publish_enabled from public.social_accounts where id = 'sa_main')
  and public.fixture_untouched() = :'before',
  'ON changed publish_enabled and nothing else (updated_at, other columns, other tables)');
select public.fixture_toggle(:'owner', 'sa_main', true, false)::text as r \gset
select public.fixture_check(:'r' = '{"status": "stale", "publish_enabled": true}', 'a stale expected value -> stale with the real value');
select public.fixture_toggle(:'owner', 'sa_main', true, true)::text as r \gset
select public.fixture_check(:'r' = '{"status": "unchanged", "publish_enabled": true}', 'same state -> unchanged');
select public.fixture_toggle(:'owner', 'sa_main', false, true)::text as r \gset
select public.fixture_check(:'r' = '{"status": "updated", "publish_enabled": false}', 'owner OFF -> updated');
select public.fixture_toggle(:'owner', 'sa_main', false, true)::text as r \gset
select public.fixture_check(:'r' = '{"status": "stale", "publish_enabled": false}', 'the same OFF sent twice -> stale, not a second change');
select public.fixture_check(
  not (select publish_enabled from public.social_accounts where id = 'sa_main')
  and public.fixture_untouched() = :'before', 'OFF changed publish_enabled and nothing else');

-- ---- 5. ON prerequisites ------------------------------------------------------
-- Each case breaks exactly one prerequisite, asks for ON as the owner, then
-- restores. The publish path's own check must refuse the same state when the
-- account is forced ON, so ON never grants what the runtime would not honor:
-- every case names the runtime refusal, none is skipped (exact parity).
create table public.fixture_cases (n int primary key, label text, break_sql text, restore_sql text, reason text not null, runtime text not null);
insert into public.fixture_cases values
  (1, 'brand inactive', $$update public.brands set is_active = false where id = %L$$, $$update public.brands set is_active = true where id = %L$$, 'BRAND_INACTIVE', 'BRAND_DISABLED'),
  (2, 'brand publish_mode disabled', $$update public.brands set publish_mode = 'disabled' where id = %L$$, $$update public.brands set publish_mode = 'live' where id = %L$$, 'BRAND_PUBLISHING_NOT_LIVE', 'BRAND_PUBLISH_MODE_DISABLED'),
  (3, 'brand publish_mode dry_run', $$update public.brands set publish_mode = 'dry_run' where id = %L$$, $$update public.brands set publish_mode = 'live' where id = %L$$, 'BRAND_PUBLISHING_NOT_LIVE', 'BRAND_PUBLISH_MODE_DRY_RUN'),
  (4, 'unconnected', $$update public.social_accounts set connection_status = 'unconnected' where brand_id = %L$$, $$update public.social_accounts set connection_status = 'identity_verified' where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (5, 'authorization pending', $$update public.social_accounts set connection_status = 'authorization_pending' where brand_id = %L$$, $$update public.social_accounts set connection_status = 'identity_verified' where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (6, 'connected, identity not verified', $$update public.social_accounts set connection_status = 'connected' where brand_id = %L$$, $$update public.social_accounts set connection_status = 'identity_verified' where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (7, 'connection failed', $$update public.social_accounts set connection_status = 'failed' where brand_id = %L$$, $$update public.social_accounts set connection_status = 'identity_verified' where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (8, 'platform user id null', $$update public.social_accounts set platform_user_id = null where brand_id = %L$$, $$update public.social_accounts set platform_user_id = 'x_main' where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (9, 'platform user id empty', $$update public.social_accounts set platform_user_id = '' where brand_id = %L$$, $$update public.social_accounts set platform_user_id = 'x_main' where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (10, 'platform user id whitespace', $$update public.social_accounts set platform_user_id = '   ' where brand_id = %L$$, $$update public.social_accounts set platform_user_id = 'x_main' where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (11, 'verified_at missing', $$update public.social_accounts set verified_at = null where brand_id = %L$$, $$update public.social_accounts set verified_at = now() where brand_id = %L$$, 'CONNECTION_NOT_VERIFIED', 'X_ACCOUNT_NOT_VERIFIED'),
  (12, 'access reference missing', $$update public.social_accounts set vault_access_token_secret_id = null where brand_id = %L$$, null, 'CREDENTIALS_MISSING', 'X_CREDENTIAL_NOT_CONFIGURED'),
  (13, 'refresh reference missing', $$update public.social_accounts set vault_refresh_token_secret_id = null where brand_id = %L$$, null, 'CREDENTIALS_MISSING', 'X_CREDENTIAL_NOT_CONFIGURED'),
  (14, 'access and refresh are the same reference', $$update public.social_accounts set vault_refresh_token_secret_id = vault_access_token_secret_id where brand_id = %L$$, null, 'CREDENTIALS_INVALID', 'X_CREDENTIAL_NOT_CONFIGURED'),
  (15, 'a reference shared with another account', $$update public.social_accounts set vault_access_token_secret_id = (select vault_refresh_token_secret_id from public.social_accounts where id = 'sa_other') where brand_id = %L$$, null, 'CREDENTIALS_INVALID', 'X_REFRESH_SECRET_REF_SHARED'),
  (16, 'connection error recorded', $$update public.social_accounts set last_connection_error_code = 'X_ACCESS_TOKEN_UNAUTHORIZED' where brand_id = %L$$, $$update public.social_accounts set last_connection_error_code = null where brand_id = %L$$, 'CONNECTION_DEGRADED', 'X_ACCOUNT_CONNECTION_DEGRADED'),
  (17, 'refresh state uncertain', $$insert into public.x_account_refresh_state_v2 (social_account_id, status) select id, 'uncertain' from public.social_accounts where brand_id = %L$$, $$delete from public.x_account_refresh_state_v2 where social_account_id in (select id from public.social_accounts where brand_id = %L)$$, 'CONNECTION_DEGRADED', 'X_REFRESH_BLOCKED_UNCERTAIN'),
  (18, 'refresh state reauth required', $$insert into public.x_account_refresh_state_v2 (social_account_id, status) select id, 'reauth_required' from public.social_accounts where brand_id = %L$$, $$delete from public.x_account_refresh_state_v2 where social_account_id in (select id from public.social_accounts where brand_id = %L)$$, 'CONNECTION_DEGRADED', 'X_REFRESH_REAUTH_REQUIRED');

create table public.fixture_saved as
select id, vault_access_token_secret_id as a, vault_refresh_token_secret_id as r from public.social_accounts;

do $$
declare
  c record;
  v_ws text := (select brand_id from public.social_accounts where id = 'sa_main');
  v_owner uuid := '00000000-0000-4000-8000-000000000001';
  v_out jsonb;
  v_post uuid := public.fixture_running_post(v_ws);
  v_runtime text;
begin
  for c in select * from public.fixture_cases order by n loop
    execute format(c.break_sql, v_ws);
    v_out := public.fixture_toggle(v_owner, 'sa_main', true, false);
    if v_out is distinct from jsonb_build_object('status', 'blocked', 'reason', c.reason) then
      raise exception 'FAIL ON with % -> % (expected blocked/%)', c.label, v_out, c.reason;
    end if;
    if (select publish_enabled from public.social_accounts where id = 'sa_main') then
      raise exception 'FAIL ON with % changed the account', c.label;
    end if;
    -- Runtime parity: the same state, forced ON, is refused by the publish path.
    update public.social_accounts set publish_enabled = true where id = 'sa_main';
    v_runtime := public.fixture_permission(v_post, 'sa_main', v_ws);
    update public.social_accounts set publish_enabled = false where id = 'sa_main';
    if v_runtime is distinct from c.runtime then
      raise exception 'FAIL runtime with % -> % (expected %)', c.label, v_runtime, c.runtime;
    end if;
    if c.restore_sql is not null then
      execute format(c.restore_sql, v_ws);
    else
      update public.social_accounts sa set vault_access_token_secret_id = s.a, vault_refresh_token_secret_id = s.r
      from public.fixture_saved s where s.id = sa.id;
    end if;
  end loop;
  -- All restored: eligible again, and the runtime agrees once it is ON.
  v_out := public.fixture_toggle(v_owner, 'sa_main', true, false);
  if v_out is distinct from jsonb_build_object('status', 'updated', 'publish_enabled', true) then
    raise exception 'FAIL an eligible account could not be enabled: %', v_out;
  end if;
  v_runtime := public.fixture_permission(v_post, 'sa_main', v_ws);
  if v_runtime <> 'authorized' then
    raise exception 'FAIL an account enabled by the switch is not publishable: %', v_runtime;
  end if;
end;
$$;
select public.fixture_check(
  (select publish_enabled from public.social_accounts where id = 'sa_main'), 'the eligible account is ON after the loop');

-- A refresh in progress is a transient state: ON answers busy.
select public.fixture_toggle(:'owner', 'sa_main', false, true) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'updated', 'back to OFF');
select id as post from public.scheduled_posts where brand_id = :'ws' and status = 'running' limit 1 \gset
-- A blank recorded error code is no error, for ON and for the publish path alike.
update public.social_accounts set last_connection_error_code = '   ' where id = 'sa_main';
select public.fixture_toggle(:'owner', 'sa_main', true, false) ->> 'status' as s \gset
select public.fixture_permission(:'post', 'sa_main', :'ws') as p \gset
select public.fixture_check(:'s' = 'updated' and :'p' = 'authorized', 'a blank connection error code blocks neither ON nor the send');
select public.fixture_toggle(:'owner', 'sa_main', false, true) ->> 'status' as s \gset
update public.social_accounts set last_connection_error_code = null where id = 'sa_main';
insert into public.x_account_refresh_state_v2
  (social_account_id, status, lease_token, lease_kind, lease_post_id, lease_post_attempt, leased_at)
values ('sa_main', 'refreshing', gen_random_uuid(), 'legacy_post', :'post', 1, now());
select public.fixture_toggle(:'owner', 'sa_main', true, false)::text as r \gset
select public.fixture_check(:'r' = '{"status": "busy"}', 'ON while a refresh lease is held -> busy');
select public.fixture_check(not (select publish_enabled from public.social_accounts where id = 'sa_main'), 'busy changed nothing');
delete from public.x_account_refresh_state_v2 where social_account_id = 'sa_main';

-- ---- 6. OFF is fail-safe ------------------------------------------------------
select public.fixture_toggle(:'owner', 'sa_main', true, false) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'updated', 'ON before degrading');
update public.brands set is_active = false, publish_mode = 'disabled' where id = :'ws';
update public.social_accounts
set connection_status = 'failed', platform_user_id = null, verified_at = null,
    vault_access_token_secret_id = null, vault_refresh_token_secret_id = null,
    last_connection_error_code = 'X_REFRESH_REAUTH_REQUIRED'
where id = 'sa_main';
insert into public.x_account_refresh_state_v2 (social_account_id, status) values ('sa_main', 'reauth_required');
select public.fixture_untouched() as degraded \gset
select public.fixture_toggle(:'member', 'sa_main', false, true)::text as r \gset
select public.fixture_check(:'r' = '{"status": "forbidden"}', 'OFF still needs owner/admin');
select public.fixture_toggle(:'other', 'sa_main', false, true)::text as r \gset
select public.fixture_check(:'r' = '{"status": "not_found"}', 'OFF still needs membership');
select public.fixture_toggle(:'admin', 'sa_main', false, false)::text as r \gset
select public.fixture_check(:'r' = '{"status": "stale", "publish_enabled": true}', 'OFF still needs the expected state');
select public.fixture_toggle(:'admin', 'sa_main', false, true)::text as r \gset
select public.fixture_check(:'r' = '{"status": "updated", "publish_enabled": false}',
  'OFF works with a failed connection, no credentials, an inactive disabled brand and a blocked refresh state');
select public.fixture_check(
  not (select publish_enabled from public.social_accounts where id = 'sa_main')
  and public.fixture_untouched() = :'degraded',
  'OFF revoked, deleted and changed nothing else (connection, references, Vault, posts, logs, history, Auth)');
-- Back ON is conditional: the same account is no longer eligible.
select public.fixture_toggle(:'admin', 'sa_main', true, false) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'blocked', 'turning it back ON is refused until the prerequisites hold again');
delete from public.x_account_refresh_state_v2 where social_account_id = 'sa_main';
update public.brands set is_active = true, publish_mode = 'live' where id = :'ws';
update public.social_accounts sa
set connection_status = 'identity_verified', platform_user_id = 'x_main', verified_at = now(),
    vault_access_token_secret_id = s.a, vault_refresh_token_secret_id = s.r, last_connection_error_code = null
from public.fixture_saved s where s.id = sa.id and sa.id = 'sa_main';

-- A legacy account without Vault references (Kabumori shape): its owner can
-- stop it, but this switch cannot turn it back on.
select public.fixture_toggle(:'kowner', 'kabumori_x', false, true) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'updated', 'legacy account OFF');
select public.fixture_toggle(:'kowner', 'kabumori_x', true, false)::text as r \gset
select public.fixture_check(:'r'::jsonb = '{"status": "blocked", "reason": "CREDENTIALS_MISSING"}'::jsonb, 'legacy account cannot be enabled here');
update public.social_accounts set publish_enabled = true where id = 'kabumori_x';

-- ---- 7. account deletion in progress ------------------------------------------
select public.fixture_toggle(:'owner', 'sa_main', true, false) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'updated', 'ON before the tombstone');
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
values (:'owner', :'ws', 'started', 'social_only', '{}');
select public.fixture_untouched() as tomb \gset
select public.fixture_toggle(:'owner', 'sa_main', false, true)::text as r \gset
select public.fixture_check(:'r' = '{"status": "busy"}', 'OFF during account deletion -> busy (the deletion guard refuses every writer)');
select public.fixture_check(
  (select publish_enabled from public.social_accounts where id = 'sa_main') and public.fixture_untouched() = :'tomb',
  'busy changed nothing');
select public.fixture_permission(:'post', 'sa_main', :'ws') as p \gset
select public.fixture_check(:'p' = 'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS', 'no send is authorized during account deletion');
delete from public.social_mobile_account_deletions where user_id = :'owner';
select public.fixture_toggle(:'owner', 'sa_main', false, true) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'updated', 'OFF after the tombstone is gone');
insert into public.social_mobile_account_deletions (user_id, workspace_id, state, scope, credential_set)
values (:'owner', :'ws', 'started', 'social_only', '{}');
select public.fixture_toggle(:'owner', 'sa_main', true, false)::text as r \gset
select public.fixture_check(:'r' = '{"status": "busy"}', 'ON during account deletion -> busy');
select public.fixture_check(not (select publish_enabled from public.social_accounts where id = 'sa_main'), 'still OFF');
delete from public.social_mobile_account_deletions where user_id = :'owner';

-- ---- 8. the pre-send permission check ------------------------------------------
select public.fixture_toggle(:'owner', 'sa_main', true, false) ->> 'status' as s \gset
select public.fixture_check(:'s' = 'updated', 'ON for the permission checks');
select public.fixture_untouched() as before \gset
select public.fixture_permission(:'post', 'sa_main', :'ws') as p \gset
select public.fixture_check(:'p' = 'authorized', 'eligible running post -> authorized');
select public.fixture_permission(:'post', 'sa_other', :'ws') as p \gset
select public.fixture_check(:'p' = 'X_CLAIM_ACCOUNT_MISMATCH', 'another account -> mismatch');
select public.fixture_permission(:'post', 'sa_main', 'brand_b') as p \gset
select public.fixture_check(:'p' = 'X_LEGACY_POST_NOT_RUNNING', 'another brand -> refused');
select public.fixture_permission(null, 'sa_main', :'ws') as p \gset
select public.fixture_check(:'p' = 'X_CREDENTIAL_REQUEST_INVALID', 'missing post -> invalid');
select public.fixture_permission(gen_random_uuid(), 'sa_main', :'ws') as p \gset
select public.fixture_check(:'p' = 'X_LEGACY_POST_NOT_RUNNING', 'unknown post -> refused');
update public.scheduled_posts set status = 'failed' where id = :'post';
select public.fixture_permission(:'post', 'sa_main', :'ws') as p \gset
select public.fixture_check(:'p' = 'X_LEGACY_POST_NOT_RUNNING', 'a post that is no longer running -> refused');
update public.scheduled_posts set status = 'running' where id = :'post';
-- Stale cached account ON: the owner switched OFF after the dispatcher read it.
select public.fixture_toggle(:'owner', 'sa_main', false, true) ->> 'status' as s \gset
select public.fixture_permission(:'post', 'sa_main', :'ws') as p \gset
select public.fixture_check(:'s' = 'updated' and :'p' = 'X_ACCOUNT_PUBLISH_DISABLED', 'after OFF no new send is authorized');
select public.fixture_toggle(:'owner', 'sa_main', true, false) ->> 'status' as s \gset
-- Stale cached brand context: the brand was disabled after the dispatcher read it.
update public.brands set is_active = false where id = :'ws';
select public.fixture_permission(:'post', 'sa_main', :'ws') as p \gset
select public.fixture_check(:'p' = 'BRAND_DISABLED', 'after a brand disable no new send is authorized');
update public.brands set is_active = true where id = :'ws';
-- A refresh that another attempt is running does not revoke permission.
insert into public.x_account_refresh_state_v2
  (social_account_id, status, lease_token, lease_kind, lease_post_id, lease_post_attempt, leased_at)
values ('sa_main', 'refreshing', gen_random_uuid(), 'legacy_post', :'post', 1, now());
select public.fixture_permission(:'post', 'sa_main', :'ws') as p \gset
select public.fixture_check(:'p' = 'authorized', 'a refresh in progress is not a permission refusal');
delete from public.x_account_refresh_state_v2 where social_account_id = 'sa_main';
-- The legacy Kabumori account never goes through this check's path.
select public.fixture_running_post('kabumori') as kpost \gset
select public.fixture_permission(:'kpost', 'kabumori_x', 'kabumori') as p \gset
select public.fixture_check(:'p' = 'X_CREDENTIAL_NOT_CONFIGURED', 'an account without Vault references is never authorized by this check');
select public.fixture_check(
  (select publish_enabled from public.social_accounts where id = 'sa_main'),
  'the permission check wrote nothing to the account');

-- An app user cannot run the permission check.
do $$
begin
  set local role authenticated;
  begin
    perform public.assert_x_publish_permission_for_legacy_post(gen_random_uuid(), 'sa_main', 'brand_b');
    reset role;
    raise exception 'FAIL authenticated executed the permission check';
  exception when insufficient_privilege then
    reset role;
  end;
end;
$$;
-- The publishing service and anonymous callers cannot run the switch.
do $$
declare r text;
begin
  foreach r in array array['service_role', 'anon'] loop
    execute format('set local role %I', r);
    begin
      perform public.set_social_account_publish_enabled('sa_main', false, true);
      reset role;
      raise exception 'FAIL % executed the switch', r;
    exception when insufficient_privilege then
      reset role;
    end;
  end loop;
end;
$$;

-- ---- 9. isolation level -------------------------------------------------------
begin isolation level repeatable read;
do $$
begin
  perform public.fixture_toggle('00000000-0000-4000-8000-000000000001', 'sa_main', false, true);
  raise exception 'FAIL the switch ran under repeatable read';
exception when sqlstate 'P0001' then
  if sqlerrm <> 'PUBLISH_SETTING_UNAVAILABLE' then raise; end if;
end;
$$;
rollback;
select public.fixture_check(
  (select publish_enabled from public.social_accounts where id = 'sa_main'), 'refused under repeatable read, nothing changed');

drop table public.fixture_cases, public.fixture_saved;
select 'PUBLISH_PERMISSION_BEHAVIOR_PASS';
