create table if not exists public.oauth_token_store (
  provider text primary key,
  access_token_ciphertext text not null,
  access_token_iv text not null,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  check (provider = 'x')
);

alter table public.oauth_token_store enable row level security;
revoke all on public.oauth_token_store from anon, authenticated;
grant select, insert, update on public.oauth_token_store to service_role;

comment on table public.oauth_token_store is
  'OAuth tokens encrypted with AES-GCM by the Edge Function; never store plaintext tokens here.';
