-- People for the Threads reservation proof (numbers 61-99): enrolled + X-onboarded through G5's real RPC and PR #257's
-- guarded onboarding (so each has a social_mobile_user_v1 workspace with a single owner), then ONE Threads account in
-- that workspace (TEST DATA written by the owner role: G4's real Threads connection is not part of this proof):
-- identity_verified, publish switch ON, an access reference (fake uuid), no refresh reference, custody recorded,
-- listed as verified (G4 double) and entitled (G5 double). Fake identities only.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
create schema t_ids;
create table t_ids.people (n integer primary key, user_id uuid not null, x_account text not null, threads_account text not null, brand text not null);
create function pg_temp.onboard(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid; v_brand text;
        v_threads text := 'th_' || p_n;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('g3th' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('g3th' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (7000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: complete ' || p_n);
  select sa.brand_id into v_brand from public.social_accounts sa where sa.id = v_account;
  insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at,
    vault_access_token_secret_id, vault_refresh_token_secret_id)
  values (v_threads, v_brand, 'threads', '@th' || p_n, (17841400000000000 + p_n)::text, true, 'identity_verified', now(), gen_random_uuid(), null);
  insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
  values (v_threads, gen_random_uuid(), now() + interval '50 days', v_user);
  insert into t_threads.verified values (v_threads);
  insert into t_threads.entitlement values (v_user, 'active');
  insert into t_ids.people values (p_n, v_user, v_account, v_threads, v_brand);
end $$;
select pg_temp.onboard(n) from generate_series(61, 99) n;
select pg_temp.expect((select count(*) from public.social_accounts where platform = 'threads') = 39, 'setup: 39 Threads accounts');
select 'THREADS_PEOPLE_READY' as result;
