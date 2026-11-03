-- G4 SOURCE CANDIDATE ROLLBACK (2026-10-25, Issue #319 G4-39) for 001_x_oauth_personal_epoch.sql. NOT applied anywhere but a disposable PG17.
-- Puts the two public X OAuth bodies back BYTE FOR BYTE (copied verbatim from main 0c42933c: begin = 20260922003101 L4-L75,
-- complete = 20260919120000 L203-L288; CREATE OR REPLACE keeps OID, owner and ACL), then drops the G4 schema (connections,
-- state_bindings, disconnect, the epoch reader, the CAS store). Refuses unless the candidate is what is installed.
-- Kept on purpose: oauth state rows begun under the candidate (they then complete under the original rules, as before the candidate),
-- the workspace / membership rows begin created, tokens. Any consumer already wired to x_connection_epoch / store_refreshed_x_tokens must be
-- unwired FIRST (this rollback refuses while another function's body names the G4 schema, in any letter case, or while the
-- catalog records anything outside the schema depending on it; G4-45 / H1 F1: no DROP ... CASCADE any more).
begin;

set local lock_timeout = '5s';

do $$
declare
  v_ns oid := to_regnamespace('postona_g4_x_oauth');
begin
  if v_ns is null then
    raise exception 'G4X_ROLLBACK_NOT_APPLIED';
  end if;
  if (select md5(p.prosrc) from pg_proc p
        where p.oid = to_regprocedure('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'))
     is distinct from '7f605c3ca7a69b4d7f58d0d7fa82fb0f' then
    raise exception 'G4X_ROLLBACK_BEGIN_BODY_UNEXPECTED';
  end if;
  if (select md5(p.prosrc) from pg_proc p
        where p.oid = to_regprocedure('public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'))
     is distinct from '3ea5686f26e8de515d902cd408ef5275' then
    raise exception 'G4X_ROLLBACK_COMPLETE_BODY_UNEXPECTED';
  end if;
  -- G4-45 (H1 F1): unquoted identifiers are case-insensitive, so the body check is too (POSTONA_G4_X_OAUTH.X_... is a caller).
  -- Function bodies run as text (PL/pgSQL, plain SQL) are not in pg_depend; a name built by dynamic SQL is not found here
  -- either, so consumers are still to be removed before this rollback (an operating precondition, not something proven).
  if exists (select 1 from pg_proc p
               where p.pronamespace <> v_ns
                 and p.oid not in (to_regprocedure('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'),
                                   to_regprocedure('public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'))
                 and p.prosrc ilike '%postona_g4_x_oauth%') then
    raise exception 'G4X_ROLLBACK_STILL_REFERENCED';
  end if;
  -- G4-45 (H1 F1): whatever the catalog records as depending on an object of this schema from OUTSIDE it (a view or
  -- materialized view, a SQL-standard function body, a default, a constraint, a trigger, a policy, ...) refuses the
  -- rollback. Nothing outside the schema is ever dropped (no CASCADE below). A dependent of a kind not listed here counts
  -- as outside.
  if exists (
    select 1 from pg_depend d
    where d.deptype in ('n', 'a')
      and ((d.refclassid = 'pg_class'::regclass and d.refobjid in (select c.oid from pg_class c where c.relnamespace = v_ns))
        or (d.refclassid = 'pg_proc'::regclass and d.refobjid in (select p.oid from pg_proc p where p.pronamespace = v_ns))
        or (d.refclassid = 'pg_type'::regclass and d.refobjid in (select t.oid from pg_type t where t.typnamespace = v_ns))
        or (d.refclassid = 'pg_namespace'::regclass and d.refobjid = v_ns))
      and coalesce(case d.classid
            when 'pg_class'::regclass then (select c.relnamespace from pg_class c where c.oid = d.objid)
            when 'pg_proc'::regclass then (select p.pronamespace from pg_proc p where p.oid = d.objid)
            when 'pg_type'::regclass then (select t.typnamespace from pg_type t where t.oid = d.objid)
            when 'pg_constraint'::regclass then (select k.connamespace from pg_constraint k where k.oid = d.objid)
            when 'pg_attrdef'::regclass then
              (select c.relnamespace from pg_attrdef a join pg_class c on c.oid = a.adrelid where a.oid = d.objid)
            when 'pg_rewrite'::regclass then
              (select c.relnamespace from pg_rewrite r join pg_class c on c.oid = r.ev_class where r.oid = d.objid)
            when 'pg_trigger'::regclass then
              (select c.relnamespace from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.oid = d.objid)
          end, 0::oid) <> v_ns) then
    raise exception 'G4X_ROLLBACK_DEPENDED_ON';
  end if;
end $$;

-- begin: main 0c42933c supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql L4-L75, verbatim
create or replace function public.begin_social_mobile_x_oauth_connection(
  p_state_hash text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns table (brand_id text, social_account_id text)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_brand_id text;
  v_owner_brand_count int;
  v_social_account_id text;
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if p_state_hash !~ '^[0-9a-f]{64}$' or p_expires_at <= now() then
    raise exception 'OAUTH_STATE_INPUT_INVALID';
  end if;

  select count(*) into v_owner_brand_count
  from public.brand_memberships bm
  where bm.user_id = v_user_id and bm.role = 'owner';
  if v_owner_brand_count > 1 then
    raise exception 'SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED';
  end if;

  if v_owner_brand_count = 1 then
    select bm.brand_id into v_brand_id
    from public.brand_memberships bm
    where bm.user_id = v_user_id and bm.role = 'owner';
  else
    v_brand_id := 'u_' || substr(md5(v_user_id::text), 1, 24);
    insert into public.brands (id, display_name, is_active, publish_mode, code_profile_key)
    values (v_brand_id, 'My Workspace', false, 'disabled', 'social_mobile_user_v1')
    on conflict (id) do nothing;
    insert into public.brand_memberships (brand_id, user_id, role)
    values (v_brand_id, v_user_id, 'owner')
    on conflict on constraint brand_memberships_pkey do nothing;
  end if;

  select sa.id into v_social_account_id
  from public.social_accounts sa
  where sa.brand_id = v_brand_id and sa.platform = 'x';
  if v_social_account_id is null then
    v_social_account_id := 'sa_' || substr(md5(v_brand_id || ':x'), 1, 24);
    insert into public.social_accounts
      (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status)
    values (v_social_account_id, v_brand_id, 'x', 'pending', false, 'default', 'authorization_pending');
  else
    -- A reconnect may refresh the OAuth state, but must not demote a verified
    -- identity before the callback succeeds or fails.
    update public.social_accounts
    set connection_status = case
          when connection_status = 'identity_verified' then 'identity_verified'
          else 'authorization_pending'
        end,
        last_connection_error_code = null,
        updated_at = now()
    where id = v_social_account_id;
  end if;

  insert into public.social_account_oauth_states
    (social_account_id, brand_id, state_hash, code_verifier_vault_secret_id, redirect_uri, expires_at, initiated_by_user_id)
  values (v_social_account_id, v_brand_id, p_state_hash, null, p_redirect_uri, p_expires_at, v_user_id);

  return query select v_brand_id, v_social_account_id;
end;
$$;

-- complete: main 0c42933c supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql L203-L288, verbatim
create or replace function public.complete_social_mobile_x_oauth_connection(
  p_oauth_state_id uuid,
  p_platform_user_id text,
  p_handle text,
  p_access_token text,
  p_refresh_token text
)
returns void
language plpgsql
security definer
set search_path = 'public', 'vault'
as $$
declare
  v_user_id uuid := auth.uid();
  v_social_account_id text;
  v_account public.social_accounts%rowtype;
  v_handle text := lower(regexp_replace(trim(p_handle), '^@', ''));
begin
  if v_user_id is null then
    raise exception 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED';
  end if;
  if p_access_token = '' or p_refresh_token = '' or p_platform_user_id = '' then
    raise exception 'OAUTH_TOKEN_OR_IDENTITY_INVALID';
  end if;

  -- The one atomic, irreversible claim: only succeeds if this exact state row belongs to the caller,
  -- was not already claimed by an earlier (successful or concurrently in-flight) completion, and has not
  -- expired. This single UPDATE is what makes replay and concurrent-duplicate-completion both fail.
  update public.social_account_oauth_states
  set consumed_at = now()
  where id = p_oauth_state_id
    and initiated_by_user_id = v_user_id
    and consumed_at is null
    and expires_at > now()
  returning social_account_id into v_social_account_id;
  if v_social_account_id is null then
    raise exception 'OAUTH_STATE_NOT_CONSUMABLE';
  end if;

  select sa.* into v_account
  from public.social_accounts sa
  join public.brand_memberships bm on bm.brand_id = sa.brand_id
  where sa.id = v_social_account_id and bm.user_id = v_user_id and bm.role = 'owner'
  for update of sa;
  if not found then
    raise exception 'SOCIAL_MOBILE_ACCOUNT_NOT_OWNED';
  end if;
  if v_account.platform_user_id is not null and v_account.platform_user_id <> p_platform_user_id then
    raise exception 'X_IDENTITY_ACCOUNT_MISMATCH';
  end if;

  if v_account.vault_access_token_secret_id is null then
    v_account.vault_access_token_secret_id := vault.create_secret(p_access_token, v_social_account_id || '_access_token', 'OAuth access token.');
  else
    perform vault.update_secret(v_account.vault_access_token_secret_id, p_access_token);
  end if;
  if v_account.vault_refresh_token_secret_id is null then
    v_account.vault_refresh_token_secret_id := vault.create_secret(p_refresh_token, v_social_account_id || '_refresh_token', 'OAuth refresh token.');
  else
    perform vault.update_secret(v_account.vault_refresh_token_secret_id, p_refresh_token);
  end if;

  -- The partial unique index from step 1 makes this UPDATE raise a real unique_violation (caught below)
  -- if p_platform_user_id is already bound to a different social_accounts row -- fail-closed, atomic,
  -- not a separate check-then-act SELECT that a race could slip past.
  update public.social_accounts set
    vault_access_token_secret_id = v_account.vault_access_token_secret_id,
    vault_refresh_token_secret_id = v_account.vault_refresh_token_secret_id,
    platform_user_id = p_platform_user_id,
    handle = v_handle,
    -- publish_enabled is never set true by OAuth success alone -- an explicit, separate, later action is
    -- required before this account can ever be posted to.
    publish_enabled = false,
    connection_status = 'identity_verified',
    verified_at = now(),
    last_connection_error_code = null,
    updated_at = now()
  where id = v_social_account_id;
exception
  when unique_violation then
    update public.social_accounts
    set connection_status = 'failed', last_connection_error_code = 'X_ACCOUNT_ALREADY_CONNECTED', updated_at = now()
    where id = v_social_account_id;
    raise exception 'X_ACCOUNT_ALREADY_CONNECTED';
end;
$$;

-- G4-45 (H1 F1): 001's own objects, each by name and RESTRICT (the default), then the schema RESTRICT: anything else found in
-- it, or depending on it, makes this whole transaction fail with nothing dropped (no CASCADE).
drop function postona_g4_x_oauth.disconnect_x_connection();
drop function postona_g4_x_oauth.store_refreshed_x_tokens(text, bigint, text, text);
drop function postona_g4_x_oauth.x_connection_epoch(text);
drop function postona_g4_x_oauth.require_owner_epoch(text);
drop function postona_g4_x_oauth.require_person(uuid);
drop function postona_g4_x_oauth.lock_workspace(text);
drop table postona_g4_x_oauth.state_bindings;
drop table postona_g4_x_oauth.connections;
drop schema postona_g4_x_oauth restrict;

do $$
begin
  if (select md5(p.prosrc) from pg_proc p
        where p.oid = to_regprocedure('public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)'))
     is distinct from '7679362b9022b88a2b6a5ef6b0d58f37'
     or (select md5(p.prosrc) from pg_proc p
        where p.oid = to_regprocedure('public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)'))
     is distinct from 'ca070453f79a7ef8713264e72c756af3' then
    raise exception 'G4X_ROLLBACK_POSTCONDITION_BODY';
  end if;
  if to_regnamespace('postona_g4_x_oauth') is not null then
    raise exception 'G4X_ROLLBACK_POSTCONDITION_SCHEMA';
  end if;
end $$;

commit;
