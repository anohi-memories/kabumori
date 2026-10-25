-- G3 TASK 28/50 (Issue #318): the X reservation candidates against the personal-workspace / owner contracts of G4-35 (PR #484) and
-- G5-26 (PR #485) -- the cases G3-25 / G3-26 did not cover: a shared workspace, a person who owns another brand, a legacy (not u_<md5>)
-- workspace, an owner A -> B -> A churn, a workspace whose kind changed. Throw-away LOCAL PostgreSQL only, fake people / sessions /
-- claims; the X candidates 001-006 read at PR #392's head by run.sh (unchanged). Prepended by run.sh with the T13 guard helpers.
-- It RECORDS today's answers; run.sh pins them. Where the user / command has not decided (multi-owner, legacy workspaces) the
-- answer is PENDING_POLICY: recorded, never compared with an expected value. Where only a proposal exists (owner-epoch binding as
-- Threads 007 does, a workspace-state check as the single-post fence does), the difference is listed as PROPOSED, not a PASS / FAIL.
create schema t_wd;
create table t_wd.results (scenario text, step text, actual text, primary key (scenario, step));
create table t_wd.people (n integer primary key, user_id uuid not null, account text not null, brand text not null, session uuid not null);

create function pg_temp.as_role_sql(p_role text, p_sql text, p_claims jsonb) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  execute format('set local role %I', p_role);
  execute p_sql into v;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok:' || coalesce(v, '<null>');
exception when others then
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ERR:' || split_part(sqlerrm, ' ', 1);
end $$;
create function pg_temp.c(p_n integer) returns jsonb language sql as $$
  select jsonb_build_object('sub', user_id, 'role', 'authenticated', 'session_id', session) from t_wd.people where n = p_n $$;
create function pg_temp.api(p_n integer, p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_api', p_sql, pg_temp.c(p_n)) $$;
create function pg_temp.worker(p_sql text) returns text language sql as $$ select pg_temp.as_role_sql('postona_resv_worker', p_sql, null) $$;
create function pg_temp.u(p_n integer) returns uuid language sql as $$ select user_id from t_wd.people where n = p_n $$;
create function pg_temp.a(p_n integer) returns text language sql as $$ select account from t_wd.people where n = p_n $$;
create function pg_temp.b(p_n integer) returns text language sql as $$ select brand from t_wd.people where n = p_n $$;
create function pg_temp.rec(p_s text, p_step text, p_v text) returns void language sql as $$ insert into t_wd.results values (p_s, p_step, p_v) $$;

create function pg_temp.person(p_n integer) returns void language plpgsql as $$
declare v_user uuid := pg_temp.enrolled(p_n); v_session uuid := pg_temp.session(pg_temp.uid(p_n)); v_account text; v_state uuid;
begin
  v_account := pg_temp.as_person(pg_temp.begin_sql('wd' || p_n), v_user, v_session);
  v_state := pg_temp.as_person(pg_temp.consume_sql('wd' || p_n), v_user, v_session)::uuid;
  perform pg_temp.expect(pg_temp.as_person(pg_temp.complete_sql(v_state, (5000 + p_n)::text), v_user, v_session) not like 'ERR:%', 'setup: connect ' || p_n);
  update public.social_accounts set publish_enabled = true where id = v_account;
  insert into t_wd.people values (p_n, v_user, v_account, (select sa.brand_id from public.social_accounts sa where sa.id = v_account), v_session);
end $$;
-- the person-facing create (one planned reservation 3 days ahead); 'ok:<id>' or 'ERR:<code>'
create function pg_temp.create1(p_n integer, p_tag text) returns text language sql as $$
  select pg_temp.api(p_n, format('select string_agg(reservation_id::text, '','') from postona_x_resv.create_batch(%L, gen_random_uuid(), 1, ''manual_exact'', null, %L::jsonb)',
    pg_temp.a(p_n), jsonb_build_array(jsonb_build_object('draft_id', 'wd_' || p_tag,
      'scheduled_at', ((now() at time zone 'Asia/Tokyo')::date + 3 + time '10:00' + case when p_tag like '%b' then interval '4 hours' else interval '0' end) at time zone 'Asia/Tokyo', 'body', 'WD ' || p_tag,
      'consent', jsonb_build_object('confirmed', true, 'content_sha256', encode(sha256(convert_to('WD ' || p_tag, 'UTF8')), 'hex')))))) $$;
create function pg_temp.make_due(p_id uuid) returns void language sql as $$
  update postona_x_resv.reservations set scheduled_at = now() - interval '1 minute', consent_scheduled_at = now() - interval '1 minute',
         expires_at = now() + interval '6 hours' where id = p_id $$;
create function pg_temp.claimed(p_id uuid) returns text language plpgsql as $$
declare v text := pg_temp.worker('select coalesce(string_agg(reservation_id::text, '',''), ''-'') from postona_x_resv.claim_due(''wd_worker'', 60, 50)');
begin
  return case when v !~ '^ok:' then v when position(p_id::text in v) > 0 then 'claimed' else 'not_claimed' end;
end $$;
create function pg_temp.begin1(p_n integer, p_tag text) returns text language sql as $$
  select pg_temp.api(p_n, format('select state from postona_x_resv.post_now_begin(%L, gen_random_uuid(), %L, %L)', pg_temp.a(p_n), 'WD single ' || p_tag,
    encode(sha256(convert_to('WD single ' || p_tag, 'UTF8')), 'hex'))) $$;
create function pg_temp.st(p_id uuid) returns text language sql as $$
  select coalesce((select status || '/' || coalesce(outcome_code, '-') from postona_x_resv.reservations where id = p_id), 'gone') $$;
create function pg_temp.ws(p_n integer) returns text language sql as $$
  select case when pg_temp.b(p_n) = 'u_' || left(md5(pg_temp.u(p_n)::text), 24) then 'u_md5' else 'other:' || pg_temp.b(p_n) end $$;

select pg_temp.person(n) from generate_series(301, 309) n;

-- W0 the ordinary person: their own u_<md5> workspace, sole owner -> create / claim / single post work
select pg_temp.rec('W0_ordinary', 'workspace_id', pg_temp.ws(301));
select pg_temp.create1(301, 'W0') as w0 \gset
select pg_temp.rec('W0_ordinary', 'create_batch', case when :'w0' ~ '^ok:' then 'ok' else :'w0' end);
select pg_temp.make_due(substr(:'w0', 4)::uuid);
select pg_temp.rec('W0_ordinary', 'worker_claim', pg_temp.claimed(substr(:'w0', 4)::uuid));
select pg_temp.rec('W0_ordinary', 'post_now_begin', pg_temp.begin1(301, 'W0'));

-- W1 a shared workspace: a second owner (person 309) is added to 302's workspace AFTER a reservation exists       [PENDING_POLICY]
select pg_temp.create1(302, 'W1') as w1 \gset
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.b(302), pg_temp.u(309), 'owner');
select pg_temp.create1(302, 'W1b') as w1b \gset
select pg_temp.rec('W1_shared_workspace', 'create_batch_after_share', case when :'w1b' ~ '^ok:' then 'ok' else :'w1b' end);
select pg_temp.make_due(substr(:'w1', 4)::uuid);
select pg_temp.rec('W1_shared_workspace', 'worker_claim', pg_temp.claimed(substr(:'w1', 4)::uuid));
select pg_temp.rec('W1_shared_workspace', 'post_now_begin', pg_temp.begin1(302, 'W1'));

-- W2 the person also owns another brand L (social_mobile_user_v1, sole owner)                                      [PENDING_POLICY]
insert into public.brands (id, code_profile_key) values ('wd_legacy_303', 'social_mobile_user_v1');
insert into public.brand_memberships (brand_id, user_id, role) values ('wd_legacy_303', pg_temp.u(303), 'owner');
select pg_temp.create1(303, 'W2') as w2 \gset
select pg_temp.rec('W2_owns_another_brand', 'create_batch', case when :'w2' ~ '^ok:' then 'ok' else :'w2' end);
select pg_temp.make_due(substr(:'w2', 4)::uuid);
select pg_temp.rec('W2_owns_another_brand', 'worker_claim', pg_temp.claimed(substr(:'w2', 4)::uuid));
select pg_temp.rec('W2_owns_another_brand', 'post_now_begin', pg_temp.begin1(303, 'W2'));

-- W3 a legacy workspace: the X account lives in a brand whose id is NOT u_<md5> (kind social_mobile_user_v1, sole owner) [PENDING_POLICY]
insert into public.brands (id, code_profile_key) values ('wd_legacy_304', 'social_mobile_user_v1');
insert into public.brand_memberships (brand_id, user_id, role) values ('wd_legacy_304', pg_temp.u(304), 'owner');
update public.social_accounts set brand_id = 'wd_legacy_304' where id = pg_temp.a(304);
update t_wd.people set brand = 'wd_legacy_304' where n = 304;
select pg_temp.rec('W3_legacy_workspace', 'workspace_id', pg_temp.ws(304));
select pg_temp.create1(304, 'W3') as w3 \gset
select pg_temp.rec('W3_legacy_workspace', 'create_batch', case when :'w3' ~ '^ok:' then 'ok' else :'w3' end);
select pg_temp.rec('W3_legacy_workspace', 'post_now_begin', pg_temp.begin1(304, 'W3'));

-- W4 owner churn A -> B -> A after A's reservation was made (old permission)                                      [PROPOSED]
select pg_temp.create1(305, 'W4') as w4 \gset
select pg_temp.make_due(substr(:'w4', 4)::uuid);
delete from public.brand_memberships where brand_id = pg_temp.b(305) and user_id = pg_temp.u(305);
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.b(305), pg_temp.u(308), 'owner');
select pg_temp.rec('W4_owner_churn_ABA', 'worker_claim_while_B_owns', pg_temp.claimed(substr(:'w4', 4)::uuid));
delete from public.brand_memberships where brand_id = pg_temp.b(305) and user_id = pg_temp.u(308);
insert into public.brand_memberships (brand_id, user_id, role) values (pg_temp.b(305), pg_temp.u(305), 'owner');
select pg_temp.rec('W4_owner_churn_ABA', 'worker_claim_after_A_again', pg_temp.claimed(substr(:'w4', 4)::uuid));
select pg_temp.rec('W4_owner_churn_ABA', 'row_after', pg_temp.st(substr(:'w4', 4)::uuid));

-- W5 the workspace kind changes after a reservation was made (no longer social_mobile_user_v1)                    [PROPOSED]
select pg_temp.create1(306, 'W5') as w5 \gset
select pg_temp.make_due(substr(:'w5', 4)::uuid);
update public.brands set code_profile_key = 'wd_not_self_service' where id = pg_temp.b(306);
select pg_temp.create1(306, 'W5b') as w5b \gset
select pg_temp.rec('W5_kind_changed', 'create_batch_after', case when :'w5b' ~ '^ok:' then 'ok' else :'w5b' end);
select pg_temp.rec('W5_kind_changed', 'worker_claim', pg_temp.claimed(substr(:'w5', 4)::uuid));
select pg_temp.rec('W5_kind_changed', 'post_now_begin', pg_temp.begin1(306, 'W5'));

select pg_temp.expect((select count(*) from postona_x_resv.reservations where status = 'published' or provider_post_id is not null) = 0, 'nothing published');
select format('RESULT|%s|%s|%s', scenario, step, actual) from t_wd.results order by scenario, step;
select 'X_WORKSPACE_OWNER_DELTA_MATRIX_DONE';
