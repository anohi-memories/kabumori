-- G4-25 (Issue #319): the Threads credential rotation candidate's compare-and-set (threads_credential_rotation_candidate.sql)
-- on the COMPOSED world of G4-24 (PR #418 001 / 002 + PR #412 credential_row + G5 PR #399 + G3 generation + G4's publish
-- stack), run after the cr.* prelude of postona_threads_credential_composition_behavior.sql. Fake tokens / fake Vault only.
-- The rotation CAS compares (secret id, custody recorded_at) and a single-use lease. recorded_at is written with now() (the
-- transaction START), so two writes in transactions with the same now() carry the same version.
-- psql variable :fix -- 'none' (the candidate as it is) or 'drop_lease_on_custody' (a TEST-WORLD prototype of a fix: every
-- custody write deletes the account's refresh lease). Cases R7 assert the reproduced behavior under 'none' and the fixed one
-- under the prototype.

-- H5's side of a rotation, modelled: claim -> (Meta refresh, not modelled) -> rotate -> vault.update_secret in place.
create function cr.claim(p_acct text) returns jsonb language sql volatile as $$ select public.claim_threads_credential_refresh(p_acct) $$;
create function cr.rotate(p_acct text, p_claim jsonb, p_expected_recorded timestamptz, p_new_expires timestamptz) returns jsonb
language sql volatile as $$
  select public.rotate_threads_credential_custody(p_acct, (p_claim ->> 'lease')::uuid, (p_claim ->> 'vault_secret_id')::uuid,
                                                  p_expected_recorded, p_new_expires) $$;
create function cr.h5_write(p_acct text, p_token text) returns void language sql as $$
  update vault.secrets set secret = p_token where id = (select vault_access_token_secret_id from public.social_accounts where id = p_acct) $$;
create function cr.recorded(p_acct text) returns timestamptz language sql volatile as $$
  select recorded_at from public.threads_account_credential_custody where social_account_id = p_acct $$;
create function cr.expires(p_acct text) returns timestamptz language sql volatile as $$
  select expires_at from public.threads_account_credential_custody where social_account_id = p_acct $$;
create function cr.token_of(p_acct text) returns text language sql volatile as $$
  select split_part(cr.cred(p_acct), '|', 3) $$;
create function cr.gen_of(p_acct text) returns text language sql volatile as $$
  select split_part(cr.cred(p_acct), '|', 4) $$;
create function cr.release(p_acct text, p_claim jsonb) returns jsonb language sql volatile as $$
  select public.release_threads_credential_refresh(p_acct, (p_claim ->> 'lease')::uuid) $$;

-- R1. Baseline (separate transactions): claim -> rotate with the claimed version -> rotated; H5 writes the refreshed token;
--     credential_row hands out that token with a new generation.
select cr.connected(101, 'r1') as acct1 \gset
select cr.gen_of(:'acct1') as gen0 \gset
select cr.claim(:'acct1')::text as c1 \gset
select cr.check((:'c1')::jsonb ->> 'status' = 'claimed', 'R1 claim: ' || :'c1');
select cr.check(cr.rotate(:'acct1', :'c1', ((:'c1')::jsonb ->> 'custody_recorded_at')::timestamptz, cr.expires(:'acct1') - interval '1 day') ->> 'code' = 'EXPIRY_NOT_EXTENDED',
                'R1 a shorter expiry is refused (the lease stays held)');
select cr.rotate(:'acct1', :'c1', ((:'c1')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days')::text as r1 \gset
select cr.check((:'r1')::jsonb ->> 'status' = 'rotated', 'R1 rotate: ' || :'r1');
select cr.h5_write(:'acct1', 'fakeTHREADSrefreshR1_0123456789');
select cr.check(cr.token_of(:'acct1') = 'fakeTHREADSrefreshR1_0123456789' and cr.gen_of(:'acct1') <> :'gen0', 'R1 the refreshed token with a new generation');
select cr.check(cr.recorded(:'acct1') > ((:'c1')::jsonb ->> 'custody_recorded_at')::timestamptz, 'R1 a later recorded_at');

-- R2. Two rotations in ONE transaction: the version timestamp does NOT change between them (same now()), but each needs a
--     fresh single-use lease, the expiry strictly grows and G3's generation still changes; no lease is ever used twice.
begin;
select cr.claim(:'acct1')::text as a \gset
select cr.rotate(:'acct1', :'a', ((:'a')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '51 days')::text as ra \gset
select cr.recorded(:'acct1') as rec_a, cr.expires(:'acct1') as exp_a, cr.gen_of(:'acct1') as gen_a \gset
select cr.claim(:'acct1')::text as b \gset
select cr.rotate(:'acct1', :'b', ((:'b')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '52 days')::text as rb \gset
select cr.recorded(:'acct1') as rec_b, cr.expires(:'acct1') as exp_b, cr.gen_of(:'acct1') as gen_b \gset
commit;
select cr.check((:'ra')::jsonb ->> 'status' = 'rotated' and (:'rb')::jsonb ->> 'status' = 'rotated', 'R2 both rotated');
select cr.check(:'rec_a'::timestamptz = :'rec_b'::timestamptz, 'R2 FACT: the same recorded_at for both versions (same now())');
select cr.check(:'exp_b'::timestamptz > :'exp_a'::timestamptz and :'gen_b' <> :'gen_a', 'R2 the expiry grew and the generation changed anyway');
select cr.check(cr.rotate(:'acct1', :'a', :'rec_a'::timestamptz, now() + interval '53 days') ->> 'code' = 'LEASE_NOT_HELD', 'R2 lease a replayed: refused');
select cr.check(cr.rotate(:'acct1', :'b', :'rec_b'::timestamptz, now() + interval '53 days') ->> 'code' = 'LEASE_NOT_HELD', 'R2 lease b replayed: refused');

-- R3. A stale expected version with a fresh lease (separate transactions) -> STALE_CREDENTIAL; nothing written.
select cr.claim(:'acct1')::text as c \gset
select cr.rotate(:'acct1', :'c', ((:'c')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '54 days')::text as rc \gset
select cr.check((:'rc')::jsonb ->> 'status' = 'rotated', 'R3 setup rotate');
select cr.claim(:'acct1')::text as d \gset
select cr.recorded(:'acct1') as rec_before_d, cr.expires(:'acct1') as exp_before_d \gset
select cr.check(cr.rotate(:'acct1', :'d', ((:'c')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'code' = 'STALE_CREDENTIAL',
                'R3 stale recorded_at with a fresh lease: STALE_CREDENTIAL');
select cr.check(cr.recorded(:'acct1') = :'rec_before_d'::timestamptz and cr.expires(:'acct1') = :'exp_before_d'::timestamptz, 'R3 nothing written');
select cr.check(cr.release(:'acct1', :'d') ->> 'status' is not null, 'R3 release');

-- R4. Rollback: a rotation rolled back leaves custody and leases as before; the next rotation works.
select cr.recorded(:'acct1') as rec_r4, cr.expires(:'acct1') as exp_r4 \gset
begin;
select cr.claim(:'acct1')::text as e \gset
select cr.check(cr.rotate(:'acct1', :'e', ((:'e')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '56 days') ->> 'status' = 'rotated', 'R4 rotated inside');
rollback;
select cr.check(cr.recorded(:'acct1') = :'rec_r4'::timestamptz and cr.expires(:'acct1') = :'exp_r4'::timestamptz
                and not exists (select 1 from public.threads_credential_refresh_leases where social_account_id = :'acct1'), 'R4 rollback undid rotation and lease');
select cr.claim(:'acct1')::text as e2 \gset
select cr.check(cr.rotate(:'acct1', :'e2', ((:'e2')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '57 days') ->> 'status' = 'rotated', 'R4 the next rotation');

-- R5. After revocation / expiry: disconnected while a lease is held -> rotate CONNECTION_NOT_VERIFIED; expired -> claim refused.
select cr.connected(105, 'r5') as acct5 \gset
select cr.claim(:'acct5')::text as f \gset
update public.social_accounts set connection_status = 'unconnected' where id = :'acct5';
select cr.check(cr.rotate(:'acct5', :'f', ((:'f')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days') ->> 'code' = 'CONNECTION_NOT_VERIFIED', 'R5 disconnected under a lease');
select cr.connected(106, 'r5b') as acct6 \gset
update public.threads_account_credential_custody set expires_at = clock_timestamp() - interval '1 second' where social_account_id = :'acct6';
select cr.claim(:'acct6')::text as g \gset
select cr.check((:'g')::jsonb ->> 'code' in ('CREDENTIAL_EXPIRED', 'CUSTODY_UNKNOWN'), 'R5 expired: claim refused: ' || :'g');

-- R6. A reconnect while a lease is held, the usual timing (separate transactions, different now()): the stale refresh is
--     refused (STALE_CREDENTIAL); the reconnect's token stays.
select cr.connected(107, 'r6') as acct7 \gset
select cr.uid(107) as u7 \gset
select cr.claim(:'acct7')::text as h \gset
select cr.check(cr.t_begin(:'u7', 'r6b') = :'acct7' and cr.t_complete(:'u7', 'r6b', '17841400000000107', now() + interval '40 days') = 'OK', 'R6 reconnect');
select cr.rotate(:'acct7', :'h', ((:'h')::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days')::text as r6 \gset
select cr.check(:'r6'::jsonb ->> 'code' in ('STALE_CREDENTIAL', 'LEASE_NOT_HELD'), 'R6 stale refresh after a reconnect: refused (' || :'r6' || ')');
select cr.check(cr.token_of(:'acct7') = cr.token('r6b'), 'R6 the reconnect''s token stays');

-- R7. The SAME now(): connect, claim, reconnect and rotate in one transaction (one statement). recorded_at, verified_at and
--     the claimed version all equal now(): the rotation's CAS cannot see the reconnect.
-- p_other_puid: the reconnect names a DIFFERENT Threads user (R7b), to see what the stale refresh hands out then.
create function cr.same_now_reconnect(p_n integer, p_other_puid boolean default false) returns jsonb language plpgsql as $$
declare v_user uuid := cr.enroll(p_n); v_acct text; v_claim jsonb; v_rot jsonb; v_rec0 timestamptz; v_reconnect text;
begin
  v_acct := cr.t_begin(v_user, 'r7a_' || p_n);
  perform cr.check(cr.t_complete(v_user, 'r7a_' || p_n, '178414000000' || lpad(p_n::text, 5, '0'), now() + interval '30 days') = 'OK', 'R7 connect');
  v_claim := cr.claim(v_acct);
  perform cr.check(v_claim ->> 'status' = 'claimed', 'R7 claim ' || v_claim::text);
  v_rec0 := (v_claim ->> 'custody_recorded_at')::timestamptz;
  perform cr.check(cr.t_begin(v_user, 'r7b_' || p_n) = v_acct, 'R7 reconnect begin');
  v_reconnect := cr.t_complete(v_user, 'r7b_' || p_n, '178414000000' || lpad((p_n + case when p_other_puid then 50 else 0 end)::text, 5, '0'),
                               now() + interval '40 days');
  if v_reconnect is distinct from 'OK' then
    return jsonb_build_object('reconnect', v_reconnect, 'account', v_acct);
  end if;
  v_rot := cr.rotate(v_acct, v_claim, v_rec0, now() + interval '55 days');
  if v_rot ->> 'status' = 'rotated' then
    perform cr.h5_write(v_acct, 'fakeTHREADSstaleLineage_0123456789'); -- H5 writes the refresh of the PRE-reconnect token
  end if;
  return jsonb_build_object('reconnect', v_reconnect, 'rotation', v_rot,
                            'threads_user_now', split_part(cr.cred(v_acct), '|', 2), 'recorded_equal', cr.recorded(v_acct) = v_rec0,
                            'verified_equal', (select verified_at from public.social_accounts where id = v_acct) = v_rec0,
                            'token_now', cr.token_of(v_acct), 'reconnect_token', cr.token('r7b_' || p_n), 'account', v_acct);
end $$;
select cr.same_now_reconnect(108)::text as r7 \gset
select 'R7 ' || :'r7' as observed;
select cr.same_now_reconnect(109, true)::text as r7b \gset
select 'R7b ' || :'r7b' as observed;
-- The same account cannot be reconnected to another Threads user (PR #418's entry), so the finding stays within ONE Threads user.
select cr.check((:'r7b')::jsonb ->> 'reconnect' = 'ERR:THREADS_IDENTITY_ACCOUNT_MISMATCH' and (:'r7b')::jsonb -> 'rotation' is null,
                'R7b a reconnect to another Threads user is refused before any rotation');
select (:'fix' = 'none') as r7_unfixed \gset
\if :r7_unfixed
select cr.check((:'r7')::jsonb #>> '{rotation,status}' = 'rotated' and ((:'r7')::jsonb ->> 'recorded_equal')::boolean
                and ((:'r7')::jsonb ->> 'verified_equal')::boolean and (:'r7')::jsonb ->> 'threads_user_now' = '17841400000000108'
                and (:'r7')::jsonb ->> 'token_now' = 'fakeTHREADSstaleLineage_0123456789',
                'R7 REPRODUCED (FAIL of the safety expectation): the stale refresh rotated over the reconnect; the pre-reconnect lineage token is handed out');
select 'R7_FINDING_REPRODUCED' as finding;
\else
select cr.check((:'r7')::jsonb #>> '{rotation,code}' in ('LEASE_NOT_HELD', 'STALE_CREDENTIAL')
                and (:'r7')::jsonb ->> 'token_now' = (:'r7')::jsonb ->> 'reconnect_token',
                'R7 with the prototype fix: refused, the reconnect''s token stays');
select 'R7_FIX_PROTOTYPE_HOLDS' as finding;
\endif

select 'POSTONA_THREADS_ROTATION_CAS_BEHAVIOR_DONE' as result;
