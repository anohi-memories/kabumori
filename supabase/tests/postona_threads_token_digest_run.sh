#!/usr/bin/env bash
# G4-33 (Issue #319): ISOLATED SOURCE CANDIDATE -- the custody token digest (004_rotation_token_digest.sql) -- on top of A
# (001), C (002) and (4) (003), on the composed world of G4-24 / G4-25 with a FAKE Vault, on a disposable LOCAL
# PostgreSQL 17. Never production, never a managed Supabase, never real Vault, OAuth, tokens, Meta or Threads. Sections 1-3
# and the helpers are those of postona_threads_connect_fingerprint_run.sh (G4-31), copied so that this proof stands alone;
# nothing here changes an existing file.
#   4. apply order / preconditions / re-apply
#   5. postona_threads_token_digest_behavior.sql (D1-D12; D8 = recorded limit) + V1 (a direct writer holding the Vault row)
#      + the earlier suites R1-R7b, N1-N5, B1-B8, P1-P9 with a TEST-WORLD adapter (their H5 write = rotate_and_store's)
#   6. races: rotate_and_store vs a direct writer, vs an entry reconnect
#   7. rollback: right order (F2 passes again), (4)'s rollback first (refused), a rollback that forgets the reader
#   8. negative controls: mutants of the candidate, caught by behavior with the postcondition stripped
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_threads_token_digest_run.sh
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

tree="$(mktemp -d /private/tmp/kabumori-dg.XXXXXX)"
n="$$"
owner="kb_dg_owner_$n"
delegate="kb_dg_delegate_$n"
prefix="kabumori_dg_${n}"
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
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/DG_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/DG_MANIFEST.txt"; done
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
echo "$PR374 $(shasum -a 256 "$tree/g3_007.sql" | cut -c1-16) 007 (generation function only)" >> "$tree/DG_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
b001="$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql"; b001rb="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
b002="$c/postona_threads_binding_epoch/002_custody_connect_proof.sql"; b002rb="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
cred="${TQ_CREDENTIAL:-$c/postona_threads_credential_atomic/001_threads_credential_atomic.sql}"; credrb="$c/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql"
behavior="$t/postona_threads_credential_composition_behavior.sql"
rotation_behavior="$t/postona_threads_rotation_cas_behavior.sql"
rotation="$c/postona_threads_publish/threads_credential_rotation_candidate.sql"
sed 's/^/  /' "$tree/DG_MANIFEST.txt"

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
# TEST-WORLD adapter for the earlier suites: their "H5 writes the refreshed token" step becomes what rotate_and_store does
# (the token and its custody record together), so they keep testing what they tested. Their F2 blocks (a direct Vault
# write, expected to pass) are cut: F2 is what the digest closes (D2-D5 assert the new outcome with an honest direct write).
cat > "$tree/dg_adapter.sql" <<'SQL'
create or replace function cr.h5_write(p_acct text, p_token text) returns void language sql as $$
  update vault.secrets set secret = p_token where id = (select vault_access_token_secret_id from public.social_accounts where id = p_acct);
  update public.threads_account_credential_custody set vault_secret_id = vault_secret_id where social_account_id = p_acct $$;
SQL
python3 -I - "$rotation_behavior" "$tree/ac_nof1.sql" "$fp_behavior" "$tree" <<'PY'
import sys
rcas, acnof1, fp, tree = sys.argv[1:5]
s = open(rcas, encoding="utf-8").read(); i = s.index("-- R1.")
open(tree + "/rcas_head.sql", "w", encoding="utf-8").write(s[:i])
open(tree + "/rcas_tail.sql", "w", encoding="utf-8").write(s[i:])
s = open(acnof1, encoding="utf-8").read(); i = s.index("-- F2. EXPECTED_FAIL"); j = s.index("select 'POSTONA_THREADS_LEASE_BINDING_BEHAVIOR_DONE'")
open(tree + "/ac_nof2.sql", "w", encoding="utf-8").write(s[:i] + s[j:])
s = open(fp, encoding="utf-8").read(); i = s.index("-- F2 (still EXPECTED_FAIL)"); j = s.index("select 'POSTONA_THREADS_CONNECT_FINGERPRINT_BEHAVIOR_DONE'")
open(tree + "/fp_nof2.sql", "w", encoding="utf-8").write(s[:i] + s[j:])
PY
{ prelude; cat "$tree/rcas_head.sql" "$tree/dg_adapter.sql" "$tree/rcas_tail.sql"; } > "$tree/rcas_adapted.sql"
{ prelude; helpers; cat "$tree/dg_adapter.sql" "$tree/ac_nof2.sql"; } > "$tree/ac_adapted.sql"
{ prelude; helpers; cat "$tree/dg_adapter.sql" "$tree/fp_nof2.sql"; } > "$tree/fp_adapted.sql"
{ prelude; helpers; cat "$tree/dg_adapter.sql"; sed -n '/^-- N1\./,$p' "$t/postona_threads_lease_invalidation_behavior.sql"; } > "$tree/li_adapted.sql"

# V1 (inside every proof): a direct Vault writer holds the Vault row; rotate_and_store waits on its row lock, then sees the
# new content -> CREDENTIAL_CHANGED, and the direct write is not overwritten.
v1_race() {
  local db="$1" acct claim got holder
  prep "$db"
  acct="$(q "$db" -c "select cr.connected(531, 'v1')")"
  claim="$(q "$db" -c "select cr.claim('$acct')::text")"
  ( as_owner "$db" -A -t -c "begin" -c "select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = '$acct'), 'fakeTHREADSoobV1_0123456789')" \
      -c "select pg_sleep(1.5)" -c "commit" > "$tree/v1_$db.out" 2>&1 ) &
  holder=$!; sleep 0.4
  got="$(q "$db" -c "select public.rotate_and_store_threads_credential('$acct', ('$claim'::jsonb ->> 'lease')::uuid, ('$claim'::jsonb ->> 'vault_secret_id')::uuid, ('$claim'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days', 'fakeTHREADSstoreV1_0123456789') ->> 'code'" 2>&1)"
  wait "$holder" || { echo "V1 holder: $(cat "$tree/v1_$db.out")"; return 0; }
  [[ "$got" == CREDENTIAL_CHANGED && "$(q "$db" -c "select cr.vault_token('$acct')" 2>/dev/null || q "$db" -c "select s.secret from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = '$acct'")" == fakeTHREADSoobV1_0123456789 ]] \
    || { echo "V1 $got"; return 0; }
  echo PASS
}

# Everything a digest file must show on an A+C+(4) world; prints PASS or the first reason.
prove_5() {
  local file="$1" tag="$2" db out mode
  db="$(copy "d_$tag" "$worldACF")"
  out="$(apply "$db" "$file")"; [[ "$out" == applied ]] || { echo "APPLY $out"; return 0; }
  out="$(as_owner "$db" -A -t -f "$tree/dg_full.sql" 2>&1)" || { echo "D $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q POSTONA_THREADS_TOKEN_DIGEST_BEHAVIOR_DONE <<<"$out" || { echo "D marker"; return 0; }
  [[ "$tag" != real ]] || grep -E '^D5 ' <<<"$out" | sed 's/^/  observed: /' | cut -c1-300 >&2
  db="$(copy "v_$tag" "$worldACF")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY_V"; return 0; }
  out="$(v1_race "$db")"; [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  db="$(copy "r_$tag" "$worldACF")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY_R"; return 0; }
  out="$(as_owner "$db" -A -t -v fix=dg -f "$tree/rcas_adapted.sql" 2>&1)" || { echo "R1-R7 $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q R7_FIX_PROTOTYPE_HOLDS <<<"$out" || { echo "R7 not refused"; return 0; }
  db="$(copy "n_$tag" "$worldACF")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY_N"; return 0; }
  out="$(as_owner "$db" -A -t -f "$tree/li_adapted.sql" 2>&1)" || { echo "N1-N5 $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q POSTONA_THREADS_LEASE_INVALIDATION_BEHAVIOR_DONE <<<"$out" || { echo "N marker"; return 0; }
  for mode in on off; do
    db="$(copy "b${mode}_$tag" "$worldACF")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY_B"; return 0; }
    out="$(as_owner "$db" -A -t -v a_mode="$mode" -f "$tree/ac_adapted.sql" 2>&1)" || { echo "B_$mode $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
    grep -q POSTONA_THREADS_LEASE_BINDING_BEHAVIOR_DONE <<<"$out" || { echo "B_$mode marker"; return 0; }
    db="$(copy "p${mode}_$tag" "$worldACF")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY_P"; return 0; }
    out="$(as_owner "$db" -A -t -v a_mode="$mode" -f "$tree/fp_adapted.sql" 2>&1)" || { echo "P_$mode $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
    grep -q POSTONA_THREADS_CONNECT_FINGERPRINT_BEHAVIOR_DONE <<<"$out" || { echo "P_$mode marker"; return 0; }
  done
  echo PASS
}

# ---- 4. Apply order, preconditions, re-apply -----------------------------------------------------------------------------
got="$(apply "$(copy g_no4 "$worldAC")" "$cand5")"
[[ "$got" == THREADS_TOKEN_DIGEST_PRECONDITION_FINGERPRINT ]] || fail "digest without (4): $got"
gdrift="$(copy g_drift "$worldACF")"
q "$gdrift" -c "do \$\$ begin execute replace(pg_get_functiondef('public.threads_account_credential_expires_at(text)'::regprocedure), 'AS \$function\$', 'AS \$function\$-- drifted'); end \$\$" > /dev/null
got="$(apply "$gdrift" "$cand5")"
[[ "$got" == THREADS_TOKEN_DIGEST_PRECONDITION_BODIES ]] || fail "digest on a drifted reader: $got"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$delegate" -d "$(copy g_owner "$worldACF")" -f "$cand5" 2>&1 | sed -n 's/^.*ERROR: *//p' | head -1 || true)"
[[ "$got" == THREADS_TOKEN_DIGEST_PRECONDITION_OWNER || "$got" == permission\ denied* ]] || fail "digest by a non-owner: $got"
g_owner_refusal="$got"
gagain="$(copy g_again "$worldACF")"; need "$gagain" "$cand5"
got="$(apply "$gagain" "$cand5")"
[[ "$got" == THREADS_TOKEN_DIGEST_ALREADY_APPLIED ]] || fail "digest re-apply: $got"
echo "PASS digest apply: without (4) -> PRECONDITION_FINGERPRINT; drifted expiry reader -> PRECONDITION_BODIES; non-owner -> refused ($g_owner_refusal); re-apply -> ALREADY_APPLIED"

# ---- 5. A+C+(4)+digest: D1-D12, V1, and the earlier suites (adapted, F1/F2 blocks cut) ---------------------------------
result="$(prove_5 "$cand5" real)"
[[ "$result" == PASS ]] || fail "A+C+(4)+digest: $result"
echo "PASS A+C+(4)+digest: D1 normal claim -> credential_row -> rotate_and_store (new token + digest, handed out, single use); D2 F2 after the claim -> CREDENTIAL_CHANGED, nothing overwritten, every reader refuses, legacy rotate too; D3 F2 before the claim -> CREDENTIAL_CHANGED; D4 same content -> rotated; D5 F2 in one transaction, one now() -> CREDENTIAL_CHANGED; D6 legacy rotate + separate Vault write -> every reader refuses until a reconnect; D7 no digest -> CREDENTIAL_UNVERIFIED until a reconnect; D9 a written digest is replaced; D10 malformed token / wrong lease / shorter expiry write nothing; D11 rollback restores everything; D12 no API access; V1 direct writer holding the Vault row -> CREDENTIAL_CHANGED; R1-R7b, N1-N5, B1-B8, P1-P9 (A on and OFF)"
echo "EXPECTED_LIMIT D8: an owner custody write after a direct Vault write re-records that content (as an apply-time backfill would)"

# ---- 6. Races: rotate_and_store first vs a direct writer; vs an entry reconnect; no deadlock -----------------------------
races="$(copy g_races "$worldACF")"; need "$races" "$cand5"; prep "$races"
v2="$(q "$races" -c "select cr.connected(532, 'v2')")"
v3="$(q "$races" -c "select cr.connected(533, 'v3')")"
[[ "$(q "$races" -c "select cr.t_begin(cr.uid(533), 'v3b')")" == "$v3" ]] || fail "V3 begin"
store_sql() { echo "select public.rotate_and_store_threads_credential('$1', ('$2'::jsonb ->> 'lease')::uuid, ('$2'::jsonb ->> 'vault_secret_id')::uuid, ('$2'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days', '$3') ->> 'status'"; }
claim2="$(q "$races" -c "select cr.claim('$v2')::text")"
( as_owner "$races" -A -t -c "begin" -c "$(store_sql "$v2" "$claim2" fakeTHREADSstoreV2_0123456789)" -c "select pg_sleep(1.5)" -c "commit" > "$tree/v2.out" 2>&1 ) &
holder=$!; sleep 0.4
q "$races" -c "select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = '$v2'), 'fakeTHREADSoobV2_0123456789')" > /dev/null 2>&1 || fail "V2 direct writer"
wait "$holder" || fail "V2 holder: $(cat "$tree/v2.out")"
grep -qx rotated "$tree/v2.out" || fail "V2: $(cat "$tree/v2.out")"
[[ "$(q "$races" -c "select cr.rows('$v2')")" == 0 && "$(q "$races" -c "select public.threads_account_credential_expires_at('$v2') is null")" == t ]] || fail "V2: readers should refuse"
claim3="$(q "$races" -c "select cr.claim('$v3')::text")"
( as_owner "$races" -A -t -c "begin" -c "$(store_sql "$v3" "$claim3" fakeTHREADSstoreV3_0123456789)" -c "select pg_sleep(1.5)" -c "commit" > "$tree/v3.out" 2>&1 ) &
holder=$!; sleep 0.4
rec3="$(q "$races" -c "select cr.t_complete(cr.uid(533), 'v3b', '17841400000000533', now() + interval '40 days')" 2>&1)"
wait "$holder" || fail "V3 holder: $(cat "$tree/v3.out")"
grep -qx rotated "$tree/v3.out" && [[ "$rec3" == OK && "$(q "$races" -c "select cr.token_of('$v3') = cr.token('v3b')")" == t ]] || fail "V3: $rec3 $(cat "$tree/v3.out")"
! grep -qi deadlock "$tree/v2.out" "$tree/v3.out" || fail "deadlock"
echo "PASS races: V2 rotate_and_store first, a direct writer waits and writes after -> every reader refuses (fail closed); V3 rotate_and_store first, an entry reconnect waits and records last -> the reconnect's token is handed out; no deadlock (V1 is inside the proof above)"

# ---- 7. Rollback: digest -> F2 passes again; (4)'s rollback first refuses; a rollback that forgets the reader -------------
rbd="$(copy g_rb "$worldACF")"; need "$rbd" "$cand5"; need "$rbd" "$cand5rb"
[[ "$(q "$rbd" -c "select md5(prosrc) from pg_proc where oid in ('public.claim_threads_credential_refresh(text)'::regprocedure, 'public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)'::regprocedure, 'public.threads_account_credential_expires_at(text)'::regprocedure) order by proname" | tr '\n' ' ')" \
   == "fa79d6b154b04e3bb7e7927f5e2df1d5 06ccc5c98190064f99bd544db8109cd2 0d63f9e609f4bc4380c8afa1b86d0916 " ]] || fail "digest rollback: bodies not back"
out="$(run_fp "$rbd" on)" || fail "after the digest rollback: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q EXPECTED_FAIL_F2 <<<"$out" || fail "after the digest rollback F2 should pass again"
wrong="$(copy g_wrong "$worldACF")"; need "$wrong" "$cand5"
got="$(apply "$wrong" "$cand4rb")"
[[ "$got" == THREADS_LEASE_FINGERPRINT_ROLLBACK_ORDER ]] || fail "(4)'s rollback before the digest's: $got"
python3 -I - "$cand5rb" "$tree/rb5_mut.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("create or replace function public.threads_account_credential_expires_at(")
j = s.index("create or replace function public.claim_threads_credential_refresh(")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
rbm="$(copy g_rbmut "$worldACF")"; need "$rbm" "$cand5"; got="$(apply "$rbm" "$tree/rb5_mut.sql")"
[[ "$got" == THREADS_TOKEN_DIGEST_ROLLBACK_INCOMPLETE ]] || fail "rollback that forgets the reader: $got"
echo "PASS rollback: digest -> claim / rotate / reader back to their pinned bodies and F2 passes again (the digest was what refused it); (4)'s rollback run first -> ROLLBACK_ORDER; a rollback that forgets the reader -> ROLLBACK_INCOMPLETE"

# ---- 8. Negative controls: mutants of the digest candidate (postcondition stripped, so behavior must catch) -------------
caught=0; total=0
mutate_5() { # name, then pairs of old/new passed as OLD1 NEW1 [OLD2 NEW2]
  local name="$1" full stripped got_full got
  total=$((total + 1)); full="$tree/mut5_$name.sql"; stripped="$tree/mut5_${name}_nopost.sql"
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
' "$cand5" "$full" || fail "mutation $name: pattern count"
  strip_post "$full" "$stripped"
  got_full="$(apply "$(copy "m5f_$name" "$worldACF")" "$full")"
  got="$(prove_5 "$stripped" "m_$name")"
  if [[ "$got" != PASS ]]; then caught=$((caught + 1)); echo "  CAUGHT $name: apply=${got_full:0:50}; behavior: ${got:0:150}"
  else echo "  MISSED $name (apply=${got_full:0:50})"; fi
}
CHECK_HEAD="  -- G4-33 (F2): the custody row describes exactly the token now in Vault (its digest, kept by the custody trigger).
  if v_custody.token_digest is null then return public.threads_credential_rotation_refused('CREDENTIAL_UNVERIFIED'); end if;
  if v_custody.token_digest is distinct from (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
                                              from vault.decrypted_secrets ds where ds.id = v_custody.vault_secret_id) then
    return public.threads_credential_rotation_refused('CREDENTIAL_CHANGED');
  end if;
"
OLD1="${CHECK_HEAD}  v_now := pg_catalog.clock_timestamp();" NEW1="  v_now := pg_catalog.clock_timestamp();" mutate_5 claim_no_digest_check
OLD1="for update;
${CHECK_HEAD}" NEW1="for update;
" mutate_5 store_no_digest_check
OLD1="  perform 1 from vault.secrets s where s.id = v_custody.vault_secret_id for update;
" NEW1="" mutate_5 store_no_vault_row_lock
OLD1="    and c.token_digest is not null
    and c.token_digest = (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(ds.decrypted_secret, 'UTF8')), 'hex')
                            from vault.decrypted_secrets ds where ds.id = c.vault_secret_id)
" NEW1="" mutate_5 reader_no_digest_check
OLD1="  before insert or update on public.threads_account_credential_custody" NEW1="  before insert on public.threads_account_credential_custody" mutate_5 trigger_insert_only
OLD1="  new.token_digest := (select pg_catalog.encode" NEW1="  new.token_digest := coalesce(new.token_digest, (select pg_catalog.encode" \
OLD2="                         from vault.decrypted_secrets ds where ds.id = new.vault_secret_id);" NEW2="                         from vault.decrypted_secrets ds where ds.id = new.vault_secret_id));" mutate_5 trigger_trusts_the_writer
OLD1="  perform vault.update_secret(v_custody.vault_secret_id, p_new_token);
  update public.threads_account_credential_custody c
     set expires_at = p_new_expires_at, recorded_at = pg_catalog.now(), recorded_by = v_owner
   where c.social_account_id = p_social_account_id;" NEW1="  update public.threads_account_credential_custody c
     set expires_at = p_new_expires_at, recorded_at = pg_catalog.now(), recorded_by = v_owner
   where c.social_account_id = p_social_account_id;
  perform vault.update_secret(v_custody.vault_secret_id, p_new_token);" mutate_5 store_writes_vault_after_custody
echo "negative controls caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a negative control was not caught"
echo "POSTONA_THREADS_TOKEN_DIGEST_RUN_PASS (isolated source candidates A+C+(4)+digest; F2 refused; EXPECTED_LIMIT D8 reported)"
