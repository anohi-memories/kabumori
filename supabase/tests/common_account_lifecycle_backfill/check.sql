-- Common-account Phase 1 backfill gate: READ-ONLY production check (Phase A foundation, Phase B dry-run,
-- Phase C parity). One psql session, one READ ONLY transaction: any write anywhere in it fails.
-- Output: one "label=<json>" line per check, aggregate counts and flags only. No user id, e-mail,
-- provider subject, handle, token or user content is selected into the output.
--
--   psql -X -q -A -t -v ON_ERROR_STOP=1 -f check.sql      (as postgres, production via session pooler)
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
begin transaction isolation level read committed read only;
set local statement_timeout = '60s';
set local lock_timeout = '5s';
set local search_path = pg_catalog, public;

select 'session='::text || jsonb_build_object(
  'user', current_user, 'read_only', current_setting('transaction_read_only'),
  'isolation', current_setting('transaction_isolation'), 'server_version_num', current_setting('server_version_num'));

-- Phase A: foundation exactness and current population ---------------------------------------
select 'A_history='::text || jsonb_build_object(
  'target_rows', (select count(*) from supabase_migrations.schema_migrations where version = '20261001150000'),
  'target_exact', (select count(*) from supabase_migrations.schema_migrations
                    where version = '20261001150000' and name = 'common_account_lifecycle_foundation'),
  'same_name_other_version', (select count(*) from supabase_migrations.schema_migrations
                               where name = 'common_account_lifecycle_foundation' and version <> '20261001150000'),
  'ledger_rows', (select count(*) from supabase_migrations.schema_migrations));

select 'A_functions='::text || jsonb_build_object(
  'backfill_def_md5', md5(pg_get_functiondef('private.account_lifecycle_backfill(boolean)'::regprocedure)),
  'backfill_owner', (select pg_get_userbyid(proowner) from pg_proc where oid = 'private.account_lifecycle_backfill(boolean)'::regprocedure),
  'backfill_secdef', (select prosecdef from pg_proc where oid = 'private.account_lifecycle_backfill(boolean)'::regprocedure),
  'backfill_config', (select proconfig from pg_proc where oid = 'private.account_lifecycle_backfill(boolean)'::regprocedure),
  'backfill_execute_api', (select jsonb_object_agg(r, has_function_privilege(r, 'private.account_lifecycle_backfill(boolean)', 'EXECUTE'))
                             from unnest(array['anon', 'authenticated', 'service_role']) r),
  'lock_def_md5', md5(pg_get_functiondef('private.account_lifecycle_lock(uuid,boolean,boolean)'::regprocedure)),
  'plan_view_md5', md5(pg_get_viewdef('private.account_lifecycle_backfill_plan'::regclass)),
  'plan_or_backfill_mentions_email', (pg_get_viewdef('private.account_lifecycle_backfill_plan'::regclass) ilike '%email%'
                                      or pg_get_functiondef('private.account_lifecycle_backfill(boolean)'::regprocedure) ilike '%email%'));

select 'A_settings='::text || jsonb_build_object(
  'settings', (select jsonb_agg(jsonb_build_object('guard', auth_delete_guard, 'integration', integration_state,
                                                   'epoch', requirement_epoch)) from private.account_lifecycle_settings),
  'registry', (select jsonb_agg(checkpoint_key || ':' || requirement order by checkpoint_key collate "C")
                 from private.account_lifecycle_managed_checkpoints));

select 'A_population='::text || jsonb_build_object(
  'auth_users', (select count(*) from auth.users),
  'auth_anonymous', (select count(*) from auth.users u where (to_jsonb(u) ->> 'is_anonymous')::boolean),
  'auth_soft_deleted', (select count(*) from auth.users u where to_jsonb(u) ->> 'deleted_at' is not null),
  'auth_sso', (select count(*) from auth.users u where (to_jsonb(u) ->> 'is_sso_user')::boolean),
  'auth_banned_now', (select count(*) from auth.users u where (to_jsonb(u) ->> 'banned_until')::timestamptz > now()),
  'identities_by_provider', (select coalesce(jsonb_object_agg(provider, n), '{}'::jsonb)
                               from (select provider, count(*) as n from auth.identities group by provider) x),
  'common_accounts', (select count(*) from public.common_accounts),
  'common_accounts_by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                                  from (select status, count(*) as n from public.common_accounts group by status) x),
  'entitlements', (select count(*) from public.service_entitlements),
  'entitlements_by_kind', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
                             from (select service_key || '/' || status || '/' || source || '/' || coalesce(legacy_evidence, '-') as k,
                                          count(*) as n from public.service_entitlements group by 1) x),
  'operations', (select count(*) from private.account_lifecycle_operations),
  'operations_by_kind', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
                           from (select operation_type || '/' || status as k, count(*) as n
                                   from private.account_lifecycle_operations group by 1) x),
  'operations_in_progress', (select count(*) from private.account_lifecycle_operations where status = 'in_progress'));

-- Phase B: the reviewed function, count-only, with row counts before and after ----------------
select 'B_counts_before='::text || jsonb_build_object(
  'auth_users', (select count(*) from auth.users), 'common_accounts', (select count(*) from public.common_accounts),
  'entitlements', (select count(*) from public.service_entitlements),
  'operations', (select count(*) from private.account_lifecycle_operations),
  'ledger_rows', (select count(*) from supabase_migrations.schema_migrations),
  'profiles', (select count(*) from public.profiles), 'brands', (select count(*) from public.brands),
  'memberships', (select count(*) from public.brand_memberships));
select 'B_dry_run='::text || private.account_lifecycle_backfill(false);
select 'B_counts_after='::text || jsonb_build_object(
  'auth_users', (select count(*) from auth.users), 'common_accounts', (select count(*) from public.common_accounts),
  'entitlements', (select count(*) from public.service_entitlements),
  'operations', (select count(*) from private.account_lifecycle_operations),
  'ledger_rows', (select count(*) from supabase_migrations.schema_migrations),
  'profiles', (select count(*) from public.profiles), 'brands', (select count(*) from public.brands),
  'memberships', (select count(*) from public.brand_memberships));

-- Phase C: parity, recomputed from the base tables without the plan view --------------------
with u as (
  select au.id,
         exists (select 1 from public.common_accounts c where c.user_id = au.id) as has_account,
         coalesce((select c.status from public.common_accounts c where c.user_id = au.id), 'active') as account_status,
         exists (select 1 from public.admin_users a where a.user_id = au.id) as is_admin,
         exists (select 1 from public.profiles p where p.id = au.id) as has_profile,
         (exists (select 1 from public.tracked_stocks t where t.user_id = au.id)
          or exists (select 1 from public.alert_settings t where t.user_id = au.id)
          or exists (select 1 from public.alert_category_settings t where t.user_id = au.id)
          or exists (select 1 from public.notifications t where t.user_id = au.id)
          or exists (select 1 from public.device_push_tokens t where t.user_id = au.id)
          or exists (select 1 from public.personalized_reports t where t.user_id = au.id)) as kab_activity,
         public.social_mobile_account_deletion_workspace(au.id) as ws
    from auth.users au
),
x as (
  select u.*,
         (select b.code_profile_key from public.brands b where b.id = u.ws) as ws_profile_key,
         exists (select 1 from public.brand_memberships m where m.brand_id = u.ws and m.user_id = u.id and m.role = 'owner') as owns_ws,
         (select count(*) from public.brand_memberships m where m.brand_id = u.ws and m.user_id <> u.id) as ws_other_members,
         (select count(*) from public.brand_memberships m where m.user_id = u.id and m.brand_id <> u.ws) as other_memberships,
         exists (select 1 from public.social_accounts s where s.brand_id = u.ws and s.connection_status = 'identity_verified') as ws_verified,
         exists (select 1 from public.service_entitlements e where e.user_id = u.id and e.service_key = 'kabumori') as has_kab_ent,
         exists (select 1 from public.service_entitlements e where e.user_id = u.id and e.service_key = 'x_autopost') as has_x_ent,
         private.account_lifecycle_footprint(u.id) as fp
    from u
),
c as (
  select x.*,
         x.has_profile as kab_candidate,
         (x.owns_ws and x.ws_profile_key = 'social_mobile_user_v1' and x.ws_other_members = 0) as x_owner_self_service
    from x
)
select 'C_parity='::text || jsonb_build_object(
  'auth_users', count(*),
  'plan_rows', (select count(*) from private.account_lifecycle_backfill_plan),
  'plan_distinct_users', (select count(distinct user_id) from private.account_lifecycle_backfill_plan),
  'plan_users_not_in_auth', (select count(*) from private.account_lifecycle_backfill_plan p where not exists (select 1 from auth.users a where a.id = p.user_id)),
  'missing_common_accounts', count(*) filter (where not has_account),
  'kabumori_candidates', count(*) filter (where kab_candidate),
  'kabumori_with_activity', count(*) filter (where kab_candidate and kab_activity),
  'kabumori_profile_only', count(*) filter (where kab_candidate and not kab_activity),
  'kabumori_activity_without_profile', count(*) filter (where kab_activity and not has_profile),
  'kabumori_to_create', count(*) filter (where kab_candidate and not has_kab_ent and account_status = 'active'),
  'x_owner_self_service', count(*) filter (where x_owner_self_service),
  'x_candidates', count(*) filter (where x_owner_self_service and not is_admin),
  'x_excluded_admin', count(*) filter (where x_owner_self_service and is_admin),
  'x_verified', count(*) filter (where x_owner_self_service and not is_admin and ws_verified),
  'x_pending', count(*) filter (where x_owner_self_service and not is_admin and not ws_verified),
  'x_to_create', count(*) filter (where x_owner_self_service and not is_admin and not has_x_ent and account_status = 'active'),
  'x_owner_of_non_self_service_ws', count(*) filter (where owns_ws and ws_profile_key is distinct from 'social_mobile_user_v1'),
  'x_owner_of_shared_ws', count(*) filter (where owns_ws and ws_other_members > 0),
  'x_member_elsewhere', count(*) filter (where other_memberships > 0),
  'admins', count(*) filter (where is_admin),
  'admins_with_profile', count(*) filter (where is_admin and has_profile),
  'auth_only', count(*) filter (where not kab_candidate and not (x_owner_self_service and not is_admin)),
  'not_active_accounts', count(*) filter (where account_status <> 'active'),
  -- the system's own footprint (what a future deletion check sees) against the candidate classification
  'footprint_combinations', (
    select jsonb_agg(jsonb_build_object('kab_fp', k, 'x_fp', xf, 'x_foreign', xg, 'admin', a,
                                        'kab_candidate', kc, 'x_candidate', xc, 'n', n)
                     order by k, xf, xg, a, kc, xc)
      from (select (fp ->> 'kabumori')::boolean as k, (fp ->> 'x_autopost')::boolean as xf,
                   (fp ->> 'x_foreign')::boolean as xg, is_admin as a, kab_candidate as kc,
                   (x_owner_self_service and not is_admin) as xc, count(*) as n
              from c group by 1, 2, 3, 4, 5, 6) g),
  'x_footprint_not_candidate', count(*) filter (where (fp ->> 'x_autopost')::boolean and not (x_owner_self_service and not is_admin)),
  'kab_footprint_not_candidate', count(*) filter (where (fp ->> 'kabumori')::boolean and not kab_candidate))
  from c;

select 'C_workspaces='::text || jsonb_build_object(
  'brands_by_profile_key', (select jsonb_object_agg(coalesce(code_profile_key, '-'), n)
                              from (select code_profile_key, count(*) as n from public.brands group by 1) x),
  'memberships_by_role_and_kind', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
                                     from (select m.role || '/' || case when b.code_profile_key = 'social_mobile_user_v1' then 'self_service' else 'internal' end
                                                  || '/' || case when b.id = public.social_mobile_account_deletion_workspace(m.user_id) then 'own_ws' else 'other_ws' end as k,
                                                  count(*) as n
                                             from public.brand_memberships m join public.brands b on b.id = m.brand_id group by 1) x),
  'social_accounts_by_kind_status', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
                                       from (select case when b.code_profile_key = 'social_mobile_user_v1' then 'self_service' else 'internal' end
                                                    || '/' || s.connection_status as k, count(*) as n
                                               from public.social_accounts s join public.brands b on b.id = s.brand_id group by 1) x),
  'self_service_brands_without_owner', (select count(*) from public.brands b where b.code_profile_key = 'social_mobile_user_v1'
                                          and not exists (select 1 from public.brand_memberships m where m.brand_id = b.id and m.role = 'owner')),
  'deletion_rows_for_current_logins', (select count(*) from public.social_mobile_account_deletions d
                                         where exists (select 1 from auth.users a where a.id = d.user_id)));

select 'C_counts_final='::text || jsonb_build_object(
  'auth_users', (select count(*) from auth.users), 'common_accounts', (select count(*) from public.common_accounts),
  'entitlements', (select count(*) from public.service_entitlements),
  'operations', (select count(*) from private.account_lifecycle_operations),
  'ledger_rows', (select count(*) from supabase_migrations.schema_migrations));
rollback;
