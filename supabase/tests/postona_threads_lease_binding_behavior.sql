-- G4-29 (Issue #319): option C (002_rotation_lease_binding.sql) on top of option A, on the composed world, run after the
-- cr.* prelude of postona_threads_credential_composition_behavior.sql and the cr.claim .. cr.release helpers of
-- postona_threads_rotation_cas_behavior.sql. Fake tokens / fake Vault only.
-- psql variable :a_mode -- 'on' (A's trigger enabled), 'off' (A's row trigger DISABLED by the owner, the limit G4-27
-- measured), 'absent' (A rolled back). Where a custody write ends the lease under A, the refusal is LEASE_NOT_HELD;
-- otherwise C must refuse with BINDING_CHANGED.
-- EXPECTED_FAIL rows (F1, F2) record what A+C cannot stop; they assert the measured outcome and print a marker.

select (:'a_mode' = 'off') as a_off \gset
select (:'a_mode' = 'on') as a_on \gset
\if :a_off
alter table public.threads_account_credential_custody disable trigger threads_credential_refresh_lease_invalidate_row;
\endif
create function cr.expect_reconnect_code() returns text language sql immutable as $$ select 'BINDING_CHANGED' $$;
\if :a_on
create or replace function cr.expect_reconnect_code() returns text language sql immutable as $$ select 'LEASE_NOT_HELD' $$;
\endif
create function cr.state_of(p_acct text) returns uuid language sql volatile as $$
  select b.oauth_state_id from postona_threads_binding.bindings b where b.social_account_id = p_acct $$;
create function cr.lease_state(p_claim jsonb) returns uuid language sql volatile as $$
  select l.binding_oauth_state_id from public.threads_credential_refresh_leases l where l.lease_id = (p_claim ->> 'lease')::uuid $$;

-- B1. A claim records the binding it was claimed under; rotate with it works; the lease is single use.
select cr.connected(301, 'b1') as b1 \gset
select cr.claim(:'b1')::text as k1 \gset
select cr.check((:'k1')::jsonb ->> 'status' = 'claimed' and cr.lease_state(:'k1') = cr.state_of(:'b1'), 'B1 the lease names the current binding');
select cr.check(cr.rotate(:'b1', :'k1', ((:'k1')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days') ->> 'status' = 'rotated', 'B1 rotated');
select cr.check(cr.rotate(:'b1', :'k1', cr.recorded(:'b1'), now() + interval '51 days') ->> 'code' = 'LEASE_NOT_HELD', 'B1 the same lease again: LEASE_NOT_HELD');

-- B2. The G4-25 finding (one transaction, one now()): connect, claim, reconnect through the entry, rotate.
create function cr.ac_same_now(p_n integer) returns jsonb language plpgsql as $$
declare v_user uuid := cr.enroll(p_n); v_acct text; v_claim jsonb; v_rot jsonb; v_rec0 timestamptz; v_puid text := '178414000000' || lpad(p_n::text, 5, '0');
begin
  v_acct := cr.t_begin(v_user, 'ac_a' || p_n);
  perform cr.check(cr.t_complete(v_user, 'ac_a' || p_n, v_puid, now() + interval '30 days') = 'OK', 'B2 connect');
  v_claim := cr.claim(v_acct);
  perform cr.check(v_claim ->> 'status' = 'claimed', 'B2 claim ' || v_claim::text);
  v_rec0 := (v_claim ->> 'custody_recorded_at')::timestamptz;
  perform cr.check(cr.t_begin(v_user, 'ac_b' || p_n) = v_acct, 'B2 reconnect begin');
  perform cr.check(cr.t_complete(v_user, 'ac_b' || p_n, v_puid, now() + interval '40 days') = 'OK', 'B2 reconnect complete');
  v_rot := cr.rotate(v_acct, v_claim, v_rec0, now() + interval '55 days');
  if v_rot ->> 'status' = 'rotated' then perform cr.h5_write(v_acct, 'fakeTHREADSstaleLineage_0123456789'); end if;
  return jsonb_build_object('rotation', v_rot, 'recorded_equal', cr.recorded(v_acct) = v_rec0,
                            'token_now', cr.token_of(v_acct), 'reconnect_token', cr.token('ac_b' || p_n));
end $$;
select cr.ac_same_now(302)::text as b2 \gset
select 'B2 ' || :'b2' as observed;
select cr.check((:'b2')::jsonb #>> '{rotation,code}' = cr.expect_reconnect_code() and ((:'b2')::jsonb ->> 'recorded_equal')::boolean
                and (:'b2')::jsonb ->> 'token_now' = (:'b2')::jsonb ->> 'reconnect_token',
                'B2 same now(): the stale refresh is refused (' || cr.expect_reconnect_code() || '), the reconnect''s token stays');

-- B3. No binding: claim refuses CONNECTION_NOT_BOUND, and credential_row hands nothing out either.
select cr.connected(303, 'b3') as b3 \gset
delete from postona_threads_binding.bindings where social_account_id = :'b3';
select cr.check(cr.claim(:'b3') ->> 'code' = 'CONNECTION_NOT_BOUND' and cr.rows(:'b3') = 0, 'B3 no binding: CONNECTION_NOT_BOUND (and no credential row)');

-- B4. A binding that does not match the account (another Threads user, another workspace): not bound.
select cr.connected(304, 'b4') as b4 \gset
update postona_threads_binding.bindings set threads_user_id = '17841499999999999' where social_account_id = :'b4';
select cr.check(cr.claim(:'b4') ->> 'code' = 'CONNECTION_NOT_BOUND', 'B4 another Threads user in the binding: CONNECTION_NOT_BOUND');
update postona_threads_binding.bindings set threads_user_id = '17841400000000304', brand_id = 'brand_other_g4_29' where social_account_id = :'b4';
select cr.check(cr.claim(:'b4') ->> 'code' = 'CONNECTION_NOT_BOUND', 'B4 another workspace in the binding: CONNECTION_NOT_BOUND');

-- B5. The binding changes under a held lease WITHOUT any custody write (A cannot see it): C refuses.
select cr.connected(305, 'b5') as b5 \gset
select cr.claim(:'b5')::text as k5 \gset
update postona_threads_binding.bindings set oauth_state_id = gen_random_uuid() where social_account_id = :'b5';
select cr.check(cr.rotate(:'b5', :'k5', ((:'k5')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days') ->> 'code' = 'BINDING_CHANGED',
                'B5 binding changed without a custody write: BINDING_CHANGED');

-- B6. An older pending state completed AFTER a newer one (last completion wins, G4-14): a new binding, the claim is refused.
select cr.enroll(306) as u6 \gset
select cr.t_begin(:'u6', 'b6old') as b6 \gset
select cr.check(cr.t_begin(:'u6', 'b6new') = :'b6', 'B6 second begin');
select cr.check(cr.t_complete(:'u6', 'b6new', '17841400000000306', now() + interval '30 days') = 'OK', 'B6 newer state completed');
select cr.claim(:'b6')::text as k6 \gset
select cr.check(cr.t_complete(:'u6', 'b6old', '17841400000000306', now() + interval '35 days') = 'OK', 'B6 older state completed later');
select cr.check(cr.state_of(:'b6') = cr.state('b6old') and cr.lease_state(:'k6') is distinct from cr.state_of(:'b6'), 'B6 the binding moved to the older state');
select cr.check(cr.rotate(:'b6', :'k6', ((:'k6')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'code' = cr.expect_reconnect_code(),
                'B6 the claim of the newer connect is refused');

-- B7. The account is deleted under a held lease (binding and lease cascade): ACCOUNT_NOT_FOUND / LEASE_NOT_HELD.
select cr.connected(307, 'b7') as b7 \gset
select cr.claim(:'b7')::text as k7 \gset
-- (test world: the account's OAuth states are removed first, as the deletion cleanup does; they do not cascade)
delete from public.social_account_oauth_states where social_account_id = :'b7';
delete from public.social_accounts where id = :'b7';
select cr.check(cr.rotate(:'b7', :'k7', ((:'k7')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days') ->> 'code' in ('ACCOUNT_NOT_FOUND', 'LEASE_NOT_HELD'),
                'B7 deleted account: refused');
select cr.check(not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'b7')
                and not exists (select 1 from postona_threads_binding.bindings where social_account_id = :'b7'), 'B7 lease and binding gone');

-- B8. ACL: the new column is behind the lease table's owner-only ACL; claim / rotate stay owner-only.
select cr.check(not pg_catalog.has_table_privilege(r.oid, 'public.threads_credential_refresh_leases', 'select')
                and not pg_catalog.has_column_privilege(r.oid, 'public.threads_credential_refresh_leases', 'binding_oauth_state_id', 'select')
                and not pg_catalog.has_function_privilege(r.oid, 'public.claim_threads_credential_refresh(text)', 'execute')
                and not pg_catalog.has_function_privilege(r.oid, 'public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)', 'execute'),
                'B8 no API access for ' || r.rolname)
  from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator');

-- F1. EXPECTED_FAIL: PR #124's complete called ON ITS OWN (no entry, no custody, no new binding) with the same now().
--     Neither A nor C sees it; this measures what happens (rotated? does credential_row hand the stale lineage out?).
create function cr.bare_complete_same_now(p_n integer) returns jsonb language plpgsql as $$
declare v_user uuid := cr.enroll(p_n); v_acct text; v_claim jsonb; v_rot jsonb; v_puid text := '178414000000' || lpad(p_n::text, 5, '0');
begin
  v_acct := cr.t_begin(v_user, 'f1a' || p_n);
  perform cr.check(cr.t_complete(v_user, 'f1a' || p_n, v_puid, now() + interval '30 days') = 'OK', 'F1 connect');
  v_claim := cr.claim(v_acct);
  perform cr.check(cr.t_begin(v_user, 'f1b' || p_n) = v_acct, 'F1 begin');
  perform cr.check(cr.legacy_complete(v_user, 'f1b' || p_n, v_puid, false) = 'OK', 'F1 PR #124 complete on its own');
  v_rot := cr.rotate(v_acct, v_claim, (v_claim ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days');
  if v_rot ->> 'status' = 'rotated' then perform cr.h5_write(v_acct, 'fakeTHREADSstaleLineage_0123456789'); end if;
  return jsonb_build_object('rotation', v_rot, 'vault_now', (select s.secret from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = v_acct),
                            'bare_complete_token', cr.token('f1b' || p_n), 'credential_rows', cr.rows(v_acct), 'credential_token', nullif(cr.token_of(v_acct), ''));
end $$;
select cr.bare_complete_same_now(308)::text as f1 \gset
select 'F1 ' || :'f1' as observed;
select cr.check((:'f1')::jsonb #>> '{rotation,status}' = 'rotated' and (:'f1')::jsonb ->> 'vault_now' = 'fakeTHREADSstaleLineage_0123456789',
                'F1 measured: the stale refresh rotated over the bare complete''s token');
-- (corrects G4-28's inference "credential_row is then 0 rows": with the SAME now(), recorded_at = verified_at, so the
--  expiry reader still answers and credential_row hands the stale lineage out)
select cr.check(((:'f1')::jsonb ->> 'credential_rows')::integer = 1 and (:'f1')::jsonb ->> 'credential_token' = 'fakeTHREADSstaleLineage_0123456789',
                'F1 measured: credential_row hands the stale lineage out');
select 'EXPECTED_FAIL_F1 bare PR #124 complete at the same now(): rotated; credential_row rows=' || ((:'f1')::jsonb ->> 'credential_rows') as finding;

-- F2. EXPECTED_FAIL: the Vault secret replaced in place (no custody write, no new binding): rotate cannot see it.
select cr.connected(309, 'f2') as f2 \gset
select cr.claim(:'f2')::text as k9 \gset
select cr.h5_write(:'f2', 'fakeTHREADSoutOfBandWrite_0123456789');
select cr.check(cr.rotate(:'f2', :'k9', ((:'k9')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days') ->> 'status' = 'rotated',
                'F2 measured: a rotate after an in-place Vault write is accepted');
select 'EXPECTED_FAIL_F2 in-place Vault write under a held lease: rotated (A+C cannot see it)' as finding;

select 'POSTONA_THREADS_LEASE_BINDING_BEHAVIOR_DONE' as result;
