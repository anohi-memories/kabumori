-- SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed activation.
--
-- Stage 3B: the one narrow publish-time read of a user's content settings.
--
-- public.social_mobile_content_settings stays closed to service_role (final
-- PR81 hardening grants it nothing). The generic Vault-account brand_post path
-- (_shared/brand/vault_account_brand_post.ts) and the publish-authority check
-- (check_x_account_publish_authority) read a brand's consent and remembered
-- settings only through this function, which answers only when:
--   - the scheduled post exists, is a running brand_post of exactly that brand,
--     and is a brand-bound row (no social_account_id), i.e. the post being
--     published right now;
--   - the brand's code profile is social_mobile_user_v1 (Kabumori, AI Lab and
--     any other internal profile can never be read through here);
-- and then returns only that brand's settings / persona columns (zero rows
-- when the user saved nothing). No user id, email, token, Vault or account
-- data; no mutation.
--
-- SECURITY DEFINER (owned by the settings table owner) only because
-- service_role has no table privilege; search_path = ''; EXECUTE for
-- service_role only. The file refuses (and rolls back completely) if
-- service_role can reach the table or ANY column by any effective privilege
-- (direct, inherited or via PUBLIC), if the creator is not the non-superuser
-- table owner, if an application role inherits the owner or service_role, or
-- if the function ends with any grantee besides owner + plain service_role
-- EXECUTE.
--
-- Requires: PR81 settings table + hardening (20260922045046, 20261003120000)
-- and the Stage 3B completion RPC (20261006160000).
-- Transaction: one explicit transaction; apply alone; not re-runnable.
begin;

do $$
begin
  if to_regclass('public.social_mobile_content_settings') is null
     or to_regprocedure('public.social_mobile_content_settings_valid_settings(jsonb)') is null
     or to_regprocedure('public.social_mobile_content_settings_valid_persona(jsonb)') is null
     or to_regclass('public.scheduled_posts') is null
     or to_regprocedure('public.complete_vault_account_brand_post(uuid,text,text,text)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = 'public.brands'::regclass and a.attname = 'code_profile_key'
                      and a.attnum > 0 and not a.attisdropped) then
    raise exception 'PUBLISH_SETTINGS_READER_PRECONDITION_MISSING';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
             where p.pronamespace = 'public'::regnamespace and p.proname = 'read_social_mobile_publish_settings') then
    raise exception 'PUBLISH_SETTINGS_READER_PRECONDITION_ALREADY_APPLIED';
  end if;
  if to_regrole('anon') is null or to_regrole('authenticated') is null or to_regrole('service_role') is null then
    raise exception 'PUBLISH_SETTINGS_READER_PRECONDITION_ROLES';
  end if;
  -- Safe owner: the creator is the non-superuser owner of the settings table (the definer runs as it).
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_mobile_content_settings'::regclass)
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'PUBLISH_SETTINGS_READER_PRECONDITION_OWNER';
  end if;
  -- Application roles must not inherit the owner or service_role.
  if pg_catalog.pg_has_role('anon', current_user, 'usage') or pg_catalog.pg_has_role('authenticated', current_user, 'usage')
     or pg_catalog.pg_has_role('anon', 'service_role', 'usage') or pg_catalog.pg_has_role('authenticated', 'service_role', 'usage') then
    raise exception 'PUBLISH_SETTINGS_READER_PRECONDITION_ROLE_GRAPH';
  end if;
  -- The reader is only narrow if service_role cannot reach the table any other way: no effective
  -- privilege on the table or on ANY live column -- direct, inherited from another role, or via PUBLIC.
  -- Unknown drift is refused, never normalized (authenticated's PR81 client privileges are untouched).
  if pg_catalog.has_table_privilege('service_role', 'public.social_mobile_content_settings',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       || case when pg_catalog.current_setting('server_version_num')::integer >= 170000 then ',MAINTAIN' else '' end)
     or exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = 'public.social_mobile_content_settings'::regclass and a.attnum > 0 and not a.attisdropped
                  and pg_catalog.has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT,INSERT,UPDATE,REFERENCES')) then
    raise exception 'PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS';
  end if;
end $$;

create function public.read_social_mobile_publish_settings(p_scheduled_post_id uuid, p_brand_id text)
returns table (
  settings jsonb,
  persona_profile jsonb,
  persona_provenance text,
  persona_confirmed boolean,
  persona_last_analyzed_at timestamptz,
  persona_last_analyzed_count integer
)
language plpgsql stable security definer set search_path = '' as $$
declare v_post public.scheduled_posts%rowtype;
        v_profile text;
begin
  if p_scheduled_post_id is null or p_brand_id is null or p_brand_id !~ '^[A-Za-z0-9_-]{1,80}$' then
    raise exception 'SOCIAL_MOBILE_PUBLISH_SETTINGS_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select sp.* into v_post from public.scheduled_posts sp where sp.id = p_scheduled_post_id;
  if not found or v_post.status is distinct from 'running' or v_post.post_type is distinct from 'brand_post'
     or v_post.brand_id is distinct from p_brand_id
     or (pg_catalog.to_jsonb(v_post) ->> 'social_account_id') is not null then
    raise exception 'SOCIAL_MOBILE_PUBLISH_SETTINGS_POST_NOT_RUNNING' using errcode = 'P0001';
  end if;
  select b.code_profile_key into v_profile from public.brands b where b.id = p_brand_id;
  if v_profile is distinct from 'social_mobile_user_v1' then
    raise exception 'SOCIAL_MOBILE_PUBLISH_SETTINGS_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  return query
  select s.settings, s.persona_profile, s.persona_provenance, s.persona_confirmed,
         s.persona_last_analyzed_at, s.persona_last_analyzed_count
  from public.social_mobile_content_settings s
  where s.brand_id = p_brand_id;
end;
$$;

-- Explicit owner: the settings table owner (the only role that may read the table on its own).
do $$
begin
  execute pg_catalog.format(
    'alter function public.read_social_mobile_publish_settings(uuid, text) owner to %I',
    (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c
     where c.oid = 'public.social_mobile_content_settings'::regclass));
end $$;

revoke all on function public.read_social_mobile_publish_settings(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.read_social_mobile_publish_settings(uuid, text) to service_role;

-- Post-conditions: one definer function with the pinned path, owned by the table owner; besides the owner
-- exactly one plain EXECUTE for service_role (any other grantee -- e.g. from the creator's default
-- privileges -- aborts the file instead of being removed silently); exact effective EXECUTE; and the
-- table still unreachable for service_role on every column.
do $$
declare v_fn oid := 'public.read_social_mobile_publish_settings(uuid,text)'::regprocedure;
        v_owner oid := (select c.relowner from pg_catalog.pg_class c
                        where c.oid = 'public.social_mobile_content_settings'::regclass);
        v_service oid := 'service_role'::regrole;
begin
  if (select count(*) from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'read_social_mobile_publish_settings') <> 1
     or not exists (select 1 from pg_catalog.pg_proc p
                    where p.oid = v_fn and p.prokind = 'f' and p.prosecdef and p.proowner = v_owner
                      and p.proconfig = array['search_path=""'])
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                where p.oid = v_fn and a.grantee <> p.proowner
                  and not (a.grantee = v_service and a.privilege_type = 'EXECUTE' and not a.is_grantable))
     or (select count(*) from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
         where p.oid = v_fn and a.grantee = v_service) <> 1
     or not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or exists (select 1 from pg_catalog.pg_roles r
                where not r.rolsuper and pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE')
                  and not pg_catalog.pg_has_role(r.oid, v_owner, 'usage')
                  and not pg_catalog.pg_has_role(r.oid, v_service, 'usage'))
     or pg_catalog.has_table_privilege('service_role', 'public.social_mobile_content_settings',
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          || case when pg_catalog.current_setting('server_version_num')::integer >= 170000 then ',MAINTAIN' else '' end)
     or exists (select 1 from pg_catalog.pg_attribute a
                where a.attrelid = 'public.social_mobile_content_settings'::regclass and a.attnum > 0 and not a.attisdropped
                  and pg_catalog.has_column_privilege('service_role', a.attrelid, a.attnum, 'SELECT,INSERT,UPDATE,REFERENCES')) then
    raise exception 'PUBLISH_SETTINGS_READER_POSTCONDITION_FAILED';
  end if;
end $$;

commit;
