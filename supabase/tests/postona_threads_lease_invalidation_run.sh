#!/usr/bin/env bash
# G4-27 (Issue #319): ISOLATED SOURCE CANDIDATE A (supabase/candidates/postona_threads_rotation_lease_invalidation/
# 001_rotation_lease_invalidation.sql: every custody write ends the account's refresh lease) on the composed world of
# G4-24 / G4-25, on a disposable LOCAL PostgreSQL 17. Never production, never a managed Supabase, never real Vault, OAuth,
# tokens, Meta or Threads (fake values only). Sections 1-3 are those of postona_threads_rotation_cas_run.sh (PR #453),
# copied so that this proof stands alone; nothing here changes an existing file.
#   4. apply order / md5 pin of the rotation bodies / owner / re-apply
#   5. R1-R7b (postona_threads_rotation_cas_behavior.sql, R7 must be refused) + N1-N5 (postona_threads_lease_invalidation_
#      behavior.sql) + N6 replica mode + N7 / N7b writers under RLS or without lease rights + N8 non-owner disable
#   6. lock order: three two-session orders (reconnect / claim / rotate first), no deadlock
#   7. the same lease from two sessions; two transactions with the same now() (postona_threads_rotation_cas_collision.mjs)
#   8. the limit: a trigger disabled by the table owner brings R7 back (reported EXPECTED_FAIL, visible to the audit)
#   9. F4's whole rotation suite (postona_threads_rotation_run.sh) with the candidate, in a temporary worktree, with the
#      expectation changes of postona_threads_lease_invalidation_legacy_patch.py (L1-L4) -- LI_SKIP_LEGACY=1 skips it
#  10. rollback: right order (R7 back), wrong order (fails closed)
#  11. negative controls: mutants of the candidate, caught by behavior with the postcondition stripped
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_threads_lease_invalidation_run.sh
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

tree="$(mktemp -d /private/tmp/kabumori-li.XXXXXX)"
n="$$"
owner="kb_li_owner_$n"
delegate="kb_li_delegate_$n"
prefix="kabumori_li_${n}"
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
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/LI_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/LI_MANIFEST.txt"; done
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
echo "$PR374 $(shasum -a 256 "$tree/g3_007.sql" | cut -c1-16) 007 (generation function only)" >> "$tree/LI_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
b001="$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql"; b001rb="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
b002="$c/postona_threads_binding_epoch/002_custody_connect_proof.sql"; b002rb="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
cred="${TQ_CREDENTIAL:-$c/postona_threads_credential_atomic/001_threads_credential_atomic.sql}"; credrb="$c/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql"
behavior="$t/postona_threads_credential_composition_behavior.sql"
rotation_behavior="$t/postona_threads_rotation_cas_behavior.sql"
rotation="$c/postona_threads_publish/threads_credential_rotation_candidate.sql"
sed 's/^/  /' "$tree/LI_MANIFEST.txt"

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
run_behavior() { # db fix -> output
  as_owner "$1" -A -t -v fix="$2" -f "$tree/rotation_behavior_full.sql" 2>&1
}

cand="$c/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation.sql"
candrb="$c/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation_rollback.sql"
li_behavior="$t/postona_threads_lease_invalidation_behavior.sql"
helpers() { sed -n '/^create function cr.claim/,/^-- R1\./p' "$rotation_behavior" | sed '$d'; }
{ prelude; helpers; cat "$li_behavior"; } > "$tree/li_behavior_full.sql"
"${as_super[@]}" -d postgres -c "create role $delegate login nosuperuser nocreatedb nocreaterole" > /dev/null
as_delegate() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$delegate" -d "$db" "$@"; }
# A copy of a candidate without its postcondition block: a mutant must then be caught by BEHAVIOR, not only at apply.
strip_post() { python3 -I - "$1" "$2" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("-- Postcondition:"); j = s.rindex("commit;")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
}
{ prelude; helpers; } > "$tree/helpers.sql"
prep() { as_owner "$1" -A -t -f "$tree/helpers.sql" > /dev/null; }
# One connected account with a live lease, made by the owner in db $1 (after prep). Prints the account.
lease_account() {
  local acct
  acct="$(q "$1" -c "select cr.connected($2, 'p$2')")"
  [[ "$(q "$1" -c "select cr.claim('$acct') ->> 'status'")" == claimed ]] || fail "lease setup $2"
  echo "$acct"
}
leases_of() { q "$1" -c "select count(*) from public.threads_credential_refresh_leases where social_account_id = '$2'"; }

# Everything one candidate file must show; prints PASS or the first reason. $3 = full (postcondition kept) | stripped.
prove_candidate() {
  local file="$1" tag="$2" db out acct
  db="$(copy "p_$tag" "$world")"
  out="$(apply "$db" "$file")"; [[ "$out" == applied ]] || { echo "APPLY $out"; return 0; }
  out="$(run_behavior "$db" candidate_a)" || { echo "R1-R7 $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q R7_FIX_PROTOTYPE_HOLDS <<<"$out" || { echo "R7 not refused"; return 0; }
  db="$(copy "n_$tag" "$world")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY2"; return 0; }
  out="$(as_owner "$db" -A -t -f "$tree/li_behavior_full.sql" 2>&1)" || { echo "N $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q POSTONA_THREADS_LEASE_INVALIDATION_BEHAVIOR_DONE <<<"$out" || { echo "N marker"; return 0; }
  # N6: a superuser session in replica mode (logical replication apply, restore tools) still ends the lease.
  db="$(copy "r_$tag" "$world")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY3"; return 0; }
  prep "$db"
  acct="$(lease_account "$db" 221)"
  "${as_super[@]}" -d "$db" -c "set session_replication_role = replica" -c "update public.threads_account_credential_custody set recorded_by = recorded_by where social_account_id = '$acct'" > /dev/null
  [[ "$(leases_of "$db" "$acct")" == 0 ]] || { echo "N6 replica-mode write kept the lease"; return 0; }
  # N7: a role that may write custody (through a policy) and may DELETE leases but has no lease policy: an invoker
  # trigger would delete nothing (RLS), silently; the definer one ends the lease.
  acct="$(lease_account "$db" 222)"
  "${as_super[@]}" -d "$db" > /dev/null <<SQL
grant usage on schema public to $delegate;
grant select, update on public.threads_account_credential_custody to $delegate;
grant select, delete on public.threads_credential_refresh_leases to $delegate;
create policy g4_27_delegate on public.threads_account_credential_custody for all to $delegate using (true) with check (true);
SQL
  out="$(as_delegate "$db" -c "update public.threads_account_credential_custody set recorded_by = recorded_by where social_account_id = '$acct'" 2>&1)" || { echo "N7 delegate write: $out"; return 0; }
  [[ "$(leases_of "$db" "$acct")" == 0 ]] || { echo "N7 a writer under RLS kept the lease"; return 0; }
  # N7b: the same writer WITHOUT any lease privilege: still ended (the trigger does not run with the writer's rights).
  acct="$(lease_account "$db" 223)"
  "${as_super[@]}" -d "$db" -c "revoke all on public.threads_credential_refresh_leases from $delegate" > /dev/null
  out="$(as_delegate "$db" -c "update public.threads_account_credential_custody set recorded_by = recorded_by where social_account_id = '$acct'" 2>&1)" || { echo "N7b delegate write: $out"; return 0; }
  [[ "$(leases_of "$db" "$acct")" == 0 ]] || { echo "N7b lease kept"; return 0; }
  # N8: a role that is not the owner cannot switch the trigger off.
  out="$(as_delegate "$db" -c "alter table public.threads_account_credential_custody disable trigger threads_credential_refresh_lease_invalidate_row" 2>&1 || true)"
  grep -q "must be owner" <<<"$out" || { echo "N8 non-owner disable: $out"; return 0; }
  echo PASS
}

# ---- 4. The candidate: order, pin, owner, re-apply -------------------------------------------------------------------
got="$(apply "$(copy order_before "$base")" "$cand")"
[[ "$got" == THREADS_LEASE_INVALIDATION_PRECONDITION_TABLES ]] || fail "candidate before the rotation candidate: $got"
python3 -I - "$rotation" "$tree/rotation_drift.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
old = "  -- Single use: the same lease can never rotate again (a replay answers LEASE_NOT_HELD).\n"
assert s.count(old) == 1
open(sys.argv[2], "w", encoding="utf-8").write(s.replace(old, old + "  -- drifted body\n"))
PY
drift="$(copy drift "$base")"; need "$drift" "$tree/rotation_drift.sql"
got="$(apply "$drift" "$cand")"
[[ "$got" == THREADS_LEASE_INVALIDATION_PRECONDITION_ROTATION ]] || fail "candidate on a drifted rotate: $got"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$delegate" -d "$(copy order_owner "$world")" -f "$cand" 2>&1 | sed -n 's/^.*ERROR: *//p' | head -1 || true)"
[[ "$got" == THREADS_LEASE_INVALIDATION_PRECONDITION_OWNER ]] || fail "candidate by a non-owner: $got"
again="$(copy again "$world")"; need "$again" "$cand"
got="$(apply "$again" "$cand")"
[[ "$got" == THREADS_LEASE_INVALIDATION_ALREADY_APPLIED ]] || fail "re-apply: $got"
echo "PASS apply: before the rotation candidate -> PRECONDITION_TABLES; drifted rotate body -> PRECONDITION_ROTATION; non-owner -> PRECONDITION_OWNER; re-apply -> ALREADY_APPLIED"

# ---- 5. The candidate: R1-R7b, N1-N5, replica mode, writers under RLS, non-owner disable --------------------------------
result="$(prove_candidate "$cand" real)"
[[ "$result" == PASS ]] || fail "candidate: $result"
echo "PASS candidate: R1-R6 unchanged, R7 refused (LEASE_NOT_HELD, the reconnect's token stays), R7b; N1 INSERT/UPDATE/DELETE end only that account's lease; N2 a new claim after a reconnect rotates; N3 transaction / savepoint rollback gives the lease back; N4 owner cannot set replica, audit ALWAYS, no API EXECUTE; N5 TRUNCATE; N6 replica-mode superuser write; N7/N7b a writer under RLS / without lease rights; N8 non-owner cannot disable"

# ---- 6. Locks: three two-session orders (no deadlock; the later writer wins; a stale claim never rotates) -------------
locks="$(copy locks "$world")"; need "$locks" "$cand"
{ prelude; helpers
  echo "select cr.connected(231, 'e1') as a \\gset"; echo "select cr.check(cr.t_begin(cr.uid(231), 'e1b') like 'sa_%', 'e1 begin');"
  echo "select cr.connected(232, 'e2') as a \\gset"
  echo "select cr.connected(233, 'e3') as a \\gset"; echo "select cr.check(cr.t_begin(cr.uid(233), 'e3b') like 'sa_%', 'e3 begin');"
  echo "select cr.check(cr.t_begin(cr.uid(232), 'e2b') like 'sa_%', 'e2 begin');"
} > "$tree/locks_setup.sql"
as_owner "$locks" -A -t -f "$tree/locks_setup.sql" > /dev/null
acct_of() { q "$locks" -c "select id from public.social_accounts where platform_user_id = '178414000000$(printf %05d "$1")'"; }
e1="$(acct_of 231)"; e2="$(acct_of 232)"; e3="$(acct_of 233)"
# E1: a reconnect holds the account; a claim waits for it and then names the reconnect's version.
( as_owner "$locks" -A -t -c "begin" -c "select cr.t_complete(cr.uid(231), 'e1b', '17841400000000231', now() + interval '40 days')" -c "select pg_sleep(1.5)" -c "commit" > "$tree/e1.out" 2>&1 ) &
holder=$!; sleep 0.4
claim1="$(q "$locks" -c "select cr.claim('$e1')::text" 2>&1)"
wait "$holder" || fail "E1 holder: $(cat "$tree/e1.out")"
[[ "$(jq -r .status <<<"$claim1")" == claimed && "$(q "$locks" -c "select ('$claim1'::jsonb ->> 'custody_recorded_at')::timestamptz = cr.recorded('$e1')")" == t ]] || fail "E1 claim: $claim1"
[[ "$(q "$locks" -c "select cr.rotate('$e1', '$claim1'::jsonb, ('$claim1'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status'")" == rotated ]] || fail "E1 rotate"
# E2: a claim holds the account; the reconnect waits, then ends that lease; the claim cannot rotate.
( as_owner "$locks" -A -t -c "begin" -c "select cr.claim('$e2')::text" -c "select pg_sleep(1.5)" -c "commit" > "$tree/e2.out" 2>&1 ) &
holder=$!; sleep 0.4
rec2="$(q "$locks" -c "select cr.t_complete(cr.uid(232), 'e2b', '17841400000000232', now() + interval '40 days')" 2>&1)"
wait "$holder" || fail "E2 holder: $(cat "$tree/e2.out")"
claim2="$(grep '{' "$tree/e2.out")"
[[ "$rec2" == OK && "$(jq -r .status <<<"$claim2")" == claimed ]] || fail "E2: $rec2 $claim2"
[[ "$(q "$locks" -c "select cr.rotate('$e2', '$claim2'::jsonb, ('$claim2'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'code'")" == LEASE_NOT_HELD ]] || fail "E2 rotate"
[[ "$(q "$locks" -c "select cr.token_of('$e2') = cr.token('e2b')")" == t ]] || fail "E2 token"
# E3: a rotate (+ H5's Vault write) holds the account; the reconnect waits and writes after it: the reconnect wins.
claim3="$(q "$locks" -c "select cr.claim('$e3')::text")"
( as_owner "$locks" -A -t -c "begin" -c "select cr.rotate('$e3', '$claim3'::jsonb, ('$claim3'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status'" \
    -c "select cr.h5_write('$e3', 'fakeTHREADSrefreshE3_0123456789')" -c "select pg_sleep(1.5)" -c "commit" > "$tree/e3.out" 2>&1 ) &
holder=$!; sleep 0.4
rec3="$(q "$locks" -c "select cr.t_complete(cr.uid(233), 'e3b', '17841400000000233', now() + interval '40 days')" 2>&1)"
wait "$holder" || fail "E3 holder: $(cat "$tree/e3.out")"
grep -qx rotated "$tree/e3.out" && [[ "$rec3" == OK ]] || fail "E3: $rec3 $(cat "$tree/e3.out")"
[[ "$(q "$locks" -c "select cr.token_of('$e3') = cr.token('e3b')")" == t ]] || fail "E3 token"
! grep -qi deadlock "$tree/e1.out" "$tree/e2.out" "$tree/e3.out" || fail "deadlock"
echo "PASS locks: E1 reconnect first -> the waiting claim names the reconnect's version and rotates; E2 claim first -> the waiting reconnect ends the lease (LEASE_NOT_HELD, reconnect token stays); E3 rotate first -> the waiting reconnect writes last (reconnect token); no deadlock"

# ---- 7. Same lease from two sessions; two different transactions with the same now() ---------------------------------
race="$(copy race "$world")"; need "$race" "$cand"
{ prelude; helpers; echo "select cr.connected(171, 'race') as acct \\gset"; } > "$tree/race_setup.sql"
as_owner "$race" -A -t -f "$tree/race_setup.sql" > /dev/null
racct="$(q "$race" -c "select id from public.social_accounts where platform_user_id = '17841400000000171'")"
rclaim="$(q "$race" -c "select cr.claim('$racct')::text")"
one="select (cr.rotate('$racct', '$rclaim'::jsonb, ('$rclaim'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days'))::text"
( as_owner "$race" -A -t -c "begin" -c "$one" -c "select pg_sleep(1.5)" -c "commit" > "$tree/race1.out" 2>&1 ) &
holder=$!; sleep 0.4
second="$(q "$race" -c "$one" 2>&1 || true)"
wait "$holder" || fail "race holder: $(cat "$tree/race1.out")"
[[ "$(jq -r .status <<<"$(grep '{' "$tree/race1.out")")" == rotated && "$(jq -r .status <<<"$second")" == refused ]] || fail "same-lease race: $second"
echo "PASS same lease from two sessions: one rotated, the other $(jq -r .code <<<"$second")"
node_bin="${NODE:-node}"
coll="$(copy coll "$world")"; need "$coll" "$cand"
{ prelude; helpers; cat <<'SQL'
select cr.enroll(181) as cu \gset
select cr.check(cr.t_begin(:'cu', 's1') like 'sa_%', 'collision begin s1');
select cr.check(cr.t_begin(:'cu', 's2') like 'sa_%', 'collision begin s2');
SQL
} > "$tree/coll_setup.sql"
as_owner "$coll" -A -t -f "$tree/coll_setup.sql" > /dev/null
"$node_bin" "$t/postona_threads_rotation_cas_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$coll" fix > "$tree/coll.out" 2>&1 || fail "collision: $(cat "$tree/coll.out")"
sed 's/^/  /' "$tree/coll.out" | cut -c1-600
echo "PASS two transactions with the same now(): the stale refresh is refused with the candidate"

# ---- 8. Owner-disabled trigger: NOT fail-closed (reported, expected), but visible to the audit ------------------------
off="$(copy off "$world")"; need "$off" "$cand"
q "$off" -c "alter table public.threads_account_credential_custody disable trigger threads_credential_refresh_lease_invalidate_row" > /dev/null
out="$(run_behavior "$off" none)" || fail "owner-disabled run: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q R7_FINDING_REPRODUCED <<<"$out" || fail "owner-disabled: R7 not reproduced (the expected limit was not shown)"
audit="$(q "$off" -c "select tgenabled from pg_catalog.pg_trigger where tgrelid = 'public.threads_account_credential_custody'::regclass and tgname = 'threads_credential_refresh_lease_invalidate_row'")"
[[ "$audit" == D ]] || fail "audit did not see the disabled trigger: $audit"
echo "EXPECTED_FAIL (limit of A, not fail-closed): with the trigger disabled by the table owner, R7 reproduces again; the audit sees tgenabled = D"

# ---- 9. F4's whole rotation suite with the candidate (expectation changes L1-L4: postona_threads_lease_invalidation_legacy_patch.py)
if [[ "${LI_SKIP_LEGACY:-0}" == 1 ]]; then
  echo "NOT_RUN legacy rotation suite (LI_SKIP_LEGACY=1)"
else
  lw="$(mktemp -d /private/tmp/kabumori-li-legacy.XXXXXX)"; rmdir "$lw"
  git -C "$repo" worktree add --detach "$lw" "$head" > /dev/null 2>&1 || fail "legacy worktree"
  python3 -I "$t/postona_threads_lease_invalidation_legacy_patch.py" "$lw/supabase/tests/postona_threads_rotation_behavior.sql" "$lw/supabase/tests/postona_threads_rotation_run.sh"
  # The candidate's md5 pin would stop every rotate mutant at apply; the pin is proven in section 4, so the suite runs
  # with a copy whose pin check is off (TEST ONLY).
  python3 -I - "$cand" "$tree/cand_unpinned.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
old = "    raise exception 'THREADS_LEASE_INVALIDATION_PRECONDITION_ROTATION';"
assert s.count(old) == 1
open(sys.argv[2], "w", encoding="utf-8").write(s.replace(old, "    null; -- G4-27 TEST ONLY: md5 pin off for the legacy suite's rotate mutants"))
PY
  cat "$rotation" "$tree/cand_unpinned.sql" > "$tree/rotation_plus_a.sql"
  set +e
  THREADS_ROTATION_CANDIDATE="$tree/rotation_plus_a.sql" THREADS_PGHOST="$host" THREADS_PGPORT="$port" THREADS_PGSUPER="$super" PSQL="$psql_bin" \
    bash "$lw/supabase/tests/postona_threads_rotation_run.sh" > "$tree/legacy.out" 2>&1
  rc=$?
  set -e
  git -C "$repo" worktree remove --force "$lw" > /dev/null 2>&1 || true
  grep -v NOTICE "$tree/legacy.out" | grep -E '^(PASS|EQUIVALENT|FAIL|ALL)' | sed 's/^/  /' | cut -c1-220
  [[ "$rc" == 0 ]] && grep -q '^ALL PASS' "$tree/legacy.out" || fail "legacy rotation suite with the candidate (rc $rc)"
  echo "PASS F4's rotation suite with the candidate (L1-L4 expectation changes only)"
fi

# ---- 10. Rollback: right order brings the finding back; wrong order fails closed ------------------------------------
rb="$(copy rb "$world")"; need "$rb" "$cand"; need "$rb" "$candrb"
[[ "$(q "$rb" -c "select count(*) from pg_catalog.pg_trigger where tgname like 'threads_credential_refresh_lease_invalidate%'")" == 0 ]] || fail "rollback left a trigger"
out="$(run_behavior "$rb" none)" || fail "after rollback: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q R7_FINDING_REPRODUCED <<<"$out" || fail "after rollback R7 should reproduce again"
wrong="$(copy wrong "$world")"; need "$wrong" "$cand"
{ prelude; helpers; echo "select cr.enroll(241) as u \\gset"; echo "select cr.check(cr.t_begin(:'u', 'w1') like 'sa_%', 'wrong begin');"; } > "$tree/wrong_setup.sql"
as_owner "$wrong" -A -t -f "$tree/wrong_setup.sql" > /dev/null
q "$wrong" -c "drop table public.threads_credential_refresh_leases" > /dev/null   # the rotation rolled back FIRST (wrong order)
before="$(q "$wrong" -c "select count(*) from public.threads_account_credential_custody")"
got="$(q "$wrong" -c "select cr.t_complete(cr.uid(241), 'w1', '17841400000000241', now() + interval '30 days')")"
[[ "$got" == ERR:*threads_credential_refresh_leases* && "$(q "$wrong" -c "select count(*) from public.threads_account_credential_custody")" == "$before" ]] || fail "wrong order: $got"
need "$wrong" "$candrb"
[[ "$(q "$wrong" -c "select cr.t_complete(cr.uid(241), 'w1', '17841400000000241', now() + interval '30 days')")" == OK ]] || fail "wrong order: connect after the candidate's rollback"
echo "PASS rollback: candidate rollback removes both triggers and R7 reproduces again; rotation rolled back first -> every custody write errors (${got:0:90}), nothing written; then the candidate's rollback restores connect"

# ---- 11. Negative controls: mutants of the candidate (postcondition kept, then stripped so behavior must catch) -------
caught=0; total=0
mutate() {
  local name="$1" old="$2" new="$3" full stripped got_full got
  total=$((total + 1)); full="$tree/mut_$name.sql"; stripped="$tree/mut_${name}_nopost.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$cand" "$full" "$old" "$new" || fail "mutation $name: pattern not unique"
  strip_post "$full" "$stripped"
  got_full="$(apply "$(copy "mf_$name" "$world")" "$full")"
  got="$(prove_candidate "$stripped" "m_$name")"
  if [[ "$got" != PASS ]]; then caught=$((caught + 1)); echo "  CAUGHT $name: apply=${got_full:0:60}; behavior: ${got:0:140}"
  else echo "  MISSED $name (apply=${got_full:0:60})"; fi
}
mutate wrong_account "    delete from public.threads_credential_refresh_leases l where l.social_account_id = new.social_account_id;" \
                     "    delete from public.threads_credential_refresh_leases l where l.social_account_id <> new.social_account_id;"
mutate no_update_event "  after insert or update or delete on public.threads_account_credential_custody" "  after insert or delete on public.threads_account_credential_custody"
mutate no_delete_event "  after insert or update or delete on public.threads_account_credential_custody" "  after insert or update on public.threads_account_credential_custody"
mutate truncate_keeps_leases "    delete from public.threads_credential_refresh_leases;
    return null;" "    return null;"
mutate security_invoker "language plpgsql security definer set search_path = '' set row_security = off as" "language plpgsql security invoker set search_path = '' as"
mutate not_always "alter table public.threads_account_credential_custody enable always trigger threads_credential_refresh_lease_invalidate_row;" ""
echo "negative controls caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a negative control was not caught"
echo "POSTONA_THREADS_LEASE_INVALIDATION_RUN_PASS (isolated source candidate A; limit reported: an owner-disabled trigger is not fail-closed)"
