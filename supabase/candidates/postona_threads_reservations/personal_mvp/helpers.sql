-- G3-40 test helpers for postona_threads_personal_mvp_run.sh (TEST ONLY, fake data, disposable local PG17). \ir'd by every SQL file of this suite.
-- The world is G5's personal MVP profile (R1-MVP + MV, no W1) under G3 001-006 + 007 (+ 009 where the file says so).
-- TEST STAND-INS: owner UPDATEs move a reservation's time into the past (the "clock"), end a service (the end saga's final state, as
-- the G5-47 suite writes it), change a fake credential reference, and list a Threads account in G3's own G4 TEST DOUBLE.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if; end $$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000040' || lpad(p_n::text, 2, '0'))::uuid $$;
create function pg_temp.ws(p_user uuid) returns text language sql immutable as $$ select 'u_' || substr(md5(p_user::text), 1, 24) $$;
create function pg_temp.tacct(p_user uuid) returns text language sql immutable as $$ select 'th40_' || right(p_user::text, 2) $$;
create function pg_temp.lv(p_user uuid) returns bigint language sql stable as $$
  select ca.lifecycle_version from public.common_accounts ca where ca.user_id = p_user $$;
-- the verified claims the Edge forwards: a live session of this person and a proven non-anonymous sign-in (S2-2 reads them)
create function pg_temp.set_claims(p_sub uuid) returns void language plpgsql as $$
declare v_session uuid;
begin
  if p_sub is not null then
    select s.id into v_session from auth.sessions s where s.user_id = p_sub and (s.not_after is null or s.not_after > clock_timestamp()) order by s.id limit 1;
  end if;
  perform set_config('request.jwt.claims', case when p_sub is null then '' else json_build_object('sub', p_sub, 'role', 'authenticated',
    'session_id', v_session, 'is_anonymous', false)::text end, true);
end $$;
create function pg_temp.as_role(p_sql text, p_role text, p_sub uuid default null) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.set_claims(p_sub);
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  perform pg_temp.set_claims(null);
  return coalesce(v, '<null>');
exception when others then
  reset role;
  perform pg_temp.set_claims(null);
  return 'ERR:' || sqlerrm;
end $$;
-- R1-MVP for the person, read as the owner (R1 is owner-only as G5 ships it; G3's definers call it as the owner)
create function pg_temp.r1(p_user uuid, p_brand text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.set_claims(p_user);
  v := public.common_account_authorization_verdict('postona', 'threads_publish', p_brand);
  perform pg_temp.set_claims(null);
  return v;
end $$;
create function pg_temp.api(p_sql text, p_sub uuid) returns text language sql as $$ select pg_temp.as_role(p_sql, 'postona_resv_api', p_sub) $$;
create function pg_temp.worker(p_sql text) returns text language sql as $$ select pg_temp.as_role(p_sql, 'postona_resv_worker') $$;
create function pg_temp.body_sha(p_body text) returns text language sql immutable as $$ select encode(sha256(convert_to(p_body, 'UTF8')), 'hex') $$;
-- One consented Threads reservation through the API role on p_account (default: the person's own), p_hours ahead.
create function pg_temp.create_raw(p_user uuid, p_tag text, p_hours integer, p_account text default null) returns text language sql as $$
  select pg_temp.api(format('select reservation_id::text from postona_threads_resv.create_reservation(%L, gen_random_uuid(), %L, %L, now() + make_interval(hours => %s))',
    coalesce(p_account, pg_temp.tacct(p_user)), 'G3-40 本文 ' || p_tag, pg_temp.body_sha('G3-40 本文 ' || p_tag), p_hours), p_user) $$;
create function pg_temp.reserve(p_user uuid, p_tag text, p_hours integer) returns uuid language plpgsql as $$
declare v text := pg_temp.create_raw(p_user, p_tag, p_hours);
begin
  perform pg_temp.expect(v !~ '^ERR' and v <> '<null>', 'setup: create ' || p_tag || ' ' || v);
  return v::uuid;
end $$;
-- The clock: due now.
create function pg_temp.make_due(p_id uuid) returns void language sql as $$
  update postona_threads_resv.reservations set scheduled_at = now() - interval '1 minute' where id = p_id $$;
create function pg_temp.row_of(p_id uuid) returns text language sql stable as $$
  select status || '/' || coalesce(outcome_code, '-') from postona_threads_resv.reservations where id = p_id $$;
create function pg_temp.bound_of(p_id uuid) returns text language sql stable as $$
  select coalesce(bound_owner_epoch::text, 'null') || '/' || coalesce(bound_lifecycle_version::text, 'null') from postona_threads_resv.reservations where id = p_id $$;
create function pg_temp.claim() returns text language sql as $$
  select pg_temp.worker('select coalesce(string_agg(reservation_id::text || ''='' || lease_token::text, '','' order by reservation_id), '''') from postona_threads_resv.claim_due(''w40'', 120, 50)') $$;
create function pg_temp.lease_of(p_id uuid) returns uuid language sql stable as $$ select lease_token from postona_threads_resv.reservations where id = p_id $$;
-- the dispatcher's last check before the provider (the pre-publish hook)
create function pg_temp.check_send(p_id uuid) returns text language sql as $$
  select pg_temp.worker(format('select verdict from postona_threads_resv.preflight(%L, %L)', p_id, pg_temp.lease_of(p_id))) $$;
create function pg_temp.record(p_id uuid, p_outcome text, p_post text, p_code text) returns text language sql as $$
  select pg_temp.worker(format('select postona_threads_resv.record(%L, %L, %L, %L, %L, ''simulated'')', p_id, pg_temp.lease_of(p_id), p_outcome, p_post, p_code)) $$;
-- The person's POSTONA service ends (the end saga's final state) and the person starts it again: a NEW generation.
create function pg_temp.restart(p_user uuid) returns bigint language plpgsql as $$
declare v_before bigint := pg_temp.lv(p_user); v text;
begin
  update public.service_entitlements set status = 'ended', ended_at = now() where user_id = p_user and service_key = 'x_autopost';
  v := pg_temp.as_role(format('select public.reactivate_x_autopost_service(%s) ->> ''status''', pg_temp.lv(p_user)), 'authenticated', p_user);
  perform pg_temp.expect(v = 'active', 'setup: restart ' || v);
  perform pg_temp.expect(pg_temp.lv(p_user) > v_before, 'setup: restart moved the generation');
  return pg_temp.lv(p_user);
end $$;
