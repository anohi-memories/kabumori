#!/usr/bin/env bash
# G4-41 (Issue #319): 003 (the person's own X disconnect RPC, gated) on top of 001 + 002, on the PRODUCT SHAPE with main's X
# refresh core, on a disposable LOCAL PostgreSQL 17 (fake Auth / Vault / G5 + G5 PR #506's predicate body copied verbatim).
# Never production, never a managed Supabase, never real Vault, OAuth, tokens or X.
#   1. behavior as the API roles (authenticated / anon): gate closed / open / closed again, connect, disconnect, reconnect
#   2. install refusals   3. rollback of 003 (001 + 002 untouched, re-apply)   4. negative controls (mutants of 003)
#   5. regression: G4-40's product wiring runner on this branch
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_g4_x_oauth_user_flow_run.sh
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
c003="$cand_dir/003_x_disconnect_user_rpc.sql"
r003="$cand_dir/003_x_disconnect_user_rpc_rollback.sql"
world="$here/postona_g4_x_oauth_personal_epoch_world.sql"
shape="$here/postona_g4_x_oauth_product_wiring_shape.sql"
behavior="$here/postona_g4_x_oauth_user_flow_behavior.sql"
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

tree="$(mktemp -d /private/tmp/kabumori-g4xu.XXXXXX)"
prefix="kabumori_g4xu_$$"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists \"$db\"" >/dev/null 2>&1 || true
  done
  rm -rf "$tree"
}
trap cleanup EXIT

git -C "$repo" show "$MAIN:supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" > "$tree/m1.sql"
git -C "$repo" show "$MAIN:supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" > "$tree/m2.sql"
git -C "$repo" show "$MAIN:$mp" | sed -n '370,392p' > "$tree/guard.sql"
git -C "$repo" show "$MAIN:supabase/migrations/20260925140000_x_account_credential_refresh_core.sql" > "$tree/core.sql"
git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' \
  | sed 's/private\.postona_personal_workspace_eligibility(/private.g5_s23_predicate_copy(/' > "$tree/g5_predicate.sql"

# make_db <name> <files...> : the product shape, then the given candidate files in order
make_db() {
  local name="$1" f
  shift
  "${as_super[@]}" -d postgres -c "create database \"$name\"" >/dev/null
  for f in "$world" "$tree/g5_predicate.sql" "$tree/m1.sql" "$tree/m2.sql" "$shape" "$tree/guard.sql" "$tree/core.sql" "$@"; do
    "${as_super[@]}" -d "$name" -f "$f" >/dev/null
  done
}
run_behavior() { "${as_super[@]}" -d "$1" -f "$behavior" 2>&1; }
expect_error() { # <db> <file> <code>
  local out
  if out="$("${as_super[@]}" -d "$1" -f "$2" 2>&1)"; then fail "expected $3, got success"; fi
  echo "$out" | grep -q "$3" || fail "expected $3, got: $(echo "$out" | tail -2)"
  echo "REFUSED_AS_EXPECTED $3"
}

echo "== 1. behavior (001 + 002 + 003, as the API roles)"
make_db "${prefix}_flow" "$c001" "$c002" "$c003"
out="$(run_behavior "${prefix}_flow")" || { echo "$out" | grep -v '^PASS' >&2; fail "behavior"; }
echo "$out" | grep '^G4XU_RESULT'

echo "== 2. install refusals"
make_db "${prefix}_no002" "$c001"
expect_error "${prefix}_no002" "$c003" G4X_DISCONNECT_RPC_NEEDS_002
expect_error "${prefix}_flow" "$c003" G4X_DISCONNECT_RPC_ALREADY_APPLIED

echo "== 3. rollback of 003"
make_db "${prefix}_rb" "$c001" "$c002"
expect_error "${prefix}_rb" "$r003" G4X_DISCONNECT_RPC_ROLLBACK_NOT_APPLIED
"${as_super[@]}" -d "${prefix}_rb" -f "$c003" >/dev/null
"${as_super[@]}" -d "${prefix}_rb" -c "create function public.g4xu_caller() returns text language sql as \$\$ select public.disconnect_social_mobile_x_connection() \$\$" >/dev/null
expect_error "${prefix}_rb" "$r003" G4X_DISCONNECT_RPC_ROLLBACK_STILL_REFERENCED
"${as_super[@]}" -d "${prefix}_rb" -c "drop function public.g4xu_caller()" >/dev/null
"${as_super[@]}" -d "${prefix}_rb" -f "$r003" >/dev/null 2>&1 || fail "rollback 003"
left="$("${as_super[@]}" -d "${prefix}_rb" -c "select md5(prosrc) from pg_proc where oid = to_regprocedure('postona_g4_x_oauth.disconnect_x_connection()')")"
[ "$left" = "f9de8f83c65f4ca228aad31ad1d6900b" ] || fail "002's disconnect changed by the rollback: $left"
"${as_super[@]}" -d "${prefix}_rb" -f "$c003" >/dev/null || fail "re-apply after rollback"
echo "ROLLBACK_OK 002 disconnect md5=$left, re-apply OK"

echo "== 4. negative controls (mutants of 003)"
survived=0
mutate() { # <name> <perl substitution>
  local f="$tree/mut_$1.sql" db="${prefix}_m_$1" out
  perl -0pe "$2" "$c003" > "$f"
  cmp -s "$f" "$c003" && fail "mutant $1 did not change 003"
  make_db "$db" "$c001" "$c002"
  "${as_super[@]}" -d "$db" -f "$f" >/dev/null 2>&1 || { echo "MUTANT_CAUGHT $1 (install refused)"; return; }
  if out="$(run_behavior "$db")"; then
    echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
  else
    echo "MUTANT_CAUGHT $1 by: $(echo "$out" | grep '^FAIL' | head -2 | cut -d'|' -f2 | tr '\n' ';')"
  fi
}
mutate gate_ignored "s/  if \(select s.x_disconnect_enabled from postona_g4_x_oauth.settings s where s.id = 1\) is not true then\n    raise exception 'X_DISCONNECT_NOT_ENABLED';\n  end if;\n//"
mutate anon_granted "s/grant execute on function public.disconnect_social_mobile_x_connection\(\) to authenticated;/grant execute on function public.disconnect_social_mobile_x_connection() to authenticated, anon;/; s/     or has_function_privilege\('anon', 'public.disconnect_social_mobile_x_connection\(\)', 'EXECUTE'\)\n//"
mutate gate_opened_by_install "s/insert into postona_g4_x_oauth.settings \(id\) values \(1\);/insert into postona_g4_x_oauth.settings (id, x_disconnect_enabled) values (1, true);/; s/is not false then\n    raise exception 'G4X_DISCONNECT_RPC_POSTCONDITION_GATE_OPEN';/is null then\n    raise exception 'G4X_DISCONNECT_RPC_POSTCONDITION_GATE_OPEN';/"
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"

echo "== 5. regression: G4-40 runner"
"$here/postona_g4_x_oauth_product_wiring_run.sh" 2>&1 | grep '^G4XW_RESULT\|^wired:\|ALL_PASS' || fail "G4-40 runner"

echo "G4XU_USER_FLOW_ALL_PASS"
