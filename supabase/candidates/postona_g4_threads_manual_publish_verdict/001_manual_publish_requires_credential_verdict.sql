-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #11, Issue #561). Kept outside supabase/migrations: no tool applies it.
--
-- One rule for "may this Threads account be posted to now": a MANUAL post (begin / create_container / check_container /
-- publish) now also needs G4's credential verdict to say VERIFIED -- the same verdict G3's scheduled dispatch binds to
-- (../postona_g4_credential_verdict/001). Before this, the two disagreed (measured in the connect -> publish e2e, scenario 30):
--   * identity_verified with a connection error (last_connection_error_code set)  -> dispatch refused, manual POSTED
--   * identity_verified with no G4 binding (a connect that skipped G4's bridge)    -> dispatch refused, manual POSTED
--   * custody naming another credential than the account holds                    -> dispatch CREDENTIAL_MISSING, manual
--     refused only by accident (the expiry reader found no custody: CREDENTIALS_EXPIRED)
-- Read-backs of a post that may already exist (confirm / reconcile: p_require_permission = false) are NOT gated by the
-- verdict, so a connection error never strands an unknown outcome; they keep every earlier check.
--
-- What changes: the BODY of public.threads_manual_publish_authorize(uuid, text, boolean) only -- the release candidate's body
-- (../postona_threads_publish/threads_publish_release_candidate.sql section 2, md5 8e97121f49f5b934dda0408f9b4044e9) plus
-- one verdict call, placed after the credential-presence check and before the expiry check. Same owner, same SECURITY
-- DEFINER, same empty search_path, same ACL (owner only; no grant is added or removed). No table, column, trigger, RLS
-- policy, grant or Vault object is touched; social_accounts is only read, as before.
-- Verdict code -> the publish refusal the Edge and the app already know:
--   NOT_OWN_WORKSPACE -> PUBLISH_FORBIDDEN; CREDENTIAL_MISSING -> CREDENTIALS_MISSING; CREDENTIAL_EXPIRED -> CREDENTIALS_EXPIRED;
--   NOT_CONNECTED / NOT_BOUND / NOT_VERIFIED / CONNECTION_ERROR / INPUT_INVALID -> CONNECTION_NOT_VERIFIED;
--   any other code (a G5 service state) -> SERVICE_NOT_ACTIVE.
-- Install after the release candidate and the verdict 001, as the lifecycle owner (the verdict is owner-only).
-- Rollback: 001_manual_publish_requires_credential_verdict_rollback.sql (restores the release candidate's body exactly).

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_fn regprocedure := pg_catalog.to_regprocedure('public.threads_manual_publish_authorize(uuid,text,boolean)');
  v_verdict regprocedure := pg_catalog.to_regprocedure('postona_g4_credential.threads_publish_credential_verdict(uuid,text)');
  v_src text;
begin
  if v_fn is null or pg_catalog.to_regprocedure('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)') is null then
    raise exception 'G4MP_PRECONDITION_RELEASE_CANDIDATE';
  end if;
  select p.prosrc into v_src from pg_catalog.pg_proc p where p.oid = v_fn;
  if pg_catalog.strpos(v_src, 'postona_g4_credential.threads_publish_credential_verdict') > 0 then
    raise exception 'G4MP_PRECONDITION_ALREADY_APPLIED';
  end if;
  if pg_catalog.md5(v_src) is distinct from '8e97121f49f5b934dda0408f9b4044e9' then
    raise exception 'G4MP_PRECONDITION_AUTHORIZE_UNPINNED';
  end if;
  if v_verdict is null then
    raise exception 'G4MP_PRECONDITION_VERDICT';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_me)
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_fn) is distinct from v_me
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_verdict) is distinct from v_me
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.threads_manual_publish_attempts'::regclass) is distinct from v_me then
    raise exception 'G4MP_PRECONDITION_OWNER';
  end if;
  if not (select p.prosecdef and p.provolatile = 's' from pg_catalog.pg_proc p where p.oid = v_verdict) then
    raise exception 'G4MP_PRECONDITION_VERDICT_SHAPE';
  end if;
end $$;

create or replace function public.threads_manual_publish_authorize(p_user uuid, p_social_account_id text, p_require_permission boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_brand_id text;
  v_brand public.brands%rowtype;
  v_role text;
  v_account public.social_accounts%rowtype;
  v_verified boolean;
  v_verdict text;
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
  -- G4-02 #11: a write step also needs the verdict G3's dispatch binds to (read in this statement's snapshot, rows locked above)
  if p_require_permission then
    select r.verified, r.code into v_verified, v_verdict
      from postona_g4_credential.threads_publish_credential_verdict(p_user, p_social_account_id) r;
    if v_verified is distinct from true then
      return case
        when v_verdict = 'NOT_OWN_WORKSPACE' then 'PUBLISH_FORBIDDEN'
        when v_verdict = 'CREDENTIAL_MISSING' then 'CREDENTIALS_MISSING'
        when v_verdict = 'CREDENTIAL_EXPIRED' then 'CREDENTIALS_EXPIRED'
        when v_verdict in ('NOT_CONNECTED', 'NOT_BOUND', 'NOT_VERIFIED', 'CONNECTION_ERROR', 'INPUT_INVALID') then 'CONNECTION_NOT_VERIFIED'
        else 'SERVICE_NOT_ACTIVE' end;
    end if;
  end if;
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

-- Postconditions: the same owner / definer / empty search_path; no API role can execute it (the ACL is unchanged).
do $$
declare
  v_fn regprocedure := pg_catalog.to_regprocedure('public.threads_manual_publish_authorize(uuid,text,boolean)');
  v_api text;
begin
  if not (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_catalog.pg_proc p where p.oid = v_fn) then
    raise exception 'G4MP_POSTCONDITION_SHAPE';
  end if;
  foreach v_api in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.to_regrole(v_api) is not null and pg_catalog.has_function_privilege(v_api, v_fn, 'EXECUTE') then
      raise exception 'G4MP_POSTCONDITION_ACL %', v_api;
    end if;
  end loop;
  -- a NULL ACL is the default (PUBLIC may execute); grantee 0 is PUBLIC
  if exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn
             and (p.proacl is null or exists (select 1 from pg_catalog.aclexplode(p.proacl) e where e.grantee = 0))) then
    raise exception 'G4MP_POSTCONDITION_ACL public';
  end if;
end $$;

commit;
