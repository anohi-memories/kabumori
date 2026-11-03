#!/usr/bin/env bash
# G4-25 (Issue #319): the Threads credential rotation compare-and-set (supabase/candidates/postona_threads_publish/
# threads_credential_rotation_candidate.sql) on the COMPOSED world of G4-24 (this file's sections 1-2 are those of
# postona_threads_credential_composition_run.sh, copied so that this proof stands alone), on a disposable LOCAL PostgreSQL 17.
# Never production, never a managed Supabase, never real Vault, OAuth, tokens or Threads (fake values only).
#   3. install: 001 -> 002 -> credential_row (PR #412) -> G4 manual publish -> publish release -> rotation
#   4. postona_threads_rotation_cas_behavior.sql with fix=none (R1..R7; R7 = the same-now() reconnect reproduction)
#   5. the same with a TEST-WORLD prototype fix (every custody write deletes the account's refresh lease): R7 must hold
#   6. two sessions rotating with the same lease: exactly one rotates
#   7. two DIFFERENT transactions with the same now() (postona_threads_rotation_cas_collision.mjs, needs node): reproduction
#      without the fix, refusal with the prototype
#   8. negative controls: mutants of the rotation candidate must change the behavior's outcome
# Findings are REPORTED (R7 / the collision reproduce a safety-expectation violation); the run marker says so. Nothing here
# changes a product file: the prototype fix and the mutants live only in the disposable databases.
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_threads_rotation_cas_run.sh
set -euo pipefail
export LC_ALL=C
export PGOPTIONS="-c client_min_messages=warning"

host="${TQ_PGHOST:?TQ_PGHOST (local socket dir) required}"
port="${TQ_PGPORT:?TQ_PGPORT required}"
super="${TQ_PGSUPER:?TQ_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: TQ_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
G5=e363c708bcb331abccc0eb51d8b2229936c87ef6
PR412=b83a7a92524a8862fe0a291d54a364fe15d8048d
PR374=e3dfbd3cce3fffccdb638159f3aa6c3313d5098c
for sha in "$G5" "$PR412" "$PR374"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-tr.XXXXXX)"
n="$$"
owner="kb_tr_owner_$n"
delegate="kb_tr_delegate_$n"
prefix="kabumori_tr_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $delegate" -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree ----------------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/TQ_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/TQ_MANIFEST.txt"; done
}
overlay "$G5" supabase/tests/common_account_phase9_auth_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql \
  supabase/migrations/20261013140000_common_account_service_reconciliation_facts.sql \
  supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql \
  supabase/migrations/20261015120000_common_account_x_unconfirmed_snapshot_record.sql \
  supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql \
  supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql \
  supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql
overlay "$PR412" supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic.sql \
  supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql \
  supabase/tests/postona_threads_credential_atomic_behavior.sql
git -C "$repo" show "$PR374:supabase/candidates/postona_threads_reservations/007_postona_threads_reservations.sql" > "$tree/g3_007.sql"
echo "$PR374 $(shasum -a 256 "$tree/g3_007.sql" | cut -c1-16) 007 (generation function only)" >> "$tree/TQ_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
b001="$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql"; b001rb="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
b002="$c/postona_threads_binding_epoch/002_custody_connect_proof.sql"; b002rb="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
cred="${TQ_CREDENTIAL:-$c/postona_threads_credential_atomic/001_threads_credential_atomic.sql}"; credrb="$c/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql"
behavior="$t/postona_threads_credential_composition_behavior.sql"
rotation_behavior="$t/postona_threads_rotation_cas_behavior.sql"
rotation="$c/postona_threads_publish/threads_credential_rotation_candidate.sql"
sed 's/^/  /' "$tree/TQ_MANIFEST.txt"

# ---- 2. The world ---------------------------------------------------------------------------------------------------
"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin noinherit; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role to $owner;
SQL
as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
create_db() { "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null; }
copy() { local db="${prefix}_$1"; create_db "$db" "$2"; echo "$db"; }
apply() {
  local db="$1" file="$2" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$file" 2>&1)"; then echo applied
  else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}
need() { local got; got="$(apply "$1" "$2")"; [[ "$got" == applied ]] || fail "$(basename "$2") did not apply: $got"; }
pre="${prefix}_pre"
create_db "$pre"
as_owner "$pre" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$pre" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$pre" -f "$m/$f" > /dev/null
done
as_owner "$pre" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
as_owner "$pre" -f "$t/common_account_phase9_auth_fixture.sql" > /dev/null
q "$pre" -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
         20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state; do
  need "$pre" "$m/$f.sql"
done
as_owner "$pre" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
q "$pre" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$pre" > /dev/null
q "$pre" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
need "$pre" "$m/20261007150000_postona_social_accounts_multi_provider.sql"
for f in 20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
         20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
  need "$pre" "$m/$f.sql"
done
"${as_super[@]}" -d "$pre" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
as_owner "$pre" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
as_owner "$pre" -f "$m/20260918120000_social_mobile_brand_memberships.sql" > /dev/null
# TEST-WORLD revoke (as F5's / G5's runners): PR #303 refuses API TRIGGER / TRUNCATE / REFERENCES on brand_memberships.
q "$pre" -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" > /dev/null
need "$pre" "$c/common_account_brand_owner_epoch/001_brand_owner_epoch.sql"
# TEST-WORLD auth.uid() (as G5's runner [A]): the per-claim setting, else request.jwt.claims ->> 'sub'. Managed: NOT_VERIFIED.
q "$pre" -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" > /dev/null
need "$pre" "$c/common_account_authorization_verdict/001_authorization_verdict.sql"
need "$pre" "$c/postona_threads_oauth_workspace_candidate.sql"
need "$pre" "$c/postona_threads_publish/threads_credential_custody_candidate.sql"
q "$pre" -c "create schema postona_threads_resv; revoke all on schema postona_threads_resv from public" > /dev/null
awk 'index($0,"create function postona_threads_resv.threads_credential_generation(") == 1 {on=1} on {print} on && $0=="end $$;" {exit}' "$tree/g3_007.sql" > "$tree/g3_generation.sql"
[[ -s "$tree/g3_generation.sql" ]] || fail "G3's generation function not found in 007"
need "$pre" "$tree/g3_generation.sql"
q "$pre" -c "revoke all on function postona_threads_resv.threads_credential_generation(text) from public, anon, authenticated, service_role" > /dev/null
echo "PASS world: G5 chain P1..P10 + R1/W1 (PR #399) + F5 owner epoch + 2a-2 + PR #124 + G4 custody + G3 generation (PR #374, verbatim)"

# ---- 3. Install the composed world + G4's publish stack + the rotation candidate ------------------------------------------
world="$(copy world "$pre")"
need "$world" "$b001"; need "$world" "$b002"; need "$world" "$cred"
for f in threads_manual_publish_candidate.sql threads_publish_release_candidate.sql; do need "$world" "$c/postona_threads_publish/$f"; done
base="$(copy base "$world")"
need "$world" "$rotation"
echo "PASS world + rotation candidate installed"
prelude() { sed -n '1,/^-- K1\. ACL/p' "$behavior" | sed '$d'; }
{ prelude; cat "$rotation_behavior"; } > "$tree/rotation_behavior_full.sql"
fix_trigger="create function public.g4_25_prototype_drop_lease() returns trigger language plpgsql security invoker set search_path = '' as \$\$ begin delete from public.threads_credential_refresh_leases l where l.social_account_id = new.social_account_id; return new; end \$\$; create trigger g4_25_prototype_drop_lease after insert or update on public.threads_account_credential_custody for each row execute function public.g4_25_prototype_drop_lease()"
run_behavior() { # db fix -> output
  as_owner "$1" -A -t -v fix="$2" -f "$tree/rotation_behavior_full.sql" 2>&1
}

# ---- 4. Behavior, the candidate as it is ---------------------------------------------------------------------------------
b4="$(copy b_none "$world")"
out="$(run_behavior "$b4" none)" || fail "rotation behavior (fix=none): $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_ROTATION_CAS_BEHAVIOR_DONE <<<"$out" || fail "rotation behavior marker missing"
grep -q R7_FINDING_REPRODUCED <<<"$out" || fail "R7 not reproduced"
grep -E '^R7b? ' <<<"$out" | sed 's/^/  observed: /'
echo "PASS R1-R6 (baseline, two rotations in one transaction, stale version, rollback, revoked / expired, reconnect at a later now())"
echo "FINDING R7 REPRODUCED: connect, claim, reconnect and rotate under ONE now(): the stale refresh is accepted over the reconnect"

# ---- 5. Behavior with the TEST-WORLD prototype fix ---------------------------------------------------------------------
b5="$(copy b_fix "$world")"
q "$b5" -c "$fix_trigger" > /dev/null
out="$(run_behavior "$b5" drop_lease_on_custody)" || fail "rotation behavior (prototype fix): $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q R7_FIX_PROTOTYPE_HOLDS <<<"$out" || fail "R7 prototype fix did not hold"
echo "PASS with the prototype fix: R1-R6 unchanged, R7 refused (the reconnect's token stays)"

# ---- 6. Two sessions rotating with the same lease ------------------------------------------------------------------------
race="$(copy race "$world")"
{ prelude; sed -n '/^create function cr.claim/,/^-- R1\./p' "$rotation_behavior" | sed '$d'; echo "select cr.connected(171, 'race') as acct \\gset"; } > "$tree/race_setup.sql"
as_owner "$race" -A -t -f "$tree/race_setup.sql" > /dev/null
racct="$(q "$race" -c "select id from public.social_accounts where platform_user_id = '17841400000000171'")"
rclaim="$(q "$race" -c "select cr.claim('$racct')::text")"
one="select (cr.rotate('$racct', '$rclaim'::jsonb, ('$rclaim'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days'))::text"
( as_owner "$race" -A -t -c "begin" -c "$one" -c "select pg_sleep(1.5)" -c "commit" > "$tree/race1.out" 2>&1 ) &
holder=$!
sleep 0.4
second="$(q "$race" -c "$one" 2>&1 || true)"
wait "$holder" || fail "race holder: $(cat "$tree/race1.out")"
first="$(grep '{' "$tree/race1.out")"
[[ "$(jq -r .status <<<"$first")" == rotated ]] || fail "race first: $first"
[[ "$(jq -r .status <<<"$second")" == refused ]] || fail "race second: $second"
echo "PASS same lease from two sessions: one rotated, the other $(jq -r .code <<<"$second")"

# ---- 7. Two different transactions with the same now() -------------------------------------------------------------------
node_bin="${NODE:-node}"
coll_setup() {
  { prelude; sed -n '/^create function cr.claim/,/^-- R1\./p' "$rotation_behavior" | sed '$d'
    cat <<'SQL'
select cr.enroll(181) as cu \gset
select cr.check(cr.t_begin(:'cu', 's1') like 'sa_%', 'collision begin s1');
select cr.check(cr.t_begin(:'cu', 's2') like 'sa_%', 'collision begin s2');
SQL
  } > "$tree/coll_setup.sql"
  as_owner "$1" -A -t -f "$tree/coll_setup.sql" > /dev/null
}
cn="$(copy coll_none "$world")"; coll_setup "$cn"
"$node_bin" "$t/postona_threads_rotation_cas_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$cn" none > "$tree/coll_none.out" 2>&1 || fail "collision (none): $(cat "$tree/coll_none.out")"
sed 's/^/  /' "$tree/coll_none.out" | cut -c1-600
cf="$(copy coll_fix "$world")"; q "$cf" -c "$fix_trigger" > /dev/null; coll_setup "$cf"
"$node_bin" "$t/postona_threads_rotation_cas_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$cf" fix > "$tree/coll_fix.out" 2>&1 || fail "collision (fix): $(cat "$tree/coll_fix.out")"
sed 's/^/  /' "$tree/coll_fix.out" | cut -c1-600
echo "FINDING REPRODUCED across transactions with the same now(); the prototype fix refuses it"

# ---- 8. Negative controls (mutants of the rotation candidate, in disposable databases only) ------------------------------
caught=0; total=0
mutate() {
  local name="$1" old="$2" new="$3" file db out
  total=$((total + 1))
  file="$tree/mut_$name.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$rotation" "$file" "$old" "$new" || fail "mutation $name: pattern not unique"
  db="$(copy "m_$name" "$base")"
  if [[ "$(apply "$db" "$file")" != applied ]] || ! run_behavior "$db" none > "$tree/mut_$name.out" 2>&1 || ! grep -q POSTONA_THREADS_ROTATION_CAS_BEHAVIOR_DONE "$tree/mut_$name.out"; then
    caught=$((caught + 1)); echo "  CAUGHT $name: $(grep -m1 -oE 'FAIL .*|ERROR: .*' "$tree/mut_$name.out" 2>/dev/null | cut -c1-160)"
  else
    echo "  MISSED $name"
  fi
}
mutate cas_recorded_at_ignored "     or v_custody.recorded_at is distinct from p_expected_recorded_at
     or v_lease.vault_secret_id is distinct from p_expected_secret_id
     or v_lease.custody_recorded_at is distinct from p_expected_recorded_at" "     or v_lease.vault_secret_id is distinct from p_expected_secret_id"
mutate lease_not_single_use "  delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  return pg_catalog.jsonb_build_object(
    'status', 'rotated'" "  return pg_catalog.jsonb_build_object(
    'status', 'rotated'"
mutate expiry_not_required_to_grow "  if p_new_expires_at <= v_custody.expires_at then return public.threads_credential_rotation_refused('EXPIRY_NOT_EXTENDED'); end if;" ""
mutate connection_not_rechecked "  if v_account.connection_status is distinct from 'identity_verified' or v_account.verified_at is null
     or v_account.vault_access_token_secret_id is null then
    return public.threads_credential_rotation_refused('CONNECTION_NOT_VERIFIED');
  end if;
  select c.* into v_custody from public.threads_account_credential_custody c where c.social_account_id = p_social_account_id for update;
  select l.* into v_lease" "  select c.* into v_custody from public.threads_account_credential_custody c where c.social_account_id = p_social_account_id for update;
  select l.* into v_lease"
echo "negative controls caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a negative control was not caught"
echo "POSTONA_THREADS_ROTATION_CAS_RUN_COMPLETE (findings reproduced: R7 same-transaction, cross-transaction same now(); prototype fix holds)"
