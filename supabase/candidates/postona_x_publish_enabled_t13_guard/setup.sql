-- Shared setup for the publish-switch guard proof (fail_before.sql / behavior.sql): PR #257's helpers plus a person who
-- onboarded X through the (guarded) live RPCs and whose workspace is live. TEST STAND-IN: the owner UPDATE that makes the
-- self-service workspace active / live (another flow's job); fake identities and tokens only.
\ir ../postona_x_oauth_t13_guard/helpers.sql
create function pg_temp.toggle_sql(p_account text, p_desired boolean, p_expected boolean) returns text language sql as $$
  select format('select public.set_social_account_publish_enabled(%L, %L, %L)::text', p_account, p_desired, p_expected) $$;
create function pg_temp.status_of(p_answer text) returns text language sql immutable as $$
  select case when p_answer like 'ERR:%' then p_answer else (p_answer::jsonb ->> 'status') ||
         coalesce(':' || (p_answer::jsonb ->> 'reason'), '') end $$;
create function pg_temp.enabled(p_account text) returns boolean language sql as $$
  select publish_enabled from public.social_accounts where id = p_account $$;
-- A person (enrolled, live session) who connected X through begin -> consume -> complete; workspace made live.
create function pg_temp.onboarded(p_n integer) returns text language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('p' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('p' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (9000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: complete ' || p_n);
  update public.brands set is_active = true, publish_mode = 'live'
   where id = (select brand_id from public.social_accounts where id = v_account);
  return v_account;
end $$;
