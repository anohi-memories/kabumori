-- G4-40 (Issue #319) X OAuth on the PRODUCT SHAPE with main's X refresh core (20260925140000) on a disposable local PG17
-- (fake Auth, fake Vault, fake G5). Run by the runner in three modes on fresh databases:
--   current = main's begin / complete      c001 = + 001 (PR #511)      wired = + 001 + 002 (this TASK)
-- Each case states the three expectations (NULL = not applicable). Each call runs in its own subtransaction (one request).
\set ON_ERROR_STOP 1
select set_config('g4xw.mode', :'mode', false);

create schema g4xw;
create table g4xw.results (n serial, case_id text, expected text, actual text, ok boolean);
create table g4xw.leases (label text primary key, token uuid);

create function g4xw.u(p int) returns uuid language sql immutable
  as $$ select ('aaaaaaaa-0000-0000-0000-' || lpad(p::text, 12, '0'))::uuid $$;
create function g4xw.ws(p int) returns text language sql immutable
  as $$ select 'u_' || substr(md5(g4xw.u(p)::text), 1, 24) $$;
create function g4xw.acct(p int) returns text language sql immutable
  as $$ select 'sa_' || substr(md5(g4xw.ws(p) || ':x'), 1, 24) $$;
create function g4xw.h(p_label text) returns text language sql immutable
  as $$ select md5(p_label) || md5(p_label || '#') $$;
create function g4xw.as_user(p int) returns void language sql
  as $$ select set_config('request.jwt.claim.sub', g4xw.u(p)::text, false) $$;
create function g4xw.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlerrm;
end $$;
create function g4xw.connect_(p int, p_label text, p_puid text) returns text language plpgsql as $$
declare v_begin text; v_complete text;
begin
  perform g4xw.as_user(p);
  v_begin := g4xw.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
                             g4xw.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
  if v_begin <> 'OK' then return v_begin; end if;
  v_complete := g4xw.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
    (select s.id from public.social_account_oauth_states s where s.state_hash = g4xw.h(p_label)), p_puid, '@h_' || p_puid,
    'fakeXat_' || p_label, 'fakeXrt_' || p_label));
  return 'OK/' || v_complete;
end $$;
-- begin only / complete only (the runner's two-session cases)
create function g4xw.begin_only(p int, p_label text) returns text language plpgsql as $$
begin
  perform g4xw.as_user(p);
  return g4xw.try(format('select * from public.begin_social_mobile_x_oauth_connection(%L, %L, %L)',
                         g4xw.h(p_label), 'kabumori-social://oauth-callback', now() + interval '10 minutes'));
end $$;
create function g4xw.complete_only(p int, p_label text, p_puid text) returns text language plpgsql as $$
begin
  perform g4xw.as_user(p);
  return g4xw.try(format('select public.complete_social_mobile_x_oauth_connection(%L, %L, %L, %L, %L)',
    (select s.id from public.social_account_oauth_states s where s.state_hash = g4xw.h(p_label)), p_puid, '@h_' || p_puid,
    'fakeXat_' || p_label, 'fakeXrt_' || p_label));
end $$;
create function g4xw.disconnect_(p int) returns text language plpgsql as $$
begin
  perform g4xw.as_user(p);
  if to_regprocedure('postona_g4_x_oauth.disconnect_x_connection()') is null then return 'absent'; end if;
  return g4xw.try('select postona_g4_x_oauth.disconnect_x_connection()');
end $$;
-- a running legacy post for p's workspace, publishing switched on (the stand-in for set_social_account_publish_enabled)
create function g4xw.post(p int, p_label text) returns uuid language plpgsql as $$
declare v uuid := md5(p_label)::uuid;
begin
  update public.social_accounts set publish_enabled = true where id = g4xw.acct(p);
  insert into public.scheduled_posts (id, brand_id, status, attempt_count) values (v, g4xw.ws(p), 'running', 1);
  return v;
end $$;
create function g4xw.lease(p int, p_label text) returns text language plpgsql as $$
declare v uuid;
begin
  select l.lease_token into v from public.begin_x_account_refresh_legacy_post(g4xw.post(p, p_label), g4xw.acct(p), g4xw.ws(p)) l;
  insert into g4xw.leases values (p_label, v);
  return 'OK';
exception when others then
  return sqlerrm;
end $$;
create function g4xw.commit_(p int, p_label text, p_at text) returns text language plpgsql as $$
begin
  return public.commit_x_account_refresh_legacy_post((select l.token from g4xw.leases l where l.label = p_label), g4xw.acct(p),
    p_at, p_at || '_rt', 3600);
exception when others then
  return sqlerrm;
end $$;
create function g4xw.token(p int) returns text language sql as $$
  select v.secret from public.social_accounts sa join vault.secrets v on v.id = sa.vault_access_token_secret_id where sa.id = g4xw.acct(p) $$;
create function g4xw.refresh_status(p int) returns text language sql as $$
  select coalesce((select st.status || '/' || coalesce(st.last_error_code, '-') from public.x_account_refresh_state_v2 st
                   where st.social_account_id = g4xw.acct(p)), 'none') $$;
create function g4xw.account(p int) returns text language sql as $$
  select coalesce((select sa.connection_status || '/' || sa.publish_enabled from public.social_accounts sa where sa.id = g4xw.acct(p)),
                  'none') $$;
create function g4xw.chk(p_case text, p_actual text, p_current text, p_c001 text, p_wired text) returns void language plpgsql as $$
declare v_exp text := case current_setting('g4xw.mode') when 'current' then p_current when 'c001' then p_c001 else p_wired end;
begin
  if v_exp is null then return; end if;
  insert into g4xw.results (case_id, expected, actual, ok)
  values (p_case, v_exp, coalesce(p_actual, '<null>'), coalesce(p_actual, '<null>') = v_exp);
end $$;

insert into auth.users select g4xw.u(i) from generate_series(1, 20) i on conflict do nothing;

-- P connect, refresh, reconnect while a lease is in flight (A=1)
select g4xw.chk('P1 connect', g4xw.connect_(1, 'a1', 'pu_A'), 'OK/OK', 'OK/OK', 'OK/OK');
select g4xw.chk('P2 refresh lease', g4xw.lease(1, 'r1'), 'OK', 'OK', 'OK');
select g4xw.chk('P2 refresh commit', g4xw.commit_(1, 'r1', 'fakeXat_r1'), 'committed', 'committed', 'committed');
select g4xw.chk('P2 refreshed token', g4xw.token(1), 'fakeXat_r1', 'fakeXat_r1', 'fakeXat_r1');
select g4xw.chk('P3 lease before a reconnect', g4xw.lease(1, 'r2'), 'OK', 'OK', 'OK');
select g4xw.chk('P3 reconnect while the lease is in flight', g4xw.connect_(1, 'a2', 'pu_A'), 'OK/OK', 'OK/OK', 'OK/OK');
select g4xw.chk('P3 old lease commit', g4xw.commit_(1, 'r2', 'fakeXat_stale'), 'account_changed', 'account_changed', 'account_changed');
select g4xw.chk('P3 reconnect token kept', g4xw.token(1), 'fakeXat_a2', 'fakeXat_a2', 'fakeXat_a2');
-- R-1 (main, refresh owner): the reset trigger ran at the reconnect, while the lease was still 'refreshing'; the late commit then
-- blocks the account until ANOTHER reconnect
select g4xw.chk('R1 state after the old commit', g4xw.refresh_status(1),
  'uncertain/X_REFRESH_ACCOUNT_CHANGED', 'uncertain/X_REFRESH_ACCOUNT_CHANGED', 'uncertain/X_REFRESH_ACCOUNT_CHANGED');
select g4xw.chk('R1 publishing is off after any reconnect', g4xw.account(1), 'identity_verified/false', 'identity_verified/false',
  'identity_verified/false');
select g4xw.chk('R1 refresh blocked', g4xw.lease(1, 'r3'), 'X_REFRESH_BLOCKED_UNCERTAIN', 'X_REFRESH_BLOCKED_UNCERTAIN',
  'X_REFRESH_BLOCKED_UNCERTAIN');
select g4xw.chk('R1 a second reconnect clears it', g4xw.connect_(1, 'a3', 'pu_A') || ' ' || g4xw.refresh_status(1),
  'OK/OK idle/-', 'OK/OK idle/-', 'OK/OK idle/-');
select g4xw.chk('R1 refresh works again', g4xw.lease(1, 'r4') || ' ' || g4xw.commit_(1, 'r4', 'fakeXat_r4'),
  'OK committed', 'OK committed', 'OK committed');

-- W1 disconnect on the product CHECK (A)
select g4xw.chk('W1 disconnect', g4xw.disconnect_(1), 'absent',
  'new row for relation "social_accounts" violates check constraint "social_accounts_connection_status_check"', 'OK');
select g4xw.chk('W1 account after disconnect', g4xw.account(1), null, null, 'unconnected/false');
select g4xw.chk('W1 refresh refused after disconnect', g4xw.lease(1, 'r5'), null, null, 'X_ACCOUNT_NOT_VERIFIED');
select g4xw.chk('W1 reconnect after disconnect', g4xw.connect_(1, 'a4', 'pu_A') || ' ' || g4xw.account(1), null, null,
  'OK/OK identity_verified/false');

-- W1b disconnect while a lease is in flight (B=2)
select g4xw.chk('W1b connect + lease', g4xw.connect_(2, 'b1', 'pu_B') || ' ' || g4xw.lease(2, 'q1'), 'OK/OK OK', 'OK/OK OK', 'OK/OK OK');
select g4xw.chk('W1b disconnect', g4xw.disconnect_(2), null, null, 'OK');
select g4xw.chk('W1b old lease commit after disconnect', g4xw.commit_(2, 'q1', 'fakeXat_q1'), null, null, 'account_changed');
select g4xw.chk('W1b token not replaced', g4xw.token(2), null, null, 'fakeXat_b1');
select g4xw.chk('W1b reconnect clears the block', g4xw.connect_(2, 'b2', 'pu_B') || ' ' || g4xw.refresh_status(2), null, null,
  'OK/OK idle/-');

-- W2 a second token writer next to the refresh lease (C=3)
select g4xw.chk('W2 connect + lease', g4xw.connect_(3, 'c1', 'pu_C') || ' ' || g4xw.lease(3, 'w1'), 'OK/OK OK', 'OK/OK OK', 'OK/OK OK');
select g4xw.chk('W2 the CAS writer exists',
  case when to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)') is null then 'absent' else 'present' end,
  'absent', 'present', 'absent');
select g4xw.chk('W2 CAS store during the lease', case when current_setting('g4xw.mode') = 'c001' then
  g4xw.try(format('select postona_g4_x_oauth.store_refreshed_x_tokens(%L, (select c.connection_epoch from postona_g4_x_oauth.connections c'
    || ' where c.social_account_id = %L), %L, %L)', g4xw.acct(3), g4xw.acct(3), 'fakeXat_cas', 'fakeXrt_cas')) end, null, 'OK', null);
select g4xw.chk('W2 lease commit after it', g4xw.commit_(3, 'w1', 'fakeXat_lease'), 'committed', 'committed', 'committed');
select g4xw.chk('W2 final token (c001: the CAS write is silently replaced)', g4xw.token(3), 'fakeXat_lease', 'fakeXat_lease', 'fakeXat_lease');

-- B2 / B6 on the product shape (user impact: refused instead of bound to another brand)
insert into public.brands values ('legacy_l4', 'Legacy', true, 'manual', 'legacy_v0');
insert into public.brand_memberships values ('legacy_l4', g4xw.u(4), 'owner');
select g4xw.chk('B2 one legacy owned brand', g4xw.connect_(4, 'l1', 'pu_L'), 'OK/OK', 'OWN_WORKSPACE_CONFLICT', 'OWN_WORKSPACE_CONFLICT');
insert into public.brands values (g4xw.ws(5), 'My Workspace', false, 'disabled', 'social_mobile_user_v1');
insert into public.brand_memberships values (g4xw.ws(5), g4xw.u(6), 'owner');
select g4xw.chk('B6 derived row owned by another', g4xw.connect_(5, 'v1', 'pu_V'), 'OK/OK', 'OWN_WORKSPACE_CONFLICT', 'OWN_WORKSPACE_CONFLICT');

-- product guards stay in force around the candidate
select g4xw.chk('G provider guard trigger present', (select count(*)::text from pg_trigger where tgname = 'social_accounts_provider_guard'),
  '1', '1', '1');
select g4xw.chk('G one X account per workspace', g4xw.try(format(
  'insert into public.social_accounts (id, brand_id, platform, handle, publish_enabled, oauth_client_ref, connection_status) values (%L, %L, %L, %L, false, %L, %L)',
  'sa_dup', g4xw.ws(1), 'x', 'h', 'default', 'unconnected')),
  'duplicate key value violates unique constraint "social_accounts_brand_id_platform_key"',
  'duplicate key value violates unique constraint "social_accounts_brand_id_platform_key"',
  'duplicate key value violates unique constraint "social_accounts_brand_id_platform_key"');

select case when ok then 'PASS' else 'FAIL' end || ' | ' || case_id || ' | expected ' || expected || ' | actual ' || actual
from g4xw.results order by n;
select 'G4XW_RESULT mode=' || current_setting('g4xw.mode') || ' checks=' || count(*) || ' pass=' || count(*) filter (where ok)
  || ' fail=' || count(*) filter (where not ok) from g4xw.results;
do $$ begin
  if exists (select 1 from g4xw.results where not ok) then raise exception 'G4XW_BEHAVIOR_FAIL'; end if;
end $$;
