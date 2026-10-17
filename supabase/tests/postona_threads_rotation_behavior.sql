-- F4 POSTONA Threads credential rotation (threads_credential_rotation_candidate.sql), one session, on the real G5
-- world + postona_threads_t13_fixture.sql + postona_threads_rotation_fixture.sql. Run by
-- postona_threads_rotation_run.sh as the owner (the role H5's owner transport uses). Every value is fake.
\set ON_ERROR_STOP 1
set timezone = 'UTC';
create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as $$ select true $$;

-- 0. No API role reaches the lease table or any new function.
do $$
declare r text; s text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    foreach s in array array[
      'select 1 from public.threads_credential_refresh_leases',
      'select public.claim_threads_credential_refresh(''threads_x'')',
      'select public.rotate_threads_credential_custody(''threads_x'', gen_random_uuid(), gen_random_uuid(), now(), now() + interval ''1 day'')',
      'select public.release_threads_credential_refresh(''threads_x'', gen_random_uuid())',
      'select public.threads_credential_publish_in_flight(''threads_x'')',
      'select public.threads_credential_refresh_owner(''u_x'')'] loop
      perform t13.check(t13.try_as(r, s) = '42501', 'ACL ' || r || ': ' || s);
    end loop;
  end loop;
end $$;

-- 1. The refresh, end to end: claim (no token), H5's one transaction (rotate + Vault write of the same secret), and
--    the publish release then hands out the rotated token.
select t13.person('00000000-0000-4000-8000-0000000001a1', 'rota') as acct_a \gset
select a.vault_access_token_secret_id as secret_a from public.social_accounts a where a.id = :'acct_a' \gset
select rot.claim(:'acct_a') as c_a \gset
select t13.check(:'c_a'::jsonb ->> 'status' = 'claimed', '1 claim');
select t13.check((:'c_a'::jsonb)::text !~ 'fake_threads_', '1 the claim answer carries no token');
select t13.check(:'c_a'::jsonb ->> 'vault_secret_id' = :'secret_a', '1 the claim names the stored secret');
select t13.check((select count(*) from public.threads_credential_refresh_leases l
                  where l.social_account_id = :'acct_a' and l.lease_id = (:'c_a'::jsonb ->> 'lease')::uuid
                    and l.owner_user_id = '00000000-0000-4000-8000-0000000001a1'
                    and l.brand_id = public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-0000000001a1')
                    and l.lease_expires_at <= clock_timestamp() + interval '60 seconds') = 1, '1 the lease is bound to account, workspace and owner');
begin;
select rot.h5_rotate(:'acct_a', :'c_a'::jsonb, 'fake_threads_rota_ROTATED_0123456789') as r_a \gset
commit;
select t13.check(:'r_a'::jsonb ->> 'status' = 'rotated', '1 rotated: ' || :'r_a');
select t13.check((:'r_a'::jsonb)::text !~ 'fake_threads_', '1 the rotate answer carries no token');
select t13.check((select c.expires_at = (:'r_a'::jsonb ->> 'expires_at')::timestamptz and c.recorded_at = (:'r_a'::jsonb ->> 'recorded_at')::timestamptz
                         and c.recorded_at > (:'c_a'::jsonb ->> 'custody_recorded_at')::timestamptz and c.vault_secret_id = :'secret_a'
                         and c.recorded_by = '00000000-0000-4000-8000-0000000001a1'
                  from public.threads_account_credential_custody c where c.social_account_id = :'acct_a'), '1 custody rotated');
select t13.check(public.threads_account_credential_expires_at(:'acct_a') = (:'r_a'::jsonb ->> 'expires_at')::timestamptz, '1 the reader accepts the rotated record');
select t13.check(not exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_a'), '1 the lease is consumed');
select t13.check((select a.vault_access_token_secret_id from public.social_accounts a where a.id = :'acct_a') = :'secret_a'
                 and (select s.secret from vault.secrets s where s.id = :'secret_a') = 'fake_threads_rota_ROTATED_0123456789', '1 same secret id, new value');
select t13.as_user('00000000-0000-4000-8000-0000000001a1', 'begin', :'acct_a', 'aaaaaaaa-0000-4000-8000-0000000001a1', 'after rotation') -> 'attempt' ->> 'attempt_id' as att_a \gset
select t13.release('00000000-0000-4000-8000-0000000001a1', :'att_a'::uuid, 'create_container') as rel_a \gset
select t13.check(:'rel_a'::jsonb ->> 'status' = 'released' and :'rel_a'::jsonb ->> 'access_token' = 'fake_threads_rota_ROTATED_0123456789',
                 '1 the publish release hands out the rotated token');

-- 2. A post in flight: no claim, no rotate (a released token may be in use); a reserved attempt and an ended grant
--    do not block. A refused rotate keeps the lease.
select rot.refused(format('select rot.claim(%L)', :'acct_a'), 'PUBLISH_IN_FLIGHT', '2 claim while creating_container');
select t13.record('00000000-0000-4000-8000-0000000001a1', :'att_a'::uuid, 'create_container', :'rel_a'::jsonb ->> 'grant', 'failed', 'THREADS_UNAVAILABLE') ->> 'status' as rec_a \gset
select t13.check(:'rec_a' = 'recorded', '2 the post is closed');
select t13.as_user('00000000-0000-4000-8000-0000000001a1', 'begin', :'acct_a', 'aaaaaaaa-0000-4000-8000-0000000002a1', 'reserved only') -> 'attempt' ->> 'attempt_id' as att_a2 \gset
select rot.claim(:'acct_a') as c_a2 \gset
select t13.check(:'c_a2'::jsonb ->> 'status' = 'claimed', '2 a reserved attempt does not block the claim');
update public.threads_manual_publish_attempts
   set status = 'container_created', container_id = '1784140000000001', grant_hash = repeat('a', 64), grant_step = 'check_container',
       grant_state = 'redeemed', grant_expires_at = clock_timestamp() + interval '5 minutes',
       grant_user_id = '00000000-0000-4000-8000-0000000001a1', grant_session_id = t13.session_of('00000000-0000-4000-8000-0000000001a1')
 where id = :'att_a2'::uuid;
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_a', :'c_a2'), 'PUBLISH_IN_FLIGHT', '2 rotate while a grant is live');
update public.threads_manual_publish_attempts set status = 'publishing' , grant_hash = null, grant_step = null, grant_state = null,
       grant_expires_at = null, grant_user_id = null, grant_session_id = null where id = :'att_a2'::uuid;
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_a', :'c_a2'), 'PUBLISH_IN_FLIGHT', '2 rotate while publishing');
update public.threads_manual_publish_attempts set status = 'container_created', grant_hash = repeat('b', 64), grant_step = 'check_container',
       grant_state = 'redeemed', grant_expires_at = clock_timestamp() - interval '1 second',
       grant_user_id = '00000000-0000-4000-8000-0000000001a1', grant_session_id = t13.session_of('00000000-0000-4000-8000-0000000001a1')
 where id = :'att_a2'::uuid;
begin;
select rot.h5_rotate(:'acct_a', :'c_a2'::jsonb, 'fake_threads_rota_ROTATED2_0123456789') as r_a2 \gset
commit;
select t13.check(:'r_a2'::jsonb ->> 'status' = 'rotated', '2 an ended grant does not block; the refused rotates kept the lease: ' || :'r_a2');

-- 3. Replay: the consumed lease never rotates again, even with the CURRENT expected values; a fresh lease with the
--    old expected values is stale.
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_a', :'c_a2'), 'LEASE_NOT_HELD', '3 the same rotate again');
select rot.refused(format('select rot.rotate(%L, %L::jsonb, p_recorded => %L::timestamptz)', :'acct_a', :'c_a2', :'r_a2'::jsonb ->> 'recorded_at'),
                   'LEASE_NOT_HELD', '3 the consumed lease with the current version');
select rot.claim(:'acct_a') as c_a3 \gset
select rot.refused(format('select rot.rotate(%L, %L::jsonb, p_recorded => %L::timestamptz)', :'acct_a', :'c_a3', :'c_a2'::jsonb ->> 'custody_recorded_at'),
                   'STALE_CREDENTIAL', '3 a fresh lease with the old version');
select rot.refused(format('select rot.rotate(%L, %L::jsonb, p_lease => %L::uuid)', :'acct_a', :'c_a3', gen_random_uuid()),
                   'LEASE_NOT_HELD', '3 no such lease');
select t13.check(public.release_threads_credential_refresh(:'acct_a', (:'c_a3'::jsonb ->> 'lease')::uuid) ->> 'status' = 'released', '3 release');

-- 4. Another person's account, lease or secret is never reached.
select t13.person('00000000-0000-4000-8000-0000000001b1', 'rotb') as acct_b \gset
select rot.claim(:'acct_b') as c_b \gset
select rot.claim(:'acct_a') as c_a4 \gset
select rot.refused(format('select rot.rotate(%L, %L::jsonb, p_lease => %L::uuid)', :'acct_a', :'c_a4', :'c_b'::jsonb ->> 'lease'),
                   'LEASE_NOT_HELD', '4 B''s lease on A''s account');
select rot.refused(format('select rot.rotate(%L, %L::jsonb, p_lease => %L::uuid)', :'acct_b', :'c_b', :'c_a4'::jsonb ->> 'lease'),
                   'LEASE_NOT_HELD', '4 A''s lease on B''s account');
select rot.refused(format('select rot.rotate(%L, %L::jsonb, p_secret => %L::uuid)', :'acct_b', :'c_b', :'c_a4'::jsonb ->> 'vault_secret_id'),
                   'STALE_CREDENTIAL', '4 A''s secret id with B''s own lease and version');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_b', :'c_a4'), 'LEASE_NOT_HELD', '4 A''s whole claim on B''s account');
update public.threads_credential_refresh_leases set brand_id = public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-0000000001a1')
 where social_account_id = :'acct_b';
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_b', :'c_b'), 'WORKSPACE_CHANGED', '4 a lease taken for another workspace');
select t13.check(public.release_threads_credential_refresh(:'acct_b', (:'c_b'::jsonb ->> 'lease')::uuid) ->> 'status' = 'released'
                 and public.release_threads_credential_refresh(:'acct_a', (:'c_a4'::jsonb ->> 'lease')::uuid) ->> 'status' = 'released', '4 release');

-- 5. The workspace owner changes after the claim: two owners (no decision), then another single owner.
select t13.person('00000000-0000-4000-8000-0000000001c1', 'rotc') as acct_c \gset
select t13.login('00000000-0000-4000-8000-0000000001d1');
select t13.check(t13.register('00000000-0000-4000-8000-0000000001d1') = 'active', '5 D registered');
select rot.claim(:'acct_c') as c_c \gset
insert into public.brand_memberships (brand_id, user_id, role)
values (public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-0000000001c1'), '00000000-0000-4000-8000-0000000001d1', 'owner');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_c', :'c_c'), 'WORKSPACE_INACTIVE', '5 two owners');
update public.brand_memberships set role = 'admin'
 where brand_id = public.social_mobile_account_deletion_workspace('00000000-0000-4000-8000-0000000001c1') and user_id = '00000000-0000-4000-8000-0000000001c1';
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_c', :'c_c'), 'OWNER_CHANGED', '5 another single owner');

-- 6. The workspace owner's POSTONA (F5): every state that is not active refuses the claim and the rotate; back to
--    active, the same lease still rotates.
select t13.person('00000000-0000-4000-8000-0000000001e1', 'rote') as acct_e \gset
select rot.claim(:'acct_e') as c_e \gset
select t13.state('00000000-0000-4000-8000-0000000001e1', 'ended');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_e', :'c_e'), 'SERVICE_NOT_ACTIVE', '6 ended: rotate');
select rot.refused(format('select rot.claim(%L)', :'acct_e'), 'SERVICE_NOT_ACTIVE', '6 ended: claim');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'active');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'suspended');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_e', :'c_e'), 'SERVICE_NOT_ACTIVE', '6 suspended: rotate');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'active');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'locked');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_e', :'c_e'), 'ACCOUNT_LIFECYCLE_BLOCKED', '6 locked: rotate');
select rot.refused(format('select rot.claim(%L)', :'acct_e'), 'ACCOUNT_LIFECYCLE_BLOCKED', '6 locked: claim');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'active');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'account_deleting');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_e', :'c_e'), 'ACCOUNT_LIFECYCLE_BLOCKED', '6 account deletion: rotate');
select rot.refused(format('select rot.claim(%L)', :'acct_e'), 'ACCOUNT_LIFECYCLE_BLOCKED', '6 account deletion: claim');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'active');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'service_deleting');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_e', :'c_e'), 'ACCOUNT_LIFECYCLE_BLOCKED', '6 POSTONA deletion: rotate');
select t13.state('00000000-0000-4000-8000-0000000001e1', 'active');
begin;
select rot.h5_rotate(:'acct_e', :'c_e'::jsonb, 'fake_threads_rote_ROTATED_0123456789') ->> 'status' as r_e \gset
commit;
select t13.check(:'r_e' = 'rotated', '6 active again: the same lease rotates');

-- 7. A reconnect between claim and rotate (the secret updated in place, a new verification and custody record):
--    stale, and the reconnect's credential and record stay. Also a reconnect that recorded no custody.
select t13.person('00000000-0000-4000-8000-0000000001f1', 'rotf') as acct_f \gset
select rot.claim(:'acct_f') as c_f \gset
select t13.complete_oauth('00000000-0000-4000-8000-0000000001f1', t13.begin_oauth('00000000-0000-4000-8000-0000000001f1', 'rotf_re'),
                          'rotf', 'fake_threads_rotf_RECONNECTED_0123456789') = :'acct_f' as reconnected \gset
select t13.check(:'reconnected'::boolean, '7 reconnected');
select rot.refused(format('select rot.h5_rotate(%L, %L::jsonb, %L)', :'acct_f', :'c_f', 'fake_threads_rotf_OLDREFRESH_0123456789'),
                   'STALE_CREDENTIAL', '7 rotate after a reconnect');
select t13.check((select s.secret from vault.secrets s where s.id = (:'c_f'::jsonb ->> 'vault_secret_id')::uuid) = 'fake_threads_rotf_RECONNECTED_0123456789',
                 '7 the reconnect''s token stays');
select rot.refused(format('select rot.claim(%L)', :'acct_f'), 'LEASE_HELD', '7 the stale lease is still held');
select t13.check(public.release_threads_credential_refresh(:'acct_f', (:'c_f'::jsonb ->> 'lease')::uuid) ->> 'status' = 'released', '7 release');
select rot.claim(:'acct_f') as c_f2 \gset
select t13.check(:'c_f2'::jsonb ->> 'status' = 'claimed', '7 claim of the reconnected credential');
update public.social_accounts set verified_at = clock_timestamp() where id = :'acct_f';
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_f', :'c_f2'), 'STALE_CREDENTIAL', '7 a verification newer than the custody record');
select rot.refused(format('select rot.claim(%L)', :'acct_f'), 'CUSTODY_UNKNOWN', '7 claim with no custody for the current verification');

-- 8. The person disconnects Threads after the claim: the lease goes with the account, nothing is rotated.
select t13.person('00000000-0000-4000-8000-0000000001a2', 'rotg') as acct_g \gset
select rot.claim(:'acct_g') as c_g \gset
select t13.as_user('00000000-0000-4000-8000-0000000001a2', 'disconnect', :'acct_g', 'rotg') ->> 'status' as disc_g \gset
select t13.check(:'disc_g' = 'disconnected', '8 the disconnect is not blocked by a refresh lease');
select t13.check(not exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_g'), '8 the lease went with the account');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_g', :'c_g'), 'ACCOUNT_NOT_FOUND', '8 rotate after the disconnect');
select rot.refused(format('select rot.claim(%L)', :'acct_g'), 'ACCOUNT_NOT_FOUND', '8 claim after the disconnect');

-- 9. Expiry: bounds, not extending, an expired or unknown credential; malformed calls.
select t13.person('00000000-0000-4000-8000-0000000001a3', 'roth') as acct_h \gset
select rot.claim(:'acct_h') as c_h \gset
select rot.refused(format('select rot.rotate(%L, %L::jsonb, %L::interval)', :'acct_h', :'c_h', '-1 minute'), 'EXPIRY_INVALID', '9 already expired');
select rot.refused(format('select rot.rotate(%L, %L::jsonb, %L::interval)', :'acct_h', :'c_h', '62 days'), 'EXPIRY_INVALID', '9 beyond 61 days');
select rot.refused(format('select rot.rotate(%L, %L::jsonb, %L::interval)', :'acct_h', :'c_h', '40 days'), 'EXPIRY_NOT_EXTENDED', '9 earlier than recorded');
select rot.refused(format('select public.rotate_threads_credential_custody(%L, %L::uuid, %L::uuid, %L::timestamptz, null)', :'acct_h',
                   :'c_h'::jsonb ->> 'lease', :'c_h'::jsonb ->> 'vault_secret_id', :'c_h'::jsonb ->> 'custody_recorded_at'), 'REQUEST_INVALID', '9 no expiry');
select rot.refused(format('select public.rotate_threads_credential_custody(%L, %L::uuid, %L::uuid, %L::timestamptz, ''infinity'')', :'acct_h',
                   :'c_h'::jsonb ->> 'lease', :'c_h'::jsonb ->> 'vault_secret_id', :'c_h'::jsonb ->> 'custody_recorded_at'), 'REQUEST_INVALID', '9 infinity');
select rot.refused('select rot.claim(''Not-An-Id'')', 'REQUEST_INVALID', '9 malformed account id');
select rot.refused('select rot.claim(''threads_no_such_account'')', 'ACCOUNT_NOT_FOUND', '9 unknown account');
update public.threads_account_credential_custody set expires_at = clock_timestamp() - interval '1 second' where social_account_id = :'acct_h';
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_h', :'c_h'), 'CREDENTIAL_EXPIRED', '9 the stored credential expired');
select rot.refused(format('select rot.claim(%L)', :'acct_h'), 'CREDENTIAL_EXPIRED', '9 claim of an expired credential');
delete from public.threads_account_credential_custody where social_account_id = :'acct_h';
select rot.refused(format('select rot.claim(%L)', :'acct_h'), 'CUSTODY_UNKNOWN', '9 claim without custody');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_h', :'c_h'), 'STALE_CREDENTIAL', '9 rotate without custody');

-- 10. One lease at a time; an ended lease is taken over and its holder can no longer rotate; release is exact.
select t13.person('00000000-0000-4000-8000-0000000001a4', 'roti') as acct_i \gset
select rot.claim(:'acct_i') as c_i \gset
select rot.refused(format('select rot.claim(%L)', :'acct_i'), 'LEASE_HELD', '10 a second claim');
select t13.check(public.release_threads_credential_refresh(:'acct_i', gen_random_uuid()) ->> 'status' = 'not_held', '10 release of another lease');
select t13.check(exists (select 1 from public.threads_credential_refresh_leases l where l.lease_id = (:'c_i'::jsonb ->> 'lease')::uuid), '10 still held');
update public.threads_credential_refresh_leases set claimed_at = clock_timestamp() - interval '2 minutes', lease_expires_at = clock_timestamp() - interval '61 seconds'
 where social_account_id = :'acct_i';
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_i', :'c_i'), 'LEASE_NOT_HELD', '10 an ended lease');
select rot.claim(:'acct_i') as c_i2 \gset
select t13.check(:'c_i2'::jsonb ->> 'status' = 'claimed' and :'c_i2'::jsonb ->> 'lease' <> :'c_i'::jsonb ->> 'lease', '10 taken over by a new lease');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_i', :'c_i'), 'LEASE_NOT_HELD', '10 the old holder after the takeover');
select t13.check(public.release_threads_credential_refresh(:'acct_i', (:'c_i'::jsonb ->> 'lease')::uuid) ->> 'status' = 'not_held', '10 the old holder releases nothing');
select t13.check(public.release_threads_credential_refresh(:'acct_i', (:'c_i2'::jsonb ->> 'lease')::uuid) ->> 'status' = 'released', '10 release');
select t13.check(public.release_threads_credential_refresh(:'acct_i', (:'c_i2'::jsonb ->> 'lease')::uuid) ->> 'status' = 'not_held', '10 release again');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_i', :'c_i2'), 'LEASE_NOT_HELD', '10 rotate after the release');

-- 11. H5's transaction fails after the rotate (the Vault write): nothing changed, the lease is still held and
--     rotates on a retry.
select t13.person('00000000-0000-4000-8000-0000000001a5', 'rotj') as acct_j \gset
select rot.claim(:'acct_j') as c_j \gset
select t13.check(rot.rotate_then_vault_fails(:'acct_j', :'c_j'::jsonb) = 'ROLLED_BACK', '11 rolled back together');
begin;
select rot.h5_rotate(:'acct_j', :'c_j'::jsonb, 'fake_threads_rotj_ROTATED_0123456789') ->> 'status' as r_j \gset
commit;
select t13.check(:'r_j' = 'rotated', '11 the retry rotates');

-- 12. Server only: a call carrying a person's claims (even the owner's own) is refused.
select rot.claim(:'acct_b') as c_b2 \gset
select rot.refused(format('select rot.as_person(%L, %L)', '00000000-0000-4000-8000-0000000001b1', format('select rot.claim(%L)', :'acct_a')),
                   'SERVER_ONLY', '12 claim as a person');
select rot.refused(format('select rot.as_person(%L, %L)', '00000000-0000-4000-8000-0000000001b1', format('select rot.rotate(%L, %L::jsonb)', :'acct_b', :'c_b2')),
                   'SERVER_ONLY', '12 rotate as the owner person');
select rot.refused(format('select rot.as_person(%L, %L)', '00000000-0000-4000-8000-0000000001b1',
                          format('select public.release_threads_credential_refresh(%L, %L::uuid)', :'acct_b', :'c_b2'::jsonb ->> 'lease')),
                   'SERVER_ONLY', '12 release as a person');

-- 13. Deletion wins over a refresh: with a refresh lease held, ending POSTONA (G5/F5 begin + claim, the owner's live
--     lease) refuses the rotate, and the Threads cleanup removes the account, its custody and the refresh lease.
select t13.person('00000000-0000-4000-8000-0000000001a6', 'rotk') as acct_k \gset
select rot.claim(:'acct_k') as c_k \gset
select public.begin_service_deletion('00000000-0000-4000-8000-0000000001a6', 'x_autopost') ->> 'operation_id' as op_k \gset
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_k', :'c_k'), 'ACCOUNT_LIFECYCLE_BLOCKED', '13 rotate once the deletion began');
select t13.check(public.claim_service_deletion('00000000-0000-4000-8000-0000000001a6', 'x_autopost', :'op_k'::uuid) ->> 'status' = 'acquired', '13 the deletion is claimed');
select t13.check(public.cleanup_threads_provider_footprint('00000000-0000-4000-8000-0000000001a6') ->> 'code' = 'LOCAL_REMOVED', '13 the cleanup is not blocked by a refresh lease');
select t13.check(not exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_k')
                 and not exists (select 1 from public.threads_account_credential_custody c where c.social_account_id = :'acct_k'), '13 lease and custody went with the account');
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_k', :'c_k'), 'ACCOUNT_NOT_FOUND', '13 rotate after the cleanup');

-- 14. The secret under the lease changes (no product path does this without a new custody record; a direct write
--     or a future writer could): the account's or the custody row's secret id no longer the one claimed -> stale,
--     so the Vault write could never land on a secret the account does not use.
select t13.person('00000000-0000-4000-8000-0000000001a7', 'rotl') as acct_l \gset
select rot.claim(:'acct_l') as c_l \gset
select a.vault_access_token_secret_id as secret_l from public.social_accounts a where a.id = :'acct_l' \gset
update public.social_accounts set vault_access_token_secret_id = vault.create_secret('fake_threads_rotl_OTHER_0123456789') where id = :'acct_l';
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_l', :'c_l'), 'STALE_CREDENTIAL', '14 the account names another secret');
update public.social_accounts set vault_access_token_secret_id = :'secret_l'::uuid where id = :'acct_l';
update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid() where social_account_id = :'acct_l';
select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_l', :'c_l'), 'STALE_CREDENTIAL', '14 the custody row names another secret');
update public.threads_account_credential_custody set vault_secret_id = :'secret_l'::uuid where social_account_id = :'acct_l';
begin;
select rot.h5_rotate(:'acct_l', :'c_l'::jsonb, 'fake_threads_rotl_ROTATED_0123456789') ->> 'status' as r_l \gset
commit;
select t13.check(:'r_l' = 'rotated', '14 back to the claimed secret: rotates');

select 'ROTATION_BEHAVIOR_OK';
