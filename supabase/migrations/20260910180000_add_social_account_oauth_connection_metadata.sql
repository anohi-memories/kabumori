-- Phase 3B expand-only OAuth/Vault connection metadata.
-- Secret bodies stay exclusively in vault.secrets; these UUIDs are opaque refs.
alter table public.social_accounts
  add column if not exists vault_access_token_secret_id uuid,
  add column if not exists vault_refresh_token_secret_id uuid,
  add column if not exists connection_status text not null default 'unconnected'
    check (connection_status in ('unconnected', 'authorization_pending', 'connected', 'identity_verified', 'failed')),
  add column if not exists verified_at timestamptz,
  add column if not exists last_connection_error_code text;

create table if not exists public.social_account_oauth_states (
  id uuid primary key default gen_random_uuid(),
  social_account_id text not null references public.social_accounts(id),
  brand_id text not null references public.brands(id),
  state_hash text not null unique,
  code_verifier_vault_secret_id uuid,
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists social_account_oauth_states_active_idx
  on public.social_account_oauth_states (social_account_id, expires_at)
  where consumed_at is null;

alter table public.social_account_oauth_states enable row level security;
revoke all on public.social_account_oauth_states from anon, authenticated;
grant select, insert, update on public.social_account_oauth_states to service_role;

comment on column public.social_accounts.vault_access_token_secret_id is
  'Opaque vault.secrets id only; never the access token body.';
comment on column public.social_accounts.vault_refresh_token_secret_id is
  'Opaque vault.secrets id only; never the refresh token body.';
