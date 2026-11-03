#!/usr/bin/env bash
# G4-43 (Issue #319): 004 (consume refuses before the code exchange what complete would refuse) on top of 001 + 002 + 003, on the
# PRODUCT SHAPE with main's X refresh core, on a disposable LOCAL PostgreSQL 17 (fake Auth / Vault / G5 + G5 PR #506's predicate
# body copied verbatim). Never production, never a managed Supabase, never real Vault, OAuth, tokens or X.
#   1. behavior as `authenticated`: mode=c003 (consume is main's) / mode=c004
#   2. install refusals   3. rollback of 004 (main's consume back; mode=c003 passes again)   4. mutants of 004
#   5. regression: G4-41's user flow runner (which runs G4-40's) and G4-39's runner on this branch
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_g4_x_oauth_preexchange_run.sh
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
c004="$cand_dir/004_x_consume_preexchange_recheck.sql"
r004="$cand_dir/004_x_consume_preexchange_recheck_rollback.sql"
world="$here/postona_g4_x_oauth_personal_epoch_world.sql"
shape="$here/postona_g4_x_oauth_product_wiring_shape.sql"
behavior="$here/postona_g4_x_oauth_preexchange_behavior.sql"
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

tree="$(mktemp -d /private/tmp/kabumori-g4xp.XXXXXX)"
prefix="kabumori_g4xp_$$"
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
# a state begun under main's begin before any candidate (user 19), for P6
cat > "$tree/pre.sql" <<'SQL'
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000019');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000019', false);
select 1 from public.begin_social_mobile_x_oauth_connection(md5('legacy_state') || md5('legacy_state#'), 'kabumori-social://oauth-callback',
  now() + interval '10 minutes');
select set_config('request.jwt.claim.sub', '', false);
SQL

# make_db <name> <files...>: the product shape + the pre-001 state, then the given candidate files in order
make_db() {
  local name="$1" f
  shift
  "${as_super[@]}" -d postgres -c "create database \"$name\"" >/dev/null
  for f in "$world" "$tree/g5_predicate.sql" "$tree/m1.sql" "$tree/m2.sql" "$shape" "$tree/guard.sql" "$tree/core.sql" "$tree/pre.sql" "$@"; do
    "${as_super[@]}" -d "$name" -f "$f" >/dev/null
  done
}
run_behavior() { "${as_super[@]}" -d "$1" -v mode="$2" -f "$behavior" 2>&1; }
expect_error() { # <db> <file> <code>
  local out
  if out="$("${as_super[@]}" -d "$1" -f "$2" 2>&1)"; then fail "expected $3, got success"; fi
  echo "$out" | grep -q "$3" || fail "expected $3, got: $(echo "$out" | tail -2)"
  echo "REFUSED_AS_EXPECTED $3"
}

echo "== 1. behavior"
make_db "${prefix}_c003" "$c001" "$c002" "$c003"
out="$(run_behavior "${prefix}_c003" c003)" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=c003"; }
echo "$out" | grep '^G4XP_RESULT'
make_db "${prefix}_c004" "$c001" "$c002" "$c003" "$c004"
out="$(run_behavior "${prefix}_c004" c004)" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=c004"; }
echo "$out" | grep '^G4XP_RESULT'

echo "== 2. install refusals"
make_db "${prefix}_no002" "$c001"
expect_error "${prefix}_no002" "$c004" G4X_CONSUME_NEEDS_002
expect_error "${prefix}_c004" "$c004" G4X_CONSUME_PRECONDITION_BODY

echo "== 3. rollback of 004"
make_db "${prefix}_rb" "$c001" "$c002" "$c003"
expect_error "${prefix}_rb" "$r004" G4X_CONSUME_ROLLBACK_NOT_APPLIED
"${as_super[@]}" -d "${prefix}_rb" -f "$c004" >/dev/null
"${as_super[@]}" -d "${prefix}_rb" -f "$r004" >/dev/null 2>&1 || fail "rollback 004"
out="$(run_behavior "${prefix}_rb" c003)" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=c003 after rollback"; }
echo "after rollback: $(echo "$out" | grep '^G4XP_RESULT')"

echo "== 4. negative controls (mutants of 004)"
survived=0
mutate() { # <name> <perl substitution>
  local f="$tree/mut_$1.sql" db="${prefix}_m_$1" out
  perl -0pe "$2" "$c004" > "$f"
  cmp -s "$f" "$c004" && fail "mutant $1 did not change 004"
  make_db "$db" "$c001" "$c002" "$c003"
  "${as_super[@]}" -d "$db" -f "$f" >/dev/null 2>&1 || { echo "MUTANT_CAUGHT $1 (install refused)"; return; }
  if out="$(run_behavior "$db" c004)"; then
    echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
  else
    echo "MUTANT_CAUGHT $1 by: $(echo "$out" | grep '^FAIL' | head -2 | cut -d'|' -f2 | tr '\n' ';')"
  fi
}
mutate binding_skipped "s/    raise exception 'OAUTH_STATE_NOT_BOUND';/    null;/"
mutate superseded_skipped "s/if not found or v_connection.latest_state_id is distinct from v_state.id then/if not found then/"
mutate person_skipped "s/\n     or postona_g4_x_oauth.require_person\(v_user_id\) <> 'own' then/ then/"
mutate owner_epoch_skipped "s/<> v_binding.owner_epoch then/<> v_binding.owner_epoch and false then/"
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"

echo "== 5. regression"
"$here/postona_g4_x_oauth_user_flow_run.sh" 2>&1 | grep '^G4XU_RESULT\|^G4XW_RESULT\|^wired:\|ALL_PASS' || fail "G4-41 runner"
"$here/postona_g4_x_oauth_personal_epoch_run.sh" 2>&1 | grep '^G4X_RESULT\|ALL_PASS' || fail "G4-39 runner"

echo "G4XP_PREEXCHANGE_ALL_PASS"
