-- People for the 006 live-fence proof: as ../single_post/setup_people.sql (enrolled through G5's real RPC, X connected
-- through PR #257's guarded onboarding, so G4's TEST DOUBLE sees them verified), numbers 61-99, publish switch OFF as the
-- onboarding leaves it. Fake identities / tokens only. Run by single_post_live_fence_run.sh.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
create schema t_ids;
create table t_ids.people (n integer primary key, user_id uuid not null, account text not null, brand text not null);
create function pg_temp.onboard(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('lf' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('lf' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (9000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: complete ' || p_n);
  insert into t_ids.people values (p_n, v_user, v_account, (select sa.brand_id from public.social_accounts sa where sa.id = v_account));
end $$;
select pg_temp.onboard(n) from generate_series(61, 99) n;
select pg_temp.expect((select bool_and(not sa.publish_enabled) from public.social_accounts sa join t_ids.people p on p.account = sa.id), 'setup: switches OFF');
select 'LIVE_FENCE_PEOPLE_READY' as result;
