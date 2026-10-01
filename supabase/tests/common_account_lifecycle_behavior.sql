-- Behavior proof for the common account lifecycle candidate (Phase 1).
-- Fake data only, disposable database only. The runner applies the fixtures,
-- the real onboarding RPCs, the social-mobile deletion candidate and the
-- candidate under test. Prints COMMON_ACCOUNT_LIFECYCLE_BEHAVIOR_PASS.
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

-- A service_role call (the backend) that returns jsonb.
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

-- An authenticated call (the app, signed in as p_sub) that returns jsonb.
create function pg_temp.usr(p_sub uuid, p_sql text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  execute 'set local role authenticated';
  execute p_sql into v;
  reset role;
  return v;
end;
$$;

create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.ws(p_user uuid) returns text language sql as $$ select 'u_' || substr(md5(p_user::text), 1, 24) $$;
create function pg_temp.start(p_user uuid, p_service text) returns jsonb language sql as $$
  select pg_temp.usr(p_user, format('select public.start_%s_service()', p_service))
$$;
create function pg_temp.eligibility(p_user uuid) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.common_account_deletion_eligibility(%L::uuid)', p_user))
$$;
create function pg_temp.begin_deletion(p_user uuid, p_version bigint default null) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.begin_common_account_deletion(%L::uuid, %s)', p_user,
    coalesce(p_version, (pg_temp.eligibility(p_user) ->> 'lifecycle_version')::bigint)))
$$;
create function pg_temp.prepare(p_user uuid, p_operation text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.prepare_common_account_auth_delete(%L::uuid, %L::uuid)', p_user, p_operation))
$$;
create function pg_temp.checkpoint(p_user uuid, p_operation text, p_checkpoint text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.record_common_account_deletion_checkpoint(%L::uuid, %L::uuid, %L)', p_user, p_operation, p_checkpoint))
$$;
create function pg_temp.withdraw_kabumori(p_user uuid) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', p_user))
$$;
create function pg_temp.entitlement(p_user uuid, p_service text) returns text language sql as $$
  select coalesce((select status from public.service_entitlements where user_id = p_user and service_key = p_service), 'none')
$$;
create function pg_temp.account(p_user uuid) returns text language sql as $$
  select coalesce((select status from public.common_accounts where user_id = p_user), 'none')
$$;
create function pg_temp.version(p_user uuid) returns bigint language sql as $$
  select coalesce((select lifecycle_version from public.common_accounts where user_id = p_user), 0)
$$;
create function pg_temp.login_exists(p_user uuid) returns boolean language sql as $$
  select exists (select 1 from auth.users where id = p_user)
$$;
create function pg_temp.ws_rows(p_user uuid) returns bigint language sql as $$
  select (select count(*) from public.brands where id = pg_temp.ws(p_user))
       + (select count(*) from public.brand_memberships where brand_id = pg_temp.ws(p_user) or user_id = p_user)
       + (select count(*) from public.social_accounts where brand_id = pg_temp.ws(p_user))
       + (select count(*) from public.social_account_oauth_states where brand_id = pg_temp.ws(p_user) or initiated_by_user_id = p_user)
$$;
-- The existing social-mobile deletion saga, exactly as its Edge Function drives
-- it (fake X revoke). Returns the saga's own finalize result.
create function pg_temp.x_saga(p_user uuid, p_scope text) returns jsonb language plpgsql as $$
declare
  v_acquire jsonb;
  v_lease text;
  v_creds jsonb;
  v_revoked jsonb;
begin
  v_acquire := pg_temp.svc(format('select public.social_mobile_account_deletion_acquire(%L::uuid, %L, false)', p_user, p_scope));
  if v_acquire ->> 'status' <> 'acquired' then return v_acquire; end if;
  v_lease := v_acquire ->> 'lease';
  v_creds := pg_temp.svc(format('select public.social_mobile_account_deletion_credentials(%L::uuid, %L::uuid)', p_user, v_lease));
  select coalesce(jsonb_agg(jsonb_build_object('id', a ->> 'id',
           'access_sha256', encode(sha256(convert_to(a ->> 'access_token', 'UTF8')), 'hex'),
           'refresh_sha256', encode(sha256(convert_to(a ->> 'refresh_token', 'UTF8')), 'hex')) order by a ->> 'id'), '[]'::jsonb)
    into v_revoked
    from jsonb_array_elements(v_creds -> 'accounts') a where (a ->> 'revoke_required')::boolean;
  perform pg_temp.svc(format('select public.social_mobile_account_deletion_mark_x_revoked(%L::uuid, %L::uuid, %L::jsonb)', p_user, v_lease, v_revoked));
  perform pg_temp.svc(format('select public.social_mobile_account_deletion_purge(%L::uuid, %L::uuid)', p_user, v_lease));
  return pg_temp.svc(format('select public.social_mobile_account_deletion_finalize(%L::uuid, %L::uuid)', p_user, v_lease));
end;
$$;

-- A login whose account deletion is ready (no service, both checkpoints
-- attested). Returns the operation id.
create function pg_temp.ready_login(p_user uuid) returns text language plpgsql as $$
declare
  v_operation text;
begin
  perform public.fixture_login(p_user);
  v_operation := pg_temp.begin_deletion(p_user, 0) ->> 'operation_id';
  perform pg_temp.checkpoint(p_user, v_operation, 'session_revocation');
  perform pg_temp.checkpoint(p_user, v_operation, 'storage_cleanup');
  if pg_temp.prepare(p_user, v_operation) ->> 'status' is distinct from 'ready_for_managed_auth_delete' then
    raise exception 'FAIL setup: ready login %', p_user;
  end if;
  return v_operation;
end;
$$;
-- "<step>:<last error code>" of an operation, and whether its binding is set.
create function pg_temp.op(p_operation text) returns text language sql as $$
  select current_step || ':' || coalesce(last_error_code, '') || ':' ||
         case when ready_at is null and ready_lifecycle_version is null and ready_requirement_epoch is null
                   and ready_required_checkpoints is null then 'unbound' else 'bound' end
    from private.account_lifecycle_operations where id = p_operation::uuid
$$;
create function pg_temp.authorization_of(p_user uuid) returns jsonb language sql as $$
  select pg_temp.eligibility(p_user) -> 'authorization'
$$;
create function pg_temp.epoch() returns bigint language sql as $$
  select requirement_epoch from private.account_lifecycle_settings
$$;

-- ---------------------------------------------------------------------------
-- 0. The candidate installs in shadow mode, before integration, and backfills
--    nothing by itself.
select pg_temp.expect((select auth_delete_guard = 'shadow' and integration_state = 'not_started' and requirement_epoch = 1
  from private.account_lifecycle_settings),
  'installs in shadow mode, integration not started, requirement epoch 1');
select pg_temp.expect((select array_agg(checkpoint_key || ':' || requirement order by checkpoint_key) from private.account_lifecycle_managed_checkpoints)
  = array['apple_revocation:apple_identity', 'session_revocation:always', 'storage_cleanup:always'], 'built-in managed checkpoints');
select pg_temp.expect((select count(*) from public.common_accounts) = 0 and (select count(*) from public.service_entitlements) = 0,
  'apply creates no account or entitlement row');

-- ---------------------------------------------------------------------------
-- 1. Shadow backfill: dry-run counts, classification, idempotent apply.
--    Population shaped like the production inventory (4 logins) plus the
--    exclusion and no-merge cases.
select public.fixture_login(pg_temp.uid(101), true, true);            -- Kabumori with activity; also the admin
insert into public.admin_users values (pg_temp.uid(101));
select public.fixture_login(pg_temp.uid(102), true, false);           -- profile only
select public.fixture_user_with_workspace(pg_temp.uid(103), 'B103');  -- X self-service owner, identity verified
select public.fixture_login(pg_temp.uid(104));                        -- login only

select pg_temp.expect(private.account_lifecycle_backfill(false) @> jsonb_build_object(
    'applied', false, 'auth_users', 4, 'common_accounts_to_create', 4,
    'kabumori_candidates', 2, 'kabumori_with_activity', 1, 'kabumori_profile_only', 1, 'kabumori_to_create', 2,
    'x_autopost_candidates', 1, 'x_autopost_identity_verified', 1, 'x_autopost_workspace_pending', 0, 'x_autopost_to_create', 1,
    'x_autopost_excluded_admin', 0, 'auth_only', 1, 'admin_users', 1, 'excluded_non_self_service_memberships', 0,
    'created_common_accounts', 0, 'created_kabumori', 0, 'created_x_autopost', 0),
  'dry-run matches the production-shaped population (4 / 2 / 1 / 1)');
select pg_temp.expect((select count(*) from public.common_accounts) = 0 and (select count(*) from public.service_entitlements) = 0,
  'dry-run writes nothing');

-- Exclusions and edge cases.
select public.fixture_user_with_workspace(pg_temp.uid(105), 'B105');  -- shared self-service workspace
select public.fixture_login(pg_temp.uid(106));
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.ws(pg_temp.uid(105)), pg_temp.uid(106), 'member');
select public.fixture_login(pg_temp.uid(107));                        -- member of an internal workspace
insert into public.brand_memberships (brand_id, user_id, role) values ('kabumori', pg_temp.uid(107), 'owner');
select public.fixture_user_with_workspace(pg_temp.uid(108), 'B108');  -- X connect started, never verified
update public.social_accounts set connection_status = 'authorization_pending' where brand_id = pg_temp.ws(pg_temp.uid(108));
select public.fixture_login(pg_temp.uid(109), true, false);           -- two logins sharing one e-mail address
select public.fixture_login(pg_temp.uid(110));
update auth.users set email = 'same@example.test' where id in (pg_temp.uid(109), pg_temp.uid(110));
select public.fixture_user_with_workspace(pg_temp.uid(111), 'B111');  -- workspace whose profile key is not self-service
update public.brands set code_profile_key = 'legacy_v1' where id = pg_temp.ws(pg_temp.uid(111));
-- Mixed role (H1 counterexample 4): an admin who is also the sole owner of a
-- correctly derived, identity-verified self-service workspace, and uses Kabumori.
select public.fixture_user_with_workspace(pg_temp.uid(115), 'B115');
select public.fixture_login(pg_temp.uid(115), true, true);
insert into public.admin_users values (pg_temp.uid(115));

select pg_temp.expect(private.account_lifecycle_backfill(false) @> jsonb_build_object(
    'auth_users', 12, 'common_accounts_to_create', 12,
    'kabumori_candidates', 4, 'kabumori_with_activity', 2, 'kabumori_profile_only', 2,
    'x_autopost_candidates', 2, 'x_autopost_identity_verified', 1, 'x_autopost_workspace_pending', 1,
    'x_autopost_excluded_admin', 1, 'admin_users', 2,
    'auth_only', 6, 'excluded_non_self_service_memberships', 4),
  'dry-run with exclusions: admin, shared, internal and non-self-service workspaces are not consumer X use');

select pg_temp.expect(private.account_lifecycle_backfill(true) @> jsonb_build_object(
    'applied', true, 'created_common_accounts', 12, 'created_kabumori', 4, 'created_x_autopost', 2,
    'skipped_account_not_active', 0),
  'apply creates exactly the planned rows');
select pg_temp.expect((select count(*) from public.common_accounts) = 12
  and (select count(*) from public.common_accounts where status <> 'active') = 0,
  'one active common account per login, no merge');
select pg_temp.expect(not exists (
    select 1 from public.common_accounts c
     where c.lifecycle_version <> 1 + (select count(*) from public.service_entitlements e where e.user_id = c.user_id)),
  'every backfilled entitlement moved its account version: version 1 means "no entitlement ever"');
select pg_temp.expect(
  (select count(*) from public.common_accounts where user_id in (pg_temp.uid(109), pg_temp.uid(110))) = 2
  and pg_temp.entitlement(pg_temp.uid(109), 'kabumori') = 'active'
  and pg_temp.entitlement(pg_temp.uid(110), 'kabumori') = 'none',
  'two logins with the same e-mail stay two accounts; the entitlement is not shared');
select pg_temp.expect(
  (select array_agg(legacy_evidence order by user_id, service_key) from public.service_entitlements)
    = array['kabumori_activity', 'kabumori_profile_only', 'x_identity_verified', 'x_workspace_pending',
            'kabumori_profile_only', 'kabumori_activity']
  and (select count(*) from public.service_entitlements where status <> 'active' or source <> 'legacy_backfill' or activated_at is null) = 0,
  'backfilled entitlements are active, marked legacy, and carry their evidence');
select pg_temp.expect(
  pg_temp.entitlement(pg_temp.uid(101), 'x_autopost') = 'none'      -- admin without a workspace
  and pg_temp.entitlement(pg_temp.uid(105), 'x_autopost') = 'none'  -- shared workspace
  and pg_temp.entitlement(pg_temp.uid(106), 'x_autopost') = 'none'
  and pg_temp.entitlement(pg_temp.uid(107), 'x_autopost') = 'none'  -- internal workspace
  and pg_temp.entitlement(pg_temp.uid(111), 'x_autopost') = 'none'  -- not self-service
  and pg_temp.entitlement(pg_temp.uid(104), 'kabumori') = 'none',   -- login only
  'shared, internal, non-self-service and login-only users get no entitlement');
select pg_temp.expect(
  pg_temp.entitlement(pg_temp.uid(115), 'x_autopost') = 'none'
  and pg_temp.entitlement(pg_temp.uid(115), 'kabumori') = 'active',
  'H1-4: an admin who owns a self-service workspace gets no consumer X entitlement; Kabumori follows its own rule');
select pg_temp.expect(private.account_lifecycle_backfill(true) @> jsonb_build_object(
    'common_accounts_to_create', 0, 'kabumori_to_create', 0, 'x_autopost_to_create', 0,
    'created_common_accounts', 0, 'created_kabumori', 0, 'created_x_autopost', 0),
  'second apply is a no-op');

-- A self-registered entitlement is never rewritten; a non-active account gains nothing.
select public.fixture_login(pg_temp.uid(112));
select pg_temp.start(pg_temp.uid(112), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'active', 'self-service start before backfill');
select public.fixture_login(pg_temp.uid(113), true, false);
insert into public.common_accounts (user_id, status) values (pg_temp.uid(113), 'locked');
select private.account_lifecycle_backfill(true) as r \gset
select pg_temp.expect(:'r'::jsonb @> jsonb_build_object('created_common_accounts', 0, 'created_kabumori', 0, 'skipped_account_not_active', 1),
  'backfill skips a non-active account and an existing entitlement');
select pg_temp.expect((select source from public.service_entitlements where user_id = pg_temp.uid(112) and service_key = 'kabumori') = 'self_service'
  and pg_temp.entitlement(pg_temp.uid(113), 'kabumori') = 'none', 'existing rows untouched by backfill');
-- An existing account that gains an entitlement moves its lifecycle version.
select public.fixture_login(pg_temp.uid(114));
insert into public.common_accounts (user_id) values (pg_temp.uid(114));
insert into public.profiles (id) values (pg_temp.uid(114));
select private.account_lifecycle_backfill(true) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'created_kabumori' = '1' and pg_temp.version(pg_temp.uid(114)) = 2,
  'backfill bumps the version of an existing account it changes');

-- H1 counterexample 2: a confirmation taken while no account row existed must
-- not survive a backfill that introduces a service.
select public.fixture_login(pg_temp.uid(116));
select pg_temp.eligibility(pg_temp.uid(116)) as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"account_status":"none","lifecycle_version":0,"services":[],"blockers":[]}'::jsonb,
  'an absent account previews as version 0');
insert into public.profiles (id) values (pg_temp.uid(116));
select private.account_lifecycle_backfill(true) as r \gset
select pg_temp.expect(pg_temp.entitlement(pg_temp.uid(116), 'kabumori') = 'active' and pg_temp.version(pg_temp.uid(116)) = 2,
  'backfill created the account and its entitlement at version 2');
select pg_temp.begin_deletion(pg_temp.uid(116), 0) as r0 \gset
select pg_temp.begin_deletion(pg_temp.uid(116), 1) as r1 \gset
select pg_temp.expect(:'r0'::jsonb = '{"status":"lifecycle_changed","lifecycle_version":2}'::jsonb
  and :'r1'::jsonb = '{"status":"lifecycle_changed","lifecycle_version":2}'::jsonb
  and pg_temp.account(pg_temp.uid(116)) = 'active'
  and not exists (select 1 from private.account_lifecycle_operations where user_id = pg_temp.uid(116)),
  'H1-2: the empty preview (0, or the old 1) is rejected after backfill added a service');
-- 0 never matches a row, even a fresh one with no entitlement.
select public.fixture_login(pg_temp.uid(117), true, false);
select pg_temp.begin_deletion(pg_temp.uid(117), 0) as r \gset
select pg_temp.expect(:'r'::jsonb -> 'reasons' = '["UNREGISTERED_SERVICE_FOOTPRINT"]'::jsonb and pg_temp.version(pg_temp.uid(117)) = 1,
  'begin on an absent account creates the row; a blocker leaves it at version 1');
select pg_temp.begin_deletion(pg_temp.uid(117), 0) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"lifecycle_changed","lifecycle_version":1}'::jsonb,
  'version 0 is not valid once any row exists');
-- A direct operator change of state or entitlement also invalidates a preview.
update public.common_accounts set status = 'locked' where user_id = pg_temp.uid(117);
select pg_temp.expect(pg_temp.version(pg_temp.uid(117)) = 2, 'an operator state change moves the version');
update public.common_accounts set status = 'active' where user_id = pg_temp.uid(117);
insert into public.service_entitlements (user_id, service_key, status, source, activated_at)
values (pg_temp.uid(117), 'kabumori', 'active', 'operator', now());
select pg_temp.expect(pg_temp.version(pg_temp.uid(117)) = 4, 'an operator-inserted entitlement moves the version');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update public.common_accounts set lifecycle_version = 1 where user_id = %L', pg_temp.uid(117)))
  like '%ACCOUNT_LIFECYCLE_VERSION_CANNOT_DECREASE%', 'the version can never go back');

-- ---------------------------------------------------------------------------
-- 2. ACL / RLS least privilege.
select pg_temp.expect(pg_temp.error_as('anon', format('select public.%s', f)) like '%permission denied%', 'anon ' || f)
from unnest(array['start_kabumori_service()', 'start_x_autopost_service()',
                  'common_account_deletion_eligibility(gen_random_uuid())',
                  'begin_common_account_deletion(gen_random_uuid(), 0)',
                  'prepare_common_account_auth_delete(gen_random_uuid(), gen_random_uuid())',
                  'withdraw_kabumori_service(gen_random_uuid())']) f;
select pg_temp.expect(pg_temp.error_as('authenticated', format('select public.%s', f), pg_temp.uid(102)) like '%permission denied%', 'authenticated ' || f)
from unnest(array['common_account_deletion_eligibility(gen_random_uuid())',
                  'begin_service_deletion(gen_random_uuid(), ''kabumori'')',
                  'finish_service_deletion(gen_random_uuid(), ''kabumori'', gen_random_uuid())',
                  'abort_service_deletion(gen_random_uuid(), ''kabumori'', gen_random_uuid())',
                  'withdraw_kabumori_service(gen_random_uuid())',
                  'begin_common_account_deletion(gen_random_uuid(), 0)',
                  'record_common_account_deletion_checkpoint(gen_random_uuid(), gen_random_uuid(), ''storage_cleanup'')',
                  'clear_common_account_deletion_checkpoint(gen_random_uuid(), gen_random_uuid(), ''storage_cleanup'')',
                  'abort_common_account_deletion(gen_random_uuid(), gen_random_uuid())',
                  'prepare_common_account_auth_delete(gen_random_uuid(), gen_random_uuid())']) f;
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.%s', f)) like '%permission denied%', 'service_role ' || f)
from unnest(array['start_kabumori_service()', 'start_x_autopost_service()']) f;
select pg_temp.expect(pg_temp.error_as(r, format('select private.%s', f)) like '%permission denied%', r || ' helper ' || f)
from unnest(array['anon', 'authenticated', 'service_role']) r,
     unnest(array['account_lifecycle_lock(gen_random_uuid(), true, false)',
                  'account_lifecycle_invalidate_readiness(null, ''X'')',
                  'account_lifecycle_builtin_checkpoints()',
                  'account_lifecycle_requirements_valid()',
                  'account_lifecycle_readiness_refusal(gen_random_uuid(), ''{}''::jsonb)',
                  'account_lifecycle_authorization_problems(gen_random_uuid(), gen_random_uuid())',
                  'account_lifecycle_footprint(gen_random_uuid())',
                  'account_lifecycle_deletion_blockers(gen_random_uuid(), ''active'')',
                  'account_lifecycle_managed_ownership(gen_random_uuid())',
                  'account_lifecycle_required_checkpoints(gen_random_uuid())',
                  'account_lifecycle_start_service(gen_random_uuid(), ''kabumori'')',
                  'account_lifecycle_backfill(true)']) f;
select pg_temp.expect(pg_temp.error_as(r, format('select count(*) from private.%s', t)) like '%permission denied%', r || ' reads private.' || t)
from unnest(array['anon', 'authenticated', 'service_role']) r,
     unnest(array['account_lifecycle_operations', 'account_lifecycle_settings', 'account_lifecycle_managed_checkpoints',
                  'account_lifecycle_backfill_plan']) t;
select pg_temp.expect(pg_temp.error_as(r, format('select count(*) from public.%s', t)) like '%permission denied%', r || ' reads public.' || t)
from unnest(array['anon', 'service_role']) r, unnest(array['common_accounts', 'service_entitlements']) t;
-- No table privilege beyond the client's column-limited SELECT; in particular
-- no TRUNCATE / REFERENCES / TRIGGER left over from default grants.
select pg_temp.expect(not exists (
    select 1 from information_schema.role_table_grants
     where table_schema in ('public', 'private')
       and table_name in ('common_accounts', 'service_entitlements', 'account_lifecycle_operations',
                          'account_lifecycle_settings', 'account_lifecycle_managed_checkpoints',
                          'account_lifecycle_backfill_plan')
       and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')),
  'no table-level privilege for any client role on the new tables');
select pg_temp.expect(
  (select array_agg(table_name || '.' || column_name order by table_name, column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name in ('common_accounts', 'service_entitlements')
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
      and not (grantee = 'authenticated' and privilege_type = 'SELECT')) is null,
  'the only column privilege is SELECT for authenticated');
select pg_temp.expect(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and (p.proname like 'account\_lifecycle\_%' or p.proname in (
           'start_kabumori_service', 'start_x_autopost_service', 'common_account_deletion_eligibility',
           'begin_service_deletion', 'finish_service_deletion', 'abort_service_deletion', 'withdraw_kabumori_service',
           'begin_common_account_deletion', 'record_common_account_deletion_checkpoint',
            'clear_common_account_deletion_checkpoint', 'abort_common_account_deletion',
           'prepare_common_account_auth_delete'))) = 33
  and not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and (p.proname like 'account\_lifecycle\_%' or p.proname in (
            'start_kabumori_service', 'start_x_autopost_service', 'common_account_deletion_eligibility',
            'begin_service_deletion', 'finish_service_deletion', 'abort_service_deletion', 'withdraw_kabumori_service',
            'begin_common_account_deletion', 'record_common_account_deletion_checkpoint',
            'clear_common_account_deletion_checkpoint', 'abort_common_account_deletion',
            'prepare_common_account_auth_delete'))
       and (has_function_privilege('anon', p.oid, 'execute')
            or p.proacl is null
            or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
            or not p.prosecdef
            or p.proconfig is distinct from array['search_path=""'])),
  'all 33 candidate functions: SECURITY DEFINER, empty search_path, no PUBLIC or anon EXECUTE');
select pg_temp.expect((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('start_kabumori_service', 'start_x_autopost_service') and p.pronargs = 0) = 2,
  'start RPCs take no argument: the person is auth.uid() only');
select pg_temp.expect((select bool_and(c.relrowsecurity) from pg_class c
   where c.oid in ('public.common_accounts'::regclass, 'public.service_entitlements'::regclass,
                   'private.account_lifecycle_operations'::regclass, 'private.account_lifecycle_settings'::regclass,
                   'private.account_lifecycle_managed_checkpoints'::regclass)),
  'RLS enabled on every new table');
-- A client reads only its own rows and only the granted columns, and writes nothing.
select pg_temp.expect(pg_temp.usr(pg_temp.uid(102), 'select to_jsonb(array_agg(user_id)) from public.common_accounts') = to_jsonb(array[pg_temp.uid(102)]),
  'RLS: own common account only');
select pg_temp.expect(pg_temp.usr(pg_temp.uid(102), 'select to_jsonb(array_agg(user_id)) from public.service_entitlements') = to_jsonb(array[pg_temp.uid(102)]),
  'RLS: own entitlements only');
select pg_temp.expect(pg_temp.usr(pg_temp.uid(104), 'select to_jsonb(count(*)) from public.service_entitlements') = '0'::jsonb,
  'RLS: nothing of other people');
select pg_temp.expect(pg_temp.error_as('authenticated', 'select source from public.service_entitlements', pg_temp.uid(102)) like '%permission denied%',
  'internal classification columns are not client-readable');
select pg_temp.expect(pg_temp.error_as('authenticated', s, pg_temp.uid(104)) like '%permission denied%', 'client write refused: ' || s)
from unnest(array[
  format('insert into public.common_accounts (user_id) values (%L)', pg_temp.uid(104)),
  format('update public.common_accounts set status = ''active'' where user_id = %L', pg_temp.uid(104)),
  format('delete from public.common_accounts where user_id = %L', pg_temp.uid(104)),
  format('insert into public.service_entitlements (user_id, service_key, status, source, activated_at) values (%L, ''x_autopost'', ''active'', ''self_service'', now())', pg_temp.uid(104)),
  format('update public.service_entitlements set status = ''active'' where user_id = %L', pg_temp.uid(102)),
  format('delete from public.service_entitlements where user_id = %L', pg_temp.uid(102)),
  'truncate public.service_entitlements']) s;

-- ---------------------------------------------------------------------------
-- 3. Service start (I2). Each call's result is captured first (\gset) and
--    asserted in a following statement, so every check reads committed state.
select public.fixture_login(pg_temp.uid(201));
select pg_temp.start(pg_temp.uid(201), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"active","service":"kabumori","started":true}'::jsonb, 'first Kabumori start');
select pg_temp.expect(pg_temp.account(pg_temp.uid(201)) = 'active' and pg_temp.version(pg_temp.uid(201)) = 2
  and exists (select 1 from public.profiles where id = pg_temp.uid(201))
  and (select source from public.service_entitlements where user_id = pg_temp.uid(201) and service_key = 'kabumori') = 'self_service',
  'start creates the account, the entitlement and the Kabumori root together');
select pg_temp.start(pg_temp.uid(201), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'started' = 'false' and pg_temp.version(pg_temp.uid(201)) = 2, 'start is idempotent');
select pg_temp.start(pg_temp.uid(201), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'started' = 'true' and pg_temp.version(pg_temp.uid(201)) = 3
  and pg_temp.entitlement(pg_temp.uid(201), 'x_autopost') = 'active' and pg_temp.ws_rows(pg_temp.uid(201)) = 0,
  'X start registers the entitlement only; the workspace is still created by the existing connect RPC');
select coalesce(pg_temp.error_as('authenticated', 'select public.start_kabumori_service()'), '') as e \gset
select pg_temp.expect(:'e' like '%ACCOUNT_LIFECYCLE_AUTH_REQUIRED%', 'start without a subject is refused');
select coalesce(pg_temp.error_as('authenticated', 'select public.start_kabumori_service()', pg_temp.uid(999)), '') as e \gset
select pg_temp.expect(:'e' like '%ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND%'
  and not exists (select 1 from public.profiles where id = pg_temp.uid(999))
  and pg_temp.account(pg_temp.uid(999)) = 'none',
  'a token whose login does not exist cannot start a service');

-- ---------------------------------------------------------------------------
-- 4. Whole-account deletion: deleting blocks every start; the last database
--    step is "ready", and the login is never deleted here (I2, I4).
select public.fixture_login(pg_temp.uid(301), true, true);
select pg_temp.start(pg_temp.uid(301), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'active', '301 registered');
select pg_temp.expect(pg_temp.eligibility(pg_temp.uid(301)) @> '{"account_status":"active","lifecycle_version":2,"blockers":[],"managed_ownership":[],"required_checkpoints":["session_revocation","storage_cleanup"],"services":[{"service_key":"kabumori","status":"active"}],"operation":null,"authorization":{"state":"none"}}'::jsonb,
  'eligibility read model');
select pg_temp.begin_deletion(pg_temp.uid(301), 1) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"lifecycle_changed","lifecycle_version":2}'::jsonb
  and pg_temp.account(pg_temp.uid(301)) = 'active', 'begin against a stale version changes nothing');
select pg_temp.begin_deletion(pg_temp.uid(301), 2) as r \gset
select :'r'::jsonb ->> 'operation_id' as op301 \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"started","services_to_end":["kabumori"],"required_checkpoints":["session_revocation","storage_cleanup"],"lifecycle_version":3}'::jsonb
  and pg_temp.account(pg_temp.uid(301)) = 'deleting', 'deletion begun');
select pg_temp.begin_deletion(pg_temp.uid(301), 3) as r \gset
select pg_temp.expect(:'r'::jsonb @> jsonb_build_object('status', 'in_progress', 'operation_id', :'op301'), 'begin is idempotent: same operation');
select pg_temp.start(pg_temp.uid(301), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"ACCOUNT_DELETION_IN_PROGRESS"}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(301), 'x_autopost') = 'none', 'no service can start while the account is deleting');
select pg_temp.start(pg_temp.uid(301), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'ACCOUNT_DELETION_IN_PROGRESS', 'not even the one already active');
select pg_temp.prepare(pg_temp.uid(301), :'op301') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_ready","reason":"SERVICES_REMAIN","services":["kabumori"],"next_steps":["end_remaining_services"]}'::jsonb,
  'not ready while an active service remains');
select pg_temp.prepare(pg_temp.uid(301), gen_random_uuid()::text) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'not_found', 'prepare needs the real operation');
select pg_temp.withdraw_kabumori(pg_temp.uid(301)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb
  and not exists (select 1 from public.profiles where id = pg_temp.uid(301))
  and not exists (select 1 from public.tracked_stocks where user_id = pg_temp.uid(301))
  and not exists (select 1 from public.device_push_tokens where user_id = pg_temp.uid(301))
  and pg_temp.login_exists(pg_temp.uid(301)),
  'Kabumori withdrawal removes the Kabumori data and nothing else');
select pg_temp.prepare(pg_temp.uid(301), :'op301') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"not_ready","reason":"MANAGED_CHECKPOINTS_MISSING","missing_checkpoints":["session_revocation","storage_cleanup"]}'::jsonb,
  'not ready until the managed cleanups are attested');
select coalesce(pg_temp.error_as('service_role', format('select public.record_common_account_deletion_checkpoint(%L::uuid, %L::uuid, ''made_up'')', pg_temp.uid(301), :'op301')), '') as e \gset
select pg_temp.expect(:'e' like '%ACCOUNT_LIFECYCLE_CHECKPOINT_INVALID%', 'an unknown checkpoint is refused');
select pg_temp.checkpoint(pg_temp.uid(301), :'op301', 'session_revocation') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"recorded","checkpoint":"session_revocation"}'::jsonb, 'checkpoint recorded');
select pg_temp.prepare(pg_temp.uid(301), :'op301') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'missing_checkpoints' = '["storage_cleanup"]'::jsonb, 'still one checkpoint missing');
select pg_temp.checkpoint(pg_temp.uid(301), :'op301', 'storage_cleanup') as r \gset
select pg_temp.prepare(pg_temp.uid(301), :'op301') as r \gset
select pg_temp.expect(:'r'::jsonb = jsonb_build_object('status', 'ready_for_managed_auth_delete', 'operation_id', :'op301', 'login_deleted', false,
    'authorization', jsonb_build_object('lifecycle_version', pg_temp.version(pg_temp.uid(301)), 'requirement_epoch', pg_temp.epoch(),
      'required_checkpoints', jsonb_build_array('session_revocation', 'storage_cleanup')),
    'next_steps', jsonb_build_array('revalidate_managed_ownership', 'managed_auth_admin_delete', 'post_delete_read_back_and_audit')),
  'ready: an authorization bound to version, epoch and required checkpoints, and what is next');
select pg_temp.expect(pg_temp.op(:'op301') = 'ready_for_managed_auth_delete::bound'
  and pg_temp.authorization_of(pg_temp.uid(301)) @> '{"state":"valid","required_checkpoints":["session_revocation","storage_cleanup"]}'::jsonb,
  'the authorization is durable on the operation and reads as valid');
-- H1 counterexample 1, first half: Phase 1 never deletes the login and has no
-- "completed" state for an account deletion.
select pg_temp.expect(pg_temp.login_exists(pg_temp.uid(301)) and pg_temp.account(pg_temp.uid(301)) = 'deleting'
  and (select status = 'in_progress' and current_step = 'ready_for_managed_auth_delete' and ready_at is not null and finished_at is null
         from private.account_lifecycle_operations where id = :'op301'::uuid),
  'H1-1: ready is not deleted: the login and the account row are still there, the operation is still open');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'', finished_at = now() where id = %L', :'op301'))
  like '%violates check constraint%', 'H1-1: an account deletion cannot be recorded as completed at all');
select pg_temp.eligibility(pg_temp.uid(301)) -> 'operation' as r \gset
select pg_temp.expect(:'r'::jsonb = jsonb_build_object('operation_id', :'op301', 'step', 'ready_for_managed_auth_delete',
    'recorded_checkpoints', jsonb_build_array('session_revocation', 'storage_cleanup')), 'the read model shows the open operation');
select pg_temp.start(pg_temp.uid(301), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'ACCOUNT_DELETION_IN_PROGRESS', 'still no start while ready');
select pg_temp.prepare(pg_temp.uid(301), :'op301') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete', 'prepare is idempotent');
-- Abort from ready returns the account to active; the ended service stays ended.
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(301), :'op301')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"aborted"}'::jsonb and pg_temp.account(pg_temp.uid(301)) = 'active'
  and pg_temp.entitlement(pg_temp.uid(301), 'kabumori') = 'ended' and pg_temp.login_exists(pg_temp.uid(301)), 'abort from ready');
select pg_temp.prepare(pg_temp.uid(301), :'op301') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_ready","reason":"ACCOUNT_DELETION_NOT_IN_PROGRESS"}'::jsonb, 'an aborted operation can never become ready');
select pg_temp.start(pg_temp.uid(301), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'started' = 'true', 'services can start again after abort');

-- Not ready with a reserved state or a service being deleted.
select public.fixture_login(pg_temp.uid(302));
select pg_temp.start(pg_temp.uid(302), 'x_autopost') as r \gset
select pg_temp.begin_deletion(pg_temp.uid(302)) ->> 'operation_id' as op302 \gset
update public.service_entitlements set status = 'provisioning' where user_id = pg_temp.uid(302);
select pg_temp.prepare(pg_temp.uid(302), :'op302') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"not_ready","reason":"SERVICES_REMAIN"}'::jsonb, 'not ready while a provisioning service remains');
update public.service_entitlements set status = 'deleting' where user_id = pg_temp.uid(302);
select pg_temp.prepare(pg_temp.uid(302), :'op302') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'SERVICES_REMAIN', 'not ready while a service is still being deleted');
update public.service_entitlements set status = 'active' where user_id = pg_temp.uid(302);
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(302), :'op302')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"aborted"}'::jsonb and pg_temp.account(pg_temp.uid(302)) = 'active', 'abort before ready');

-- A person with no service at all: begin from the absent state (version 0).
select public.fixture_login(pg_temp.uid(303));
select pg_temp.begin_deletion(pg_temp.uid(303), 0) as r \gset
select :'r'::jsonb ->> 'operation_id' as op303 \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"started","services_to_end":[],"lifecycle_version":2}'::jsonb, 'begin from the absent state');
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(303), :'op303')) as r \gset

-- ---------------------------------------------------------------------------
-- 5. Service-only deletion leaves the other service and the login intact (I3).
select public.fixture_user_with_workspace(pg_temp.uid(401), 'S401');
select public.fixture_login(pg_temp.uid(401), true, true);
select pg_temp.start(pg_temp.uid(401), 'kabumori') as r1 \gset
select pg_temp.start(pg_temp.uid(401), 'x_autopost') as r2 \gset
select pg_temp.expect(:'r1'::jsonb ->> 'status' = 'active' and :'r2'::jsonb ->> 'status' = 'active', '401 uses both services');
select pg_temp.ws_rows(pg_temp.uid(401)) as ws401 \gset
select pg_temp.withdraw_kabumori(pg_temp.uid(401)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb, 'Kabumori-only withdrawal');
select pg_temp.expect(pg_temp.login_exists(pg_temp.uid(401)) and pg_temp.account(pg_temp.uid(401)) = 'active'
  and pg_temp.entitlement(pg_temp.uid(401), 'kabumori') = 'ended' and pg_temp.entitlement(pg_temp.uid(401), 'x_autopost') = 'active'
  and pg_temp.ws_rows(pg_temp.uid(401)) = :ws401 and :ws401 > 0
  and not exists (select 1 from public.profiles where id = pg_temp.uid(401)),
  'login, X entitlement and X workspace untouched by Kabumori withdrawal');
select pg_temp.withdraw_kabumori(pg_temp.uid(401)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"already_ended"}'::jsonb, 'withdrawal is idempotent');
select pg_temp.start(pg_temp.uid(401), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'started' = 'true'
  and exists (select 1 from public.profiles where id = pg_temp.uid(401))
  and (select ended_at is null and source = 'self_service' from public.service_entitlements where user_id = pg_temp.uid(401) and service_key = 'kabumori'),
  'the same person can register again after withdrawing');

-- X-only deletion around the existing social-mobile saga (adapter contract).
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', pg_temp.uid(401))) as r \gset
select :'r'::jsonb ->> 'operation_id' as op401x \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'started' and pg_temp.entitlement(pg_temp.uid(401), 'x_autopost') = 'deleting', 'X deletion begun');
select pg_temp.start(pg_temp.uid(401), 'x_autopost') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"SERVICE_DELETION_IN_PROGRESS"}'::jsonb, 'X start is refused while X is being deleted');
select pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', pg_temp.uid(401), :'op401x')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_ready","reason":"SERVICE_FOOTPRINT_REMAINS"}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(401), 'x_autopost') = 'deleting', 'the entitlement cannot end while the workspace still exists');
select pg_temp.x_saga(pg_temp.uid(401), 'social_only') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"completed","login_deleted":false}'::jsonb and pg_temp.ws_rows(pg_temp.uid(401)) = 0,
  'existing social-mobile saga removes the workspace and keeps the login');
select pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', pg_temp.uid(401), :'op401x')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb and pg_temp.entitlement(pg_temp.uid(401), 'x_autopost') = 'ended', 'X entitlement ends after its cleanup');
select pg_temp.expect(pg_temp.login_exists(pg_temp.uid(401)) and pg_temp.account(pg_temp.uid(401)) = 'active'
  and pg_temp.entitlement(pg_temp.uid(401), 'kabumori') = 'active' and exists (select 1 from public.profiles where id = pg_temp.uid(401)),
  'login and Kabumori untouched by X-only deletion');

-- A cancelled service deletion returns to active.
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''kabumori'')', pg_temp.uid(401))) ->> 'operation_id' as op401k \gset
select pg_temp.svc(format('select public.abort_service_deletion(%L::uuid, ''kabumori'', %L::uuid)', pg_temp.uid(401), :'op401k')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"aborted"}'::jsonb and pg_temp.entitlement(pg_temp.uid(401), 'kabumori') = 'active'
  and exists (select 1 from public.profiles where id = pg_temp.uid(401)), 'abort of a service deletion');
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''kabumori'')', pg_temp.uid(104))) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_registered"}'::jsonb, 'nothing to delete for a person who never used the service');

-- Whole-account deletion of a person using both services, in the order the
-- future orchestrator must use while the legacy X scope rule still exists
-- (X first, while the Kabumori profile keeps its scope at social_only). It
-- ends at "ready"; the login is still there.
select public.fixture_user_with_workspace(pg_temp.uid(402), 'S402');
select public.fixture_login(pg_temp.uid(402), true, true);
select pg_temp.start(pg_temp.uid(402), 'kabumori') as r1 \gset
select pg_temp.start(pg_temp.uid(402), 'x_autopost') as r2 \gset
select pg_temp.begin_deletion(pg_temp.uid(402)) as r \gset
select :'r'::jsonb ->> 'operation_id' as op402 \gset
select pg_temp.expect(:'r'::jsonb -> 'services_to_end' = '["kabumori","x_autopost"]'::jsonb, '402: both services must end first');
select pg_temp.prepare(pg_temp.uid(402), :'op402') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'services' = '["kabumori","x_autopost"]'::jsonb, '402: not ready with both');
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', pg_temp.uid(402))) ->> 'operation_id' as op402x \gset
select pg_temp.x_saga(pg_temp.uid(402), 'social_only') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"completed","login_deleted":false}'::jsonb, '402 X cleanup');
select pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', pg_temp.uid(402), :'op402x')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb, '402 X ended');
select pg_temp.prepare(pg_temp.uid(402), :'op402') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'services' = '["kabumori"]'::jsonb, '402: still one service left');
select pg_temp.withdraw_kabumori(pg_temp.uid(402)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb, '402 Kabumori ended');
select pg_temp.checkpoint(pg_temp.uid(402), :'op402', 'session_revocation') as r1 \gset
select pg_temp.checkpoint(pg_temp.uid(402), :'op402', 'storage_cleanup') as r2 \gset
select pg_temp.prepare(pg_temp.uid(402), :'op402') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete' and :'r'::jsonb ->> 'login_deleted' = 'false'
  and pg_temp.login_exists(pg_temp.uid(402)) and pg_temp.ws_rows(pg_temp.uid(402)) = 0
  and not exists (select 1 from public.profiles where id = pg_temp.uid(402)),
  'both services ended and attested: ready, with no service row left and the login untouched');

-- ---------------------------------------------------------------------------
-- 6. Fail closed: admin, shared / internal workspace, unregistered data,
--    reserved states, locked account (I5).
select pg_temp.begin_deletion(pg_temp.uid(101)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reasons":["ADMIN_ACCOUNT"]}'::jsonb
  and pg_temp.account(pg_temp.uid(101)) = 'active', 'an admin account cannot be deleted through this path');
select pg_temp.expect(pg_temp.eligibility(pg_temp.uid(101)) -> 'blockers' = '["ADMIN_ACCOUNT"]'::jsonb, 'eligibility reports the same blocker');
select pg_temp.begin_deletion(pg_temp.uid(105)) -> 'reasons' as r105 \gset
select pg_temp.begin_deletion(pg_temp.uid(106)) -> 'reasons' as r106 \gset
select pg_temp.begin_deletion(pg_temp.uid(107)) -> 'reasons' as r107 \gset
select pg_temp.begin_deletion(pg_temp.uid(111)) -> 'reasons' as r111 \gset
select pg_temp.begin_deletion(pg_temp.uid(115)) -> 'reasons' as r115 \gset
select pg_temp.expect(:'r105'::jsonb = '["X_WORKSPACE_NOT_SELF_SERVICE", "UNREGISTERED_SERVICE_FOOTPRINT"]'::jsonb, 'owner of a shared workspace');
select pg_temp.expect(:'r106'::jsonb = '["X_WORKSPACE_NOT_SELF_SERVICE"]'::jsonb, 'member of someone else''s workspace');
select pg_temp.expect(:'r107'::jsonb = '["X_WORKSPACE_NOT_SELF_SERVICE"]'::jsonb, 'member of an internal workspace');
select pg_temp.expect(:'r111'::jsonb = '["X_WORKSPACE_NOT_SELF_SERVICE", "UNREGISTERED_SERVICE_FOOTPRINT"]'::jsonb, 'workspace that is not self-service');
select pg_temp.expect(:'r115'::jsonb = '["ADMIN_ACCOUNT", "UNREGISTERED_SERVICE_FOOTPRINT"]'::jsonb, 'admin who owns a self-service workspace');
select pg_temp.expect((select count(*) from public.common_accounts where user_id in (pg_temp.uid(105), pg_temp.uid(106), pg_temp.uid(107), pg_temp.uid(111), pg_temp.uid(115)) and status = 'active') = 5
  and not exists (select 1 from private.account_lifecycle_operations where user_id in (pg_temp.uid(101), pg_temp.uid(105), pg_temp.uid(106), pg_temp.uid(107), pg_temp.uid(111), pg_temp.uid(115))),
  'blocked: no state change, no operation');
-- An admin may still stop using Kabumori: only Kabumori data goes.
select pg_temp.withdraw_kabumori(pg_temp.uid(101)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb and pg_temp.login_exists(pg_temp.uid(101))
  and exists (select 1 from public.admin_users where user_id = pg_temp.uid(101))
  and not exists (select 1 from public.profiles where id = pg_temp.uid(101)),
  'service-only withdrawal by an admin keeps the login and the admin membership');
-- Service data that no entitlement accounts for (a legacy creator ran after the backfill).
select public.fixture_login(pg_temp.uid(601), true, false);
select pg_temp.begin_deletion(pg_temp.uid(601)) -> 'reasons' as r1 \gset
select pg_temp.withdraw_kabumori(pg_temp.uid(601)) as r2 \gset
select pg_temp.expect(:'r1'::jsonb = '["UNREGISTERED_SERVICE_FOOTPRINT"]'::jsonb
  and :'r2'::jsonb = '{"status":"blocked","reason":"UNREGISTERED_SERVICE_FOOTPRINT"}'::jsonb
  and exists (select 1 from public.profiles where id = pg_temp.uid(601)),
  'data without an entitlement is never deleted or skipped silently');
-- X service deletion refuses a shared workspace even with an entitlement.
insert into public.service_entitlements (user_id, service_key, status, source, activated_at) values (pg_temp.uid(105), 'x_autopost', 'active', 'operator', now());
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', pg_temp.uid(105))) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"X_WORKSPACE_NOT_SELF_SERVICE"}'::jsonb
  and pg_temp.entitlement(pg_temp.uid(105), 'x_autopost') = 'active', 'X service deletion refuses a shared workspace');
-- Reserved entitlement states.
select public.fixture_login(pg_temp.uid(602));
select pg_temp.start(pg_temp.uid(602), 'kabumori') as r \gset
update public.service_entitlements set status = 'suspended' where user_id = pg_temp.uid(602);
select pg_temp.start(pg_temp.uid(602), 'kabumori') as r1 \gset
select pg_temp.begin_deletion(pg_temp.uid(602)) -> 'reasons' as r2 \gset
select pg_temp.withdraw_kabumori(pg_temp.uid(602)) as r3 \gset
select pg_temp.expect(:'r1'::jsonb = '{"status":"blocked","reason":"SERVICE_SUSPENDED"}'::jsonb
  and :'r2'::jsonb = '["SERVICE_NOT_DELETABLE"]'::jsonb
  and :'r3'::jsonb = '{"status":"blocked","reason":"SERVICE_NOT_DELETABLE"}'::jsonb
  and exists (select 1 from public.profiles where id = pg_temp.uid(602)),
  'a suspended service can be neither started nor deleted');
update public.service_entitlements set status = 'provisioning' where user_id = pg_temp.uid(602);
select pg_temp.start(pg_temp.uid(602), 'kabumori') as r1 \gset
select pg_temp.begin_deletion(pg_temp.uid(602)) -> 'reasons' as r2 \gset
select pg_temp.expect(:'r1'::jsonb = '{"status":"blocked","reason":"SERVICE_NOT_READY"}'::jsonb
  and :'r2'::jsonb = '["SERVICE_NOT_DELETABLE"]'::jsonb, 'a provisioning service blocks start and deletion');
-- Locked account.
select pg_temp.start(pg_temp.uid(113), 'x_autopost') as r1 \gset
select pg_temp.begin_deletion(pg_temp.uid(113)) -> 'reasons' as r2 \gset
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''kabumori'')', pg_temp.uid(113))) as r3 \gset
select pg_temp.expect(:'r1'::jsonb = '{"status":"blocked","reason":"ACCOUNT_LOCKED"}'::jsonb
  and :'r2'::jsonb @> '["ACCOUNT_LOCKED"]'::jsonb
  and :'r3'::jsonb = '{"status":"blocked","reason":"ACCOUNT_LOCKED"}'::jsonb
  and pg_temp.account(pg_temp.uid(113)) = 'locked',
  'a locked account can neither start nor delete');
-- Input validation.
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.begin_service_deletion(%L::uuid, ''other'')', pg_temp.uid(104))) like '%ACCOUNT_LIFECYCLE_SERVICE_INVALID%',
  'unknown service key is refused');
select pg_temp.expect(pg_temp.error_as('service_role', 'select public.begin_common_account_deletion(null, 0)') like '%ACCOUNT_LIFECYCLE_USER_REQUIRED%',
  'missing user is refused');
select pg_temp.expect(pg_temp.error_as('service_role', format('insert into public.service_entitlements (user_id, service_key, status, source) values (%L, ''kabumori'', ''active'', ''self_service'')', pg_temp.uid(104))) like '%permission denied%',
  'the backend cannot write entitlements directly either');

-- ---------------------------------------------------------------------------
-- 7. Managed ownership (H1 counterexample 1): Storage records its owner as
--    text with no foreign key to the login. An attested checkpoint does not
--    override ownership the database can still see, and an unreadable or
--    newly required managed service fails closed.
select public.fixture_login(pg_temp.uid(701));
insert into storage.buckets (id) values ('fake-bucket');
insert into storage.objects (bucket_id, name, owner_id) values ('fake-bucket', 'fake/701.png', pg_temp.uid(701)::text);
select pg_temp.expect(pg_temp.eligibility(pg_temp.uid(701)) -> 'managed_ownership' = '["MANAGED_STORAGE_OWNED"]'::jsonb, 'eligibility shows the Storage ownership');
select pg_temp.begin_deletion(pg_temp.uid(701), 0) ->> 'operation_id' as op701 \gset
select pg_temp.checkpoint(pg_temp.uid(701), :'op701', 'session_revocation') as r1 \gset
select pg_temp.checkpoint(pg_temp.uid(701), :'op701', 'storage_cleanup') as r2 \gset
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"not_ready","reason":"MANAGED_OWNERSHIP_REMAINS","managed_ownership":["MANAGED_STORAGE_OWNED"]}'::jsonb
  and pg_temp.login_exists(pg_temp.uid(701))
  and (select status = 'in_progress' and current_step = 'cleanup' and last_error_code = 'MANAGED_OWNERSHIP_REMAINS'
         from private.account_lifecycle_operations where id = :'op701'::uuid)
  and (select count(*) from storage.objects where owner_id = pg_temp.uid(701)::text) = 1,
  'H1-1: with a Storage object still owned, the deletion is neither ready nor completed, and nothing in Storage is touched');
delete from storage.objects where owner_id = pg_temp.uid(701)::text;  -- stands in for cleanup through the Storage API
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete' and pg_temp.login_exists(pg_temp.uid(701)), 'ready once the object is gone');
insert into storage.objects (bucket_id, name, owner_id) values ('fake-bucket', 'fake/701-late.png', pg_temp.uid(701)::text);
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_OWNERSHIP_REMAINS'
  and (select current_step = 'cleanup' and ready_at is null from private.account_lifecycle_operations where id = :'op701'::uuid),
  'revalidation: an object uploaded after "ready" drops the operation back to cleanup');
delete from storage.objects where owner_id = pg_temp.uid(701)::text;
-- The deprecated uuid owner column and bucket ownership count as well.
insert into storage.objects (bucket_id, name, owner) values ('fake-bucket', 'fake/701-old.png', pg_temp.uid(701));
select pg_temp.prepare(pg_temp.uid(701), :'op701') ->> 'reason' as r \gset
select pg_temp.expect(:'r' = 'MANAGED_OWNERSHIP_REMAINS', 'deprecated owner column');
delete from storage.objects where owner = pg_temp.uid(701);
insert into storage.buckets (id, owner_id) values ('fake-bucket-701', pg_temp.uid(701)::text);
select pg_temp.prepare(pg_temp.uid(701), :'op701') ->> 'reason' as r \gset
select pg_temp.expect(:'r' = 'MANAGED_OWNERSHIP_REMAINS', 'bucket ownership');
delete from storage.buckets where id = 'fake-bucket-701';
-- A Storage shape this code cannot read is treated as "may be owned".
alter table storage.objects rename column owner_id to owner_id_renamed;
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'managed_ownership' = '["MANAGED_STORAGE_SHAPE_UNKNOWN"]'::jsonb, 'unknown Storage shape fails closed');
alter table storage.objects rename column owner_id_renamed to owner_id;
-- Storage that cannot be read at all (here: owner_id is no longer text) is
-- "may be owned", answered as not ready rather than as an error.
alter table storage.objects alter column owner_id type uuid using owner_id::uuid;
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'managed_ownership' = '["MANAGED_STORAGE_PROBE_FAILED"]'::jsonb, 'an unreadable Storage probe fails closed');
alter table storage.objects alter column owner_id type text;
select pg_temp.prepare(pg_temp.uid(701), :'op701') ->> 'status' as r \gset
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete', '701 ready');

-- Extension point, and H1 F2 (new requirement): a newly registered managed
-- service moves the requirement epoch, withdraws every existing readiness at
-- once, and keeps every deletion not ready until an orchestrator attests it.
select pg_temp.epoch() as e0 \gset
insert into private.account_lifecycle_managed_checkpoints values ('new_managed_service_cleanup', 'always');
select pg_temp.expect(pg_temp.epoch() = :e0 + 1 and pg_temp.op(:'op701') = 'cleanup:REQUIREMENT_EPOCH_CHANGED:unbound'
  and pg_temp.authorization_of(pg_temp.uid(701)) = '{"state":"none"}'::jsonb,
  'H1-F2: a new always-required checkpoint invalidates a readiness that was already granted');
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'missing_checkpoints' = '["new_managed_service_cleanup"]'::jsonb, 'a new managed-ownership requirement fails closed');
delete from private.account_lifecycle_managed_checkpoints where checkpoint_key = 'new_managed_service_cleanup';
select pg_temp.expect(pg_temp.epoch() = :e0 + 2, 'removing a requirement moves the epoch too');
select pg_temp.prepare(pg_temp.uid(701), :'op701') ->> 'status' as r \gset
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete', '701 ready again under the new epoch');

-- I9 / H1 F3: the built-in checkpoints cannot be removed or given another
-- meaning by ordinary maintenance.
select pg_temp.expect(pg_temp.error_as(current_user::text, q) like '%ACCOUNT_LIFECYCLE_BUILTIN_CHECKPOINT_IMMUTABLE%', 'built-in immutable: ' || q)
from unnest(array[
  'delete from private.account_lifecycle_managed_checkpoints where checkpoint_key = ''storage_cleanup''',
  'update private.account_lifecycle_managed_checkpoints set requirement = ''apple_identity'' where checkpoint_key = ''session_revocation''',
  'update private.account_lifecycle_managed_checkpoints set requirement = ''always'' where checkpoint_key = ''apple_revocation''',
  'update private.account_lifecycle_managed_checkpoints set checkpoint_key = ''renamed_cleanup'' where checkpoint_key = ''storage_cleanup''',
  'truncate private.account_lifecycle_managed_checkpoints']) q;
select pg_temp.expect(pg_temp.op(:'op701') = 'ready_for_managed_auth_delete::bound', 'refused maintenance changes nothing');
-- Corruption (the maintenance guard bypassed) still fails closed. H1 F3: the
-- built-in names are kept but session/storage are weakened to Apple-only. A
-- person without an Apple identity and without any checkpoint must not
-- become ready.
alter table private.account_lifecycle_managed_checkpoints disable trigger account_lifecycle_guard_checkpoint_registry;
update private.account_lifecycle_managed_checkpoints set requirement = 'apple_identity'
 where checkpoint_key in ('session_revocation', 'storage_cleanup');
select pg_temp.expect(pg_temp.op(:'op701') = 'cleanup:REQUIREMENT_EPOCH_CHANGED:unbound', 'the corrupting change itself withdraws readiness');
select public.fixture_login(pg_temp.uid(702));
select pg_temp.begin_deletion(pg_temp.uid(702), 0) ->> 'operation_id' as op702 \gset
select pg_temp.prepare(pg_temp.uid(702), :'op702') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_CHECKPOINT_REGISTRY_INVALID'
  and pg_temp.eligibility(pg_temp.uid(702)) -> 'required_checkpoints' = 'null'::jsonb,
  'H1-F3: built-in names with a weakened meaning make nothing ready');
update private.account_lifecycle_managed_checkpoints b set requirement = c.requirement
  from private.account_lifecycle_builtin_checkpoints() c where c.checkpoint_key = b.checkpoint_key;
-- H1 F2 (removed built-in row).
delete from private.account_lifecycle_managed_checkpoints where checkpoint_key = 'storage_cleanup';
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_CHECKPOINT_REGISTRY_INVALID', 'H1-F2: a registry without a built-in row makes nothing ready');
insert into private.account_lifecycle_managed_checkpoints values ('storage_cleanup', 'always');
alter table private.account_lifecycle_managed_checkpoints enable trigger account_lifecycle_guard_checkpoint_registry;
select pg_temp.prepare(pg_temp.uid(702), :'op702') -> 'missing_checkpoints' as r \gset
select pg_temp.expect(:'r'::jsonb = '["session_revocation","storage_cleanup"]'::jsonb, 'with the contract restored both checkpoints are required again');
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete' and pg_temp.login_exists(pg_temp.uid(701)), '701 ready again');
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(701), :'op701')) as r \gset
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(702), :'op702')) as r \gset

-- Sign in with Apple: its revoke is one more required checkpoint.
select public.fixture_login(pg_temp.uid(703));
insert into auth.identities (user_id, provider) values (pg_temp.uid(703), 'apple');
select pg_temp.begin_deletion(pg_temp.uid(703), 0) as r \gset
select :'r'::jsonb ->> 'operation_id' as op703 \gset
select pg_temp.expect(:'r'::jsonb -> 'required_checkpoints' = '["apple_revocation","session_revocation","storage_cleanup"]'::jsonb, 'Apple revoke is required for an Apple identity');
select pg_temp.checkpoint(pg_temp.uid(703), :'op703', 'session_revocation') as r1 \gset
select pg_temp.checkpoint(pg_temp.uid(703), :'op703', 'storage_cleanup') as r2 \gset
select pg_temp.prepare(pg_temp.uid(703), :'op703') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'missing_checkpoints' = '["apple_revocation"]'::jsonb, 'not ready before the Apple grant is revoked');
select pg_temp.checkpoint(pg_temp.uid(703), :'op703', 'apple_revocation') as r1 \gset
select pg_temp.prepare(pg_temp.uid(703), :'op703') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete' and pg_temp.login_exists(pg_temp.uid(703)), 'ready after the checkpoint');
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(703), :'op703')) as r \gset

-- ---------------------------------------------------------------------------
-- 8. Auth-delete guard. In Phase 1 it only observes. The plain
--    "delete from auth.users" below is the TEST standing in for whoever removes
--    a login (today's legacy routes; later the orchestrator through the managed
--    API). The candidate never does it.
select public.fixture_login(pg_temp.uid(801), true, true);
select pg_temp.start(pg_temp.uid(801), 'kabumori') as r \gset
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''kabumori'')', pg_temp.uid(801))) ->> 'operation_id' as op801 \gset
delete from auth.users where id = pg_temp.uid(801);
select pg_temp.expect(not pg_temp.login_exists(pg_temp.uid(801)) and pg_temp.account(pg_temp.uid(801)) = 'none'
  and not exists (select 1 from public.profiles where id = pg_temp.uid(801))
  and (select status = 'login_removed' and last_error_code = 'ACCOUNT_REMOVED_EXTERNALLY' and user_id is null
         from private.account_lifecycle_operations where id = :'op801'::uuid),
  'shadow: a legacy hard delete still works (it is NOT made safe); the lifecycle records are closed and scrubbed');
-- A ready operation whose login disappears is recorded as an unverified
-- observation, never as a completed account deletion.
select pg_temp.ready_login(pg_temp.uid(802)) as op802 \gset
delete from auth.users where id = pg_temp.uid(802);
select pg_temp.expect(not pg_temp.login_exists(pg_temp.uid(802))
  and (select status = 'login_removed' and last_error_code = 'LOGIN_REMOVED_WHILE_READY_UNVERIFIED' and user_id is null
         from private.account_lifecycle_operations where id = :'op802'::uuid)
  and not exists (select 1 from private.account_lifecycle_operations where operation_type = 'account_deletion' and status = 'completed'),
  'shadow: the removal of a ready login is an unverified observation; no "completed" is recorded');

-- There is no enforcing mode in Phase 1, whatever the integration state.
select pg_temp.expect(pg_temp.error_as(current_user::text, 'update private.account_lifecycle_settings set auth_delete_guard = ''enforce''')
  like '%violates check constraint%', 'enforce does not exist');
select pg_temp.expect(pg_temp.error_as(current_user::text, 'update private.account_lifecycle_settings set integration_state = ''started'', auth_delete_guard = ''enforce''')
  like '%violates check constraint%', 'enforce does not exist even after integration started');

-- Missing settings: nothing is authorized. Every login delete is refused, a
-- ready and clean operation included, and readiness itself is withdrawn.
select pg_temp.ready_login(pg_temp.uid(804)) as op804 \gset
select public.fixture_user_with_workspace(pg_temp.uid(803), 'S803');
select pg_temp.start(pg_temp.uid(803), 'x_autopost') as r \gset
delete from private.account_lifecycle_settings;
select pg_temp.expect(pg_temp.op(:'op804') = 'cleanup:REQUIREMENT_EPOCH_CHANGED:unbound', 'removing the settings row withdraws every readiness');
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(804))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%' and pg_temp.login_exists(pg_temp.uid(804)),
  'missing settings refuse every login delete');
select pg_temp.prepare(pg_temp.uid(804), :'op804') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'LIFECYCLE_SETTINGS_INVALID', 'and nothing can become ready without settings');
-- The existing X saga (legacy scope rule: no profile => delete the login) is
-- stopped at its own operator state instead of removing the login.
select pg_temp.x_saga(pg_temp.uid(803), 'social_and_login') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"operator_required","reason":"LOGIN_DELETE_BLOCKED"}'::jsonb
  and pg_temp.login_exists(pg_temp.uid(803)), 'a refused login delete lands in the legacy X saga''s operator state');
insert into private.account_lifecycle_settings default values;
select pg_temp.expect((select auth_delete_guard = 'shadow' and integration_state = 'not_started' from private.account_lifecycle_settings), 'settings restored');
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(804), :'op804')) as r \gset

-- ---------------------------------------------------------------------------
-- 9. Durable authorization (I8) and its invalidators.
--    (a) Changes this candidate can see withdraw a readiness at once.
select pg_temp.ready_login(pg_temp.uid(1001)) as op \gset
select pg_temp.expect(pg_temp.op(:'op') = 'ready_for_managed_auth_delete::bound'
  and pg_temp.authorization_of(pg_temp.uid(1001)) ->> 'state' = 'valid', 'a ready operation carries a valid authorization');
-- Entitlement inserted (operator SQL).
insert into public.service_entitlements (user_id, service_key, status, source, activated_at)
values (pg_temp.uid(1001), 'kabumori', 'active', 'operator', now());
select pg_temp.expect(pg_temp.op(:'op') = 'cleanup:LIFECYCLE_VERSION_CHANGED:unbound'
  and pg_temp.authorization_of(pg_temp.uid(1001)) = '{"state":"none"}'::jsonb, 'invalidator: entitlement insert');
-- Entitlement updated.
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.uid(1001);
select pg_temp.prepare(pg_temp.uid(1001), :'op') ->> 'status' as r \gset
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete', '1001 ready again');
update public.service_entitlements set status = 'active', ended_at = null where user_id = pg_temp.uid(1001);
select pg_temp.expect(pg_temp.op(:'op') = 'cleanup:LIFECYCLE_VERSION_CHANGED:unbound', 'invalidator: entitlement update');
-- Entitlement deleted.
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = pg_temp.uid(1001);
select pg_temp.prepare(pg_temp.uid(1001), :'op') ->> 'status' as r \gset
delete from public.service_entitlements where user_id = pg_temp.uid(1001);
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete' and pg_temp.op(:'op') = 'cleanup:LIFECYCLE_VERSION_CHANGED:unbound',
  'invalidator: entitlement delete');
-- Account state changed (operator hold), and released again.
select pg_temp.prepare(pg_temp.uid(1001), :'op') ->> 'status' as r \gset
update public.common_accounts set status = 'locked' where user_id = pg_temp.uid(1001);
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete' and pg_temp.op(:'op') = 'cleanup:LIFECYCLE_VERSION_CHANGED:unbound',
  'invalidator: account state change');
update public.common_accounts set status = 'deleting' where user_id = pg_temp.uid(1001);
-- Checkpoint withdrawn by the orchestrator.
select pg_temp.prepare(pg_temp.uid(1001), :'op') ->> 'status' as r \gset
select pg_temp.svc(format('select public.clear_common_account_deletion_checkpoint(%L::uuid, %L::uuid, ''storage_cleanup'')', pg_temp.uid(1001), :'op')) as c \gset
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete' and :'c'::jsonb = '{"status":"cleared","checkpoint":"storage_cleanup"}'::jsonb
  and pg_temp.op(:'op') = 'cleanup:MANAGED_CHECKPOINT_CLEARED:unbound', 'invalidator: checkpoint cleared');
select pg_temp.prepare(pg_temp.uid(1001), :'op') -> 'missing_checkpoints' as r \gset
select pg_temp.expect(:'r'::jsonb = '["storage_cleanup"]'::jsonb, 'a cleared checkpoint must be attested again');
select pg_temp.checkpoint(pg_temp.uid(1001), :'op', 'storage_cleanup') as c \gset
-- Integration state transition.
select pg_temp.prepare(pg_temp.uid(1001), :'op') ->> 'status' as r \gset
select pg_temp.epoch() as e0 \gset
update private.account_lifecycle_settings set integration_state = 'started';
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete' and pg_temp.epoch() = :e0 + 1
  and pg_temp.op(:'op') = 'cleanup:REQUIREMENT_EPOCH_CHANGED:unbound', 'invalidator: integration state transition');
update private.account_lifecycle_settings set integration_state = 'not_started';
select pg_temp.expect(pg_temp.error_as(current_user::text, 'update private.account_lifecycle_settings set requirement_epoch = 1')
  like '%ACCOUNT_LIFECYCLE_EPOCH_CANNOT_DECREASE%', 'the requirement epoch can never go back');
-- Things that change nothing leave the authorization valid: a refused service
-- start, and a backfill (it grants nothing to an account that is deleting).
select pg_temp.prepare(pg_temp.uid(1001), :'op') ->> 'status' as r \gset
select pg_temp.start(pg_temp.uid(1001), 'x_autopost') ->> 'reason' as s \gset
select private.account_lifecycle_backfill(true) as b \gset
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete' and :'s' = 'ACCOUNT_DELETION_IN_PROGRESS'
  and pg_temp.op(:'op') = 'ready_for_managed_auth_delete::bound'
  and pg_temp.authorization_of(pg_temp.uid(1001)) ->> 'state' = 'valid',
  'a refused start and a backfill leave a valid authorization valid');
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(1001), :'op')) as r \gset

--    The binding itself is checked, not only the withdrawal: with the
--    withdrawing trigger switched off (as corruption would), a moved version
--    or epoch still reads as stale.
select pg_temp.ready_login(pg_temp.uid(1007)) as op1007 \gset
alter table public.common_accounts disable trigger account_lifecycle_account_changed;
update public.common_accounts set lifecycle_version = lifecycle_version + 1 where user_id = pg_temp.uid(1007);
alter table public.common_accounts enable trigger account_lifecycle_account_changed;
select pg_temp.expect(pg_temp.op(:'op1007') = 'ready_for_managed_auth_delete::bound'
  and pg_temp.authorization_of(pg_temp.uid(1007)) = '{"state":"stale","problems":["LIFECYCLE_VERSION_CHANGED"]}'::jsonb,
  'binding: a readiness decided against another lifecycle version is stale');
select pg_temp.prepare(pg_temp.uid(1007), :'op1007') ->> 'status' as r \gset
alter table private.account_lifecycle_settings disable trigger account_lifecycle_settings_changed;
update private.account_lifecycle_settings set requirement_epoch = requirement_epoch + 1;
alter table private.account_lifecycle_settings enable trigger account_lifecycle_settings_changed;
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete' and pg_temp.op(:'op1007') = 'ready_for_managed_auth_delete::bound'
  and pg_temp.authorization_of(pg_temp.uid(1007)) = '{"state":"stale","problems":["REQUIREMENT_EPOCH_CHANGED"]}'::jsonb,
  'binding: a readiness decided against another requirement epoch is stale');
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(1007), :'op1007')) as r \gset

--    (b) Changes this candidate cannot see (they are written to existing or
--    managed tables that Phase 1 does not wire). The stored step stays
--    "ready", so the authorization must be, and is, re-evaluated before use:
--    it reads as stale, and prepare refuses. This is exactly why Phase 1 has
--    no enforcing guard.
-- H1 F1: late admin membership.
select pg_temp.ready_login(pg_temp.uid(1002)) as op1002 \gset
insert into public.admin_users values (pg_temp.uid(1002));
select pg_temp.expect(pg_temp.op(:'op1002') = 'ready_for_managed_auth_delete::bound'
  and pg_temp.authorization_of(pg_temp.uid(1002)) = '{"state":"stale","problems":["ADMIN_ACCOUNT"]}'::jsonb,
  'H1-F1: a late admin membership makes the authorization stale');
select pg_temp.prepare(pg_temp.uid(1002), :'op1002') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"blocked","reasons":["ADMIN_ACCOUNT"]}'::jsonb
  and pg_temp.op(:'op1002') = 'cleanup:ADMIN_ACCOUNT:unbound', 'H1-F1: stale readiness cannot be refreshed past a late admin blocker');
-- H1 F1: late membership of an internal workspace.
select pg_temp.ready_login(pg_temp.uid(1003)) as op1003 \gset
insert into public.brand_memberships (brand_id, user_id, role) values ('kabumori', pg_temp.uid(1003), 'member');
select pg_temp.expect(pg_temp.authorization_of(pg_temp.uid(1003)) = '{"state":"stale","problems":["X_WORKSPACE_NOT_SELF_SERVICE"]}'::jsonb,
  'H1-F1: a late foreign membership makes the authorization stale');
select pg_temp.prepare(pg_temp.uid(1003), :'op1003') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"blocked","reasons":["X_WORKSPACE_NOT_SELF_SERVICE"]}'::jsonb
  and pg_temp.op(:'op1003') = 'cleanup:X_WORKSPACE_NOT_SELF_SERVICE:unbound', 'H1-F1: stale readiness cannot be refreshed past a late membership blocker');
-- H1 F2: late Apple identity without its checkpoint.
select pg_temp.ready_login(pg_temp.uid(1004)) as op1004 \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(1004), 'apple');
select pg_temp.expect(pg_temp.authorization_of(pg_temp.uid(1004))
  = '{"state":"stale","problems":["REQUIRED_CHECKPOINTS_CHANGED","MANAGED_CHECKPOINTS_MISSING"]}'::jsonb,
  'H1-F2: a late Apple identity makes the authorization stale: the required set is no longer the one it was bound to');
select pg_temp.prepare(pg_temp.uid(1004), :'op1004') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'missing_checkpoints' = '["apple_revocation"]'::jsonb
  and pg_temp.op(:'op1004') = 'cleanup:MANAGED_CHECKPOINTS_MISSING:unbound', 'H1-F2: the old readiness cannot be reused without apple_revocation');
-- Late Storage object, and late legacy profile bootstrap.
select pg_temp.ready_login(pg_temp.uid(1005)) as op1005 \gset
insert into storage.objects (bucket_id, name, owner_id) values ('fake-bucket', 'fake/1005.png', pg_temp.uid(1005)::text);
select pg_temp.expect(pg_temp.authorization_of(pg_temp.uid(1005)) = '{"state":"stale","problems":["MANAGED_OWNERSHIP_REMAINS"]}'::jsonb,
  'a late Storage object makes the authorization stale');
delete from storage.objects where owner_id = pg_temp.uid(1005)::text;
select pg_temp.usr(pg_temp.uid(1005), 'select to_jsonb(public.ensure_my_profile())') as r \gset
select pg_temp.expect(pg_temp.authorization_of(pg_temp.uid(1005)) = '{"state":"stale","problems":["UNREGISTERED_SERVICE_FOOTPRINT"]}'::jsonb,
  'a late legacy profile makes the authorization stale');
-- Shadow is not safety: a login whose stored readiness is stale (a late admin
-- membership, never re-evaluated) can still be hard-deleted by a legacy route.
-- Phase 1 records it as unverified; it does not claim to prevent it.
select pg_temp.ready_login(pg_temp.uid(1006)) as op1006 \gset
insert into public.admin_users values (pg_temp.uid(1006));
delete from auth.users where id = pg_temp.uid(1006);
select pg_temp.expect(not pg_temp.login_exists(pg_temp.uid(1006))
  and (select status = 'login_removed' and last_error_code = 'LOGIN_REMOVED_WHILE_READY_UNVERIFIED' and user_id is null
         from private.account_lifecycle_operations where id = :'op1006'::uuid),
  'shadow allows a hard delete despite a late blocker (explicitly unsafe) and records it as unverified');

-- ---------------------------------------------------------------------------
-- 10. H1 F1, cascade order. The guard must not depend on whether the rows of
--     a blocker are still visible when the cascade reaches common_accounts.
--     A test-only probe records, inside the cascade and before the guard,
--     whether the admin row is still there; the guard's answer is the same in
--     both orders, because it looks at no blocker row at all.
create table public.fixture_cascade_probe (user_id uuid primary key, admin_visible boolean not null);
create function public.fixture_cascade_probe() returns trigger language plpgsql as $$
begin
  insert into public.fixture_cascade_probe
  values (old.user_id, exists (select 1 from public.admin_users a where a.user_id = old.user_id));
  return old;
end;
$$;
create trigger aaa_fixture_cascade_probe before delete on public.common_accounts
  for each row execute function public.fixture_cascade_probe();
-- Which cascade the same DELETE runs first is decided by trigger name order.
create function pg_temp.admin_cascades_first() returns boolean language sql as $$
  select (select t.tgname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
           where c.conname = 'admin_users_user_id_fkey' and t.tgrelid = 'auth.users'::regclass
             and t.tgfoid = 'pg_catalog."RI_FKey_cascade_del"'::regproc)
       < (select t.tgname from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint
           where c.conname = 'common_accounts_user_id_fkey' and t.tgrelid = 'auth.users'::regclass
             and t.tgfoid = 'pg_catalog."RI_FKey_cascade_del"'::regproc)
$$;
-- Order as installed.
select pg_temp.admin_cascades_first() as first_a \gset
select pg_temp.ready_login(pg_temp.uid(1011)) as op1011 \gset
select pg_temp.ready_login(pg_temp.uid(1012)) as op1012 \gset
insert into public.admin_users values (pg_temp.uid(1011)), (pg_temp.uid(1012));
delete from private.account_lifecycle_settings;
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(1011))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%' and pg_temp.login_exists(pg_temp.uid(1011))
  and exists (select 1 from public.admin_users where user_id = pg_temp.uid(1011)),
  'H1-F1: with nothing authorizing, a late admin''s login is not deleted (order as installed)');
insert into private.account_lifecycle_settings default values;
delete from auth.users where id = pg_temp.uid(1012);
select admin_visible as visible_a from public.fixture_cascade_probe where user_id = pg_temp.uid(1012) \gset
select pg_temp.expect(:'visible_a'::boolean = not :'first_a'::boolean,
  'the probe sees the admin row exactly when its cascade has not run yet (order as installed)');
-- The other order: the admin foreign key is re-created, so its cascade now
-- runs after the one to common_accounts.
alter table public.admin_users drop constraint admin_users_user_id_fkey;
alter table public.admin_users add constraint admin_users_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade;
select pg_temp.admin_cascades_first() as first_b \gset
select pg_temp.ready_login(pg_temp.uid(1013)) as op1013 \gset
select pg_temp.ready_login(pg_temp.uid(1014)) as op1014 \gset
insert into public.admin_users values (pg_temp.uid(1013)), (pg_temp.uid(1014));
delete from private.account_lifecycle_settings;
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(1013))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%' and pg_temp.login_exists(pg_temp.uid(1013))
  and exists (select 1 from public.admin_users where user_id = pg_temp.uid(1013)),
  'H1-F1: the same refusal in the other cascade order');
insert into private.account_lifecycle_settings default values;
delete from auth.users where id = pg_temp.uid(1014);
select admin_visible as visible_b from public.fixture_cascade_probe where user_id = pg_temp.uid(1014) \gset
-- (If trigger names happen to sort the same way after the re-creation, the two
-- orders coincide; the checks above still hold for the order that exists.)
select pg_temp.expect(:'visible_b'::boolean = not :'first_b'::boolean
  and (:'first_a'::boolean = :'first_b'::boolean or :'visible_a'::boolean is distinct from :'visible_b'::boolean),
  'H1-F1: blocker visibility inside the cascade depends on the order; the guard''s answer does not');
drop trigger aaa_fixture_cascade_probe on public.common_accounts;
drop function public.fixture_cascade_probe();
drop table public.fixture_cascade_probe;
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', u, o)) from (values
  (pg_temp.uid(1011), :'op1011'), (pg_temp.uid(1013), :'op1013')) v(u, o);
delete from public.admin_users where user_id in (pg_temp.uid(1002), pg_temp.uid(1011), pg_temp.uid(1013));

-- ---------------------------------------------------------------------------
-- 11. H1 F4: an entitlement cannot be moved to another person or service, so
--     no account can change without its own version moving.
select public.fixture_login(pg_temp.uid(1021));
select public.fixture_login(pg_temp.uid(1022));
select pg_temp.start(pg_temp.uid(1021), 'x_autopost') as r1 \gset
select pg_temp.start(pg_temp.uid(1022), 'kabumori') as r2 \gset
select pg_temp.version(pg_temp.uid(1021)) as v1, pg_temp.version(pg_temp.uid(1022)) as v2 \gset
select coalesce(pg_temp.error_as(current_user::text, format(
  'update public.service_entitlements set user_id = %L where user_id = %L', pg_temp.uid(1022), pg_temp.uid(1021))), '') as e1 \gset
select coalesce(pg_temp.error_as(current_user::text, format(
  'update public.service_entitlements set service_key = ''kabumori'' where user_id = %L', pg_temp.uid(1021))), '') as e2 \gset
select pg_temp.expect(:'e1' like '%ACCOUNT_LIFECYCLE_ENTITLEMENT_OWNER_IMMUTABLE%' and :'e2' like '%ACCOUNT_LIFECYCLE_ENTITLEMENT_OWNER_IMMUTABLE%',
  'H1-F4: an entitlement cannot be transferred to another person or service');
select pg_temp.expect(pg_temp.version(pg_temp.uid(1021)) = :v1 and pg_temp.version(pg_temp.uid(1022)) = :v2
  and pg_temp.entitlement(pg_temp.uid(1021), 'x_autopost') = 'active' and pg_temp.entitlement(pg_temp.uid(1022), 'x_autopost') = 'none',
  'H1-F4: the refused transfer changed neither account');
-- Moving a service is: end it for one person, start it for the other. Both
-- versions move.
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', pg_temp.uid(1021))) ->> 'operation_id' as opx \gset
select pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', pg_temp.uid(1021), :'opx')) as r1 \gset
select pg_temp.start(pg_temp.uid(1022), 'x_autopost') as r2 \gset
select pg_temp.expect(pg_temp.version(pg_temp.uid(1021)) > :v1 and pg_temp.version(pg_temp.uid(1022)) > :v2
  and pg_temp.entitlement(pg_temp.uid(1021), 'x_autopost') = 'ended' and pg_temp.entitlement(pg_temp.uid(1022), 'x_autopost') = 'active',
  'H1-F4: end here and start there moves both versions');

select 'COMMON_ACCOUNT_LIFECYCLE_BEHAVIOR_PASS';
