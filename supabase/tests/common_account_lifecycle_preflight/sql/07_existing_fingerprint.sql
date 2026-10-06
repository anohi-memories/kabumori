-- Production preflight / read-back (read-only). Fingerprint of everything that already exists in schemas public and
-- private (the foundation's own names excluded). Taken now and again right after the apply:
-- equal hashes prove the migration changed no existing table, column, constraint, index,
-- policy, trigger, function, grant, type or default privilege there. Code and ACL text are
-- hashed, never printed. Every aggregate has an explicit C-collation order.
with tgt_rel(n) as (values
  ('common_accounts'), ('common_accounts_pkey'), ('service_entitlements'), ('service_entitlements_pkey'),
  ('account_lifecycle_operations'), ('account_lifecycle_operations_pkey'),
  ('account_lifecycle_operations_one_in_progress'), ('account_lifecycle_settings'),
  ('account_lifecycle_settings_pkey'), ('account_lifecycle_managed_checkpoints'),
  ('account_lifecycle_managed_checkpoints_pkey'), ('account_lifecycle_backfill_plan')),
tgt_fn(n) as (values
  ('account_lifecycle_builtin_checkpoints'), ('account_lifecycle_lock'), ('account_lifecycle_invalidate_readiness'),
  ('account_lifecycle_touch_account'), ('account_lifecycle_account_changed'),
  ('account_lifecycle_guard_entitlement_identity'), ('account_lifecycle_touch_entitlement'),
  ('account_lifecycle_guard_checkpoint_registry'), ('account_lifecycle_requirements_changed'),
  ('account_lifecycle_touch_settings'), ('account_lifecycle_settings_changed'), ('account_lifecycle_footprint'),
  ('account_lifecycle_deletion_blockers'), ('account_lifecycle_managed_ownership'),
  ('account_lifecycle_requirements_valid'), ('account_lifecycle_required_checkpoints'),
  ('account_lifecycle_readiness_refusal'), ('account_lifecycle_authorization_problems'),
  ('account_lifecycle_start_service'), ('account_lifecycle_guard_account_delete'), ('account_lifecycle_backfill'),
  ('start_kabumori_service'), ('start_x_autopost_service'), ('common_account_deletion_eligibility'),
  ('begin_service_deletion'), ('finish_service_deletion'), ('abort_service_deletion'),
  ('withdraw_kabumori_service'), ('begin_common_account_deletion'),
  ('record_common_account_deletion_checkpoint'), ('clear_common_account_deletion_checkpoint'),
  ('abort_common_account_deletion'), ('prepare_common_account_auth_delete')),
rel as (
  select c.oid, n.nspname || '.' || c.relname as qname, c.relkind
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S')
     and c.relname not in (select n from tgt_rel)),
sections(name, cnt, body) as (
  select 'relations', count(*), string_agg(
           r.qname || ' kind=' || r.relkind::text || ' owner=' || pg_get_userbyid(c.relowner) ||
           ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity || ' persist=' || c.relpersistence::text ||
           ' opts=' || coalesce(array_to_string(c.reloptions, ','), '') ||
           ' comment=' || md5(coalesce(obj_description(c.oid, 'pg_class'), '')) ||
           ' view=' || case when c.relkind in ('v', 'm') then md5(pg_get_viewdef(c.oid)) else '-' end ||
           ' cols=' || coalesce((
             select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' ||
                               coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ':' || a.attidentity::text || ':' ||
                               a.attgenerated::text || ':' || coalesce(array_to_string(a.attacl::text[], ';'), '-'),
                               '|' order by a.attnum)
               from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '') ||
           ' acl=' || md5(coalesce((select string_agg(k, ',' order by k collate "C")
                             from (select (case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end) || ':' ||
                                          x.privilege_type || ':' || x.is_grantable as k
                                     from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x) z), '')),
           E'\n' order by r.qname collate "C")
    from rel r join pg_class c on c.oid = r.oid
  union all
  select 'constraints', count(*), string_agg(r.qname || ' ' || k.conname || ' ' || k.contype::text || ' ' ||
           pg_get_constraintdef(k.oid) || ' valid=' || k.convalidated || ' defer=' || k.condeferrable || '/' || k.condeferred,
           E'\n' order by r.qname collate "C", k.conname collate "C")
    from rel r join pg_constraint k on k.conrelid = r.oid
  union all
  select 'indexes', count(*), string_agg(r.qname || ' ' || i.relname || ' valid=' || x.indisvalid || ' ready=' || x.indisready ||
           ' live=' || x.indislive || ' ' || pg_get_indexdef(i.oid),
           E'\n' order by r.qname collate "C", i.relname collate "C")
    from rel r join pg_index x on x.indrelid = r.oid join pg_class i on i.oid = x.indexrelid
  union all
  select 'policies', count(*), string_agg(r.qname || ' ' || p.polname || ' perm=' || p.polpermissive || ' cmd=' || p.polcmd::text ||
           ' roles=' || (select string_agg(case when ro = 0 then 'PUBLIC' else pg_get_userbyid(ro) end, ',' order by (case when ro = 0 then 'PUBLIC' else pg_get_userbyid(ro) end) collate "C")
                           from unnest(p.polroles) ro) ||
           ' using=' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-') ||
           ' check=' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'),
           E'\n' order by r.qname collate "C", p.polname collate "C")
    from rel r join pg_policy p on p.polrelid = r.oid
  union all
  select 'triggers', count(*), string_agg(r.qname || ' ' || t.tgname || ' enabled=' || t.tgenabled::text || ' ' ||
           pg_get_triggerdef(t.oid), E'\n' order by r.qname collate "C", t.tgname collate "C")
    from rel r join pg_trigger t on t.tgrelid = r.oid where not t.tgisinternal
  union all
  select 'functions', count(*), string_agg(
           n.nspname || '.' || p.proname || '(' || coalesce((
             select string_agg(format_type(u.t, null), ',' order by u.ord)
               from unnest(p.proargtypes::oid[]) with ordinality as u(t, ord)), '') || ')' ||
           ' kind=' || p.prokind::text || ' owner=' || pg_get_userbyid(p.proowner) || ' secdef=' || p.prosecdef ||
           ' config=' || coalesce(array_to_string(p.proconfig, ','), '-') || ' vol=' || p.provolatile::text ||
           ' strict=' || p.proisstrict || ' def=' || md5(case when p.prokind = 'a' then p.proname else pg_get_functiondef(p.oid) end) ||
           ' acl=' || md5(coalesce((select string_agg(k, ',' order by k collate "C")
                             from (select (case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end) || ':' ||
                                          x.privilege_type || ':' || x.is_grantable as k
                                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x) z), '')),
           E'\n' order by n.nspname collate "C", p.proname collate "C",
                          coalesce((select string_agg(format_type(u.t, null), ',' order by u.ord)
                                      from unnest(p.proargtypes::oid[]) with ordinality as u(t, ord)), '') collate "C")
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.proname not in (select n from tgt_fn)
  union all
  select 'types', count(*), string_agg(n.nspname || '.' || t.typname || ' ' || t.typtype::text || ' owner=' || pg_get_userbyid(t.typowner) ||
           ' labels=' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '-') ||
           ' base=' || coalesce(format_type(t.typbasetype, t.typtypmod), '-') ||
           ' acl=' || coalesce(array_to_string(t.typacl::text[], ';'), '-'),
           E'\n' order by n.nspname collate "C", t.typname collate "C")
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname in ('public', 'private') and t.typtype in ('e', 'd', 'r', 'm')
  union all
  select 'schemas_and_default_acls', count(*), string_agg(line, E'\n' order by line collate "C")
    from (select 'schema ' || n.nspname || ' owner=' || pg_get_userbyid(n.nspowner) || ' acl=' ||
                 coalesce(array_to_string(n.nspacl::text[], ';'), '-') as line
            from pg_namespace n where n.nspname in ('public', 'private')
          union all
          select 'default ' || pg_get_userbyid(d.defaclrole) || ' ' ||
                 coalesce((select nspname from pg_namespace where oid = d.defaclnamespace), '*') || ' ' ||
                 d.defaclobjtype::text || ' ' || array_to_string(d.defaclacl::text[], ';')
            from pg_default_acl d) s
)
select jsonb_build_object(
  'sections', (select jsonb_object_agg(name, jsonb_build_object('count', cnt,
                        'sha256', encode(sha256(convert_to(coalesce(body, '<empty>'), 'UTF8')), 'hex')))
                 from sections),
  'combined_sha256', (select encode(sha256(convert_to(string_agg(name || '=' || coalesce(body, '<empty>'), E'\n' order by name collate "C"), 'UTF8')), 'hex')
                        from sections)
) as result;
