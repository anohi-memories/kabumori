-- G4-40 (Issue #319) TEST WORLD ONLY, loaded after postona_g4_x_oauth_personal_epoch_world.sql: the PRODUCT SHAPE around X OAuth.
-- Disposable local PostgreSQL 17 only. The runner then adds, verbatim from main 0c42933c:
--   20261007150000 L370-L392 (social_accounts_provider_guard + its trigger) and the whole 20260925140000 (the X refresh core).
-- public.social_accounts: the constraints main's 20261007150000 checks for (L232-L237 before it, L409-L412 after it).
alter table public.social_accounts
  add constraint social_accounts_connection_status_check check (connection_status = any (array[
    'unconnected', 'authorization_pending', 'connected', 'identity_verified', 'failed'])),
  add constraint social_accounts_id_check check (id ~ '^[a-z][a-z0-9_]{1,80}$'),
  add constraint social_accounts_platform_supported check (platform = any (array['x', 'threads', 'instagram'])),
  add constraint social_accounts_brand_id_platform_key unique (brand_id, platform),
  add constraint social_accounts_meta_connected_access check (platform = 'x' or vault_access_token_secret_id is not null
    or connection_status = any (array['unconnected', 'authorization_pending', 'failed'])),
  add constraint social_accounts_meta_publish_disabled check (platform = 'x' or publish_enabled is false),
  add constraint social_accounts_provider_credential_profile check (platform = 'x' or vault_refresh_token_secret_id is null);

-- fake Vault in the shape the refresh core requires (5-argument update_secret, decrypted_secrets);
-- g4x.vault_sleep (seconds) holds the caller inside Vault, for the two-session cases
drop function vault.update_secret(uuid, text, text, text);
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null)
returns void language plpgsql as $$
begin
  if current_setting('g4x.vault_fail', true) = 'on' then raise exception 'FAKE_VAULT_UNAVAILABLE'; end if;
  perform pg_sleep(coalesce(nullif(current_setting('g4x.vault_sleep', true), ''), '0')::float8);
  update vault.secrets set secret = new_secret where id = secret_id;
end $$;
create view vault.decrypted_secrets as select s.id, s.name, s.description, s.secret as decrypted_secret from vault.secrets s;

-- the legacy dispatcher's queue row: only the columns the refresh core reads
create table public.scheduled_posts (
  id uuid primary key default gen_random_uuid(), brand_id text, status text, attempt_count integer not null default 0);
