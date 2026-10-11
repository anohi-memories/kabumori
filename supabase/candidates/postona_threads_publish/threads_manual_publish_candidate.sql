-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere. It lives outside supabase/migrations on
-- purpose: it depends on objects that do not exist in production yet (Phase 2a-2 applied, the G5
-- common-account writer fence private.account_lifecycle_assert_active_service_write) and refuses to
-- install without them. Apply only as a single reviewed file after a separately approved, same-day
-- read-only preflight (never db push), after the integrated security review.
--
-- POSTONA Threads: ONE user-initiated text post, the database side (G4,
-- postona-threads-manual-text-publish-v1-20261011). The Edge source that calls it is
-- supabase/functions/social-mobile-threads-publish/ (hard-disabled); the flow and the reference model
-- are supabase/functions/_shared/social/threads_manual_publish.ts and threads_manual_publish_fake.ts.
--
-- Objects:
--   TABLE public.social_account_manual_publish_permissions  the explicit per-account "you may post to this
--                                                          Threads account from POSTONA" permission; a
--                                                          row = granted (separate from publish_enabled,
--                                                          the automatic-publishing switch, which stays
--                                                          false for Threads under 2a-2's CHECK)
--   TABLE public.threads_manual_publish_attempts           one row per tap (idempotency key), the exact
--                                                          text, the step status, the single-use step
--                                                          grant (hash only) and the provider ids
--   caller functions (role authenticated, auth.uid() is the caller; SECURITY DEFINER, owner-only body):
--     set_threads_manual_publish_permission(account, desired, expected)
--     get_threads_manual_publish_state(account)
--     begin_threads_manual_publish(account, idempotency_key, text)
--     claim_threads_manual_publish_step(attempt, step)        fresh authorization before EACH provider call
--     get_threads_manual_publish_attempt(attempt)
--   server functions (role service_role only):
--     redeem_threads_manual_publish_step(attempt, step, grant) the credential (Vault), once, for that step
--     record_threads_manual_publish_step(attempt, step, grant, ...) the provider answer, fixed transitions
--
-- Authority: every caller function starts with the G5 fence for (auth.uid(), 'x_autopost') (T13: same
-- transaction, its locks first), then locks brand -> membership -> account -> permission -> attempt
-- (the order of the existing account functions). No function takes a user id, workspace id, provider id
-- or secret id from its caller. The server functions take an attempt id plus a grant that only a
-- caller-authorized claim issues (64 hex characters, sha256 stored, 60 s, single use, step-bound); they
-- re-check the account before reading Vault. Nothing here calls Meta, changes social_accounts, Vault,
-- entitlements or Auth, or enables automatic publishing.
--
-- Credential expiry: the candidate requires public.threads_account_credential_expires_at(text) from the
-- credential custody owner (H5 / token lifecycle; see the design doc, section 5) and refuses a step when
-- the token's expiry is unknown or within 5 minutes.
--
-- Lifecycle interaction: both tables cascade with their account and workspace (POSTONA deletion and
-- disconnect remove them); both carry the existing social_mobile_deletion_guard trigger, so nothing is
-- written into a workspace whose POSTONA deletion has started. G5's T10 footprint must list both tables
-- (see docs/postona/threads-manual-publish-v1.md).
--
-- Transaction: one explicit transaction; not re-runnable (ALREADY_APPLIED); written for PostgreSQL 17.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
begin
  if pg_catalog.to_regclass('public.social_accounts') is null or pg_catalog.to_regclass('public.brands') is null
     or pg_catalog.to_regclass('public.brand_memberships') is null then
    raise exception 'THREADS_PUBLISH_PRECONDITION_MISSING';
  end if;
  if pg_catalog.to_regclass('public.threads_manual_publish_attempts') is not null
     or pg_catalog.to_regclass('public.social_account_manual_publish_permissions') is not null then
    raise exception 'THREADS_PUBLISH_PRECONDITION_ALREADY_APPLIED';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'THREADS_PUBLISH_PRECONDITION_OWNER';
  end if;
  -- Phase 2a-2 applied: Threads rows exist only under its CHECKs and owner-only provider guard.
  if not exists (select 1 from pg_catalog.pg_constraint c
                 where c.conrelid = 'public.social_accounts'::regclass and c.conname = 'social_accounts_platform_supported'
                   and pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((platform = ANY (ARRAY[''x''::text, ''threads''::text, ''instagram''::text])))')
     or not exists (select 1 from pg_catalog.pg_trigger t
                    where t.tgrelid = 'public.social_accounts'::regclass and t.tgname = 'social_accounts_provider_guard' and t.tgenabled = 'O') then
    raise exception 'THREADS_PUBLISH_PRECONDITION_2A2';
  end if;
  -- G5 T13: the common-account writer fence, owned by the table owner, not executable by app roles.
  if pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)') is null
     or (select p.proowner from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('private.account_lifecycle_assert_active_service_write(uuid,text)')) is distinct from v_owner
     or exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app)
                where pg_catalog.has_function_privilege(a.app, 'private.account_lifecycle_assert_active_service_write(uuid,text)', 'EXECUTE')) then
    raise exception 'THREADS_PUBLISH_PRECONDITION_T13';
  end if;
  -- Credential custody (H5 / token lifecycle owner): when this account's long-lived token expires.
  -- NULL or unknown is treated as expired. Owned by the table owner, not executable by app roles.
  if pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)') is null
     or (select p.proowner from pg_catalog.pg_proc p
         where p.oid = pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)')) is distinct from v_owner
     or exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app)
                where pg_catalog.has_function_privilege(a.app, 'public.threads_account_credential_expires_at(text)', 'EXECUTE')) then
    raise exception 'THREADS_PUBLISH_PRECONDITION_CREDENTIAL_EXPIRY';
  end if;
  if pg_catalog.to_regclass('vault.decrypted_secrets') is null then
    raise exception 'THREADS_PUBLISH_PRECONDITION_VAULT';
  end if;
  if pg_catalog.to_regprocedure('public.social_mobile_account_deletion_guard()') is null then
    raise exception 'THREADS_PUBLISH_PRECONDITION_DELETION_GUARD';
  end if;
  if pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception 'THREADS_PUBLISH_PRECONDITION_AUTH';
  end if;
end $$;

-- --- Tables -----------------------------------------------------------------------------------------

create table public.social_account_manual_publish_permissions (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  brand_id text not null references public.brands (id) on delete cascade,
  granted_by uuid not null,
  granted_at timestamptz not null default now()
);

create table public.threads_manual_publish_attempts (
  id uuid primary key default gen_random_uuid(),
  social_account_id text not null references public.social_accounts (id) on delete cascade,
  brand_id text not null references public.brands (id) on delete cascade,
  requested_by uuid not null,
  idempotency_key uuid not null,
  -- The exact text, stored once and sent as stored. Code points <= 500 is necessary for the documented
  -- 500-character limit (emojis count more); the server checks the exact provider length before begin.
  post_text text not null check (pg_catalog.char_length(post_text) between 1 and 500
                                 and pg_catalog.btrim(post_text, E' \t\n　') <> ''
                                 and pg_catalog.translate(post_text, E'\n\t', '') !~ '[[:cntrl:]]'),
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'reserved' check (status in ('reserved', 'creating_container', 'container_created', 'publishing',
                                                            'publish_returned', 'published', 'published_unidentified', 'failed', 'uncertain')),
  container_id text check (container_id ~ '^[1-9][0-9]{0,31}$'),
  provider_post_id text check (provider_post_id ~ '^[1-9][0-9]{0,31}$'),
  permalink text check (pg_catalog.char_length(permalink) <= 512
                        and permalink ~ '^https://(www\.)?threads\.(net|com)/[^[:space:]]*$'),
  error_code text check (error_code in (
    'THREADS_REQUEST_INVALID', 'THREADS_TOKEN_INVALID', 'THREADS_PERMISSION_MISSING', 'THREADS_RATE_LIMITED',
    'THREADS_REQUEST_REJECTED', 'THREADS_UNAVAILABLE', 'THREADS_RESPONSE_MALFORMED', 'THREADS_IDENTITY_MISMATCH',
    'CONTAINER_OUTCOME_UNKNOWN', 'CONTAINER_ERROR', 'CONTAINER_EXPIRED', 'STORED_TEXT_MISSING', 'STORED_CONTAINER_MISSING',
    'PUBLISH_OUTCOME_UNKNOWN', 'RECONCILE_CONTAINER_UNKNOWN', 'PUBLISHED_POST_AMBIGUOUS', 'PUBLISHED_POST_NOT_FOUND',
    'ATTEMPT_EXPIRED', 'STEP_INTERRUPTED', 'AUTHORIZATION_CHANGED')),
  grant_hash text check (grant_hash ~ '^[0-9a-f]{64}$'),
  grant_step text check (grant_step in ('create_container', 'check_container', 'publish', 'confirm', 'reconcile')),
  grant_state text check (grant_state in ('issued', 'redeemed')),
  grant_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (social_account_id, idempotency_key),
  check ((grant_hash is null) = (grant_step is null) and (grant_step is null) = (grant_state is null)
         and (grant_state is null) = (grant_expires_at is null)),
  check (status not in ('container_created', 'publishing', 'publish_returned') or container_id is not null),
  check (status <> 'publish_returned' or provider_post_id is not null),
  check (status <> 'published' or (provider_post_id is not null and permalink is not null)),
  check (status not in ('failed', 'uncertain', 'published_unidentified') or error_code is not null),
  check (status not in ('published', 'published_unidentified', 'failed') or grant_hash is null)
);
-- At most one open attempt per account: an uncertain one blocks the next until it is resolved.
create unique index threads_manual_publish_one_open_per_account
  on public.threads_manual_publish_attempts (social_account_id)
  where status not in ('published', 'published_unidentified', 'failed');

alter table public.social_account_manual_publish_permissions enable row level security;
alter table public.threads_manual_publish_attempts enable row level security;
revoke all on table public.social_account_manual_publish_permissions, public.threads_manual_publish_attempts
  from public, anon, authenticated, service_role;

create trigger social_mobile_deletion_guard before insert or update on public.social_account_manual_publish_permissions
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.threads_manual_publish_attempts
  for each row execute function public.social_mobile_account_deletion_guard();

-- --- Internal helpers (owner only) ---------------------------------------------------------------------

create function public.threads_manual_publish_attempt_json(a public.threads_manual_publish_attempts)
returns jsonb language sql stable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'attempt_id', a.id, 'social_account_id', a.social_account_id, 'status', a.status,
    'container_id', a.container_id, 'provider_post_id', a.provider_post_id, 'permalink', a.permalink,
    'error_code', a.error_code, 'created_at', a.created_at)
$$;

create function public.threads_manual_publish_refused(p_code text) returns jsonb
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('status', 'refused', 'code', p_code)
$$;

-- The G5 fence for the caller and POSTONA, its outcome as one of our fixed codes (null = may proceed).
-- Its locks (auth user, common account, entitlement) are kept to the end of the transaction on success.
create function public.threads_manual_publish_fence(p_user uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.account_lifecycle_assert_active_service_write(p_user, 'x_autopost');
  exception
    when sqlstate 'P0001' then
      return case
        when sqlerrm = 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' then 'AUTH_REQUIRED'
        when sqlerrm in ('SERVICE_NOT_REGISTERED', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND') then 'SERVICE_NOT_ACTIVE'
        else 'ACCOUNT_LIFECYCLE_BLOCKED' end;
    when lock_not_available or deadlock_detected then
      return 'BUSY';
    when others then
      return 'ACCOUNT_LIFECYCLE_BLOCKED';
  end;
  return null;
end;
$$;

-- Everything a publish needs for (user, account), on locked rows, AFTER the fence. Returns the refusal
-- code or null. Locks: brand FOR SHARE -> membership FOR SHARE -> account FOR SHARE -> permission FOR SHARE.
create function public.threads_manual_publish_authorize(p_user uuid, p_social_account_id text, p_require_permission boolean)
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
  -- The account moved or vanished between the first read and the lock.
  if v_account.id is null or v_account.brand_id is distinct from v_brand_id then return 'ACCOUNT_NOT_FOUND'; end if;
  if v_role not in ('owner', 'admin') then return 'PUBLISH_FORBIDDEN'; end if;
  if v_brand.is_active is distinct from true or v_brand.publish_mode = 'disabled' then return 'WORKSPACE_INACTIVE'; end if;
  if v_account.platform is distinct from 'threads' then return 'PLATFORM_NOT_SUPPORTED'; end if;
  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or coalesce(v_account.platform_user_id, '') !~ '^[1-9][0-9]{0,31}$' then
    return 'CONNECTION_NOT_VERIFIED';
  end if;
  if v_account.vault_access_token_secret_id is null then return 'CREDENTIALS_MISSING'; end if;
  -- Never start a step with a token that is unknown, expired or about to expire mid-flow.
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

-- --- Caller functions --------------------------------------------------------------------------------

create function public.set_threads_manual_publish_permission(p_social_account_id text, p_desired boolean, p_expected boolean)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_brand_id text;
  v_role text;
  v_current boolean;
begin
  if v_user is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' or p_desired is null or p_expected is null then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  if p_desired then
    v_code := public.threads_manual_publish_fence(v_user);
    if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  end if;
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id;
  if v_brand_id is null then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  perform 1 from public.brands b where b.id = v_brand_id for share;
  select m.role into v_role from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = v_user for share;
  if v_role is null then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  if v_role not in ('owner', 'admin') then return public.threads_manual_publish_refused('PUBLISH_FORBIDDEN'); end if;
  perform 1 from public.social_accounts a where a.id = p_social_account_id and a.brand_id = v_brand_id for share;
  if not found then return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND'); end if;
  v_current := exists (select 1 from public.social_account_manual_publish_permissions p
                       where p.social_account_id = p_social_account_id for update);
  if v_current is distinct from p_expected then
    return pg_catalog.jsonb_build_object('status', 'stale', 'permitted', v_current);
  end if;
  if v_current = p_desired then
    return pg_catalog.jsonb_build_object('status', 'unchanged', 'permitted', v_current);
  end if;
  if not p_desired then
    -- Withdrawing is always possible for an owner/admin; it cancels nothing already sent.
    delete from public.social_account_manual_publish_permissions p where p.social_account_id = p_social_account_id;
    return pg_catalog.jsonb_build_object('status', 'updated', 'permitted', false);
  end if;
  v_code := public.threads_manual_publish_authorize(v_user, p_social_account_id, false);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  insert into public.social_account_manual_publish_permissions (social_account_id, brand_id, granted_by)
  values (p_social_account_id, v_brand_id, v_user);
  return pg_catalog.jsonb_build_object('status', 'updated', 'permitted', true);
exception
  when lock_not_available or deadlock_detected or unique_violation then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    -- The deletion guard (SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS) or another reviewed guard.
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

create function public.get_threads_manual_publish_state(p_social_account_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_brand_id text;
  v_open public.threads_manual_publish_attempts%rowtype;
  v_last public.threads_manual_publish_attempts%rowtype;
begin
  if v_user is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  select a.brand_id into v_brand_id from public.social_accounts a where a.id = p_social_account_id;
  if v_brand_id is null or not exists (select 1 from public.brand_memberships m where m.brand_id = v_brand_id and m.user_id = v_user) then
    return public.threads_manual_publish_refused('ACCOUNT_NOT_FOUND');
  end if;
  select t.* into v_open from public.threads_manual_publish_attempts t
  where t.social_account_id = p_social_account_id and t.status not in ('published', 'published_unidentified', 'failed')
  order by t.created_at desc limit 1;
  select t.* into v_last from public.threads_manual_publish_attempts t
  where t.social_account_id = p_social_account_id and t.status in ('published', 'published_unidentified', 'failed')
  order by t.created_at desc limit 1;
  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'permitted', exists (select 1 from public.social_account_manual_publish_permissions p where p.social_account_id = p_social_account_id),
    'open_attempt', case when v_open.id is null then null else public.threads_manual_publish_attempt_json(v_open) end,
    'last_attempt', case when v_last.id is null then null else public.threads_manual_publish_attempt_json(v_last) end);
end;
$$;

create function public.begin_threads_manual_publish(p_social_account_id text, p_idempotency_key uuid, p_text text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_hash text;
  v_row public.threads_manual_publish_attempts%rowtype;
begin
  if v_user is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}$' or p_idempotency_key is null then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  if p_text is null or pg_catalog.char_length(p_text) not between 1 and 500
     or pg_catalog.btrim(p_text, E' \t\n　') = '' or pg_catalog.translate(p_text, E'\n\t', '') ~ '[[:cntrl:]]' then
    return public.threads_manual_publish_refused('TEXT_INVALID');
  end if;
  v_code := public.threads_manual_publish_fence(v_user);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  v_code := public.threads_manual_publish_authorize(v_user, p_social_account_id, true);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_text, 'UTF8')), 'hex');
  for i in 1..2 loop
    select t.* into v_row from public.threads_manual_publish_attempts t
    where t.social_account_id = p_social_account_id and t.idempotency_key = p_idempotency_key;
    if v_row.id is not null then
      -- A replay: same key, same caller, same text -> the same attempt, nothing new happens.
      if v_row.requested_by is distinct from v_user or v_row.text_sha256 is distinct from v_hash then
        return public.threads_manual_publish_refused('IDEMPOTENCY_CONFLICT');
      end if;
      return pg_catalog.jsonb_build_object('status', 'replayed', 'attempt', public.threads_manual_publish_attempt_json(v_row));
    end if;
    if exists (select 1 from public.threads_manual_publish_attempts t
               where t.social_account_id = p_social_account_id and t.status not in ('published', 'published_unidentified', 'failed')) then
      return public.threads_manual_publish_refused('PUBLISH_IN_PROGRESS');
    end if;
    begin
      insert into public.threads_manual_publish_attempts (social_account_id, brand_id, requested_by, idempotency_key, post_text, text_sha256)
      select p_social_account_id, a.brand_id, v_user, p_idempotency_key, p_text, v_hash
      from public.social_accounts a where a.id = p_social_account_id
      returning * into v_row;
      return pg_catalog.jsonb_build_object('status', 'reserved', 'attempt', public.threads_manual_publish_attempt_json(v_row));
    exception when unique_violation then
      -- A concurrent begin won (same key -> replay on the next pass; another key -> in progress).
      v_row := null;
    end;
  end loop;
  return public.threads_manual_publish_refused('BUSY');
exception
  when lock_not_available or deadlock_detected then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

create function public.claim_threads_manual_publish_step(p_attempt_id uuid, p_step text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_user uuid := auth.uid();
  v_code text;
  v_from text;
  v_to text;
  v_row public.threads_manual_publish_attempts%rowtype;
  v_grant text;
begin
  if v_user is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  v_from := case p_step when 'create_container' then 'reserved' when 'check_container' then 'container_created'
                        when 'publish' then 'container_created' when 'confirm' then 'publish_returned'
                        when 'reconcile' then 'uncertain' end;
  v_to := case p_step when 'create_container' then 'creating_container' when 'publish' then 'publishing' end;
  if p_attempt_id is null or v_from is null then return public.threads_manual_publish_refused('REQUEST_INVALID'); end if;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id;
  if v_row.id is null or not exists (select 1 from public.brand_memberships m where m.brand_id = v_row.brand_id and m.user_id = v_user) then
    return public.threads_manual_publish_refused('ATTEMPT_NOT_FOUND');
  end if;
  v_code := public.threads_manual_publish_fence(v_user);
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  -- The post-publish read-backs do not need the permission (THREADS_PERMISSION_STEPS).
  v_code := public.threads_manual_publish_authorize(v_user, v_row.social_account_id, p_step in ('create_container', 'check_container', 'publish'));
  if v_code is not null then return public.threads_manual_publish_refused(v_code); end if;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id for update;
  if p_step = 'reconcile' and v_row.updated_at < pg_catalog.now() - interval '120 seconds' then
    -- An abandoned in-flight write is settled first. creating_container: no container id was ever
    -- recorded, so nothing can be published from it. publishing: the outcome is unknown.
    if v_row.status = 'creating_container' then
      update public.threads_manual_publish_attempts t
         set status = 'failed', error_code = 'STEP_INTERRUPTED', grant_hash = null, grant_step = null,
             grant_state = null, grant_expires_at = null, updated_at = pg_catalog.now()
       where t.id = p_attempt_id;
      return public.threads_manual_publish_refused('STALE_STEP');
    end if;
    if v_row.status = 'publishing' then
      update public.threads_manual_publish_attempts t
         set status = 'uncertain', error_code = 'STEP_INTERRUPTED', grant_hash = null, grant_step = null,
             grant_state = null, grant_expires_at = null, updated_at = pg_catalog.now()
       where t.id = p_attempt_id
      returning * into v_row;
    end if;
  end if;
  if v_row.status is distinct from v_from then return public.threads_manual_publish_refused('STALE_STEP'); end if;
  if v_to is not null and v_row.created_at < pg_catalog.now() - interval '15 minutes' then
    -- Too old to continue to a provider write; reserved / container_created never carry a post.
    update public.threads_manual_publish_attempts t
       set status = 'failed', error_code = 'ATTEMPT_EXPIRED', grant_hash = null, grant_step = null,
           grant_state = null, grant_expires_at = null, updated_at = pg_catalog.now()
     where t.id = p_attempt_id;
    return public.threads_manual_publish_refused('ATTEMPT_EXPIRED');
  end if;
  v_grant := pg_catalog.replace(gen_random_uuid()::text, '-', '') || pg_catalog.replace(gen_random_uuid()::text, '-', '');
  update public.threads_manual_publish_attempts t
     set status = coalesce(v_to, t.status),
         updated_at = case when v_to is null then t.updated_at else pg_catalog.now() end,
         grant_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_grant, 'UTF8')), 'hex'),
         grant_step = p_step, grant_state = 'issued',
         grant_expires_at = pg_catalog.clock_timestamp() + interval '60 seconds'
   where t.id = p_attempt_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object('status', 'claimed', 'grant', v_grant, 'attempt', public.threads_manual_publish_attempt_json(v_row));
exception
  when lock_not_available or deadlock_detected then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

create function public.get_threads_manual_publish_attempt(p_attempt_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_row public.threads_manual_publish_attempts%rowtype;
begin
  if v_user is null then return public.threads_manual_publish_refused('AUTH_REQUIRED'); end if;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id;
  if v_row.id is null or not exists (select 1 from public.brand_memberships m where m.brand_id = v_row.brand_id and m.user_id = v_user) then
    return public.threads_manual_publish_refused('ATTEMPT_NOT_FOUND');
  end if;
  return pg_catalog.jsonb_build_object('status', 'ok', 'attempt', public.threads_manual_publish_attempt_json(v_row));
end;
$$;

-- --- Server functions (service_role only) ------------------------------------------------------------

create function public.redeem_threads_manual_publish_step(p_attempt_id uuid, p_step text, p_grant text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_row public.threads_manual_publish_attempts%rowtype;
  v_account public.social_accounts%rowtype;
  v_expected text;
  v_token text;
  v_refusal text;
begin
  if p_attempt_id is null or p_grant is null or p_grant !~ '^[0-9a-f]{64}$' then return public.threads_manual_publish_refused('GRANT_INVALID'); end if;
  v_expected := case p_step when 'create_container' then 'creating_container' when 'check_container' then 'container_created'
                            when 'publish' then 'publishing' when 'confirm' then 'publish_returned' when 'reconcile' then 'uncertain' end;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id for update;
  if v_row.id is null or v_expected is null or v_row.status is distinct from v_expected
     or v_row.grant_step is distinct from p_step or v_row.grant_state is distinct from 'issued'
     or v_row.grant_expires_at <= pg_catalog.clock_timestamp()
     or v_row.grant_hash is distinct from pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_grant, 'UTF8')), 'hex') then
    return public.threads_manual_publish_refused('GRANT_INVALID');
  end if;
  update public.threads_manual_publish_attempts t set grant_state = 'redeemed' where t.id = p_attempt_id;
  -- Re-checked on the current state: the account may have changed since the claim.
  select a.* into v_account from public.social_accounts a where a.id = v_row.social_account_id;
  v_refusal := case
    when v_account.id is null or v_account.platform is distinct from 'threads' or v_account.brand_id is distinct from v_row.brand_id
      then 'ACCOUNT_NOT_FOUND'
    when v_account.connection_status is distinct from 'identity_verified' or coalesce(v_account.platform_user_id, '') !~ '^[1-9][0-9]{0,31}$'
      then 'CONNECTION_NOT_VERIFIED'
    when p_step in ('create_container', 'check_container', 'publish') and not exists (
           select 1 from public.social_account_manual_publish_permissions p where p.social_account_id = v_row.social_account_id)
      then 'MANUAL_PUBLISH_NOT_PERMITTED'
    when v_account.vault_access_token_secret_id is null then 'CREDENTIALS_MISSING'
    when coalesce(public.threads_account_credential_expires_at(v_account.id), '-infinity') <= pg_catalog.clock_timestamp() + interval '5 minutes'
      then 'CREDENTIALS_EXPIRED'
  end;
  if v_refusal is null then
    begin
      select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = v_account.vault_access_token_secret_id;
    exception when others then
      v_token := null;
    end;
    if coalesce(v_token, '') = '' then v_refusal := 'CREDENTIALS_MISSING'; end if;
  end if;
  if v_refusal is not null then
    -- No credential left this function, so the claimed write was provably never sent: a write step's
    -- in-flight status is closed as failed (a read step changes nothing).
    if p_step in ('create_container', 'publish') then
      update public.threads_manual_publish_attempts t
         set status = 'failed', error_code = 'AUTHORIZATION_CHANGED', grant_hash = null, grant_step = null,
             grant_state = null, grant_expires_at = null, updated_at = pg_catalog.now()
       where t.id = p_attempt_id;
    end if;
    return public.threads_manual_publish_refused(v_refusal);
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'redeemed',
    'threads_user_id', v_account.platform_user_id,
    'access_token', v_token,
    'text', case when p_step in ('create_container', 'reconcile') then v_row.post_text end,
    'container_id', v_row.container_id,
    'provider_post_id', v_row.provider_post_id,
    'attempt_created_at', v_row.created_at);
exception
  when lock_not_available or deadlock_detected then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

create function public.record_threads_manual_publish_step(
  p_attempt_id uuid, p_step text, p_grant text, p_to_status text,
  p_container_id text, p_provider_post_id text, p_permalink text, p_error_code text)
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_row public.threads_manual_publish_attempts%rowtype;
  v_ok boolean;
begin
  if p_attempt_id is null or p_grant is null or p_grant !~ '^[0-9a-f]{64}$' then return public.threads_manual_publish_refused('GRANT_INVALID'); end if;
  select t.* into v_row from public.threads_manual_publish_attempts t where t.id = p_attempt_id for update;
  -- No expiry here: the provider call may outlast the grant; its answer must still be recorded.
  if v_row.id is null or v_row.grant_step is distinct from p_step or v_row.grant_state is distinct from 'redeemed'
     or v_row.grant_hash is distinct from pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_grant, 'UTF8')), 'hex') then
    return public.threads_manual_publish_refused('GRANT_INVALID');
  end if;
  -- THREADS_RECORD_TRANSITIONS, exactly.
  v_ok := (p_step, v_row.status, p_to_status) in (
    ('create_container', 'creating_container', 'container_created'), ('create_container', 'creating_container', 'failed'),
    ('check_container', 'container_created', 'failed'),
    ('publish', 'publishing', 'publish_returned'), ('publish', 'publishing', 'failed'), ('publish', 'publishing', 'uncertain'),
    ('confirm', 'publish_returned', 'published'),
    ('reconcile', 'uncertain', 'published'), ('reconcile', 'uncertain', 'published_unidentified'),
    ('reconcile', 'uncertain', 'failed'), ('reconcile', 'uncertain', 'uncertain'));
  if not v_ok then return public.threads_manual_publish_refused('STALE_STEP'); end if;
  -- Exactly the fields each result carries.
  if (p_to_status = 'container_created') is distinct from (p_container_id is not null)
     or (p_to_status in ('publish_returned', 'published')) is distinct from (p_provider_post_id is not null)
     or (p_to_status = 'published') is distinct from (p_permalink is not null)
     or (p_to_status in ('failed', 'uncertain', 'published_unidentified')) is distinct from (p_error_code is not null)
     or (p_to_status = 'published' and v_row.provider_post_id is not null and v_row.provider_post_id is distinct from p_provider_post_id) then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  end if;
  update public.threads_manual_publish_attempts t
     set status = p_to_status,
         container_id = coalesce(p_container_id, t.container_id),
         provider_post_id = coalesce(p_provider_post_id, t.provider_post_id),
         permalink = coalesce(p_permalink, t.permalink),
         error_code = case when p_to_status = 'published' then null else coalesce(p_error_code, t.error_code) end,
         grant_hash = null, grant_step = null, grant_state = null, grant_expires_at = null,
         updated_at = pg_catalog.now()
   where t.id = p_attempt_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'attempt', public.threads_manual_publish_attempt_json(v_row));
exception
  when check_violation then
    return public.threads_manual_publish_refused('REQUEST_INVALID');
  when lock_not_available or deadlock_detected then
    return public.threads_manual_publish_refused('BUSY');
  when raise_exception then
    return public.threads_manual_publish_refused('ACCOUNT_LIFECYCLE_BLOCKED');
end;
$$;

-- --- Access ---------------------------------------------------------------------------------------------

revoke all on function
  public.threads_manual_publish_attempt_json(public.threads_manual_publish_attempts),
  public.threads_manual_publish_refused(text),
  public.threads_manual_publish_fence(uuid),
  public.threads_manual_publish_authorize(uuid, text, boolean),
  public.set_threads_manual_publish_permission(text, boolean, boolean),
  public.get_threads_manual_publish_state(text),
  public.begin_threads_manual_publish(text, uuid, text),
  public.claim_threads_manual_publish_step(uuid, text),
  public.get_threads_manual_publish_attempt(uuid),
  public.redeem_threads_manual_publish_step(uuid, text, text),
  public.record_threads_manual_publish_step(uuid, text, text, text, text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.set_threads_manual_publish_permission(text, boolean, boolean),
  public.get_threads_manual_publish_state(text),
  public.begin_threads_manual_publish(text, uuid, text),
  public.claim_threads_manual_publish_step(uuid, text),
  public.get_threads_manual_publish_attempt(uuid)
to authenticated;
grant execute on function
  public.redeem_threads_manual_publish_step(uuid, text, text),
  public.record_threads_manual_publish_step(uuid, text, text, text, text, text, text, text)
to service_role;

-- Postcondition: no app role can read or write the tables directly; each function is reachable by
-- exactly the role it is for.
do $$
begin
  if exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app),
                           (values ('public.threads_manual_publish_attempts'), ('public.social_account_manual_publish_permissions')) t(tbl)
             where pg_catalog.has_table_privilege(a.app, t.tbl, 'SELECT') or pg_catalog.has_table_privilege(a.app, t.tbl, 'INSERT')
                or pg_catalog.has_table_privilege(a.app, t.tbl, 'UPDATE') or pg_catalog.has_table_privilege(a.app, t.tbl, 'DELETE')) then
    raise exception 'THREADS_PUBLISH_POSTCONDITION_TABLE_ACL';
  end if;
  if pg_catalog.has_function_privilege('anon', 'public.begin_threads_manual_publish(text,uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.redeem_threads_manual_publish_step(uuid,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.record_threads_manual_publish_step(uuid,text,text,text,text,text,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.redeem_threads_manual_publish_step(uuid,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.threads_manual_publish_authorize(uuid,text,boolean)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.threads_manual_publish_fence(uuid)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', 'public.claim_threads_manual_publish_step(uuid,text)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', 'public.redeem_threads_manual_publish_step(uuid,text,text)', 'EXECUTE') then
    raise exception 'THREADS_PUBLISH_POSTCONDITION_FUNCTION_ACL';
  end if;
end $$;

commit;
