-- G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-51): strict READ-ONLY checks before / after the POSTONA X + Threads reservation rollout
-- (rollout.sh). NOT applied anywhere. Runs as the role that will own G3's schemas (the non-superuser lifecycle owner) and ends with
-- ROLLBACK: it never changes anything. psql variable `mode`:
--   install   the prerequisites G3's files rely on, and G3 not installed at all (fresh);
--   rollback  the same prerequisites, and G3 installed exactly (every layer through 013 / 015);
--   postcheck right after an install: G3 installed exactly, nothing in G3's schemas reachable by PUBLIC / anon / authenticated /
--             service_role, the API / worker roles NOLOGIN and unprivileged, G4's verdicts still owner-only, U8 still in force.
-- Answers one line `G3_ROLLOUT_PREFLIGHT_OK <mode> <state>`, or raises G3_ROLLOUT_PREFLIGHT_<CODE>: <detail>.
-- Prerequisites (the G5 personal MVP profile + G4's verdicts; owned by G5 / G4, only READ here):
--   G5  private.postona_personal_session(), private.postona_personal_worker_verdict(uuid,text,text,bigint),
--       private.account_lifecycle_brand_owner(text), private.account_lifecycle_service_state_refusal(uuid,text),
--       private.account_lifecycle_assert_active_service_write(uuid,text), public.common_account_authorization_verdict(text,text,text):
--       present, SECURITY DEFINER, owned by this role, EXECUTE for this role only; auth.uid() present.
--   G4  postona_g4_credential.x_publish_credential_verdict(uuid,text) md5 46643d50..., threads_publish_credential_verdict(uuid,text)
--       md5 fb93a0ad... (G4 head c6df19cc): TABLE(verified boolean, credential_generation text, code text), SECURITY DEFINER, this
--       owner, owner-only ACL. G4's real X token read / Threads credential statement are NOT database objects G3 can check: the Edge
--       entries keep their credential ports NOT_CONNECTED (deny) until G4 delivers them (rollout.sh reports this, never allows).
--   U8  public.social_accounts CHECK social_accounts_meta_publish_disabled present and validated (Threads stays publish-disabled; its
--       owner decides -- G3 never installs over a dropped CHECK).
--   the tables G3 reads: public.social_accounts, brands, brand_memberships, x_account_refresh_state_v2, threads_account_credential_custody.
--   no default privilege of this role (global or on G3's schemas) granting anything to another role: new G3 objects must start closed.
--   install only: CREATEROLE (002 / 004 create the NOLOGIN API / worker roles), and neither role exists yet.
\set ON_ERROR_STOP 1
begin;
set local search_path = '';
select pg_catalog.set_config('g3ro.mode', :'mode', true);

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_mode text := pg_catalog.current_setting('g3ro.mode');
  v_fn text; v_oid oid; v_t text; v_bad text; v_state text; v_def text;
begin
  if v_mode not in ('install', 'rollback', 'postcheck') then
    raise exception 'G3_ROLLOUT_PREFLIGHT_MODE: %', v_mode;
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_me) is distinct from false then
    raise exception 'G3_ROLLOUT_PREFLIGHT_SUPERUSER: G3 is installed by the non-superuser lifecycle owner only';
  end if;

  -- G5 (personal MVP)
  foreach v_fn in array array['private.postona_personal_session()', 'private.postona_personal_worker_verdict(uuid,text,text,bigint)',
      'private.account_lifecycle_brand_owner(text)', 'private.account_lifecycle_service_state_refusal(uuid,text)',
      'private.account_lifecycle_assert_active_service_write(uuid,text)', 'public.common_account_authorization_verdict(text,text,text)'] loop
    v_oid := pg_catalog.to_regprocedure(v_fn);
    if v_oid is null then
      raise exception 'G3_ROLLOUT_PREFLIGHT_G5_MISSING: %', v_fn;
    end if;
    if (select p.proowner from pg_catalog.pg_proc p where p.oid = v_oid) is distinct from v_me
       or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_oid)
       or (select p.proacl from pg_catalog.pg_proc p where p.oid = v_oid) is null
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_oid and a.grantee <> v_me) then
      raise exception 'G3_ROLLOUT_PREFLIGHT_G5_NOT_OWNER_ONLY: %', v_fn;
    end if;
  end loop;
  if pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception 'G3_ROLLOUT_PREFLIGHT_G5_MISSING: auth.uid()';
  end if;

  -- G4 (verified publish-credential verdicts)
  foreach v_fn in array array['postona_g4_credential.x_publish_credential_verdict(uuid,text)=46643d50a4a6c6a82867061328de05bf',
      'postona_g4_credential.threads_publish_credential_verdict(uuid,text)=fb93a0ad84c44c6781521eec4618fff4'] loop
    v_oid := pg_catalog.to_regprocedure(pg_catalog.split_part(v_fn, '=', 1));
    if v_oid is null
       or (select p.proowner from pg_catalog.pg_proc p where p.oid = v_oid) is distinct from v_me
       or not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_oid)
       or pg_catalog.pg_get_function_result(v_oid) is distinct from 'TABLE(verified boolean, credential_generation text, code text)'
       or pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = v_oid)) is distinct from pg_catalog.split_part(v_fn, '=', 2)
       or (select p.proacl from pg_catalog.pg_proc p where p.oid = v_oid) is null
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = v_oid and a.grantee <> v_me) then
      raise exception 'G3_ROLLOUT_PREFLIGHT_G4_VERDICT: %', pg_catalog.split_part(v_fn, '=', 1);
    end if;
  end loop;

  -- tables G3 reads
  foreach v_t in array array['public.social_accounts', 'public.brands', 'public.brand_memberships', 'public.x_account_refresh_state_v2',
      'public.threads_account_credential_custody'] loop
    if pg_catalog.to_regclass(v_t) is null or not pg_catalog.has_table_privilege(v_me, v_t, 'SELECT') then
      raise exception 'G3_ROLLOUT_PREFLIGHT_TABLE: %', v_t;
    end if;
  end loop;

  -- U8: Threads stays publish-disabled until the CHECK's owner decides
  select pg_catalog.pg_get_constraintdef(c.oid) into v_def from pg_catalog.pg_constraint c
  where c.conrelid = 'public.social_accounts'::pg_catalog.regclass and c.conname = 'social_accounts_meta_publish_disabled' and c.contype = 'c' and c.convalidated;
  if v_def is null or v_def !~ 'publish_enabled IS FALSE' then
    raise exception 'G3_ROLLOUT_PREFLIGHT_U8_CHECK_MISSING: social_accounts_meta_publish_disabled';
  end if;

  -- new objects must start closed: no default privilege of this role for another role, globally or on G3's schemas
  select pg_catalog.string_agg(d.defaclobjtype::text || ':' || coalesce(n.nspname, '*'), ',' order by 1) into v_bad
  from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace,
       pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclrole = v_me and (d.defaclnamespace = 0 or n.nspname in ('postona_x_resv', 'postona_threads_resv')) and a.grantee <> v_me;
  if v_bad is not null then
    raise exception 'G3_ROLLOUT_PREFLIGHT_DEFAULT_PRIVILEGES: %', v_bad;
  end if;

  if (select count(*) from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'G3_ROLLOUT_PREFLIGHT_ROLES: anon / authenticated / service_role';
  end if;

  -- G3's own state
  if pg_catalog.to_regnamespace('postona_x_resv') is null and pg_catalog.to_regnamespace('postona_threads_resv') is null
     and pg_catalog.to_regrole('postona_resv_api') is null and pg_catalog.to_regrole('postona_resv_worker') is null then
    v_state := 'fresh';
  elsif pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check_bound(uuid,uuid)') is not null
     and pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.pre_publish_check_bound(uuid,uuid)'))) = '1220c208d2b268e15ae67a1e6474f58c'
     and pg_catalog.to_regprocedure('postona_threads_resv.g4_threads_account_verified(uuid,text)') is not null
     and pg_catalog.md5((select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_threads_resv.g4_threads_account_verified(uuid,text)'))) = '83cecbf2c922281da0a2cea2f3a5e9d5'
     and pg_catalog.to_regprocedure('postona_x_resv.audit_lease_expired()') is not null
     and pg_catalog.to_regprocedure('postona_x_resv.list_reservations(text)') is not null
     and pg_catalog.to_regrole('postona_resv_api') is not null and pg_catalog.to_regrole('postona_resv_worker') is not null then
    v_state := 'installed';
  else
    v_state := 'partial';
  end if;
  if v_mode = 'install' and v_state <> 'fresh' then
    raise exception 'G3_ROLLOUT_PREFLIGHT_NOT_FRESH: %', v_state;
  end if;
  if v_mode in ('rollback', 'postcheck') and v_state <> 'installed' then
    raise exception 'G3_ROLLOUT_PREFLIGHT_NOT_INSTALLED: %', v_state;
  end if;
  if v_mode = 'install' and not (select r.rolcreaterole from pg_catalog.pg_roles r where r.oid = v_me) then
    raise exception 'G3_ROLLOUT_PREFLIGHT_CREATEROLE: 002 / 004 create the NOLOGIN API / worker roles';
  end if;

  if v_mode = 'postcheck' then
    -- nothing in G3's schemas reachable by PUBLIC / anon / authenticated / service_role
    select pg_catalog.string_agg(x, ',' order by x) into v_bad from (
      select p.oid::pg_catalog.regprocedure::text as x from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace,
             pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      where n.nspname in ('postona_x_resv', 'postona_threads_resv')
        and (a.grantee = 0 or a.grantee in (select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')))
      union all
      select c.oid::pg_catalog.regclass::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace,
             pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
      where n.nspname in ('postona_x_resv', 'postona_threads_resv')
        and (a.grantee = 0 or a.grantee in (select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')))
      union all
      select n.nspname from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      where n.nspname in ('postona_x_resv', 'postona_threads_resv')
        and (a.grantee = 0 or a.grantee in (select r.oid from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')))) s;
    if v_bad is not null then
      raise exception 'G3_ROLLOUT_PREFLIGHT_POSTCHECK_EXPOSED: %', v_bad;
    end if;
    -- the API / worker roles: NOLOGIN, nothing else; their only members are this owner (the creator) at most
    if exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('postona_resv_api', 'postona_resv_worker')
               and (r.rolcanlogin or r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls))
       or exists (select 1 from pg_catalog.pg_auth_members m where m.roleid in (select r.oid from pg_catalog.pg_roles r where r.rolname in ('postona_resv_api', 'postona_resv_worker'))
                  and m.member <> v_me) then
      raise exception 'G3_ROLLOUT_PREFLIGHT_POSTCHECK_ROLES';
    end if;
  end if;
  perform pg_catalog.set_config('g3ro.state', v_state, true);
end $$;

select 'G3_ROLLOUT_PREFLIGHT_OK ' || pg_catalog.current_setting('g3ro.mode') || ' ' || pg_catalog.current_setting('g3ro.state');
rollback;
