-- G5-36 FAKE CONSUMERS (test-only; loaded by postona_personal_auth_integration_pg_run.sh into a THROW-AWAY database). They model the CALL SEQUENCES
-- that G5 asks G3 / G4 to use, so the gates can be exercised together. They are NOT G3's or G4's product code, they are not a proposal for their
-- tables, and nothing here is meant for a managed or production database. Every function is owned by the lifecycle owner, SECURITY DEFINER with
-- an empty search_path, VOLATILE (READ COMMITTED required where T13 is called), and touches only what the step needs.
create schema g5fake;
grant usage on schema g5fake to authenticated;

-- G4: the first X / Threads connection's begin. 1. T13 (with S2-1): a proven person, live session, active account and service. 2. R0 (with D1 +
-- S2-3): the bootstrap verdict. 3. The S2-3 predicate again inside the writer, for the subject it acts for (auth.uid()). Only 'absent' creates the
-- personal workspace, and an existing row RAISES (a conflict is never a join); 'own' reuses it; anything else stops.
create function g5fake.x_begin() returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_r0 jsonb;
  v_el text;
  v_ws text;
begin
  perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');
  v_r0 := public.common_account_bootstrap_verdict('postona', 'x_connect_bootstrap');
  if v_r0 ->> 'decision' is distinct from 'allow' then
    return 'R0:' || coalesce(v_r0 ->> 'decision', 'null') || ':' || coalesce(v_r0 ->> 'reason', 'null');
  end if;
  v_el := private.postona_personal_workspace_eligibility(v_user);
  if v_el = 'absent' then
    v_ws := 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24);
    insert into public.brands (id, code_profile_key) values (v_ws, 'social_mobile_user_v1');
    insert into public.brand_memberships (brand_id, user_id, role) values (v_ws, v_user, 'owner');
    return 'BEGIN_CREATED';
  elsif v_el = 'own' then
    return 'BEGIN_OWN';
  end if;
  return 'ELIGIBILITY:' || coalesce(v_el, 'null');
end $$;

-- G4: a reconnect's begin binds R1's owner-epoch token to the OAuth state; the callback re-asks R1 and completes only on the SAME token.
create function g5fake.x_reconnect_begin(p_brand text) returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v jsonb;
begin
  perform private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost');
  v := public.common_account_authorization_verdict('postona', 'x_publish', p_brand);
  if v ->> 'decision' is distinct from 'allow' then
    return 'R1:' || coalesce(v ->> 'decision', 'null') || ':' || coalesce(v ->> 'reason', 'null');
  end if;
  return v ->> 'owner_epoch';
end $$;

create function g5fake.x_callback(p_brand text, p_bound text) returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v jsonb;
begin
  perform private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost');
  v := public.common_account_authorization_verdict('postona', 'x_publish', p_brand);
  if v ->> 'decision' is distinct from 'allow' then
    return 'R1:' || coalesce(v ->> 'decision', 'null') || ':' || coalesce(v ->> 'reason', 'null');
  end if;
  if p_bound is null or v ->> 'owner_epoch' is distinct from p_bound then
    return 'STALE_OWNER_EPOCH';
  end if;
  return 'COMPLETE_OK';
end $$;

-- G3: a reservation is created behind T13 + R1 and keeps R1's token; the worker (no session) re-checks it with W1 before sending.
create function g5fake.reservation_create(p_brand text) returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v jsonb;
begin
  perform private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost');
  v := public.common_account_authorization_verdict('postona', 'x_publish', p_brand);
  if v ->> 'decision' is distinct from 'allow' then
    return 'R1:' || coalesce(v ->> 'decision', 'null') || ':' || coalesce(v ->> 'reason', 'null');
  end if;
  return v ->> 'owner_epoch';
end $$;

create function g5fake.worker_send(p_brand text, p_bound text) returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_bound is null or p_bound !~ '^g5oe:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$' then
    return 'NO_BOUND_EPOCH';  -- an old row without a token never sends
  end if;
  return private.account_lifecycle_worker_brand_verdict(p_brand, 'x_autopost', pg_catalog.split_part(p_bound, ':', 2)::bigint,
                                                         pg_catalog.split_part(p_bound, ':', 3)::bigint);
end $$;

-- G3: person-facing cancel / receipt: the S2-2 gate FIRST; anything but exactly 'active' (NULL included) touches nothing.
create function g5fake.reservation_cancel() returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v text := private.postona_personal_session();
begin
  if v is distinct from 'active' then
    return 'S22:' || coalesce(v, 'null');
  end if;
  return 'CANCEL_OK';
end $$;

create function g5fake.reservation_receipt() returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v text := private.postona_personal_session();
begin
  if v is distinct from 'active' then
    return 'S22:' || coalesce(v, 'null');
  end if;
  return 'RECEIPT_OK';
end $$;

revoke all on all functions in schema g5fake from public;
grant execute on function g5fake.x_begin(), g5fake.x_reconnect_begin(text), g5fake.x_callback(text, text), g5fake.reservation_create(text),
  g5fake.reservation_cancel(), g5fake.reservation_receipt() to authenticated;
-- the worker runs without a person: no API role may call it
