-- SOURCE CANDIDATE ONLY. NOT applied to production. Apply only as a single reviewed file after a
-- separately approved, same-day read-only preflight (never db push).
--
-- POSTONA Phase 2a-2: let public.social_accounts hold Threads and Instagram accounts later, without
-- changing anything for X. Preparation only: no Threads/Instagram connection, credential, publish or
-- deletion path exists yet, and nothing here creates one.
--
-- What changes:
--   CHECK social_accounts_platform_supported          platform is one of x / threads / instagram
--                                                      (replaces the existing CHECK (platform = 'x'))
--   CHECK social_accounts_provider_credential_profile a Threads/Instagram row never has a refresh-token
--                                                      reference (credential profile `long_lived_access`)
--   CHECK social_accounts_meta_connected_access       a connected or identity_verified Threads/Instagram
--                                                      row has its access reference; only the pre-connect
--                                                      states (unconnected / authorization_pending /
--                                                      failed) may lack it
--   CHECK social_accounts_meta_publish_disabled       a Threads/Instagram row cannot be publish-enabled
--                                                      until a reviewed publish path exists (a later
--                                                      migration lifts this deliberately); holds whatever
--                                                      the column default is
--   TRIGGER social_accounts_provider_guard (BEFORE INSERT OR UPDATE, FOR EACH ROW,
--   function public.social_accounts_provider_guard(), SECURITY INVOKER, empty search_path, EXECUTE for
--   the owner only):
--     * a row's provider never changes, for every role and every provider pair, whatever else the same
--       statement changes (a different provider is a different connection: disconnect, then a new row);
--     * a Threads/Instagram row is inserted or updated only by code running as the table owner, i.e. a
--       reviewed SECURITY DEFINER function owned by the owner (none exists yet; the future Threads
--       connection function is the intended one) or the operator. Direct writes by service_role or any
--       other role are refused. X rows are unaffected. DELETE is not guarded (removing a row never
--       creates or widens a credential).
--   X rows, X credential rules (which stay in the X functions) and every existing object are unchanged.
--
-- Reviewed starting contract (repository evidence: the production-shaped fixtures of the 2026-09-28
-- read-only inspection, the migrations that created the identity index, policy and triggers, and the
-- 2026-10-06 read-only S0: owner postgres, not a superuser; exactly these two non-internal triggers;
-- authenticated without INSERT / UPDATE / DELETE). Before any DDL the file refuses, with a fixed code and
-- changing nothing, unless public.social_accounts is exactly:
--   * a plain table (no inheritance, no partitions) with exactly the 14 columns below (name, type,
--     nullability, default, identity/generated, collation) and no other column;
--   * exactly the six constraints below (definition, validated, not deferrable), the platform one being
--     exactly `CHECK ((platform = 'x'::text))`;
--   * exactly the three indexes below, each valid, ready, live and immediate: the primary key,
--     UNIQUE (brand_id, platform) and the provider-identity index UNIQUE (platform, platform_user_id)
--     WHERE (platform_user_id IS NOT NULL) (default operator classes and collations, NULLS DISTINCT,
--     no expression): one provider identity in at most one row, for every provider;
--   * RLS on and not forced, with exactly the member read policy (permissive, SELECT, authenticated);
--   * exactly the two existing triggers (full definition, enabled, function language, SECURITY DEFINER,
--     search_path and body md5);
--   * table ACL: owner; authenticated SELECT only; service_role at most SELECT / INSERT / UPDATE /
--     DELETE / TRUNCATE / REFERENCES / MAINTAIN (never TRIGGER: a trigger it created would run as the
--     owner inside the owner's SECURITY DEFINER functions); nothing grantable; nothing for PUBLIC, anon
--     or any other role; no column ACL;
--   * role graph (PostgreSQL 16+ membership semantics: pg_has_role(..., 'MEMBER') follows every
--     membership path, whatever its INHERIT / SET options): neither anon nor authenticated can reach,
--     by inheritance or SET ROLE, directly or transitively, the owner, a superuser, a BYPASSRLS role,
--     service_role or any role that may insert, update (any column), delete, truncate or add triggers
--     to the table; service_role cannot reach the owner or a superuser;
--   * owner = current_user, not a superuser.
-- Unknown objects or grants are never dropped, revoked or normalized: the file stops. Where production
-- differs from this contract, the contract is corrected through review first.
--
-- Postcondition before COMMIT: the four CHECKs with exactly these definitions, validated; the guard
-- trigger and function exactly as above; and columns, constraints, indexes, policies, triggers, table
-- and column ACLs, the relevant role memberships and every row exactly as before.
--
-- Transaction: one explicit transaction; apply alone with a tool that does NOT wrap the file in another
-- transaction; not re-runnable (ALREADY_APPLIED). The ACCESS EXCLUSIVE lock is taken right after the
-- owner check and held to COMMIT; waiting for it is bounded by lock_timeout (5s), but the run time of
-- the file itself is not (the CHECKs scan the table): the production gate must set an approved
-- statement_timeout / cancel plan. Written for PostgreSQL 17 (NOT NULL is not a pg_constraint row).
begin;

set local lock_timeout = '5s';
set local search_path = '';

-- Everything the change must leave as it was, as one comparable value (session-local helper).
create function pg_temp.postona_accounts_state(p_skip_constraints text[], p_skip_triggers text[])
returns jsonb language sql stable as $$
  select pg_catalog.jsonb_build_object(
    'columns', (select pg_catalog.array_agg(x order by x) from (
                  select pg_catalog.concat_ws(' | ', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                           case when a.attnotnull then 'not null' else 'null' end,
                           coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity::text || a.attgenerated::text,
                           case a.attcollation when 0 then '' when 100 then 'default' else a.attcollation::text end) as x
                  from pg_catalog.pg_attribute a
                  left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = 'public.social_accounts'::regclass and a.attnum > 0 and not a.attisdropped) s),
    'table', (select pg_catalog.concat_ws(' | ', coalesce(c.relacl::text, ''), c.relrowsecurity::text,
                                          c.relforcerowsecurity::text, c.relowner::regrole::text, c.relkind::text)
              from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass),
    'column_acl', (select pg_catalog.array_agg(x order by x) from (
                     select a.attname || '=' || a.attacl::text as x from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.social_accounts'::regclass and a.attacl is not null) s),
    'constraints', (select pg_catalog.array_agg(x order by x) from (
                      select pg_catalog.concat_ws(' | ', c.conname, c.contype::text, pg_catalog.pg_get_constraintdef(c.oid),
                               c.convalidated::text, c.condeferrable::text, c.condeferred::text) as x
                      from pg_catalog.pg_constraint c
                      where c.conrelid = 'public.social_accounts'::regclass and c.conname <> all (p_skip_constraints)) s),
    'indexes', (select pg_catalog.array_agg(x order by x) from (
                  select pg_catalog.pg_get_indexdef(i.indexrelid) || ' | '
                         || pg_catalog.concat_ws(',', i.indisvalid::text, i.indisready::text, i.indislive::text, i.indimmediate::text) as x
                  from pg_catalog.pg_index i where i.indrelid = 'public.social_accounts'::regclass) s),
    'policies', (select pg_catalog.array_agg(x order by x) from (
                   select pg_catalog.concat_ws(' | ', p.polname, p.polcmd::text, p.polpermissive::text,
                            p.polroles::pg_catalog.regrole[]::text, coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), ''),
                            coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')) as x
                   from pg_catalog.pg_policy p where p.polrelid = 'public.social_accounts'::regclass) s),
    'triggers', (select pg_catalog.array_agg(x order by x) from (
                   select pg_catalog.concat_ws(' | ', pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled::text,
                            t.tgfoid::regprocedure::text, p.proowner::regrole::text, p.prosecdef::text,
                            coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''), pg_catalog.md5(p.prosrc)) as x
                   from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid
                   where t.tgrelid = 'public.social_accounts'::regclass and not t.tgisinternal
                     and t.tgname <> all (p_skip_triggers)) s),
    'memberships', (select pg_catalog.array_agg(x order by x) from (
                      select pg_catalog.concat_ws(' | ', m.roleid::regrole::text, m.member::regrole::text,
                               m.inherit_option::text, m.set_option::text, m.admin_option::text) as x
                      from pg_catalog.pg_auth_members m
                      where m.member in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)
                         or m.roleid in ('service_role'::regrole,
                                         (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass))) s),
    'rows', (select pg_catalog.md5(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(sa)::text, ',' order by sa.id), ''))
             from public.social_accounts sa))
$$;

do $$
declare
  v_table oid := pg_catalog.to_regclass('public.social_accounts');
  v_owner oid;
  v_platform smallint;
  v_old_check text;
begin
  if v_table is null then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_MISSING';
  end if;
  if exists (select 1 from pg_catalog.pg_constraint c
             where c.conrelid = v_table
               and c.conname in ('social_accounts_platform_supported', 'social_accounts_provider_credential_profile',
                                 'social_accounts_meta_connected_access', 'social_accounts_meta_publish_disabled'))
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = v_table and t.tgname = 'social_accounts_provider_guard')
     or pg_catalog.to_regprocedure('public.social_accounts_provider_guard()') is not null then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ALREADY_APPLIED';
  end if;
  if pg_catalog.to_regrole('anon') is null or pg_catalog.to_regrole('authenticated') is null
     or pg_catalog.to_regrole('service_role') is null then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ROLES';
  end if;

  -- Owner: ALTER TABLE needs the owner; it must not be a superuser. Checked before anything reads the
  -- table, so another role is refused with this code rather than a permission error.
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = v_table;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_OWNER';
  end if;

  -- From here until COMMIT nobody else reads or writes the table: the checks below, the snapshot and
  -- the change all see one state, and no lock is upgraded midway. Bounded by lock_timeout.
  lock table public.social_accounts in access exclusive mode;

  -- A plain table with exactly the reviewed columns: no other column (a token-shaped one included).
  if (select c.relkind from pg_catalog.pg_class c where c.oid = v_table) is distinct from 'r'
     or exists (select 1 from pg_catalog.pg_inherits h where h.inhrelid = v_table or h.inhparent = v_table)
     or (select pg_catalog.array_agg(x order by x) from (
           select pg_catalog.concat_ws(' | ', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                    case when a.attnotnull then 'not null' else 'null' end,
                    coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity::text || a.attgenerated::text,
                    case a.attcollation when 0 then '' when 100 then 'default' else a.attcollation::text end) as x
           from pg_catalog.pg_attribute a
           left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped) s)
        is distinct from array[
          'brand_id | text | not null |  |  | default',
          'connection_status | text | not null | ''unconnected''::text |  | default',
          'created_at | timestamp with time zone | not null | now() |  | ',
          'handle | text | not null | ''pending''::text |  | default',
          'id | text | not null |  |  | default',
          'last_connection_error_code | text | null |  |  | default',
          'oauth_client_ref | text | not null | ''default''::text |  | default',
          'platform | text | not null | ''x''::text |  | default',
          'platform_user_id | text | null |  |  | default',
          'publish_enabled | boolean | not null | false |  | ',
          'updated_at | timestamp with time zone | not null | now() |  | ',
          'vault_access_token_secret_id | uuid | null |  |  | ',
          'vault_refresh_token_secret_id | uuid | null |  |  | ',
          'verified_at | timestamp with time zone | null |  |  | '] then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_SHAPE';
  end if;
  select a.attnum into v_platform from pg_catalog.pg_attribute a where a.attrelid = v_table and a.attname = 'platform';

  -- The platform CHECK: exactly one CHECK touches `platform`, and it is exactly the X-only rule,
  -- validated (so every existing row is X; a NOT VALID one reads `... NOT VALID` and does not match).
  -- Found by its definition, never by name.
  select c.conname into v_old_check from pg_catalog.pg_constraint c
  where c.conrelid = v_table and c.contype = 'c'
    and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ''x''::text))';
  if (select count(*) from pg_catalog.pg_constraint c
      where c.conrelid = v_table and c.contype = 'c' and v_platform = any (c.conkey)) <> 1
     or v_old_check is null then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK';
  end if;

  -- Indexes, compared by definition without the index name, and usable (valid, ready, live, immediate).
  -- One account per workspace and provider:
  if not exists (select 1 from pg_catalog.pg_index i
                 where i.indrelid = v_table and i.indisvalid and i.indisready and i.indislive and i.indimmediate
                   and pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )\S+ ON ', '\1ON ')
                       = 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (brand_id, platform)') then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_UNIQUE';
  end if;
  -- One provider identity in at most one row, for every provider (the predicate covers every row that
  -- has an identity; default operator classes and collations, NULLS DISTINCT, no expression; the
  -- definition text would show any of those).
  if not exists (select 1 from pg_catalog.pg_index i
                 where i.indrelid = v_table and i.indisvalid and i.indisready and i.indislive and i.indimmediate
                   and pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )\S+ ON ', '\1ON ')
                       = 'CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id) WHERE (platform_user_id IS NOT NULL)') then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_IDENTITY_UNIQUE';
  end if;
  -- Every constraint (names are not compared; definitions, validation and deferrability are) and
  -- every index.
  if (select pg_catalog.array_agg(x order by x) from (
        select pg_catalog.concat_ws(' | ', c.contype::text, pg_catalog.pg_get_constraintdef(c.oid), c.convalidated::text,
                 c.condeferrable::text, c.condeferred::text) as x
        from pg_catalog.pg_constraint c where c.conrelid = v_table) s)
     is distinct from array[
       'c | CHECK ((connection_status = ANY (ARRAY[''unconnected''::text, ''authorization_pending''::text, ''connected''::text, ''identity_verified''::text, ''failed''::text]))) | true | false | false',
       'c | CHECK ((id ~ ''^[a-z][a-z0-9_]{1,80}$''::text)) | true | false | false',
       'c | CHECK ((platform = ''x''::text)) | true | false | false',
       'f | FOREIGN KEY (brand_id) REFERENCES public.brands(id) | true | false | false',
       'p | PRIMARY KEY (id) | true | false | false',
       'u | UNIQUE (brand_id, platform) | true | false | false'] then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_CONSTRAINTS';
  end if;
  if (select pg_catalog.array_agg(x order by x) from (
        select pg_catalog.regexp_replace(pg_catalog.pg_get_indexdef(i.indexrelid), '^(CREATE (UNIQUE )?INDEX )\S+ ON ', '\1ON ')
               || ' | ' || (i.indisvalid and i.indisready and i.indislive and i.indimmediate)::text as x
        from pg_catalog.pg_index i where i.indrelid = v_table) s)
     is distinct from array[
       'CREATE UNIQUE INDEX ON public.social_accounts USING btree (brand_id, platform) | true',
       'CREATE UNIQUE INDEX ON public.social_accounts USING btree (id) | true',
       'CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id) WHERE (platform_user_id IS NOT NULL) | true'] then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_INDEXES';
  end if;

  -- RLS on, not forced (the owner's checks and snapshot must see every row), exactly the member read policy.
  if (select c.relrowsecurity and not c.relforcerowsecurity from pg_catalog.pg_class c where c.oid = v_table) is not true
     or (select pg_catalog.array_agg(x order by x) from (
           select pg_catalog.concat_ws(' | ', p.polname, p.polcmd::text, p.polpermissive::text,
                    p.polroles::pg_catalog.regrole[]::text, coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), ''),
                    coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')) as x
           from pg_catalog.pg_policy p where p.polrelid = v_table) s)
        is distinct from array[
          'social_mobile_member_select_social_accounts | r | true | {authenticated} | (EXISTS ( SELECT 1
   FROM public.brand_memberships bm
  WHERE ((bm.brand_id = social_accounts.brand_id) AND (bm.user_id = ( SELECT auth.uid() AS uid))))) | '] then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_POLICIES';
  end if;

  -- Exactly the two existing triggers: full definition, enabled, and their functions' language,
  -- SECURITY DEFINER, search_path and body.
  if (select pg_catalog.array_agg(x order by x) from (
        select pg_catalog.concat_ws(' | ', pg_catalog.pg_get_triggerdef(t.oid), t.tgenabled::text, l.lanname,
                 p.prosecdef::text, coalesce(p.proconfig::text, ''), pg_catalog.md5(p.prosrc)) as x
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_proc p on p.oid = t.tgfoid
        join pg_catalog.pg_language l on l.oid = p.prolang
        where t.tgrelid = v_table and not t.tgisinternal) s)
     is distinct from array[
       'CREATE TRIGGER social_accounts_x_refresh_reset_on_reconnect AFTER UPDATE OF verified_at ON public.social_accounts FOR EACH ROW WHEN (((new.connection_status = ''identity_verified''::text) AND (new.verified_at IS DISTINCT FROM old.verified_at))) EXECUTE FUNCTION public.x_account_refresh_reset_on_reconnect() | O | plpgsql | true | {"search_path=\"\""} | 2d50233f129216a8f6580734835ced39',
       'CREATE TRIGGER social_mobile_deletion_guard BEFORE INSERT OR UPDATE ON public.social_accounts FOR EACH ROW EXECUTE FUNCTION public.social_mobile_account_deletion_guard() | O | plpgsql | true | {"search_path=\"\""} | dc37138099df32c24142addf012e9132'] then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_TRIGGERS';
  end if;

  -- Table and column ACL: the owner; authenticated SELECT (the member read policy needs it) and
  -- nothing else; service_role DML but never TRIGGER; nothing grantable; nobody else (PUBLIC and anon
  -- included); no column grants.
  if exists (select 1 from pg_catalog.pg_class c,
                    pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
             where c.oid = v_table and a.grantee <> v_owner
               and not (a.grantee = 'authenticated'::regrole and a.privilege_type = 'SELECT' and not a.is_grantable)
               and not (a.grantee = 'service_role'::regrole and not a.is_grantable
                        and a.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'MAINTAIN')))
     or not exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
                    where c.oid = v_table and a.grantee = 'authenticated'::regrole and a.privilege_type = 'SELECT')
     or exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = v_table and a.attnum > 0 and a.attacl is not null) then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ACL';
  end if;

  -- Role graph, by every membership path (MEMBER: inherited or SET ROLE only, direct or transitive).
  if exists (select 1
             from (values ('anon'::name), ('authenticated'::name)) a(app)
             join pg_catalog.pg_roles r on pg_catalog.pg_has_role(a.app, r.oid, 'MEMBER')
             where r.oid = v_owner or r.rolsuper or r.rolbypassrls or r.rolname = 'service_role'
                or pg_catalog.has_any_column_privilege(r.oid, v_table, 'INSERT')
                or pg_catalog.has_any_column_privilege(r.oid, v_table, 'UPDATE')
                or pg_catalog.has_table_privilege(r.oid, v_table, 'DELETE')
                or pg_catalog.has_table_privilege(r.oid, v_table, 'TRUNCATE')
                or pg_catalog.has_table_privilege(r.oid, v_table, 'TRIGGER'))
     or pg_catalog.pg_has_role('service_role', v_owner, 'MEMBER')
     or exists (select 1 from pg_catalog.pg_roles r
                where r.rolsuper and pg_catalog.pg_has_role('service_role', r.oid, 'MEMBER')) then
    raise exception 'POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH';
  end if;

  -- Snapshot of everything that must come out unchanged (compared before COMMIT).
  perform pg_catalog.set_config('postona.accounts_before',
    pg_temp.postona_accounts_state(array[v_old_check], array[]::text[])::text, true);

  execute pg_catalog.format('alter table public.social_accounts drop constraint %I', v_old_check);
end $$;

alter table public.social_accounts
  add constraint social_accounts_platform_supported check (platform in ('x', 'threads', 'instagram'));
alter table public.social_accounts
  add constraint social_accounts_provider_credential_profile check (platform = 'x' or vault_refresh_token_secret_id is null);
alter table public.social_accounts
  add constraint social_accounts_meta_connected_access
  check (platform = 'x' or vault_access_token_secret_id is not null
         or connection_status in ('unconnected', 'authorization_pending', 'failed'));
alter table public.social_accounts
  add constraint social_accounts_meta_publish_disabled check (platform = 'x' or publish_enabled is false);

create function public.social_accounts_provider_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- A row's provider never changes, whoever writes and whatever else the statement changes.
  if tg_op = 'UPDATE' and new.platform is distinct from old.platform then
    raise exception 'SOCIAL_ACCOUNT_PROVIDER_IMMUTABLE' using errcode = 'P0001';
  end if;
  -- Threads/Instagram rows are written only as the table owner (a reviewed SECURITY DEFINER function
  -- owned by it, or the operator). current_user is the role running the statement, or the owner of
  -- the SECURITY DEFINER function running it; this function itself is SECURITY INVOKER.
  if new.platform is distinct from 'x'
     and (select c.relowner from pg_catalog.pg_class c where c.oid = tg_relid)
         is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'SOCIAL_ACCOUNT_PROVIDER_WRITE_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.social_accounts_provider_guard() from public, anon, authenticated, service_role;
create trigger social_accounts_provider_guard
  before insert or update on public.social_accounts
  for each row execute function public.social_accounts_provider_guard();

-- Postcondition.
do $$
declare
  v_table oid := 'public.social_accounts'::regclass;
  v_owner oid := (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass);
  v_platform smallint := (select a.attnum from pg_catalog.pg_attribute a
                          where a.attrelid = 'public.social_accounts'::regclass and a.attname = 'platform');
  v_fn oid := pg_catalog.to_regprocedure('public.social_accounts_provider_guard()');
  v_new text[] := array['social_accounts_platform_supported', 'social_accounts_provider_credential_profile',
                        'social_accounts_meta_connected_access', 'social_accounts_meta_publish_disabled'];
begin
  -- Exactly the four CHECKs, with exactly these definitions, validated; no other CHECK touches platform.
  if (select pg_catalog.array_agg(x order by x) from (
        select pg_catalog.concat_ws(' | ', c.conname, pg_catalog.pg_get_constraintdef(c.oid), c.convalidated::text) as x
        from pg_catalog.pg_constraint c where c.conrelid = v_table and c.conname = any (v_new)) s)
     is distinct from array[
       'social_accounts_meta_connected_access | CHECK (((platform = ''x''::text) OR (vault_access_token_secret_id IS NOT NULL) OR (connection_status = ANY (ARRAY[''unconnected''::text, ''authorization_pending''::text, ''failed''::text])))) | true',
       'social_accounts_meta_publish_disabled | CHECK (((platform = ''x''::text) OR (publish_enabled IS FALSE))) | true',
       'social_accounts_platform_supported | CHECK ((platform = ANY (ARRAY[''x''::text, ''threads''::text, ''instagram''::text]))) | true',
       'social_accounts_provider_credential_profile | CHECK (((platform = ''x''::text) OR (vault_refresh_token_secret_id IS NULL))) | true']
     or exists (select 1 from pg_catalog.pg_constraint c
                where c.conrelid = v_table and c.contype = 'c' and v_platform = any (c.conkey) and not (c.conname = any (v_new))) then
    raise exception 'POSTONA_ACCOUNTS_POSTCONDITION_CONSTRAINTS';
  end if;
  -- The guard: exactly this trigger, enabled, on exactly this function; the function owned by the
  -- table owner, SECURITY INVOKER, plpgsql, empty search_path, EXECUTE for the owner only.
  if (select pg_catalog.array_agg(pg_catalog.pg_get_triggerdef(t.oid) || ' | ' || t.tgenabled::text)
      from pg_catalog.pg_trigger t where t.tgrelid = v_table and t.tgname = 'social_accounts_provider_guard')
     is distinct from array['CREATE TRIGGER social_accounts_provider_guard BEFORE INSERT OR UPDATE ON public.social_accounts FOR EACH ROW EXECUTE FUNCTION public.social_accounts_provider_guard() | O']
     or v_fn is null
     or (select p.proowner = v_owner and not p.prosecdef and p.proconfig = array['search_path=""']
                and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
         from pg_catalog.pg_proc p where p.oid = v_fn) is not true
     or exists (select 1 from pg_catalog.pg_proc p,
                       pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                where p.oid = v_fn and a.grantee <> p.proowner) then
    raise exception 'POSTONA_ACCOUNTS_POSTCONDITION_GUARD';
  end if;
  -- Everything else exactly as before.
  if pg_temp.postona_accounts_state(v_new, array['social_accounts_provider_guard'])
     is distinct from pg_catalog.current_setting('postona.accounts_before')::jsonb then
    raise exception 'POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED';
  end if;
end $$;

drop function pg_temp.postona_accounts_state(text[], text[]);

commit;
