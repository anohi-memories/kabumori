#!/usr/bin/env bash
# G4-39 (Issue #319): ISOLATED SOURCE CANDIDATE supabase/candidates/postona_g4_x_oauth_personal_epoch/ on a disposable LOCAL
# PostgreSQL 17 with fake Auth, fake Vault and fake G5 authority (plus a verbatim copy of G5 PR #506's workspace predicate body).
# Never production, never a managed Supabase, never real Vault, OAuth, tokens or X.
#   1. mode=current   main's X begin / complete (0c42933c): the defects REPRODUCE (behavior.sql, current expectations)
#   2. mode=candidate the candidate installed: the same cases are REFUSED, the normal path connects
#   3. install refusals: re-apply, a changed product body, a missing G5 function
#   4. rollback: refused when not applied / still referenced; applied -> main's bodies byte for byte, then mode=current passes again
#   5. negative controls: mutants of the candidate must FAIL behavior (mode=candidate)
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_g4_x_oauth_personal_epoch_run.sh
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
cand="$cand_dir/001_x_oauth_personal_epoch.sql"
rollback="$cand_dir/001_x_oauth_personal_epoch_rollback.sql"
world="$here/postona_g4_x_oauth_personal_epoch_world.sql"
behavior="$here/postona_g4_x_oauth_personal_epoch_behavior.sql"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
MAIN=0c42933ca5030ab31a56267529430d0473d9b155
G5S23=bbc52a6b
for sha in "$MAIN" "$G5S23"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done
g5_file=supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql
[ "$(git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' | md5 -q)" = "3d7cf91b22b9f841fd9b4ed3b47eae32" ] \
  || [ -n "${G4X_PRINT_PIN:-}" ] || fail "G5 PR #506 predicate lines moved (pin)"

tree="$(mktemp -d /private/tmp/kabumori-g4x.XXXXXX)"
prefix="kabumori_g4x_$$"
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
git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' \
  | sed 's/private\.postona_personal_workspace_eligibility(/private.g5_s23_predicate_copy(/' > "$tree/g5_predicate.sql"
if [ -n "${G4X_PRINT_PIN:-}" ]; then git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' | md5 -q; exit 0; fi
# a state begun under main's body before any candidate (user 23), for the LEG case
cat > "$tree/pre.sql" <<'SQL'
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000023');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000023', false);
select 1 from public.begin_social_mobile_x_oauth_connection(md5('legacy_state') || md5('legacy_state#'), 'kabumori://x-callback',
  now() + interval '10 minutes');
select set_config('request.jwt.claim.sub', '', false);
SQL

# make_db <name> : world + G5 copy + main's two migrations + the pre-install state
make_db() {
  "${as_super[@]}" -d postgres -c "create database \"$1\"" >/dev/null
  local q=("${as_super[@]}" -d "$1")
  "${q[@]}" -f "$world" >/dev/null
  "${q[@]}" -f "$tree/g5_predicate.sql" >/dev/null
  "${q[@]}" -f "$tree/m1.sql" >/dev/null
  "${q[@]}" -f "$tree/m2.sql" >/dev/null
  "${q[@]}" -f "$tree/pre.sql" >/dev/null
}
run_behavior() { "${as_super[@]}" -d "$1" -v mode="$2" -f "$behavior" 2>&1; }
expect_error() { # <db> <file> <code>
  local out
  if out="$("${as_super[@]}" -d "$1" -f "$2" 2>&1)"; then fail "expected $3, got success"; fi
  echo "$out" | grep -q "$3" || fail "expected $3, got: $(echo "$out" | tail -2)"
  echo "REFUSED_AS_EXPECTED $3"
}

echo "== 1. mode=current (main 0c42933c)"
make_db "${prefix}_cur"
out="$(run_behavior "${prefix}_cur" current)" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=current"; }
echo "$out" | grep '^G4X_RESULT'

echo "== 2. mode=candidate"
make_db "${prefix}_cand"
"${as_super[@]}" -d "${prefix}_cand" -f "$cand" >/dev/null
out="$(run_behavior "${prefix}_cand" candidate)" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=candidate"; }
echo "$out" | grep '^G4X_RESULT'

echo "== 2b. two sessions at once (candidate)"
q=("${as_super[@]}" -d "${prefix}_cand")
# the same state completed twice concurrently (user 30): the second waits for the first, then the claim refuses
"${q[@]}" -c "select g4xt.begin_(30, 'cc1')" | grep -qx OK || fail "cc1 begin"
( "${q[@]}" -c "begin" -c "select 'A=' || g4xt.complete_(30, 'cc1', 'pu_CC')" -c "select pg_sleep(1)" -c "commit" > "$tree/ccA" ) &
sleep 0.3
t0=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
"${q[@]}" -c "select 'B=' || g4xt.complete_(30, 'cc1', 'pu_CC')" > "$tree/ccB"
t1=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
wait
grep -qx 'A=OK' "$tree/ccA" || fail "concurrent complete A: $(cat "$tree/ccA")"
grep -qx 'B=OAUTH_STATE_NOT_CONSUMABLE' "$tree/ccB" || fail "concurrent complete B: $(cat "$tree/ccB")"
perl -e "exit(($t1 - $t0) >= 0.4 ? 0 : 1)" || fail "concurrent complete B did not wait"
echo "CONCURRENT_COMPLETE A=OK B=OAUTH_STATE_NOT_CONSUMABLE (B waited $(perl -e "printf '%.2f', $t1 - $t0")s)"
# two first begins of one absent person at once (user 31): serialized, one workspace, one owner, the later state is the latest
( "${q[@]}" -c "begin" -c "select 'A=' || g4xt.begin_(31, 'cb1')" -c "select pg_sleep(1)" -c "commit" > "$tree/cbA" ) &
sleep 0.3
"${q[@]}" -c "select 'B=' || g4xt.begin_(31, 'cb2')" > "$tree/cbB"
wait
grep -qx 'A=OK' "$tree/cbA" && grep -qx 'B=OK' "$tree/cbB" || fail "concurrent begin: $(cat "$tree/cbA" "$tree/cbB")"
facts="$("${q[@]}" -c "set g4xt.mode = 'candidate'" -c "select g4xt.owners(g4xt.ws(31)) || '/' || (select count(*) from public.brand_memberships where brand_id = g4xt.ws(31)) || '/' || g4xt.latest_is(g4xt.acct_of(g4xt.ws(31)), 'cb2')")"
[ "$facts" = "1/1/true" ] || fail "concurrent begin facts: $facts"
echo "CONCURRENT_BEGIN A=OK B=OK owners/members/latest=$facts"

echo "== 3. install refusals"
expect_error "${prefix}_cand" "$cand" G4X_ALREADY_APPLIED
make_db "${prefix}_body"
"${as_super[@]}" -d "${prefix}_body" -c "create or replace function public.begin_social_mobile_x_oauth_connection(p_state_hash text, p_redirect_uri text, p_expires_at timestamptz) returns table (brand_id text, social_account_id text) language plpgsql security definer set search_path = 'public' as \$\$ begin return; end \$\$" >/dev/null
expect_error "${prefix}_body" "$cand" G4X_PRECONDITION_BEGIN_BODY
make_db "${prefix}_nog5"
"${as_super[@]}" -d "${prefix}_nog5" -c "drop function private.postona_personal_session()" >/dev/null
expect_error "${prefix}_nog5" "$cand" "G4X_PRECONDITION_AUTHORITY_MISSING private.postona_personal_session()"

echo "== 4. rollback"
expect_error "${prefix}_cur" "$rollback" G4X_ROLLBACK_NOT_APPLIED
make_db "${prefix}_rb"
"${as_super[@]}" -d "${prefix}_rb" -f "$cand" >/dev/null
"${as_super[@]}" -d "${prefix}_rb" -c "create function public.g4x_consumer() returns bigint language sql as \$\$ select postona_g4_x_oauth.x_connection_epoch('x') \$\$" >/dev/null
expect_error "${prefix}_rb" "$rollback" G4X_ROLLBACK_STILL_REFERENCED
"${as_super[@]}" -d "${prefix}_rb" -c "drop function public.g4x_consumer()" >/dev/null
"${as_super[@]}" -d "${prefix}_rb" -f "$rollback" >/dev/null 2>&1 || fail "rollback"
"${as_super[@]}" -d "${prefix}_rb" -c "select proname || '=' || md5(prosrc) from pg_proc where proname in ('begin_social_mobile_x_oauth_connection', 'complete_social_mobile_x_oauth_connection') order by 1"
acl="$("${as_super[@]}" -d "${prefix}_rb" -c "select string_agg(proacl::text, ' ' order by proname) from pg_proc where proname in ('begin_social_mobile_x_oauth_connection', 'complete_social_mobile_x_oauth_connection')")"
echo "$acl" | grep -q "authenticated=X" || fail "rollback ACL"
out="$(run_behavior "${prefix}_rb" current)" || { echo "$out" | grep -v '^PASS' >&2; fail "mode=current after rollback"; }
echo "after rollback: $(echo "$out" | grep '^G4X_RESULT')"

echo "== 5. negative controls (mutants of the candidate)"
mutate() { # <name> <perl substitution>
  local f="$tree/mut_$1.sql" db="${prefix}_m_$1"
  perl -0pe "$2" "$cand" > "$f"
  cmp -s "$f" "$cand" && fail "mutant $1 did not change the candidate"
  make_db "$db"
  "${as_super[@]}" -d "$db" -f "$f" >/dev/null 2>&1 || { echo "MUTANT_CAUGHT $1 (install refused)"; return; }
  if out="$(run_behavior "$db" candidate)"; then
    echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
  else
    echo "MUTANT_CAUGHT $1 by: $(echo "$out" | grep '^FAIL' | head -2 | cut -d'|' -f2 | tr '\n' ';')"
  fi
}
survived=0
mutate session_ignored "s/if v_session is distinct from 'active' then/if false then/"
mutate unknown_verdict_allowed "s/if v_verdict in \('absent', 'own'\) then/if v_verdict in ('absent', 'own', 'WORKSPACE_OWNER_UNKNOWN') or v_verdict is null then/"
mutate absent_path_joins "s/if v_rows <> 1 then/if false then/; s/if postona_g4_x_oauth.require_person\(v_user_id\) <> 'own' then\n      raise exception 'OWN_WORKSPACE_CONFLICT';\n    end if;\n  end if;/end if;/"
mutate complete_skips_workspace "s/\n     or postona_g4_x_oauth.require_person\(v_user_id\) <> 'own' then/ then/"
mutate complete_skips_owner_epoch "s/<> v_binding.owner_epoch then/<> v_binding.owner_epoch and false then/"
mutate complete_skips_superseded "s/v_connection.latest_state_id is distinct from p_oauth_state_id/false/"
mutate complete_keeps_epoch "s/set connection_epoch = c.connection_epoch \+ 1, latest_state_id = null, updated_at = now\(\)/set latest_state_id = null, updated_at = now()/"
mutate legacy_state_allowed "s/raise exception 'OAUTH_STATE_NOT_BOUND';/null;/"
mutate null_token_allowed "s/if coalesce\(p_access_token, ''\) = '' or coalesce\(p_refresh_token, ''\) = '' or coalesce\(p_platform_user_id, ''\) = '' then/if p_access_token = '' or p_refresh_token = '' or p_platform_user_id = '' then/"
mutate disconnect_keeps_states "s/  delete from public.social_account_oauth_states s where s.social_account_id = v_account and s.consumed_at is null;\n//"
mutate cas_ignores_epoch "s/v_epoch is null or v_epoch <> p_expected_epoch or/v_epoch is null or/"
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"

echo "G4X_PERSONAL_EPOCH_ALL_PASS"
