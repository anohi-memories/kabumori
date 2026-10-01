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

-- ---------------------------------------------------------------------------
-- 0. The candidate installs in shadow mode, before integration, and backfills
--    nothing by itself.
select pg_temp.expect((select auth_delete_guard = 'shadow' and integration_state = 'not_started' from private.account_lifecycle_settings),
  'installs in shadow mode, integration not started');
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
                  'abort_common_account_deletion(gen_random_uuid(), gen_random_uuid())',
                  'prepare_common_account_auth_delete(gen_random_uuid(), gen_random_uuid())']) f;
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.%s', f)) like '%permission denied%', 'service_role ' || f)
from unnest(array['start_kabumori_service()', 'start_x_autopost_service()']) f;
select pg_temp.expect(pg_temp.error_as(r, format('select private.%s', f)) like '%permission denied%', r || ' helper ' || f)
from unnest(array['anon', 'authenticated', 'service_role']) r,
     unnest(array['account_lifecycle_lock(gen_random_uuid(), true, false)',
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
           'begin_common_account_deletion', 'record_common_account_deletion_checkpoint', 'abort_common_account_deletion',
           'prepare_common_account_auth_delete'))) = 21
  and not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and (p.proname like 'account\_lifecycle\_%' or p.proname in (
            'start_kabumori_service', 'start_x_autopost_service', 'common_account_deletion_eligibility',
            'begin_service_deletion', 'finish_service_deletion', 'abort_service_deletion', 'withdraw_kabumori_service',
            'begin_common_account_deletion', 'record_common_account_deletion_checkpoint', 'abort_common_account_deletion',
            'prepare_common_account_auth_delete'))
       and (has_function_privilege('anon', p.oid, 'execute')
            or p.proacl is null
            or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)
            or not p.prosecdef
            or p.proconfig is distinct from array['search_path=""'])),
  'all 21 candidate functions: SECURITY DEFINER, empty search_path, no PUBLIC or anon EXECUTE');
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
select pg_temp.expect(pg_temp.eligibility(pg_temp.uid(301)) @> '{"account_status":"active","lifecycle_version":2,"blockers":[],"managed_ownership":[],"required_checkpoints":["session_revocation","storage_cleanup"],"services":[{"service_key":"kabumori","status":"active"}],"operation":null}'::jsonb,
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
    'next_steps', jsonb_build_array('revalidate_managed_ownership', 'managed_auth_admin_delete', 'post_delete_read_back_and_audit')),
  'ready: the database tells the orchestrator what is next');
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
-- Extension point: a newly registered managed service blocks every deletion
-- until an orchestrator attests it; a damaged registry blocks too.
insert into private.account_lifecycle_managed_checkpoints values ('new_managed_service_cleanup', 'always');
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb -> 'missing_checkpoints' = '["new_managed_service_cleanup"]'::jsonb, 'a new managed-ownership requirement fails closed');
delete from private.account_lifecycle_managed_checkpoints where checkpoint_key = 'new_managed_service_cleanup';
delete from private.account_lifecycle_managed_checkpoints where checkpoint_key = 'storage_cleanup';
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_CHECKPOINT_REGISTRY_INVALID', 'a registry without its built-in rows fails closed');
insert into private.account_lifecycle_managed_checkpoints values ('storage_cleanup', 'always');
select pg_temp.prepare(pg_temp.uid(701), :'op701') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete' and pg_temp.login_exists(pg_temp.uid(701)), '701 ready again');
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(701), :'op701')) as r \gset

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
-- 8. Auth-delete guard. The plain "delete from auth.users" below is the TEST
--    standing in for whoever removes a login (today's legacy routes; later the
--    orchestrator through the managed API). The candidate never does it.
--    Shadow (installed default): existing deletion routes behave as before.
select public.fixture_login(pg_temp.uid(801), true, true);
select pg_temp.start(pg_temp.uid(801), 'kabumori') as r \gset
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''kabumori'')', pg_temp.uid(801))) ->> 'operation_id' as op801 \gset
delete from auth.users where id = pg_temp.uid(801);
select pg_temp.expect(not pg_temp.login_exists(pg_temp.uid(801)) and pg_temp.account(pg_temp.uid(801)) = 'none'
  and not exists (select 1 from public.profiles where id = pg_temp.uid(801))
  and (select status = 'login_removed' and last_error_code = 'ACCOUNT_REMOVED_EXTERNALLY' and user_id is null
         from private.account_lifecycle_operations where id = :'op801'::uuid),
  'shadow mode: a legacy hard delete still works (it is NOT made safe); the lifecycle records are closed and scrubbed');

-- Enforce cannot be switched on before integration has started.
select pg_temp.expect(pg_temp.error_as(current_user::text, 'update private.account_lifecycle_settings set auth_delete_guard = ''enforce''')
  like '%violates check constraint%', 'enforce is refused while integration is not started');
update private.account_lifecycle_settings set integration_state = 'started', auth_delete_guard = 'enforce';

select public.fixture_login(pg_temp.uid(802), true, true);
select pg_temp.start(pg_temp.uid(802), 'kabumori') as r \gset
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(802))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%'
  and pg_temp.login_exists(pg_temp.uid(802)) and exists (select 1 from public.profiles where id = pg_temp.uid(802))
  and pg_temp.entitlement(pg_temp.uid(802), 'kabumori') = 'active',
  'enforce: a hard delete of an active account is refused and nothing is lost');
-- Deleting but not ready: still refused.
select pg_temp.begin_deletion(pg_temp.uid(802)) ->> 'operation_id' as op802 \gset
select pg_temp.withdraw_kabumori(pg_temp.uid(802)) as r \gset
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(802))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%' and pg_temp.login_exists(pg_temp.uid(802)),
  'enforce: an operation that is not ready does not authorize a delete');
-- Ready, but managed ownership is visible again at the moment of the delete.
select pg_temp.checkpoint(pg_temp.uid(802), :'op802', 'session_revocation') as r1 \gset
select pg_temp.checkpoint(pg_temp.uid(802), :'op802', 'storage_cleanup') as r2 \gset
select pg_temp.prepare(pg_temp.uid(802), :'op802') ->> 'status' as r \gset
select pg_temp.expect(:'r' = 'ready_for_managed_auth_delete', '802 ready');
insert into storage.objects (bucket_id, name, owner_id) values ('fake-bucket', 'fake/802.png', pg_temp.uid(802)::text);
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(802))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%' and pg_temp.login_exists(pg_temp.uid(802)),
  'enforce: ready is re-checked at the delete; visible Storage ownership refuses it');
delete from storage.objects where owner_id = pg_temp.uid(802)::text;
-- Ready and clean: the boundary lets the login row go. It records that the
-- row disappeared, never that the account deletion completed.
delete from auth.users where id = pg_temp.uid(802);
select pg_temp.expect(not pg_temp.login_exists(pg_temp.uid(802)) and pg_temp.account(pg_temp.uid(802)) = 'none'
  and (select status = 'login_removed' and last_error_code is null and user_id is null and current_step = 'ready_for_managed_auth_delete'
         from private.account_lifecycle_operations where id = :'op802'::uuid)
  and not exists (select 1 from private.account_lifecycle_operations where operation_type = 'account_deletion' and status = 'completed'),
  'enforce: a ready, clean operation is the only thing that authorizes the login row to go; no "completed" is recorded');
-- Ready, then a legacy creator (the real X onboarding RPC, not yet gated in
-- Phase 1) creates a workspace: the delete is refused, nothing is orphaned.
select public.fixture_login(pg_temp.uid(805));
select pg_temp.begin_deletion(pg_temp.uid(805), 0) ->> 'operation_id' as op805 \gset
select pg_temp.checkpoint(pg_temp.uid(805), :'op805', 'session_revocation') as r1 \gset
select pg_temp.checkpoint(pg_temp.uid(805), :'op805', 'storage_cleanup') as r2 \gset
select pg_temp.prepare(pg_temp.uid(805), :'op805') ->> 'status' as r \gset
select pg_temp.usr(pg_temp.uid(805), 'select to_jsonb(b) from public.begin_social_mobile_x_oauth_connection(repeat(''8'', 64), ''kabumori-social://oauth-callback'', now() + interval ''10 minutes'') b') as r \gset
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(805))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%' and pg_temp.login_exists(pg_temp.uid(805))
  and (select count(*) from public.brand_memberships where user_id = pg_temp.uid(805) and role = 'owner') = 1,
  'enforce: a workspace created after "ready" stops the delete; the workspace keeps its owner');
-- The existing X saga (legacy scope rule: no profile => delete the login) is
-- stopped at its own operator state instead of removing the login.
select public.fixture_user_with_workspace(pg_temp.uid(803), 'S803');
select pg_temp.start(pg_temp.uid(803), 'x_autopost') as r \gset
select pg_temp.x_saga(pg_temp.uid(803), 'social_and_login') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"operator_required","reason":"LOGIN_DELETE_BLOCKED"}'::jsonb
  and pg_temp.login_exists(pg_temp.uid(803)), 'enforce: the legacy X login delete fails closed into its operator state');
-- A missing settings row is treated as enforce.
delete from private.account_lifecycle_settings;
select public.fixture_login(pg_temp.uid(804));
select pg_temp.start(pg_temp.uid(804), 'kabumori') as r \gset
select coalesce(pg_temp.error_as(current_user::text, format('delete from auth.users where id = %L', pg_temp.uid(804))), '') as e \gset
select pg_temp.expect(:'e' like '%COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED%' and pg_temp.login_exists(pg_temp.uid(804)), 'unknown guard mode fails closed');
insert into private.account_lifecycle_settings default values;
select pg_temp.expect((select auth_delete_guard = 'shadow' and integration_state = 'not_started' from private.account_lifecycle_settings), 'guard back to shadow');

select 'COMMON_ACCOUNT_LIFECYCLE_BEHAVIOR_PASS';
