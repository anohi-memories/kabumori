-- G4-39 (Issue #319) behaviour of the X OAuth begin / complete on a disposable local PG17 (fake Auth, fake Vault, fake G5 authority).
-- Run twice by the runner on fresh databases: mode=current (main's bodies: the defects REPRODUCE) and mode=candidate
-- (001_x_oauth_personal_epoch.sql: they are REFUSED). Each case states both expectations; NULL = not applicable in that mode.
-- Each RPC call runs in its own subtransaction (like one PostgREST request); a refused call leaves nothing behind.
\set ON_ERROR_STOP 1
select set_config('g4xt.mode', :'mode', false);

create schema g4xt;
create table g4xt.results (n serial, case_id text, expected text, actual text, ok boolean);

create function g4xt.u(p int) returns uuid language sql immutable
  as $$ select ('aaaaaaaa-0000-0000-0000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4xt.ws(p int) returns text language sql immutable
  as $$ select 'u_' || substr(md5(g4xt.u(p)::text), 1, 24) $$;
create function g4xt.acct_of(p_brand text) returns text language sql immutable
  as $$ select 'sa_' || substr(md5(p_brand || ':x'), 1, 24) $$;
create function g4xt.h(p_label text) returns text language sql immutable
  as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g4xt.as_user(p int) returns void language sql
  as $$ select set_config('request.jwt.claim.sub', g4xt.u(p)::text, false) $$;
create function g4xt.fake(p_k text, p_v text) returns void language plpgsql as $$
begin
  delete from private.g4x_fake where k = p_k;
  if p_v is not null then insert into private.g4x_fake values (p_k, p_v); end if;
end $$;
create function g4xt.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $$;
create function g4xt.begin_(p int, p_label text) returns text language plpgsql as $$
begin
  perform g4xt.as_user(p);
  return g4xt.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
                         g4xt.h(p_label), 'kabumori://x-callback', now() + interval '10 minutes'));
end $$;
create function g4xt.sid(p_label text) returns uuid language sql
  as $$ select s.id from public.social_account_oauth_states s where s.state_hash = g4xt.h(p_label) $$;
create function g4xt.complete_(p int, p_label text, p_puid text, p_at text default null) returns text language plpgsql as $$
begin
  perform g4xt.as_user(p);
  return g4xt.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
                         g4xt.sid(p_label), p_puid, '@h_' || p_puid, coalesce(p_at, 'fakeXat_' || p_label), 'fakeXrt_' || p_label));
end $$;
create function g4xt.chk(p_case text, p_actual text, p_current text, p_candidate text) returns void language plpgsql as $$
declare v_exp text := case current_setting('g4xt.mode') when 'current' then p_current else p_candidate end;
begin
  if v_exp is null then return; end if;
  insert into g4xt.results (case_id, expected, actual, ok) values (p_case, v_exp, coalesce(p_actual, '<null>'),
    coalesce(p_actual, '<null>') = v_exp);
end $$;
create function g4xt.candidate() returns boolean language sql as $$ select current_setting('g4xt.mode') = 'candidate' $$;
-- candidate-only facts read through dynamic SQL so that mode=current never touches the G4 schema
create function g4xt.epoch(p_acct text) returns text language plpgsql as $$
declare v text;
begin
  if not g4xt.candidate() then return 'n/a'; end if;
  execute 'select connection_epoch::text from postona_g4_x_oauth.connections where social_account_id = $1' into v using p_acct;
  return v;
end $$;
create function g4xt.latest_is(p_acct text, p_label text) returns text language plpgsql as $$
declare v boolean;
begin
  if not g4xt.candidate() then return 'n/a'; end if;
  execute 'select latest_state_id is not distinct from $2 from postona_g4_x_oauth.connections where social_account_id = $1'
    into v using p_acct, g4xt.sid(p_label);
  return v::text;
end $$;
create function g4xt.token(p_acct text) returns text language sql as $$
  select v.secret from public.social_accounts sa join vault.secrets v on v.id = sa.vault_access_token_secret_id where sa.id = p_acct $$;
create function g4xt.owners(p_brand text) returns text language sql as $$
  select count(*)::text from public.brand_memberships m where m.brand_id = p_brand and m.role = 'owner' $$;
create function g4xt.consumed(p_label text) returns text language sql as $$
  select (s.consumed_at is not null)::text from public.social_account_oauth_states s where s.state_hash = g4xt.h(p_label) $$;
create function g4xt.transfer(p_brand text, p_from int, p_to int) returns void language sql as $$
  delete from public.brand_memberships where brand_id = p_brand and user_id = g4xt.u(p_from);
  insert into public.brand_memberships values (p_brand, g4xt.u(p_to), 'owner');
$$;

-- the PRIV cases run the helpers as `authenticated` (test schema only)
grant usage on schema g4xt to authenticated;
grant insert, select on g4xt.results to authenticated;
grant usage on sequence g4xt.results_n_seq to authenticated;

insert into auth.users select g4xt.u(i) from generate_series(1, 40) i on conflict do nothing;
select g4xt.fake('session', 'active');

-- N1 first connection (A=1)
select g4xt.chk('N1 begin, absent workspace', g4xt.begin_(1, 'a1'), 'OK', 'OK');
select g4xt.chk('N1 complete', g4xt.complete_(1, 'a1', 'pu_A'), 'OK', 'OK');
select g4xt.chk('N1 one owner on own workspace', g4xt.owners(g4xt.ws(1)), '1', '1');
select g4xt.chk('N1 identity verified', (select connection_status from public.social_accounts where id = g4xt.acct_of(g4xt.ws(1))),
  'identity_verified', 'identity_verified');
select g4xt.chk('N1 connection epoch 1 -> 2', g4xt.epoch(g4xt.acct_of(g4xt.ws(1))), null, '2');
-- N2 reconnect (A)
select g4xt.chk('N2 reconnect begin (own)', g4xt.begin_(1, 'a2'), 'OK', 'OK');
select g4xt.chk('N2 reconnect complete', g4xt.complete_(1, 'a2', 'pu_A'), 'OK', 'OK');
select g4xt.chk('N2 token replaced', g4xt.token(g4xt.acct_of(g4xt.ws(1))), 'fakeXat_a2', 'fakeXat_a2');
select g4xt.chk('N2 connection epoch -> 3', g4xt.epoch(g4xt.acct_of(g4xt.ws(1))), null, '3');

-- SUP: two begins (B=2); the older state completes after the newer begin
select g4xt.chk('SUP begin b1', g4xt.begin_(2, 'b1'), 'OK', 'OK');
select g4xt.chk('SUP begin b2 (idempotent workspace)', g4xt.begin_(2, 'b2'), 'OK', 'OK');
select g4xt.chk('SUP one owner, one X account', g4xt.owners(g4xt.ws(2)) || '/' ||
  (select count(*) from public.social_accounts where brand_id = g4xt.ws(2))::text, '1/1', '1/1');
select g4xt.chk('SUP older state b1 completes', g4xt.complete_(2, 'b1', 'pu_B'), 'OK', 'OAUTH_STATE_SUPERSEDED');
select g4xt.chk('SUP newest state b2 completes', g4xt.complete_(2, 'b2', 'pu_B'), 'OK', 'OK');

-- B2 legacy brand reuse (L=3 owns 'legacy_L')
insert into public.brands values ('legacy_L', 'Legacy', true, 'manual', 'legacy_v0');
insert into public.brand_memberships values ('legacy_L', g4xt.u(3), 'owner');
select g4xt.chk('B2 begin with a legacy owned brand', g4xt.begin_(3, 'l1'), 'OK', 'OWN_WORKSPACE_CONFLICT');
select g4xt.chk('B2 state written for the legacy brand',
  coalesce((select brand_id from public.social_account_oauth_states where state_hash = g4xt.h('l1')), 'none'), 'legacy_L', 'none');

-- B6 someone else made the derived row (V=4, maker M=5)
insert into public.brands values (g4xt.ws(4), 'My Workspace', false, 'disabled', 'social_mobile_user_v1');
insert into public.brand_memberships values (g4xt.ws(4), g4xt.u(5), 'owner');
select g4xt.chk('B6 begin over a derived row owned by another', g4xt.begin_(4, 'v1'), 'OK', 'OWN_WORKSPACE_CONFLICT');
select g4xt.chk('B6 owners of that row afterwards', g4xt.owners(g4xt.ws(4)), '2', '1');
-- RACE G5 answered 'absent', then the derived row (V's, owned by M) was there at the insert
select g4xt.fake('workspace', 'absent_once');
select g4xt.chk('RACE begin when the row appears after the verdict', g4xt.begin_(4, 'v2'), 'OK', 'OWN_WORKSPACE_CONFLICT');
select g4xt.fake('workspace', null);
select g4xt.chk('RACE owners of that row afterwards', g4xt.owners(g4xt.ws(4)), '2', '1');
-- B6b the derived row exists with no member (W=6)
insert into public.brands values (g4xt.ws(6), 'My Workspace', false, 'disabled', 'social_mobile_user_v1');
select g4xt.chk('B6b begin over an ownerless derived row', g4xt.begin_(6, 'w1'), 'OK', 'WORKSPACE_OWNER_UNKNOWN');
-- B6c another member on the own workspace (O=7, member Q=8)
select g4xt.chk('B6c setup: O connects first', g4xt.begin_(7, 'o1'), 'OK', 'OK');
insert into public.brand_memberships values (g4xt.ws(7), g4xt.u(8), 'member');
select g4xt.chk('B6c begin with another member present', g4xt.begin_(7, 'o2'), 'OK', 'OWN_WORKSPACE_CONFLICT');

-- S1-F2 anonymous / revoked session at begin (Z=9)
select g4xt.fake('session', 'AUTH_REQUIRED');
select g4xt.chk('S1F2 anonymous begin', g4xt.begin_(9, 'z1'), 'OK', 'SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE');
select g4xt.fake('session', 'active');

-- B10 the person owns another brand by the callback (T=10)
select g4xt.chk('B10 begin', g4xt.begin_(10, 't1'), 'OK', 'OK');
insert into public.brands values ('other_T', 'Other', true, 'manual', 'legacy_v0');
insert into public.brand_memberships values ('other_T', g4xt.u(10), 'owner');
select g4xt.chk('B10 complete after owning another brand', g4xt.complete_(10, 't1', 'pu_T'), 'OK', 'OWN_WORKSPACE_CONFLICT');

-- S1-F2 at the callback: the session was revoked between begin and complete (S=11)
select g4xt.chk('SESS begin', g4xt.begin_(11, 's1'), 'OK', 'OK');
select g4xt.fake('session', 'SESSION_REVOKED');
select g4xt.chk('SESS complete after revoke', g4xt.complete_(11, 's1', 'pu_S'), 'OK', 'SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE');
select g4xt.fake('session', 'active');

-- OE owner ABA between begin and complete (E=12, F=13)
select g4xt.chk('OE begin', g4xt.begin_(12, 'e1'), 'OK', 'OK');
select g4xt.transfer(g4xt.ws(12), 12, 13);
select g4xt.transfer(g4xt.ws(12), 13, 12);
select g4xt.chk('OE complete after A -> B -> A', g4xt.complete_(12, 'e1', 'pu_E'), 'OK', 'OWNER_EPOCH_CHANGED');
select g4xt.chk('OE a fresh begin after the ABA connects', g4xt.begin_(12, 'e2') || '/' || g4xt.complete_(12, 'e2', 'pu_E'), null, 'OK/OK');
-- owner moved away for good (G=14, H=15)
select g4xt.chk('OWN begin', g4xt.begin_(14, 'g1'), 'OK', 'OK');
select g4xt.transfer(g4xt.ws(14), 14, 15);
select g4xt.chk('OWN complete after the owner moved', g4xt.complete_(14, 'g1', 'pu_G'),
  'SOCIAL_MOBILE_ACCOUNT_NOT_OWNED', 'OWN_WORKSPACE_CONFLICT');

-- state: duplicate, late, someone else's (I=16, J=17, K=18, P=19)
select g4xt.chk('DUP begin + complete', g4xt.begin_(16, 'i1') || '/' || g4xt.complete_(16, 'i1', 'pu_I'), 'OK/OK', 'OK/OK');
select g4xt.chk('DUP second complete', g4xt.complete_(16, 'i1', 'pu_I'), 'OAUTH_STATE_NOT_CONSUMABLE', 'OAUTH_STATE_NOT_CONSUMABLE');
select g4xt.chk('LATE begin', g4xt.begin_(17, 'j1'), 'OK', 'OK');
update public.social_account_oauth_states set expires_at = now() - interval '1 second' where state_hash = g4xt.h('j1');
select g4xt.chk('LATE complete after expiry', g4xt.complete_(17, 'j1', 'pu_J'), 'OAUTH_STATE_NOT_CONSUMABLE', 'OAUTH_STATE_NOT_CONSUMABLE');
select g4xt.chk('OTHER begin by K', g4xt.begin_(18, 'k1'), 'OK', 'OK');
select g4xt.chk('OTHER complete of K''s state by P', g4xt.complete_(19, 'k1', 'pu_P'), 'OAUTH_STATE_NOT_CONSUMABLE', 'OAUTH_STATE_NOT_CONSUMABLE');
select g4xt.chk('OTHER K still completes', g4xt.complete_(18, 'k1', 'pu_K'), 'OK', 'OK');

-- RB a failure after the claim rolls everything back; the retry connects (Y=20)
select g4xt.chk('RB begin', g4xt.begin_(20, 'y1'), 'OK', 'OK');
set g4x.vault_fail = 'on';
select g4xt.chk('RB complete with Vault down', g4xt.complete_(20, 'y1', 'pu_Y'), 'FAKE_VAULT_UNAVAILABLE', 'FAKE_VAULT_UNAVAILABLE');
set g4x.vault_fail = 'off';
select g4xt.chk('RB state still unconsumed', g4xt.consumed('y1'), 'false', 'false');
select g4xt.chk('RB epoch / latest unchanged', g4xt.epoch(g4xt.acct_of(g4xt.ws(20))) || '/' || g4xt.latest_is(g4xt.acct_of(g4xt.ws(20)), 'y1'),
  null, '1/true');
select g4xt.chk('RB retry connects', g4xt.complete_(20, 'y1', 'pu_Y'), 'OK', 'OK');

-- UQ the X identity is already connected to A: refused, nothing kept (X2=21)
select g4xt.chk('UQ begin', g4xt.begin_(21, 'x1'), 'OK', 'OK');
select g4xt.chk('UQ complete with A''s X identity', g4xt.complete_(21, 'x1', 'pu_A'), 'X_ACCOUNT_ALREADY_CONNECTED', 'X_ACCOUNT_ALREADY_CONNECTED');
select g4xt.chk('UQ state still unconsumed', g4xt.consumed('x1'), 'false', 'false');

-- NULL tokens pass main's empty check (fake Vault stores NULL; real Vault NOT_VERIFIED) (N=22)
select g4xt.chk('NUL begin', g4xt.begin_(22, 'n1'), 'OK', 'OK');
select g4xt.as_user(22);
select g4xt.chk('NUL complete with a NULL access token',
  g4xt.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, null, %L)', g4xt.sid('n1'), 'pu_N', 'h', 'fakeXrt')),
  'OK', 'OAUTH_TOKEN_OR_IDENTITY_INVALID');

-- LEG a state begun under main's body before the candidate was installed (pre-step of the runner; LS=23)
select g4xt.chk('LEG complete of a pre-install state', g4xt.complete_(23, 'legacy_state', 'pu_LS'), 'OK', 'OAUTH_STATE_NOT_BOUND');

-- AUTH G5's answers that are not exactly allow refuse (U2=24)
select g4xt.fake('workspace', 'null');
select g4xt.chk('AUTH workspace verdict NULL', g4xt.begin_(24, 'h1'), 'OK', 'WORKSPACE_VERDICT_UNKNOWN');
select g4xt.fake('workspace', 'maybe');
select g4xt.chk('AUTH workspace verdict unknown text', g4xt.begin_(24, 'h2'), 'OK', 'WORKSPACE_VERDICT_UNKNOWN');
select g4xt.fake('workspace', null);
select g4xt.fake('owner_epoch', 'null');
select g4xt.chk('AUTH owner epoch NULL (absent -> create)', g4xt.begin_(25, 'h3'), 'OK', 'OWNER_EPOCH_UNAVAILABLE');
select g4xt.chk('AUTH nothing created when the epoch is NULL', coalesce((select 'brand' from public.brands where id = g4xt.ws(25)), 'none'),
  'brand', 'none');
select g4xt.fake('owner_epoch', null);

-- candidate-only: disconnect, connection epoch, CAS store, permissions
select g4xt.candidate() as is_candidate \gset
\if :is_candidate
-- DIS disconnect, then a state begun before it (U=26)
select g4xt.chk('DIS connect', g4xt.begin_(26, 'u1') || '/' || g4xt.complete_(26, 'u1', 'pu_U'), null, 'OK/OK');
select g4xt.chk('DIS begin u2', g4xt.begin_(26, 'u2'), null, 'OK');
select g4xt.as_user(26);
select g4xt.chk('DIS disconnect', g4xt.try('select postona_g4_x_oauth.disconnect_x_connection()'), null, 'OK');
select g4xt.chk('DIS status / epoch', (select connection_status from public.social_accounts where id = g4xt.acct_of(g4xt.ws(26)))
  || '/' || g4xt.epoch(g4xt.acct_of(g4xt.ws(26))), null, 'disconnected/3');
select g4xt.chk('DIS pre-disconnect state completes', g4xt.complete_(26, 'u2', 'pu_U'), null, 'OAUTH_STATE_NOT_CONSUMABLE');
select g4xt.chk('DIS reconnect', g4xt.begin_(26, 'u3') || '/' || g4xt.complete_(26, 'u3', 'pu_U'), null, 'OK/OK');
select g4xt.as_user(27);
select g4xt.chk('DIS someone without an X connection', g4xt.try('select postona_g4_x_oauth.disconnect_x_connection()'), null,
  'X_CONNECTION_NOT_FOUND');
-- CE a moved connection epoch refuses an otherwise latest state (R=28)
select g4xt.chk('CE begin', g4xt.begin_(28, 'r1'), null, 'OK');
update postona_g4_x_oauth.connections set connection_epoch = connection_epoch + 1 where social_account_id = g4xt.acct_of(g4xt.ws(28));
select g4xt.chk('CE complete after the epoch moved', g4xt.complete_(28, 'r1', 'pu_R'), null, 'X_CONNECTION_CHANGED');
-- CAS an old token holder after a reconnect (A=1, epoch 3)
select g4xt.chk('CAS epoch before', g4xt.epoch(g4xt.acct_of(g4xt.ws(1))), null, '3');
select g4xt.chk('CAS reconnect', g4xt.begin_(1, 'a3') || '/' || g4xt.complete_(1, 'a3', 'pu_A'), null, 'OK/OK');
select g4xt.chk('CAS old lineage store', g4xt.try(format('select postona_g4_x_oauth.store_refreshed_x_tokens(%L, 3, %L, %L)',
  g4xt.acct_of(g4xt.ws(1)), 'fakeXat_old', 'fakeXrt_old')), null, 'X_CONNECTION_CHANGED');
select g4xt.chk('CAS new token kept', g4xt.token(g4xt.acct_of(g4xt.ws(1))), null, 'fakeXat_a3');
select g4xt.chk('CAS current lineage store', g4xt.try(format('select postona_g4_x_oauth.store_refreshed_x_tokens(%L, 4, %L, %L)',
  g4xt.acct_of(g4xt.ws(1)), 'fakeXat_ref', 'fakeXrt_ref')), null, 'OK');
select g4xt.chk('CAS refreshed token', g4xt.token(g4xt.acct_of(g4xt.ws(1))), null, 'fakeXat_ref');
select g4xt.as_user(26);
select g4xt.try('select postona_g4_x_oauth.disconnect_x_connection()');
select g4xt.chk('CAS store on a disconnected account', g4xt.try(format('select postona_g4_x_oauth.store_refreshed_x_tokens(%L, %s, %L, %L)',
  g4xt.acct_of(g4xt.ws(26)), g4xt.epoch(g4xt.acct_of(g4xt.ws(26))), 'fakeXat_y', 'fakeXrt_y')), null, 'X_CONNECTION_CHANGED');
-- PRIV the API roles reach only the two public functions
select g4xt.chk('PRIV authenticated executes begin / complete',
  (has_function_privilege('authenticated', 'public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)', 'EXECUTE')
   and has_function_privilege('authenticated', 'public.complete_social_mobile_x_oauth_connection(uuid,text,text,text,text)', 'EXECUTE'))::text,
  null, 'true');
select g4xt.chk('PRIV anon executes begin', has_function_privilege('anon', 'public.begin_social_mobile_x_oauth_connection(text,text,timestamptz)',
  'EXECUTE')::text, null, 'false');
set role authenticated;
select g4xt.chk('PRIV authenticated calls disconnect', g4xt.try('select postona_g4_x_oauth.disconnect_x_connection()'), null,
  'permission denied for schema postona_g4_x_oauth');
select g4xt.chk('PRIV authenticated reads connections', g4xt.try('select 1 from postona_g4_x_oauth.connections'), null,
  'permission denied for schema postona_g4_x_oauth');
reset role;
\endif

select case when ok then 'PASS' else 'FAIL' end || ' | ' || case_id || ' | expected ' || expected || ' | actual ' || actual
from g4xt.results order by n;
select 'G4X_RESULT mode=' || current_setting('g4xt.mode') || ' checks=' || count(*) || ' pass=' || count(*) filter (where ok)
  || ' fail=' || count(*) filter (where not ok) from g4xt.results;
do $$ begin
  if exists (select 1 from g4xt.results where not ok) then raise exception 'G4X_BEHAVIOR_FAIL'; end if;
end $$;
