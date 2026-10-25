-- G4-41 (Issue #319): the person's own connect / disconnect / reconnect through the API roles, on the product shape with
-- 001 + 002 + 003 installed (disposable local PG17; fake Auth, fake Vault, fake G5). Calls run as `authenticated` (or `anon`)
-- with the fake JWT subject, each in its own subtransaction, like one PostgREST request.
\set ON_ERROR_STOP 1

create schema g4xu;
create table g4xu.results (n serial, case_id text, expected text, actual text, ok boolean);
grant usage on schema g4xu to authenticated, anon;
grant insert, select on g4xu.results to authenticated, anon;
grant usage on sequence g4xu.results_n_seq to authenticated, anon;

create function g4xu.u(p int) returns uuid language sql immutable
  as $$ select ('aaaaaaaa-0000-0000-0000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4xu.acct(p int) returns text language sql immutable
  as $$ select 'sa_' || substr(md5('u_' || substr(md5(g4xu.u(p)::text), 1, 24) || ':x'), 1, 24) $$;
create function g4xu.h(p_label text) returns text language sql immutable
  as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g4xu.as_user(p int) returns void language sql
  as $$ select set_config('request.jwt.claim.sub', coalesce(g4xu.u(p)::text, ''), false) $$;
create function g4xu.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $$;
-- the state id the Edge gets back from consume_social_mobile_x_oauth_state (read here as the superuser)
create function g4xu.sid(p_label text) returns uuid language sql security definer
  as $$ select s.id from public.social_account_oauth_states s where s.state_hash = g4xu.h(p_label) $$;
-- the two RPCs the Edge makes, as the caller's role
create function g4xu.connect_(p int, p_label text, p_puid text) returns text language plpgsql as $$
declare v text;
begin
  perform g4xu.as_user(p);
  v := g4xu.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
                       g4xu.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
  if v <> 'OK' then return v; end if;
  return 'OK/' || g4xu.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
    g4xu.sid(p_label), p_puid, '@h_' || p_puid, 'fakeXat_' || p_label, 'fakeXrt_' || p_label));
end $$;
create function g4xu.disconnect_(p int) returns text language plpgsql as $$
begin
  perform g4xu.as_user(p);
  return g4xu.try('select public.disconnect_social_mobile_x_connection()');
end $$;
create function g4xu.chk(p_case text, p_actual text, p_expected text) returns void language sql as $$
  insert into g4xu.results (case_id, expected, actual, ok) values (p_case, p_expected, coalesce(p_actual, '<null>'),
    coalesce(p_actual, '<null>') = p_expected);
$$;
-- facts are read as the superuser (the API roles cannot see these tables)
create function g4xu.account(p int) returns text language sql security definer as $$
  select coalesce((select sa.connection_status || '/' || sa.publish_enabled from public.social_accounts sa where sa.id = g4xu.acct(p)),
                  'none') $$;
create function g4xu.epoch(p int) returns text language sql security definer as $$
  select coalesce((select c.connection_epoch::text from postona_g4_x_oauth.connections c where c.social_account_id = g4xu.acct(p)), 'none') $$;
create function g4xu.pending(p int) returns text language sql security definer as $$
  select count(*)::text from public.social_account_oauth_states s where s.social_account_id = g4xu.acct(p) and s.consumed_at is null $$;

insert into auth.users select g4xu.u(i) from generate_series(1, 12) i;
insert into public.brands values ('legacy_l7', 'Legacy', true, 'manual', 'legacy_v0');
insert into public.brand_memberships values ('legacy_l7', g4xu.u(7), 'owner');

set role authenticated;
-- U1 connect as the person, then the gate is closed
select g4xu.chk('U1 connect (authenticated)', g4xu.connect_(1, 'a1', 'pu_A'), 'OK/OK');
select g4xu.chk('U1 disconnect while the gate is closed', g4xu.disconnect_(1), 'X_DISCONNECT_NOT_ENABLED');
reset role;
select g4xu.chk('U1 account untouched', g4xu.account(1) || ' ' || g4xu.epoch(1), 'identity_verified/false 2');

-- the operator opens the gate (owner only)
select postona_g4_x_oauth.set_x_disconnect_enabled(true);

set role anon;
select g4xu.chk('U2 anon cannot call it', g4xu.disconnect_(1), 'permission denied for function disconnect_social_mobile_x_connection');
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub', '', false);
select g4xu.chk('U3 no subject', g4xu.try('select public.disconnect_social_mobile_x_connection()'), 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED');
-- U4 a begun-but-unfinished reconnect, then disconnect: the pending state goes, the epoch moves
select g4xu.as_user(1);
select g4xu.chk('U4 begin a reconnect', g4xu.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
  g4xu.h('a2'), 'kabumori-social://oauth-callback', now() + interval '10 minutes')), 'OK');
select g4xu.chk('U4 disconnect', g4xu.disconnect_(1), 'OK');
reset role;
select g4xu.chk('U4 account / epoch / pending', g4xu.account(1) || ' ' || g4xu.epoch(1) || ' ' || g4xu.pending(1),
  'unconnected/false 3 0');
set role authenticated;
select g4xu.chk('U4 the pre-disconnect callback', g4xu.try(format(
  'select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)', g4xu.sid('a2'), 'pu_A', 'h', 'fakeXat_a2',
  'fakeXrt_a2')), 'OAUTH_STATE_NOT_CONSUMABLE');
select g4xu.chk('U5 disconnect twice', g4xu.disconnect_(1), 'OK');
select g4xu.chk('U6 reconnect after disconnect', g4xu.connect_(1, 'a3', 'pu_A'), 'OK/OK');
reset role;
select g4xu.chk('U6 account / epoch', g4xu.account(1) || ' ' || g4xu.epoch(1), 'identity_verified/false 5');

set role authenticated;
select g4xu.chk('U7 someone without X', g4xu.disconnect_(2), 'X_CONNECTION_NOT_FOUND');
select g4xu.chk('U8 a legacy-brand owner (P-1 undecided)', g4xu.disconnect_(7), 'OWN_WORKSPACE_CONFLICT');
-- U9 another person cannot reach A's X: there is no argument to point at it
select g4xu.chk('U9 B connects', g4xu.connect_(3, 'b1', 'pu_B'), 'OK/OK');
select g4xu.chk('U9 B disconnects (own only)', g4xu.disconnect_(3), 'OK');
reset role;
select g4xu.chk('U9 A untouched', g4xu.account(1), 'identity_verified/false');
-- U10 a revoked session (G5's session verdict, faked)
insert into private.g4x_fake values ('session', 'SESSION_REVOKED');
set role authenticated;
select g4xu.chk('U10 session revoked', g4xu.disconnect_(1), 'SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE');
reset role;
delete from private.g4x_fake where k = 'session';
-- U11 closing the gate again stops new disconnects
select postona_g4_x_oauth.set_x_disconnect_enabled(false);
set role authenticated;
select g4xu.chk('U11 gate closed again', g4xu.disconnect_(1), 'X_DISCONNECT_NOT_ENABLED');
reset role;

select case when ok then 'PASS' else 'FAIL' end || ' | ' || case_id || ' | expected ' || expected || ' | actual ' || actual
from g4xu.results order by n;
select 'G4XU_RESULT checks=' || count(*) || ' pass=' || count(*) filter (where ok) || ' fail=' || count(*) filter (where not ok)
from g4xu.results;
do $$ begin
  if exists (select 1 from g4xu.results where not ok) then raise exception 'G4XU_BEHAVIOR_FAIL'; end if;
end $$;
