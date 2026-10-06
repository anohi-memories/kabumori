-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is
-- mandatory before any apply; apply as a single reviewed file (never db push).
-- Phase 4b (H2 C2 corrections R1-R4).
--
-- Social-mobile self-service account deletion: the privileged data boundary.
-- Called only by the Edge Function `social-mobile-account-delete` with the
-- service role, always with the user id the function verified from the
-- caller's own JWT. No client role can execute anything here.
--
-- Production shape relied on (read-only catalog inspection 2026-09-28/29):
--   * brand_memberships(brand_id -> brands CASCADE, user_id -> auth.users CASCADE)
--   * profiles.id -> auth.users CASCADE (Kabumori main-app data)
--   * every other reference to brands / social_accounts / scheduled_posts is
--     NO ACTION (only daily_content_plans cascades from brands)
--   * the social-mobile workspace id is 'u_' || substr(md5(user_id), 1, 24)
--
-- Design (docs: apps/social-mobile/docs/account-lifecycle-phase4.md):
--   * Durable deletion record (tombstone) per user, with a lease. It survives
--     HTTP/transaction boundaries and is removed only on completion or by an
--     operator cancel.
--   * While a tombstone exists, guard triggers make EVERY writer of the
--     user's workspace rows fail closed (X OAuth begin/complete, credential
--     refresh/rollout, posting, workspace recreation), except the deletion
--     process itself, identified by its unguessable lease token.
--   * The exact credential set is bound when deletion starts; foreign/shared
--     secret references refuse up front (before any external revoke). The
--     X revoke is accepted only against SHA-256 fingerprints of the current
--     Vault material, which purge re-verifies.
--   * Scope: the shared login (auth.users) is deleted only when the user has
--     no Kabumori main-app data (no profiles row), checked and deleted in one
--     transaction with the auth row locked. Otherwise only the social-mobile
--     data is deleted and the login is kept (never a hidden cascade).
--
--   * Phase 4c: one per-workspace serialization lock (transaction advisory
--     lock on the derived workspace id) is taken by every workspace/membership
--     creation (guard trigger on INSERT into brands / brand_memberships) and
--     by every deletion step before any snapshot or row lock. An in-flight
--     first onboarding therefore finishes (and is then deleted) or waits and
--     fails closed; deletion can never snapshot "no workspace" while one is
--     being created. Lock order everywhere: deletion lock -> workspace lock ->
--     row / auth.users locks. finalize re-checks under the locks that no row
--     of the workspace exists before the login and tombstone are removed.
--
-- States: started -> x_revoked -> purged -> (completed: tombstone removed)
--         any pre-purge state -> operator_required (reason) -> operator resolve

do $$
begin
  if to_regclass('public.social_mobile_account_deletions') is not null then
    raise exception 'SOCIAL_MOBILE_DELETION_CANDIDATE_ALREADY_APPLIED';
  end if;
  if to_regclass('public.brand_memberships') is null or to_regclass('public.admin_users') is null or to_regclass('public.profiles') is null then
    raise exception 'SOCIAL_MOBILE_DELETION_PREREQUISITE_MISSING';
  end if;
end;
$$;

-- Outcome log without personal data: SHA-256 of the user id plus fixed codes.
create table public.social_mobile_account_deletion_audit (
  id bigint generated always as identity primary key,
  subject_sha256 text not null check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  step text not null check (step in (
    'requested', 'blocked', 'started', 'x_revoked', 'apple_revoked', 'purged',
    'completed', 'completed_social_only', 'operator_required', 'operator_resolved', 'failed')),
  reason_code text check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz not null default now()
);
alter table public.social_mobile_account_deletion_audit enable row level security;
revoke all on table public.social_mobile_account_deletion_audit from public, anon, authenticated, service_role;

-- The durable deletion record. Holds the raw user id only while a deletion
-- is in progress; the row is removed on completion.
create table public.social_mobile_account_deletions (
  user_id uuid primary key,
  workspace_id text not null unique check (workspace_id ~ '^u_[0-9a-f]{24}$'),
  state text not null check (state in ('started', 'x_revoked', 'purged', 'operator_required')),
  resume_state text check (resume_state is null or resume_state in ('started', 'x_revoked', 'purged')),
  operator_reason text check (operator_reason is null or operator_reason ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  scope text not null check (scope in ('social_only', 'social_and_login')),
  apple_required boolean not null default false,
  apple_revoked_at timestamptz,
  credential_set jsonb not null,
  revoked_fingerprints jsonb,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((lease_token is null) = (lease_expires_at is null)),
  check ((state = 'operator_required') = (operator_reason is not null and resume_state is not null))
);
alter table public.social_mobile_account_deletions enable row level security;
revoke all on table public.social_mobile_account_deletions from public, anon, authenticated, service_role;

create function public.social_mobile_account_deletion_subject(p_user_id uuid)
returns text language sql immutable set search_path = ''
as $$ select encode(pg_catalog.sha256(convert_to(p_user_id::text, 'UTF8')), 'hex') $$;

create function public.social_mobile_account_deletion_workspace(p_user_id uuid)
returns text language sql immutable set search_path = ''
as $$ select 'u_' || substr(md5(p_user_id::text), 1, 24) $$;

-- The per-workspace serialization primitive shared by creation and deletion.
create function public.social_mobile_account_deletion_workspace_lock(p_workspace text)
returns void language sql volatile set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended('social_mobile_workspace:' || p_workspace, 0)) $$;

create function public.social_mobile_account_deletion_record(p_user_id uuid, p_step text, p_reason_code text default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_user_id is null then raise exception 'SOCIAL_MOBILE_DELETION_USER_REQUIRED'; end if;
  insert into public.social_mobile_account_deletion_audit (subject_sha256, step, reason_code)
  values (public.social_mobile_account_deletion_subject(p_user_id), p_step, p_reason_code);
end;
$$;

-- R1: every writer of a workspace under deletion fails closed, except the
-- deletion process holding the current lease (transaction-local setting).
create function public.social_mobile_account_deletion_guard()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_workspace text;
  v_lease uuid;
begin
  if tg_table_name = 'brands' then
    v_workspace := new.id;
  elsif tg_table_name in ('x_account_refresh_state_v2', 'x_account_refresh_rollout') then
    select a.brand_id into v_workspace from public.social_accounts a where a.id = new.social_account_id;
  else
    v_workspace := new.brand_id;
  end if;
  if v_workspace is null or v_workspace !~ '^u_' then
    return new;
  end if;
  -- Creation of a workspace or membership serializes with deletion; the
  -- tombstone is then read with a fresh (post-lock) snapshot.
  if tg_op = 'INSERT' and tg_table_name in ('brands', 'brand_memberships') then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'SOCIAL_MOBILE_WORKSPACE_CREATION_REQUIRES_READ_COMMITTED';
    end if;
    perform public.social_mobile_account_deletion_workspace_lock(v_workspace);
  end if;
  select d.lease_token into v_lease from public.social_mobile_account_deletions d where d.workspace_id = v_workspace;
  if not found then
    return new;
  end if;
  if v_lease is not null and current_setting('kabumori.social_mobile_deletion_lease', true) = v_lease::text then
    return new;
  end if;
  raise exception 'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS';
end;
$$;

create trigger social_mobile_deletion_guard before insert or update on public.brands
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.brand_memberships
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.social_accounts
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.social_account_oauth_states
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.x_account_refresh_state_v2
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.x_account_refresh_rollout
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.scheduled_posts
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.publish_claims
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.published_content_fingerprints
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.post_execution_logs
  for each row execute function public.social_mobile_account_deletion_guard();
create trigger social_mobile_deletion_guard before insert or update on public.posting_windows
  for each row execute function public.social_mobile_account_deletion_guard();

-- The exact credential set of a workspace (secret ids only, never material).
create function public.social_mobile_account_deletion_credential_set(p_workspace text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'access', a.vault_access_token_secret_id, 'refresh', a.vault_refresh_token_secret_id,
        'platform_user_id', a.platform_user_id, 'connection_status', a.connection_status) order by a.id)
      from public.social_accounts a where a.brand_id = p_workspace), '[]'::jsonb),
    'verifiers', coalesce((
      select jsonb_agg(distinct s.code_verifier_vault_secret_id order by s.code_verifier_vault_secret_id)
      from public.social_account_oauth_states s
      where s.brand_id = p_workspace and s.code_verifier_vault_secret_id is not null), '[]'::jsonb))
$$;

-- R3: every candidate secret must belong to exactly one role of this
-- workspace; any other reference (another workspace, account, OAuth state or
-- refresh lease) is ambiguous and refuses the deletion before anything happens.
create function public.social_mobile_account_deletion_ownership_problem(p_workspace text)
returns text language plpgsql stable security definer set search_path = ''
as $$
declare
  v_accounts text[];
  v_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into v_accounts from public.social_accounts where brand_id = p_workspace;
  with refs as (
    select vault_access_token_secret_id as secret_id from public.social_accounts where brand_id = p_workspace
    union all select vault_refresh_token_secret_id from public.social_accounts where brand_id = p_workspace
    union all select code_verifier_vault_secret_id from public.social_account_oauth_states where brand_id = p_workspace
  )
  select coalesce(array_agg(secret_id), '{}') into v_ids from refs where secret_id is not null;
  if (select count(*) from unnest(v_ids)) <> (select count(distinct x) from unnest(v_ids) x) then
    return 'CREDENTIAL_OWNERSHIP_AMBIGUOUS';
  end if;
  if exists (
       select 1 from public.social_accounts
        where brand_id <> p_workspace
          and (vault_access_token_secret_id = any (v_ids) or vault_refresh_token_secret_id = any (v_ids)))
     or exists (
       select 1 from public.social_account_oauth_states
        where (brand_id <> p_workspace or not (social_account_id = any (v_accounts)))
          and code_verifier_vault_secret_id = any (v_ids))
     or exists (
       select 1 from public.x_account_refresh_state_v2
        where not (social_account_id = any (v_accounts))
          and (leased_access_secret_id = any (v_ids) or leased_refresh_secret_id = any (v_ids)))
     or exists (
       select 1 from public.x_account_refresh_state_v2 s
         join public.social_accounts a on a.id = s.social_account_id
        where a.brand_id = p_workspace
          and ((s.leased_access_secret_id is not null and s.leased_access_secret_id is distinct from a.vault_access_token_secret_id)
            or (s.leased_refresh_secret_id is not null and s.leased_refresh_secret_id is distinct from a.vault_refresh_token_secret_id))) then
    return 'CREDENTIAL_OWNERSHIP_AMBIGUOUS';
  end if;
  return null;
end;
$$;

-- Exact-user checks. Returns null when the user may proceed, or a fixed code.
create function public.social_mobile_account_deletion_blocker(p_user_id uuid, p_workspace text)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_profile text;
begin
  if exists (select 1 from public.admin_users where user_id = p_user_id) then
    return 'ADMIN_ACCOUNT';
  end if;
  if exists (select 1 from public.brand_memberships where user_id = p_user_id and role = 'owner' and brand_id <> p_workspace) then
    return 'OWNS_OTHER_WORKSPACE';
  end if;
  select code_profile_key into v_profile from public.brands where id = p_workspace for update;
  if not found then
    return null;
  end if;
  if v_profile <> 'social_mobile_user_v1' then
    return 'WORKSPACE_NOT_SELF_SERVICE';
  end if;
  perform 1 from public.brand_memberships where brand_id = p_workspace for update;
  if exists (select 1 from public.brand_memberships where brand_id = p_workspace and user_id <> p_user_id) then
    return 'SHARED_WORKSPACE';
  end if;
  if not exists (select 1 from public.brand_memberships where brand_id = p_workspace and user_id = p_user_id and role = 'owner') then
    return 'WORKSPACE_ROLE_MISMATCH';
  end if;
  perform 1 from public.social_accounts where brand_id = p_workspace for update;
  perform 1 from public.scheduled_posts where brand_id = p_workspace and status in ('pending', 'running') for update;
  if exists (select 1 from public.scheduled_posts where brand_id = p_workspace and status = 'running')
     or exists (select 1 from public.publish_claims where brand_id = p_workspace and status = 'publishing') then
    return 'POSTING_IN_PROGRESS';
  end if;
  if exists (
    select 1 from public.x_account_refresh_state_v2 s
    join public.social_accounts a on a.id = s.social_account_id
    where a.brand_id = p_workspace and s.status = 'refreshing'
  ) then
    return 'CREDENTIAL_REFRESH_IN_PROGRESS';
  end if;
  return public.social_mobile_account_deletion_ownership_problem(p_workspace);
end;
$$;

create function public.social_mobile_account_deletion_scope(p_user_id uuid)
returns text language sql stable security definer set search_path = ''
as $$ select case when exists (select 1 from public.profiles where id = p_user_id) then 'social_only' else 'social_and_login' end $$;

-- Validates the lease and makes the guard triggers accept this transaction.
create function public.social_mobile_account_deletion_hold(p_user_id uuid, p_lease uuid)
returns public.social_mobile_account_deletions language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
begin
  if p_user_id is null or p_lease is null then raise exception 'SOCIAL_MOBILE_DELETION_LEASE_LOST'; end if;
  perform pg_advisory_xact_lock(hashtextextended('social_mobile_account_deletion:' || p_user_id::text, 0));
  perform public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace(p_user_id));
  select * into v_row from public.social_mobile_account_deletions where user_id = p_user_id for update;
  if not found or v_row.lease_token is distinct from p_lease or v_row.lease_expires_at <= now() then
    raise exception 'SOCIAL_MOBILE_DELETION_LEASE_LOST';
  end if;
  perform set_config('kabumori.social_mobile_deletion_lease', p_lease::text, true);
  return v_row;
end;
$$;

create function public.social_mobile_account_deletion_to_operator(p_user_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  update public.social_mobile_account_deletions
     set resume_state = state, state = 'operator_required', operator_reason = p_reason,
         lease_token = null, lease_expires_at = null, updated_at = now()
   where user_id = p_user_id and state <> 'operator_required';
  perform public.social_mobile_account_deletion_record(p_user_id, 'operator_required', p_reason);
  return jsonb_build_object('status', 'operator_required', 'reason', p_reason);
end;
$$;

-- Read-only: what a deletion would do now (for the confirmation screen).
create function public.social_mobile_account_deletion_preview(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
begin
  if p_user_id is null then raise exception 'SOCIAL_MOBILE_DELETION_USER_REQUIRED'; end if;
  select * into v_row from public.social_mobile_account_deletions where user_id = p_user_id;
  if found then
    return jsonb_build_object('state', v_row.state, 'scope', v_row.scope, 'apple_revoked', v_row.apple_revoked_at is not null,
      'operator_reason', v_row.operator_reason);
  end if;
  return jsonb_build_object('state', 'none', 'scope', public.social_mobile_account_deletion_scope(p_user_id), 'apple_revoked', false);
end;
$$;

-- Step 1: create (or resume) the durable deletion and take the lease.
create function public.social_mobile_account_deletion_acquire(
  p_user_id uuid, p_expected_scope text, p_apple_required boolean, p_lease_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_workspace text;
  v_row public.social_mobile_account_deletions;
  v_scope text;
  v_blocker text;
  v_lease uuid := gen_random_uuid();
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 300), 30), 900);
begin
  if p_user_id is null then raise exception 'SOCIAL_MOBILE_DELETION_USER_REQUIRED'; end if;
  if p_expected_scope not in ('social_only', 'social_and_login') then raise exception 'SOCIAL_MOBILE_DELETION_SCOPE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('social_mobile_account_deletion:' || p_user_id::text, 0));
  v_workspace := public.social_mobile_account_deletion_workspace(p_user_id);
  -- Before any snapshot: wait for an in-flight workspace creation to finish.
  perform public.social_mobile_account_deletion_workspace_lock(v_workspace);
  select * into v_row from public.social_mobile_account_deletions where user_id = p_user_id for update;
  if found then
    if v_row.state = 'operator_required' then
      return jsonb_build_object('status', 'operator_required', 'reason', v_row.operator_reason);
    end if;
    if v_row.scope <> p_expected_scope then
      return jsonb_build_object('status', 'scope_changed', 'scope', v_row.scope);
    end if;
    if v_row.lease_token is not null and v_row.lease_expires_at > now() then
      return jsonb_build_object('status', 'in_progress');
    end if;
    update public.social_mobile_account_deletions
       set lease_token = v_lease, lease_expires_at = now() + make_interval(secs => v_seconds),
           apple_required = apple_required or coalesce(p_apple_required, false), updated_at = now()
     where user_id = p_user_id returning * into v_row;
    return jsonb_build_object('status', 'acquired', 'lease', v_lease, 'state', v_row.state,
      'apple_required', v_row.apple_required, 'apple_revoked', v_row.apple_revoked_at is not null);
  end if;

  v_scope := public.social_mobile_account_deletion_scope(p_user_id);
  if v_scope <> p_expected_scope then
    return jsonb_build_object('status', 'scope_changed', 'scope', v_scope);
  end if;
  v_blocker := public.social_mobile_account_deletion_blocker(p_user_id, v_workspace);
  if v_blocker is not null then
    perform public.social_mobile_account_deletion_record(p_user_id, 'blocked', v_blocker);
    return jsonb_build_object('status', 'blocked', 'reason', v_blocker);
  end if;

  insert into public.social_mobile_account_deletions
    (user_id, workspace_id, state, scope, apple_required, credential_set, lease_token, lease_expires_at)
  values (p_user_id, v_workspace, 'started', v_scope, coalesce(p_apple_required, false),
          public.social_mobile_account_deletion_credential_set(v_workspace), v_lease, now() + make_interval(secs => v_seconds));
  perform set_config('kabumori.social_mobile_deletion_lease', v_lease::text, true);
  -- Posting authority off before anything external or destructive.
  update public.brands set is_active = false, publish_mode = 'disabled', updated_at = now() where id = v_workspace;
  update public.social_accounts set publish_enabled = false, updated_at = now() where brand_id = v_workspace;
  update public.x_account_refresh_rollout
     set mode = 'off', pilot_expires_at = null, pilot_max_generation = null, reason_code = 'ACCOUNT_DELETION', updated_at = now()
   where social_account_id in (select id from public.social_accounts where brand_id = v_workspace);
  update public.scheduled_posts set status = 'failed', finished_at = now() where brand_id = v_workspace and status = 'pending';
  perform public.social_mobile_account_deletion_record(p_user_id, 'started', null);
  return jsonb_build_object('status', 'acquired', 'lease', v_lease, 'state', 'started',
    'apple_required', coalesce(p_apple_required, false), 'apple_revoked', false);
end;
$$;

create function public.social_mobile_account_deletion_release(p_user_id uuid, p_lease uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  update public.social_mobile_account_deletions set lease_token = null, lease_expires_at = null, updated_at = now()
   where user_id = p_user_id and lease_token = p_lease;
end;
$$;

-- Current SHA-256 of a Vault secret's material (null when missing/empty).
create function public.social_mobile_account_deletion_fingerprint(p_secret_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select encode(pg_catalog.sha256(convert_to(d.decrypted_secret, 'UTF8')), 'hex')
    from vault.decrypted_secrets d where d.id = p_secret_id and coalesce(d.decrypted_secret, '') <> ''
$$;

-- Step 2: X material of the bound set. R4: a connected account whose
-- required material is missing goes to operator_required (never a skip).
create function public.social_mobile_account_deletion_credentials(p_user_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
  v_problem text;
  v_accounts jsonb := '[]'::jsonb;
  v_account jsonb;
  v_required boolean;
  v_access text;
  v_refresh text;
begin
  v_row := public.social_mobile_account_deletion_hold(p_user_id, p_lease);
  if v_row.state <> 'started' then
    return jsonb_build_object('status', 'not_needed', 'state', v_row.state);
  end if;
  if public.social_mobile_account_deletion_credential_set(v_row.workspace_id) <> v_row.credential_set then
    return public.social_mobile_account_deletion_to_operator(p_user_id, 'CREDENTIALS_CHANGED');
  end if;
  v_problem := public.social_mobile_account_deletion_ownership_problem(v_row.workspace_id);
  if v_problem is not null then
    return public.social_mobile_account_deletion_to_operator(p_user_id, v_problem);
  end if;
  for v_account in select * from jsonb_array_elements(v_row.credential_set -> 'accounts') loop
    v_required := (v_account ->> 'access') is not null or (v_account ->> 'refresh') is not null
      or (v_account ->> 'platform_user_id') is not null
      or (v_account ->> 'connection_status') in ('connected', 'identity_verified');
    v_access := null;
    v_refresh := null;
    if v_required then
      select d.decrypted_secret into v_access from vault.decrypted_secrets d where d.id = (v_account ->> 'access')::uuid;
      select d.decrypted_secret into v_refresh from vault.decrypted_secrets d where d.id = (v_account ->> 'refresh')::uuid;
      if coalesce(v_access, '') = '' or coalesce(v_refresh, '') = '' then
        return public.social_mobile_account_deletion_to_operator(p_user_id, 'CREDENTIAL_MATERIAL_MISSING');
      end if;
    end if;
    v_accounts := v_accounts || jsonb_build_object('id', v_account ->> 'id', 'revoke_required', v_required,
      'access_token', v_access, 'refresh_token', v_refresh);
  end loop;
  return jsonb_build_object('status', 'ok', 'accounts', v_accounts);
end;
$$;

-- Step 2b: X revocation is recorded only for exactly the current material.
create function public.social_mobile_account_deletion_mark_x_revoked(p_user_id uuid, p_lease uuid, p_revoked jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
  v_expected jsonb := '[]'::jsonb;
  v_account jsonb;
  v_given jsonb;
begin
  v_row := public.social_mobile_account_deletion_hold(p_user_id, p_lease);
  if v_row.state <> 'started' then
    return jsonb_build_object('status', 'not_needed', 'state', v_row.state);
  end if;
  for v_account in select * from jsonb_array_elements(v_row.credential_set -> 'accounts') loop
    if (v_account ->> 'access') is not null or (v_account ->> 'refresh') is not null
       or (v_account ->> 'platform_user_id') is not null
       or (v_account ->> 'connection_status') in ('connected', 'identity_verified') then
      v_expected := v_expected || jsonb_build_object('id', v_account ->> 'id',
        'access_sha256', public.social_mobile_account_deletion_fingerprint((v_account ->> 'access')::uuid),
        'refresh_sha256', public.social_mobile_account_deletion_fingerprint((v_account ->> 'refresh')::uuid));
    end if;
  end loop;
  select coalesce(jsonb_agg(e order by e ->> 'id'), '[]'::jsonb) into v_given
    from jsonb_array_elements(coalesce(p_revoked, '[]'::jsonb)) e;
  select coalesce(jsonb_agg(e order by e ->> 'id'), '[]'::jsonb) into v_expected from jsonb_array_elements(v_expected) e;
  if v_given <> v_expected or exists (
       select 1 from jsonb_array_elements(v_expected) e where e ->> 'access_sha256' is null or e ->> 'refresh_sha256' is null) then
    return jsonb_build_object('status', 'credentials_changed');
  end if;
  update public.social_mobile_account_deletions
     set state = 'x_revoked', revoked_fingerprints = v_expected, updated_at = now() where user_id = p_user_id;
  perform public.social_mobile_account_deletion_record(p_user_id, 'x_revoked', null);
  return jsonb_build_object('status', 'x_revoked');
end;
$$;

-- R5: durable checkpoint that the Apple grant was revoked.
create function public.social_mobile_account_deletion_mark_apple_revoked(p_user_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
begin
  v_row := public.social_mobile_account_deletion_hold(p_user_id, p_lease);
  if v_row.apple_revoked_at is null then
    update public.social_mobile_account_deletions set apple_revoked_at = now(), updated_at = now() where user_id = p_user_id;
    perform public.social_mobile_account_deletion_record(p_user_id, 'apple_revoked', null);
  end if;
  return jsonb_build_object('status', 'apple_revoked');
end;
$$;

-- Step 3: purge the bound workspace. Re-verifies everything; any change or
-- unexpected dependent row stops (operator_required / abort).
create function public.social_mobile_account_deletion_purge(p_user_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
  v_workspace text;
  v_blocker text;
  v_accounts text[];
  v_secrets uuid[];
  v_current jsonb := '[]'::jsonb;
  v_account jsonb;
begin
  v_row := public.social_mobile_account_deletion_hold(p_user_id, p_lease);
  if v_row.state = 'purged' then
    return jsonb_build_object('status', 'purged');
  end if;
  if v_row.state <> 'x_revoked' then
    return jsonb_build_object('status', 'not_ready', 'state', v_row.state);
  end if;
  if v_row.apple_required and v_row.apple_revoked_at is null then
    return jsonb_build_object('status', 'apple_revoke_required');
  end if;
  v_workspace := v_row.workspace_id;
  if exists (select 1 from public.brands where id = v_workspace) then
    v_blocker := public.social_mobile_account_deletion_blocker(p_user_id, v_workspace);
    if v_blocker is not null then
      return public.social_mobile_account_deletion_to_operator(p_user_id, v_blocker);
    end if;
  end if;
  if public.social_mobile_account_deletion_credential_set(v_workspace) <> v_row.credential_set then
    return public.social_mobile_account_deletion_to_operator(p_user_id, 'CREDENTIALS_CHANGED');
  end if;
  for v_account in select * from jsonb_array_elements(coalesce(v_row.revoked_fingerprints, '[]'::jsonb)) loop
    v_current := v_current || jsonb_build_object('id', v_account ->> 'id',
      'access_sha256', public.social_mobile_account_deletion_fingerprint(
        (select a.vault_access_token_secret_id from public.social_accounts a where a.id = v_account ->> 'id')),
      'refresh_sha256', public.social_mobile_account_deletion_fingerprint(
        (select a.vault_refresh_token_secret_id from public.social_accounts a where a.id = v_account ->> 'id')));
  end loop;
  if v_current <> coalesce(v_row.revoked_fingerprints, '[]'::jsonb) then
    return public.social_mobile_account_deletion_to_operator(p_user_id, 'CREDENTIALS_CHANGED');
  end if;

  select coalesce(array_agg(id order by id), '{}') into v_accounts from public.social_accounts where brand_id = v_workspace;
  select coalesce(array_agg(distinct secret_id), '{}') into v_secrets from (
    select vault_access_token_secret_id as secret_id from public.social_accounts where brand_id = v_workspace
    union all select vault_refresh_token_secret_id from public.social_accounts where brand_id = v_workspace
    union all select code_verifier_vault_secret_id from public.social_account_oauth_states where brand_id = v_workspace
  ) s where secret_id is not null;
  begin
    delete from public.x_account_refresh_state_v2 where social_account_id = any (v_accounts);
    delete from public.x_account_refresh_rollout where social_account_id = any (v_accounts);
    delete from public.social_account_oauth_states where brand_id = v_workspace or social_account_id = any (v_accounts);
    delete from public.published_content_fingerprints where brand_id = v_workspace or social_account_id = any (v_accounts);
    delete from public.publish_claims where brand_id = v_workspace;
    delete from public.post_execution_logs where brand_id = v_workspace;
    delete from public.posting_windows where brand_id = v_workspace;
    delete from public.scheduled_posts where brand_id = v_workspace;
    delete from public.social_accounts where brand_id = v_workspace;
    delete from vault.secrets where id = any (v_secrets);
    -- Cascades brand_memberships and daily_content_plans; any other reference fails.
    delete from public.brands where id = v_workspace;
  exception when foreign_key_violation then
    raise exception 'SOCIAL_MOBILE_DELETION_UNEXPECTED_DEPENDENT_DATA';
  end;
  update public.social_mobile_account_deletions set state = 'purged', updated_at = now() where user_id = p_user_id;
  perform public.social_mobile_account_deletion_record(p_user_id, 'purged', null);
  return jsonb_build_object('status', 'purged');
end;
$$;

-- Step 4: finish. The login is deleted only for scope social_and_login and
-- only when no Kabumori main-app data exists, checked with the auth row
-- locked in this same transaction (no hidden cascade). The tombstone is
-- removed in the same transaction.
create function public.social_mobile_account_deletion_finalize(p_user_id uuid, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
  v_login_deleted boolean := false;
  v_reason text := null;
begin
  v_row := public.social_mobile_account_deletion_hold(p_user_id, p_lease);
  if v_row.state <> 'purged' then
    return jsonb_build_object('status', 'not_ready', 'state', v_row.state);
  end if;
  perform 1 from auth.users where id = p_user_id for update;
  -- Orphan invariant, under the workspace and auth locks: nothing of the
  -- workspace may exist when deletion is reported complete.
  if exists (select 1 from public.brands where id = v_row.workspace_id)
     or exists (select 1 from public.brand_memberships where brand_id = v_row.workspace_id)
     or exists (select 1 from public.social_accounts where brand_id = v_row.workspace_id)
     or exists (select 1 from public.social_account_oauth_states where brand_id = v_row.workspace_id) then
    return public.social_mobile_account_deletion_to_operator(p_user_id, 'WORKSPACE_REAPPEARED');
  end if;
  if v_row.scope = 'social_and_login' then
    if exists (select 1 from public.profiles where id = p_user_id) then
      v_reason := 'MAIN_APP_ACCOUNT_PRESENT';
    else
      begin
        delete from auth.users where id = p_user_id;
        v_login_deleted := true;
      exception when foreign_key_violation then
        return public.social_mobile_account_deletion_to_operator(p_user_id, 'LOGIN_DELETE_BLOCKED');
      end;
    end if;
  end if;
  delete from public.social_mobile_account_deletions where user_id = p_user_id;
  perform public.social_mobile_account_deletion_record(p_user_id, case when v_login_deleted then 'completed' else 'completed_social_only' end, v_reason);
  return jsonb_build_object('status', 'completed', 'login_deleted', v_login_deleted, 'reason', v_reason);
end;
$$;

-- Operator recovery (service_role; never called by the Edge Function):
--   retry                 : the underlying data was fixed; resume where it stopped
--   x_revoked_out_of_band : the X grant was revoked outside the app; accept the
--                           current material as revoked (only from 'started')
--   cancel                : stop before purge; posting stays disabled
create function public.social_mobile_account_deletion_operator_resolve(p_user_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.social_mobile_account_deletions;
  v_expected jsonb := '[]'::jsonb;
  v_account jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('social_mobile_account_deletion:' || p_user_id::text, 0));
  perform public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace(p_user_id));
  select * into v_row from public.social_mobile_account_deletions where user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_action = 'retry' and v_row.state = 'operator_required' then
    update public.social_mobile_account_deletions
       set state = resume_state, resume_state = null, operator_reason = null,
           credential_set = case when resume_state = 'started'
             then public.social_mobile_account_deletion_credential_set(workspace_id) else credential_set end,
           updated_at = now()
     where user_id = p_user_id;
  elsif p_action = 'x_revoked_out_of_band' and (v_row.state = 'started' or (v_row.state = 'operator_required' and v_row.resume_state = 'started')) then
    for v_account in select * from jsonb_array_elements(public.social_mobile_account_deletion_credential_set(v_row.workspace_id) -> 'accounts') loop
      v_expected := v_expected || jsonb_build_object('id', v_account ->> 'id',
        'access_sha256', public.social_mobile_account_deletion_fingerprint((v_account ->> 'access')::uuid),
        'refresh_sha256', public.social_mobile_account_deletion_fingerprint((v_account ->> 'refresh')::uuid));
    end loop;
    update public.social_mobile_account_deletions
       set state = 'x_revoked', resume_state = null, operator_reason = null,
           credential_set = public.social_mobile_account_deletion_credential_set(workspace_id),
           revoked_fingerprints = (select coalesce(jsonb_agg(e order by e ->> 'id'), '[]'::jsonb) from jsonb_array_elements(v_expected) e),
           lease_token = null, lease_expires_at = null, updated_at = now()
     where user_id = p_user_id;
  elsif p_action = 'cancel' and (v_row.state = 'started' or (v_row.state = 'operator_required' and v_row.resume_state = 'started')) then
    delete from public.social_mobile_account_deletions where user_id = p_user_id;
  else
    return jsonb_build_object('status', 'refused');
  end if;
  perform public.social_mobile_account_deletion_record(p_user_id, 'operator_resolved', upper(p_action));
  return jsonb_build_object('status', 'resolved');
end;
$$;

revoke all on function public.social_mobile_account_deletion_subject(uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_workspace(uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_workspace_lock(text) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_guard() from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_credential_set(text) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_ownership_problem(text) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_blocker(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_scope(uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_hold(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_to_operator(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_fingerprint(uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_record(uuid, text, text) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_preview(uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_acquire(uuid, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_release(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_credentials(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_mark_x_revoked(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_mark_apple_revoked(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_purge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_finalize(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_operator_resolve(uuid, text) from public, anon, authenticated;
grant execute on function public.social_mobile_account_deletion_record(uuid, text, text) to service_role;
grant execute on function public.social_mobile_account_deletion_preview(uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_acquire(uuid, text, boolean, integer) to service_role;
grant execute on function public.social_mobile_account_deletion_release(uuid, uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_credentials(uuid, uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_mark_x_revoked(uuid, uuid, jsonb) to service_role;
grant execute on function public.social_mobile_account_deletion_mark_apple_revoked(uuid, uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_purge(uuid, uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_finalize(uuid, uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_operator_resolve(uuid, text) to service_role;
