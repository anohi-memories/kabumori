-- Fake-only test support for the POSTONA Threads OAuth / workspace candidate
-- (supabase/candidates/postona_threads_oauth_workspace_candidate.sql). Applied by
-- postona_threads_oauth_run.sh after the T13 stand-in (MOCK_ONLY) or G5's own candidate guard, and
-- before the candidate. Disposable local database only; every value is fake.
set timezone = 'UTC';

-- 1. Vault as Supabase shapes it: a secret has a unique name, decrypted_secrets exposes it and
--    create_secret stores it. TEST-ONLY failure injection: a secret starting with fakeFAILVAULT fails.
alter table vault.secrets add column name text unique;
create or replace view vault.decrypted_secrets as select s.id, s.secret as decrypted_secret, s.name from vault.secrets s;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if new_secret like 'fakeFAILVAULT%' then
    raise exception 'VAULT_UNAVAILABLE';
  end if;
  insert into vault.secrets (secret, name) values (new_secret, new_name) returning id into v_id;
  return v_id;
end;
$$;

-- 2. The server attestation key (TEST-ONLY value; the Edge exchange would hold the same one).
insert into vault.secrets (name, secret)
values ('postona_threads_connect_attestation_v1', 'fake_attestation_key_0123456789abcdef0123456789abcdef');

-- 3. auth.sessions as GoTrue shapes it (G5's guard fixture creates it in g5 mode).
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  not_after timestamptz
);

-- 4. Write log: every row written to the tables the candidate writes, in transaction order, next to the
--    T13 stand-in's own log entries (mock mode), so the tests can prove the guard ran first.
create schema if not exists postona_mock;
create table if not exists postona_mock.calls (
  seq bigserial primary key,
  tx xid8 not null default pg_current_xact_id(),
  what text not null
);
create function postona_mock.log_write() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into postona_mock.calls (what) values ('write:' || tg_table_name);
  return null;
end;
$$;
create trigger zz_postona_mock_log after insert or update on public.brands for each row execute function postona_mock.log_write();
create trigger zz_postona_mock_log after insert or update on public.brand_memberships for each row execute function postona_mock.log_write();
create trigger zz_postona_mock_log after insert or update on public.social_account_oauth_states for each row execute function postona_mock.log_write();
create trigger zz_postona_mock_log after insert or update on public.social_accounts for each row execute function postona_mock.log_write();
create trigger zz_postona_mock_log after insert or update on vault.secrets for each row execute function postona_mock.log_write();
