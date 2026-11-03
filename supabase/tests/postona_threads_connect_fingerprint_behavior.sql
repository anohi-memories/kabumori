-- G4-31 (Issue #319): option (4) (003_rotation_lease_connect_fingerprint.sql) on top of A and C, on the composed world,
-- run after the cr.* prelude of postona_threads_credential_composition_behavior.sql and the cr.claim .. cr.release helpers
-- of postona_threads_rotation_cas_behavior.sql. Fake tokens / fake Vault only.
-- psql variable :a_mode -- 'on' (A's trigger enabled) or 'off' (A's row trigger DISABLED by the owner). F1 writes no
-- custody and binds nothing, so A and C never see it: the refusal there must be (4)'s CONNECTION_CHANGED in both modes.

select (:'a_mode' = 'off') as a_off \gset
\if :a_off
alter table public.threads_account_credential_custody disable trigger threads_credential_refresh_lease_invalidate_row;
\endif
create function cr.fp(p_acct text) returns text language sql volatile as $$
  select encode(sha256(convert_to(coalesce(string_agg(s.id::text, ',' order by s.id), ''), 'UTF8')), 'hex')
    from public.social_account_oauth_states s where s.social_account_id = p_acct and s.consumed_at is not null $$;
create function cr.lease_fp(p_claim jsonb) returns text language sql volatile as $$
  select l.connect_fingerprint from public.threads_credential_refresh_leases l where l.lease_id = (p_claim ->> 'lease')::uuid $$;
create function cr.rot(p_acct text, p_claim jsonb, p_days integer default 50) returns jsonb language sql volatile as $$
  select cr.rotate(p_acct, p_claim, (p_claim ->> 'custody_recorded_at')::timestamptz, now() + make_interval(days => p_days)) $$;

-- P1. Normal connect -> claim -> rotate: the lease carries the account's fingerprint; rotated; single use.
select cr.connected(401, 'p1') as p1 \gset
select cr.claim(:'p1')::text as k1 \gset
select cr.check(cr.lease_fp(:'k1') = cr.fp(:'p1'), 'P1 the lease carries the connect fingerprint');
select cr.check(cr.rot(:'p1', :'k1') ->> 'status' = 'rotated', 'P1 rotated');
select cr.check(cr.rot(:'p1', :'k1', 51) ->> 'code' = 'LEASE_NOT_HELD', 'P1 single use');

-- P2. F1 of G4-29, the SAME now(): connect, claim, PR #124's complete ON ITS OWN (no entry, no custody, no binding), rotate.
create function cr.f1_same_now(p_n integer) returns jsonb language plpgsql as $$
declare v_user uuid := cr.enroll(p_n); v_acct text; v_claim jsonb; v_rot jsonb; v_puid text := '178414000000' || lpad(p_n::text, 5, '0');
begin
  v_acct := cr.t_begin(v_user, 'q2a' || p_n);
  perform cr.check(cr.t_complete(v_user, 'q2a' || p_n, v_puid, now() + interval '30 days') = 'OK', 'P2 connect');
  v_claim := cr.claim(v_acct);
  perform cr.check(cr.t_begin(v_user, 'q2b' || p_n) = v_acct, 'P2 begin');
  perform cr.check(cr.legacy_complete(v_user, 'q2b' || p_n, v_puid, false) = 'OK', 'P2 PR #124 complete on its own');
  v_rot := cr.rot(v_acct, v_claim, 55);
  if v_rot ->> 'status' = 'rotated' then perform cr.h5_write(v_acct, 'fakeTHREADSstaleLineage_0123456789'); end if;
  return jsonb_build_object('rotation', v_rot, 'recorded_equal', cr.recorded(v_acct) = (v_claim ->> 'custody_recorded_at')::timestamptz,
                            'vault_now', (select s.secret from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = v_acct),
                            'bare_complete_token', cr.token('q2b' || p_n), 'credential_token', nullif(cr.token_of(v_acct), ''));
end $$;
select cr.f1_same_now(402)::text as p2 \gset
select 'P2 ' || :'p2' as observed;
select cr.check((:'p2')::jsonb #>> '{rotation,code}' = 'CONNECTION_CHANGED' and ((:'p2')::jsonb ->> 'recorded_equal')::boolean
                and (:'p2')::jsonb ->> 'vault_now' = (:'p2')::jsonb ->> 'bare_complete_token'
                and (:'p2')::jsonb ->> 'credential_token' is distinct from 'fakeTHREADSstaleLineage_0123456789',
                'P2 F1 same now(): CONNECTION_CHANGED; the bare complete''s token stays, the stale lineage is never handed out');

-- P3. F1 in separate transactions (the bare complete commits before the rotate): CONNECTION_CHANGED.
select cr.connected(403, 'p3') as p3 \gset
select cr.uid(403) as u3 \gset
select cr.claim(:'p3')::text as k3 \gset
select cr.check(cr.t_begin(:'u3', 'p3b') = :'p3' and cr.legacy_complete(:'u3', 'p3b', '17841400000000403', false) = 'OK', 'P3 bare complete');
select cr.check(cr.rot(:'p3', :'k3') ->> 'code' = 'CONNECTION_CHANGED', 'P3 F1 separate transactions: CONNECTION_CHANGED');

-- P4. A connect attempt that FAILS (attestation refused) consumes nothing: the fingerprint stays, the claim still rotates.
select cr.connected(404, 'p4') as p4 \gset
select cr.uid(404) as u4 \gset
select cr.claim(:'p4')::text as k4 \gset
select cr.check(cr.t_begin(:'u4', 'p4b') = :'p4', 'P4 begin');
select cr.check(cr.as_person(:'u4', format('select public.complete_social_mobile_threads_oauth_connection(%L::uuid, %L, %L, %L, %L)',
                  cr.state('p4b'), '17841400000000404', 'h17841400000000404', cr.token('p4b'), repeat('0', 64))) like 'ERR:THREADS_CONNECT_ATTESTATION_INVALID%',
                'P4 a refused complete (bad attestation)');
select cr.check(cr.lease_fp(:'k4') = cr.fp(:'p4'), 'P4 the fingerprint did not move');

-- P5. A new BEGIN (an unconsumed state) under the lease does not count either: P4's claim rotates.
select cr.check(cr.rot(:'p4', :'k4') ->> 'status' = 'rotated', 'P4/P5 a failed attempt and an open state: rotated');

-- P6. A reconnect through the entry: refused by A (on) or C (off) before (4); and (4) alone would refuse it too.
select cr.connected(406, 'p6') as p6 \gset
select cr.uid(406) as u6 \gset
select cr.claim(:'p6')::text as k6 \gset
select cr.check(cr.t_begin(:'u6', 'p6b') = :'p6' and cr.t_complete(:'u6', 'p6b', '17841400000000406', now() + interval '40 days') = 'OK', 'P6 reconnect');
select cr.check(cr.lease_fp(:'k6') is distinct from cr.fp(:'p6'), 'P6 the entry''s completion moved the fingerprint');
select cr.check(cr.rot(:'p6', :'k6') ->> 'code' in ('LEASE_NOT_HELD', 'BINDING_CHANGED'), 'P6 refused');

-- P7. The owner changes under the lease (a second owner): the rotation's own owner fence refuses; nothing written.
select cr.connected(407, 'p7') as p7 \gset
select cr.uid(407) as u7 \gset
select cr.enroll(417) as u7b \gset
select cr.claim(:'p7')::text as k7 \gset
select cr.recorded(:'p7') as rec7 \gset
insert into public.brand_memberships (brand_id, user_id, role) values (cr.ws(:'u7'), :'u7b', 'owner');
select cr.rot(:'p7', :'k7')::text as r7 \gset
select cr.check((:'r7')::jsonb ->> 'status' = 'refused' and cr.recorded(:'p7') = :'rec7'::timestamptz, 'P7 two owners: refused (' || (:'r7')::text || ')');
delete from public.brand_memberships where brand_id = cr.ws(:'u7') and user_id = :'u7b';

-- P8. A consumed state removed (a cleanup) under the lease: the fingerprint moved -> CONNECTION_CHANGED (fail closed).
select cr.connected(408, 'p8') as p8 \gset
select cr.claim(:'p8')::text as k8 \gset
delete from public.social_account_oauth_states where id = cr.state('p8');
select cr.check(cr.rot(:'p8', :'k8') ->> 'code' = 'CONNECTION_CHANGED', 'P8 a consumed state removed: CONNECTION_CHANGED');

-- P8b. One consumed state removed AND one consumed by a bare complete: the COUNT is unchanged, the id set is not.
select cr.connected(409, 'p8b') as p9 \gset
select cr.uid(409) as u9 \gset
select cr.claim(:'p9')::text as k9 \gset
select (select count(*) from public.social_account_oauth_states where social_account_id = :'p9' and consumed_at is not null) as n9 \gset
select cr.check(cr.t_begin(:'u9', 'p8c') = :'p9', 'P8b begin');
delete from public.social_account_oauth_states where id = cr.state('p8b');
select cr.check(cr.legacy_complete(:'u9', 'p8c', '17841400000000409', false) = 'OK', 'P8b bare complete');
select cr.check((select count(*) from public.social_account_oauth_states where social_account_id = :'p9' and consumed_at is not null) = :'n9'::bigint,
                'P8b setup: the same number of consumed states');
select cr.check(cr.rot(:'p9', :'k9') ->> 'code' = 'CONNECTION_CHANGED', 'P8b same count, another set: CONNECTION_CHANGED');

-- P9. ACL: the new column is behind the lease table's owner-only ACL.
select cr.check(not pg_catalog.has_column_privilege(r.oid, 'public.threads_credential_refresh_leases', 'connect_fingerprint', 'select')
                and not pg_catalog.has_function_privilege(r.oid, 'public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)', 'execute'),
                'P9 no API access for ' || r.rolname)
  from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator');

-- F2 (still EXPECTED_FAIL): an in-place Vault write consumes no state; (4) cannot see it.
select cr.connected(410, 'f2') as f2 \gset
select cr.claim(:'f2')::text as kf \gset
select cr.h5_write(:'f2', 'fakeTHREADSoutOfBandWrite_0123456789');
select cr.check(cr.rot(:'f2', :'kf') ->> 'status' = 'rotated', 'F2 measured: an in-place Vault write is still not seen');
select 'EXPECTED_FAIL_F2 in-place Vault write under a held lease: rotated (A+C+(4) cannot see it)' as finding;

select 'POSTONA_THREADS_CONNECT_FINGERPRINT_BEHAVIOR_DONE' as result;
