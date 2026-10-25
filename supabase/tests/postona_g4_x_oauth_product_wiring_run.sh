#!/usr/bin/env bash
# G4-40 (Issue #319): X OAuth candidate 001 (PR #511) + 002 (product wiring) on the PRODUCT SHAPE with main's X refresh core,
# on a disposable LOCAL PostgreSQL 17 (fake Auth, fake Vault, fake G5 + a verbatim copy of G5 PR #506's predicate body).
# Never production, never a managed Supabase, never real Vault, OAuth, tokens or X.
#   1. behavior in three modes: current (main) / c001 (+001) / wired (+001+002)
#   2. two sessions: an X reconnect complete (held inside Vault) vs a refresh lease commit, in all three modes (W3)
#   3. install refusals: 002 without 001, re-apply, the dropped writer still in use, a status CHECK without 'unconnected';
#      001 when the function owner cannot EXECUTE G5's session function
#   4. rollback of 002: back to 001 byte for byte (postcondition), then mode=c001 passes on that database
#   5. negative controls: mutants of 002 must FAIL (behavior + the two-session case)
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_g4_x_oauth_product_wiring_run.sh
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
cand_dir="$repo/supabase/candidates/postona_g4_x_oauth_personal_epoch"
c001="$cand_dir/001_x_oauth_personal_epoch.sql"
c002="$cand_dir/002_x_oauth_product_wiring.sql"
r002="$cand_dir/002_x_oauth_product_wiring_rollback.sql"
world="$here/postona_g4_x_oauth_personal_epoch_world.sql"
shape="$here/postona_g4_x_oauth_product_wiring_shape.sql"
behavior="$here/postona_g4_x_oauth_product_wiring_behavior.sql"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
MAIN=0c42933ca5030ab31a56267529430d0473d9b155
G5S23=bbc52a6b
for sha in "$MAIN" "$G5S23"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done
g5_file=supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql
[ "$(git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' | md5 -q)" = "3d7cf91b22b9f841fd9b4ed3b47eae32" ] \
  || fail "G5 PR #506 predicate lines moved (pin)"
mp=supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql
[ "$(git -C "$repo" show "$MAIN:$mp" | sed -n '370p')" = "create function public.social_accounts_provider_guard() returns trigger" ] \
  || fail "provider guard lines moved (pin)"

tree="$(mktemp -d /private/tmp/kabumori-g4xw.XXXXXX)"
prefix="kabumori_g4xw_$$"
fnowner="kb_g4xw_fnowner_$$"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists \"$db\"" >/dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $fnowner" >/dev/null 2>&1 || true
  rm -rf "$tree"
}
trap cleanup EXIT

git -C "$repo" show "$MAIN:supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" > "$tree/m1.sql"
git -C "$repo" show "$MAIN:supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" > "$tree/m2.sql"
git -C "$repo" show "$MAIN:$mp" | sed -n '370,392p' > "$tree/guard.sql"
git -C "$repo" show "$MAIN:supabase/migrations/20260925140000_x_account_credential_refresh_core.sql" > "$tree/core.sql"
git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' \
  | sed 's/private\.postona_personal_workspace_eligibility(/private.g5_s23_predicate_copy(/' > "$tree/g5_predicate.sql"

# make_db <name> <current|c001|wired>
make_db() {
  "${as_super[@]}" -d postgres -c "create database \"$1\"" >/dev/null
  local q=("${as_super[@]}" -d "$1") f
  for f in "$world" "$tree/g5_predicate.sql" "$tree/m1.sql" "$tree/m2.sql" "$shape" "$tree/guard.sql" "$tree/core.sql"; do
    "${q[@]}" -f "$f" >/dev/null
  done
  case "$2" in
    c001) "${q[@]}" -f "${3:-$c001}" >/dev/null ;;
    wired) "${q[@]}" -f "$c001" >/dev/null; "${q[@]}" -f "${3:-$c002}" >/dev/null ;;
  esac
}
run_behavior() { "${as_super[@]}" -d "$1" -v mode="$2" -f "$behavior" 2>&1; }
expect_error() { # <db> <file> <code>
  local out
  if out="$("${as_super[@]}" -d "$1" -f "$2" 2>&1)"; then fail "expected $3, got success"; fi
  echo "$out" | grep -q "$3" || fail "expected $3, got: $(echo "$out" | tail -2)"
  echo "REFUSED_AS_EXPECTED $3"
}
deadlocks() { "${as_super[@]}" -d postgres -c "select deadlocks from pg_stat_database where datname = '$1'"; }
# two_sessions <db> <mode> -> prints "A=<complete> B=<commit> deadlocks=<n> state=<refresh state>" (user 10, after behavior)
two_sessions() {
  local db="$1" q=("${as_super[@]}" -d "$1") d0 d1
  "${q[@]}" -c "set g4xw.mode = '$2'" -c "select g4xw.connect_(10, 'k1', 'pu_K') || ' ' || g4xw.begin_only(10, 'k2') || ' ' || g4xw.lease(10, 'kl')" \
    | grep -qx 'OK/OK OK OK' || fail "two_sessions setup ($2)"
  d0="$(deadlocks "$db")"
  ( "${q[@]}" -c "set g4x.vault_sleep = '0.6'" -c "select 'A=' || g4xw.complete_only(10, 'k2', 'pu_K')" > "$tree/ts_A" 2>&1 ) &
  sleep 0.2
  "${q[@]}" -c "select 'B=' || g4xw.commit_(10, 'kl', 'fakeXat_kl')" > "$tree/ts_B" 2>&1
  wait
  sleep 0.2
  d1="$(deadlocks "$db")"
  echo "$(cat "$tree/ts_A") $(cat "$tree/ts_B") deadlocks=$((d1 - d0)) state=$("${q[@]}" -c "select g4xw.refresh_status(10)") token=$("${q[@]}" -c "select g4xw.token(10)")"
}

echo "== 1. behavior"
for mode in current c001 wired; do
  make_db "${prefix}_$mode" "$mode"
  out="$(run_behavior "${prefix}_$mode" "$mode")" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=$mode"; }
  echo "$out" | grep '^G4XW_RESULT'
done

echo "== 2. two sessions: reconnect complete vs refresh commit (W3)"
for mode in current c001; do
  r="$(two_sessions "${prefix}_$mode" "$mode")"
  echo "$mode: $r"
  [ "$r" = "A=OK B=X_REFRESH_PERSIST_FAILED deadlocks=1 state=refreshing/- token=fakeXat_k2" ] || fail "W3 reproduction ($mode): $r"
done
r="$(two_sessions "${prefix}_wired" wired)"
echo "wired: $r"
[ "$r" = "A=OK B=account_changed deadlocks=0 state=uncertain/X_REFRESH_ACCOUNT_CHANGED token=fakeXat_k2" ] || fail "W3 wired: $r"

echo "== 3. install refusals"
expect_error "${prefix}_current" "$c002" G4X_WIRING_NEEDS_001
expect_error "${prefix}_wired" "$c002" G4X_WIRING_ALREADY_APPLIED
make_db "${prefix}_inuse" c001
"${as_super[@]}" -d "${prefix}_inuse" -c "create function public.g4xw_consumer() returns void language sql as \$\$ select postona_g4_x_oauth.store_refreshed_x_tokens('x', 1, 'a', 'b') \$\$" >/dev/null
expect_error "${prefix}_inuse" "$c002" G4X_WIRING_PRECONDITION_WRITER_IN_USE
make_db "${prefix}_status" c001
"${as_super[@]}" -d "${prefix}_status" -c "alter table public.social_accounts drop constraint social_accounts_connection_status_check" \
  -c "alter table public.social_accounts add constraint social_accounts_connection_status_check check (connection_status = any (array['authorization_pending', 'connected', 'identity_verified', 'failed', 'unconnected_x']))" >/dev/null
expect_error "${prefix}_status" "$c002" G4X_WIRING_PRECONDITION_STATUS_SET
make_db "${prefix}_exec" current
"${as_super[@]}" -d "${prefix}_exec" -c "create role $fnowner nologin" \
  -c "alter function public.begin_social_mobile_x_oauth_connection(text, text, timestamptz) owner to $fnowner" \
  -c "alter function public.complete_social_mobile_x_oauth_connection(uuid, text, text, text, text) owner to $fnowner" \
  -c "revoke execute on function private.postona_personal_session() from public" >/dev/null
expect_error "${prefix}_exec" "$c001" "G4X_PRECONDITION_AUTHORITY_NOT_EXECUTABLE private.postona_personal_session()"
"${as_super[@]}" -d "${prefix}_exec" -c "reassign owned by $fnowner to $super" -c "drop owned by $fnowner" >/dev/null

echo "== 4. rollback of 002"
expect_error "${prefix}_c001" "$r002" G4X_WIRING_ROLLBACK_NOT_APPLIED
make_db "${prefix}_rb" wired
"${as_super[@]}" -d "${prefix}_rb" -f "$r002" >/dev/null 2>&1 || fail "rollback 002"
out="$(run_behavior "${prefix}_rb" c001)" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=c001 after rollback"; }
echo "after rollback: $(echo "$out" | grep '^G4XW_RESULT')"

echo "== 5. negative controls (mutants of 002)"
survived=0
mutate() { # <name> <perl substitution>
  local f="$tree/mut_$1.sql" db="${prefix}_m_$1" out r
  perl -0pe "$2" "$c002" > "$f"
  cmp -s "$f" "$c002" && fail "mutant $1 did not change 002"
  make_db "$db" current
  "${as_super[@]}" -d "$db" -f "$c001" >/dev/null
  "${as_super[@]}" -d "$db" -f "$f" >/dev/null 2>&1 || { echo "MUTANT_CAUGHT $1 (install refused)"; return; }
  if out="$(run_behavior "$db" wired)"; then
    r="$(two_sessions "$db" wired)"
    if [ "$r" = "A=OK B=account_changed deadlocks=0 state=uncertain/X_REFRESH_ACCOUNT_CHANGED token=fakeXat_k2" ]; then
      echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
    else
      echo "MUTANT_CAUGHT $1 by: two sessions ($r)"
    fi
  else
    echo "MUTANT_CAUGHT $1 by: $(echo "$out" | grep '^FAIL' | head -2 | cut -d'|' -f2 | tr '\n' ';')"
  fi
}
mutate w1_disconnected "s/set connection_status = 'unconnected', publish_enabled/set connection_status = 'disconnected', publish_enabled/"
mutate w1_no_row_change "s/set connection_status = 'unconnected', publish_enabled = false, last_connection_error_code = null,\n      updated_at = pg_catalog.clock_timestamp\(\)/set last_connection_error_code = null/"
mutate w2_writer_kept "s/\ndrop function postona_g4_x_oauth.store_refreshed_x_tokens\(text, bigint, text, text\);\n/\n/; s/raise exception 'G4X_WIRING_POSTCONDITION_WRITER_LEFT';/null;/"
mutate w3_complete_no_lock "s/(perform postona_g4_x_oauth.lock_workspace\(v_state_brand\);\n  end if;\n)  lock table public.social_accounts in row exclusive mode;[^\n]*\n/\$1/"
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"

echo "G4XW_PRODUCT_WIRING_ALL_PASS"
