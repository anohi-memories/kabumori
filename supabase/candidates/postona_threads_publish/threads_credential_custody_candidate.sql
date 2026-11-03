-- SOURCE CANDIDATE ONLY. NOT a migration, NOT applied anywhere (G4,
-- postona-threads-connect-publish-integrated-offline-v1-g4-20261011).
--
-- POSTONA Threads: an ACCOUNT-scoped record of the long-lived token's expiry, bound to the exact
-- credential that a verified connection stored, and the reader the publish candidate requires
-- (public.threads_account_credential_expires_at(text), see threads_manual_publish_candidate.sql).
--
-- Why: H5's runtime (Draft PR #139) records `token_expires_at` per OAuth ATTEMPT, and PR #124's complete
-- stores the token in Vault without any expiry. Publishing must not rely on an attempt row (an old
-- attempt says nothing about the token stored now) nor assume a 60-day default.
--
-- Apply order: after Phase 2a-2 and PR #124's candidate, BEFORE threads_manual_publish_candidate.sql
-- (whose precondition is the reader below).
--
-- Objects:
--   TABLE public.threads_account_credential_custody   one row per Threads account: which Vault secret the
--                                                      expiry is about, the expiry, when and by whom
--   public.record_threads_credential_custody(account, expires_at)   owner-only writer (SECURITY INVOKER,
--       no API grant). Accepts ONLY in the transaction that just completed the verified connection:
--       the account is a verified Threads account of the caller's own workspace whose verified_at equals
--       this transaction's start time (PR #124's complete sets verified_at = now()). The expiry must be in
--       (now, now + 61 days]; it is the provider's `expires_in` from the long-lived exchange, computed by
--       the server, never a client value. H5's owner transaction calls it right after complete():
--         select public.complete_social_mobile_threads_oauth_connection(...);
--         select public.record_threads_credential_custody($social_account_id, $expires_at);
--         select postona_threads_runtime.outcome(..., 'complete', $expires_at);
--   public.threads_account_credential_expires_at(account)   owner-only reader (SECURITY DEFINER, no API
--       grant). Returns the expiry only while it still describes the stored credential: same Vault secret
--       id, account still verified, and the custody row recorded no earlier than the account's latest
--       verification (a reconnect that updated the secret in place without a new custody row reads NULL).
--       NULL = unknown = expired for every caller.
--
-- Deletion (T10): the row cascades with its social account. It holds no secret material.
begin;

set local lock_timeout = '5s';
set local search_path = '';

do $$
declare
  v_owner oid;
begin
  if pg_catalog.to_regclass('public.social_accounts') is null or pg_catalog.to_regclass('public.brand_memberships') is null
     or pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception 'THREADS_CUSTODY_PRECONDITION_MISSING';
  end if;
  if pg_catalog.to_regclass('public.threads_account_credential_custody') is not null
     or pg_catalog.to_regprocedure('public.threads_account_credential_expires_at(text)') is not null then
    raise exception 'THREADS_CUSTODY_PRECONDITION_ALREADY_APPLIED';
  end if;
  select c.relowner into v_owner from pg_catalog.pg_class c where c.oid = 'public.social_accounts'::regclass;
  if v_owner is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user)
     or (select r.rolsuper from pg_catalog.pg_roles r where r.oid = v_owner) is distinct from false then
    raise exception 'THREADS_CUSTODY_PRECONDITION_OWNER';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c
                 where c.conrelid = 'public.social_accounts'::regclass and c.conname = 'social_accounts_provider_credential_profile') then
    raise exception 'THREADS_CUSTODY_PRECONDITION_2A2';
  end if;
end $$;

create table public.threads_account_credential_custody (
  social_account_id text primary key references public.social_accounts (id) on delete cascade,
  vault_secret_id uuid not null,
  expires_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null
);
alter table public.threads_account_credential_custody enable row level security;
revoke all on table public.threads_account_credential_custody from public, anon, authenticated, service_role;

create function public.record_threads_credential_custody(p_social_account_id text, p_expires_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_account public.social_accounts%rowtype;
begin
  if v_user is null then raise exception 'THREADS_CUSTODY_AUTH_REQUIRED' using errcode = 'P0001'; end if;
  if p_expires_at is null or p_expires_at <= pg_catalog.clock_timestamp()
     or p_expires_at > pg_catalog.clock_timestamp() + interval '61 days' then
    raise exception 'THREADS_CUSTODY_EXPIRY_INVALID' using errcode = 'P0001';
  end if;
  select a.* into v_account from public.social_accounts a where a.id = p_social_account_id for update;
  if v_account.id is null or v_account.platform is distinct from 'threads'
     or v_account.connection_status is distinct from 'identity_verified' or v_account.vault_access_token_secret_id is null
     or not exists (select 1 from public.brand_memberships m
                    where m.brand_id = v_account.brand_id and m.user_id = v_user and m.role = 'owner') then
    raise exception 'THREADS_CUSTODY_ACCOUNT_INVALID' using errcode = 'P0001';
  end if;
  -- Only in the very transaction that verified this connection (and stored this credential).
  if v_account.verified_at is distinct from pg_catalog.now() then
    raise exception 'THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION' using errcode = 'P0001';
  end if;
  insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_at, recorded_by)
  values (v_account.id, v_account.vault_access_token_secret_id, p_expires_at, pg_catalog.now(), v_user)
  on conflict (social_account_id) do update
    set vault_secret_id = excluded.vault_secret_id, expires_at = excluded.expires_at,
        recorded_at = excluded.recorded_at, recorded_by = excluded.recorded_by;
end;
$$;

create function public.threads_account_credential_expires_at(p_social_account_id text)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select c.expires_at
  from public.threads_account_credential_custody c
  join public.social_accounts a on a.id = c.social_account_id
  where c.social_account_id = p_social_account_id
    and a.platform = 'threads'
    and a.connection_status = 'identity_verified'
    and a.vault_access_token_secret_id = c.vault_secret_id
    and a.verified_at is not null
    and c.recorded_at >= a.verified_at
$$;

revoke all on function public.record_threads_credential_custody(text, timestamptz),
                       public.threads_account_credential_expires_at(text)
  from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from (values ('anon'::name), ('authenticated'::name), ('service_role'::name)) a(app)
             where pg_catalog.has_table_privilege(a.app, 'public.threads_account_credential_custody', 'SELECT')
                or pg_catalog.has_table_privilege(a.app, 'public.threads_account_credential_custody', 'INSERT')
                or pg_catalog.has_table_privilege(a.app, 'public.threads_account_credential_custody', 'UPDATE')
                or pg_catalog.has_function_privilege(a.app, 'public.record_threads_credential_custody(text,timestamptz)', 'EXECUTE')
                or pg_catalog.has_function_privilege(a.app, 'public.threads_account_credential_expires_at(text)', 'EXECUTE')) then
    raise exception 'THREADS_CUSTODY_POSTCONDITION_ACL';
  end if;
end $$;

commit;
