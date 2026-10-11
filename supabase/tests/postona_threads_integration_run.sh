#!/usr/bin/env bash
# G4 POSTONA Threads connect -> publish INTEGRATION SMOKE. Disposable and local only; never production.
#
# 1. Builds a throwaway combined source tree under /private/tmp from:
#      this branch's HEAD (G4: PR #140 + the integration stack), and BOUNDED, READ-ONLY copies of the exact
#      protected candidates  PR #124 c30f246409a77080cbc03aef6c4cb72b5481e125 (G4 OAuth/workspace SQL),
#                            PR #135 e38788d6677082138f0990453c7d2f00549666d0 (H1 mock OAuth Edge),
#                            PR #139 b4fa672f97592e87682671454e868a92098cbd56 (H5 runtime + durable claim).
#    Nothing is merged, rebased, checked out or pushed; an overlay path that already exists in the base
#    stops the run (ownership overlap). The tree and its manifest are deleted at exit unless KEEP=1.
# 2. On a LOCAL Unix-socket PostgreSQL 17 cluster: the H5 parent world (real G5 lifecycle, deletion, X and
#    Phase 2a-2 migrations; PR #124's MOCK_ONLY T13; fake Vault / Auth sessions), PR #124's candidate and
#    behavior proof, H5's claim candidate, then G4 custody -> PR #140 manual publish -> G4 release, and
#    supabase/candidates/postona_threads_integration/integration_smoke.sql (one person end to end).
# 3. Deno, in the combined tree: integration_smoke.ts (H5's real verifier/runtime -> G4's real Edge logic),
#    and the regression suites of every overlaid candidate plus G4's.
#
# Requires: git objects of the three SHAs (git fetch origin <their branches>), deno, psql 17, a local
# superuser. Usage:
#   THREADS_PGHOST=/private/tmp/<socket-dir> THREADS_PGPORT=<port> THREADS_PGSUPER=<superuser> \
#     supabase/tests/postona_threads_integration_run.sh
set -euo pipefail
export LC_ALL=C

host="${THREADS_PGHOST:?THREADS_PGHOST (local socket dir) required}"
port="${THREADS_PGPORT:?THREADS_PGPORT required}"
super="${THREADS_PGSUPER:?THREADS_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: THREADS_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }

PR124=c30f246409a77080cbc03aef6c4cb72b5481e125
PR135=e38788d6677082138f0990453c7d2f00549666d0
PR139=b4fa672f97592e87682671454e868a92098cbd56
for sha in "$PR124" "$PR135" "$PR139"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-threads-int.XXXXXX)"
n="$$"
owner="kb_threads_int_owner_$n"
db="kabumori_threads_int_$n"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  "${as_super[@]}" -d postgres -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree ------------------------------------------------------------------------------------
# The base is this checkout's working tree (tracked + new files, .gitignore respected), i.e. HEAD plus
# any local edits; after a commit it is exactly HEAD.
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do
    [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"
  done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $path" >> "$tree/INTEGRATION_MANIFEST.txt"; done
}
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/INTEGRATION_MANIFEST.txt"
overlay "$PR124" \
  supabase/candidates/postona_threads_oauth_workspace_candidate.sql \
  supabase/functions/_shared/social/threads_connect_rpc_contract.ts \
  supabase/functions/_shared/social/threads_connect_rpc_contract_test.ts \
  supabase/tests/postona_threads_oauth_behavior.sql \
  supabase/tests/postona_threads_oauth_mock_t13_fixture.sql \
  supabase/tests/postona_threads_oauth_test_fixture.sql \
  supabase/tests/postona_threads_oauth_run.sh
overlay "$PR135" supabase/candidates/postona_threads_edge
overlay "$PR139" supabase/candidates/postona_threads_auth_runtime supabase/functions/threads-oauth-connect-user
echo "PASS combined tree: base $head + bounded read-only copies of #124 #135 #139 (no overlap)"

# ---- 2. Database chain -------------------------------------------------------------------------------------
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
q=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
# The H5 parent world, exactly as PR #139's parent_integration_run.sh builds it.
"${q[@]}" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
for f in 20260919120000_social_mobile_x_oauth_onboarding.sql 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  "${q[@]}" -f "$m/$f" > /dev/null
done
"${q[@]}" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
  "${q[@]}" -f "$m/$f" > /dev/null
done
"${q[@]}" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
"${q[@]}" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | "${q[@]}" > /dev/null
"${q[@]}" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
"${q[@]}" -f "$m/20261007150000_postona_social_accounts_multi_provider.sql" > /dev/null
"${as_super[@]}" -d "$db" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
"${q[@]}" -f "$t/postona_threads_oauth_mock_t13_fixture.sql" > /dev/null
"${q[@]}" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
"${q[@]}" -f "$c/postona_threads_oauth_workspace_candidate.sql" > /dev/null
"${q[@]}" -f "$c/postona_threads_auth_runtime/claim_candidate.sql" > /dev/null
# PR #124's own behavior proof (its helpers postona_t are used below); its test-only grants as H5 does.
"${q[@]}" -c 'grant execute on function public.begin_social_mobile_threads_oauth_connection(text,text,timestamptz),public.consume_social_mobile_threads_oauth_state(text),public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text) to authenticated;' > /dev/null
"${q[@]}" -v mock=true -v g5=false -v owner="$owner" -f "$t/postona_threads_oauth_behavior.sql" > /dev/null
echo "PASS PR #124 behavior on the H5 parent world"
# G4: custody -> manual publish (PR #140) -> release.
for f in threads_credential_custody_candidate.sql threads_manual_publish_candidate.sql threads_publish_release_candidate.sql; do
  "${q[@]}" -f "$c/postona_threads_publish/$f" > /dev/null || fail "G4 $f did not apply on the combined world"
done
out="$("${q[@]}" -A -t -f "$c/postona_threads_integration/integration_smoke.sql" 2>&1)" || { echo "$out" | tail -5 >&2; fail "integration_smoke.sql"; }
grep -q G4_INTEGRATION_SMOKE_SQL_PASS <<<"$out" || fail "integration_smoke.sql incomplete"
echo "PASS SQL chain: G5 start -> #124 begin/complete + H5 claim/outcome + G4 custody -> G4 permission/reserve/release x4 -> published; P1 refusals"

# ---- 3. Deno in the combined tree --------------------------------------------------------------------------
cd "$tree"
deno test --no-config --no-lock --allow-env --allow-read supabase/candidates/postona_threads_integration/integration_smoke.ts > "$tree/deno_smoke.log" 2>&1 \
  || { tail -20 "$tree/deno_smoke.log" >&2; fail "integration_smoke.ts"; }
echo "PASS TS chain: H5 verifier/runtime -> receipt -> G4 Edge logic -> one post, read back"
deno test --no-config --no-lock --allow-env --allow-read \
  supabase/candidates/postona_threads_auth_runtime/runtime_test.ts \
  supabase/candidates/postona_threads_edge/ \
  supabase/functions/_shared/social/ \
  supabase/functions/social-mobile-threads-publish/ > "$tree/deno_regress.log" 2>&1 \
  || { tail -30 "$tree/deno_regress.log" >&2; fail "regression suites in the combined tree"; }
echo "PASS regressions in the combined tree: $(grep -E '(passed|failed) \|' "$tree/deno_regress.log" | tail -1 | sed 's/\x1b\[[0-9;]*m//g')"
cat "$tree/INTEGRATION_MANIFEST.txt"
echo "ALL PASS (RUN: local disposable PG17 + Deno with fakes. NOT_RUN: managed Supabase Auth/PostgREST/Vault, real G5 T13, Meta, production)"
