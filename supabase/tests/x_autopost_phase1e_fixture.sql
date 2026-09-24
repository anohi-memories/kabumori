-- Fake-only Phase1E additions, applied after x_autopost_phase1d_fixture.sql
-- and before the Phase1B/Phase1D/Phase1E migrations. Never production.
-- Tokens below are fake strings; the vault schema is a stand-in for Supabase
-- Vault's decrypted_secrets view.
set timezone = 'UTC';

alter table public.social_accounts
  add column vault_access_token_secret_id uuid,
  add column vault_refresh_token_secret_id uuid;
-- Model a future brand with two X accounts: the resolver must still pick the
-- exact claimed account (production today enforces one X account per brand).
alter table public.social_accounts drop constraint social_accounts_brand_id_platform_key;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), secret text not null);
create view vault.decrypted_secrets as select s.id, s.secret as decrypted_secret from vault.secrets s;
revoke all on schema vault from public;
revoke all on all tables in schema vault from public, anon, authenticated, service_role;

-- Legacy shared store and hardcoded-account token that must never be used.
create table public.oauth_token_store (provider text primary key, access_token_ciphertext text);
insert into public.oauth_token_store values ('x', 'fake_LEGACY_shared_store_token');

insert into public.brands values ('ai_salaryman_lab');
insert into public.social_accounts
  (id, brand_id, platform, platform_user_id, connection_status, publish_enabled)
values
  ('acct_a2', 'brand_a', 'x', 'x_a2', 'identity_verified', true),
  ('ai_salaryman_lab_x', 'ai_salaryman_lab', 'x', 'x_lab', 'identity_verified', true);

insert into vault.secrets (id, secret) values
  ('00000000-0000-4000-8000-00000000000a', 'fake_tok_acct_a'),
  ('00000000-0000-4000-8000-0000000000a2', 'fake_tok_acct_a2'),
  ('00000000-0000-4000-8000-00000000000b', 'fake_tok_acct_b'),
  ('00000000-0000-4000-8000-0000000000ff', 'fake_tok_acct_other'),
  ('00000000-0000-4000-8000-00000000001a', 'fake_tok_ai_lab_hardcoded'),
  ('00000000-0000-4000-8000-0000000000aa', 'fake_REFRESH_acct_a');
update public.social_accounts set
  vault_access_token_secret_id = case id
    when 'acct_a' then '00000000-0000-4000-8000-00000000000a'::uuid
    when 'acct_a2' then '00000000-0000-4000-8000-0000000000a2'::uuid
    when 'acct_b' then '00000000-0000-4000-8000-00000000000b'::uuid
    when 'acct_other' then '00000000-0000-4000-8000-0000000000ff'::uuid
    when 'ai_salaryman_lab_x' then '00000000-0000-4000-8000-00000000001a'::uuid
  end,
  vault_refresh_token_secret_id = case id when 'acct_a' then '00000000-0000-4000-8000-0000000000aa'::uuid end;
