#!/usr/bin/env bash
# G4-34 (Issue #319): the token read TOCTOU -- the gap between the token digest check (004, G4-33) and the token read --
# on the composed world of G4-24 / G4-25 with A, C, (4) and the digest, a FAKE Vault and fake tokens, on a disposable
# LOCAL PostgreSQL 17. Never production, never a managed Supabase, never real Vault, OAuth, tokens, Meta or Threads.
# Sections 1-3 and the helpers are those of postona_threads_token_digest_run.sh (G4-33), copied so that this proof stands
# alone. postona_threads_token_read_toctou_barrier.sql is a TEST-WORLD barrier (an advisory lock inside the fake
# vault.decrypted_secrets view) that makes the window deterministic; nothing here changes an existing file.
#   4. 005_rotation_verified_token_read.sql: apply order / preconditions / re-apply
#   5. the window on the digest candidate alone: T1 release (EXPECTED_FAIL), T2 credential_row (one statement: closed),
#      T3 the H5 model claim -> raw read (EXPECTED_FAIL for the read; the store still refuses), T4 REPEATABLE READ and
#      M2 a Vault row lock (comparisons only)
#   6. with 005: T1' closed, a normal release, T3' through the verified read, T6 an entry reconnect cannot enter the
#      window, T8 a wait beyond lock_timeout, T7 rollback, G4-33's D1-D12 unchanged
#   7. rollback: right order, the digest rolled back first, a rollback that keeps the function
#   8. negative controls: mutants of 005, caught by behavior with the postcondition stripped
# TT_KEEP_DB=1 keeps the databases and roles (debugging only; drop them by hand afterwards).
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_threads_token_read_toctou_run.sh
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

tree="$(mktemp -d /private/tmp/kabumori-tt.XXXXXX)"
n="$$"
owner="kb_tt_owner_$n"
delegate="kb_tt_delegate_$n"
prefix="kabumori_tt_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  if [[ "${TT_KEEP_DB:-0}" == 1 ]]; then echo "kept databases ${prefix}_* and roles $owner / $delegate (TT_KEEP_DB=1)"; return 0; fi
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $delegate" -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree ----------------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/TT_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/TT_MANIFEST.txt"; done
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
echo "$PR374 $(shasum -a 256 "$tree/g3_007.sql" | cut -c1-16) 007 (generation function only)" >> "$tree/TT_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
b001="$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql"; b001rb="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
b002="$c/postona_threads_binding_epoch/002_custody_connect_proof.sql"; b002rb="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
cred="${TQ_CREDENTIAL:-$c/postona_threads_credential_atomic/001_threads_credential_atomic.sql}"; credrb="$c/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql"
behavior="$t/postona_threads_credential_composition_behavior.sql"
rotation_behavior="$t/postona_threads_rotation_cas_behavior.sql"
rotation="$c/postona_threads_publish/threads_credential_rotation_candidate.sql"
sed 's/^/  /' "$tree/TT_MANIFEST.txt"

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

# ===================================== G4-29: option C on top of option A =====================================
candC="$c/postona_threads_rotation_lease_invalidation/002_rotation_lease_binding.sql"
candCrb="$c/postona_threads_rotation_lease_invalidation/002_rotation_lease_binding_rollback.sql"
ac_behavior="$t/postona_threads_lease_binding_behavior.sql"
{ prelude; helpers; cat "$ac_behavior"; } > "$tree/ac_behavior_full.sql"
worldA="$(copy worlda "$world")"; need "$worldA" "$cand"
echo "PASS world + rotation + candidate A (001_rotation_lease_invalidation.sql)"
run_ac() { as_owner "$1" -A -t -v a_mode="$2" -f "$tree/ac_behavior_full.sql" 2>&1; }
disable_a() { q "$1" -c "alter table public.threads_account_credential_custody disable trigger threads_credential_refresh_lease_invalidate_row" > /dev/null; }

# ===================================== G4-31: (4) the connect fingerprint on A + C =====================================
cand4="$c/postona_threads_rotation_lease_invalidation/003_rotation_lease_connect_fingerprint.sql"
cand4rb="$c/postona_threads_rotation_lease_invalidation/003_rotation_lease_connect_fingerprint_rollback.sql"
fp_behavior="$t/postona_threads_connect_fingerprint_behavior.sql"
{ prelude; helpers; cat "$fp_behavior"; } > "$tree/fp_behavior_full.sql"
# G4-29's A+C behavior without its F1 block: F1 is what (4) closes (P2/P3 assert the new outcome); B1-B8 and F2 stay.
python3 -I - "$ac_behavior" "$tree/ac_nof1.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("-- F1. EXPECTED_FAIL"); j = s.index("-- F2. EXPECTED_FAIL")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
{ prelude; helpers; cat "$tree/ac_nof1.sql"; } > "$tree/ac_nof1_full.sql"
worldAC="$(copy worldac "$worldA")"; need "$worldAC" "$candC"
echo "PASS world + rotation + A + C (002_rotation_lease_binding.sql)"
run_fp() { as_owner "$1" -A -t -v a_mode="$2" -f "$tree/fp_behavior_full.sql" 2>&1; }

# ===================================== G4-33: the token digest on A + C + (4) =====================================
cand5="$c/postona_threads_rotation_lease_invalidation/004_rotation_token_digest.sql"
cand5rb="$c/postona_threads_rotation_lease_invalidation/004_rotation_token_digest_rollback.sql"
dg_behavior="$t/postona_threads_token_digest_behavior.sql"
{ prelude; helpers; cat "$dg_behavior"; } > "$tree/dg_full.sql"
worldACF="$(copy worldacf "$worldAC")"; need "$worldACF" "$cand4"
echo "PASS world + rotation + A + C + (4) (003_rotation_lease_connect_fingerprint.sql)"

# ===================================== G4-34: the token read TOCTOU on A + C + (4) + digest =====================================
cand5="$c/postona_threads_rotation_lease_invalidation/004_rotation_token_digest.sql"
cand5rb="$c/postona_threads_rotation_lease_invalidation/004_rotation_token_digest_rollback.sql"
cand6="$c/postona_threads_rotation_lease_invalidation/005_rotation_verified_token_read.sql"
cand6rb="$c/postona_threads_rotation_lease_invalidation/005_rotation_verified_token_read_rollback.sql"
barrier="$t/postona_threads_token_read_toctou_barrier.sql"
worldD="$(copy worldd "$worldACF")"; need "$worldD" "$cand5"
echo "PASS world + rotation + A + C + (4) + digest (004_rotation_token_digest.sql)"
OOB=fakeTHREADSoutOfBandTT_0123456789
qa() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=0 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
# A database for one scenario: the given candidates on worldD, the helpers and the TEST-WORLD barrier.
scenario_db() { # tag, candidate files...
  local db; db="$(copy "s_$1" "$worldD")"; shift
  local f; for f in "$@"; do need "$db" "$f"; done
  prep "$db"; as_owner "$db" -A -t -f "$barrier" > /dev/null
  echo "$db"
}
# attack DB SECRET VICTIM_SQL [ATTACKER_SQL] [HOLD]: the attacker takes advisory lock 774100, waits until the victim blocks
# in the barrier (inside its CHECK statement), runs ATTACKER_SQL (default: a direct Vault write) and commits, keeps the lock
# HOLD more seconds, releases. The victim arms the barrier for SECRET and runs VICTIM_SQL. Prints the victim's output.
attack() {
  local db="$1" sec="$2" vsql="$3" asql="${4:-select vault.update_secret('$2', '$OOB')}" hold="${5:-0}" out pid
  ( qa "$db" -c "select pg_advisory_lock(774100)" \
       -c "do \$\$ begin for i in 1..200 loop exit when exists (select 1 from pg_locks where locktype = 'advisory' and objid = 774100 and not granted); perform pg_sleep(0.05); end loop; end \$\$" \
       -c "$asql" -c "select pg_sleep($hold)" -c "select pg_advisory_unlock(774100)" > "$tree/att_$db.out" 2>&1 ) &
  pid=$!; sleep 0.3
  out="$(qa "$db" -c "select set_config('g4test.toctou_arm', '$sec', false)" -c "$vsql" 2>&1 | sed '1d')"
  wait "$pid"
  echo "$out"
}
ready() { q "$1" -c "select cr.publish_ready($2)"; }   # account|user|attempt|secret
field() { cut -d'|' -f"$2" <<<"$1"; }
vault_of() { q "$1" -c "select s.secret from vault.secrets s where s.id = '$2'"; }

# ---- 4. 005: apply order, preconditions, re-apply ---------------------------------------------------------------------
got="$(apply "$(copy v_no_digest "$worldACF")" "$cand6")"
[[ "$got" == THREADS_VERIFIED_READ_PRECONDITION_DIGEST ]] || fail "005 without the digest: $got"
vdrift="$(copy v_drift "$worldD")"
q "$vdrift" -c "do \$\$ begin execute replace(pg_get_functiondef('public.release_threads_manual_publish_step(uuid,text,bigint,text,text)'::regprocedure), 'AS \$function\$', 'AS \$function\$-- drifted'); end \$\$" > /dev/null
got="$(apply "$vdrift" "$cand6")"
[[ "$got" == THREADS_VERIFIED_READ_PRECONDITION_RELEASE ]] || fail "005 on a drifted release: $got"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$delegate" -d "$(copy v_owner "$worldD")" -f "$cand6" 2>&1 | sed -n 's/^.*ERROR: *//p' | head -1 || true)"
[[ "$got" == THREADS_VERIFIED_READ_PRECONDITION_OWNER || "$got" == permission\ denied* ]] || fail "005 by a non-owner: $got"
v_owner_refusal="$got"
vagain="$(copy v_again "$worldD")"; need "$vagain" "$cand6"
got="$(apply "$vagain" "$cand6")"
[[ "$got" == THREADS_VERIFIED_READ_ALREADY_APPLIED ]] || fail "005 re-apply: $got"
echo "PASS 005 apply: without the digest -> PRECONDITION_DIGEST; drifted release -> PRECONDITION_RELEASE; non-owner -> refused ($v_owner_refusal); re-apply -> ALREADY_APPLIED"

# ---- 5. The window, reproduced on the digest candidate alone (EXPECTED_FAIL) and the controls ----------------------------
db="$(scenario_db t)"
r="$(ready "$db" 701)"; a="$(field "$r" 1)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"; sec="$(field "$r" 4)"
got="$(attack "$db" "$sec" "select cr.release('$u', '$att'::uuid) ->> 'access_token'")"
[[ "$got" == "$OOB" && "$(q "$db" -c "select cr.attempt_status('$att')")" == creating_container ]] || fail "T1 expected the release to hand out the unchecked token: $got"
echo "EXPECTED_FAIL T1 release (004 alone): a direct Vault write committed between the expiry check (digest) and the token read is handed out (access_token = the unchecked token, attempt moved to creating_container)"
r="$(ready "$db" 702)"; a="$(field "$r" 1)"; sec="$(field "$r" 4)"
got="$(attack "$db" "$sec" "select cr.token_of('$a')")"
[[ "$got" == "$(q "$db" -c "select cr.token('tt702')")" && "$(q "$db" -c "select cr.rows('$a')")" == 0 ]] || fail "T2 credential_row: $got"
echo "PASS T2 credential_row (one statement): the same attack returns the checked token (its snapshot), and every later read refuses"
r="$(ready "$db" 703)"; a="$(field "$r" 1)"; sec="$(field "$r" 4)"
out="$(attack "$db" "$sec" "select cr.claim('$a')::text; select ds.decrypted_secret from vault.decrypted_secrets ds where ds.id = '$sec'")"
claim="$(grep '{' <<<"$out")"; tok="$(tail -1 <<<"$out")"
[[ "$(jq -r .status <<<"$claim")" == claimed && "$tok" == "$OOB" ]] || fail "T3 H5 claim then raw read: $out"
got="$(q "$db" -c "select public.rotate_and_store_threads_credential('$a', ('$claim'::jsonb ->> 'lease')::uuid, ('$claim'::jsonb ->> 'vault_secret_id')::uuid, ('$claim'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days', 'fakeTHREADSrefreshOfUnchecked_0123456789') ->> 'code'")"
[[ "$got" == CREDENTIAL_CHANGED && "$(vault_of "$db" "$sec")" == "$OOB" ]] || fail "T3 store: $got"
echo "EXPECTED_FAIL T3 H5 model (claim, then a raw SELECT of the token in the same transaction): the raw read returns the unchecked token (it would be sent to Meta); rotate_and_store then refuses CREDENTIAL_CHANGED, nothing stored"
r="$(ready "$db" 704)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"
got="$(q "$db" -c "begin isolation level repeatable read" -c "select cr.release('$u', '$att'::uuid) ->> 'code'" -c "commit")"
[[ "$got" == ACCOUNT_LIFECYCLE_BLOCKED && "$(q "$db" -c "select cr.attempt_status('$att')")" == reserved ]] || fail "T4 repeatable read: $got"
echo "PASS T4 REPEATABLE READ is not an option (comparison only): the release refuses it before any read (G5's fence requires READ COMMITTED: ACCOUNT_LIFECYCLE_BLOCKED), as credential_row does"
# M2 (comparison only, a TEST copy of the release): a Vault row lock FOR SHARE before the checks -> the direct writer cannot
# commit inside the window (here: it times out), the release hands out the checked token.
python3 -I - "$c/postona_threads_publish/threads_publish_release_candidate.sql" "$tree/release_m2.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("create function public.release_threads_manual_publish_step("); a = s.index("$$", i) + 2; b = s.index("$$", a); j = s.index(";", b) + 1
f = s[i:j].replace("create function", "create or replace function", 1)
old = "  v_code := public.threads_manual_publish_authorize(v_user, v_row.social_account_id, p_step in ('create_container', 'check_container', 'publish'));"
assert f.count(old) == 1
f = f.replace(old, "  perform 1 from vault.secrets s where s.id = (select a.vault_access_token_secret_id from public.social_accounts a where a.id = v_row.social_account_id) for share;\n" + old)
open(sys.argv[2], "w", encoding="utf-8").write("set search_path = '';\n" + f + "\n")
PY
m2="$(scenario_db m2)"; need "$m2" "$tree/release_m2.sql"
r="$(ready "$m2" 705)"; a="$(field "$r" 1)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"; sec="$(field "$r" 4)"
got="$(attack "$m2" "$sec" "select cr.release('$u', '$att'::uuid) ->> 'access_token'" "set lock_timeout = '700ms'; select vault.update_secret('$sec', '$OOB')")"
[[ "$got" == "$(q "$m2" -c "select cr.token('tt705')")" ]] && grep -q "lock timeout" "$tree/att_$m2.out" || fail "M2 row lock: $got $(cat "$tree/att_$m2.out")"
echo "PASS M2 Vault row lock FOR SHARE (comparison only): the direct writer waits (lock timeout) instead of committing in the window; the checked token is handed out (needs a row-lock privilege on vault.secrets, NOT verified on the managed Vault)"

# ---- 6. With 005: the window is closed for the release; normal paths still work --------------------------------------
proof_6() { # file -> PASS or reason
  local db r a u att sec got
  db="$(scenario_db "p6_$RANDOM" "$1")"
  r="$(ready "$db" 711)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"; sec="$(field "$r" 4)"
  got="$(attack "$db" "$sec" "select cr.release('$u', '$att'::uuid)::text")"
  [[ "$(jq -r .code <<<"$got" 2>/dev/null)" == CREDENTIALS_MISSING && "$(jq -r .access_token <<<"$got")" == null && "$(q "$db" -c "select cr.attempt_status('$att')")" == reserved \
     && "$(vault_of "$db" "$sec")" == "$OOB" ]] || { echo "T1' $got"; return 0; }
  r="$(ready "$db" 712)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"
  [[ "$(q "$db" -c "select cr.release('$u', '$att'::uuid) ->> 'access_token'")" == "$(q "$db" -c "select cr.token('tt712')")" ]] || { echo "N1 normal release"; return 0; }
  r="$(ready "$db" 713)"; a="$(field "$r" 1)"; sec="$(field "$r" 4)"
  got="$(attack "$db" "$sec" "select cr.claim('$a')::text; select coalesce(public.threads_credential_verified_token('$a'), '<null>')")"
  [[ "$(tail -1 <<<"$got")" == "<null>" ]] || { echo "T3' $got"; return 0; }
  r="$(ready "$db" 714)"; a="$(field "$r" 1)"
  q "$db" -c "update public.social_accounts set connection_status = 'unconnected' where id = '$a'" > /dev/null
  [[ "$(q "$db" -c "select coalesce(public.threads_credential_verified_token('$a'), '<null>')")" == "<null>" ]] || { echo "V disconnected"; return 0; }
  echo PASS
}
result="$(proof_6 "$cand6")"
[[ "$result" == PASS ]] || fail "005: $result"
echo "PASS 005: T1' the same attack on the release -> CREDENTIALS_MISSING, no token out, the attempt stays reserved, the direct write is not overwritten; N1 a normal release hands out the checked token; T3' the H5 model reading through threads_credential_verified_token gets NULL; a disconnected account gets NULL"
db="$(scenario_db t6 "$cand6")"
r="$(ready "$db" 721)"; a="$(field "$r" 1)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"; sec="$(field "$r" 4)"
[[ "$(q "$db" -c "select cr.t_begin(cr.uid(721), 'tt721b')")" == "$a" ]] || fail "T6 begin"
got="$(attack "$db" "$sec" "select cr.release('$u', '$att'::uuid) ->> 'access_token'" "set lock_timeout = '700ms'; select cr.t_complete(cr.uid(721), 'tt721b', '17841400000000721', now() + interval '40 days')")"
[[ "$got" == "$(q "$db" -c "select cr.token('tt721')")" ]] && grep -q "ERR:.*lock" "$tree/att_$db.out" || fail "T6 reconnect in the window: $got $(cat "$tree/att_$db.out")"
[[ "$(q "$db" -c "select cr.t_complete(cr.uid(721), 'tt721b', '17841400000000721', now() + interval '40 days')")" == OK && "$(q "$db" -c "select cr.token_of('$a')")" == "$(q "$db" -c "select cr.token('tt721b')")" ]] || fail "T6 reconnect after"
echo "PASS T6 an entry reconnect cannot enter the window (it waits on the account row the release holds FOR SHARE; here lock timeout); after the release it records and its token is handed out"
r="$(ready "$db" 722)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"; sec="$(field "$r" 4)"
got="$(attack "$db" "$sec" "select cr.release('$u', '$att'::uuid)::text" "select 1" 3.5)"
[[ "$(jq -r .code <<<"$got" 2>/dev/null)" == BUSY && "$(q "$db" -c "select cr.attempt_status('$att')")" == reserved ]] || fail "T8 wait beyond lock_timeout: $got"
r="$(ready "$db" 723)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"
q "$db" -c "begin" -c "select cr.release('$u', '$att'::uuid) ->> 'status'" -c "rollback" > /dev/null
[[ "$(q "$db" -c "select cr.attempt_status('$att')")" == reserved ]] || fail "T7 rollback"
! grep -qi deadlock "$tree"/att_*.out || fail "deadlock"
echo "PASS T8 a wait longer than the release's lock_timeout -> BUSY, nothing moved; T7 a rolled-back release leaves the attempt reserved; no deadlock"
dgb="$(copy t_dg "$worldD")"; need "$dgb" "$cand6"
{ prelude; helpers; cat "$t/postona_threads_token_digest_behavior.sql"; } > "$tree/dg_full.sql"
out="$(as_owner "$dgb" -A -t -f "$tree/dg_full.sql" 2>&1)" || fail "D1-D12 with 005: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_TOKEN_DIGEST_BEHAVIOR_DONE <<<"$out" || fail "D1-D12 marker"
echo "PASS G4-33's D1-D12 unchanged with 005"

# ---- 7. Rollback ----------------------------------------------------------------------------------------------------------
db="$(scenario_db rb "$cand6")"; need "$db" "$cand6rb"
[[ "$(q "$db" -c "select md5(prosrc) from pg_proc where oid = 'public.release_threads_manual_publish_step(uuid,text,bigint,text,text)'::regprocedure")" == bd5bed5adcbef4d87614613f51c83dbf \
   && "$(q "$db" -c "select to_regprocedure('public.threads_credential_verified_token(text)') is null")" == t ]] || fail "005 rollback"
r="$(ready "$db" 731)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"; sec="$(field "$r" 4)"
[[ "$(attack "$db" "$sec" "select cr.release('$u', '$att'::uuid) ->> 'access_token'")" == "$OOB" ]] || fail "after 005's rollback T1 should reproduce again"
db="$(scenario_db rbw "$cand6")"; need "$db" "$cand5rb"
r="$(ready "$db" 732)"; u="$(field "$r" 2)"; att="$(field "$r" 3)"
got="$(q "$db" -c "select cr.release('$u', '$att'::uuid)::text")"
[[ "$(jq -r .code <<<"$got")" == CREDENTIALS_MISSING ]] || fail "digest rolled back first: $got"
need "$db" "$cand6rb"
[[ "$(q "$db" -c "select cr.release('$u', '$att'::uuid) ->> 'access_token'")" == "$(q "$db" -c "select cr.token('tt732')")" ]] || fail "after both rollbacks"
python3 -I - "$cand6rb" "$tree/rb6_mut.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
old = "drop function public.threads_credential_verified_token(text);\n"
assert s.count(old) == 1
open(sys.argv[2], "w", encoding="utf-8").write(s.replace(old, ""))
PY
rbm="$(copy v_rbmut "$worldD")"; need "$rbm" "$cand6"; got="$(apply "$rbm" "$tree/rb6_mut.sql")"
[[ "$got" == THREADS_VERIFIED_READ_ROLLBACK_INCOMPLETE ]] || fail "rollback that keeps the function: $got"
echo "PASS rollback: 005 -> the release body is back and T1 reproduces again; the digest rolled back first (wrong order) -> the release refuses (CREDENTIALS_MISSING, fail closed) until 005 is rolled back too; a rollback that keeps the function -> ROLLBACK_INCOMPLETE"

# ---- 8. Negative controls: mutants of 005 (postcondition stripped) ------------------------------------------------------
caught=0; total=0
mutate_6() {
  local name="$1" full stripped got_full got
  total=$((total + 1)); full="$tree/mut6_$name.sql"; stripped="$tree/mut6_${name}_nopost.sql"
  python3 -I -c '
import os, sys
src, dst = sys.argv[1:3]
s = open(src, encoding="utf-8").read()
k = 1
while ("OLD%d" % k) in os.environ:
    old, new = os.environ["OLD%d" % k], os.environ["NEW%d" % k]
    if s.count(old) != 1: sys.exit(1)
    s = s.replace(old, new); k += 1
open(dst, "w", encoding="utf-8").write(s)
' "$cand6" "$full" || fail "mutation $name: pattern count"
  strip_post "$full" "$stripped"
  got_full="$(apply "$(copy "m6f_$name" "$worldD")" "$full")"
  got="$(proof_6 "$stripped")"
  if [[ "$got" != PASS ]]; then caught=$((caught + 1)); echo "  CAUGHT $name: apply=${got_full:0:50}; behavior: ${got:0:150}"
  else echo "  MISSED $name (apply=${got_full:0:50})"; fi
}
OLD1="    v_token := public.threads_credential_verified_token(v_account.id);" \
NEW1="    select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = v_account.vault_access_token_secret_id;" mutate_6 release_reads_raw
OLD1="     and c.token_digest is not null
     and c.token_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
" NEW1="" mutate_6 verified_without_digest
OLD1="     and a.connection_status = 'identity_verified'
" NEW1="" mutate_6 verified_ignores_connection
OLD1="  if coalesce(v_token, '') = '' then return public.threads_manual_publish_refused('CREDENTIALS_MISSING'); end if;" NEW1="" mutate_6 release_ignores_null
echo "negative controls caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a negative control was not caught"
echo "POSTONA_THREADS_TOKEN_READ_TOCTOU_RUN_PASS (window reproduced on 004 alone: EXPECTED_FAIL T1/T3; closed for the release by isolated candidate 005)"
