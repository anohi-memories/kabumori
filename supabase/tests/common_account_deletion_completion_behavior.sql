-- Behavior proof for 20261009120000_common_account_deletion_completion (common account Phase 3a).
-- Fake data only, disposable database only. The runner applies the production-shaped fixtures, the
-- real onboarding RPCs, the real social-mobile deletion candidate, Phase 1, Phase 2 and the candidate.
-- Prints COMMON_ACCOUNT_DELETION_COMPLETION_BEHAVIOR_PASS.
--
-- TEST STAND-INS, never in the candidate: "delete from auth.users" is the managed Auth Admin delete
-- the orchestrator makes; "delete from storage.objects" / "insert into storage.objects" are the
-- Storage API removing / a still-valid token uploading.
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
create function pg_temp.op(p_operation text) returns private.account_lifecycle_operations language sql as $$
  select * from private.account_lifecycle_operations where id = p_operation::uuid
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
-- A Kabumori-only person whose account deletion is ready (orchestrator steps 1-8). Returns the op id.
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

insert into storage.buckets (id) values ('avatars'), ('reports') on conflict do nothing;

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
select pg_temp.start(pg_temp.uid(501), 'kabumori') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"blocked","reason":"ACCOUNT_DELETION_IN_PROGRESS"}'::jsonb, 'A: no start once deletion began');
select pg_temp.prepare(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'SERVICES_REMAIN', 'A: not ready while Kabumori remains');
select pg_temp.svc(format('select public.withdraw_kabumori_service(%L::uuid)', pg_temp.uid(501))) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ended"}'::jsonb and not exists (select 1 from public.tracked_stocks where user_id = pg_temp.uid(501)),
  'A: Kabumori withdrawn inside the deletion (its rows gone by cascade)');
select pg_temp.prepare(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'MANAGED_CHECKPOINTS_MISSING', 'A: not ready before the managed checkpoints');
select pg_temp.storage(pg_temp.uid(501)) as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"ok","objects":[],"more":false,"buckets_owned":false}'::jsonb, 'A: nothing in Storage');
select pg_temp.checkpoint(pg_temp.uid(501), :'op501', 'session_revocation') as r \gset
select pg_temp.checkpoint(pg_temp.uid(501), :'op501', 'storage_cleanup') as r \gset
select pg_temp.prepare(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete', 'A: ready');
select pg_temp.complete(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"login_present","login_deleted":false}'::jsonb
  and (pg_temp.op(:'op501')).status = 'in_progress' and (pg_temp.op(:'op501')).verified_at is null,
  'A: completion while the login exists says so and changes nothing');
delete from auth.users where id = pg_temp.uid(501);
select pg_temp.expect((pg_temp.op(:'op501')).status = 'login_removed' and (pg_temp.op(:'op501')).user_id is null
  and (pg_temp.op(:'op501')).last_error_code = 'LOGIN_REMOVED_WHILE_READY_UNVERIFIED', 'A: the guard records an unverified removal');
select pg_temp.complete(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb = jsonb_build_object('status', 'completed', 'operation_id', :'op501', 'login_deleted', true)
  and (pg_temp.op(:'op501')).status = 'completed' and (pg_temp.op(:'op501')).verified_at is not null
  and (pg_temp.op(:'op501')).last_error_code is null and (pg_temp.op(:'op501')).ready_lifecycle_version is not null
  and (pg_temp.op(:'op501')).current_step = 'ready_for_managed_auth_delete',
  'A: verified completion, readiness binding kept as audit');
select pg_temp.complete(pg_temp.uid(501), :'op501') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed', 'A: completion is idempotent');
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
select pg_temp.checkpoint(pg_temp.uid(502), :'op502', 'session_revocation') as r \gset
select pg_temp.checkpoint(pg_temp.uid(502), :'op502', 'storage_cleanup') as r \gset
select pg_temp.prepare(pg_temp.uid(502), :'op502') as r \gset
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
select pg_temp.prepare(pg_temp.uid(502), :'op502') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'ready_for_managed_auth_delete', 'B: ready');
delete from auth.users where id = pg_temp.uid(502);
select pg_temp.complete(pg_temp.uid(502), :'op502') as r \gset
select pg_temp.expect(:'r'::jsonb ->> 'status' = 'completed' and exists (select 1 from storage.objects where name = 'someone-else.png'),
  'B: completed; another person''s object untouched');

-- C. Post-delete verification failures are never completed ---------------------------------------------
-- C1. A still-valid token uploaded after the revalidation: Storage ownership remains.
select pg_temp.ready_kabumori_person(pg_temp.uid(503)) as op503 \gset
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
-- C2. A still-valid token re-created an X workspace after the X cleanup.
select pg_temp.ready_kabumori_person(pg_temp.uid(504)) as op504 \gset
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
select pg_temp.expect(:'r'::jsonb ->> 'reason' = 'LOGIN_REMOVED_BEFORE_READY' and (pg_temp.op(:'op505')).status = 'login_removed', 'C3: not verified');
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

-- D. Identity and scope of the completion ---------------------------------------------------------------
select pg_temp.ready_kabumori_person(pg_temp.uid(507)) as op507 \gset
delete from auth.users where id = pg_temp.uid(507);
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
select pg_temp.begin_deletion(pg_temp.uid(509)) ->> 'operation_id' as op509 \gset
select pg_temp.svc(format('select public.abort_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(509), :'op509')) as r \gset
select pg_temp.complete(pg_temp.uid(509), :'op509') as r \gset
select pg_temp.expect(:'r'::jsonb = '{"status":"not_found"}'::jsonb, 'D: an aborted deletion is never completed');
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
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'' where id = %L', :'op510'))
  like '%violates check constraint%', 'E: not without a verification time');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set status = ''completed'', verified_at = now() where id = %L', :'op505'))
  like '%violates check constraint%', 'E: not for a login removed before readiness');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set verified_at = now() where id = %L', :'op510'))
  like '%violates check constraint%', 'E: a verification time only on a completed account deletion');
select pg_temp.expect(pg_temp.error_as(current_user::text, format('update private.account_lifecycle_operations set verified_at = now() where id = %L', :'op509k'))
  like '%violates check constraint%', 'E: never on a service deletion');
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

-- H. Grants: backend only ---------------------------------------------------------------------------
select pg_temp.expect(pg_temp.error_as(r, s, pg_temp.uid(513)) like '%permission denied%', format('H: %s cannot run %s', r, s))
  from unnest(array['anon', 'authenticated']) r,
       unnest(array[format('select public.complete_common_account_deletion(%L::uuid, %L::uuid)', pg_temp.uid(513), :'op513'),
                    format('select public.common_account_deletion_storage_objects(%L::uuid)', pg_temp.uid(513)),
                    format('select public.record_common_account_deletion_error(%L::uuid, %L::uuid, ''X'')', pg_temp.uid(513), :'op513'),
                    format('select private.account_lifecycle_storage_inventory(%L::uuid, 1)', pg_temp.uid(513))]) s;
select pg_temp.expect(pg_temp.error_as('service_role', format('select private.account_lifecycle_storage_inventory(%L::uuid, 1)', pg_temp.uid(513))) like '%permission denied%',
  'H: the private helper is not callable by the backend role either');
select pg_temp.expect(not has_function_privilege('authenticated', 'public.complete_common_account_deletion(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.complete_common_account_deletion(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.common_account_deletion_storage_objects(uuid,integer)', 'execute')
  and has_function_privilege('service_role', 'public.record_common_account_deletion_error(uuid,uuid,text)', 'execute'), 'H: service_role only');
select pg_temp.expect((select auth_delete_guard from private.account_lifecycle_settings) = 'shadow', 'H: the guard is still shadow');

select 'COMMON_ACCOUNT_DELETION_COMPLETION_BEHAVIOR_PASS';
