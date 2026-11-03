#!/usr/bin/env bash
# G4-24 (Issue #319): Threads PR #412 (credential_row) x PR #418 (binding entry + custody connect proof) COMPOSED on a disposable
# LOCAL PostgreSQL 17. Never production, never a managed Supabase, never real Vault, OAuth, tokens or Threads (fake values only).
#
# 1. A throwaway tree from this checkout (PR #418's candidates) plus BOUNDED, READ-ONLY copies (an overlay path that already
#    exists stops the run; nothing is merged, checked out or pushed):
#      G5 PR #399 e363c708bcb331abccc0eb51d8b2229936c87ef6  the chain (P1..P10 not on main), its fixtures, F5's owner epoch,
#                                                           R1 / W1 / W2 (001) and R0 (002)
#      G4 PR #412 b83a7a92524a8862fe0a291d54a364fe15d8048d  credential_row 001 + rollback (+ its own runner / behavior, only to
#                                                           show they do not run on PR #418's world)
#      G3 PR #374 e3dfbd3cce3fffccdb638159f3aa6c3313d5098c  007: ONLY threads_credential_generation, verbatim
# 2. The world: G4's (2a-2, X tables, PR #124 + its fake attestation key, G4 custody) on G5's chain; TEST-WORLD auth.uid() that
#    reads the per-claim setting, else request.jwt.claims (as G5's runner); TEST-WORLD revoke on brand_memberships (as F5).
# 3. The old PR #412 proof on the composed world: its behavior stops at attest_binding (does not exist after PR #405 / #418).
# 4. Order: credential_row before 001, 002 before 001 refused; 001 -> 002 -> credential_row applies.
# 5. postona_threads_credential_composition_behavior.sql.
# 6. Rollback order: credential_row -> 002 -> 001 (clean); the wrong order (001 first) leaves calls failing loudly, not rows.
# 7. Negative controls: mutants of credential_row / 002 / 001 must FAIL the behavior.
# 8. Rotation (recorded_at CAS): tried on the composed world; its own preconditions decide (NOT_RUN if they refuse).
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_threads_credential_composition_run.sh
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

tree="$(mktemp -d /private/tmp/kabumori-tq.XXXXXX)"
n="$$"
owner="kb_tq_owner_$n"
delegate="kb_tq_delegate_$n"
prefix="kabumori_tq_${n}"
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

# ---- 3. The old PR #412 proof on the composed world -------------------------------------------------------------------
old="$(copy old412 "$pre")"
need "$old" "$b001"; need "$old" "$b002"; need "$old" "$cred"
# (its psql variable: a delegate role authenticated may SET ROLE to, holding nothing -- as PR #412's runner makes it)
"${as_super[@]}" -d postgres -c "create role $delegate nologin" -c "grant $delegate to authenticated with inherit false, set true" > /dev/null
got="$(as_owner "$old" -A -t -v delegate="$delegate" -f "$t/postona_threads_credential_atomic_behavior.sql" 2>&1 || true)"
oldmsg="$(grep -m1 -o -E 'attest_binding[^"]*does not exist|ERROR: .*' <<<"$got" | head -1)"
[[ "$oldmsg" == *attest_binding* || "$got" == *attest_binding* ]] || fail "old PR #412 behavior on the composed world: expected the attest_binding stop, got: $(grep -m1 ERROR <<<"$got")"
echo "PASS reproduced: PR #412's own behavior stops on the composed world -> $(grep -m1 -o -E 'function postona_threads_binding\.attest_binding\([^)]*\) does not exist' <<<"$got")"

# ---- 4. Order of application --------------------------------------------------------------------------------------------
expect() { local label="$1" db="$2" file="$3" code="$4" got; got="$(apply "$db" "$file")"; [[ "$got" == "$code"* ]] || fail "$label: $got"; echo "  $label -> $got"; }
db="$(copy o_cred_first "$pre")"
expect "credential_row before 001" "$db" "$cred" THREADS_CREDENTIAL_PRECONDITION_TABLES
db="$(copy o_002_first "$pre")"
expect "002 before 001" "$db" "$b002" THREADS_CUSTODY_PROOF_PRECONDITION_BINDING
world="$(copy world "$pre")"
need "$world" "$b001"; need "$world" "$b002"; need "$world" "$cred"
echo "PASS order: credential_row / 002 before 001 refused; 001 -> 002 -> credential_row applies"

# ---- 5. Behavior -----------------------------------------------------------------------------------------------------
main="$(copy main "$world")"
out="$(as_owner "$main" -A -t -f "$behavior" 2>&1)" || fail "composition behavior: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_CREDENTIAL_COMPOSITION_BEHAVIOR_PASS <<<"$out" || fail "composition behavior marker missing"
grep -E '^C7_(MIXED|OTHER)' <<<"$out" | sed 's/^/  observed: /'
echo "PASS composition behavior (postona_threads_credential_composition_behavior.sql)"

# ---- 6. Rollback order ------------------------------------------------------------------------------------------------
connect_one() { { sed -n '1,/^-- K1\. ACL/p' "$behavior" | sed '$d'; echo "select cr.connected(91, 'rb') as acct \\gset"; } > "$tree/rb_setup.sql"; as_owner "$1" -A -t -f "$tree/rb_setup.sql" > /dev/null; }
rb="$(copy rb_right "$world")"; connect_one "$rb"
acct="$(q "$rb" -c "select id from public.social_accounts where platform_user_id = '17841400000000091'")"
[[ "$(q "$rb" -c "select count(*) from postona_threads_credential.credential_row('$acct', 'x_autopost')")" == 1 ]] || fail "rollback setup: no row"
need "$rb" "$credrb"; need "$rb" "$b002rb"; need "$rb" "$b001rb"
[[ "$(q "$rb" -c "select to_regnamespace('postona_threads_credential') is null and to_regnamespace('postona_threads_binding') is null and (select md5(prosrc) from pg_proc where oid = 'public.record_threads_credential_custody(text,timestamptz)'::regprocedure) = 'eb58930b04d23d6a012cf1b54ab93e0f'")" == t ]] \
  || fail "rollback in order did not restore the pre-install state"
echo "PASS rollback in order: credential_row -> 002 -> 001 (schemas gone, the custody writer is the candidate's original again)"
rb="$(copy rb_wrong "$world")"; connect_one "$rb"
need "$rb" "$b001rb"
w1="$(q "$rb" -c "select count(*) from postona_threads_credential.credential_row('$acct', 'x_autopost')" 2>&1 || true)"
[[ "$w1" == *"does not exist"* ]] || fail "wrong order: credential_row after 001's rollback answered: $w1"
w2="$(q "$rb" -c "select public.record_threads_credential_custody('$acct', now() + interval '1 day')" 2>&1 || true)"
[[ "$w2" == *ERROR* ]] || fail "wrong order: the custody writer after 001's rollback answered: $w2"
need "$rb" "$b002rb"; need "$rb" "$credrb"
echo "PASS rollback out of order (001 first): credential_row and the custody writer then FAIL LOUDLY (no row, no write); 002 and credential_row still roll back after"
echo "  credential_row: $(grep -o 'ERROR: .*' <<<"$w1" | head -1 | cut -c1-110)"

# ---- 7. Negative controls -----------------------------------------------------------------------------------------------
caught=0; total=0
mutate() {
  local name="$1" target="$2" old="$3" new="$4" file db
  total=$((total + 1))
  file="$tree/mut_$name.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$target" "$file" "$old" "$new" || fail "mutation $name: pattern not unique"
  db="$(copy "m_$name" "$pre")"
  local a1="$b001" a2="$b002" a3="$cred"
  case "$target" in "$b001") a1="$file" ;; "$b002") a2="$file" ;; "$cred") a3="$file" ;; esac
  if [[ "$(apply "$db" "$a1")" != applied || "$(apply "$db" "$a2")" != applied || "$(apply "$db" "$a3")" != applied ]] \
     || ! as_owner "$db" -A -t -f "$behavior" > /dev/null 2>&1; then
    caught=$((caught + 1)); echo "  CAUGHT $name"
  else
    echo "  MISSED $name"
  fi
}
mutate cred_expiry_tx_start "$cred" "public.threads_account_credential_expires_at(sa.id) > pg_catalog.clock_timestamp()" "public.threads_account_credential_expires_at(sa.id) > pg_catalog.now()"
mutate cred_any_isolation "$cred" "         and pg_catalog.current_setting('transaction_isolation') = 'read committed'
" ""
mutate cred_no_w1 "$cred" "         and private.account_lifecycle_worker_brand_verdict(sa.brand_id, 'x_autopost', b.owner_epoch, b.lifecycle_version) = 'active'
" ""
mutate cred_no_bound_owner "$cred" "         and b.bound_by = private.account_lifecycle_brand_owner(sa.brand_id)
" ""
mutate custody_no_proof "$b002" "          and b.connect_proof::text = v_proof) then" "          ) then"
mutate entry_no_proof_setting "$b001" "  perform pg_catalog.set_config('postona_threads_binding.connect_proof', v_proof::text, true);" ""
echo "negative controls caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a negative control was not caught"

# ---- 8. Rotation (recorded_at CAS) ------------------------------------------------------------------------------------
# The rotation candidate applies after G4's publish stack (custody -> manual publish -> publish release). Its basic CAS on the
# composed world: claim -> rotate with the claimed (secret id, recorded_at) = rotated; a stale recorded_at = refused. A race of
# two transactions with the SAME now() (recorded_at is written with now()) is NOT exercised here (NOT_RUN).
rot="$(copy rotation "$world")"
rot_state=applied
for f in threads_manual_publish_candidate.sql threads_publish_release_candidate.sql threads_credential_rotation_candidate.sql; do
  got="$(apply "$rot" "$c/postona_threads_publish/$f")"
  if [[ "$got" != applied ]]; then rot_state="$f -> $got"; break; fi
done
if [[ "$rot_state" == applied ]]; then
  connect_one "$rot"
  racct="$(q "$rot" -c "select id from public.social_accounts where platform_user_id = '17841400000000091'")"
  claim1="$(q "$rot" -c "select public.claim_threads_credential_refresh('$racct')::text")"
  [[ "$(jq -r .status <<<"$claim1")" == claimed ]] || fail "rotation claim: $claim1"
  lease1="$(jq -r .lease <<<"$claim1")"; secret1="$(jq -r .vault_secret_id <<<"$claim1")"; rec1="$(jq -r .custody_recorded_at <<<"$claim1")"
  r1="$(q "$rot" -c "select public.rotate_threads_credential_custody('$racct', '$lease1'::uuid, '$secret1'::uuid, '$rec1'::timestamptz, now() + interval '50 days')::text")"
  [[ "$(jq -r .status <<<"$r1")" == rotated ]] || fail "rotation CAS with the claimed version: $r1"
  [[ "$(q "$rot" -c "select count(*) from postona_threads_credential.credential_row('$racct', 'x_autopost')")" == 1 ]] || fail "credential_row after rotation"
  claim2="$(q "$rot" -c "select public.claim_threads_credential_refresh('$racct')::text")"
  lease2="$(jq -r .lease <<<"$claim2")"
  r2="$(q "$rot" -c "select public.rotate_threads_credential_custody('$racct', '$lease2'::uuid, '$secret1'::uuid, '$rec1'::timestamptz, now() + interval '55 days')::text")"
  [[ "$(jq -r .status <<<"$r2")" == refused ]] || fail "rotation CAS with a stale recorded_at was not refused: $r2"
  echo "PASS rotation basic CAS on the composed world: claimed version -> rotated (credential_row still one row); stale recorded_at -> $(jq -r .code <<<"$r2")"
  echo "  NOT_RUN: two transactions with the same now() writing / expecting recorded_at (the same-microsecond case of G4-16's observation)"
else
  echo "ROTATION NOT_RUN: $rot_state"
fi
echo "POSTONA_THREADS_CREDENTIAL_COMPOSITION_RUN_PASS"
