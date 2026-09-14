-- Return exactly one token only when its reference belongs to the verified AI Lab X account.
-- This lets the Edge Function read an opaque Vault secret reference without exposing the Vault schema
-- through the Data API or permitting arbitrary secret reads.
create or replace function public.read_ai_salaryman_lab_x_vault_token(
  p_vault_secret_id uuid
)
returns table(token_value text)
language sql
security definer
set search_path = ''
as $$
  select secret.decrypted_secret
  from vault.decrypted_secrets as secret
  where secret.id = p_vault_secret_id
    and secret.decrypted_secret is not null
    and secret.decrypted_secret <> ''
    and exists (
      select 1
      from public.social_accounts as account
      where account.id = 'ai_salaryman_lab_x'
        and account.brand_id = 'ai_salaryman_lab'
        and account.platform = 'x'
        and account.handle = 'kaishain_ai_lab'
        and account.connection_status = 'identity_verified'
        and p_vault_secret_id in (
          account.vault_access_token_secret_id,
          account.vault_refresh_token_secret_id
        )
    )
  limit 1;
$$;

revoke all on function public.read_ai_salaryman_lab_x_vault_token(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_ai_salaryman_lab_x_vault_token(uuid)
  to service_role;
