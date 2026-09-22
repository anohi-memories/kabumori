-- Run only in a fresh disposable PostgreSQL database as a superuser:
-- psql -v ON_ERROR_STOP=1 -f social_mobile_history_access_reader_disposable_proof.sql
-- The script applies the candidate, asserts behavior/ACL, then rolls back every
-- proof object. It refuses to run if the Supabase-like roles already exist.
\set ON_ERROR_STOP on

do $$
begin
  if exists (select 1 from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) then
    raise exception 'PROOF_REQUIRES_FRESH_DISPOSABLE_POSTGRES_ROLES';
  end if;
end;
$$;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema vault;
create table public.brand_memberships (
  brand_id text not null,
  user_id uuid not null,
  role text not null,
  primary key (brand_id, user_id)
);
create table public.social_accounts (
  id text primary key,
  brand_id text not null,
  platform text not null,
  connection_status text not null,
  platform_user_id text,
  vault_access_token_secret_id uuid,
  vault_refresh_token_secret_id uuid
);
create table vault.proof_secrets (
  id uuid primary key,
  decrypted_secret text not null
);
create table public.proof_vault_reads (secret_id uuid not null);
create function public.proof_mark_vault_read(p_id uuid, p_secret text)
returns text language plpgsql volatile as $$
begin
  insert into public.proof_vault_reads(secret_id) values (p_id);
  return p_secret;
end;
$$;
create view vault.decrypted_secrets as
  select s.id, public.proof_mark_vault_read(s.id, s.decrypted_secret) as decrypted_secret
  from vault.proof_secrets as s;
grant usage on schema public, vault to service_role;
grant select on public.proof_vault_reads to service_role;

insert into public.brand_memberships (brand_id, user_id, role) values
  ('brand-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('brand-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('brand-a', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'viewer'),
  ('brand-pending', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('brand-no-platform', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('brand-no-ref', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('brand-missing-secret', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('brand-multi', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner');

insert into public.social_accounts
  (id, brand_id, platform, connection_status, platform_user_id, vault_access_token_secret_id, vault_refresh_token_secret_id)
values
  ('account-a', 'brand-a', 'x', 'identity_verified', 'x-user-a', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'),
  ('account-b', 'brand-b', 'x', 'identity_verified', 'x-user-b', '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'),
  ('account-pending', 'brand-pending', 'x', 'authorization_pending', 'x-pending', '30000000-0000-4000-8000-000000000001', null),
  ('account-no-platform', 'brand-no-platform', 'x', 'identity_verified', null, '40000000-0000-4000-8000-000000000001', null),
  ('account-no-ref', 'brand-no-ref', 'x', 'identity_verified', 'x-no-ref', null, null),
  ('account-missing-secret', 'brand-missing-secret', 'x', 'identity_verified', 'x-missing-secret', '50000000-0000-4000-8000-000000000001', null),
  ('account-multi-a', 'brand-multi', 'x', 'identity_verified', 'x-multi-a', '60000000-0000-4000-8000-000000000001', null),
  ('account-multi-b', 'brand-multi', 'x', 'identity_verified', 'x-multi-b', '60000000-0000-4000-8000-000000000002', null);

insert into vault.proof_secrets (id, decrypted_secret) values
  ('10000000-0000-4000-8000-000000000001', 'fake-access-token-a'),
  ('10000000-0000-4000-8000-000000000002', 'fake-refresh-token-a'),
  ('20000000-0000-4000-8000-000000000001', 'fake-access-token-b'),
  ('20000000-0000-4000-8000-000000000002', 'fake-refresh-token-b'),
  ('30000000-0000-4000-8000-000000000001', 'fake-pending-token'),
  ('40000000-0000-4000-8000-000000000001', 'fake-no-platform-token'),
  ('60000000-0000-4000-8000-000000000001', 'fake-multi-token-a'),
  ('60000000-0000-4000-8000-000000000002', 'fake-multi-token-b');

\ir ../../../migrations/20260923120000_social_mobile_history_access_token_reader.sql

do $$
declare
  v_proc oid := 'public.read_social_mobile_history_access_token(uuid,text)'::regprocedure;
  v_config text[];
begin
  if not (select prosecdef from pg_proc where oid = v_proc) then
    raise exception 'PROOF_SECURITY_DEFINER_MISSING';
  end if;
  select proconfig into v_config from pg_proc where oid = v_proc;
  if v_config is distinct from array['search_path=""']::text[] then
    raise exception 'PROOF_SEARCH_PATH_MISMATCH:%', v_config;
  end if;
  if has_function_privilege('anon', v_proc, 'EXECUTE')
     or has_function_privilege('authenticated', v_proc, 'EXECUTE')
     or not has_function_privilege('service_role', v_proc, 'EXECUTE') then
    raise exception 'PROOF_FUNCTION_ACL_MISMATCH';
  end if;
end;
$$;

set role service_role;
do $$
declare v_token text; v_reads integer;
begin
  v_token := public.read_social_mobile_history_access_token(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'account-a'
  );
  if v_token <> 'fake-access-token-a' then raise exception 'PROOF_OWNER_ACCESS_TOKEN_MISMATCH'; end if;
  select count(*) into v_reads from public.proof_vault_reads;
  if v_reads <> 1 then raise exception 'PROOF_EXPECTED_ONE_PLAINTEXT_READ:%', v_reads; end if;
end;
$$;

-- Assert each negative branch independently and verify it caused no plaintext read.
do $$
declare
  v_case record;
  v_failed boolean;
  v_reads_before integer;
  v_reads_after integer;
begin
  for v_case in select * from (values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'account-b'::text),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid, 'account-a'::text),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'account-pending'::text),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'account-no-platform'::text),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'account-no-ref'::text),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'account-missing-secret'::text),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'forged-account-id'::text),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'account-multi-a'::text)
  ) as cases(user_id, account_id)
  loop
    select count(*) into v_reads_before from public.proof_vault_reads;
    v_failed := false;
    begin
      perform public.read_social_mobile_history_access_token(v_case.user_id, v_case.account_id);
    exception when sqlstate 'P0001' then
      v_failed := true;
    end;
    if not v_failed then raise exception 'PROOF_EXPECTED_DENIAL:%', v_case.account_id; end if;
    select count(*) into v_reads_after from public.proof_vault_reads;
    if v_reads_after <> v_reads_before then raise exception 'PROOF_DENIAL_READ_PLAINTEXT:%', v_case.account_id; end if;
  end loop;
end;
$$;
reset role;

drop function public.read_social_mobile_history_access_token(uuid, text);
do $$
begin
  if to_regprocedure('public.read_social_mobile_history_access_token(uuid,text)') is not null then
    raise exception 'PROOF_ROLLBACK_FUNCTION_REMAINS';
  end if;
end;
$$;
drop view vault.decrypted_secrets;
drop function public.proof_mark_vault_read(uuid, text);
drop table public.proof_vault_reads, vault.proof_secrets;
drop table public.social_accounts, public.brand_memberships;
drop schema vault, auth;
revoke usage on schema public from service_role;
drop role anon, authenticated, service_role;
