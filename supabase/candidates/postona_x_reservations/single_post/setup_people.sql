-- People for the single-post proof: enrolled in POSTONA x_autopost (G5's real RPC), X connected through the guarded live
-- onboarding (PR #257), so G4's TEST DOUBLE (PR #257, built only from what the onboarding records) sees them verified.
-- Records (n, user, account) in t_ids.people for the Deno end to end. Fake identities / tokens only. Run by single_post_run.sh.
\ir ../../postona_x_oauth_t13_guard/helpers.sql
create schema t_ids;
create table t_ids.people (n integer primary key, user_id uuid not null, account text not null);
create function pg_temp.onboard(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('sp' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('sp' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (8000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: complete ' || p_n);
  insert into t_ids.people values (p_n, v_user, v_account);
end $$;
select pg_temp.onboard(n) from generate_series(61, 78) n;
select 'SINGLE_POST_PEOPLE_READY' as result;
