-- MOCK_ONLY. A stand-in for G5's service-write guard (T13,
-- private.account_lifecycle_assert_active_service_write), which is not on main and not applied anywhere.
-- It follows the agreed contract (docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md) closely
-- enough to exercise the POSTONA Threads candidate: READ COMMITTED only; the caller must be the
-- authenticated person named by the JWT; the real Phase 1 lifecycle lock (login KEY SHARE -> common
-- account FOR UPDATE), then the entitlement FOR UPDATE; refusals with the agreed fixed codes and SQLSTATE
-- 42501; EXECUTE for its owner only. It does NOT check auth.sessions and is NOT a security proof of the
-- real guard or of Supabase Auth. Each call is logged so the tests can prove it runs before any write.
-- Disposable local database only; applied by postona_threads_oauth_run.sh in its default (mock) mode.
set timezone = 'UTC';

-- auth.uid() as GoTrue defines it: the per-claim setting first, else the JSON claims.
create or replace function auth.uid() returns uuid language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create schema if not exists postona_mock;
create table postona_mock.calls (
  seq bigserial primary key,
  tx xid8 not null default pg_current_xact_id(),
  what text not null
);

create function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
  v_account public.common_accounts;
  v_status text;
begin
  insert into postona_mock.calls (what) values ('T13');
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE' using errcode = '42501';
  end if;
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then
    raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID' using errcode = '42501';
  end if;
  if p_user_id is null or (select auth.uid()) is distinct from p_user_id or v_role is distinct from 'authenticated' then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  v_account := private.account_lifecycle_lock(p_user_id, false);
  if v_account.user_id is null then
    raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501';
  end if;
  if v_account.status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then
    raise exception 'ACCOUNT_DELETION_IN_PROGRESS' using errcode = '42501';
  end if;
  if v_account.status <> 'active' then
    raise exception 'ACCOUNT_LOCKED' using errcode = '42501';
  end if;
  select e.status into v_status from public.service_entitlements e
   where e.user_id = p_user_id and e.service_key = p_service_key for update;
  if not found then
    raise exception 'SERVICE_NOT_REGISTERED' using errcode = '42501';
  end if;
  if v_status = 'deleting'
     or exists (select 1 from private.account_lifecycle_operations o
                where o.user_id = p_user_id and o.operation_type = 'service_deletion'
                  and o.service_key = p_service_key and o.status = 'in_progress') then
    raise exception 'SERVICE_DELETION_IN_PROGRESS' using errcode = '42501';
  end if;
  if v_status <> 'active' then
    raise exception 'SERVICE_NOT_ACTIVE' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.account_lifecycle_assert_active_service_write(uuid, text) from public, anon, authenticated, service_role;
