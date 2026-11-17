-- G4-02 #20 (Issue #561): BEFORE evidence for H1 #50 P2-1 / P2-2 on PR #706's 003 (public.postona_x_send_credential_v1(text), the
-- account-only read), in the same world. Appended by postona_g4_x_send_credential_run.sh after the behavior file's helper lines.
-- Prints 'code|token returned?' per case; the runner expects the defects to REPRODUCE here (VERIFIED with a token) and the same
-- situations to be refused by the new 003 (behavior cases 14-21). Fake tokens only; the token itself is never printed.
create function g4xs.v1(p_account text) returns text language plpgsql as $$
declare v text;
begin
  set local role service_role;
  execute 'select r.code || ''|'' || case when r.access_token is null then ''no_token'' else ''token_returned'' end from public.postona_x_send_credential_v1($1) r'
    into v using p_account;
  reset role;
  return v;
end $$;
select g4xs.person(4911), g4xs.person(4912);
select g4xs.begin_(4911, 'g4xs-before-a-label'), g4xs.complete_(4911, 'g4xs-before-a-label', '2911');
select g4xs.begin_(4912, 'g4xs-before-b-label'), g4xs.complete_(4912, 'g4xs-before-b-label', '2912');
select set_config('g4xs.ba', g4xs.acct(4911), false), set_config('g4xs.bb', g4xs.acct(4912), false),
       set_config('g4xs.baa', (select vault_access_token_secret_id::text from public.social_accounts where id = g4xs.acct(4911)), false),
       set_config('g4xs.bar', (select vault_refresh_token_secret_id::text from public.social_accounts where id = g4xs.acct(4911)), false),
       set_config('g4xs.bba', (select vault_access_token_secret_id::text from public.social_accounts where id = g4xs.acct(4912)), false);
\o
select 'BEFORE P2-1 account id only (no attempt, no session, any service_role code)|' || g4xs.v1(current_setting('g4xs.ba'));
update public.social_accounts set publish_enabled = false where id = current_setting('g4xs.ba');
select 'BEFORE P2-1 publishing off|' || g4xs.v1(current_setting('g4xs.ba'));
update public.social_accounts set publish_enabled = true where id = current_setting('g4xs.ba');
update public.social_accounts set vault_refresh_token_secret_id = vault_access_token_secret_id where id = current_setting('g4xs.ba');
select 'BEFORE P2-2 access = refresh (alias)|' || g4xs.v1(current_setting('g4xs.ba'));
update public.social_accounts set vault_refresh_token_secret_id = current_setting('g4xs.bar')::uuid where id = current_setting('g4xs.ba');
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.baa')::uuid where id = current_setting('g4xs.bb');
select 'BEFORE P2-2 shared with another account|' || g4xs.v1(current_setting('g4xs.ba'));
update public.social_accounts set vault_access_token_secret_id = current_setting('g4xs.bba')::uuid where id = current_setting('g4xs.bb');
update public.social_accounts set vault_access_token_secret_id = vault.create_secret('fakeXat_g4xs-before-b-label', current_setting('g4xs.bb') || '_restored_access_token') where id = current_setting('g4xs.ba');
select 'BEFORE P2-2 another account''s secret (purpose)|' || g4xs.v1(current_setting('g4xs.ba'));
