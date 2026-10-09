-- Behavior proof for 20261009120000_common_account_deletion_completion (common account Phase 3a, with the
-- PR112 H2 R1-R4 corrective). Fake data only, disposable database only. The runner applies the
-- production-shaped fixtures, the real onboarding RPCs, the real social-mobile deletion candidate,
-- Phase 1, Phase 2 and the candidate. Prints COMMON_ACCOUNT_DELETION_COMPLETION_BEHAVIOR_PASS.
--
-- TEST STAND-INS, never in the candidate: "delete from auth.users" is the managed Auth Admin delete the
-- orchestrator makes (or, where said, a route that bypasses it); "delete from / insert into
-- storage.objects" is the Storage API removing / a still-valid token uploading; "insert into
-- auth.identities" is GoTrue linking an identity; moving owner_lease_expires_at / external_step_started_at
-- into the past is time passing. Section G0 runs on the schema exactly as shipped (release gate
-- blocked); from section A on, the gate is opened by TEST-ONLY DDL so the paths behind it can be proven.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create function pg_temp.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL %', p_label; end if;
end;
$$;
create function pg_temp.error_as(p_role text, p_sql text, p_sub uuid default null) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return null;
exception when others then
  reset role;
  return sqlerrm;
end;
$$;
create function pg_temp.svc(p_sql text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  execute 'set local role service_role';
  execute p_sql into v;
  reset role;
  return v;
end;
$$;
create function pg_temp.usr(p_sub uuid, p_sql text) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  execute 'set local role authenticated';
  execute p_sql into v;
  reset role;
  return v;
end;
$$;
create function pg_temp.uid(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;
create function pg_temp.ws(p_user uuid) returns text language sql as $$ select 'u_' || substr(md5(p_user::text), 1, 24) $$;
create function pg_temp.start(p_user uuid, p_service text) returns jsonb language sql as $$
  select pg_temp.usr(p_user, format('select public.start_%s_service()', p_service))
$$;
create function pg_temp.version(p_user uuid) returns bigint language sql as $$
  select coalesce((select lifecycle_version from public.common_accounts where user_id = p_user), 0)
$$;
create function pg_temp.begin_deletion(p_user uuid, p_version bigint default null) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.begin_common_account_deletion(%L::uuid, %s)', p_user, coalesce(p_version, pg_temp.version(p_user))))
$$;
create function pg_temp.prepare(p_user uuid, p_operation text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.prepare_common_account_auth_delete(%L::uuid, %L::uuid)', p_user, p_operation))
$$;
create function pg_temp.checkpoint(p_user uuid, p_operation text, p_checkpoint text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.record_common_account_deletion_checkpoint(%L::uuid, %L::uuid, %L)', p_user, p_operation, p_checkpoint))
$$;
create function pg_temp.complete(p_user uuid, p_operation text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.complete_common_account_deletion(%L::uuid, %L::uuid)', p_user, p_operation))
$$;
create function pg_temp.storage(p_user uuid, p_limit integer default 1000) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.common_account_deletion_storage_objects(%L::uuid, %s)', p_user, p_limit))
$$;
create function pg_temp.claim(p_user uuid, p_operation text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.claim_common_account_deletion(%L::uuid, %L::uuid, 600)', p_user, p_operation))
$$;
create function pg_temp.renew(p_user uuid, p_operation text, p_lease text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.renew_common_account_deletion_claim(%L::uuid, %L::uuid, %L::uuid, 600)', p_user, p_operation, p_lease))
$$;
create function pg_temp.release(p_user uuid, p_operation text, p_lease text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.release_common_account_deletion_claim(%L::uuid, %L::uuid, %L::uuid)', p_user, p_operation, p_lease))
$$;
create function pg_temp.owned_checkpoint(p_user uuid, p_operation text, p_lease text, p_checkpoint text, p_recorded boolean default true) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.set_owned_common_account_deletion_checkpoint(%L::uuid, %L::uuid, %L::uuid, %L, %L)',
    p_user, p_operation, p_lease, p_checkpoint, p_recorded))
$$;
create function pg_temp.owned_prepare(p_user uuid, p_operation text, p_lease text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.prepare_owned_common_account_auth_delete(%L::uuid, %L::uuid, %L::uuid)', p_user, p_operation, p_lease))
$$;
create function pg_temp.intent(p_user uuid, p_operation text, p_lease text, p_step text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.begin_common_account_deletion_external_step(%L::uuid, %L::uuid, %L::uuid, %L)', p_user, p_operation, p_lease, p_step))
$$;
create function pg_temp.settle(p_user uuid, p_operation text, p_lease text, p_step text, p_outcome text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.settle_common_account_deletion_external_step(%L::uuid, %L::uuid, %L::uuid, %L, %L)', p_user, p_operation, p_lease, p_step, p_outcome))
$$;
create function pg_temp.resolve(p_user uuid, p_operation text, p_resolution text) returns jsonb language sql as $$
  select pg_temp.svc(format('select public.resolve_common_account_deletion_external_step(%L::uuid, %L::uuid, %L)', p_user, p_operation, p_resolution))
$$;
create function pg_temp.op(p_operation text) returns private.account_lifecycle_operations language sql as $$
  select * from private.account_lifecycle_operations where id = p_operation::uuid
$$;
create function pg_temp.expire_lease(p_operation text) returns void language sql as $$
  update private.account_lifecycle_operations set owner_lease_expires_at = now() - interval '1 second' where id = p_operation::uuid
$$;
create function pg_temp.age_step(p_operation text, p_seconds integer) returns void language sql as $$
  update private.account_lifecycle_operations
     set external_step_started_at = now() - make_interval(secs => p_seconds) where id = p_operation::uuid
$$;
create function pg_temp.entitlement(p_user uuid, p_service text) returns text language sql as $$
  select coalesce((select status from public.service_entitlements where user_id = p_user and service_key = p_service), 'none')
$$;
create function pg_temp.ws_rows(p_user uuid) returns bigint language sql as $$
  select (select count(*) from public.brands where id = pg_temp.ws(p_user))
       + (select count(*) from public.brand_memberships where brand_id = pg_temp.ws(p_user) or user_id = p_user)
       + (select count(*) from public.social_accounts where brand_id = pg_temp.ws(p_user))
$$;
-- The real social-mobile saga, social_only scope (the orchestrator's X adapter runs it that way).
create function pg_temp.x_saga(p_user uuid, p_scope text) returns jsonb language plpgsql as $$
declare
  v_acquire jsonb;
  v_lease text;
  v_creds jsonb;
  v_revoked jsonb;
begin
  v_acquire := pg_temp.svc(format('select public.social_mobile_account_deletion_acquire(%L::uuid, %L, false)', p_user, p_scope));
  if v_acquire ->> 'status' <> 'acquired' then return v_acquire; end if;
  v_lease := v_acquire ->> 'lease';
  v_creds := pg_temp.svc(format('select public.social_mobile_account_deletion_credentials(%L::uuid, %L::uuid)', p_user, v_lease));
  select coalesce(jsonb_agg(jsonb_build_object('id', a ->> 'id',
           'access_sha256', encode(sha256(convert_to(a ->> 'access_token', 'UTF8')), 'hex'),
           'refresh_sha256', encode(sha256(convert_to(a ->> 'refresh_token', 'UTF8')), 'hex')) order by a ->> 'id'), '[]'::jsonb)
    into v_revoked
    from jsonb_array_elements(v_creds -> 'accounts') a where (a ->> 'revoke_required')::boolean;
  perform pg_temp.svc(format('select public.social_mobile_account_deletion_mark_x_revoked(%L::uuid, %L::uuid, %L::jsonb)', p_user, v_lease, v_revoked));
  perform pg_temp.svc(format('select public.social_mobile_account_deletion_purge(%L::uuid, %L::uuid)', p_user, v_lease));
  return pg_temp.svc(format('select public.social_mobile_account_deletion_finalize(%L::uuid, %L::uuid)', p_user, v_lease));
end;
$$;
-- A Kabumori-only person whose account deletion is ready (orchestrator steps 1-8, unowned Phase 1 calls
-- are fine for setup). Returns the operation id.
create function pg_temp.ready_kabumori_person(p_user uuid) returns text language plpgsql as $$
declare
  v_op text;
begin
  perform public.fixture_login(p_user);
  perform pg_temp.start(p_user, 'kabumori');
  v_op := pg_temp.begin_deletion(p_user) ->> 'operation_id';
  perform pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', p_user));
  perform pg_temp.checkpoint(p_user, v_op, 'session_revocation');
  perform pg_temp.checkpoint(p_user, v_op, 'storage_cleanup');
  if pg_temp.prepare(p_user, v_op) ->> 'status' <> 'ready_for_managed_auth_delete' then
    raise exception 'FAIL fixture: % is not ready', p_user;
  end if;
  return v_op;
end;
$$;
-- The orchestrator's last two steps for a ready operation: claim, record the managed delete intent
-- (it must answer 'owned'), then the managed delete itself (stand-in). Returns the intent answer.
create function pg_temp.managed_delete(p_user uuid, p_operation text) returns jsonb language plpgsql as $$
declare
  v_lease text := pg_temp.claim(p_user, p_operation) ->> 'lease';
  v_intent jsonb;
begin
  v_intent := pg_temp.intent(p_user, p_operation, v_lease, 'managed_auth_delete');
  if v_intent ->> 'status' = 'owned' then
    delete from auth.users where id = p_user;
  end if;
  return v_intent;
end;
$$;

insert into storage.buckets (id) values ('avatars'), ('reports') on conflict do nothing;

-- G0. The schema as shipped: the managed Auth delete is release-blocked (R3) -------------------------------
select pg_temp.svc('select public.common_account_deletion_release_gate()') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"managed_auth_delete":{"state":"blocked","reason":"IDENTITY_CHANGE_FENCE_MISSING"}}'::jsonb,
  'G0: the release gate reports blocked');
select pg_temp.ready_kabumori_person(pg_temp.uid(490)) as op490 \gset
select pg_temp.claim(pg_temp.uid(490), :'op490') ->> 'lease' as lease490 \gset
select pg_temp.intent(pg_temp.uid(490), :'op490', :'lease490', 'managed_auth_delete') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"release_blocked","reason":"IDENTITY_CHANGE_FENCE_MISSING"}'::jsonb
  and (pg_temp.op(:'op490')).external_step is null and (pg_temp.op(:'op490')).managed_delete_intent_at is null
  and (pg_temp.op(:'op490')).last_error_code = 'MANAGED_AUTH_DELETE_RELEASE_BLOCKED',
  'G0: no managed delete intent can be recorded while the gate is blocked');
select pg_temp.expect(pg_temp.error_as(current_user::text, 'update private.account_lifecycle_release_gates set state = ''open''')
  like '%account_lifecycle_release_gates_blocked_only%', 'G0: no setting opens the gate (only a reviewed migration can)');
-- H2 R3 reproduction on the shipped schema: an Apple identity appears after the final prepare and the
-- login is removed (by a route that bypasses the orchestrator). Before the corrective this completed.
select pg_temp.ready_kabumori_person(pg_temp.uid(491)) as op491 \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(491), 'apple');
select pg_temp.expect(private.account_lifecycle_required_checkpoints(pg_temp.uid(491)) @> array['apple_revocation']
  and not (pg_temp.op(:'op491')).checkpoints ? 'apple_revocation', 'G0/R3: Apple is now required and not revoked');
delete from auth.users where id = pg_temp.uid(491);
select pg_temp.complete(pg_temp.uid(491), :'op491') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_verified","reason":"LOGIN_REMOVED_WITHOUT_MANAGED_INTENT","login_deleted":true}'::jsonb
  and (pg_temp.op(:'op491')).status = 'login_removed', 'G0/R3: H2_R3_LATE_APPLE_COMPLETED_WITHOUT_REVOCATION is now impossible');

-- TEST-ONLY: open the gate so the paths behind it can be proven. Production keeps it blocked by schema.
alter table private.account_lifecycle_release_gates drop constraint account_lifecycle_release_gates_blocked_only;
update private.account_lifecycle_release_gates set state = 'open';

-- A. Kabumori-only person, whole flow at the database level ------------------------------------------
select public.fixture_login(pg_temp.uid(501));
select pg_temp.start(pg_temp.uid(501), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'active', 'A: Kabumori registered');
insert into public.tracked_stocks (user_id) values (pg_temp.uid(501));
select pg_temp.begin_deletion(pg_temp.uid(501), pg_temp.version(pg_temp.uid(501)) - 1) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'lifecycle_changed'
  and not exists (select 1 from private.account_lifecycle_operations where subject_sha256 = public.social_mobile_account_deletion_subject(pg_temp.uid(501))),
  'A: a stale confirmation version begins nothing');
select pg_temp.begin_deletion(pg_temp.uid(501)) as r \gset
select :'r'::jsonb ->> 'operation_id' as op501 \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'started' and :'r'::jsonb -> 'services_to_end' = '["kabumori"]'::jsonb, 'A: deletion begun');
select pg_temp.claim(pg_temp.uid(501), :'op501') as r \gset
select :'r'::jsonb ->> 'lease' as lease501 \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'acquired' and (:'r'::jsonb ->> 'fence')::bigint = 1
  and :'r'::jsonb -> 'recorded_checkpoints' = '[]'::jsonb, 'A: ownership taken (fence 1)');
select pg_temp.start(pg_temp.uid(501), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"ACCOUNT_DELETION_IN_PROGRESS"}'::jsonb, 'A: no start once deletion began');
select pg_temp.owned_prepare(pg_temp.uid(501), :'op501', :'lease501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'SERVICES_REMAIN', 'A: not ready while Kabumori remains');
select pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', pg_temp.uid(501))) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb and not exists (select 1 from public.tracked_stocks where user_id = pg_temp.uid(501)),
  'A: Kabumori withdrawn inside the deletion (its rows gone by cascade)');
select pg_temp.owned_prepare(pg_temp.uid(501), :'op501', :'lease501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_CHECKPOINTS_MISSING', 'A: not ready before the managed checkpoints');
select pg_temp.storage(pg_temp.uid(501)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ok","objects":[],"more":false,"buckets_owned":false}'::jsonb, 'A: nothing in Storage');
select pg_temp.owned_checkpoint(pg_temp.uid(501), :'op501', :'lease501', 'session_revocation') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'recorded', 'A: owned checkpoint');
select pg_temp.owned_checkpoint(pg_temp.uid(501), :'op501', :'lease501', 'storage_cleanup') as r \gset
select pg_temp.owned_prepare(pg_temp.uid(501), :'op501', :'lease501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete', 'A: ready');
select pg_temp.complete(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"login_present","login_deleted":false}'::jsonb
  and (pg_temp.op(:'op501')).status = 'in_progress' and (pg_temp.op(:'op501')).verified_at is null,
  'A: completion while the login exists says so and changes nothing');
select pg_temp.intent(pg_temp.uid(501), :'op501', :'lease501', 'managed_auth_delete') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'owned' and (pg_temp.op(:'op501')).external_step = 'managed_auth_delete'
  and (pg_temp.op(:'op501')).managed_delete_required_checkpoints = array['session_revocation', 'storage_cleanup']
  and (pg_temp.op(:'op501')).managed_delete_identity_providers = array['email'],
  'A: managed delete intent recorded with its evidence (required checkpoints, identity providers)');
delete from auth.users where id = pg_temp.uid(501);
select pg_temp.expect((pg_temp.op(:'op501')).status = 'login_removed' and (pg_temp.op(:'op501')).user_id is null
  and (pg_temp.op(:'op501')).last_error_code = 'LOGIN_REMOVED_WHILE_READY_UNVERIFIED', 'A: the guard records an unverified removal');
select pg_temp.complete(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb = jsonb_build_object('status', 'completed', 'operation_id', :'op501', 'login_deleted', true)
  and (pg_temp.op(:'op501')).status = 'completed' and (pg_temp.op(:'op501')).verified_at is not null
  and (pg_temp.op(:'op501')).last_error_code is null and (pg_temp.op(:'op501')).ready_lifecycle_version is not null
  and (pg_temp.op(:'op501')).external_step is null and (pg_temp.op(:'op501')).owner_lease is null
  and (pg_temp.op(:'op501')).managed_delete_intent_at is not null,
  'A: verified completion; readiness binding and intent evidence kept, owner and step closed');
select pg_temp.release(pg_temp.uid(501), :'op501', :'lease501') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_owned"}'::jsonb, 'A: the completion already gave ownership back');
select pg_temp.complete(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed', 'A: asking again re-checks and is still completed');
select pg_temp.svc(format('select public.common_account_deletion_eligibility(%L::uuid)', pg_temp.uid(501))) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'account_status' = 'none' and :'r'::jsonb -> 'operation' = 'null'::jsonb, 'A: nothing of the person remains');

-- B. Both services: X first through the real saga (social_only keeps the login), then Kabumori ----------
select public.fixture_user_with_workspace(pg_temp.uid(502), 'S502');
select public.fixture_login(pg_temp.uid(502));
select pg_temp.start(pg_temp.uid(502), 'kabumori') as r1 \gset
select pg_temp.start(pg_temp.uid(502), 'x_autopost') as r2 \gset
select pg_temp.begin_deletion(pg_temp.uid(502)) as r \gset
select :'r'::jsonb ->> 'operation_id' as op502 \gset
select pg_temp.expect(:'r'::jsonb -> 'services_to_end' = '["kabumori","x_autopost"]'::jsonb, 'B: both services must end');
select pg_temp.claim(pg_temp.uid(502), :'op502') ->> 'lease' as lease502 \gset
select pg_temp.svc(format('select public.social_mobile_account_deletion_preview(%L::uuid)', pg_temp.uid(502))) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'scope' = 'social_only', 'B: with the Kabumori profile present, X keeps the login');
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''x_autopost'')', pg_temp.uid(502))) ->> 'operation_id' as op502x \gset
select pg_temp.x_saga(pg_temp.uid(502), 'social_only') as r \gset
select pg_temp.expect(:'r'::jsonb @> '{"status":"completed","login_deleted":false}'::jsonb and pg_temp.ws_rows(pg_temp.uid(502)) = 0
  and exists (select 1 from auth.users where id = pg_temp.uid(502)), 'B: X saga removed the workspace, login kept');
select pg_temp.svc(format('select public.finish_service_deletion(%L::uuid, ''x_autopost'', %L::uuid)', pg_temp.uid(502), :'op502x')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb, 'B: X ended');
select pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', pg_temp.uid(502))) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb, 'B: Kabumori ended');
insert into storage.objects (bucket_id, name, owner_id) values ('avatars', 'p502/a.png', pg_temp.uid(502)::text);
insert into storage.objects (bucket_id, name, owner) values ('reports', 'p502/legacy.pdf', pg_temp.uid(502));
insert into storage.objects (bucket_id, name, owner_id) values ('avatars', 'someone-else.png', pg_temp.uid(599)::text);
select pg_temp.owned_checkpoint(pg_temp.uid(502), :'op502', :'lease502', 'session_revocation') as r \gset
select pg_temp.owned_checkpoint(pg_temp.uid(502), :'op502', :'lease502', 'storage_cleanup') as r \gset
select pg_temp.owned_prepare(pg_temp.uid(502), :'op502', :'lease502') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_OWNERSHIP_REMAINS', 'B: a recorded Storage checkpoint does not outweigh visible ownership');
select pg_temp.storage(pg_temp.uid(502), 1) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ok","objects":[{"bucket_id":"avatars","name":"p502/a.png"}],"more":true,"buckets_owned":false}'::jsonb,
  'B: inventory is paged (limit 1, more)');
select pg_temp.storage(pg_temp.uid(502)) as r \gset
select pg_temp.expect(:'r'::jsonb -> 'objects' = '[{"bucket_id":"avatars","name":"p502/a.png"},{"bucket_id":"reports","name":"p502/legacy.pdf"}]'::jsonb
  and :'r'::jsonb ->> 'more' = 'false', 'B: owner_id and the deprecated owner column are both listed; nobody else''s object is');
delete from storage.objects where name = 'p502/a.png';
select pg_temp.storage(pg_temp.uid(502)) as r \gset
select pg_temp.expect(jsonb_array_length(:'r'::jsonb -> 'objects') = 1, 'B: still not empty after the first pass (re-list)');
delete from storage.objects where name = 'p502/legacy.pdf';
select pg_temp.storage(pg_temp.uid(502)) as r \gset
select pg_temp.expect(:'r'::jsonb -> 'objects' = '[]'::jsonb, 'B: empty after the second pass');
select pg_temp.owned_prepare(pg_temp.uid(502), :'op502', :'lease502') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete', 'B: ready');
select pg_temp.intent(pg_temp.uid(502), :'op502', :'lease502', 'managed_auth_delete') as r \gset
delete from auth.users where id = pg_temp.uid(502);
select pg_temp.complete(pg_temp.uid(502), :'op502') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed' and exists (select 1 from storage.objects where name = 'someone-else.png'),
  'B: completed; another person''s object untouched');

-- C. Post-delete verification failures are never completed ---------------------------------------------
-- C1. A still-valid token uploaded after the managed delete intent: Storage ownership remains.
select pg_temp.ready_kabumori_person(pg_temp.uid(503)) as op503 \gset
select pg_temp.claim(pg_temp.uid(503), :'op503') ->> 'lease' as lease503 \gset
select pg_temp.intent(pg_temp.uid(503), :'op503', :'lease503', 'managed_auth_delete') as r \gset
insert into storage.objects (bucket_id, name, owner_id) values ('avatars', 'late.png', pg_temp.uid(503)::text);
delete from auth.users where id = pg_temp.uid(503);
select pg_temp.complete(pg_temp.uid(503), :'op503') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_verified","reason":"MANAGED_STORAGE_OWNED","login_deleted":true}'::jsonb
  and (pg_temp.op(:'op503')).status = 'login_removed' and (pg_temp.op(:'op503')).verified_at is null
  and (pg_temp.op(:'op503')).last_error_code = 'MANAGED_STORAGE_OWNED', 'C1: residual Storage is not verified; reason kept for an operator');
select pg_temp.storage(pg_temp.uid(503)) as r \gset
select pg_temp.expect(:'r'::jsonb -> 'objects' = '[{"bucket_id":"avatars","name":"late.png"}]'::jsonb, 'C1: the residue is listable after the login is gone');
delete from storage.objects where name = 'late.png';
select pg_temp.complete(pg_temp.uid(503), :'op503') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed', 'C1: completed once the residue is removed');
-- C2. An X workspace seen at the intent drops the readiness; one created after the intent is a residue.
select pg_temp.ready_kabumori_person(pg_temp.uid(504)) as op504 \gset
insert into public.brands (id) values (pg_temp.ws(pg_temp.uid(504)));
select pg_temp.managed_delete(pg_temp.uid(504), :'op504') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'not_ready' and exists (select 1 from auth.users where id = pg_temp.uid(504))
  and (pg_temp.op(:'op504')).current_step = 'cleanup', 'C2: a workspace seen at the intent drops the readiness; the login stays');
delete from public.brands where id = pg_temp.ws(pg_temp.uid(504));
select pg_temp.prepare(pg_temp.uid(504), :'op504') as r \gset
select pg_temp.expire_lease(:'op504');
select pg_temp.claim(pg_temp.uid(504), :'op504') ->> 'lease' as lease504 \gset
select pg_temp.intent(pg_temp.uid(504), :'op504', :'lease504', 'managed_auth_delete') as r \gset
insert into public.brands (id) values (pg_temp.ws(pg_temp.uid(504)));
delete from auth.users where id = pg_temp.uid(504);
select pg_temp.complete(pg_temp.uid(504), :'op504') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'RESIDUAL_SERVICE_DATA' and (pg_temp.op(:'op504')).status = 'login_removed', 'C2: residual X workspace is not verified');
delete from public.brands where id = pg_temp.ws(pg_temp.uid(504));
select pg_temp.complete(pg_temp.uid(504), :'op504') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed', 'C2: completed once the workspace is gone');
-- C3. The login was removed while NOT ready (a legacy route during cleanup): never completed.
select public.fixture_login(pg_temp.uid(505));
select pg_temp.start(pg_temp.uid(505), 'kabumori') as r \gset
select pg_temp.begin_deletion(pg_temp.uid(505)) ->> 'operation_id' as op505 \gset
delete from auth.users where id = pg_temp.uid(505);
select pg_temp.expect((pg_temp.op(:'op505')).last_error_code = 'ACCOUNT_REMOVED_EXTERNALLY', 'C3: the guard saw an external removal');
select pg_temp.complete(pg_temp.uid(505), :'op505') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'LOGIN_REMOVED_WITHOUT_MANAGED_INTENT' and (pg_temp.op(:'op505')).status = 'login_removed', 'C3: not verified');
select pg_temp.complete(pg_temp.uid(505), :'op505') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'not_verified', 'C3: and never on a retry');
-- C4. A removed login whose guard was bypassed (operation still in progress).
select pg_temp.ready_kabumori_person(pg_temp.uid(506)) as op506 \gset
alter table public.common_accounts disable trigger account_lifecycle_guard_account_delete;
delete from auth.users where id = pg_temp.uid(506);
alter table public.common_accounts enable trigger account_lifecycle_guard_account_delete;
select pg_temp.complete(pg_temp.uid(506), :'op506') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'LIFECYCLE_STATE_INCONSISTENT' and (pg_temp.op(:'op506')).status = 'in_progress',
  'C4: an operation the guard never closed is not verified');

-- C5. The readiness was withdrawn after the intent (a checkpoint cleared), then the login removed.
select pg_temp.ready_kabumori_person(pg_temp.uid(515)) as op515 \gset
select pg_temp.claim(pg_temp.uid(515), :'op515') ->> 'lease' as lease515 \gset
select pg_temp.intent(pg_temp.uid(515), :'op515', :'lease515', 'managed_auth_delete') as r \gset
select pg_temp.svc(format('select public.clear_common_account_deletion_checkpoint(%L::uuid, %L::uuid, ''storage_cleanup'')', pg_temp.uid(515), :'op515')) as r \gset
delete from auth.users where id = pg_temp.uid(515);
select pg_temp.complete(pg_temp.uid(515), :'op515') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'LOGIN_REMOVED_BEFORE_READY', 'C5: a readiness withdrawn after the intent is not verified');
-- C6. Defense in depth: operator edits after the intent (stand-ins) are never completed.
select pg_temp.ready_kabumori_person(pg_temp.uid(516)) as op516 \gset
select pg_temp.claim(pg_temp.uid(516), :'op516') ->> 'lease' as lease516 \gset
select pg_temp.intent(pg_temp.uid(516), :'op516', :'lease516', 'managed_auth_delete') as r \gset
update private.account_lifecycle_operations set checkpoints = checkpoints - 'session_revocation' where id = :'op516'::uuid;
delete from auth.users where id = pg_temp.uid(516);
select pg_temp.complete(pg_temp.uid(516), :'op516') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_CHECKPOINTS_MISSING', 'C6: a required checkpoint dropped after the intent');
select pg_temp.ready_kabumori_person(pg_temp.uid(517)) as op517 \gset
select pg_temp.claim(pg_temp.uid(517), :'op517') ->> 'lease' as lease517 \gset
select pg_temp.intent(pg_temp.uid(517), :'op517', :'lease517', 'managed_auth_delete') as r \gset
update private.account_lifecycle_operations set managed_delete_required_checkpoints = array['storage_cleanup'] where id = :'op517'::uuid;
delete from auth.users where id = pg_temp.uid(517);
select pg_temp.complete(pg_temp.uid(517), :'op517') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'REQUIRED_CHECKPOINTS_CHANGED', 'C6: an intent decided against other requirements than the readiness');

-- D. Identity and scope of the completion ---------------------------------------------------------------
select pg_temp.ready_kabumori_person(pg_temp.uid(507)) as op507 \gset
select pg_temp.managed_delete(pg_temp.uid(507), :'op507') as r \gset
select pg_temp.complete(pg_temp.uid(508), :'op507') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb and (pg_temp.op(:'op507')).status = 'login_removed',
  'D: another person cannot complete this operation by naming its id');
select pg_temp.complete(pg_temp.uid(507), gen_random_uuid()::text) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb, 'D: unknown operation');
select public.fixture_login(pg_temp.uid(509));
select pg_temp.start(pg_temp.uid(509), 'kabumori') as r \gset
select pg_temp.svc(format('select public.begin_service_deletion(%L::uuid, ''kabumori'')', pg_temp.uid(509))) ->> 'operation_id' as op509k \gset
select pg_temp.complete(pg_temp.uid(509), :'op509k') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb, 'D: a service deletion is not an account deletion');
select pg_temp.claim(pg_temp.uid(509), :'op509k') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb, 'D: a service deletion cannot be owned');
select pg_temp.begin_deletion(pg_temp.uid(509)) ->> 'operation_id' as op509 \gset
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(509), :'op509')) as r \gset
select pg_temp.complete(pg_temp.uid(509), :'op509') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb, 'D: an aborted deletion is never completed');
select pg_temp.claim(pg_temp.uid(509), :'op509') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_in_progress"}'::jsonb, 'D: an aborted deletion cannot be owned');
select pg_temp.expect(pg_temp.error_as('service_role', 'select public.complete_common_account_deletion(null, gen_random_uuid())') like '%ACCOUNT_LIFECYCLE_USER_REQUIRED%',
  'D: a user id is required');
begin isolation level repeatable read;
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.complete_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(507), :'op507'))
  like '%ACCOUNT_LIFECYCLE_REQUIRES_READ_COMMITTED%', 'D: only READ COMMITTED (a snapshot would not see the committed removal)');
rollback;

-- E. The completed shape is enforced by the table, not only by the function ----------------------------
select pg_temp.ready_kabumori_person(pg_temp.uid(510)) as op510 \gset
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'', finished_at = now(), verified_at = now() where id = %L', :'op510'))
  like '%violates check constraint%', 'E: a ready deletion whose login still exists cannot be completed');
delete from auth.users where id = pg_temp.uid(510);
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'', verified_at = now() where id = %L', :'op510'))
  like '%violates check constraint%', 'E: not without a recorded managed delete intent');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'' where id = %L', :'op507'))
  like '%violates check constraint%', 'E: not without a verification time');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'', verified_at = now() where id = %L', :'op505'))
  like '%violates check constraint%', 'E: not for a login removed before readiness');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'', verified_at = now() where id = %L', :'op507'))
  like '%violates check constraint%', 'E: not while the managed delete step is still open');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set verified_at = now() where id = %L', :'op510'))
  like '%violates check constraint%', 'E: a verification time only on a completed account deletion');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set verified_at = now() where id = %L', :'op509k'))
  like '%violates check constraint%', 'E: never on a service deletion');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set owner_lease = gen_random_uuid(), owner_lease_expires_at = now() where id = %L', :'op509k'))
  like '%violates check constraint%', 'E: a service deletion has no owner lease');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set external_step = ''apple_revocation'' where id = %L', :'op490'))
  like '%violates check constraint%', 'E: an external step always has its time and fence');
select pg_temp.expect(pg_temp.error_as(current_user::text, format(
  'insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type, status, finished_at) values (%L, repeat(''a'', 64), ''account_deletion'', ''completed'', now())',
  pg_temp.uid(511))) like '%violates check constraint%', 'E: a completed account deletion cannot be inserted directly');

-- F. Storage inventory edges -------------------------------------------------------------------------
select public.fixture_login(pg_temp.uid(512));
insert into storage.buckets (id, owner_id) values ('private-512', pg_temp.uid(512)::text);
select pg_temp.storage(pg_temp.uid(512)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ok","objects":[],"more":false,"buckets_owned":true}'::jsonb, 'F: an owned bucket is reported');
delete from storage.buckets where id = 'private-512';
insert into storage.buckets (id, owner) values ('legacy-512', pg_temp.uid(512));
select pg_temp.storage(pg_temp.uid(512)) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'buckets_owned' = 'true', 'F: also through the deprecated owner column');
delete from storage.buckets where id = 'legacy-512';
select pg_temp.storage(pg_temp.uid(512), 0) as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ok', 'F: the limit is clamped (0 -> 1)');
select pg_temp.expect(pg_temp.error_as('service_role', 'select public.common_account_deletion_storage_objects(null)') like '%ACCOUNT_LIFECYCLE_USER_REQUIRED%',
  'F: a user id is required (not swallowed as a probe failure)');
begin;
alter table storage.objects rename column owner_id to owner_ref;
select pg_temp.storage(pg_temp.uid(512)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"unknown_shape"}'::jsonb, 'F: an unexpected Storage shape is never "empty"');
rollback;
begin;
alter table storage.objects alter column owner_id type integer using null;
select pg_temp.storage(pg_temp.uid(512)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"probe_failed"}'::jsonb, 'F: a Storage read failure is never "empty"');
rollback;

-- G. Error codes for operators ------------------------------------------------------------------------
select public.fixture_login(pg_temp.uid(513));
select pg_temp.start(pg_temp.uid(513), 'kabumori') as r \gset
select pg_temp.begin_deletion(pg_temp.uid(513)) ->> 'operation_id' as op513 \gset
select pg_temp.svc(format('select public.record_common_account_deletion_error(%L::uuid, %L::uuid, ''X_CLEANUP_FAILED'')', pg_temp.uid(513), :'op513')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"recorded"}'::jsonb and (pg_temp.op(:'op513')).last_error_code = 'X_CLEANUP_FAILED'
  and (pg_temp.op(:'op513')).current_step = 'cleanup', 'G: a fixed code is kept, nothing else changes');
select public.fixture_login(pg_temp.uid(514));
select pg_temp.start(pg_temp.uid(514), 'kabumori') as r \gset
select pg_temp.svc(format('select public.record_common_account_deletion_error(%L::uuid, %L::uuid, ''OTHER_PERSON'')', pg_temp.uid(514), :'op513')) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb and (pg_temp.op(:'op513')).last_error_code = 'X_CLEANUP_FAILED',
  'G: not on another person''s operation');
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.record_common_account_deletion_error(%L::uuid, %L::uuid, ''user@example.invalid'')', pg_temp.uid(513), :'op513'))
  like '%ACCOUNT_LIFECYCLE_ERROR_CODE_INVALID%', 'G: free text (an e-mail) is refused');

-- R1. One owner per open deletion; a stale owner can do nothing ------------------------------------------
select pg_temp.ready_kabumori_person(pg_temp.uid(520)) as op520 \gset
select pg_temp.claim(pg_temp.uid(520), :'op520') as r \gset
select :'r'::jsonb ->> 'lease' as lease520a \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'acquired' and :'r'::jsonb -> 'recorded_checkpoints' = '["session_revocation","storage_cleanup"]'::jsonb,
  'R1: first owner (sees the recorded checkpoints)');
select pg_temp.claim(pg_temp.uid(520), :'op520') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"in_progress"}'::jsonb, 'R1: a second request (any token of the same person) is told the truth: in progress');
select pg_temp.renew(pg_temp.uid(520), :'op520', gen_random_uuid()::text) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"lease_lost"}'::jsonb, 'R1: a guessed lease owns nothing');
select pg_temp.renew(pg_temp.uid(520), :'op520', :'lease520a') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'owned', 'R1: the owner renews');
select pg_temp.expire_lease(:'op520');
select pg_temp.renew(pg_temp.uid(520), :'op520', :'lease520a') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"lease_lost"}'::jsonb, 'R1: an expired lease owns nothing (even before a takeover)');
select pg_temp.claim(pg_temp.uid(520), :'op520') as r \gset
select :'r'::jsonb ->> 'lease' as lease520b \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'acquired' and (:'r'::jsonb ->> 'fence')::bigint = 2, 'R1: an expired owner is taken over (fence moves)');
select pg_temp.expect(pg_temp.renew(pg_temp.uid(520), :'op520', :'lease520a') = '{"status":"lease_lost"}'::jsonb
  and pg_temp.owned_checkpoint(pg_temp.uid(520), :'op520', :'lease520a', 'storage_cleanup', false) = '{"status":"lease_lost"}'::jsonb
  and pg_temp.owned_prepare(pg_temp.uid(520), :'op520', :'lease520a') = '{"status":"lease_lost"}'::jsonb
  and pg_temp.intent(pg_temp.uid(520), :'op520', :'lease520a', 'managed_auth_delete') = '{"status":"lease_lost"}'::jsonb
  and pg_temp.intent(pg_temp.uid(520), :'op520', :'lease520a', 'apple_revocation') = '{"status":"lease_lost"}'::jsonb
  and pg_temp.release(pg_temp.uid(520), :'op520', :'lease520a') = '{"status":"not_owned"}'::jsonb,
  'R1: the stale owner is refused at every step, checkpoint, readiness and intent');
select pg_temp.expect((pg_temp.op(:'op520')).checkpoints ? 'storage_cleanup' and (pg_temp.op(:'op520')).external_step is null
  and (pg_temp.op(:'op520')).owner_lease = :'lease520b'::uuid, 'R1: and changed nothing');
select pg_temp.release(pg_temp.uid(520), :'op520', :'lease520b') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"released"}'::jsonb and (pg_temp.op(:'op520')).owner_lease is null, 'R1: the owner releases');
select pg_temp.claim(pg_temp.uid(520), :'op520') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'acquired' and (:'r'::jsonb ->> 'fence')::bigint = 3, 'R1: and the next request owns it at once');
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.set_owned_common_account_deletion_checkpoint(%L::uuid, %L::uuid, %L::uuid, ''apple_revocation'', true)',
  pg_temp.uid(520), :'op520', :'r'::jsonb ->> 'lease')) like '%ACCOUNT_LIFECYCLE_CHECKPOINT_INVALID%',
  'R1: the Apple checkpoint is never written as a plain checkpoint (only by settling its intent)');
select pg_temp.claim(pg_temp.uid(521), :'op520') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb, 'R1: another person cannot own it');

-- R2. The Apple step: recorded before the call, never replayed when its outcome is unknown --------------
select pg_temp.ready_kabumori_person(pg_temp.uid(530)) as op530 \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(530), 'apple');
select pg_temp.claim(pg_temp.uid(530), :'op530') ->> 'lease' as lease530 \gset
select pg_temp.intent(pg_temp.uid(530), :'op530', :'lease530', 'apple_revocation') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'owned' and (pg_temp.op(:'op530')).external_step = 'apple_revocation', 'R2: intent before the call');
select pg_temp.intent(pg_temp.uid(530), :'op530', :'lease530', 'apple_revocation') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"step_in_flight","step":"apple_revocation"}'::jsonb, 'R2: one in flight at a time');
select pg_temp.intent(pg_temp.uid(530), :'op530', :'lease530', 'managed_auth_delete') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'step_in_flight', 'R2: no managed delete while the Apple step is unsettled');
-- The owner crashes after Apple answered (or the checkpoint write failed): nothing was settled.
select pg_temp.expire_lease(:'op530');
select pg_temp.claim(pg_temp.uid(530), :'op530') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"in_progress","step":"apple_revocation"}'::jsonb, 'R2: within the settle window a takeover waits');
select pg_temp.age_step(:'op530', 901);
select pg_temp.claim(pg_temp.uid(530), :'op530') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"reconciliation_required","step":"apple_revocation"}'::jsonb
  and (pg_temp.op(:'op530')).last_error_code = 'APPLE_REVOCATION_OUTCOME_UNKNOWN' and (pg_temp.op(:'op530')).owner_lease is null
  and not (pg_temp.op(:'op530')).checkpoints ? 'apple_revocation', 'R2: afterwards: reconciliation, never a replay of the single-use code');
select pg_temp.claim(pg_temp.uid(530), :'op530') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'reconciliation_required', 'R2: and it stays that way');
select pg_temp.resolve(pg_temp.uid(530), :'op530', 'apple_revoked') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"resolved","resolution":"apple_revoked"}'::jsonb
  and (pg_temp.op(:'op530')).checkpoints ? 'apple_revocation' and (pg_temp.op(:'op530')).external_step is null,
  'R2: an operator who confirmed the revocation records it');
select pg_temp.claim(pg_temp.uid(530), :'op530') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'acquired', 'R2: then the deletion can continue');
select pg_temp.intent(pg_temp.uid(530), :'op530', :'r'::jsonb ->> 'lease', 'apple_revocation') as r2 \gset
select pg_temp.expect(:'r2'::jsonb = '{"status":"already_recorded"}'::jsonb, 'R2: a recorded revocation is never repeated');
-- Settling: succeeded / failed / lost lease / operator 'not revoked'.
select pg_temp.ready_kabumori_person(pg_temp.uid(531)) as op531 \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(531), 'apple');
select pg_temp.claim(pg_temp.uid(531), :'op531') ->> 'lease' as lease531 \gset
select pg_temp.intent(pg_temp.uid(531), :'op531', :'lease531', 'apple_revocation') as r \gset
select pg_temp.settle(pg_temp.uid(531), :'op531', :'lease531', 'apple_revocation', 'failed') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"cleared"}'::jsonb and (pg_temp.op(:'op531')).external_step is null
  and (pg_temp.op(:'op531')).last_error_code = 'APPLE_REVOKE_FAILED' and not (pg_temp.op(:'op531')).checkpoints ? 'apple_revocation',
  'R2: Apple said no: cleared (a new code may be used)');
select pg_temp.intent(pg_temp.uid(531), :'op531', :'lease531', 'apple_revocation') as r \gset
select pg_temp.settle(pg_temp.uid(531), :'op531', gen_random_uuid()::text, 'apple_revocation', 'succeeded') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"lease_lost"}'::jsonb and (pg_temp.op(:'op531')).external_step = 'apple_revocation',
  'R2: a settle without ownership records nothing; the intent stays (never assumed)');
select pg_temp.settle(pg_temp.uid(531), :'op531', :'lease531', 'apple_revocation', 'succeeded') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"recorded"}'::jsonb and (pg_temp.op(:'op531')).checkpoints ? 'apple_revocation'
  and (pg_temp.op(:'op531')).external_step is null and (pg_temp.op(:'op531')).last_error_code is null,
  'R2: success records the checkpoint and clears the intent in one transaction');
select pg_temp.settle(pg_temp.uid(531), :'op531', :'lease531', 'apple_revocation', 'succeeded') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"step_mismatch"}'::jsonb, 'R2: a second settle changes nothing');
select pg_temp.expect(pg_temp.error_as('service_role', format('select public.settle_common_account_deletion_external_step(%L::uuid, %L::uuid, %L::uuid, ''managed_auth_delete'', ''succeeded'')',
  pg_temp.uid(531), :'op531', :'lease531')) like '%ACCOUNT_LIFECYCLE_STEP_INVALID%', 'R2: a managed delete is never settled as succeeded (only the read-back can)');
select pg_temp.ready_kabumori_person(pg_temp.uid(532)) as op532 \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(532), 'apple');
select pg_temp.claim(pg_temp.uid(532), :'op532') ->> 'lease' as lease532 \gset
select pg_temp.intent(pg_temp.uid(532), :'op532', :'lease532', 'apple_revocation') as r \gset
select pg_temp.resolve(pg_temp.uid(532), :'op532', 'apple_not_revoked') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"in_progress"}'::jsonb, 'R2: no reconciliation while an owner holds the deletion');
select pg_temp.expire_lease(:'op532');
select pg_temp.resolve(pg_temp.uid(532), :'op532', 'apple_not_revoked') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'resolved' and (pg_temp.op(:'op532')).external_step is null
  and not (pg_temp.op(:'op532')).checkpoints ? 'apple_revocation', 'R2: an operator who found it not revoked clears it (new code needed)');

-- R3. The managed delete decision: re-evaluated under the exclusive login lock, with evidence --------------
select pg_temp.ready_kabumori_person(pg_temp.uid(540)) as op540 \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(540), 'apple');
select pg_temp.managed_delete(pg_temp.uid(540), :'op540') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'not_ready' and :'r'::jsonb -> 'reasons' ? 'REQUIRED_CHECKPOINTS_CHANGED'
  and exists (select 1 from auth.users where id = pg_temp.uid(540))
  and (pg_temp.op(:'op540')).current_step = 'cleanup' and (pg_temp.op(:'op540')).managed_delete_intent_at is null,
  'R3: an Apple identity linked after the final prepare refuses the intent and drops the readiness');
-- A route that removes the login anyway is never completed (the requirement is not erased silently).
delete from auth.users where id = pg_temp.uid(540);
select pg_temp.complete(pg_temp.uid(540), :'op540') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'LOGIN_REMOVED_WITHOUT_MANAGED_INTENT', 'R3: and its removal is not verified');
-- Evidence kept after the login is gone.
select pg_temp.expect((pg_temp.op(:'op501')).managed_delete_identity_providers = array['email']
  and (pg_temp.op(:'op501')).managed_delete_required_checkpoints = (pg_temp.op(:'op501')).ready_required_checkpoints,
  'R3: what each managed delete was decided against stays on the operation');
-- An Apple-identity person, the whole owned path: Apple revoked and settled, then the managed delete.
select pg_temp.ready_kabumori_person(pg_temp.uid(541)) as op541 \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(541), 'apple');
select pg_temp.claim(pg_temp.uid(541), :'op541') ->> 'lease' as lease541 \gset
select pg_temp.intent(pg_temp.uid(541), :'op541', :'lease541', 'apple_revocation') as r \gset
select pg_temp.settle(pg_temp.uid(541), :'op541', :'lease541', 'apple_revocation', 'succeeded') as r \gset
select pg_temp.owned_prepare(pg_temp.uid(541), :'op541', :'lease541') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete', 'R3: ready with the Apple checkpoint');
select pg_temp.intent(pg_temp.uid(541), :'op541', :'lease541', 'managed_auth_delete') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'owned'
  and (pg_temp.op(:'op541')).managed_delete_required_checkpoints = array['apple_revocation', 'session_revocation', 'storage_cleanup']
  and (pg_temp.op(:'op541')).managed_delete_identity_providers = array['apple', 'email'], 'R3: intent with the Apple requirement captured');
-- A managed delete that failed with the login still there: settled 'failed', a later owner may retry.
select pg_temp.settle(pg_temp.uid(541), :'op541', :'lease541', 'managed_auth_delete', 'failed') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"cleared"}'::jsonb and (pg_temp.op(:'op541')).external_step is null
  and (pg_temp.op(:'op541')).last_error_code = 'MANAGED_AUTH_DELETE_FAILED', 'R3: a failed managed delete is cleared');
-- An owner that crashed inside the managed delete, the login still there: cleared after the settle window.
select pg_temp.intent(pg_temp.uid(541), :'op541', :'lease541', 'managed_auth_delete') as r \gset
select pg_temp.expire_lease(:'op541');
select pg_temp.claim(pg_temp.uid(541), :'op541') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"in_progress","step":"managed_auth_delete"}'::jsonb, 'R3: a possibly running delete is waited for');
select pg_temp.age_step(:'op541', 901);
select pg_temp.claim(pg_temp.uid(541), :'op541') as r \gset
select :'r'::jsonb ->> 'lease' as lease541b \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'acquired' and (pg_temp.op(:'op541')).external_step is null
  and (pg_temp.op(:'op541')).last_error_code = 'MANAGED_AUTH_DELETE_NOT_APPLIED', 'R3: then, the login being there, it did not happen');
select pg_temp.intent(pg_temp.uid(541), :'op541', :'lease541b', 'managed_auth_delete') as r \gset
delete from auth.users where id = pg_temp.uid(541);
select pg_temp.complete(pg_temp.uid(541), :'op541') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed', 'R3: the Apple-identity person completes with every required checkpoint');
-- DOCUMENTED RESIDUAL -- the reason the release gate stays blocked in the shipped schema: an identity
-- linked AFTER the intent committed and erased by the Auth cascade is invisible to every later check.
-- This path exists here only because the gate was opened by test-only DDL above.
select pg_temp.ready_kabumori_person(pg_temp.uid(542)) as op542 \gset
select pg_temp.claim(pg_temp.uid(542), :'op542') ->> 'lease' as lease542 \gset
select pg_temp.intent(pg_temp.uid(542), :'op542', :'lease542', 'managed_auth_delete') as r \gset
insert into auth.identities (user_id, provider) values (pg_temp.uid(542), 'apple');
delete from auth.users where id = pg_temp.uid(542);
select pg_temp.complete(pg_temp.uid(542), :'op542') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed' and (pg_temp.op(:'op542')).managed_delete_identity_providers = array['email'],
  'R3 RESIDUAL (documented, gate stays blocked): a link after the intent is not observable afterwards');

-- R4. A completed deletion asked again re-checks the residue now ---------------------------------------
select pg_temp.ready_kabumori_person(pg_temp.uid(550)) as op550 \gset
select pg_temp.managed_delete(pg_temp.uid(550), :'op550') as r \gset
select pg_temp.complete(pg_temp.uid(550), :'op550') as r \gset
select (pg_temp.op(:'op550')).verified_at::text as verified550 \gset
insert into storage.objects (bucket_id, name, owner_id) values ('avatars', 'late-token-upload.png', pg_temp.uid(550)::text);
select pg_temp.expect(jsonb_array_length(pg_temp.storage(pg_temp.uid(550)) -> 'objects') = 1, 'R4: a late object is there');
select pg_temp.complete(pg_temp.uid(550), :'op550') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"residue_found","reason":"MANAGED_STORAGE_OWNED","login_deleted":true}'::jsonb
  and (pg_temp.op(:'op550')).status = 'completed' and (pg_temp.op(:'op550')).verified_at::text = :'verified550'
  and (pg_temp.op(:'op550')).last_error_code = 'MANAGED_STORAGE_OWNED',
  'R4: H2_R4_LATE_STORAGE_STILL_COMPLETED is now impossible; the historical verification is kept');
delete from storage.objects where name = 'late-token-upload.png';
select pg_temp.complete(pg_temp.uid(550), :'op550') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed', 'R4: clean again');
insert into public.brands (id) values (pg_temp.ws(pg_temp.uid(550)));
select pg_temp.complete(pg_temp.uid(550), :'op550') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'RESIDUAL_SERVICE_DATA', 'R4: other footprint too');
delete from public.brands where id = pg_temp.ws(pg_temp.uid(550));
begin;
alter table storage.objects rename column owner_id to owner_ref;
select pg_temp.complete(pg_temp.uid(550), :'op550') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_STORAGE_SHAPE_UNKNOWN', 'R4: an unknown inventory is never clean');
rollback;

-- H. Grants: backend only ---------------------------------------------------------------------------
select pg_temp.expect(pg_temp.error_as(r, s, pg_temp.uid(513)) like '%permission denied%', format('H: %s cannot run %s', r, s))
  from unnest(array['anon', 'authenticated']) r,
       unnest(array[format('select public.complete_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(513), :'op513'),
                    format('select public.common_account_deletion_storage_objects(%L::uuid)', pg_temp.uid(513)),
                    format('select public.record_common_account_deletion_error(%L::uuid, %L::uuid, ''X'')', pg_temp.uid(513), :'op513'),
                    format('select public.claim_common_account_deletion(%L::uuid, %L::uuid, 600)', pg_temp.uid(513), :'op513'),
                    format('select public.renew_common_account_deletion_claim(%L::uuid, %L::uuid, gen_random_uuid(), 600)', pg_temp.uid(513), :'op513'),
                    format('select public.release_common_account_deletion_claim(%L::uuid, %L::uuid, gen_random_uuid())', pg_temp.uid(513), :'op513'),
                    format('select public.set_owned_common_account_deletion_checkpoint(%L::uuid, %L::uuid, gen_random_uuid(), ''storage_cleanup'', true)', pg_temp.uid(513), :'op513'),
                    format('select public.prepare_owned_common_account_auth_delete(%L::uuid, %L::uuid, gen_random_uuid())', pg_temp.uid(513), :'op513'),
                    format('select public.begin_common_account_deletion_external_step(%L::uuid, %L::uuid, gen_random_uuid(), ''apple_revocation'')', pg_temp.uid(513), :'op513'),
                    format('select public.settle_common_account_deletion_external_step(%L::uuid, %L::uuid, gen_random_uuid(), ''apple_revocation'', ''failed'')', pg_temp.uid(513), :'op513'),
                    format('select public.resolve_common_account_deletion_external_step(%L::uuid, %L::uuid, ''apple_revoked'')', pg_temp.uid(513), :'op513'),
                    'select public.common_account_deletion_release_gate()',
                    format('select private.account_lifecycle_storage_inventory(%L::uuid, 1)', pg_temp.uid(513)),
                    format('select private.account_lifecycle_residue(%L::uuid)', pg_temp.uid(513)),
                    'select private.account_lifecycle_gate_open(''managed_auth_delete'')',
                    format('select private.account_lifecycle_owned_operation(%L::uuid, %L::uuid, gen_random_uuid())', pg_temp.uid(513), :'op513')]) s;
select pg_temp.expect(pg_temp.error_as('service_role', s) like '%permission denied%', format('H: the backend role cannot run the private helper %s', s))
  from unnest(array[format('select private.account_lifecycle_storage_inventory(%L::uuid, 1)', pg_temp.uid(513)),
                    format('select private.account_lifecycle_residue(%L::uuid)', pg_temp.uid(513)),
                    'select private.account_lifecycle_gate_open(''managed_auth_delete'')',
                    format('select private.account_lifecycle_owned_operation(%L::uuid, %L::uuid, gen_random_uuid())', pg_temp.uid(513), :'op513'),
                    'select count(*) from private.account_lifecycle_release_gates']) s;
select pg_temp.expect(not has_function_privilege('authenticated', 'public.complete_common_account_deletion(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.complete_common_account_deletion(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.claim_common_account_deletion(uuid,uuid,integer)', 'execute')
  and has_function_privilege('service_role', 'public.begin_common_account_deletion_external_step(uuid,uuid,uuid,text)', 'execute'), 'H: service_role only');
select pg_temp.expect((select auth_delete_guard from private.account_lifecycle_settings) = 'shadow', 'H: the guard is still shadow');

select 'COMMON_ACCOUNT_DELETION_COMPLETION_BEHAVIOR_PASS';
