-- POSTONA X service end — the X deletion saga's stop step (F3 SOURCE CANDIDATE, 2026-10-13). NOT in supabase/migrations/.
-- Applies after: the social-mobile deletion saga (20260928160000), the Stage 3B publish authority (20261006160200),
-- the F3 entitlement guard 001 (postona_x_stop_account_publishing) and, when present, the F3 reservation
-- candidate. Never apply without the reviewed rollout (G5/F5 approval, Sol（高） review, user approval).
--
-- public.social_mobile_account_deletion_stop_x(p_user_id, p_lease) -> jsonb, called by the X saga
-- (social-mobile-account-delete) with ITS OWN deletion lease, twice per attempt:
--   1. right after acquire, BEFORE any credential is read, revoked at X or removed:
--      every X account of the workspace -> publish authority 'revoked', planned reservations cancelled
--      (postona_x_stop_account_publishing, idempotent); expired reservation leases are fenced to 'uncertain'
--      first (never counted as safe);
--   2. again right before the purge (state x_revoked, the saga has revoked the X tokens): the same stop, then the
--      workspace's publish-authority rows (a NO ACTION reference that otherwise makes the purge fail) and this
--      person's reservation audit rows are removed with the rest of the workspace.
-- It answers a TYPED outcome and never escalates to an operator itself:
--   stopped                      -> continue (reservations_uncertain > 0 => reconciliation_required: an X post
--                                   whose result is unknown; the saga reports it, it is never success-by-silence)
--   blocked POSTING_IN_PROGRESS  -> a reservation is claimed or a brand_post is running / publishing: publishing
--                                   is ALREADY stopped; retry after it settles (F5 9.3 (b))
--   blocked NON_X_ACCOUNT_PRESENT -> a non-X social account is still in the workspace: the other providers must be
--                                   removed first (F5 9.3 (a)); nothing X-side was revoked or removed yet
--   blocked SHARED_WORKSPACE / WORKSPACE_NOT_SELF_SERVICE -> never on one person's word (F5 9.3 (d))
--   not_applicable               -> the deletion is already purged / handed to an operator
-- Lock order is the saga's own: deletion lock -> workspace lock -> rows (social_mobile_account_deletion_hold).
-- Remote X authorization is revoked by the saga's existing step (X API answer verified), never here.
begin;

do $$
begin
  if to_regprocedure('public.social_mobile_account_deletion_hold(uuid,uuid)') is null
     or to_regprocedure('public.social_mobile_account_deletion_purge(uuid,uuid)') is null
     or to_regclass('public.x_account_publish_authority') is null
     or to_regprocedure('public.postona_x_stop_account_publishing(text,text)') is null then
    raise exception 'X_SAGA_STOP_PRECONDITION_MISSING';
  end if;
  if to_regprocedure('public.social_mobile_account_deletion_stop_x(uuid,uuid)') is not null
     or to_regprocedure('public.social_mobile_account_deletion_x_precheck(uuid)') is not null then
    raise exception 'X_SAGA_STOP_ALREADY_APPLIED';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = current_user) is distinct from false
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.social_mobile_account_deletion_hold(uuid,uuid)'::regprocedure)
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.postona_x_stop_account_publishing(text,text)'::regprocedure)
          is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'X_SAGA_STOP_PRECONDITION_OWNER';
  end if;
end $$;

create function public.social_mobile_account_deletion_stop_x(p_user_id uuid, p_lease uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.social_mobile_account_deletions;
        v_ws text;
        v_profile text;
        v_acc record;
        v_r jsonb;
        v_accounts jsonb := '[]'::jsonb;
        v_claimed integer := 0;
        v_running integer := 0;
        v_publishing integer := 0;
        v_uncertain integer := 0;
        v_swept integer := 0;
        v_non_x integer := 0;
        v_resv boolean := to_regclass('postona_x_resv.reservations') is not null;
begin
  -- The saga's lease (LEASE_LOST otherwise), its lock order, and the guard bypass for this transaction only.
  v_row := public.social_mobile_account_deletion_hold(p_user_id, p_lease);
  if v_row.state not in ('started', 'x_revoked') then
    return pg_catalog.jsonb_build_object('status', 'not_applicable', 'state', v_row.state);
  end if;
  v_ws := v_row.workspace_id;
  select b.code_profile_key into v_profile from public.brands b where b.id = v_ws;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'stopped', 'accounts', '[]'::jsonb, 'reservations_uncertain', 0,
      'reconciliation_required', false, 'remote_authorization', 'not_applicable');
  end if;
  if v_profile is distinct from 'social_mobile_user_v1' then
    return pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'WORKSPACE_NOT_SELF_SERVICE');
  end if;
  if exists (select 1 from public.brand_memberships m where m.brand_id = v_ws and m.user_id <> p_user_id) then
    return pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'SHARED_WORKSPACE');
  end if;
  -- A claimed reservation whose lease already ran out is in an unknown state: fence it (as claim_due's sweep).
  if v_resv then
    execute 'with s as (update postona_x_resv.reservations r set status = ''uncertain'', outcome_code = ''LEASE_EXPIRED'', updated_at = pg_catalog.now()
                        where r.brand_id = $1 and r.status = ''claimed'' and r.lease_expires_at <= pg_catalog.clock_timestamp() returning 1)
             select count(*)::integer from s' into v_swept using v_ws;
  end if;
  -- Stop every X account of the workspace (authority revoked, planned reservations cancelled), idempotently.
  for v_acc in select sa.id from public.social_accounts sa where sa.brand_id = v_ws and sa.platform = 'x' order by sa.id loop
    v_r := public.postona_x_stop_account_publishing(v_acc.id, 'SOCIAL_MOBILE_DELETION');
    v_accounts := v_accounts || pg_catalog.jsonb_build_object(
      'social_account_id', v_r ->> 'social_account_id', 'authority', v_r ->> 'authority',
      'reservations_cancelled', (v_r ->> 'reservations_cancelled')::integer);
    v_claimed := v_claimed + (v_r ->> 'reservations_in_flight')::integer;
    v_running := v_running + (v_r ->> 'brand_posts_running')::integer;
  end loop;
  select count(*)::integer into v_publishing from public.publish_claims pc where pc.brand_id = v_ws and pc.status = 'publishing';
  if v_resv then
    execute 'select count(*)::integer from postona_x_resv.reservations r where r.brand_id = $1 and r.status = ''uncertain'''
      into v_uncertain using v_ws;
  end if;
  if v_claimed + v_running + v_publishing > 0 then
    return pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'POSTING_IN_PROGRESS', 'accounts', v_accounts,
      'reservations_in_flight', v_claimed, 'brand_posts_running', v_running, 'publish_claims_publishing', v_publishing,
      'reservations_uncertain', v_uncertain, 'publishing_stopped', true);
  end if;
  select count(*)::integer into v_non_x from public.social_accounts sa where sa.brand_id = v_ws and sa.platform is distinct from 'x';
  if v_non_x > 0 then
    return pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'NON_X_ACCOUNT_PRESENT', 'accounts', v_accounts,
      'non_x_accounts', v_non_x, 'publishing_stopped', true);
  end if;
  if v_row.state = 'x_revoked' then
    -- Pre-purge: the saga has revoked the X tokens; the authority rows (NO ACTION reference to social_accounts)
    -- and this person's reservation audit go with the workspace.
    delete from public.x_account_publish_authority pa
     where pa.social_account_id in (select sa.id from public.social_accounts sa where sa.brand_id = v_ws);
    if to_regclass('postona_x_resv.audit') is not null then
      execute 'delete from postona_x_resv.audit a where a.user_id = $1' using p_user_id;
    end if;
  end if;
  return pg_catalog.jsonb_build_object('status', 'stopped', 'accounts', v_accounts,
    'reservations_lease_expired_fenced', v_swept, 'reservations_uncertain', v_uncertain,
    'reconciliation_required', v_uncertain > 0,
    'remote_authorization', case v_row.state when 'x_revoked' then 'revoked_by_saga' else 'pending_saga_revoke' end);
end;
$$;

-- Read-only, BEFORE acquire (no tombstone, no lock): a non-X social account still in the workspace refuses the saga
-- up front. The saga binds its credential set at acquire, so a non-X account removed after that would otherwise turn
-- into an operator hand-off (CREDENTIALS_CHANGED); refusing first lets the other providers be removed and the saga
-- start clean (F5 9.3 (a)). stop_x keeps the same check as a second line.
create function public.social_mobile_account_deletion_x_precheck(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('non_x_accounts', (
    select count(*)::integer from public.social_accounts sa
     where sa.brand_id = public.social_mobile_account_deletion_workspace(p_user_id) and sa.platform is distinct from 'x'))
$$;

revoke all on function public.social_mobile_account_deletion_stop_x(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.social_mobile_account_deletion_stop_x(uuid, uuid) to service_role;
revoke all on function public.social_mobile_account_deletion_x_precheck(uuid) from public, anon, authenticated, service_role;
grant execute on function public.social_mobile_account_deletion_x_precheck(uuid) to service_role;

do $$
declare v_fn oid;
begin
  foreach v_fn in array array['public.social_mobile_account_deletion_stop_x(uuid,uuid)'::regprocedure::oid,
                              'public.social_mobile_account_deletion_x_precheck(uuid)'::regprocedure::oid] loop
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig = array['search_path=""'])
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                where p.oid = v_fn and a.grantee <> p.proowner
                  and not (a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE' and not a.is_grantable)) then
    raise exception 'X_SAGA_STOP_POSTCONDITION %', v_fn::regprocedure;
  end if;
  end loop;
end $$;

commit;
