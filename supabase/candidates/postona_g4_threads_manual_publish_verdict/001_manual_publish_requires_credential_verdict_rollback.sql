-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #11, Issue #561). Rollback of
-- 001_manual_publish_requires_credential_verdict.sql: puts back the release candidate's body of
-- public.threads_manual_publish_authorize(uuid, text, boolean) EXACTLY (copied verbatim from
-- ../postona_threads_publish/threads_publish_release_candidate.sql section 2; md5 of the body 8e97121f49f5b934dda0408f9b4044e9).
-- Refuses unless the current body is 001's. Owner, definer, search_path and ACL are unchanged by both files.
-- G4-02 #12: refuses while 002 is installed (G4MP_ROLLBACK_002_PRESENT): roll back 002 first.
-- G4-02 #13 (H1 #41 P3): also refuses a PARTIAL 002 (its bodies / send fence / trigger without its table:
-- G4MP_ROLLBACK_002_PARTIAL) and begin / release bodies that are neither (G4MP_ROLLBACK_STACK_UNKNOWN), before any change.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_fn regprocedure := pg_catalog.to_regprocedure('public.threads_manual_publish_authorize(uuid,text,boolean)');
begin
  if v_fn is null or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from 'f31f16d6ccbb4fc64946337325e93a35' then
    raise exception 'G4MP_ROLLBACK_NOT_APPLIED';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'G4MP_ROLLBACK_OWNER';
  end if;
  -- G4-02 #12: 002 builds on 001 (it checks 001's body at install): roll 002 back first
  if pg_catalog.to_regclass('public.threads_manual_publish_attempt_generations') is not null then
    raise exception 'G4MP_ROLLBACK_002_PRESENT';
  end if;
  -- G4-02 #13 (H1 #41 P3): ANY part of 002 left without its table (its begin / release bodies, the send fence or its trigger)
  -- is a partial state: refused before anything changes. The two bodies must be exactly the ones 001 was installed over
  -- (threads_manual_publish_candidate.sql / threads_publish_release_candidate.sql); anything else is an unknown stack.
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
       where p.oid = pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)')) = '7d26e42edaf3f7f85083880814983c2e'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
          where p.oid = pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)')) = 'e92ec523bb1a7a3ba7ca53dce744fb82'
     or pg_catalog.to_regprocedure('postona_threads_binding.manual_publish_send_fence()') is not null
     or exists (select 1 from pg_catalog.pg_trigger t where t.tgname = 'threads_manual_publish_send_fence') then
    raise exception 'G4MP_ROLLBACK_002_PARTIAL';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
       where p.oid = pg_catalog.to_regprocedure('public.begin_threads_manual_publish(text,uuid,text)')) is distinct from '6ae40adbcd203592fbc3847c57f1bccf'
     or (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
          where p.oid = pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)')) is distinct from 'bd5bed5adcbef4d87614613f51c83dbf' then
    raise exception 'G4MP_ROLLBACK_STACK_UNKNOWN';
  end if;
end $$;

create or replace function public.threads_manual_publish_authorize(p_user uuid, p_social_account_id text, p_require_permission boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_brand_id text;
  v_brand public.brands%rowtype;
  v_role text;
  v_account public.social_accounts%rowtype;
begin
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id;
  if v_brand_id is null then return 'ACCOUNT_NOT_FOUND'; end if;
  select b.* into v_brand from public.brands b where b.id = v_brand_id for share;
  select m.role into v_role from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = p_user for share;
  if v_role is null then return 'ACCOUNT_NOT_FOUND'; end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for share;
  if v_account.id is null or v_account.brand_id is distinct from v_brand_id then return 'ACCOUNT_NOT_FOUND'; end if;
  if v_role not in ('owner', 'admin') then return 'PUBLISH_FORBIDDEN'; end if;
  if v_brand.code_profile_key is distinct from 'social_mobile_user_v1' then return 'WORKSPACE_INACTIVE'; end if;
  if v_account.platform is distinct from 'threads' then return 'PLATFORM_NOT_SUPPORTED'; end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or coalesce(v_account.platform_user_id, '') !~ '^[1-9][0-9]{0,31}$' then
    return 'CONNECTION_NOT_VERIFIED';
  end if;
  if v_account.vault_access_token_secret_id is null then return 'CREDENTIALS_MISSING'; end if;
  if coalesce(public.threads_account_credential_expires_at(p_social_account_id), '-infinity') <= pg_catalog.now() + interval '5 minutes' then
    return 'CREDENTIALS_EXPIRED';
  end if;
  if p_require_permission and not exists (
       select 1 from public.social_account_manual_publish_permissions p
       where p.social_account_id = p_social_account_id and p.brand_id = v_brand_id for share) then
    return 'MANUAL_PUBLISH_NOT_PERMITTED';
  end if;
  return null;
end;
$$;

do $$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure('public.threads_manual_publish_authorize(uuid,text,boolean)')) is distinct from '8e97121f49f5b934dda0408f9b4044e9' then
    raise exception 'G4MP_ROLLBACK_POSTCONDITION_BODY';
  end if;
end $$;

commit;
