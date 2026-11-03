# G4-27 (Issue #319): rewrites, in a DISPOSABLE copy only, the expectations of F4's rotation suite
# (postona_threads_rotation_behavior.sql + postona_threads_rotation_run.sh) that option A changes ON PURPOSE, so the
# whole suite (ACL, publish in flight, every F5 state, owner binding, 13 races, mutants) re-runs with the candidate.
# Every replacement must match exactly once; the list below is the complete set of semantic changes:
#   L1  section 7: a reconnect under a held lease ends the lease (was STALE_CREDENTIAL / LEASE_HELD / released).
#   L2  sections 9 and 14: the direct custody writes that set up rotate's OWN expiry / secret checks run with the
#       invalidation trigger disabled (test world only), so those checks stay covered; each section then asserts that
#       the same write with the trigger enabled ends the lease (section 9: an INSERT; section 14: an UPDATE, after
#       which section 14 claims again for its final "rotates" step).
#   L3  race "reconnect": the waiting rotate now answers LEASE_NOT_HELD (the reconnect ended the lease).
#   L4  mutant lease_not_consumed: equivalent under A (rotate's own custody update ends the lease) -> expected NOT
#       caught, reported as EQUIVALENT_UNDER_A instead of failing the suite.
# Usage: python3 -I postona_threads_lease_invalidation_legacy_patch.py <behavior.sql> <run.sh>
import sys

behavior_path, runner_path = sys.argv[1:3]
TRG = "threads_credential_refresh_lease_invalidate_row"
OFF = f"alter table public.threads_account_credential_custody disable trigger {TRG};\n"
ON = f"alter table public.threads_account_credential_custody enable always trigger {TRG};\n"

behavior = [
    # L1
    ("""                   'STALE_CREDENTIAL', '7 rotate after a reconnect');""",
     """                   'LEASE_NOT_HELD', '7 rotate after a reconnect (G4-27 A: the reconnect ended the lease)');"""),
    ("""select rot.refused(format('select rot.claim(%L)', :'acct_f'), 'LEASE_HELD', '7 the stale lease is still held');
select t13.check(public.release_threads_credential_refresh(:'acct_f', (:'c_f'::jsonb ->> 'lease')::uuid) ->> 'status' = 'released', '7 release');""",
     """select t13.check(not exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_f'), '7 G4-27 A: no lease after the reconnect');
select t13.check(public.release_threads_credential_refresh(:'acct_f', (:'c_f'::jsonb ->> 'lease')::uuid) ->> 'status' = 'not_held', '7 release (G4-27 A: already ended)');"""),
    # L2 (section 9)
    ("""update public.threads_account_credential_custody set expires_at = clock_timestamp() - interval '1 second' where social_account_id = :'acct_h';""",
     OFF + """update public.threads_account_credential_custody set expires_at = clock_timestamp() - interval '1 second' where social_account_id = :'acct_h';"""),
    ("""select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_h', :'c_h'), 'STALE_CREDENTIAL', '9 rotate without custody');""",
     """select rot.refused(format('select rot.rotate(%L, %L::jsonb)', :'acct_h', :'c_h'), 'STALE_CREDENTIAL', '9 rotate without custody');
""" + ON + """select t13.check(exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_h'), '9 G4-27 the lease was kept while the trigger was off');
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_at, recorded_by)
select a.id, a.vault_access_token_secret_id, clock_timestamp() + interval '30 days', now(), gen_random_uuid() from public.social_accounts a where a.id = :'acct_h';
select t13.check(not exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_h'), '9 G4-27 A: a custody INSERT ends the lease');"""),
    # L2 (section 14)
    ("""update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid() where social_account_id = :'acct_l';""",
     OFF + """update public.threads_account_credential_custody set vault_secret_id = gen_random_uuid() where social_account_id = :'acct_l';"""),
    ("""update public.threads_account_credential_custody set vault_secret_id = :'secret_l'::uuid where social_account_id = :'acct_l';""",
     """update public.threads_account_credential_custody set vault_secret_id = :'secret_l'::uuid where social_account_id = :'acct_l';
""" + ON + """select t13.check(exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_l'), '14 G4-27 the lease was kept while the trigger was off');
update public.threads_account_credential_custody set recorded_by = recorded_by where social_account_id = :'acct_l';
select t13.check(not exists (select 1 from public.threads_credential_refresh_leases l where l.social_account_id = :'acct_l'), '14 G4-27 A: any custody UPDATE ends the lease');
select rot.claim(:'acct_l') as c_l \\gset"""),
]

runner = [
    # L3
    ("""'fake_threads_race_RECONNECTED_0123456789'); select pg_sleep(1.5); commit;" STALE_CREDENTIAL "c$tag")\"""",
     """'fake_threads_race_RECONNECTED_0123456789'); select pg_sleep(1.5); commit;" LEASE_NOT_HELD "c$tag")\""""),
    # L4
    ("""mutate lease_not_consumed """, """mutate_equivalent_under_a lease_not_consumed """),
    ("""# ---- 2e. Mutations ------------------------------------------------------------------------------------------------
""",
     """# ---- 2e. Mutations ------------------------------------------------------------------------------------------------
mutate_equivalent_under_a() { # G4-27 L4: expected NOT caught under option A
  local name="$1" from="$2" to="$3" out="$tree/mut_$1.sql" got
  FROM="$from" TO="$to" perl -0pe 's/\\Q$ENV{FROM}\\E/$ENV{TO}/' "$candidate" > "$out"
  cmp -s "$candidate" "$out" && fail "mutation $name: pattern not found"
  got="$(prove "$out" "$name")"
  [[ "$got" == PASS ]] || fail "mutation $name: expected EQUIVALENT under A, got ${got:0:140}"
  echo "EQUIVALENT_UNDER_A mutation $name (rotate's own custody update ends the lease)"
}
"""),
]


def patch(path, pairs):
    text = open(path, encoding="utf-8").read()
    for old, new in pairs:
        n = text.count(old)
        if n != 1:
            sys.exit(f"G4-27 legacy patch: {path}: pattern found {n} times: {old[:80]!r}")
        text = text.replace(old, new)
    open(path, "w", encoding="utf-8").write(text)


patch(behavior_path, behavior)
patch(runner_path, runner)
print(f"G4-27 legacy patch applied: behavior {len(behavior)} + runner {len(runner)} replacements")
