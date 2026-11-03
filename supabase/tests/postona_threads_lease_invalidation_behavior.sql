-- G4-27 (Issue #319): what option A itself must do (001_rotation_lease_invalidation.sql), on the composed world, run after
-- the cr.* prelude of postona_threads_credential_composition_behavior.sql and the cr.claim .. cr.release helpers of
-- postona_threads_rotation_cas_behavior.sql. Fake tokens / fake Vault only. Ends with TRUNCATE (run it in its own database).

-- N1. Every kind of custody write ends exactly that account's lease; another account's lease stays.
select cr.connected(201, 'n1a') as a1 \gset
select cr.connected(202, 'n1b') as a2 \gset
select cr.claim(:'a1')::text as l1 \gset
select cr.claim(:'a2')::text as l2 \gset
select cr.check((:'l1')::jsonb ->> 'status' = 'claimed' and (:'l2')::jsonb ->> 'status' = 'claimed', 'N1 two leases');
update public.threads_account_credential_custody set recorded_by = recorded_by where social_account_id = :'a1';
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a1')
                and exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a2'),
                'N1 UPDATE (even of an unrelated column) ends that account''s lease only');
select cr.check(cr.rotate(:'a1', :'l1', ((:'l1')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days') ->> 'code' = 'LEASE_NOT_HELD',
                'N1 the ended lease cannot rotate');
delete from public.threads_account_credential_custody where social_account_id = :'a2';
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a2'), 'N1 DELETE ends the lease');
-- INSERT: a lease can only exist with a custody row, so the row is removed with the trigger off (test world only).
select cr.claim(:'a1')::text as l1b \gset
alter table public.threads_account_credential_custody disable trigger threads_credential_refresh_lease_invalidate_row;
delete from public.threads_account_credential_custody where social_account_id = :'a1';
alter table public.threads_account_credential_custody enable always trigger threads_credential_refresh_lease_invalidate_row;
select cr.check(exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a1'), 'N1 setup: lease without custody');
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_at, recorded_by)
select a.id, a.vault_access_token_secret_id, clock_timestamp() + interval '30 days', now(), cr.uid(201) from public.social_accounts a where a.id = :'a1';
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a1'), 'N1 INSERT ends the lease');

-- N2. After a reconnect, a NEW claim names the reconnect's version and rotates normally; the old claim is refused.
select cr.connected(203, 'n2') as a3 \gset
select cr.uid(203) as u3 \gset
select cr.claim(:'a3')::text as l3 \gset
select cr.check(cr.t_begin(:'u3', 'n2b') = :'a3' and cr.t_complete(:'u3', 'n2b', '17841400000000203', now() + interval '40 days') = 'OK', 'N2 reconnect');
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a3'), 'N2 the reconnect ended the lease');
select cr.check(cr.rotate(:'a3', :'l3', ((:'l3')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'code' = 'LEASE_NOT_HELD',
                'N2 the pre-reconnect claim is refused');
select cr.claim(:'a3')::text as l3b \gset
select cr.check((:'l3b')::jsonb ->> 'status' = 'claimed'
                and ((:'l3b')::jsonb ->> 'custody_recorded_at')::timestamptz = cr.recorded(:'a3'), 'N2 a new claim names the reconnect''s version');
select cr.check(cr.rotate(:'a3', :'l3b', ((:'l3b')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status' = 'rotated',
                'N2 the new claim rotates');
select cr.h5_write(:'a3', 'fakeTHREADSrefreshOfReconnect_0123456789');
select cr.check(cr.token_of(:'a3') = 'fakeTHREADSrefreshOfReconnect_0123456789', 'N2 the refresh of the reconnect''s token is handed out');
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a3'), 'N2 the rotate used its lease up');

-- N3. Atomicity: a reconnect rolled back (transaction or savepoint) gives the lease back; the claim then rotates.
select cr.connected(204, 'n3') as a4 \gset
select cr.uid(204) as u4 \gset
select cr.claim(:'a4')::text as l4 \gset
begin;
select cr.check(cr.t_begin(:'u4', 'n3b') = :'a4' and cr.t_complete(:'u4', 'n3b', '17841400000000204', now() + interval '40 days') = 'OK', 'N3 reconnect inside');
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'a4'), 'N3 ended inside');
rollback;
select cr.check(exists (select 1 from public.threads_credential_refresh_leases where lease_id = ((:'l4')::jsonb ->> 'lease')::uuid), 'N3 transaction rollback gives the lease back');
begin;
savepoint s;
select cr.check(cr.t_begin(:'u4', 'n3c') = :'a4' and cr.t_complete(:'u4', 'n3c', '17841400000000204', now() + interval '40 days') = 'OK', 'N3 reconnect in a savepoint');
rollback to savepoint s;
commit;
select cr.check(exists (select 1 from public.threads_credential_refresh_leases where lease_id = ((:'l4')::jsonb ->> 'lease')::uuid), 'N3 savepoint rollback gives the lease back');
select cr.check(cr.rotate(:'a4', :'l4', ((:'l4')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status' = 'rotated',
                'N3 the reconnect never happened: the claim rotates');

-- N4. The owner (not a superuser) cannot switch the triggers off with session_replication_role; the triggers fire ALWAYS.
select cr.check(cr.try('set session_replication_role = replica') like 'ERR:permission denied%', 'N4 owner cannot set session_replication_role');
select cr.check((select string_agg(t.tgname || '=' || t.tgenabled::text, ',' order by t.tgname) from pg_catalog.pg_trigger t
                  where t.tgrelid = 'public.threads_account_credential_custody'::regclass and t.tgname like 'threads_credential_refresh_lease_invalidate%')
                = 'threads_credential_refresh_lease_invalidate_row=A,threads_credential_refresh_lease_invalidate_truncate=A', 'N4 audit: both triggers ALWAYS');
select cr.check(not pg_catalog.has_function_privilege(r.oid, 'public.threads_credential_refresh_lease_invalidate()', 'execute'), 'N4 no EXECUTE for ' || r.rolname)
  from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator');

-- N5. TRUNCATE of the custody table ends every lease (last: it empties the table).
select cr.connected(205, 'n5') as a5 \gset
select cr.claim(:'a5')::text as l5 \gset
select cr.claim(:'a4')::text as l4b \gset
select cr.check((select count(*) from public.threads_credential_refresh_leases) >= 2, 'N5 leases before');
truncate public.threads_account_credential_custody;
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases), 'N5 TRUNCATE ends every lease');

select 'POSTONA_THREADS_LEASE_INVALIDATION_BEHAVIOR_DONE' as result;
