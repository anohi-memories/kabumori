-- G3 SOURCE CANDIDATE (2026-11-05, Issue #589 G3-02 #16; G3-02 #17: H1 #37 P2-1 / P2-2 fixed): post approval + the person's notification
-- events. NOT applied anywhere.
-- Applied last, after 001-006, 008, 010, 012, 014, 015 and 017; rolled back FIRST with 018_..._rollback.sql.
--
-- A post candidate is NOT a reservation. The person submits it (pending_approval), may revise it, then approves or rejects it. Only an
-- approval creates a reservation, through 001's create_batch in the same transaction, with every gate that create has (person
-- session, brand owner + personal profile, G5 service, G4 verdict + connection generation, time / text / slot rules). So a candidate
-- that is not approved is never in the reservations table, and the worker (claim_due / row_publishable / pre_publish_check,
-- unchanged) never sees it. Reservations made the existing way are unchanged and need no approval.
--
-- New, and all of it (no existing function, table, type, trigger or grant is replaced or altered):
--   tables  approval_candidates, notifications, push_outbox (owner only; no grant to any role)
--   types   approval_view, notification_view (results)
--   SECURITY DEFINER functions, EXECUTE to postona_resv_api only (the reservation API's role; the Edge entry postona-x-approvals):
--     submit_approval, revise_approval, approve_candidate, reject_candidate, list_approvals, get_approval,
--     list_notifications, mark_notification_read
--   internal (no grant): approval_generation_active, approval_workspace_live, notify, sync_reservation_notifications
--
-- Rules (each refusal a fixed POSTONA_RESV_* code, nothing written):
--   - every call: caller() (G5's person session S2-2); a row of another person and an unknown id give the same NOT_FOUND;
--   - submit / revise: assert_account_access (as create) + the same text and time rules as create; the G5 generation AND G4's
--     credential generation of the X connection (014's x_credential_generation: +1 on every completed connect / disconnect) are recorded;
--   - approve: the caller's own pending candidate at exactly the expected revision and content hash; the candidate's G5 generation still
--     active (G5's MV) and the X connection still the one it was submitted / revised under (G3-02 #17, H1 #37 P2-1: a disconnect +
--     reconnect of the same account, with G5's generation unchanged, refuses APPROVAL_GENERATION_CHANGED; a revise under the new
--     connection is the person's explicit re-confirmation and rebinds it); then create_batch, and the connection is checked once more
--     after it, in the same transaction. A retry of the SAME approval (expected revision = current - 1, same hash) returns the same
--     answer and creates nothing; any other approve of a decided candidate is refused;
--   - reject: own pending candidate at the expected revision (no service gate: deciding not to post needs none); the same retry rule;
--   - list / get / list_notifications / mark_notification_read: own rows only, of a workspace the caller still owns.
-- Notifications: one row per (person, event key), so a retry or a race never makes a second one. approval_requested (per revision),
-- approval_approved, approval_rejected are written in the decision's own transaction; reservation_changed (a later reschedule, send
-- result, cancel or expiry of an approved candidate's reservation) is derived from the reservation's confirmed state when the person
-- lists notifications, so a missed event is never lost: the next list writes it. G3-02 #17 (H1 #37 P2-2): every notification write
-- (and its outbox row) is made only while the workspace is still the caller's own personal one (G5's eligibility 'own' + the owner
-- membership), checked in the INSERT statement itself; a former owner's list writes nothing. Each new notification also gets a push_outbox row
-- (state pending). Nothing reads the outbox in this candidate: a later, separately reviewed push worker does; no push is sent here.
-- Payloads carry ids, states, revisions and times only: no post text, no token, no account handle.
-- Refuses (nothing changed) when: already applied; 001 / 008 (personal MVP) / 014 / 017 are not there; the caller is a superuser or does
-- not own the schema, the reservations table and create_batch. Postconditions: postona_resv_api reaches exactly 001 / 002's six
-- functions plus these eight; no other role reaches any of them; nothing is granted on the new tables.

begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if pg_catalog.to_regclass('postona_x_resv.approval_candidates') is not null then
    raise exception 'G3_APPROVALS_ALREADY_APPLIED';
  end if;
  if pg_catalog.to_regprocedure('postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb)') is null
     or pg_catalog.to_regtype('postona_x_resv.reservation_read_view') is null
     or pg_catalog.to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)') is null
     or pg_catalog.to_regprocedure('private.postona_personal_workspace_eligibility(uuid)') is null
     or pg_catalog.to_regprocedure('postona_x_resv.x_credential_generation(text)') is null
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.g5_bound_state(postona_x_resv.reservations)')) !~ 'G3_G5_PROFILE_MVP'
     or (select p.prosrc from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('postona_x_resv.g4_x_account_verified(uuid,text)')) !~ 'postona_x_refresh_precheck_v1'
     or pg_catalog.to_regrole('postona_resv_api') is null then
    raise exception 'G3_APPROVALS_BASE_UNKNOWN';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner
     or (select c.relowner from pg_catalog.pg_class c where c.oid = 'postona_x_resv.reservations'::pg_catalog.regclass) is distinct from v_owner
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = 'postona_x_resv.create_batch(text,uuid,integer,text,jsonb,jsonb)'::pg_catalog.regprocedure) is distinct from v_owner then
    raise exception 'G3_APPROVALS_OWNER';
  end if;
end $$;

create table postona_x_resv.approval_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  brand_id text not null references public.brands (id) on delete cascade,
  social_account_id text not null references public.social_accounts (id) on delete cascade,
  client_request_id uuid not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  body text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  scheduled_at timestamptz not null check (isfinite(scheduled_at)),
  state text not null default 'pending_approval' check (state in ('pending_approval', 'approved', 'rejected')),
  revision integer not null default 1 check (revision >= 1),
  bound_lifecycle_version bigint not null check (bound_lifecycle_version >= 1),
  bound_credential_generation text not null check (bound_credential_generation ~ '^[0-9a-f]{64}$'),
  reservation_id uuid references postona_x_resv.reservations (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_request_id),
  check ((state = 'pending_approval') = (decided_at is null)),
  check (state = 'approved' or reservation_id is null)
);
create index approval_candidates_user_account on postona_x_resv.approval_candidates (user_id, social_account_id, created_at);

create table postona_x_resv.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  brand_id text not null references public.brands (id) on delete cascade,
  event_key text not null check (event_key ~ '^[a-z_]{1,32}:[0-9a-f-]{36}(:[a-z0-9_]{1,32}){0,3}$'),
  kind text not null check (kind in ('approval_requested', 'approval_approved', 'approval_rejected', 'reservation_changed')),
  candidate_id uuid references postona_x_resv.approval_candidates (id) on delete cascade,
  reservation_id uuid,
  subject_revision integer not null check (subject_revision >= 1),
  state text not null check (state ~ '^[a-z_]{1,32}$'),
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, event_key)
);
create index notifications_user_created on postona_x_resv.notifications (user_id, created_at desc, id);

/** The outbox a later, separately reviewed push worker reads. Nothing in this candidate reads, claims or sends it. */
create table postona_x_resv.push_outbox (
  notification_id uuid primary key references postona_x_resv.notifications (id) on delete cascade,
  user_id uuid not null,
  state text not null default 'pending' check (state = 'pending'),
  created_at timestamptz not null default now()
);

revoke all on table postona_x_resv.approval_candidates, postona_x_resv.notifications, postona_x_resv.push_outbox from public;

create type postona_x_resv.approval_view as (
  candidate_id uuid, social_account_id text, body text, content_sha256 text, scheduled_at timestamptz, state text, revision integer,
  reservation_id uuid, decided_at timestamptz, created_at timestamptz
);
create type postona_x_resv.notification_view as (
  notification_id uuid, kind text, candidate_id uuid, reservation_id uuid, subject_revision integer, state text,
  scheduled_at timestamptz, created_at timestamptz, read_at timestamptz
);
revoke all on type postona_x_resv.approval_view, postona_x_resv.notification_view from public;

/** G5's MV still answers 'active' for the generation the candidate was submitted under. Missing / any other answer: false. Internal. */
create function postona_x_resv.approval_generation_active(p_user_id uuid, p_brand_id text, p_lifecycle bigint) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  return coalesce(private.postona_personal_worker_verdict(p_user_id, p_brand_id, 'x_autopost', p_lifecycle) = 'active', false);
exception when others then
  return false;
end $$;

/** The workspace is still the caller's own personal one: the derived id, G5's eligibility 'own', the owner membership. Internal. */
create function postona_x_resv.approval_workspace_live(p_user_id uuid, p_brand_id text) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  return p_brand_id = 'u_' || pg_catalog.substr(pg_catalog.md5(p_user_id::text), 1, 24)
     and coalesce(private.postona_personal_workspace_eligibility(p_user_id) = 'own', false)
     and exists (select 1 from public.brand_memberships bm where bm.brand_id = p_brand_id and bm.user_id = p_user_id and bm.role = 'owner');
exception when others then
  return false;
end $$;

/** The X connection's current credential generation (014), or NULL. Internal. */
create function postona_x_resv.approval_credential_generation(p_social_account_id text) returns text
language plpgsql stable set search_path = '' as $$
begin
  return postona_x_resv.x_credential_generation(p_social_account_id);
exception when others then
  return null;
end $$;

/** One notification + its outbox row, once per (person, event key), and only while the workspace is still theirs. Internal. */
create function postona_x_resv.notify(p_user_id uuid, p_brand_id text, p_event_key text, p_kind text, p_candidate_id uuid,
                                      p_reservation_id uuid, p_revision integer, p_state text, p_scheduled_at timestamptz) returns void
language plpgsql volatile set search_path = '' as $$
declare v_id uuid;
begin
  insert into postona_x_resv.notifications (user_id, brand_id, event_key, kind, candidate_id, reservation_id, subject_revision, state, scheduled_at)
  select p_user_id, p_brand_id, p_event_key, p_kind, p_candidate_id, p_reservation_id, p_revision, p_state, p_scheduled_at
  where postona_x_resv.approval_workspace_live(p_user_id, p_brand_id)
  on conflict (user_id, event_key) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into postona_x_resv.push_outbox (notification_id, user_id) values (v_id, p_user_id);
  end if;
end $$;

/** reservation_changed for the caller's approved candidates whose reservation moved past what it was at approval. Internal. */
create function postona_x_resv.sync_reservation_notifications(p_user_id uuid) returns void
language plpgsql volatile set search_path = '' as $$
declare v record;
begin
  for v in
    select c.id as candidate_id, c.brand_id, r.id as reservation_id, r.revision, r.status, r.scheduled_at
    from postona_x_resv.approval_candidates c
    join postona_x_resv.reservations r on r.id = c.reservation_id and r.user_id = c.user_id
    where c.user_id = p_user_id and c.state = 'approved' and (r.revision > 1 or r.status <> 'planned')
      and postona_x_resv.approval_workspace_live(p_user_id, c.brand_id)
  loop
    perform postona_x_resv.notify(p_user_id, v.brand_id, 'reservation:' || v.reservation_id || ':r' || v.revision || ':' || v.status,
                                  'reservation_changed', v.candidate_id, v.reservation_id, v.revision, v.status, v.scheduled_at);
  end loop;
end $$;

/** The caller still owns the candidate's workspace (G5's personal workspace, as built by W0). */
create function postona_x_resv.approval_owned(p_user_id uuid, p_brand_id text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.brand_memberships bm where bm.brand_id = p_brand_id and bm.user_id = p_user_id and bm.role = 'owner')
$$;

create function postona_x_resv.approval_check_input(p_body text, p_scheduled_at timestamptz) returns text
language plpgsql stable set search_path = '' as $$
declare v_body text := pg_catalog.btrim(p_body);
begin
  if v_body is null or v_body = '' or postona_x_resv.x_weighted_length(v_body) > 280 then
    raise exception 'POSTONA_RESV_TEXT_INVALID' using errcode = 'P0001';
  end if;
  if p_scheduled_at is null or p_scheduled_at < pg_catalog.now() + interval '5 minutes' or p_scheduled_at > pg_catalog.now() + interval '90 days' then
    raise exception 'POSTONA_RESV_TIME_OUT_OF_RANGE' using errcode = 'P0001';
  end if;
  return v_body;
end $$;

/** Locks the caller's own candidate (another person's or an unknown id: NOT_FOUND; a workspace no longer owned: NOT_FOUND). */
create function postona_x_resv.lock_own_candidate(p_user_id uuid, p_candidate_id uuid) returns postona_x_resv.approval_candidates
language plpgsql volatile set search_path = '' as $$
declare v postona_x_resv.approval_candidates%rowtype;
begin
  select * into v from postona_x_resv.approval_candidates c where c.id = p_candidate_id for update;
  if not found or v.user_id is distinct from p_user_id or not postona_x_resv.approval_owned(p_user_id, v.brand_id) then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  return v;
end $$;

create function postona_x_resv.approval_row(p_candidate_id uuid) returns setof postona_x_resv.approval_view
language sql stable set search_path = '' as $$
  select c.id, c.social_account_id, c.body, c.content_sha256, c.scheduled_at, c.state, c.revision, c.reservation_id, c.decided_at, c.created_at
  from postona_x_resv.approval_candidates c where c.id = p_candidate_id
$$;

/** Submit a post candidate for approval. Idempotent per (person, client_request_id): the same request returns the stored row. */
create function postona_x_resv.submit_approval(p_social_account_id text, p_client_request_id uuid, p_body text, p_scheduled_at timestamptz)
returns setof postona_x_resv.approval_view
language plpgsql volatile security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller(); v_brand text; v_body text; v_lifecycle bigint; v_credential text; v_req text;
        v postona_x_resv.approval_candidates%rowtype;
begin
  if p_client_request_id is null then raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001'; end if;
  v_req := postona_x_resv.sha256_hex(pg_catalog.jsonb_build_object('account', p_social_account_id, 'body', p_body, 'at', p_scheduled_at)::text);
  select * into v from postona_x_resv.approval_candidates c where c.user_id = v_user and c.client_request_id = p_client_request_id;
  if found then
    if v.request_sha256 <> v_req or not postona_x_resv.approval_owned(v_user, v.brand_id) then
      raise exception 'POSTONA_RESV_IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
    end if;
    return query select * from postona_x_resv.approval_row(v.id);
    return;
  end if;
  v_brand := postona_x_resv.assert_account_access(v_user, p_social_account_id);
  v_body := postona_x_resv.approval_check_input(p_body, p_scheduled_at);
  select b.lifecycle_version into v_lifecycle from postona_x_resv.g5_r1_bound(v_brand) b;
  v_credential := postona_x_resv.approval_credential_generation(p_social_account_id);
  if v_credential is null then raise exception 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001'; end if;
  if (select count(*) from postona_x_resv.approval_candidates c where c.user_id = v_user and c.state = 'pending_approval') >= 200 then
    raise exception 'POSTONA_RESV_APPROVAL_CAPACITY' using errcode = 'P0001';
  end if;
  insert into postona_x_resv.approval_candidates (user_id, brand_id, social_account_id, client_request_id, request_sha256, body, content_sha256,
                                                  scheduled_at, bound_lifecycle_version, bound_credential_generation)
  values (v_user, v_brand, p_social_account_id, p_client_request_id, v_req, v_body, postona_x_resv.sha256_hex(v_body), p_scheduled_at, v_lifecycle,
          v_credential)
  on conflict (user_id, client_request_id) do nothing
  returning * into v;
  if v.id is null then   -- a concurrent submit of the same request won: compare with it
    select * into v from postona_x_resv.approval_candidates c where c.user_id = v_user and c.client_request_id = p_client_request_id;
    if v.request_sha256 <> v_req then raise exception 'POSTONA_RESV_IDEMPOTENCY_CONFLICT' using errcode = 'P0001'; end if;
    return query select * from postona_x_resv.approval_row(v.id);
    return;
  end if;
  perform postona_x_resv.notify(v_user, v_brand, 'approval_requested:' || v.id || ':r1', 'approval_requested', v.id, null, 1, v.state, v.scheduled_at);
  return query select * from postona_x_resv.approval_row(v.id);
end $$;

/** Change the text / time of a pending candidate (expected revision); the approval then has to name the new hash. */
create function postona_x_resv.revise_approval(p_candidate_id uuid, p_expected_revision integer, p_body text, p_scheduled_at timestamptz)
returns setof postona_x_resv.approval_view
language plpgsql volatile security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller(); v postona_x_resv.approval_candidates%rowtype; v_body text; v_lifecycle bigint; v_credential text;
begin
  v := postona_x_resv.lock_own_candidate(v_user, p_candidate_id);
  if v.state <> 'pending_approval' then raise exception 'POSTONA_RESV_APPROVAL_NOT_PENDING' using errcode = 'P0001'; end if;
  if v.revision is distinct from p_expected_revision then raise exception 'POSTONA_RESV_STALE_REVISION' using errcode = 'P0001'; end if;
  perform postona_x_resv.assert_account_access(v_user, v.social_account_id);
  v_body := postona_x_resv.approval_check_input(p_body, p_scheduled_at);
  select b.lifecycle_version into v_lifecycle from postona_x_resv.g5_r1_bound(v.brand_id) b;
  v_credential := postona_x_resv.approval_credential_generation(v.social_account_id);
  if v_credential is null then raise exception 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001'; end if;
  update postona_x_resv.approval_candidates c
     set body = v_body, content_sha256 = postona_x_resv.sha256_hex(v_body), scheduled_at = p_scheduled_at, revision = c.revision + 1,
         bound_lifecycle_version = v_lifecycle, bound_credential_generation = v_credential, updated_at = pg_catalog.now()
   where c.id = v.id returning * into v;
  perform postona_x_resv.notify(v_user, v.brand_id, 'approval_requested:' || v.id || ':r' || v.revision, 'approval_requested', v.id, null, v.revision, v.state, v.scheduled_at);
  return query select * from postona_x_resv.approval_row(v.id);
end $$;

/** Approve exactly this text at this revision: creates the reservation through create_batch, in this transaction. */
create function postona_x_resv.approve_candidate(p_candidate_id uuid, p_expected_revision integer, p_content_sha256 text)
returns setof postona_x_resv.approval_view
language plpgsql volatile security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller(); v postona_x_resv.approval_candidates%rowtype; v_rid uuid;
begin
  v := postona_x_resv.lock_own_candidate(v_user, p_candidate_id);
  if v.state = 'approved' and v.revision = p_expected_revision + 1 and v.content_sha256 = p_content_sha256 then
    return query select * from postona_x_resv.approval_row(v.id);   -- the same approval, retried: nothing new
    return;
  end if;
  if v.state <> 'pending_approval' then raise exception 'POSTONA_RESV_APPROVAL_NOT_PENDING' using errcode = 'P0001'; end if;
  if v.revision is distinct from p_expected_revision then raise exception 'POSTONA_RESV_STALE_REVISION' using errcode = 'P0001'; end if;
  if v.content_sha256 is distinct from p_content_sha256 then raise exception 'POSTONA_RESV_CONSENT_REQUIRED' using errcode = 'P0001'; end if;
  perform postona_x_resv.assert_account_access(v_user, v.social_account_id);   -- service / account / connection first (their own codes)
  if not postona_x_resv.approval_generation_active(v_user, v.brand_id, v.bound_lifecycle_version)
     or postona_x_resv.approval_credential_generation(v.social_account_id) is distinct from v.bound_credential_generation then
    raise exception 'POSTONA_RESV_APPROVAL_GENERATION_CHANGED' using errcode = 'P0001';
  end if;
  select r.reservation_id into v_rid
    from postona_x_resv.create_batch(v.social_account_id, v.id, v.revision, 'manual_exact', null,
           pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('draft_id', 'appr:' || v.id, 'scheduled_at', v.scheduled_at, 'body', v.body,
             'consent', pg_catalog.jsonb_build_object('confirmed', true, 'content_sha256', v.content_sha256)))) r;
  if v_rid is null then raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001'; end if;
  -- once more after create_batch, in this transaction: a reconnect committed meanwhile rolls the whole approval back
  if postona_x_resv.approval_credential_generation(v.social_account_id) is distinct from v.bound_credential_generation then
    raise exception 'POSTONA_RESV_APPROVAL_GENERATION_CHANGED' using errcode = 'P0001';
  end if;
  update postona_x_resv.approval_candidates c
     set state = 'approved', revision = c.revision + 1, reservation_id = v_rid, decided_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where c.id = v.id returning * into v;
  perform postona_x_resv.notify(v_user, v.brand_id, 'approval_approved:' || v.id, 'approval_approved', v.id, v_rid, v.revision, v.state, v.scheduled_at);
  return query select * from postona_x_resv.approval_row(v.id);
end $$;

/** Reject a pending candidate (expected revision). No reservation is made. */
create function postona_x_resv.reject_candidate(p_candidate_id uuid, p_expected_revision integer)
returns setof postona_x_resv.approval_view
language plpgsql volatile security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller(); v postona_x_resv.approval_candidates%rowtype;
begin
  v := postona_x_resv.lock_own_candidate(v_user, p_candidate_id);
  if v.state = 'rejected' and v.revision = p_expected_revision + 1 then
    return query select * from postona_x_resv.approval_row(v.id);
    return;
  end if;
  if v.state <> 'pending_approval' then raise exception 'POSTONA_RESV_APPROVAL_NOT_PENDING' using errcode = 'P0001'; end if;
  if v.revision is distinct from p_expected_revision then raise exception 'POSTONA_RESV_STALE_REVISION' using errcode = 'P0001'; end if;
  update postona_x_resv.approval_candidates c
     set state = 'rejected', revision = c.revision + 1, decided_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where c.id = v.id returning * into v;
  perform postona_x_resv.notify(v_user, v.brand_id, 'approval_rejected:' || v.id, 'approval_rejected', v.id, null, v.revision, v.state, v.scheduled_at);
  return query select * from postona_x_resv.approval_row(v.id);
end $$;

/** The caller's own candidates of one account, newest first (another account: empty). */
create function postona_x_resv.list_approvals(p_social_account_id text) returns setof postona_x_resv.approval_view
language plpgsql stable security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller();
begin
  return query select c.id, c.social_account_id, c.body, c.content_sha256, c.scheduled_at, c.state, c.revision, c.reservation_id, c.decided_at, c.created_at
               from postona_x_resv.approval_candidates c
               where c.user_id = v_user and c.social_account_id = p_social_account_id and postona_x_resv.approval_owned(v_user, c.brand_id)
               order by c.created_at desc, c.id
               limit 200;
end $$;

create function postona_x_resv.get_approval(p_candidate_id uuid) returns setof postona_x_resv.approval_view
language plpgsql stable security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller(); v postona_x_resv.approval_candidates%rowtype;
begin
  select * into v from postona_x_resv.approval_candidates c where c.id = p_candidate_id;
  if not found or v.user_id is distinct from v_user or not postona_x_resv.approval_owned(v_user, v.brand_id) then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  return query select * from postona_x_resv.approval_row(v.id);
end $$;

/** The caller's notifications (newest first, at most p_limit, 1-100), after writing any reservation_changed still missing. */
create function postona_x_resv.list_notifications(p_limit integer) returns setof postona_x_resv.notification_view
language plpgsql volatile security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller();
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'POSTONA_RESV_REQUEST_INVALID' using errcode = 'P0001'; end if;
  perform postona_x_resv.sync_reservation_notifications(v_user);
  return query select n.id, n.kind, n.candidate_id, n.reservation_id, n.subject_revision, n.state, n.scheduled_at, n.created_at, n.read_at
               from postona_x_resv.notifications n
               where n.user_id = v_user and postona_x_resv.approval_owned(v_user, n.brand_id)
               order by n.created_at desc, n.id
               limit p_limit;
end $$;

/** Marks one of the caller's notifications read (idempotent: the first read time stays). */
create function postona_x_resv.mark_notification_read(p_notification_id uuid) returns setof postona_x_resv.notification_view
language plpgsql volatile security definer set search_path = '' as $$
-- G3_APPROVALS (G3-02 #16)
declare v_user uuid := postona_x_resv.caller(); v postona_x_resv.notifications%rowtype;
begin
  select * into v from postona_x_resv.notifications n where n.id = p_notification_id for update;
  if not found or v.user_id is distinct from v_user or not postona_x_resv.approval_owned(v_user, v.brand_id) then
    raise exception 'POSTONA_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  update postona_x_resv.notifications n set read_at = coalesce(n.read_at, pg_catalog.now()) where n.id = v.id;
  return query select n.id, n.kind, n.candidate_id, n.reservation_id, n.subject_revision, n.state, n.scheduled_at, n.created_at, n.read_at
               from postona_x_resv.notifications n where n.id = v.id;
end $$;

revoke all on function
  postona_x_resv.approval_generation_active(uuid, text, bigint),
  postona_x_resv.approval_workspace_live(uuid, text),
  postona_x_resv.approval_credential_generation(text),
  postona_x_resv.notify(uuid, text, text, text, uuid, uuid, integer, text, timestamptz),
  postona_x_resv.sync_reservation_notifications(uuid),
  postona_x_resv.approval_owned(uuid, text),
  postona_x_resv.approval_check_input(text, timestamptz),
  postona_x_resv.lock_own_candidate(uuid, uuid),
  postona_x_resv.approval_row(uuid),
  postona_x_resv.submit_approval(text, uuid, text, timestamptz),
  postona_x_resv.revise_approval(uuid, integer, text, timestamptz),
  postona_x_resv.approve_candidate(uuid, integer, text),
  postona_x_resv.reject_candidate(uuid, integer),
  postona_x_resv.list_approvals(text),
  postona_x_resv.get_approval(uuid),
  postona_x_resv.list_notifications(integer),
  postona_x_resv.mark_notification_read(uuid)
from public;
grant execute on function
  postona_x_resv.submit_approval(text, uuid, text, timestamptz),
  postona_x_resv.revise_approval(uuid, integer, text, timestamptz),
  postona_x_resv.approve_candidate(uuid, integer, text),
  postona_x_resv.reject_candidate(uuid, integer),
  postona_x_resv.list_approvals(text),
  postona_x_resv.get_approval(uuid),
  postona_x_resv.list_notifications(integer),
  postona_x_resv.mark_notification_read(uuid)
to postona_resv_api;

do $$
declare v_api text; v_other int;
begin
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ',' order by p.oid::pg_catalog.regprocedure::text) into v_api
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'postona_x_resv' and pg_catalog.has_function_privilege('postona_resv_api', p.oid, 'EXECUTE')
     and p.proname in ('submit_approval', 'revise_approval', 'approve_candidate', 'reject_candidate', 'list_approvals', 'get_approval',
                       'list_notifications', 'mark_notification_read', 'approval_generation_active', 'approval_workspace_live', 'approval_credential_generation', 'notify', 'sync_reservation_notifications',
                       'approval_owned', 'approval_check_input', 'lock_own_candidate', 'approval_row');
  if v_api is distinct from 'postona_x_resv.approve_candidate(uuid,integer,text),postona_x_resv.get_approval(uuid),postona_x_resv.list_approvals(text),postona_x_resv.list_notifications(integer),postona_x_resv.mark_notification_read(uuid),postona_x_resv.reject_candidate(uuid,integer),postona_x_resv.revise_approval(uuid,integer,text,timestamp with time zone),postona_x_resv.submit_approval(text,uuid,text,timestamp with time zone)' then
    raise exception 'G3_APPROVALS_POSTCONDITION: the API role reaches %', v_api;
  end if;
  select count(*) into v_other
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (select r.rolname from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'postona_resv_worker')) x
   where n.nspname = 'postona_x_resv' and pg_catalog.has_function_privilege(x.rolname, p.oid, 'EXECUTE')
     and p.proname in ('submit_approval', 'revise_approval', 'approve_candidate', 'reject_candidate', 'list_approvals', 'get_approval',
                       'list_notifications', 'mark_notification_read', 'approval_generation_active', 'approval_workspace_live', 'approval_credential_generation', 'notify', 'sync_reservation_notifications',
                       'approval_owned', 'approval_check_input', 'lock_own_candidate', 'approval_row');
  if v_other <> 0 then raise exception 'G3_APPROVALS_POSTCONDITION: another role reaches a new function'; end if;
  if exists (select 1 from pg_catalog.pg_class c where c.oid in ('postona_x_resv.approval_candidates'::pg_catalog.regclass,
               'postona_x_resv.notifications'::pg_catalog.regclass, 'postona_x_resv.push_outbox'::pg_catalog.regclass)
             and c.relacl is not null and pg_catalog.array_length(c.relacl, 1) > 1) then
    raise exception 'G3_APPROVALS_POSTCONDITION: a new table is granted';
  end if;
end $$;

commit;
