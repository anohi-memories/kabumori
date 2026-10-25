#!/usr/bin/env bash
# G4-45 (Issue #319; H1 #306 20th review, P2 F1): the X candidates' dependency guards on a disposable LOCAL PostgreSQL 17
# (product shape + fake Auth / Vault / G5, as postona_g4_x_oauth_preexchange_run.sh). Never production / managed / real Vault.
# Each case runs twice: with the files of the reviewed head (#523 cbd3922c = FAIL-BEFORE: H1's reproduction) and with this
# checkout's files (FIXED). A consumer outside the G4 objects must make 001's rollback, 002's install or 003's rollback refuse,
# and a refusal must leave every OID, body, ACL, row and the consumer as they were.
#   H1-1 an UPPERCASE PL/pgSQL caller of POSTONA_G4_X_OAUTH.X_CONNECTION_EPOCH       -> 001 rollback
#   H1-2 an external materialized view over x_connection_epoch (CASCADE dropped it)   -> 001 rollback
#   H1-3 an UPPERCASE PL/pgSQL caller of STORE_REFRESHED_X_TOKENS                     -> 002 install
#   H1-4 an UPPERCASE PL/pgSQL caller of PUBLIC.DISCONNECT_SOCIAL_MOBILE_X_CONNECTION  -> 003 rollback
#   plus: mixed case, SQL-standard (BEGIN ATOMIC) bodies, an external view over a G4 table, an external column default, and
#   lowercase controls; then the normal reverse rollback 004 -> 003 -> 002 -> 001 and the reinstall 001 -> 004.
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_g4_x_oauth_dependency_guard_run.sh
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
cand_rel=supabase/candidates/postona_g4_x_oauth_personal_epoch
world="$here/postona_g4_x_oauth_personal_epoch_world.sql"
shape="$here/postona_g4_x_oauth_product_wiring_shape.sql"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
MAIN=0c42933ca5030ab31a56267529430d0473d9b155
G5S23=bbc52a6b
REVIEWED=cbd3922c51f363c72e903cd03ed89c518897e0b3
for sha in "$MAIN" "$G5S23" "$REVIEWED"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done
g5_file=supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql
[ "$(git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' | md5 -q)" = "3d7cf91b22b9f841fd9b4ed3b47eae32" ] \
  || fail "G5 PR #506 predicate lines moved (pin)"
mp=supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql

tree="$(mktemp -d /private/tmp/kabumori-g4xd.XXXXXX)"
prefix="kabumori_g4xd_$$"
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
# the two file sets: reviewed (#523) and fixed (this checkout)
mkdir -p "$tree/reviewed" "$tree/fixed"
for f in 001_x_oauth_personal_epoch.sql 001_x_oauth_personal_epoch_rollback.sql 002_x_oauth_product_wiring.sql \
         002_x_oauth_product_wiring_rollback.sql 003_x_disconnect_user_rpc.sql 003_x_disconnect_user_rpc_rollback.sql \
         004_x_consume_preexchange_recheck.sql 004_x_consume_preexchange_recheck_rollback.sql; do
  git -C "$repo" show "$REVIEWED:$cand_rel/$f" > "$tree/reviewed/$f"
  cp "$repo/$cand_rel/$f" "$tree/fixed/$f"
done
# rows in the G4 tables (one connected person), so that "data unchanged" means something
cat > "$tree/rows.sql" <<'SQL'
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select 1 from public.begin_social_mobile_x_oauth_connection(md5('a1') || md5('a1#'), 'kabumori-social://oauth-callback',
  now() + interval '10 minutes');
select public.complete_social_mobile_x_oauth_connection(
  (select id from public.social_account_oauth_states where state_hash = md5('a1') || md5('a1#')), 'pu_A', 'h', 'fakeXat', 'fakeXrt');
select set_config('request.jwt.claim.sub', '', false);
SQL
# every OID / body / ACL of the G4 and the X OAuth functions, the G4 relations, their rows, the consumers' objects
cat > "$tree/snap.sql" <<'SQL'
select md5(concat_ws('|',
  (select string_agg(p.oid::text || ':' || n.nspname || '.' || p.proname || ':' || md5(coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), ''))
                     || ':' || coalesce(p.proacl::text, ''), ',' order by p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('postona_g4_x_oauth', 'public')),
  (select string_agg(c.oid::text || ':' || c.relname || ':' || coalesce(c.relacl::text, ''), ',' order by c.oid)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('postona_g4_x_oauth', 'public')),
  (select string_agg(t::text, ',' order by t.social_account_id) from postona_g4_x_oauth.connections t),
  (select string_agg(t::text, ',' order by t.oauth_state_id) from postona_g4_x_oauth.state_bindings t),
  (select string_agg(t::text, ',' order by t.id) from public.social_accounts t)));
SQL

# make_db <name> <set> <files...>: the product shape + one connected person, then candidate files of <set> in order
make_db() {
  local name="$1" set="$2" f
  shift 2
  "${as_super[@]}" -d postgres -c "create database \"$name\"" >/dev/null
  for f in "$world" "$tree/g5_predicate.sql" "$tree/m1.sql" "$tree/m2.sql" "$shape" "$tree/guard.sql" "$tree/core.sql"; do
    "${as_super[@]}" -d "$name" -f "$f" >/dev/null
  done
  for f in "$@"; do "${as_super[@]}" -d "$name" -f "$tree/$set/$f" >/dev/null; done
  "${as_super[@]}" -d "$name" -f "$tree/rows.sql" >/dev/null
}
# apply <db> <file>: 'applied' or the first ERROR text
apply() {
  local out
  if out="$("${as_super[@]}" -d "$1" -f "$2" 2>&1)"; then echo applied; else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}
snap() { "${as_super[@]}" -d "$1" -f "$tree/snap.sql"; }
q() { local db="$1"; shift; "${as_super[@]}" -d "$db" -c "$*" 2>&1 | head -1; }

C001=(001_x_oauth_personal_epoch.sql)
C003=(001_x_oauth_personal_epoch.sql 002_x_oauth_product_wiring.sql 003_x_disconnect_user_rpc.sql)
n=0
# case <id> <set> <expect: refused CODE | applied> <setup sql> <target file> <after-check sql> <after-check expected> <files...>
case_() {
  local id="$1" set="$2" want="$3" setup="$4" target="$5" check="$6" check_want="$7" db got before after c
  shift 7
  n=$((n + 1)); db="${prefix}_${n}"
  make_db "$db" "$set" "$@"
  "${as_super[@]}" -d "$db" -c "$setup" >/dev/null
  before="$(snap "$db")"
  got="$(apply "$db" "$tree/$set/$target")"
  # (only a refusal promises "nothing changed"; after an applied rollback the G4 tables are gone)
  if [ "$want" != applied ]; then after="$(snap "$db")"; fi
  c="$(q "$db" "$check")"
  if [ "$want" = applied ]; then
    [ "$got" = applied ] || fail "$id [$set]: expected the operation to go through, got: $got"
  else
    [[ "$got" == "$want"* ]] || fail "$id [$set]: expected $want, got: $got"
    [ "$before" = "$after" ] || fail "$id [$set]: the refusal changed an OID / body / ACL / row"
  fi
  [ "$c" = "$check_want" ] || fail "$id [$set]: after-check expected '$check_want', got '$c'"
  echo "PASS $id [$set] -> ${got} ; ${check} = ${c}"
}

UPPER_EPOCH="create function public.h1_upper_caller() returns bigint language plpgsql as \$b\$ begin return POSTONA_G4_X_OAUTH.X_CONNECTION_EPOCH('FAKE'); end \$b\$"
MIXED_EPOCH="create function public.h1_mixed_caller() returns bigint language plpgsql as \$b\$ begin return Postona_G4_X_Oauth.x_Connection_Epoch('FAKE'); end \$b\$"
LOWER_EPOCH="create function public.h1_lower_caller() returns bigint language plpgsql as \$b\$ begin return postona_g4_x_oauth.x_connection_epoch('FAKE'); end \$b\$"
EXT_MV="create materialized view public.h1_external_mv as select postona_g4_x_oauth.x_connection_epoch('FAKE') as e"
ATOMIC_EPOCH="create function public.h1_atomic() returns bigint language sql begin atomic select postona_g4_x_oauth.x_connection_epoch('FAKE'); end"
EXT_VIEW="create view public.h1_external_view as select social_account_id, connection_epoch from postona_g4_x_oauth.connections"
EXT_DEFAULT="create table public.h1_external_default (id int, e bigint default postona_g4_x_oauth.x_connection_epoch('FAKE')); insert into public.h1_external_default (id) values (1)"
UPPER_STORE="create function public.h1_upper_writer() returns void language plpgsql as \$b\$ begin perform POSTONA_G4_X_OAUTH.STORE_REFRESHED_X_TOKENS('x', 1, 'a', 'b'); end \$b\$"
ATOMIC_STORE="create function public.h1_atomic_writer() returns void language sql begin atomic select postona_g4_x_oauth.store_refreshed_x_tokens('x', 1, 'a', 'b'); end"
UPPER_RPC="create function public.h1_upper_rpc() returns text language plpgsql as \$b\$ begin return PUBLIC.DISCONNECT_SOCIAL_MOBILE_X_CONNECTION(); end \$b\$"
ATOMIC_RPC="create function public.h1_atomic_rpc() returns text language sql begin atomic select public.disconnect_social_mobile_x_connection(); end"
LOWER_RPC="create function public.h1_lower_rpc() returns text language plpgsql as \$b\$ begin return public.disconnect_social_mobile_x_connection(); end \$b\$"
SCHEMA_GONE="select to_regnamespace('postona_g4_x_oauth') is null"
MV_ROWS="select coalesce((select count(*)::text from public.h1_external_mv), 'gone')"
FN_LEFT="select to_regprocedure('postona_g4_x_oauth.store_refreshed_x_tokens(text,bigint,text,text)') is not null"
RPC_LEFT="select to_regprocedure('public.disconnect_social_mobile_x_connection()') is not null"

echo "== FAIL-BEFORE: the reviewed head #523 (H1's reproduction)"
case_ "H1-1 uppercase caller / 001 rollback" reviewed applied "$UPPER_EPOCH" 001_x_oauth_personal_epoch_rollback.sql "$SCHEMA_GONE" t "${C001[@]}"
case_ "H1-2 external MV / 001 rollback" reviewed applied "$EXT_MV" 001_x_oauth_personal_epoch_rollback.sql \
  "select to_regclass('public.h1_external_mv') is null" t "${C001[@]}"
case_ "H1-3 uppercase writer caller / 002 install" reviewed applied "$UPPER_STORE" 002_x_oauth_product_wiring.sql "$FN_LEFT" f "${C001[@]}"
case_ "H1-4 uppercase RPC caller / 003 rollback" reviewed applied "$UPPER_RPC" 003_x_disconnect_user_rpc_rollback.sql "$RPC_LEFT" f "${C003[@]}"
case_ "BEGIN ATOMIC caller / 001 rollback (CASCADE took it)" reviewed applied "$ATOMIC_EPOCH" 001_x_oauth_personal_epoch_rollback.sql \
  "select to_regprocedure('public.h1_atomic()') is null" t "${C001[@]}"

echo "== FIXED: this checkout"
case_ "H1-1 uppercase caller / 001 rollback" fixed G4X_ROLLBACK_STILL_REFERENCED "$UPPER_EPOCH" 001_x_oauth_personal_epoch_rollback.sql "$SCHEMA_GONE" f "${C001[@]}"
case_ "H1-2 external MV / 001 rollback" fixed G4X_ROLLBACK_DEPENDED_ON "$EXT_MV" 001_x_oauth_personal_epoch_rollback.sql "$MV_ROWS" 1 "${C001[@]}"
case_ "H1-3 uppercase writer caller / 002 install" fixed G4X_WIRING_PRECONDITION_WRITER_IN_USE "$UPPER_STORE" 002_x_oauth_product_wiring.sql "$FN_LEFT" t "${C001[@]}"
case_ "H1-4 uppercase RPC caller / 003 rollback" fixed G4X_DISCONNECT_RPC_ROLLBACK_STILL_REFERENCED "$UPPER_RPC" 003_x_disconnect_user_rpc_rollback.sql "$RPC_LEFT" t "${C003[@]}"
case_ "mixed-case caller / 001 rollback" fixed G4X_ROLLBACK_STILL_REFERENCED "$MIXED_EPOCH" 001_x_oauth_personal_epoch_rollback.sql "$SCHEMA_GONE" f "${C001[@]}"
case_ "BEGIN ATOMIC caller / 001 rollback" fixed G4X_ROLLBACK_DEPENDED_ON "$ATOMIC_EPOCH" 001_x_oauth_personal_epoch_rollback.sql \
  "select to_regprocedure('public.h1_atomic()') is not null" t "${C001[@]}"
case_ "external view over a G4 table / 001 rollback" fixed G4X_ROLLBACK_DEPENDED_ON "$EXT_VIEW" 001_x_oauth_personal_epoch_rollback.sql \
  "select count(*) from public.h1_external_view" 1 "${C001[@]}"
case_ "external column default / 001 rollback" fixed G4X_ROLLBACK_DEPENDED_ON "$EXT_DEFAULT" 001_x_oauth_personal_epoch_rollback.sql \
  "select count(*) from public.h1_external_default" 1 "${C001[@]}"
case_ "BEGIN ATOMIC writer caller / 002 install" fixed G4X_WIRING_PRECONDITION_WRITER_IN_USE "$ATOMIC_STORE" 002_x_oauth_product_wiring.sql "$FN_LEFT" t "${C001[@]}"
case_ "BEGIN ATOMIC RPC caller / 003 rollback" fixed G4X_DISCONNECT_RPC_ROLLBACK_STILL_REFERENCED "$ATOMIC_RPC" 003_x_disconnect_user_rpc_rollback.sql "$RPC_LEFT" t "${C003[@]}"
echo "== controls (lowercase, refused before and after)"
case_ "lowercase caller / 001 rollback" reviewed G4X_ROLLBACK_STILL_REFERENCED "$LOWER_EPOCH" 001_x_oauth_personal_epoch_rollback.sql "$SCHEMA_GONE" f "${C001[@]}"
case_ "lowercase caller / 001 rollback" fixed G4X_ROLLBACK_STILL_REFERENCED "$LOWER_EPOCH" 001_x_oauth_personal_epoch_rollback.sql "$SCHEMA_GONE" f "${C001[@]}"
case_ "lowercase RPC caller / 003 rollback" reviewed G4X_DISCONNECT_RPC_ROLLBACK_STILL_REFERENCED "$LOWER_RPC" 003_x_disconnect_user_rpc_rollback.sql "$RPC_LEFT" t "${C003[@]}"
case_ "lowercase RPC caller / 003 rollback" fixed G4X_DISCONNECT_RPC_ROLLBACK_STILL_REFERENCED "$LOWER_RPC" 003_x_disconnect_user_rpc_rollback.sql "$RPC_LEFT" t "${C003[@]}"

echo "== after the consumer is removed, the same rollback goes through (FIXED)"
n=$((n + 1)); db="${prefix}_${n}"
make_db "$db" fixed "${C001[@]}"
"${as_super[@]}" -d "$db" -c "$EXT_MV" >/dev/null
[[ "$(apply "$db" "$tree/fixed/001_x_oauth_personal_epoch_rollback.sql")" == G4X_ROLLBACK_DEPENDED_ON* ]] || fail "MV present: not refused"
"${as_super[@]}" -d "$db" -c "drop materialized view public.h1_external_mv" >/dev/null
[ "$(apply "$db" "$tree/fixed/001_x_oauth_personal_epoch_rollback.sql")" = applied ] || fail "MV removed: rollback refused"
echo "PASS consumer removed -> 001 rollback applied"

echo "== the normal reverse rollback and the reinstall (FIXED, no consumer)"
n=$((n + 1)); db="${prefix}_${n}"
make_db "$db" fixed 001_x_oauth_personal_epoch.sql 002_x_oauth_product_wiring.sql 003_x_disconnect_user_rpc.sql 004_x_consume_preexchange_recheck.sql
for f in 004_x_consume_preexchange_recheck_rollback.sql 003_x_disconnect_user_rpc_rollback.sql 002_x_oauth_product_wiring_rollback.sql \
         001_x_oauth_personal_epoch_rollback.sql 001_x_oauth_personal_epoch.sql 002_x_oauth_product_wiring.sql \
         003_x_disconnect_user_rpc.sql 004_x_consume_preexchange_recheck.sql; do
  got="$(apply "$db" "$tree/fixed/$f")"
  [ "$got" = applied ] || fail "reverse / reinstall: $f -> $got"
done
echo "PASS 004 -> 003 -> 002 -> 001 rolled back, then 001 -> 002 -> 003 -> 004 reinstalled"

echo "G4X_DEPENDENCY_GUARD_ALL_PASS cases=$n"
