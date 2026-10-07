-- SOURCE CANDIDATE ONLY. NOT applied to production. Apply only as a single reviewed file after a
-- separately approved, same-day read-only preflight (never db push).
--
-- POSTONA Phase 2a-2: let public.social_accounts hold Threads and Instagram accounts later, without
-- changing anything for X. Preparation only: no Threads/Instagram connection, credential, publish or
-- deletion path exists yet, and nothing here creates one.
--
-- What changes (three CHECK constraints; nothing else):
--   social_accounts_platform_supported         platform is one of x / threads / instagram
--                                              (replaces the existing CHECK (platform = 'x'))
--   social_accounts_provider_credential_profile a Threads/Instagram row has no refresh-token reference:
--                                              those providers keep one long-lived access credential
--                                              (credential profile `long_lived_access`). X rows are
--                                              unconstrained here, exactly as today.
--   social_accounts_meta_publish_disabled      a Threads/Instagram row cannot be publish-enabled until a
--                                              reviewed publish path for it exists (a later migration
--                                              lifts this deliberately). Holds whatever the column
--                                              default is: a Meta insert that omits publish_enabled
--                                              under a default of true is refused, never enabled.
--
-- What does not change: every column, default, uniqueness rule (including UNIQUE (brand_id, platform)
-- and (platform, platform_user_id)), RLS policy, grant, trigger and row; every X invariant, which stays
-- in the functions that enforce it today (x_legacy_post_account, the publish switch and pre-send check,
-- refresh core, deletion). Those functions pick the workspace's account with `platform = 'x'` or refuse
-- a non-X account (the publish switch answers PLATFORM_NOT_SUPPORTED), and account deletion sends a
-- workspace with a non-X connected row to operator review (refresh material missing) before any token
-- is read out.
--
-- The existing production CHECK is found by its exact definition, never guessed by name. The file
-- refuses (and so changes nothing) when the table is not in the expected shape: platform not exactly
-- `CHECK ((platform = 'x'::text))` validated, missing UNIQUE (brand_id, platform), unexpected column
-- types or nullability, an inheritance/partitioned table, RLS off or forced, an application role able
-- to write the table, a creator that is not the non-superuser table owner, or an application role
-- that inherits the owner or service_role.
--
-- Transaction: one explicit transaction; apply alone with a tool that does NOT wrap the file in another
-- transaction; not re-runnable. Lock waits are bounded; on timeout nothing is changed.
begin;

set local lock_timeout = '5s';

do $$
declare
  v_table oid := to_regclass('public.social_accounts');
  v_platform smallint;
  v_brand smallint;
  v_checks integer;
  v_old_check text;
begin
  if v_table is null then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_MISSING';
  end if;
  if exists (select 1 from pg_catalog.pg_constraint c
             where c.conrelid = v_table
               and c.conname in ('social_accounts_platform_supported', 'social_accounts_provider_credential_profile',
                                 'social_accounts_meta_publish_disabled')) then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ALREADY_APPLIED';
  end if;
  if to_regrole('anon') is null or to_regrole('authenticated') is null or to_regrole('service_role') is null then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ROLES';
  end if;

  -- Owner: ALTER TABLE needs the owner; it must not be a superuser. Checked before anything reads the
  -- table, so another role is refused with this code rather than a permission error.
  if (select c.relowner from pg_catalog.pg_class c where c.oid = v_table)
       is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_OWNER';
  end if;
  if pg_catalog.pg_has_role('anon', current_user, 'usage') or pg_catalog.pg_has_role('authenticated', current_user, 'usage')
     or pg_catalog.pg_has_role('anon', 'service_role', 'usage') or pg_catalog.pg_has_role('authenticated', 'service_role', 'usage') then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH';
  end if;

  -- From here until COMMIT nobody else reads or writes the table: the checks below, the snapshot and
  -- the change all see one state, and no lock is upgraded midway. Bounded by lock_timeout.
  lock table public.social_accounts in access exclusive mode;

  -- A plain table (no inheritance, no partitions) with the columns the constraints rely on, with the
  -- expected types and nullability.
  if (select c.relkind from pg_catalog.pg_class c where c.oid = v_table) is distinct from 'r'
     or exists (select 1 from pg_catalog.pg_inherits h where h.inhrelid = v_table or h.inhparent = v_table)
     or (select count(*) from pg_catalog.pg_attribute a
         where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped
           and ((a.attname = 'platform' and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text' and a.attnotnull)
             or (a.attname = 'brand_id' and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text' and a.attnotnull)
             or (a.attname = 'publish_enabled' and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'boolean' and a.attnotnull)
             or (a.attname = 'vault_access_token_secret_id' and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'uuid')
             or (a.attname = 'vault_refresh_token_secret_id' and pg_catalog.format_type(a.atttypid, a.atttypmod) = 'uuid'))) <> 5 then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_SHAPE';
  end if;
  select a.attnum into v_platform from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attname = 'platform';
  select a.attnum into v_brand from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attname = 'brand_id';

  -- The platform CHECK: exactly one CHECK touches `platform`, and it is exactly the X-only rule,
  -- validated (so every existing row is X; a NOT VALID one reads `... NOT VALID` and does not match).
  -- Anything else is drift this file does not interpret.
  select count(*) into v_checks from pg_catalog.pg_constraint c
  where c.conrelid = v_table and c.contype = 'c' and v_platform = any (c.conkey);
  select c.conname into v_old_check from pg_catalog.pg_constraint c
  where c.conrelid = v_table and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ''x''::text))';
  if v_checks <> 1 or v_old_check is null then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK';
  end if;

  -- One account per brand and platform stays the rule: a plain, valid unique index on exactly those columns.
  if not exists (select 1 from pg_catalog.pg_index i
                 where i.indrelid = v_table and i.indisunique and i.indisvalid and i.indpred is null
                   and i.indexprs is null and i.indnkeyatts = 2
                   and (select array_agg(k order by k) from unnest(i.indkey::smallint[]) k)
                         = (select array_agg(k order by k) from unnest(array[v_brand, v_platform]) k)) then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_UNIQUE';
  end if;

  -- Application roles only read, through RLS; neither may write the table in any way (a table or
  -- column grant, to them, to PUBLIC or to a role they inherit). Widening `platform` on a table users
  -- can write would let a user create provider rows directly. RLS must not be FORCEd: the owner's
  -- checks above and the snapshot below must see every row.
  if (select c.relrowsecurity and not c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = v_table) is not true
     or exists (select 1 from unnest(array['anon', 'authenticated']) r
                where pg_catalog.has_any_column_privilege(r, v_table, 'INSERT')
                   or pg_catalog.has_any_column_privilege(r, v_table, 'UPDATE')
                   or pg_catalog.has_table_privilege(r, v_table, 'DELETE')
                   or pg_catalog.has_table_privilege(r, v_table, 'TRUNCATE')) then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ACL';
  end if;

  -- Snapshot of everything that must come out unchanged (compared before COMMIT).
  perform pg_catalog.set_config('postona.accounts_before', (
    select pg_catalog.jsonb_build_object(
      'columns', (select pg_catalog.string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
                                               || ':' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ',' order by a.attnum)
                  from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped),
      'acl', (select coalesce(c.relacl::text, '') || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || c.relowner
              from pg_catalog.pg_class c where c.oid = v_table),
      'column_acl', (select coalesce(pg_catalog.string_agg(a.attname || '=' || a.attacl::text, ',' order by a.attnum), '')
                     from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attacl is not null),
      'policies', (select coalesce(pg_catalog.string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':'
                                                         || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ':'
                                                         || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''), ',' order by p.polname), '')
                   from pg_catalog.pg_policy p where p.polrelid = v_table),
      'triggers', (select coalesce(pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text, ',' order by t.tgname), '')
                   from pg_catalog.pg_trigger t where t.tgrelid = v_table and not t.tgisinternal),
      'indexes', (select coalesce(pg_catalog.string_agg(pg_catalog.pg_get_indexdef(i.indexrelid), ',' order by i.indexrelid), '')
                  from pg_catalog.pg_index i where i.indrelid = v_table),
      'other_constraints', (select coalesce(pg_catalog.string_agg(c.conname || ':' || pg_catalog.pg_get_constraintdef(c.oid), ',' order by c.conname), '')
                            from pg_catalog.pg_constraint c where c.conrelid = v_table and c.conname <> v_old_check),
      'rows', (select pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(sa)::text, ',' order by sa.id), ''))
               from public.social_accounts sa))::text
  ), true);

  execute pg_catalog.format('alter table public.social_accounts drop constraint %I', v_old_check);
end $$;

alter table public.social_accounts
  add constraint social_accounts_platform_supported check (platform in ('x', 'threads', 'instagram'));
alter table public.social_accounts
  add constraint social_accounts_provider_credential_profile check (platform = 'x' or vault_refresh_token_secret_id is null);
alter table public.social_accounts
  add constraint social_accounts_meta_publish_disabled check (platform = 'x' or publish_enabled is false);

-- Postcondition: the three constraints exist and are validated, no other CHECK touches `platform`, and
-- columns, grants, RLS, policies, triggers, indexes, every other constraint and every row are unchanged.
do $$
declare
  v_table oid := 'public.social_accounts'::regclass;
  v_platform smallint := (select a.attnum from pg_catalog.pg_attribute a where a.attrelid = 'public.social_accounts'::regclass and a.attname = 'platform');
  v_before jsonb := pg_catalog.current_setting('postona.accounts_before')::jsonb;
  v_new text[] := array['social_accounts_platform_supported', 'social_accounts_provider_credential_profile', 'social_accounts_meta_publish_disabled'];
begin
  if (select count(*) from pg_catalog.pg_constraint c
      where c.conrelid = v_table and c.contype = 'c' and c.convalidated and c.conname = any (v_new)) <> 3
     or exists (select 1 from pg_catalog.pg_constraint c
                where c.conrelid = v_table and c.contype = 'c' and v_platform = any (c.conkey) and not (c.conname = any (v_new))) then
    raise exception 'POSTONA_ACCOUNTS_POSTCONDITION_CONSTRAINTS';
  end if;
  if v_before is distinct from pg_catalog.jsonb_build_object(
      'columns', (select pg_catalog.string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
                                               || ':' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ',' order by a.attnum)
                  from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped),
      'acl', (select coalesce(c.relacl::text, '') || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || c.relowner
              from pg_catalog.pg_class c where c.oid = v_table),
      'column_acl', (select coalesce(pg_catalog.string_agg(a.attname || '=' || a.attacl::text, ',' order by a.attnum), '')
                     from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attacl is not null),
      'policies', (select coalesce(pg_catalog.string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':'
                                                         || coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ':'
                                                         || coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''), ',' order by p.polname), '')
                   from pg_catalog.pg_policy p where p.polrelid = v_table),
      'triggers', (select coalesce(pg_catalog.string_agg(t.tgname || ':' || t.tgenabled::text, ',' order by t.tgname), '')
                   from pg_catalog.pg_trigger t where t.tgrelid = v_table and not t.tgisinternal),
      'indexes', (select coalesce(pg_catalog.string_agg(pg_catalog.pg_get_indexdef(i.indexrelid), ',' order by i.indexrelid), '')
                  from pg_catalog.pg_index i where i.indrelid = v_table),
      'other_constraints', (select coalesce(pg_catalog.string_agg(c.conname || ':' || pg_catalog.pg_get_constraintdef(c.oid), ',' order by c.conname), '')
                            from pg_catalog.pg_constraint c where c.conrelid = v_table and not (c.conname = any (v_new))),
      'rows', (select pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(sa)::text, ',' order by sa.id), ''))
               from public.social_accounts sa)) then
    raise exception 'POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED';
  end if;
end $$;

commit;
