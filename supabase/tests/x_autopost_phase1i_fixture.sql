-- Fake-only Phase1I additions, applied after the 1D/1E/1F/1G fixtures and
-- before the 1B..1I migrations. Never production. Mirrors the production
-- social_accounts columns the refresh path reads, and Supabase Vault's
-- vault.update_secret signature. All tokens are fake strings.
set timezone = 'UTC';

alter table public.social_accounts
  add column oauth_client_ref text default 'default',
  add column updated_at timestamptz not null default now();

create function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null
) returns void language plpgsql as $$
begin
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id;
  if not found then raise exception 'fixture vault secret not found'; end if;
end;
$$;
revoke all on function vault.update_secret(uuid, text, text, text, uuid) from public;

-- Test-only fault injection for "writer failure".
create function vault.fixture_fail_write() returns trigger language plpgsql as $$
begin
  if new.secret = 'fake_FORCE_WRITE_FAIL' then raise exception 'FIXTURE_VAULT_WRITE_FAILURE'; end if;
  return new;
end;
$$;
create trigger fixture_fail_write before update on vault.secrets
for each row execute function vault.fixture_fail_write();

insert into vault.secrets (id, secret) values
  ('00000000-0000-4000-8000-0000000000bb', 'fake_REFRESH_acct_b'),
  ('00000000-0000-4000-8000-0000000000c3', 'fake_tok_acct_c'),
  ('00000000-0000-4000-8000-0000000000cc', 'fake_REFRESH_acct_c');
update public.social_accounts set vault_refresh_token_secret_id = '00000000-0000-4000-8000-0000000000bb' where id = 'acct_b';
-- acct_a2 wrongly uses another account's secret (acct_other's access token)
-- as its refresh destination. Any sharing blocks refresh for both sides.
update public.social_accounts set vault_refresh_token_secret_id = '00000000-0000-4000-8000-0000000000ff' where id = 'acct_a2';

-- A third brand/account for independent parallel refresh.
insert into public.brands values ('brand_c');
insert into public.social_accounts
  (id, brand_id, platform, platform_user_id, connection_status, publish_enabled,
   vault_access_token_secret_id, vault_refresh_token_secret_id)
values ('acct_c', 'brand_c', 'x', 'x_c', 'identity_verified', true,
        '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000cc');
