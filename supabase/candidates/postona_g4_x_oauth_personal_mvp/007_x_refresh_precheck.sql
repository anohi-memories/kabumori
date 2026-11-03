-- NOT A MIGRATION. G4 SOURCE CANDIDATE ONLY (G4-02 #8, Issue #561). Applies ON TOP OF 006 and the X verdict (postona_g4_credential/002).
-- May the X token refresh writer start for this account, on this database? For the refresh worker to ask BEFORE it takes the lease and
-- before the provider's single-use refresh token is spent (supabase/functions/_shared/x_refresh_db_profile_fence.ts).
--
--   public.postona_x_refresh_precheck_v1(p_social_account_id text) returns text   -- 'allow', or one fixed refusal code
--
-- 'allow' only when: 006 answers 'personal' for this database, AND G4's X verdict says verified for the account's single owner (own
-- workspace, service active, G4's lineage, no connect pending, identity_verified, no error, credentials set, refresh state not
-- refreshing / uncertain / reauth_required), AND (G4-02 #9) G5's MV still answers 'active' for the generation recorded when this
-- connection was made: a service end + restart since then refuses (SERVICE_GENERATION_CHANGED), exactly G5's rule for work done for a
-- person. A new connect records the current generation; no new reconnect policy is made here. No token, secret id or generation is
-- returned. A full or not-installed database has no such function: PostgREST 404, and the caller refuses.
--
-- New surface, and all of it: one STABLE SECURITY DEFINER function (read-only, empty search_path; definer because the X verdict and G5's
-- brand owner are owner-only), EXECUTE to `service_role` ONLY (the worker's role). Not anon, not authenticated. Rollback: ..._rollback.sql.
-- It does NOT replace the refresh core's own checks at begin / commit (single flight, lease, account_changed): those stay the core's.

begin;
set local lock_timeout = '2s';
set local search_path = '';

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn text;
begin
  if (select rolsuper from pg_catalog.pg_roles where oid = v_me) then
    raise exception 'G4X_PRECHECK_PRECONDITION_OWNER';
  end if;
  if to_regprocedure('private.account_lifecycle_brand_owner_epoch(text)') is not null then
    raise exception 'G4X_PRECHECK_PRECONDITION_FULL_PROFILE';
  end if;
  foreach v_fn in array array['public.postona_x_connect_profile_v1()', 'postona_g4_credential.x_publish_credential_verdict(uuid,text)',
                              'private.account_lifecycle_brand_owner(text)', 'private.postona_personal_worker_verdict(uuid,text,text,bigint)'] loop
    if to_regprocedure(v_fn) is null or (select proowner from pg_catalog.pg_proc where oid = to_regprocedure(v_fn)) <> v_me then
      raise exception 'G4X_PRECHECK_PRECONDITION_DEPENDENCY %', v_fn;
    end if;
  end loop;
  if to_regprocedure('public.postona_x_refresh_precheck_v1(text)') is not null then
    raise exception 'G4X_PRECHECK_ALREADY_APPLIED';
  end if;
end $$;

create function public.postona_x_refresh_precheck_v1(p_social_account_id text) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_brand text;
  v_owner uuid;
  v_verified boolean;
  v_code text;
  v_generations bigint[];
begin
  if p_social_account_id is null or p_social_account_id = '' then
    return 'INPUT_INVALID';
  end if;
  if public.postona_x_connect_profile_v1() is distinct from 'personal' then
    return 'DB_PROFILE_MISMATCH';
  end if;
  select sa.brand_id into v_brand from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'x';
  if not found then
    return 'NOT_CONNECTED';
  end if;
  v_owner := private.account_lifecycle_brand_owner(v_brand);
  if v_owner is null then
    return 'NOT_OWN_WORKSPACE';
  end if;
  select r.verified, r.code into v_verified, v_code
    from postona_g4_credential.x_publish_credential_verdict(v_owner, p_social_account_id) r;
  if v_verified is not true then
    return coalesce(v_code, 'VERDICT_UNKNOWN');
  end if;
  -- the generation (the personal build's owner_epoch column) of the completed begin that made this connection: complete moved the epoch +1
  select pg_catalog.array_agg(b.owner_epoch) into v_generations
    from postona_g4_x_oauth.connections c
    join postona_g4_x_oauth.state_bindings b on b.social_account_id = c.social_account_id and b.connection_epoch = c.connection_epoch - 1
    join public.social_account_oauth_states s on s.id = b.oauth_state_id and s.consumed_at is not null
   where c.social_account_id = p_social_account_id;
  if v_generations is null or pg_catalog.cardinality(v_generations) <> 1 then
    return 'GENERATION_UNKNOWN';
  end if;
  v_code := private.postona_personal_worker_verdict(v_owner, v_brand, 'x_autopost', v_generations[1]);
  if v_code is distinct from 'active' then
    return coalesce(v_code, 'SERVICE_STATE_UNKNOWN');
  end if;
  return 'allow';
end $$;

revoke all on function public.postona_x_refresh_precheck_v1(text) from public, anon, authenticated, service_role;
grant execute on function public.postona_x_refresh_precheck_v1(text) to service_role;

do $$
declare
  v_me oid := (select oid from pg_catalog.pg_roles where rolname = current_user);
  v_fn regprocedure := to_regprocedure('public.postona_x_refresh_precheck_v1(text)');
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.proowner = v_me and p.prosecdef and p.provolatile = 's'
                   and coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'G4X_PRECHECK_POSTCONDITION_FUNCTION';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
              where p.oid = v_fn and a.grantee not in (v_me, 'service_role'::regrole))
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'G4X_PRECHECK_POSTCONDITION_ACL';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
