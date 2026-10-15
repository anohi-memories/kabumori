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
--   stopped                      -> continue (x_posts_unconfirmed > 0 => reconciliation_required: an X post
--                                   whose result is unknown; the saga reports it, it is never success-by-silence)
--   blocked POSTING_IN_PROGRESS  -> a reservation is claimed or a brand_post is running / publishing: publishing
--                                   is ALREADY stopped; retry after it settles (F5 9.3 (b))
--   blocked NON_X_ACCOUNT_PRESENT -> a non-X social account is still in the workspace: the other providers must be
--                                   removed first (F5 9.3 (a)); nothing X-side was revoked or removed yet
--   blocked SHARED_WORKSPACE / WORKSPACE_NOT_SELF_SERVICE -> never on one person's word (F5 9.3 (d))
--   not_applicable               -> the deletion is already purged / handed to an operator
-- Lock order is the saga's own: deletion lock -> workspace lock -> rows (social_mobile_account_deletion_hold).
-- Remote X authorization is revoked by the saga's existing step (X API answer verified), never here.
--
-- J3 V3 repairs (2026-10-13):
--   R1 every reservation whose X result is unknown ('uncertain') is CHECKPOINTED durably, before the pre-purge
--      removal and the purge, in social_mobile_account_deletion_x_unconfirmed (keyed by the subject hash the saga's
--      audit already uses, never the raw user id). Every stop / precheck answer carries the durable count
--      (x_posts_unconfirmed), so a retry after a committed purge, a failed finalize or a lease takeover -- or a
--      whole new run after finalize -- still reports it. It is cleared only by an explicit acknowledgement
--      (social_mobile_account_deletion_x_unconfirmed_ack, service_role, compare-and-clear, never during a
--      deletion). Until then it over-reports rather than under-reports.
--   R3 hold() checks the lease against now() (transaction start) AFTER waiting on the deletion and workspace
--      locks; stop_x re-checks it against clock_timestamp() after those locks and before any write
--      (SOCIAL_MOBILE_DELETION_LEASE_LOST). hold() itself is inherited and not edited here.
--
-- J3 V3 re-review repairs (2026-10-15):
--   R1a the acknowledgement names the EXACT evidence it clears: every answer carries x_unconfirmed_snapshot, a
--       SHA-256 over the subject and the exact set of checkpointed reservation ids. ack(user, snapshot) clears only
--       when the current set is that set (under the saga's deletion lock), records a receipt, and answers a replay
--       of the same snapshot as acknowledged WITHOUT clearing anything again -- so a delayed / retried ACK can never
--       clear a later set of the same size. The former count-only ack(user, integer) stays only as a fail-closed
--       shim: it answers snapshot_required and clears nothing.
--   R3a stop_x writes through rows it may still have to WAIT for after the R3 check (social_accounts FOR UPDATE
--       in the stop, reservation rows in the sweep, authority rows). The lease is therefore checked on the wall
--       clock again AFTER every write, right before the answer: an expired lease raises
--       SOCIAL_MOBILE_DELETION_LEASE_LOST and the WHOLE transaction (authority, reservations, their audit, the
--       checkpoint, hold's guard bypass) rolls back. Lock order unchanged: deletion -> workspace -> rows.
--   R1b the rollback takes the checkpoint tables' ACCESS EXCLUSIVE lock BEFORE it looks for evidence (see
--       002_..._rollback.sql).
begin;

do $$
begin
  if to_regprocedure('public.social_mobile_account_deletion_hold(uuid,uuid)') is null
     or to_regprocedure('public.social_mobile_account_deletion_purge(uuid,uuid)') is null
     or to_regprocedure('public.social_mobile_account_deletion_subject(uuid)') is null
     or to_regclass('public.x_account_publish_authority') is null
     or to_regprocedure('public.postona_x_stop_account_publishing(text,text)') is null then
    raise exception 'X_SAGA_STOP_PRECONDITION_MISSING';
  end if;
  if to_regprocedure('public.social_mobile_account_deletion_stop_x(uuid,uuid)') is not null
     or to_regprocedure('public.social_mobile_account_deletion_x_precheck(uuid)') is not null
     or to_regprocedure('public.social_mobile_account_deletion_x_unconfirmed_ack(uuid,integer)') is not null
     or to_regprocedure('public.social_mobile_account_deletion_x_unconfirmed_ack(uuid,text)') is not null
     or to_regprocedure('public.social_mobile_account_deletion_x_unconfirmed_snapshot(text)') is not null
     or to_regclass('public.social_mobile_account_deletion_x_unconfirmed') is not null
     or to_regclass('public.social_mobile_account_deletion_x_unconfirmed_ack_receipts') is not null then
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

-- R1: the durable checkpoint of X posts whose result is unknown. No raw user id (subject hash, as the saga's audit);
-- reservation ids are random. No API role can read or write it; only the SECURITY DEFINER functions below.
create table public.social_mobile_account_deletion_x_unconfirmed (
  subject_sha256 text not null check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  reservation_id uuid not null,
  recorded_at timestamptz not null default now(),
  primary key (subject_sha256, reservation_id)
);
alter table public.social_mobile_account_deletion_x_unconfirmed enable row level security;
revoke all on table public.social_mobile_account_deletion_x_unconfirmed from public, anon, authenticated, service_role;

-- R1a: one receipt per acknowledged snapshot (subject hash, digest, how many rows it cleared). A replayed ACK is
-- answered from here and clears nothing.
create table public.social_mobile_account_deletion_x_unconfirmed_ack_receipts (
  subject_sha256 text not null check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot text not null check (snapshot ~ '^[0-9a-f]{64}$'),
  cleared integer not null check (cleared > 0),
  acknowledged_at timestamptz not null default now(),
  primary key (subject_sha256, snapshot)
);
alter table public.social_mobile_account_deletion_x_unconfirmed_ack_receipts enable row level security;
revoke all on table public.social_mobile_account_deletion_x_unconfirmed_ack_receipts from public, anon, authenticated, service_role;

-- R1a: the durable count and its snapshot (null when nothing is checkpointed). Internal: no API role may call it.
create function public.social_mobile_account_deletion_x_unconfirmed_snapshot(p_subject text)
returns jsonb language sql stable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'x_posts_unconfirmed', count(*)::integer,
    'x_unconfirmed_snapshot', case when count(*) = 0 then null else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      'x_unconfirmed:v1:' || p_subject || ':' || pg_catalog.string_agg(u.reservation_id::text, ',' order by u.reservation_id), 'UTF8')), 'hex') end,
    'reconciliation_required', count(*) > 0)
  from public.social_mobile_account_deletion_x_unconfirmed u where u.subject_sha256 = p_subject
$$;
revoke all on function public.social_mobile_account_deletion_x_unconfirmed_snapshot(text) from public, anon, authenticated, service_role;

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
        v_result jsonb;
        v_subject text := public.social_mobile_account_deletion_subject(p_user_id);
        v_resv boolean := to_regclass('postona_x_resv.reservations') is not null;
begin
  -- The saga's lease (LEASE_LOST otherwise), its lock order, and the guard bypass for this transaction only.
  -- hold() locks the tombstone row FOR UPDATE: its lease cannot change until this transaction ends.
  v_row := public.social_mobile_account_deletion_hold(p_user_id, p_lease);
  -- R3: hold() compared the lease with now() (transaction start) after WAITING on its locks; re-check it on the
  -- wall clock before the first write (the error rolls back hold's guard bypass too).
  if v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'SOCIAL_MOBILE_DELETION_LEASE_LOST';
  end if;
  <<body>>
  begin
    if v_row.state not in ('started', 'x_revoked') then
      v_result := pg_catalog.jsonb_build_object('status', 'not_applicable', 'state', v_row.state)
                  || public.social_mobile_account_deletion_x_unconfirmed_snapshot(v_subject);
      exit body;
    end if;
    v_ws := v_row.workspace_id;
    select b.code_profile_key into v_profile from public.brands b where b.id = v_ws;
    if not found then
      v_result := pg_catalog.jsonb_build_object('status', 'stopped', 'accounts', '[]'::jsonb, 'reservations_uncertain', 0,
                    'remote_authorization', 'not_applicable')
                  || public.social_mobile_account_deletion_x_unconfirmed_snapshot(v_subject);
      exit body;
    end if;
    if v_profile is distinct from 'social_mobile_user_v1' then
      v_result := pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'WORKSPACE_NOT_SELF_SERVICE');
      exit body;
    end if;
    if exists (select 1 from public.brand_memberships m where m.brand_id = v_ws and m.user_id <> p_user_id) then
      v_result := pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'SHARED_WORKSPACE');
      exit body;
    end if;
    -- A claimed reservation whose lease already ran out is in an unknown state: fence it (as claim_due's sweep).
    -- (May wait on a reservation row a worker holds -- covered by the late fence below.)
    if v_resv then
      execute 'with s as (update postona_x_resv.reservations r set status = ''uncertain'', outcome_code = ''LEASE_EXPIRED'', updated_at = pg_catalog.now()
                          where r.brand_id = $1 and r.status = ''claimed'' and r.lease_expires_at <= pg_catalog.clock_timestamp() returning 1)
               select count(*)::integer from s' into v_swept using v_ws;
    end if;
    -- Stop every X account of the workspace (authority revoked, planned reservations cancelled), idempotently.
    -- (Locks each social_accounts row FOR UPDATE and may wait on it -- covered by the late fence below.)
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
      -- R1: checkpoint every unknown-result reservation durably BEFORE anything that removes them (idempotent).
      execute 'insert into public.social_mobile_account_deletion_x_unconfirmed (subject_sha256, reservation_id)
               select $1, r.id from postona_x_resv.reservations r where r.brand_id = $2 and r.status = ''uncertain''
               on conflict do nothing' using v_subject, v_ws;
    end if;
    if v_claimed + v_running + v_publishing > 0 then
      v_result := pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'POSTING_IN_PROGRESS', 'accounts', v_accounts,
                    'reservations_in_flight', v_claimed, 'brand_posts_running', v_running, 'publish_claims_publishing', v_publishing,
                    'reservations_uncertain', v_uncertain, 'publishing_stopped', true)
                  || public.social_mobile_account_deletion_x_unconfirmed_snapshot(v_subject);
      exit body;
    end if;
    select count(*)::integer into v_non_x from public.social_accounts sa where sa.brand_id = v_ws and sa.platform is distinct from 'x';
    if v_non_x > 0 then
      v_result := pg_catalog.jsonb_build_object('status', 'blocked', 'reason', 'NON_X_ACCOUNT_PRESENT', 'accounts', v_accounts,
                    'non_x_accounts', v_non_x, 'publishing_stopped', true);
      exit body;
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
    v_result := pg_catalog.jsonb_build_object('status', 'stopped', 'accounts', v_accounts,
                  'reservations_lease_expired_fenced', v_swept, 'reservations_uncertain', v_uncertain,
                  'remote_authorization', case v_row.state when 'x_revoked' then 'revoked_by_saga' else 'pending_saga_revoke' end)
                || public.social_mobile_account_deletion_x_unconfirmed_snapshot(v_subject);
  end body;
  -- R3a: the late fence. Every write above (and every row-lock wait it needed) is done; nothing after this waits.
  -- If the lease ran out meanwhile, nothing of this call may stand: raising rolls the whole transaction back.
  if v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'SOCIAL_MOBILE_DELETION_LEASE_LOST';
  end if;
  return v_result;
end;
$$;

-- Read-only, BEFORE acquire (no tombstone, no lock): a non-X social account still in the workspace refuses the saga
-- up front. The saga binds its credential set at acquire, so a non-X account removed after that would otherwise turn
-- into an operator hand-off (CREDENTIALS_CHANGED); refusing first lets the other providers be removed and the saga
-- start clean (F5 9.3 (a)). stop_x keeps the same check as a second line. It also reports the durable count of X
-- posts whose result is unknown (R1) and its snapshot (R1a), so even a run that starts after a finished deletion
-- reports it.
create function public.social_mobile_account_deletion_x_precheck(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('non_x_accounts', (
    select count(*)::integer from public.social_accounts sa
     where sa.brand_id = public.social_mobile_account_deletion_workspace(p_user_id) and sa.platform is distinct from 'x'))
  || public.social_mobile_account_deletion_x_unconfirmed_snapshot(public.social_mobile_account_deletion_subject(p_user_id))
$$;

-- R1/R1a: the caller (G5/F5, after it recorded the count AND the snapshot in its own durable state) acknowledges
-- exactly the evidence it saw. Under the saga's deletion lock (the lock stop_x's checkpoint is written under):
--   deletion_in_progress -> a deletion of this person exists (the set may still grow): nothing cleared
--   acknowledged replay  -> this snapshot was already acknowledged: nothing cleared again (idempotent)
--   snapshot_changed     -> the current set is not the one the caller saw (or is empty): nothing cleared; the
--                           answer carries the current count / snapshot to be RECORDED before any new ACK
--   acknowledged         -> the set cleared, the receipt recorded
create function public.social_mobile_account_deletion_x_unconfirmed_ack(p_user_id uuid, p_snapshot text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_subject text;
        v_current jsonb;
        v_cleared integer;
begin
  if p_user_id is null or p_snapshot is null or p_snapshot !~ '^[0-9a-f]{64}$' then
    raise exception 'SOCIAL_MOBILE_DELETION_ACK_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('social_mobile_account_deletion:' || p_user_id::text, 0));
  if exists (select 1 from public.social_mobile_account_deletions d where d.user_id = p_user_id) then
    return pg_catalog.jsonb_build_object('status', 'deletion_in_progress');
  end if;
  v_subject := public.social_mobile_account_deletion_subject(p_user_id);
  select r.cleared into v_cleared from public.social_mobile_account_deletion_x_unconfirmed_ack_receipts r
   where r.subject_sha256 = v_subject and r.snapshot = p_snapshot;
  if found then
    return pg_catalog.jsonb_build_object('status', 'acknowledged', 'replay', true, 'cleared', v_cleared);
  end if;
  v_current := public.social_mobile_account_deletion_x_unconfirmed_snapshot(v_subject);
  if v_current ->> 'x_unconfirmed_snapshot' is distinct from p_snapshot then
    return pg_catalog.jsonb_build_object('status', 'snapshot_changed') || v_current;
  end if;
  delete from public.social_mobile_account_deletion_x_unconfirmed u where u.subject_sha256 = v_subject;
  get diagnostics v_cleared = row_count;
  insert into public.social_mobile_account_deletion_x_unconfirmed_ack_receipts (subject_sha256, snapshot, cleared)
  values (v_subject, p_snapshot, v_cleared);
  return pg_catalog.jsonb_build_object('status', 'acknowledged', 'replay', false, 'cleared', v_cleared);
end;
$$;

-- R1a: the former count-only acknowledgement (F5 PR #193 still sends it) names no evidence set, so it can never be
-- safe (ABA). It is kept only so such a caller gets a typed refusal: it clears NOTHING.
create function public.social_mobile_account_deletion_x_unconfirmed_ack(p_user_id uuid, p_expected integer)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('status', 'snapshot_required')
$$;

revoke all on function public.social_mobile_account_deletion_stop_x(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.social_mobile_account_deletion_stop_x(uuid, uuid) to service_role;
revoke all on function public.social_mobile_account_deletion_x_precheck(uuid) from public, anon, authenticated, service_role;
grant execute on function public.social_mobile_account_deletion_x_precheck(uuid) to service_role;
revoke all on function public.social_mobile_account_deletion_x_unconfirmed_ack(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.social_mobile_account_deletion_x_unconfirmed_ack(uuid, integer) to service_role;
revoke all on function public.social_mobile_account_deletion_x_unconfirmed_ack(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.social_mobile_account_deletion_x_unconfirmed_ack(uuid, text) to service_role;

do $$
declare v_fn oid;
begin
  foreach v_fn in array array['public.social_mobile_account_deletion_stop_x(uuid,uuid)'::regprocedure::oid,
                              'public.social_mobile_account_deletion_x_precheck(uuid)'::regprocedure::oid,
                              'public.social_mobile_account_deletion_x_unconfirmed_ack(uuid,integer)'::regprocedure::oid,
                              'public.social_mobile_account_deletion_x_unconfirmed_ack(uuid,text)'::regprocedure::oid] loop
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and p.prosecdef and p.proconfig = array['search_path=""'])
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                where p.oid = v_fn and a.grantee <> p.proowner
                  and not (a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE' and not a.is_grantable)) then
    raise exception 'X_SAGA_STOP_POSTCONDITION %', v_fn::regprocedure;
  end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('public.social_mobile_account_deletion_x_unconfirmed'::regclass,
                              'public.social_mobile_account_deletion_x_unconfirmed_ack_receipts'::regclass)
                and (not c.relrowsecurity or c.relowner <> (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)))
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role),
                       unnest(array['public.social_mobile_account_deletion_x_unconfirmed',
                                    'public.social_mobile_account_deletion_x_unconfirmed_ack_receipts']) t(tbl)
                where pg_catalog.has_table_privilege(r.role, t.tbl, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) then
    raise exception 'X_SAGA_STOP_POSTCONDITION x_unconfirmed tables';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.oid = 'public.social_mobile_account_deletion_x_unconfirmed_snapshot(text)'::regprocedure
              and (p.prosecdef or p.proconfig is distinct from array['search_path=""']))
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r(role)
                where pg_catalog.has_function_privilege(r.role, 'public.social_mobile_account_deletion_x_unconfirmed_snapshot(text)', 'EXECUTE'))
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                where p.oid = 'public.social_mobile_account_deletion_x_unconfirmed_snapshot(text)'::regprocedure and a.grantee <> p.proowner) then
    raise exception 'X_SAGA_STOP_POSTCONDITION x_unconfirmed snapshot';
  end if;
end $$;

commit;
