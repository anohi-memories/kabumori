-- POSTONA X publish — common-account entitlement guard (F3 SOURCE CANDIDATE, 2026-10-13). NOT in supabase/migrations/.
-- Never apply until: the Stage 3B publish authority (20261006160200) is applied, G5/F5's Phase 3b/4/5 candidates
-- (PR #121 -> #152 -> #165) are approved and applied, one Sol（高） integrated review, and the user's approval.
--
-- What changes (F3/G3-owned functions only; no G5/F5 object, Kabumori / AI Lab object or row is changed):
--   A. public.check_x_account_publish_authority(post, account, brand) -- the single publish predicate the worker
--      calls before generation AND again immediately before the X create -- additionally requires
--      public.common_account_brand_service_state(brand, 'x_autopost') = 'active'. Anything else (owner unknown /
--      several owners / account locked or being deleted / service not registered, ended, suspended or being
--      deleted / the decision unreadable) refuses with VAULT_PUBLISH_SERVICE_NOT_ACTIVE (the G5 code in DETAIL).
--      Every existing check (post running, exact account, brand live, verified, publish_enabled, brand_post on,
--      authority window, owner consent) is kept, unchanged and in the same order.
--   B. public.set_x_account_publish_authority(..., 'enabled', ...) asserts the owner's x_autopost entitlement with
--      G5's ORDERING variant private.account_lifecycle_assert_brand_service_active, BEFORE it locks the account
--      row: G5's lock order is lifecycle rows (login -> account -> entitlement) first, workspace rows after (F5
--      Phase 6 kills the opposite order). The locks are kept to the end of the transaction, so a freeze that
--      starts later waits for this grant, and a freeze holding them first makes the grant wait (<= 3 s) and
--      refuse with VAULT_PUBLISH_SERVICE_BUSY. 'off' / 'revoked' never ask G5: stopping always works.
--   D. X-only stop functions for the POSTONA end flows (called by G5/F5's orchestrator or F3's X saga; F3 does
--      not wire them into F5's flow):
--        public.postona_x_stop_account_publishing(p_social_account_id, p_reason_code) -> jsonb
--            (A: one X account disconnected)
--        public.postona_x_stop_publishing_for_user(p_user_id, p_reason_code) -> jsonb
--            (B: POSTONA service end; C: whole common-account deletion runs B for x_autopost)
--      Each: authority -> 'revoked' (idempotent), planned reservations of the account -> cancelled, in-flight work
--      counted (never "stopped" silently), remote X authorization NOT touched (reported 'not_attempted').
-- The claim of Stage 3B brand_posts is the shared claim_due_post() (Kabumori / AI Lab queue): NOT changed here.
-- A claimed brand_post of an ended service is refused by A's first check, before any generation or X call.
-- Honest limit: no database lock spans the X HTTP call; a freeze that commits between the last check and the
-- X create can let that one in-flight attempt complete. It is reported by the stop functions (in_flight) and the
-- deletion read-back, never hidden.
begin;

do $$
declare v_state regprocedure; v_assert regprocedure; v_p record;
begin
  if to_regprocedure('public.check_x_account_publish_authority(uuid,text,text)') is null
     or to_regprocedure('public.set_x_account_publish_authority(text,text,text,timestamptz,timestamptz)') is null
     or to_regclass('public.x_account_publish_authority') is null then
    raise exception 'X_PUBLISH_ENTITLEMENT_PRECONDITION_STAGE3B_MISSING';
  end if;
  if to_regprocedure('public.postona_x_stop_account_publishing(text,text)') is not null
     or (select p.prosrc from pg_catalog.pg_proc p
          where p.oid = 'public.check_x_account_publish_authority(uuid,text,text)'::regprocedure) ~ 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE' then
    raise exception 'X_PUBLISH_ENTITLEMENT_ALREADY_APPLIED';
  end if;
  v_state := to_regprocedure('public.common_account_brand_service_state(text,text)');
  v_assert := to_regprocedure('private.account_lifecycle_assert_brand_service_active(text,text)');
  if v_state is null or v_assert is null then
    raise exception 'X_PUBLISH_ENTITLEMENT_PRECONDITION_G5_MISSING';
  end if;
  select p.prorettype::regtype::text as ret, p.provolatile, p.prosecdef, p.proconfig into v_p from pg_catalog.pg_proc p where p.oid = v_state;
  if v_p.ret <> 'text' or v_p.provolatile <> 's' or not v_p.prosecdef or not ('search_path=""' = any (coalesce(v_p.proconfig, '{}'))) then
    raise exception 'X_PUBLISH_ENTITLEMENT_PRECONDITION_G5_SHAPE';
  end if;
  select p.prorettype::regtype::text as ret, p.provolatile, p.prosecdef, p.proconfig into v_p from pg_catalog.pg_proc p where p.oid = v_assert;
  if v_p.ret <> 'void' or v_p.provolatile <> 'v' or not v_p.prosecdef or not ('search_path=""' = any (coalesce(v_p.proconfig, '{}'))) then
    raise exception 'X_PUBLISH_ENTITLEMENT_PRECONDITION_G5_SHAPE';
  end if;
  -- service_role runs the predicate (SECURITY INVOKER): it must reach the G5 read, and nothing wider may.
  if not pg_catalog.has_function_privilege('service_role', v_state, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_state, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_state, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_assert, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_assert, 'EXECUTE')
     or not pg_catalog.has_function_privilege(current_user, v_assert, 'EXECUTE') then
    raise exception 'X_PUBLISH_ENTITLEMENT_PRECONDITION_G5_ACL';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass)
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select p.proowner from pg_catalog.pg_proc p
          where p.oid = 'public.set_x_account_publish_authority(text,text,text,timestamptz,timestamptz)'::regprocedure)
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'X_PUBLISH_ENTITLEMENT_PRECONDITION_OWNER';
  end if;
end $$;

-- A. The single publish predicate (same signature, owner, ACL and SECURITY INVOKER; body extended).
create or replace function public.check_x_account_publish_authority(
  p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text
) returns text language plpgsql stable security invoker set search_path = '' as $$
declare v_post public.scheduled_posts%rowtype;
        v_account public.social_accounts%rowtype;
        v_brand public.brands%rowtype;
        v_authority public.x_account_publish_authority%rowtype;
        v_approval text;
        v_service text;
begin
  if p_scheduled_post_id is null or nullif(btrim(p_social_account_id), '') is null
     or nullif(btrim(p_brand_id), '') is null then
    raise exception 'VAULT_PUBLISH_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  -- Specialised paths never publish through the generic route.
  if p_brand_id in ('kabumori', 'ai_salaryman_lab') then
    raise exception 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  select sp.* into v_post from public.scheduled_posts sp where sp.id = p_scheduled_post_id;
  if not found or v_post.status is distinct from 'running' or v_post.post_type is distinct from 'brand_post'
     or v_post.brand_id is distinct from p_brand_id
     or (pg_catalog.to_jsonb(v_post) ->> 'social_account_id') is not null then
    raise exception 'VAULT_PUBLISH_POST_NOT_RUNNING' using errcode = 'P0001';
  end if;
  if (select count(*) from public.social_accounts sa where sa.brand_id = p_brand_id and sa.platform = 'x') <> 1 then
    raise exception 'X_ACCOUNT_NOT_UNIQUE_FOR_BRAND' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.brand_id = p_brand_id and sa.platform = 'x';
  if v_account.id is distinct from p_social_account_id then
    raise exception 'X_CLAIM_ACCOUNT_MISMATCH' using errcode = 'P0001';
  end if;
  select b.* into v_brand from public.brands b where b.id = p_brand_id;
  if v_brand.is_active is distinct from true or v_brand.publish_mode is distinct from 'live' then
    raise exception 'VAULT_PUBLISH_BRAND_DISABLED' using errcode = 'P0001';
  end if;
  if v_account.connection_status is distinct from 'identity_verified' then
    raise exception 'X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  if v_account.publish_enabled is distinct from true then
    raise exception 'X_ACCOUNT_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.brand_settings bs
                 where bs.brand_id = p_brand_id and bs.enabled_post_types ? 'brand_post') then
    raise exception 'VAULT_PUBLISH_POST_TYPE_NOT_ENABLED' using errcode = 'P0001';
  end if;
  select pa.* into v_authority from public.x_account_publish_authority pa where pa.social_account_id = v_account.id;
  if not found or v_authority.state = 'off' then
    raise exception 'VAULT_PUBLISH_AUTHORITY_OFF' using errcode = 'P0001';
  end if;
  if v_authority.state = 'revoked' then
    raise exception 'VAULT_PUBLISH_AUTHORITY_REVOKED' using errcode = 'P0001';
  end if;
  if pg_catalog.now() < v_authority.starts_at then
    raise exception 'VAULT_PUBLISH_AUTHORITY_NOT_STARTED' using errcode = 'P0001';
  end if;
  if pg_catalog.now() >= v_authority.expires_at then
    raise exception 'VAULT_PUBLISH_AUTHORITY_EXPIRED' using errcode = 'P0001';
  end if;
  -- Owner consent lives in the brand's own content settings, read only through the narrow
  -- publish-time reader (same running post, social_mobile_user_v1 only). No row = no consent;
  -- a non-eligible brand is refused by the reader itself.
  select r.settings ->> 'approvalMode' into v_approval
  from public.read_social_mobile_publish_settings(p_scheduled_post_id, p_brand_id) r;
  if v_approval is distinct from 'auto_post_preference' then
    raise exception 'SOCIAL_MOBILE_AUTO_POST_NOT_CONSENTED' using errcode = 'P0001';
  end if;
  -- Common account (G5/F5): the workspace owner's x_autopost service must be active right now. Only the exact
  -- answer 'active' allows; a refusal, null or an error reading it never does (an error propagates: refused).
  v_service := public.common_account_brand_service_state(p_brand_id, 'x_autopost');
  if v_service is distinct from 'active' then
    raise exception 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE' using errcode = 'P0001', detail = coalesce(v_service, 'UNKNOWN');
  end if;
  return 'allowed';
end;
$$;

-- B. The only mutation path (same signature, owner, ACL and SECURITY DEFINER; 'enabled' now needs G5).
create or replace function public.set_x_account_publish_authority(
  p_social_account_id text, p_state text, p_reason_code text,
  p_starts_at timestamptz default null, p_expires_at timestamptz default null
) returns text language plpgsql security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_brand text;
begin
  if nullif(btrim(p_social_account_id), '') is null or p_state is null or p_state not in ('enabled', 'off', 'revoked')
     or p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{1,99}$'
     or (p_state = 'enabled' and (p_starts_at is null or p_expires_at is null or p_expires_at <= pg_catalog.now()
                                  or p_expires_at <= p_starts_at or p_expires_at > p_starts_at + interval '30 days'))
     or (p_state <> 'enabled' and (p_starts_at is not null or p_expires_at is not null)) then
    raise exception 'VAULT_PUBLISH_AUTHORITY_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  if p_state = 'enabled' then
    -- G5 lock order: the owner's lifecycle rows FIRST (kept to commit), the account row after.
    select sa.brand_id into v_brand from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'x';
    if v_brand is null then
      raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
    end if;
    if v_brand in ('kabumori', 'ai_salaryman_lab') then
      raise exception 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
    end if;
    begin
      perform private.account_lifecycle_assert_brand_service_active(v_brand, 'x_autopost');
    exception
      when sqlstate '55P03' then
        raise exception 'VAULT_PUBLISH_SERVICE_BUSY' using errcode = 'P0001';
      when sqlstate '42501' then
        raise exception 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE' using errcode = 'P0001', detail = sqlerrm;
    end;
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id for update;
  if not found or v_account.platform is distinct from 'x' then
    raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_account.brand_id in ('kabumori', 'ai_salaryman_lab') then
    raise exception 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  if p_state = 'enabled' and v_account.brand_id is distinct from v_brand then
    -- The account moved between the G5 decision and the row lock: decide again, never grant on a stale brand.
    raise exception 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE' using errcode = 'P0001', detail = 'ACCOUNT_BRAND_CHANGED';
  end if;
  if p_state = 'enabled' then
    insert into public.x_account_publish_authority (social_account_id, state, starts_at, expires_at, reason_code, updated_at)
    values (v_account.id, 'enabled', p_starts_at, p_expires_at, p_reason_code, pg_catalog.now())
    on conflict (social_account_id) do update
    set state = 'enabled', starts_at = excluded.starts_at, expires_at = excluded.expires_at,
        reason_code = excluded.reason_code, updated_at = pg_catalog.now();
  else
    insert into public.x_account_publish_authority (social_account_id, state, reason_code, updated_at)
    values (v_account.id, p_state, p_reason_code, pg_catalog.now())
    on conflict (social_account_id) do update
    set state = excluded.state, reason_code = excluded.reason_code, updated_at = pg_catalog.now();
  end if;
  return p_state;
exception
  when sqlstate 'P0001' then raise;
  when others then raise exception 'VAULT_PUBLISH_AUTHORITY_UNAVAILABLE' using errcode = 'P0001';
end;
$$;

-- D. X-only stop. One X account: authority revoked (idempotent), planned reservations cancelled, in-flight counted.
create function public.postona_x_stop_account_publishing(p_social_account_id text, p_reason_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_account public.social_accounts%rowtype;
        v_previous text;
        v_cancelled integer := 0;
        v_claimed integer := 0;
        v_running integer := 0;
        v_pending integer := 0;
begin
  if nullif(btrim(p_social_account_id), '') is null or p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{1,99}$' then
    raise exception 'X_STOP_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select sa.* into v_account from public.social_accounts sa where sa.id = p_social_account_id for update;
  if not found or v_account.platform is distinct from 'x' then
    raise exception 'X_ACCOUNT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_account.brand_id in ('kabumori', 'ai_salaryman_lab') then
    raise exception 'VAULT_PUBLISH_BRAND_NOT_ELIGIBLE' using errcode = 'P0001';
  end if;
  select pa.state into v_previous from public.x_account_publish_authority pa where pa.social_account_id = v_account.id;
  perform public.set_x_account_publish_authority(v_account.id, 'revoked', p_reason_code);
  -- Reservations (F3 candidate schema; absent until applied): planned rows end, claimed rows are in flight.
  if to_regclass('postona_x_resv.reservations') is not null then
    execute 'with c as (update postona_x_resv.reservations r set status = ''cancelled'', revision = r.revision + 1, updated_at = pg_catalog.now()
                        where r.social_account_id = $1 and r.status = ''planned'' returning r.id, r.user_id)
             , a as (insert into postona_x_resv.audit (user_id, reservation_id, action, detail)
                     select c.user_id, c.id, ''service_stop'', pg_catalog.jsonb_build_object(''reason'', $2::text) from c returning 1)
             select (select count(*) from c)::integer + 0 * (select count(*) from a)::integer'
      into v_cancelled using v_account.id, p_reason_code;
    execute 'select count(*)::integer from postona_x_resv.reservations r where r.social_account_id = $1 and r.status = ''claimed'''
      into v_claimed using v_account.id;
  end if;
  -- Stage 3B brand_posts of the brand (the shared queue is NOT changed): they are refused by the revoked authority.
  select count(*) filter (where sp.status = 'running'), count(*) filter (where sp.status = 'pending')
    into v_running, v_pending
    from public.scheduled_posts sp where sp.brand_id = v_account.brand_id and sp.post_type = 'brand_post';
  return pg_catalog.jsonb_build_object(
    'social_account_id', v_account.id,
    'platform', 'x',
    'authority', 'revoked',
    'authority_before', coalesce(v_previous, 'none'),
    'reservations_cancelled', v_cancelled,
    'reservations_in_flight', v_claimed,
    'brand_posts_running', v_running,
    'brand_posts_pending_refused', v_pending,
    'remote_authorization', 'not_attempted',
    'reconciliation_required', (v_claimed + v_running) > 0);
end;
$$;

-- D. POSTONA service end (B) / common-account deletion (C runs B): every X account of the person's own workspaces.
create function public.postona_x_stop_publishing_for_user(p_user_id uuid, p_reason_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row record;
        v_accounts jsonb := '[]'::jsonb;
        v_blocked jsonb := '[]'::jsonb;
        v_result jsonb;
        v_reconcile boolean := false;
begin
  if p_user_id is null or p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{1,99}$' then
    raise exception 'X_STOP_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  for v_row in
    select sa.id as account_id, b.id as brand_id,
           (select count(*) from public.brand_memberships o where o.brand_id = b.id and o.role = 'owner') as owners,
           (select count(*) from public.brand_memberships o where o.brand_id = b.id) as members
      from public.brand_memberships m
      join public.brands b on b.id = m.brand_id
      join public.social_accounts sa on sa.brand_id = b.id and sa.platform = 'x'
     where m.user_id = p_user_id and m.role = 'owner' and b.code_profile_key = 'social_mobile_user_v1'
       and b.id not in ('kabumori', 'ai_salaryman_lab')
     order by sa.id
  loop
    if v_row.owners <> 1 or v_row.members <> 1 then
      -- A workspace shared with someone else is never stopped on one person's word (F5 9.3 (d)): blocked.
      v_blocked := v_blocked || pg_catalog.jsonb_build_object('social_account_id', v_row.account_id, 'reason', 'WORKSPACE_SHARED');
      continue;
    end if;
    v_result := public.postona_x_stop_account_publishing(v_row.account_id, p_reason_code);
    v_accounts := v_accounts || v_result;
    v_reconcile := v_reconcile or (v_result ->> 'reconciliation_required')::boolean;
  end loop;
  return pg_catalog.jsonb_build_object(
    'user_id', p_user_id,
    'platform', 'x',
    'status', case when pg_catalog.jsonb_array_length(v_blocked) > 0 then 'blocked'
                   when v_reconcile then 'stopped_in_flight'
                   else 'stopped' end,
    'accounts', v_accounts,
    'blocked', v_blocked,
    'remote_authorization', 'not_attempted',
    'reconciliation_required', v_reconcile);
end;
$$;

revoke all on function public.postona_x_stop_account_publishing(text, text),
  public.postona_x_stop_publishing_for_user(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.postona_x_stop_account_publishing(text, text),
  public.postona_x_stop_publishing_for_user(uuid, text)
to service_role;

-- Postconditions: the two Stage 3B routines keep their exact shape and ACL; the stop functions are definer with
-- an empty search_path and reach only service_role; no application role reaches any of them or G5's ordering.
do $$
declare v_check oid := 'public.check_x_account_publish_authority(uuid,text,text)'::regprocedure;
        v_set oid := 'public.set_x_account_publish_authority(text,text,text,timestamptz,timestamptz)'::regprocedure;
        v_stop_a oid := 'public.postona_x_stop_account_publishing(text,text)'::regprocedure;
        v_stop_u oid := 'public.postona_x_stop_publishing_for_user(uuid,text)'::regprocedure;
        v_fn oid;
begin
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_check and not p.prosecdef and p.provolatile = 's'
                 and p.proconfig = array['search_path=""'])
     or not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_set and p.prosecdef and p.proconfig = array['search_path=""']) then
    raise exception 'X_PUBLISH_ENTITLEMENT_POSTCONDITION:STAGE3B_SHAPE';
  end if;
  foreach v_fn in array array[v_check, v_set, v_stop_a, v_stop_u] loop
    if pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                  where p.oid = v_fn and a.grantee <> p.proowner
                    and not (a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE' and not a.is_grantable)) then
      raise exception 'X_PUBLISH_ENTITLEMENT_POSTCONDITION:ACL %', v_fn::regprocedure;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid in (v_stop_a, v_stop_u) and p.prosecdef
                 and p.proconfig = array['search_path=""'] having count(*) = 2) then
    raise exception 'X_PUBLISH_ENTITLEMENT_POSTCONDITION:STOP_SHAPE';
  end if;
  if pg_catalog.has_function_privilege('service_role', 'private.account_lifecycle_assert_brand_service_active(text,text)', 'EXECUTE') then
    raise exception 'X_PUBLISH_ENTITLEMENT_POSTCONDITION:G5_ORDERING_REACHABLE';
  end if;
end $$;

commit;
