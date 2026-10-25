-- POSTONA Threads reservations -- G3 SOURCE CANDIDATE 007 (2026-10-19, Issue #318 TASK 2/50). NOT a migration, NOT in
-- supabase/migrations/, applied only to a disposable local PostgreSQL by postona_threads_reservations_run.sh. Never apply
-- anywhere without: G5's Threads entitlement interface (the service key is undecided), G4's verified-Threads-account
-- predicate and generation-bound credential port, the reviewed 2a-2 multi-provider migration (Threads rows), one
-- Codex Sol（高） review of the schema / SECURITY DEFINER / grants, and the user's explicit approval.
--
-- Shape: Threads reservations live in their OWN schema postona_threads_resv. The X reservation schema postona_x_resv
-- (001-006) is not changed by one byte (the runner fingerprints it before / after / after rollback); 007 only reuses
-- its caller() and the two existing roles postona_resv_api (person) and postona_resv_worker (dispatcher).
--
-- Rules (the same as the X paths; PR #224 worker, PR #278 single post, PR #334 Threads dispatcher):
--   create      the verified caller, a Threads account of a social_mobile_user_v1 workspace whose SINGLE owner (F5's
--               private.account_lifecycle_brand_owner) is the caller, connected + identity verified + publish switch
--               ON, G4 says verified, G5 says the Threads service is usable -- per-action consent = SHA-256 of the text;
--               idempotent per (caller, account, client_request_id); same id + other text = conflict.
--   receipt     text-free read of the caller's own row by (account, client_request_id): state, Threads media id,
--               outcome, after_freeze, simulated. Read only. Another person / account / id = the same NOT_FOUND.
--   claim_due   the dispatcher's exclusive lease on due planned rows (SKIP LOCKED), the credential generation bound
--               at claim; an expired lease is fenced to 'uncertain' (never re-sent).
--   preflight   the last check before the provider: lease, refresh not in progress (else RELEASED, never sent), the
--               whole fence again (else failed NOT_PUBLISHABLE_AT_SEND), generation unchanged since the claim (else
--               failed CREDENTIAL_CHANGED) -> OK + the generation the credential must carry.
--   record      the outcome (published needs the media id; failed_before_send; uncertain), the transport ('threads'
--               | 'simulated') and after_freeze (G5's state read again); an expired lease is fenced to uncertain
--               ('lease_lost'); an identical published replay is idempotent; anything else on a finished row refuses.
--   release     hands back a claimed row that was NOT sent.
-- G5 service generation (2026-10-20, Issue #318 TASK 7/50; G5 notice #318 6279933784, G5 PR #358): the Threads posting service key is
-- 'x_autopost'. create stores the TWO numbers of R1's allow token g5oe:<owner_epoch>:<lifecycle_version>, read inside create from
--   R1 public.common_account_authorization_verdict('postona', 'threads_publish', brand) -> jsonb   (the person's verdict; decision 'allow')
-- and claim_due, preflight (and so the dispatcher's pre-publish hook) and record ask
--   W1 private.account_lifecycle_worker_brand_verdict(brand, 'x_autopost', bound_owner_epoch, bound_lifecycle_version) -> text
-- and continue ONLY on 'active'; every other answer (OWNER_EPOCH_CHANGED, SERVICE_GENERATION_CHANGED, EXPECTED_*_REQUIRED, ...) stops the row and
-- is kept as its outcome code. No timestamp is compared for authorization. A row without a bound pair (written before this rule) is never sent.
-- Interface of another owner shipped as DENY (replaced only by its owner's reviewed code):
--   postona_threads_resv.g4_threads_account_verified(user, account) -> boolean   G4 (false)
-- Optional G4 tables read only where they exist (PR #258/#263 candidates): public.threads_account_credential_custody,
-- public.threads_credential_refresh_leases.
-- Rollback: 007_postona_threads_reservations_rollback.sql.
begin;

do $$
declare v_owner oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  if to_regprocedure('postona_x_resv.caller()') is null or to_regrole('postona_resv_api') is null or to_regrole('postona_resv_worker') is null
     or to_regprocedure('postona_x_resv.post_now_preflight(uuid,uuid)') is null then
    raise exception 'POSTONA_THREADS_RESV_PRECONDITION_001_006_MISSING';
  end if;
  if to_regnamespace('postona_threads_resv') is not null then
    raise exception 'POSTONA_THREADS_RESV_ALREADY_APPLIED';
  end if;
  -- G5 R1 / W1 (PR #358): present, STABLE, definer, owned by this owner, unreachable from the API roles.
  if to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is null
     or to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is null
     or exists (select 1 from pg_catalog.pg_proc p where p.oid in (to_regprocedure('public.common_account_authorization_verdict(text,text,text)'),
                                                                  to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)'))
                and (p.provolatile <> 's' or not p.prosecdef or p.proowner <> v_owner))
     or exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'postona_resv_api', 'postona_resv_worker')
                and pg_catalog.has_function_privilege(r.oid, to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)'), 'EXECUTE')) then
    raise exception 'POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT';
  end if;
  if to_regprocedure('private.account_lifecycle_brand_owner(text)') is null
     or (select p.proowner from pg_catalog.pg_proc p where p.oid = to_regprocedure('private.account_lifecycle_brand_owner(text)')) is distinct from v_owner then
    raise exception 'POSTONA_THREADS_RESV_PRECONDITION_F5_BRAND_OWNER';
  end if;
  -- Threads rows must be possible: the X-only CHECK (platform = 'x') must be gone (2a-2 or its reviewed successor).
  if exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = 'public.social_accounts'::regclass and c.contype = 'c'
             and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ''x''::text))') then
    raise exception 'POSTONA_THREADS_RESV_PRECONDITION_MULTI_PROVIDER';
  end if;
  if (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false
     or (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'postona_x_resv') is distinct from v_owner then
    raise exception 'POSTONA_THREADS_RESV_PRECONDITION_OWNER';
  end if;
end $$;

create schema postona_threads_resv;
revoke all on schema postona_threads_resv from public;
grant usage on schema postona_threads_resv to postona_resv_api, postona_resv_worker;

create table postona_threads_resv.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  brand_id text not null,
  social_account_id text not null references public.social_accounts (id) on delete cascade,
  client_request_id uuid not null,
  body text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  scheduled_at timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'claimed', 'published', 'failed', 'uncertain', 'cancelled')),
  lease_token uuid,
  lease_expires_at timestamptz,
  claimed_by text,
  bound_generation text check (bound_generation is null or bound_generation ~ '^[0-9a-f]{64}$'),
  -- G5's service generation bound at create (R1's allow token); NULL = written before this rule: never sent.
  bound_owner_epoch bigint check (bound_owner_epoch is null or bound_owner_epoch >= 1),
  bound_lifecycle_version bigint check (bound_lifecycle_version is null or bound_lifecycle_version >= 1),
  check ((bound_owner_epoch is null) = (bound_lifecycle_version is null)),
  provider_post_id text check (provider_post_id is null or provider_post_id ~ '^[1-9][0-9]{0,31}$'),
  outcome_code text check (outcome_code is null or outcome_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  transport text check (transport is null or transport in ('threads', 'simulated')),
  after_freeze boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, social_account_id, client_request_id),
  check ((status = 'claimed') = (lease_token is not null and lease_expires_at is not null)),
  check (status <> 'published' or provider_post_id is not null)
);
create index reservations_due on postona_threads_resv.reservations (scheduled_at) where status = 'planned';
alter table postona_threads_resv.reservations enable row level security;
revoke all on table postona_threads_resv.reservations from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
-- G3-33 T5: the person-facing cancel leaves one audit row (X keeps one in postona_x_resv.audit). Codes and times only:
-- never the post text, its hash or a token. Written only by the SECURITY DEFINER functions; no role reads or writes it.
-- Its retention / pseudonymisation on account deletion is not decided here (PR #475 Q2).
create table postona_threads_resv.audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  reservation_id uuid,
  action text not null check (action ~ '^[a-z_]{1,40}$'),
  detail jsonb not null default '{}'::jsonb
);
alter table postona_threads_resv.audit enable row level security;
revoke all on table postona_threads_resv.audit from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;

/** G4 (DENY until delivered): is this a Threads account the person verified through the reviewed connection? */
create function postona_threads_resv.g4_threads_account_verified(p_user_id uuid, p_social_account_id text) returns boolean
language sql stable security definer set search_path = '' as $$ select false $$;

/** R1's owner-epoch token g5oe:<epoch>:<lifecycle_version> -> the two numbers, or NULLs for anything else (empty, malformed, leading zero,
 *  zero, more than bigint). Internal. */
create function postona_threads_resv.parse_owner_epoch_token(p_token text, out owner_epoch bigint, out lifecycle_version bigint)
language plpgsql immutable set search_path = '' as $$
declare v text[];
begin
  if p_token is null or pg_catalog.length(p_token) > 64 then return; end if;
  v := pg_catalog.regexp_match(p_token, '^g5oe:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$');
  if v is null then return; end if;
  if v[1]::numeric > 9223372036854775807 or v[2]::numeric > 9223372036854775807 then return; end if;
  owner_epoch := v[1]::bigint;
  lifecycle_version := v[2]::bigint;
end $$;

/** G5 W1 for a bound pair: 'active' or G5's fixed code (a missing pair answers without asking). Internal. */
create function postona_threads_resv.g5_bound_state(p_brand_id text, p_owner_epoch bigint, p_lifecycle_version bigint) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_owner_epoch is null or p_owner_epoch < 1 then return 'EXPECTED_OWNER_EPOCH_REQUIRED'; end if;
  if p_lifecycle_version is null or p_lifecycle_version < 1 then return 'EXPECTED_LIFECYCLE_VERSION_REQUIRED'; end if;
  return coalesce(private.account_lifecycle_worker_brand_verdict(p_brand_id, 'x_autopost', p_owner_epoch, p_lifecycle_version), 'SERVICE_STATE_UNKNOWN');
end $$;

/** The credential generation of one Threads account (64 lowercase hex). Internal. */
create function postona_threads_resv.threads_credential_generation(p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_sa public.social_accounts%rowtype; v_custody jsonb; v_lease jsonb;
begin
  select sa.* into v_sa from public.social_accounts sa where sa.id = p_social_account_id and sa.platform = 'threads';
  if v_sa.id is null then
    return null;
  end if;
  if to_regclass('public.threads_account_credential_custody') is not null then
    execute 'select pg_catalog.jsonb_build_object(''secret'', c.vault_secret_id, ''expires'', c.expires_at, ''recorded'', c.recorded_at)
             from public.threads_account_credential_custody c where c.social_account_id = $1' into v_custody using p_social_account_id;
  end if;
  if to_regclass('public.threads_credential_refresh_leases') is not null then
    execute 'select pg_catalog.jsonb_build_object(''lease'', l.lease_id, ''secret'', l.vault_secret_id)
             from public.threads_credential_refresh_leases l where l.social_account_id = $1' into v_lease using p_social_account_id;
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'v', 1, 'provider', 'threads', 'account', v_sa.id, 'brand', v_sa.brand_id, 'owner', private.account_lifecycle_brand_owner(v_sa.brand_id),
    'platform_user_id', v_sa.platform_user_id, 'access', v_sa.vault_access_token_secret_id, 'connection', v_sa.connection_status,
    'verified_at', v_sa.verified_at, 'account_updated_at', v_sa.updated_at, 'custody', v_custody, 'refresh_lease', v_lease)::text, 'UTF8')), 'hex');
end $$;

/** A refresh of this account's credential is in progress (G4's lease is live): never send now. Internal. */
create function postona_threads_resv.refresh_in_progress(p_social_account_id text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v boolean := false;
begin
  if to_regclass('public.threads_credential_refresh_leases') is not null then
    execute 'select exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = $1 and l.lease_expires_at > pg_catalog.clock_timestamp())'
      into v using p_social_account_id;
  end if;
  return v;
end $$;

/** The fence: Threads account of a user workspace whose single owner is the person, connected, verified, switch ON,
 *  G4 verified. Returns the workspace; raises a fixed code otherwise. G5 is asked by the callers (R1 at create, W1 with the
 *  bound pair afterwards). Internal. */
create function postona_threads_resv.fence(p_user_id uuid, p_social_account_id text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_sa public.social_accounts%rowtype;
begin
  select sa.* into v_sa from public.social_accounts sa where sa.id = p_social_account_id;
  if v_sa.id is null or v_sa.platform is distinct from 'threads'
     or (select b.code_profile_key from public.brands b where b.id = v_sa.brand_id) is distinct from 'social_mobile_user_v1'
     or private.account_lifecycle_brand_owner(v_sa.brand_id) is distinct from p_user_id then
    raise exception 'POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND' using errcode = 'P0001';  -- one answer: no oracle
  end if;
  if v_sa.connection_status is distinct from 'identity_verified' or v_sa.verified_at is null or v_sa.platform_user_id is null
     or v_sa.last_connection_error_code is not null or v_sa.vault_access_token_secret_id is null
     or postona_threads_resv.g4_threads_account_verified(p_user_id, p_social_account_id) is not true then
    raise exception 'POSTONA_THREADS_RESV_ACCOUNT_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  if v_sa.publish_enabled is not true then
    raise exception 'POSTONA_THREADS_RESV_PUBLISH_DISABLED' using errcode = 'P0001';
  end if;
  return v_sa.brand_id;
end $$;

create function postona_threads_resv.text_ok(p_text text) returns boolean
language sql immutable set search_path = '' as $$
  -- Conservative: 1..500 code points, no control characters other than tab / line feed. G4's transport re-checks
  -- the documented Threads counting (emoji by UTF-8 bytes) before any provider call.
  select p_text is not null and pg_catalog.char_length(p_text) between 1 and 500 and pg_catalog.btrim(p_text) <> ''
         and p_text !~ '[\x01-\x08\x0b-\x1f\x7f]'
$$;

-- ---- person (postona_resv_api) -----------------------------------------------------------------------------

create function postona_threads_resv.create_reservation(p_social_account_id text, p_client_request_id uuid, p_text text,
  p_content_sha256 text, p_scheduled_at timestamptz)
returns table (reservation_id uuid, status text, created boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_brand text; v_row postona_threads_resv.reservations%rowtype; v_sha text;
        v_verdict jsonb; v_epoch bigint; v_lifecycle bigint;
begin
  if p_social_account_id is null or p_client_request_id is null or p_scheduled_at is null then
    raise exception 'POSTONA_THREADS_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  if not postona_threads_resv.text_ok(p_text) then
    raise exception 'POSTONA_THREADS_RESV_TEXT_INVALID' using errcode = 'P0001';
  end if;
  v_sha := postona_x_resv.sha256_hex(p_text);
  if p_content_sha256 is distinct from v_sha then
    raise exception 'POSTONA_THREADS_RESV_CONSENT_REQUIRED' using errcode = 'P0001';
  end if;
  if p_scheduled_at < pg_catalog.now() + interval '1 minute' or p_scheduled_at > pg_catalog.now() + interval '60 days' then
    raise exception 'POSTONA_THREADS_RESV_SCHEDULE_INVALID' using errcode = 'P0001';
  end if;
  v_brand := postona_threads_resv.fence(v_user, p_social_account_id);
  -- G5 R1, the person's verdict for this workspace, read now: only 'allow' with a well-formed owner-epoch token is bound.
  v_verdict := public.common_account_authorization_verdict('postona', 'threads_publish', v_brand);
  if v_verdict ->> 'decision' is distinct from 'allow' then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  select t.owner_epoch, t.lifecycle_version into v_epoch, v_lifecycle from postona_threads_resv.parse_owner_epoch_token(v_verdict ->> 'owner_epoch') t;
  if v_epoch is null or v_lifecycle is null then
    raise exception 'POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('postona_threads_resv:' || p_social_account_id, 0));
  select r.* into v_row from postona_threads_resv.reservations r
   where r.user_id = v_user and r.social_account_id = p_social_account_id and r.client_request_id = p_client_request_id;
  if found then
    if v_row.content_sha256 is distinct from v_sha or v_row.scheduled_at is distinct from p_scheduled_at then
      raise exception 'POSTONA_THREADS_RESV_IDEMPOTENCY_CONFLICT' using errcode = 'P0001';
    end if;
    reservation_id := v_row.id; status := v_row.status; created := false; return next; return;
  end if;
  insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at,
    bound_owner_epoch, bound_lifecycle_version)
  values (v_user, v_brand, p_social_account_id, p_client_request_id, p_text, v_sha, p_scheduled_at, v_epoch, v_lifecycle)
  returning * into v_row;
  reservation_id := v_row.id; status := v_row.status; created := true; return next;
end $$;

create function postona_threads_resv.cancel_reservation(p_reservation_id uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller();
begin
  update postona_threads_resv.reservations r set status = 'cancelled', updated_at = pg_catalog.now()
  where r.id = p_reservation_id and r.user_id = v_user and r.status = 'planned';
  if found then
    insert into postona_threads_resv.audit (user_id, reservation_id, action, detail)
    values (v_user, p_reservation_id, 'cancel', pg_catalog.jsonb_build_object('from_status', 'planned'));
    return 'cancelled';
  end if;
  if exists (select 1 from postona_threads_resv.reservations r where r.id = p_reservation_id and r.user_id = v_user) then
    raise exception 'POSTONA_THREADS_RESV_NOT_CANCELLABLE' using errcode = 'P0001';
  end if;
  raise exception 'POSTONA_THREADS_RESV_NOT_FOUND' using errcode = 'P0001';
end $$;

create function postona_threads_resv.receipt(p_social_account_id text, p_client_request_id uuid)
returns table (reservation_id uuid, state text, provider_post_id text, outcome_code text, after_freeze boolean, simulated boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := postona_x_resv.caller(); v_row postona_threads_resv.reservations%rowtype;
begin
  select r.* into v_row from postona_threads_resv.reservations r
   where r.user_id = v_user and r.social_account_id = p_social_account_id and r.client_request_id = p_client_request_id;
  if v_row.id is null then
    raise exception 'POSTONA_THREADS_RESV_NOT_FOUND' using errcode = 'P0001';
  end if;
  reservation_id := v_row.id;
  state := case v_row.status when 'published' then 'sent' when 'failed' then 'failed' when 'cancelled' then 'cancelled'
                             when 'planned' then 'pending'
                             when 'claimed' then case when v_row.lease_expires_at > pg_catalog.clock_timestamp() then 'pending' else 'uncertain' end
                             else 'uncertain' end;
  provider_post_id := v_row.provider_post_id; outcome_code := v_row.outcome_code;
  after_freeze := coalesce(v_row.after_freeze, false);
  simulated := v_row.transport is distinct from 'threads';
  return next;
end $$;

-- ---- dispatcher (postona_resv_worker) ------------------------------------------------------------------------

create function postona_threads_resv.claim_due(p_worker text, p_lease_seconds integer, p_limit integer)
returns table (reservation_id uuid, lease_token uuid, provider text, social_account_id text, body text)
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_threads_resv.reservations%rowtype; v_token uuid; v_g5 text;
begin
  if p_worker is null or p_worker !~ '^[a-z0-9_-]{1,40}$' or p_lease_seconds is null or p_lease_seconds not between 30 and 300
     or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'POSTONA_THREADS_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  -- An expired lease may have reached Threads: fenced to uncertain, never claimed again.
  update postona_threads_resv.reservations r set status = 'uncertain', outcome_code = 'LEASE_EXPIRED', lease_token = null,
         lease_expires_at = null, updated_at = pg_catalog.now()
  where r.status = 'claimed' and r.lease_expires_at <= pg_catalog.clock_timestamp();
  for v_row in
    select r.* from postona_threads_resv.reservations r
    where r.status = 'planned' and r.scheduled_at <= pg_catalog.now()
    order by r.scheduled_at, r.id
    limit p_limit
    for update skip locked
  loop
    -- G5 W1 with the pair bound at create: anything but 'active' stops the row here (never claimed, never sent).
    v_g5 := postona_threads_resv.g5_bound_state(v_row.brand_id, v_row.bound_owner_epoch, v_row.bound_lifecycle_version);
    if v_g5 is distinct from 'active' then
      update postona_threads_resv.reservations r set status = 'failed',
             outcome_code = case when v_g5 ~ '^[A-Z][A-Z0-9_]{1,63}$' then v_g5 else 'SERVICE_STATE_UNKNOWN' end, updated_at = pg_catalog.now()
      where r.id = v_row.id;
      continue;
    end if;
    v_token := gen_random_uuid();
    update postona_threads_resv.reservations r
    set status = 'claimed', lease_token = v_token, lease_expires_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
        claimed_by = p_worker, bound_generation = postona_threads_resv.threads_credential_generation(v_row.social_account_id), updated_at = pg_catalog.now()
    where r.id = v_row.id;
    reservation_id := v_row.id; lease_token := v_token; provider := 'threads'; social_account_id := v_row.social_account_id; body := v_row.body;
    return next;
  end loop;
end $$;

create function postona_threads_resv.preflight(p_reservation_id uuid, p_lease_token uuid)
returns table (verdict text, credential_generation text)
language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_threads_resv.reservations%rowtype; v_now text; v_g5 text;
begin
  select r.* into v_row from postona_threads_resv.reservations r where r.id = p_reservation_id for update;
  if v_row.id is null or v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token then
    verdict := 'LEASE_LOST'; return next; return;
  end if;
  if v_row.lease_expires_at <= pg_catalog.clock_timestamp() or postona_threads_resv.refresh_in_progress(v_row.social_account_id) then
    -- Still ours and nothing was sent: hand it back.
    update postona_threads_resv.reservations r set status = 'planned', lease_token = null, lease_expires_at = null, claimed_by = null,
           bound_generation = null, updated_at = pg_catalog.now()
    where r.id = v_row.id;
    verdict := 'RELEASED'; return next; return;
  end if;
  begin
    perform postona_threads_resv.fence(v_row.user_id, v_row.social_account_id);
  exception when others then
    if sqlerrm !~ '^POSTONA_THREADS_RESV_' then raise; end if;
    update postona_threads_resv.reservations r set status = 'failed', outcome_code = 'NOT_PUBLISHABLE_AT_SEND', lease_token = null,
           lease_expires_at = null, updated_at = pg_catalog.now()
    where r.id = v_row.id;
    verdict := 'NOT_PUBLISHABLE'; return next; return;
  end;
  v_g5 := postona_threads_resv.g5_bound_state(v_row.brand_id, v_row.bound_owner_epoch, v_row.bound_lifecycle_version);
  if v_g5 is distinct from 'active' then
    update postona_threads_resv.reservations r set status = 'failed',
           outcome_code = case when v_g5 ~ '^[A-Z][A-Z0-9_]{1,63}$' then v_g5 else 'SERVICE_STATE_UNKNOWN' end, lease_token = null,
           lease_expires_at = null, updated_at = pg_catalog.now()
    where r.id = v_row.id;
    verdict := 'NOT_PUBLISHABLE'; return next; return;
  end if;
  v_now := postona_threads_resv.threads_credential_generation(v_row.social_account_id);
  if v_now is null or v_row.bound_generation is distinct from v_now then
    update postona_threads_resv.reservations r set status = 'failed', outcome_code = 'CREDENTIAL_CHANGED', lease_token = null,
           lease_expires_at = null, updated_at = pg_catalog.now()
    where r.id = v_row.id;
    verdict := 'NOT_PUBLISHABLE'; return next; return;
  end if;
  verdict := 'OK'; credential_generation := v_now; return next;
end $$;

create function postona_threads_resv.record(p_reservation_id uuid, p_lease_token uuid, p_outcome text, p_provider_post_id text,
  p_code text, p_transport text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_row postona_threads_resv.reservations%rowtype;
begin
  if p_outcome is null or p_outcome not in ('published', 'failed_before_send', 'uncertain')
     or (p_outcome = 'published') <> (p_provider_post_id is not null)
     or (p_provider_post_id is not null and p_provider_post_id !~ '^[1-9][0-9]{0,31}$')
     or (p_code is not null and p_code !~ '^[A-Z][A-Z0-9_]{1,63}$')
     or p_transport is null or p_transport not in ('threads', 'simulated') then
    raise exception 'POSTONA_THREADS_RESV_REQUEST_INVALID' using errcode = 'P0001';
  end if;
  select r.* into v_row from postona_threads_resv.reservations r where r.id = p_reservation_id for update;
  if v_row.id is null then
    raise exception 'POSTONA_THREADS_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  if v_row.status = 'published' and p_outcome = 'published' and v_row.provider_post_id = p_provider_post_id then
    return 'published';  -- identical replay: nothing changes
  end if;
  if v_row.status <> 'claimed' or v_row.lease_token is distinct from p_lease_token then
    raise exception 'POSTONA_THREADS_RESV_LEASE_LOST' using errcode = 'P0001';
  end if;
  if v_row.lease_expires_at <= pg_catalog.clock_timestamp() then
    update postona_threads_resv.reservations r set status = 'uncertain', outcome_code = 'LEASE_EXPIRED_AT_FINISH', lease_token = null,
           lease_expires_at = null, transport = p_transport, updated_at = pg_catalog.now()
    where r.id = v_row.id;
    return 'lease_lost';
  end if;
  update postona_threads_resv.reservations r
  set status = case p_outcome when 'published' then 'published' when 'failed_before_send' then 'failed' else 'uncertain' end,
      provider_post_id = p_provider_post_id, outcome_code = coalesce(p_code, pg_catalog.upper(p_outcome)),
      lease_token = null, lease_expires_at = null, transport = p_transport,
      after_freeze = postona_threads_resv.g5_bound_state(v_row.brand_id, v_row.bound_owner_epoch, v_row.bound_lifecycle_version) is distinct from 'active',
      updated_at = pg_catalog.now()
  where r.id = v_row.id;
  return p_outcome;
end $$;

create function postona_threads_resv.release_unsent(p_reservation_id uuid, p_lease_token uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  update postona_threads_resv.reservations r set status = 'planned', lease_token = null, lease_expires_at = null, claimed_by = null,
         bound_generation = null, updated_at = pg_catalog.now()
  where r.id = p_reservation_id and r.status = 'claimed' and r.lease_token = p_lease_token;
  return case when found then 'released' else 'lease_lost' end;
end $$;

revoke all on all functions in schema postona_threads_resv from public, anon, authenticated, service_role, postona_resv_api, postona_resv_worker;
grant execute on function
  postona_threads_resv.create_reservation(text, uuid, text, text, timestamptz),
  postona_threads_resv.cancel_reservation(uuid),
  postona_threads_resv.receipt(text, uuid)
to postona_resv_api;
grant execute on function
  postona_threads_resv.claim_due(text, integer, integer),
  postona_threads_resv.preflight(uuid, uuid),
  postona_threads_resv.record(uuid, uuid, text, text, text, text),
  postona_threads_resv.release_unsent(uuid, uuid)
to postona_resv_worker;

do $$
declare v_bad text; v_role text;
begin
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_threads_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_api', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_threads_resv.cancel_reservation(uuid),postona_threads_resv.create_reservation(text,uuid,text,text,timestamp with time zone),postona_threads_resv.receipt(text,uuid)' then
    raise exception 'POSTONA_THREADS_RESV_POSTCONDITION: postona_resv_api executes %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text) into v_bad from pg_catalog.pg_proc p
  where p.pronamespace = 'postona_threads_resv'::regnamespace and pg_catalog.has_function_privilege('postona_resv_worker', p.oid, 'EXECUTE');
  if v_bad is distinct from 'postona_threads_resv.claim_due(text,integer,integer),postona_threads_resv.preflight(uuid,uuid),postona_threads_resv.record(uuid,uuid,text,text,text,text),postona_threads_resv.release_unsent(uuid,uuid)' then
    raise exception 'POSTONA_THREADS_RESV_POSTCONDITION: postona_resv_worker executes %', v_bad;
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_threads_resv'::regnamespace and pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE'))
       or pg_catalog.has_schema_privilege(v_role, 'postona_threads_resv', 'USAGE') then
      raise exception 'POSTONA_THREADS_RESV_POSTCONDITION: % reaches the schema', v_role;
    end if;
  end loop;
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'postona_resv_api', 'postona_resv_worker']) r(role)
             cross join unnest(array['postona_threads_resv.reservations', 'postona_threads_resv.audit']) t(tbl)
             where pg_catalog.has_table_privilege(r.role, t.tbl, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) then
    raise exception 'POSTONA_THREADS_RESV_POSTCONDITION: table reachable';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p where p.pronamespace = 'postona_threads_resv'::regnamespace
             and p.prosecdef and p.proconfig is distinct from array['search_path=""']) then
    raise exception 'POSTONA_THREADS_RESV_POSTCONDITION: definer search_path';
  end if;
end $$;

commit;
