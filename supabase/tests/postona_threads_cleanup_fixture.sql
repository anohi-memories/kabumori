-- Fake-only, applied by postona_threads_cleanup_run.sh / postona_threads_disconnect_run.sh on the G4 publish
-- world after the release fixture. A stand-in of G5's private.account_lifecycle_operations with exactly the
-- columns and CHECKs of 20261001150000_common_account_lifecycle_foundation.sql and the owner lease of
-- 20261009120000_common_account_deletion_completion.sql (lease shape, owner scope) that the Threads
-- candidates read (it is NOT G5's table and carries none of its guards). Disposable local database only.
create table private.account_lifecycle_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  operation_type text not null check (operation_type in ('service_deletion', 'account_deletion')),
  service_key text check (service_key in ('kabumori', 'x_autopost')),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'aborted', 'login_removed')),
  current_step text not null default 'cleanup' check (current_step in ('cleanup', 'ready_for_managed_auth_delete')),
  owner_lease uuid,
  owner_lease_expires_at timestamptz,
  check ((operation_type = 'service_deletion') = (service_key is not null)),
  constraint account_lifecycle_operations_lease_shape check ((owner_lease is null) = (owner_lease_expires_at is null)),
  constraint account_lifecycle_operations_owner_scope check (operation_type = 'account_deletion' or owner_lease is null)
);
revoke all on table private.account_lifecycle_operations from public, anon, authenticated, service_role;

-- A stand-in of G5 Phase 4's private.account_lifecycle_service_state_refusal (20261012130000), following its
-- contract over the release fixture's postona_rel.lifecycle states (+ 'suspended') and the table above: null =
-- a write may proceed, otherwise the fixed code; the person's lifecycle row locked FOR UPDATE and kept; a
-- timed-out wait is ACCOUNT_LIFECYCLE_BUSY. NOT G5's implementation (the real one is proven by
-- postona_threads_t13_run.sh). Each call is logged in postona_rel.fence_calls.
alter table postona_rel.lifecycle drop constraint lifecycle_state_check;
alter table postona_rel.lifecycle add constraint lifecycle_state_check
  check (state in ('active', 'not_registered', 'ended', 'suspended', 'deleting', 'locked'));
-- The release fixture's T13 stand-in, taught 'suspended' (G5: any entitlement status other than active is
-- SERVICE_NOT_ACTIVE); otherwise the same body.
create or replace function private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare v postona_rel.lifecycle%rowtype;
begin
  insert into postona_rel.fence_calls (user_id) values (p_user_id);
  if p_user_id is null or p_user_id is distinct from auth.uid() then
    raise exception 'ACCOUNT_LIFECYCLE_AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_service_key is distinct from 'x_autopost' then raise exception 'ACCOUNT_LIFECYCLE_SERVICE_INVALID' using errcode = '42501'; end if;
  perform 1 from auth.users u where u.id = p_user_id for key share;
  select l.* into v from postona_rel.lifecycle l where l.user_id = p_user_id for update;
  if v.user_id is null then raise exception 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND' using errcode = '42501'; end if;
  if v.state = 'not_registered' then raise exception 'SERVICE_NOT_REGISTERED' using errcode = v.sqlstate; end if;
  if v.state in ('ended', 'suspended') then raise exception 'SERVICE_NOT_ACTIVE' using errcode = v.sqlstate; end if;
  if v.state = 'deleting' then raise exception 'ACCOUNT_DELETION_IN_PROGRESS' using errcode = v.sqlstate; end if;
  if v.state = 'locked' then raise exception 'ACCOUNT_LOCKED' using errcode = v.sqlstate; end if;
end;
$$;
create function private.account_lifecycle_service_state_refusal(p_user_id uuid, p_service_key text) returns text
language plpgsql volatile security definer set search_path = '' set lock_timeout = '3s' as $$
declare v postona_rel.lifecycle%rowtype;
begin
  insert into postona_rel.fence_calls (user_id) values (p_user_id);
  if p_service_key is null or p_service_key not in ('kabumori', 'x_autopost') then return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID'; end if;
  if p_user_id is null then return 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'; end if;
  begin
    perform 1 from auth.users u where u.id = p_user_id for key share;
    select l.* into v from postona_rel.lifecycle l where l.user_id = p_user_id for update;
  exception when lock_not_available then
    return 'ACCOUNT_LIFECYCLE_BUSY';
  end;
  if v.user_id is null then return 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND'; end if;
  if v.state = 'deleting' or exists (select 1 from private.account_lifecycle_operations o
                                     where o.user_id = p_user_id and o.operation_type = 'account_deletion' and o.status = 'in_progress') then
    return 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;
  if v.state = 'locked' then return 'ACCOUNT_LOCKED'; end if;
  if v.state = 'not_registered' then return 'SERVICE_NOT_REGISTERED'; end if;
  if exists (select 1 from private.account_lifecycle_operations o
             where o.user_id = p_user_id and o.operation_type = 'service_deletion' and o.service_key = p_service_key and o.status = 'in_progress') then
    return 'SERVICE_DELETION_IN_PROGRESS';
  end if;
  if v.state in ('ended', 'suspended') then return 'SERVICE_NOT_ACTIVE'; end if;
  return null;
end;
$$;
revoke all on function private.account_lifecycle_service_state_refusal(uuid, text) from public, anon, authenticated, service_role;
