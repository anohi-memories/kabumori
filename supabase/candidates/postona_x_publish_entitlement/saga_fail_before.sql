-- Fail-before for the X saga stop (run by saga_run.sh BEFORE 002 is applied, on the unchanged saga SQL):
--   (1) a Stage 3B publish-authority row makes the purge fail (NO ACTION reference to social_accounts);
--   (2) without it, a reservation IN FLIGHT (claimed) is silently removed by the purge's cascade.
-- TEST STAND-INS: owner inserts build the workspaces, authority row and reservations. Fake data only.
\set ON_ERROR_STOP 1
create function pg_temp.svc(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  set local role service_role;
  execute p_sql into v;
  reset role;
  return coalesce(v, '<null>');
exception when others then
  reset role;
  return 'ERR:' || sqlerrm;
end $$;
-- The unchanged saga, step by step: acquire -> credentials -> mark_x_revoked (exact fingerprints) -> purge.
create function pg_temp.old_saga_purge(p_user uuid) returns text language plpgsql as $$
declare v_lease text; v_revoked jsonb;
begin
  v_lease := pg_temp.svc(format('select public.social_mobile_account_deletion_acquire(%L, ''social_only'', false) ->> ''lease''', p_user));
  perform pg_temp.svc(format('select public.social_mobile_account_deletion_credentials(%L, %L)::text', p_user, v_lease));
  select jsonb_agg(jsonb_build_object('id', a.id, 'access_sha256', public.social_mobile_account_deletion_fingerprint(a.vault_access_token_secret_id),
                                      'refresh_sha256', public.social_mobile_account_deletion_fingerprint(a.vault_refresh_token_secret_id)))
    into v_revoked from public.social_accounts a where a.brand_id = public.social_mobile_account_deletion_workspace(p_user);
  perform pg_temp.svc(format('select public.social_mobile_account_deletion_mark_x_revoked(%L, %L, %L::jsonb)::text', p_user, v_lease, v_revoked));
  return pg_temp.svc(format('select public.social_mobile_account_deletion_purge(%L, %L)::text', p_user, v_lease));
end $$;

-- A person with an active Kabumori service (the profiles row exists => scope social_only), as G5's own suites build it.
create function pg_temp.kabumori_person(p_user uuid) returns void language plpgsql as $$
declare v text;
begin
  perform public.fixture_login(p_user);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
  v := public.start_kabumori_service() ->> 'status';
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  if v is distinct from 'active' then raise exception 'FAIL setup kabumori %', v; end if;
  insert into public.profiles (id) values (p_user) on conflict do nothing;
end $$;

\set f1 00000000-0000-4000-8000-0000000000f1
\set f2 00000000-0000-4000-8000-0000000000f2
select pg_temp.kabumori_person(:'f1');
select pg_temp.kabumori_person(:'f2');
select public.fixture_user_with_workspace(:'f1', 'fbone') as ws1 \gset
select public.fixture_user_with_workspace(:'f2', 'fbtwo') as ws2 \gset
insert into public.x_account_publish_authority (social_account_id, state, starts_at, expires_at, reason_code)
  select id, 'enabled', now() - interval '1 minute', now() + interval '1 day', 'TEST_STAND_IN' from public.social_accounts where brand_id = :'ws1';
select 'FB1:' || pg_temp.old_saga_purge(:'f1') as fb1;
insert into postona_x_resv.batches (id, user_id, brand_id, social_account_id, client_batch_id, revision, mode, origin, time_zone, band, payload_sha256)
  select 'fb000000-0000-4000-8000-000000000002', :'f2', :'ws2', id, gen_random_uuid(), 1, 'manual_exact', 'user_authored', 'Asia/Tokyo', null, repeat('a', 64)
    from public.social_accounts where brand_id = :'ws2';
insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
  scheduled_at, fixed, status, consent_state, expires_at, lease_token, lease_expires_at)
  select 'fb000000-0000-4000-8000-000000000002', :'f2', :'ws2', id, 'inflight', 0, 'user_authored', 'manual_exact', 'b', repeat('c', 64),
         now(), true, 'claimed', 'confirmed', now() + interval '6 hours', gen_random_uuid(), now() + interval '2 minutes'
    from public.social_accounts where brand_id = :'ws2';
select pg_temp.old_saga_purge(:'f2') as fb2_purge \gset
select 'FB2:' || :'fb2_purge' || ':claimed_left=' || (select count(*) from postona_x_resv.reservations where draft_id = 'inflight') as fb2;
