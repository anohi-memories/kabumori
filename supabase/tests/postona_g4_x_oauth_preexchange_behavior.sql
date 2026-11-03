-- G4-43 (Issue #319): the read-only consume the Edge calls BEFORE it exchanges the code with X, on the product shape
-- (disposable local PG17; fake Auth / Vault / G5 + G5 PR #506's predicate body). Calls run as `authenticated`.
--   mode=c003: 001 + 002 + 003 (consume is main's: what complete will refuse still reaches the exchange)
--   mode=c004: + 004 (consume refuses it before the exchange)
\set ON_ERROR_STOP 1
select set_config('g4xp.mode', :'mode', false);

create schema g4xp;
create table g4xp.results (n serial, case_id text, expected text, actual text, ok boolean);
grant usage on schema g4xp to authenticated, anon;
grant insert, select on g4xp.results to authenticated, anon;
grant usage on sequence g4xp.results_n_seq to authenticated, anon;

create function g4xp.u(p int) returns uuid language sql immutable
  as $$ select ('aaaaaaaa-0000-0000-0000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4xp.ws(p int) returns text language sql immutable
  as $$ select 'u_' || substr(md5(g4xp.u(p)::text), 1, 24) $$;
create function g4xp.h(p_label text) returns text language sql immutable
  as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g4xp.as_user(p int) returns void language sql
  as $$ select set_config('request.jwt.claim.sub', coalesce(g4xp.u(p)::text, ''), false) $$;
create function g4xp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $$;
create function g4xp.sid(p_label text) returns uuid language sql security definer
  as $$ select s.id from public.social_account_oauth_states s where s.state_hash = g4xp.h(p_label) $$;
create function g4xp.begin_(p int, p_label text) returns text language plpgsql as $$
begin
  perform g4xp.as_user(p);
  return g4xp.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
                         g4xp.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
end $$;
-- the Edge's pre-exchange call
create function g4xp.consume_(p int, p_label text) returns text language plpgsql as $$
begin
  perform g4xp.as_user(p);
  return g4xp.try(format('select * from public.consume_social_mobile_x_oauth_state(%L)', g4xp.h(p_label)));
end $$;
create function g4xp.complete_(p int, p_label text, p_puid text) returns text language plpgsql as $$
begin
  perform g4xp.as_user(p);
  return g4xp.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
    g4xp.sid(p_label), p_puid, '@h_' || p_puid, 'fakeXat_' || p_label, 'fakeXrt_' || p_label));
end $$;
create function g4xp.chk(p_case text, p_actual text, p_c003 text, p_c004 text) returns void language plpgsql as $$
declare v_exp text := case current_setting('g4xp.mode') when 'c003' then p_c003 else p_c004 end;
begin
  insert into g4xp.results (case_id, expected, actual, ok) values (p_case, v_exp, coalesce(p_actual, '<null>'),
    coalesce(p_actual, '<null>') = v_exp);
end $$;
-- everything consume may not change (read as the superuser)
create function g4xp.snap() returns text language sql security definer as $$
  select md5(concat_ws('|',
    (select string_agg(t::text, ',' order by t.id) from public.social_account_oauth_states t),
    (select string_agg(t::text, ',' order by t.social_account_id) from postona_g4_x_oauth.connections t),
    (select string_agg(t::text, ',' order by t.id) from public.social_accounts t))) $$;

insert into auth.users select g4xp.u(i) from generate_series(1, 20) i on conflict do nothing;

-- P1 the normal path: consume, then complete
set role authenticated;
select g4xp.chk('P1 begin', g4xp.begin_(1, 'a1'), 'OK', 'OK');
select g4xp.chk('P1 consume', g4xp.consume_(1, 'a1'), 'OK', 'OK');
select g4xp.chk('P1 complete', g4xp.complete_(1, 'a1', 'pu_A'), 'OK', 'OK');
-- P2 an older begin (a newer one exists)
select g4xp.chk('P2 begin b1, b2', g4xp.begin_(2, 'b1') || '/' || g4xp.begin_(2, 'b2'), 'OK/OK', 'OK/OK');
reset role;
select g4xp.snap() as s2 \gset
set role authenticated;
select g4xp.chk('P2 consume the older state', g4xp.consume_(2, 'b1'), 'OK', 'OAUTH_STATE_SUPERSEDED');
select g4xp.chk('P2 its complete is refused anyway', g4xp.complete_(2, 'b1', 'pu_B'), 'OAUTH_STATE_SUPERSEDED', 'OAUTH_STATE_SUPERSEDED');
reset role;
select g4xp.chk('P2 consume changed nothing', (g4xp.snap() = :'s2')::text, 'true', 'true');
-- P3 the session was revoked after begin
set role authenticated;
select g4xp.chk('P3 begin', g4xp.begin_(3, 'c1'), 'OK', 'OK');
reset role;
insert into private.g4x_fake values ('session', 'SESSION_REVOKED');
set role authenticated;
select g4xp.chk('P3 consume after revoke', g4xp.consume_(3, 'c1'), 'OK', 'SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE');
reset role;
delete from private.g4x_fake where k = 'session';
-- P4 the person owns another brand by the callback
set role authenticated;
select g4xp.chk('P4 begin', g4xp.begin_(4, 'd1'), 'OK', 'OK');
reset role;
insert into public.brands values ('legacy_p4', 'Legacy', false, 'disabled', 'legacy_v0');
insert into public.brand_memberships values ('legacy_p4', g4xp.u(4), 'owner');
set role authenticated;
select g4xp.chk('P4 consume after owning another brand', g4xp.consume_(4, 'd1'), 'OK', 'OWN_WORKSPACE_CONFLICT');
-- P5 the owner went A -> B -> A after begin
select g4xp.chk('P5 begin', g4xp.begin_(5, 'e1'), 'OK', 'OK');
reset role;
delete from public.brand_memberships where brand_id = g4xp.ws(5) and user_id = g4xp.u(5);
insert into public.brand_memberships values (g4xp.ws(5), g4xp.u(6), 'owner');
delete from public.brand_memberships where brand_id = g4xp.ws(5) and user_id = g4xp.u(6);
insert into public.brand_memberships values (g4xp.ws(5), g4xp.u(5), 'owner');
set role authenticated;
select g4xp.chk('P5 consume after an owner ABA', g4xp.consume_(5, 'e1'), 'OK', 'OWNER_EPOCH_CHANGED');
-- P6 a state begun under main's begin before 001 (the runner's pre-step, user 19)
select g4xp.chk('P6 consume a pre-001 state', g4xp.consume_(19, 'legacy_state'), 'OK', 'OAUTH_STATE_NOT_BOUND');
-- P7 main's own refusals are unchanged
select g4xp.chk('P7 someone else''s state', g4xp.consume_(7, 'a1'), 'OAUTH_STATE_NOT_CONSUMABLE', 'OAUTH_STATE_NOT_CONSUMABLE');
select g4xp.chk('P7 a consumed state', g4xp.consume_(1, 'a1'), 'OAUTH_STATE_NOT_CONSUMABLE', 'OAUTH_STATE_NOT_CONSUMABLE');
select set_config('request.jwt.claim.sub', '', false);
select g4xp.chk('P7 no subject', g4xp.try(format('select * from public.consume_social_mobile_x_oauth_state(%L)', g4xp.h('b2'))),
  'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED', 'SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED');
-- P8 the newest state still goes through
select g4xp.chk('P8 consume + complete the newest state', g4xp.consume_(2, 'b2') || '/' || g4xp.complete_(2, 'b2', 'pu_B'), 'OK/OK', 'OK/OK');
reset role;
set role anon;
select g4xp.chk('P9 anon', g4xp.consume_(1, 'a1'), 'permission denied for function consume_social_mobile_x_oauth_state',
  'permission denied for function consume_social_mobile_x_oauth_state');
reset role;

select case when ok then 'PASS' else 'FAIL' end || ' | ' || case_id || ' | expected ' || expected || ' | actual ' || actual
from g4xp.results order by n;
select 'G4XP_RESULT mode=' || current_setting('g4xp.mode') || ' checks=' || count(*) || ' pass=' || count(*) filter (where ok)
  || ' fail=' || count(*) filter (where not ok) from g4xp.results;
do $$ begin
  if exists (select 1 from g4xp.results where not ok) then raise exception 'G4XP_BEHAVIOR_FAIL'; end if;
end $$;
