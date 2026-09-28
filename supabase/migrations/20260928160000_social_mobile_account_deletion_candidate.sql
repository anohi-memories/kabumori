-- SOURCE CANDIDATE ONLY. NOT applied to production. Independent review is
-- mandatory before any apply; apply as a single reviewed file (never db push).
--
-- Social-mobile self-service account deletion: the privileged data boundary.
-- Called only by the Edge Function `social-mobile-account-delete` with the
-- service role, always with the user id the function verified from the
-- caller's own JWT. No client role can execute anything here.
--
-- Production shape this relies on (read-only catalog inspection 2026-09-28):
--   * brand_memberships(brand_id -> brands ON DELETE CASCADE, user_id ->
--     auth.users ON DELETE CASCADE, role owner/admin/member/viewer)
--   * every other reference to brands / social_accounts / scheduled_posts is
--     NO ACTION (only daily_content_plans cascades from brands).
--   * the social-mobile workspace id is derived from the user id:
--     'u_' || substr(md5(user_id), 1, 24), code_profile_key 'social_mobile_user_v1'.
--
-- Steps (each idempotent, serialized per user by an advisory lock):
--   1. begin:       exact-user checks, then disable posting authority.
--   2. credentials: X tokens of that workspace only, only after step 1, so the
--                   Edge Function can revoke them at X.
--   3. purge:       delete the workspace and its data in FK order, then its
--                   Vault secrets, then the workspace. Any unexpected
--                   dependent row aborts the whole purge (fail closed).
-- The Edge Function deletes the auth user last; brand_memberships and
-- social_account_oauth_states rows keyed to the user cascade from auth.users.
--
-- Never deleted here: another user's workspace or data, a shared workspace,
-- any workspace other than the user's own derived one, operator/admin accounts.

do $$
begin
  if to_regclass('public.social_mobile_account_deletion_audit') is not null then
    raise exception 'SOCIAL_MOBILE_DELETION_CANDIDATE_ALREADY_APPLIED';
  end if;
  if to_regclass('public.brand_memberships') is null or to_regclass('public.admin_users') is null then
    raise exception 'SOCIAL_MOBILE_DELETION_PREREQUISITE_MISSING';
  end if;
end;
$$;

-- Outcome log without personal data: a SHA-256 of the user id, a fixed step
-- and an optional fixed reason code. No e-mail, handle, token or free text.
create table public.social_mobile_account_deletion_audit (
  id bigint generated always as identity primary key,
  subject_sha256 text not null check (subject_sha256 ~ '^[0-9a-f]{64}$'),
  step text not null check (step in ('requested', 'blocked', 'posting_disabled', 'credentials_revoked', 'data_purged', 'auth_user_deleted', 'failed')),
  reason_code text check (reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz not null default now()
);
alter table public.social_mobile_account_deletion_audit enable row level security;
revoke all on table public.social_mobile_account_deletion_audit from public, anon, authenticated, service_role;

create function public.social_mobile_account_deletion_subject(p_user_id uuid)
returns text language sql immutable set search_path = ''
as $$ select encode(pg_catalog.sha256(convert_to(p_user_id::text, 'UTF8')), 'hex') $$;

create function public.social_mobile_account_deletion_workspace(p_user_id uuid)
returns text language sql immutable set search_path = ''
as $$ select 'u_' || substr(md5(p_user_id::text), 1, 24) $$;

create function public.social_mobile_account_deletion_record(p_user_id uuid, p_step text, p_reason_code text default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_user_id is null then raise exception 'SOCIAL_MOBILE_DELETION_USER_REQUIRED'; end if;
  insert into public.social_mobile_account_deletion_audit (subject_sha256, step, reason_code)
  values (public.social_mobile_account_deletion_subject(p_user_id), p_step, p_reason_code);
end;
$$;

-- Shared exact-user checks. Returns null when the user may proceed, or a
-- fixed reason code. Locks the user's derived workspace row when it exists.
create function public.social_mobile_account_deletion_blocker(p_user_id uuid, p_workspace text)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  v_profile text;
begin
  if exists (select 1 from public.admin_users where user_id = p_user_id) then
    return 'ADMIN_ACCOUNT';
  end if;
  -- Owning anything but the user's own derived workspace is operator work.
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
  if exists (select 1 from public.brand_memberships where brand_id = p_workspace and user_id = p_user_id and role <> 'owner') then
    return 'WORKSPACE_ROLE_MISMATCH';
  end if;
  perform 1 from public.social_accounts where brand_id = p_workspace for update;
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
  return null;
end;
$$;

-- Step 1: exact-user checks, then posting authority is switched off before
-- anything destructive. Pending posts become failed so no dispatcher picks them.
create function public.social_mobile_account_deletion_begin(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_workspace text;
  v_blocker text;
  v_accounts integer;
begin
  if p_user_id is null then raise exception 'SOCIAL_MOBILE_DELETION_USER_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('social_mobile_account_deletion:' || p_user_id::text, 0));
  v_workspace := public.social_mobile_account_deletion_workspace(p_user_id);
  v_blocker := public.social_mobile_account_deletion_blocker(p_user_id, v_workspace);
  if v_blocker is not null then
    perform public.social_mobile_account_deletion_record(p_user_id, 'blocked', v_blocker);
    return jsonb_build_object('status', 'blocked', 'reason', v_blocker);
  end if;
  if not exists (select 1 from public.brands where id = v_workspace) then
    perform public.social_mobile_account_deletion_record(p_user_id, 'posting_disabled', 'NO_WORKSPACE');
    return jsonb_build_object('status', 'ready', 'workspace', false, 'x_accounts', 0);
  end if;
  update public.brands set is_active = false, publish_mode = 'disabled', updated_at = now() where id = v_workspace;
  update public.social_accounts set publish_enabled = false, updated_at = now() where brand_id = v_workspace;
  update public.x_account_refresh_rollout
     set mode = 'off', pilot_expires_at = null, pilot_max_generation = null, reason_code = 'ACCOUNT_DELETION', updated_at = now()
   where social_account_id in (select id from public.social_accounts where brand_id = v_workspace);
  update public.scheduled_posts set status = 'failed', finished_at = now() where brand_id = v_workspace and status = 'pending';
  select count(*) into v_accounts from public.social_accounts where brand_id = v_workspace;
  perform public.social_mobile_account_deletion_record(p_user_id, 'posting_disabled', null);
  return jsonb_build_object('status', 'ready', 'workspace', true, 'x_accounts', v_accounts);
end;
$$;

-- Step 2: the X tokens of the user's own workspace only, and only after step 1.
create function public.social_mobile_account_deletion_credentials(p_user_id uuid)
returns table (social_account_id text, access_token text, refresh_token text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_workspace text;
  v_active boolean;
  v_mode text;
begin
  if p_user_id is null then raise exception 'SOCIAL_MOBILE_DELETION_USER_REQUIRED'; end if;
  v_workspace := public.social_mobile_account_deletion_workspace(p_user_id);
  select is_active, publish_mode into v_active, v_mode from public.brands where id = v_workspace;
  if not found then return; end if;
  if v_active or v_mode <> 'disabled' then raise exception 'SOCIAL_MOBILE_DELETION_NOT_STARTED'; end if;
  return query
    select a.id,
           (select d.decrypted_secret from vault.decrypted_secrets d where d.id = a.vault_access_token_secret_id),
           (select d.decrypted_secret from vault.decrypted_secrets d where d.id = a.vault_refresh_token_secret_id)
      from public.social_accounts a
     where a.brand_id = v_workspace
     order by a.id;
end;
$$;

-- Step 3: purge the user's own workspace. Re-checks everything; any row of a
-- table not handled here that still references the workspace aborts the purge.
create function public.social_mobile_account_deletion_purge(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_workspace text;
  v_blocker text;
  v_active boolean;
  v_mode text;
  v_accounts text[];
  v_secrets uuid[];
begin
  if p_user_id is null then raise exception 'SOCIAL_MOBILE_DELETION_USER_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('social_mobile_account_deletion:' || p_user_id::text, 0));
  v_workspace := public.social_mobile_account_deletion_workspace(p_user_id);
  v_blocker := public.social_mobile_account_deletion_blocker(p_user_id, v_workspace);
  if v_blocker is not null then raise exception 'SOCIAL_MOBILE_DELETION_BLOCKED_%', v_blocker; end if;
  select is_active, publish_mode into v_active, v_mode from public.brands where id = v_workspace;
  if not found then
    perform public.social_mobile_account_deletion_record(p_user_id, 'data_purged', 'NO_WORKSPACE');
    return jsonb_build_object('status', 'nothing_to_purge');
  end if;
  if v_active or v_mode <> 'disabled' then raise exception 'SOCIAL_MOBILE_DELETION_NOT_STARTED'; end if;

  select coalesce(array_agg(id order by id), '{}') into v_accounts from public.social_accounts where brand_id = v_workspace;
  select coalesce(array_agg(distinct secret_id), '{}') into v_secrets from (
    select vault_access_token_secret_id as secret_id from public.social_accounts where brand_id = v_workspace
    union all select vault_refresh_token_secret_id from public.social_accounts where brand_id = v_workspace
    union all select code_verifier_vault_secret_id from public.social_account_oauth_states
               where brand_id = v_workspace or social_account_id = any (v_accounts)
    union all select leased_access_secret_id from public.x_account_refresh_state_v2 where social_account_id = any (v_accounts)
    union all select leased_refresh_secret_id from public.x_account_refresh_state_v2 where social_account_id = any (v_accounts)
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
  perform public.social_mobile_account_deletion_record(p_user_id, 'data_purged', null);
  return jsonb_build_object('status', 'purged', 'x_accounts', coalesce(array_length(v_accounts, 1), 0), 'vault_secrets', coalesce(array_length(v_secrets, 1), 0));
end;
$$;

revoke all on function public.social_mobile_account_deletion_subject(uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_workspace(uuid) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_blocker(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.social_mobile_account_deletion_record(uuid, text, text) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_begin(uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_credentials(uuid) from public, anon, authenticated;
revoke all on function public.social_mobile_account_deletion_purge(uuid) from public, anon, authenticated;
grant execute on function public.social_mobile_account_deletion_record(uuid, text, text) to service_role;
grant execute on function public.social_mobile_account_deletion_begin(uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_credentials(uuid) to service_role;
grant execute on function public.social_mobile_account_deletion_purge(uuid) to service_role;
