#!/usr/bin/env bash
# G4-43 (Issue #319): G5's S2-2 person-session verdict in the Threads callback entry --
# supabase/candidates/postona_g4_threads_personal_auth/002_threads_entry_person_session.sql (on top of G4-42's 001) -- on a
# disposable LOCAL PostgreSQL 17, never production / managed / real Vault / OAuth / Meta / Threads.
# The world is postona_threads_binding_epoch_run.sh's L30-L153 (real G5 lifecycle + T13 + F5 owner epoch + PR #124 + custody),
# copied so that this proof stands alone. Then binding-epoch 001, G5 PR #506's S2-3 body and G5 PR #510's S2-2 body (verbatim,
# under their own names) and G4-42's 001; the owner transport's claims come from postona_g4_threads_person_session_claims.sql:
#   G4-43 1. behavior: mode=g442 (001 only) / mode=g443 (+ 002); 'omit' = H5's claims today
#   G4-43 2. regression under 002 with is_anonymous false: binding-epoch behavior and G4-42's behavior
#   G4-43 3. install refusals, rollback refusal, rollback -> mode=g442 passes again   4. mutants of 002
# A delegate role and authenticator are cluster-wide: run alone.
# Usage: TB_PGHOST=/private/tmp/<socket-dir> TB_PGPORT=<port> TB_PGSUPER=<superuser> supabase/tests/postona_g4_threads_person_session_run.sh
set -euo pipefail
export LC_ALL=C
export PGOPTIONS="-c client_min_messages=warning"

host="${TB_PGHOST:?TB_PGHOST (local socket dir) required}"
port="${TB_PGPORT:?TB_PGPORT required}"
super="${TB_PGSUPER:?TB_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: TB_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
PR178=83334a091ded5571cf595fd99d7a035627564735
PR303=88481aefaf5488adb2735161ec76fa8ea7046260
for sha in "$PR178" "$PR303"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-tb.XXXXXX)"
n="$$"
owner="kb_tb_owner_$n"
delegate="kb_tb_delegate_$n"
hop1="kb_tb_hop1_$n"; hop2="kb_tb_hop2_$n"; leaf="kb_tb_leaf_$n"
prefix="kabumori_tb_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $leaf" -c "drop role if exists $hop2" -c "drop role if exists $hop1" > /dev/null 2>&1 || true
  "${as_super[@]}" -d postgres -c "drop role if exists $delegate" -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree ----------------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/TB_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/TB_MANIFEST.txt"; done
}
overlay "$PR178" supabase/tests/common_account_write_guard_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql
overlay "$PR303" supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
cand="${TB_CANDIDATE:-$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql}"
rollback="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
cand2="${TB_CANDIDATE2:-$c/postona_threads_binding_epoch/002_custody_connect_proof.sql}"
rollback2="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
custody_behavior="$t/postona_threads_binding_custody_behavior.sql"
behavior="$t/postona_threads_binding_epoch_behavior.sql"
git -C "$repo" show "fd71450511f4a8d73e150a92bd9fe95677b70edc:supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql" > "$tree/pr367_original_001.sql"
echo "fd71450511f4a8d73e150a92bd9fe95677b70edc $(shasum -a 256 "$tree/pr367_original_001.sql" | cut -c1-16) PR #367's original 001 (fail-before copy)" >> "$tree/TB_MANIFEST.txt"
git -C "$repo" show "5bf6f915353eadb4e1425ae6aec3d281ac36c8a8:supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql" > "$tree/pr388_001.sql"
echo "5bf6f915353eadb4e1425ae6aec3d281ac36c8a8 $(shasum -a 256 "$tree/pr388_001.sql" | cut -c1-16) PR #388's 001 (fail-before copy)" >> "$tree/TB_MANIFEST.txt"
git -C "$repo" show "80667ffb788836722eb8d98190eaa874e6d5acc4:supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql" > "$tree/pr405_001.sql"
echo "80667ffb788836722eb8d98190eaa874e6d5acc4 $(shasum -a 256 "$tree/pr405_001.sql" | cut -c1-16) PR #405's 001 (no connect proof)" >> "$tree/TB_MANIFEST.txt"
sed 's/^/  /' "$tree/TB_MANIFEST.txt"

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
need() { [[ "$(apply "$1" "$2")" == applied ]] || fail "$(basename "$2") did not apply: $(apply "$(copy "why_$RANDOM" "$1")" "$2")"; }
pre="${prefix}_pre"
create_db "$pre"
as_owner "$pre" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$pre" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$pre" -f "$m/$f" > /dev/null
done
as_owner "$pre" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
  as_owner "$pre" -f "$m/$f" > /dev/null
done
as_owner "$pre" -f "$t/common_account_write_guard_fixture.sql" > /dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql 20261012230000_common_account_service_brand_state.sql; do
  need "$pre" "$m/$f"
done
as_owner "$pre" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
q "$pre" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$pre" > /dev/null
q "$pre" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
need "$pre" "$m/20261007150000_postona_social_accounts_multi_provider.sql"
need "$pre" "$m/20261013120000_common_account_service_deletion_ownership.sql"
"${as_super[@]}" -d "$pre" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
as_owner "$pre" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
as_owner "$pre" -f "$m/20260918120000_social_mobile_brand_memberships.sql" > /dev/null
# As F5's own runner (PR #303 common_account_owner_epoch_run.sh): the model world's default grants leave TRIGGER / TRUNCATE /
# REFERENCES on public.brand_memberships to API roles, which PR #303 refuses; the real revoke is F3 / G3's dependency. This
# TEST-WORLD revoke stands in for it.
q "$pre" -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" > /dev/null
# G4-02 #2: the G5 PERSONAL MVP world (G5-46/47, g5pv, no owner epoch) for the app flow: this world BEFORE PR #303, then
# G5's MVP_INSTALL (PR #563 head; the blob is unchanged since PR #550). Only built for G4T_APP_FLOW / G4T_BRIDGE_FLOW.
G5MVP=9846c0f062626db1dd4d9e8c10d5b1573e7f4982
mvp_pre=""
if [ -n "${G4T_APP_FLOW:-}${G4T_BRIDGE_FLOW:-}" ]; then
  git -C "$repo" cat-file -e "${G5MVP}^{commit}" 2>/dev/null || fail "missing git objects for $G5MVP (fetch G5 PR #563)"
  [ "$(git -C "$repo" rev-parse "${G5MVP}:supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql")" = eebaabf2629575901947c0664d6f0002526d3273 ] \
    || fail "G5 MVP_INSTALL blob moved (pin)"
  git -C "$repo" show "${G5MVP}:supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql" > "$tree/g5_mvp_install.sql"
  echo "$G5MVP eebaabf2629575901947c0664d6f0002526d3273 G5 MVP_INSTALL (personal MVP, g5pv)" >> "$tree/TB_MANIFEST.txt"
  # MVP prerequisite P1: the rest of G5's lifecycle chain, from the G5 Draft chain G5's own MVP runner pins (21a5cad4)
  G5CHAIN=21a5cad4b71de63265db8517da93c6efc60cdde8
  git -C "$repo" cat-file -e "${G5CHAIN}^{commit}" 2>/dev/null || fail "missing git objects for $G5CHAIN (fetch the G5 chain)"
  g5chain=()
  for f in 20261013140000_common_account_service_reconciliation_facts 20261015090000_common_account_enrollment_session_fence \
           20261015120000_common_account_x_unconfirmed_snapshot_record; do
    git -C "$repo" show "${G5CHAIN}:supabase/migrations/$f.sql" > "$tree/g5chain_$f.sql"
    echo "$G5CHAIN $(git -C "$repo" rev-parse "${G5CHAIN}:supabase/migrations/$f.sql") $f (G5 chain, MVP P1)" >> "$tree/TB_MANIFEST.txt"
    g5chain+=("$tree/g5chain_$f.sql")
  done
  mvp_pre="$(copy mvppre "$pre")"
fi
need "$pre" "$c/common_account_brand_owner_epoch/001_brand_owner_epoch.sql"
need "$pre" "$c/postona_threads_oauth_workspace_candidate.sql"
need "$pre" "$c/postona_threads_publish/threads_credential_custody_candidate.sql"
echo "PASS world: real G5 (T13 + Phase 4 + brand state + Phase 6) + F5 PR #303 owner epoch + live X onboarding tables + 2a-2 + PR #124"

# ---- G4-43: S2-2 in the Threads callback entry ---------------------------------------------------------------------------
G5S23=bbc52a6b
G5S22=6d59f3b6690e237c203ba4ee8a8afbf42e7a5e11
for sha in "$G5S23" "$G5S22"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch G5 PR #506 / #510)"
done
g5_file=supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql
s22_file=supabase/candidates/postona_personal_auth/004_s2_2_personal_session.sql
[ "$(git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' | md5 -q)" = "3d7cf91b22b9f841fd9b4ed3b47eae32" ] \
  || fail "G5 PR #506 predicate lines moved (pin)"
[ "$(git -C "$repo" show "$G5S22:$s22_file" | sed -n '76,132p' | md5 -q)" = "dde7fc6071b756182ac8b4c721fe2cf3" ] \
  || [ -n "${G4T_PRINT_PINS:-}" ] || fail "G5 PR #510 S2-2 lines moved (pin)"
# G5's S2-3 predicate and S2-2 session verdict under their own names, bodies verbatim
git -C "$repo" show "$G5S23:$g5_file" | sed -n '99,141p' > "$tree/g5_predicate.sql"
git -C "$repo" show "$G5S22:$s22_file" | sed -n '76,132p' > "$tree/g5_session.sql"
g442="$c/postona_g4_threads_personal_auth/001_threads_entry_workspace_recheck.sql"
g443="$c/postona_g4_threads_personal_auth/002_threads_entry_person_session.sql"
g443_rb="$c/postona_g4_threads_personal_auth/002_threads_entry_person_session_rollback.sql"
claims="$t/postona_g4_threads_person_session_claims.sql"
mine="$t/postona_g4_threads_person_session_behavior.sql"
recheck="$t/postona_g4_threads_entry_recheck_behavior.sql"
sed -n '1,/^-- 0\. No API role/p' "$behavior" | sed '$d' > "$tree/prelude.sql"
sed -n '/^-- 0\. No API role/,$p' "$behavior" > "$tree/epoch_rest.sql"
echo "select set_config('g4t.anon', 'false', false);" > "$tree/anon_false.sql"
run_mine() { cat "$tree/prelude.sql" "$claims" "$mine" > "$tree/mine_full.sql"; as_owner "$1" -A -t -v mode="$2" -f "$tree/mine_full.sql" 2>&1; }
world="$(copy world "$pre")"
need "$world" "$cand"
as_owner "$world" -f "$tree/g5_predicate.sql" > /dev/null
as_owner "$world" -f "$tree/g5_session.sql" > /dev/null
need "$world" "$g442"
if [ -n "${G4T_PRINT_PINS:-}" ]; then
  echo "s22_lines=$(git -C "$repo" show "$G5S22:$s22_file" | sed -n '76,132p' | md5 -q)"
  pin="$(copy pin "$world")"
  awk '/^create or replace function postona_threads_binding.complete_and_attest_binding\(/ {on=1} on {print} on && /^end \$\$;/ {exit}' "$g443" | q "$pin" > /dev/null
  q "$pin" -c "select 'candidate=' || md5(prosrc) from pg_proc where oid = to_regprocedure('postona_threads_binding.complete_and_attest_binding(uuid,text,text,text,text)')"
  exit 0
fi

# G4-02 #2/#3: the stack and the personal MVP world, shared by the bridge flow and the app flow
pub="$c/postona_threads_publish"
g5pv="$c/postona_g4_threads_personal_mvp/001_threads_binding_g5pv.sql"
g5pv_rb="$c/postona_g4_threads_personal_mvp/001_threads_binding_g5pv_rollback.sql"
stack=("$cand2" "$c/postona_threads_auth_runtime/claim_candidate.sql" "$pub/threads_manual_publish_candidate.sql"
  "$pub/threads_publish_release_candidate.sql" "$c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql"
  "$c/postona_threads_disconnect/threads_disconnect_candidate.sql")
# The personal MVP world up to (not including) G4's binding: G5's chain + MVP_INSTALL, PR #124, custody.
mvp_world() {
  local db; db="$(copy "$1" "$mvp_pre")"
  # TEST-WORLD stand-in for G3's L-1 revoke (G5 MVP prerequisite P3: no person can change memberships), as G5's own runner
  q "$db" -c "revoke insert, update, delete, truncate, references, trigger on public.brand_memberships from anon, authenticated" > /dev/null
  for f in "${g5chain[@]}" "$tree/g5_mvp_install.sql" "$c/postona_threads_oauth_workspace_candidate.sql" \
    "$pub/threads_credential_custody_candidate.sql"; do
    need "$db" "$f"
  done
  echo "$db"
}
# G4-50: the server chain through G4's owner bridge (Edge handler -> H5 runtime -> bridge -> this SQL), then stop.
if [ -n "${G4T_BRIDGE_FLOW:-}" ]; then
  h5_claim="$c/postona_threads_auth_runtime/claim_candidate.sql"
  for profile in ${G4T_PROFILES:-full personal}; do
    if [ "$profile" = full ]; then
      bridge_db="$(copy bridge "$world")"
      for f in "$g443" "$cand2" "$h5_claim"; do need "$bridge_db" "$f"; done
      nobind_db="$(copy nobind "$pre")"   # PR #124 + H5's claim SQL, but no G4 binding entry
    else
      bridge_db="$(mvp_world bridgemvp)"
      for f in "$g5pv" "$cand2" "$h5_claim"; do need "$bridge_db" "$f"; done
      nobind_db="$(mvp_world nobindmvp)"
    fi
    need "$nobind_db" "$h5_claim"
    echo "== G4-50 / G4-02 #3 bridge flow, G5 profile $profile (db $bridge_db, fail-closed db $nobind_db)"
    G4B_PROFILE="$profile" G4B_PGHOST="$host" G4B_PGPORT="$port" G4B_PGUSER="$owner" G4B_DB="$bridge_db" G4B_DB_NOBIND="$nobind_db" \
      deno test --cached-only --no-lock --config "$c/postona_threads_auth_runtime/wiring/deno.json" \
      --allow-env=G4B_PROFILE,G4B_PGHOST,G4B_PGPORT,G4B_PGUSER,G4B_DB,G4B_DB_NOBIND --allow-read="$host" \
      --allow-write="$host/.s.PGSQL.$port" --allow-net="unix:$host/.s.PGSQL.$port" "$t/postona_g4_threads_bridge_flow.smoke.ts"
  done
  echo "G4T_BRIDGE_FLOW_ALL_PASS"
  exit 0
fi

if [ -n "${G4T_APP_FLOW:-}" ]; then
  # G4-02 #1: the app product flow (real hooks -> SDK -> Edge entry -> G4 composition -> H5 runtime -> G4 bridge -> SQL, and the
  # disconnect Edge -> its RPC) on the connect world + PR #124's custody/publish stack + the disconnect candidate.
  # G4-02 #2: once per G5 profile -- "full" (PR #303 owner epoch + G4 001/002) and "personal" (G5's MVP, g5pv + G4's
  # postona_g4_threads_personal_mvp/001) -- then the g5pv candidate's install / rollback checks and one mutant.
  app="$repo/apps/social-mobile"
  [ -d "$app/node_modules/@supabase/supabase-js" ] && [ -d "$app/node_modules/typescript" ] \
    || fail "run 'npm ci --ignore-scripts' in apps/social-mobile first (the real SDK and TypeScript are needed)"
  edge_cmd="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' deno run --cached-only --no-lock \
    --config "$repo/supabase/candidates/postona_threads_auth_runtime/wiring/deno.json" \
    --allow-env=FLOW_PGHOST,FLOW_PGPORT,FLOW_PGUSER,FLOW_DB,FLOW_JWK,FLOW_PROFILE --allow-read="$repo,$host" \
    --allow-write="$host/.s.PGSQL.$port" --allow-net="127.0.0.1,unix:$host/.s.PGSQL.$port" \
    "$repo/supabase/tests/postona_g4_threads_app_flow_edge.ts")"
  # One run of the e2e; no timeout and no kill: the node process must end by itself (G4-02 #2: a leaked deadline timer
  # kept it alive ~10 min). Sets $out; returns node's status.
  flow_run() {
    local status=0
    out="$(cd "$app" && env FLOW_DEBUG="${FLOW_DEBUG:-}" FLOW_PROFILE="$1" FLOW_PGHOST="$host" FLOW_PGPORT="$port" FLOW_PGUSER="$owner" \
      FLOW_DB="$2" FLOW_EDGE_CMD="$edge_cmd" node --experimental-transform-types --test --test-reporter=tap \
      tests/threads-connect-product-flow.e2e.mjs 2>&1)" || status=$?
    return $status
  }
  for profile in ${G4T_PROFILES:-full personal}; do
    if [ "$profile" = full ]; then
      app_db="$(copy app "$world")"
      for f in "$g443" "${stack[@]}"; do need "$app_db" "$f"; done
    elif [ "$profile" = personal ]; then
      app_db="$(mvp_world appmvp)"
      for f in "$g5pv" "${stack[@]}"; do need "$app_db" "$f"; done
    else
      fail "G4T_PROFILES: full | personal"
    fi
    echo "== G4-02 app product flow, G5 profile $profile (db $app_db)"
    t0=$SECONDS
    flow_run "$profile" "$app_db" || { echo "$out"; fail "app product flow ($profile)"; }
    grep -E '^(ok|not ok|# (pass|fail|tests|measured))' <<<"$out"
    echo "node exited by itself with status 0 after $((SECONDS - t0)) s"
  done

  echo "== G4-02 #2 the g5pv candidate: install / rollback / mutant"
  # (a) on the FULL profile (F5's owner epoch present) it refuses before anything else
  r="$(apply "$(copy g5pvfull "$pre")" "$g5pv")"
  [ "$r" = THREADS_BINDING_G5PV_PRECONDITION_FULL_PROFILE ] || fail "g5pv on the full profile: $r"
  echo "ok refused on the full profile ($r)"
  # (b) its rollback refuses the FULL profile's binding (owner_epoch column)
  r="$(apply "$(copy g5pvfullrb "$world")" "$g5pv_rb")"
  [ "$r" = THREADS_BINDING_G5PV_ROLLBACK_NOT_PERSONAL_PROFILE ] || fail "g5pv rollback on the full binding: $r"
  echo "ok its rollback refuses the full binding ($r)"
  # (c) install -> custody 002 -> rollback (002 first) -> install again; a dependent outside the schema blocks the rollback
  rb_db="$(mvp_world g5pvrb)"
  need "$rb_db" "$g5pv"
  need "$rb_db" "$cand2"
  r="$(apply "$rb_db" "$g5pv")"; [ "$r" = THREADS_BINDING_ALREADY_APPLIED ] || fail "g5pv twice: $r"
  need "$rb_db" "$rollback2"
  q "$rb_db" -c "create view public.g4t_dependent as select social_account_id from postona_threads_binding.bindings" > /dev/null
  r="$(apply "$rb_db" "$g5pv_rb")"; [ "$r" = THREADS_BINDING_G5PV_ROLLBACK_DEPENDENTS ] || fail "g5pv rollback with a dependent: $r"
  q "$rb_db" -c "drop view public.g4t_dependent" > /dev/null
  need "$rb_db" "$g5pv_rb"
  [ -z "$(q "$rb_db" -c "select to_regnamespace('postona_threads_binding')")" ] || fail "g5pv rollback left the schema"
  need "$rb_db" "$g5pv"
  echo "ok install, ALREADY_APPLIED, rollback (002 first; refused while a view depends on it), install again"
  # (c2) G4-02 #3 pre-adoption: every install precondition refuses on a fresh MVP world with exactly one thing wrong
  pre_mvp="$(mvp_world g5pvpre)"
  probe() {  # label, expected refusal, SQL that breaks the world (as the owner)
    local db; db="$(copy "g5pv$RANDOM" "$pre_mvp")"
    [ -n "$3" ] && q "$db" -c "$3" > /dev/null
    local r; r="$(apply "$db" "$g5pv")"
    [ "$r" = "$2" ] || fail "g5pv precondition $1: expected $2, got $r"
    echo "ok refused: $1 ($r)"
  }
  probe "G5 MV missing" "THREADS_BINDING_PRECONDITION_DEPENDENCY private.postona_personal_worker_verdict(uuid,text,text,bigint)" \
    "drop function private.postona_personal_worker_verdict(uuid,text,text,bigint)"
  probe "G5 MV exposed to authenticated" THREADS_BINDING_PRECONDITION_G5_GATE_EXPOSED \
    "grant execute on function private.postona_personal_worker_verdict(uuid,text,text,bigint) to authenticated"
  probe "G5 S2-2 exposed to authenticated" THREADS_BINDING_PRECONDITION_G5_GATE_EXPOSED \
    "grant execute on function private.postona_personal_session() to authenticated"
  probe "PR #124 complete exposed" THREADS_BINDING_PRECONDITION_COMPLETE_EXPOSED \
    "grant execute on function public.complete_social_mobile_threads_oauth_connection(uuid,text,text,text,text) to authenticated"
  probe "PR #124 complete not the reviewed body" THREADS_BINDING_PRECONDITION_COMPLETE_UNPINNED \
    "create or replace function public.complete_social_mobile_threads_oauth_connection(p_oauth_state_id uuid, p_platform_user_id text, p_handle text, p_access_token text, p_attestation text) returns void language plpgsql security definer set search_path = '' as \$\$ begin null; end \$\$"
  # as a superuser, and with an API role able to become the owner (a cluster-wide membership: granted and revoked here)
  su_db="$(copy g5pvsu "$pre_mvp")"
  r="$({ "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$su_db" -f "$g5pv" 2>&1 || true; } | sed -n 's/^.*ERROR: *//p' | head -1)"
  [ "$r" = THREADS_BINDING_PRECONDITION_OWNER ] || fail "g5pv as superuser: $r"
  echo "ok refused: run as a superuser ($r)"
  reach_db="$(copy g5pvreach "$pre_mvp")"
  "${as_super[@]}" -d postgres -c "grant $owner to authenticator" > /dev/null
  r="$(apply "$reach_db" "$g5pv")"
  "${as_super[@]}" -d postgres -c "revoke $owner from authenticator" > /dev/null
  [ "$r" = "THREADS_BINDING_PRECONDITION_OWNER_REACHABLE authenticator" ] || fail "g5pv with the owner reachable: $r"
  echo "ok refused: an API role can become the owner ($r)"
  # (c3) no mixing: the FULL profile's SQL does not install on top of the personal one, nor the full binding on the MVP world
  mix_db="$(copy g5pvmix "$pre_mvp")"
  need "$mix_db" "$g5pv"
  for f in "$cand" "$g442" "$g443"; do
    r="$(apply "$(copy "g5pvmix$RANDOM" "$mix_db")" "$f")"
    [ "$r" != applied ] || fail "$(basename "$f") installed on top of the personal profile"
    echo "ok refused: $(basename "$f") on top of the personal profile ($r)"
  done
  # (d) mutant: the entry's MV check at completion replaced by a constant -> the personal e2e must fail (ABA scenario 8)
  sed "s/  v_verdict := private.postona_personal_worker_verdict(v_actor, v_gen.brand_id, 'x_autopost', v_gen.lifecycle_version);/  v_verdict := 'active'; -- MUTANT/" \
    "$g5pv" > "$tree/g5pv_mutant.sql"
  [ "$(grep -c "MUTANT" "$tree/g5pv_mutant.sql")" = 1 ] || fail "mutant not made"
  mut_db="$(mvp_world appmut)"
  for f in "$tree/g5pv_mutant.sql" "${stack[@]}"; do need "$mut_db" "$f"; done
  if flow_run personal "$mut_db"; then fail "the e2e passed without the completion's MV check"; fi
  grep -E '^not ok 8 ' <<<"$out" > /dev/null || { echo "$out"; fail "the mutant did not fail scenario 8"; }
  echo "MUTANT_CAUGHT completion_mv_removed by: $(grep -E '^not ok' <<<"$out" | cut -c1-90 | paste -sd ';' -)"
  echo "G4T_APP_FLOW_ALL_PASS"
  exit 0
fi

echo "== G4-43 1. behavior"
d442="$(copy g442 "$world")"
out="$(run_mine "$d442" g442)" || fail "mode=g442: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o 'G4T_PERSON_SESSION_BEHAVIOR_PASS mode=g442' <<<"$out" || fail "mode=g442 marker"
d443="$(copy g443 "$world")"
need "$d443" "$g443"
out="$(run_mine "$d443" g443)" || fail "mode=g443: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o 'G4T_PERSON_SESSION_BEHAVIOR_PASS mode=g443' <<<"$out" || fail "mode=g443 marker"

echo "== G4-43 2. regression with 002 and a real person's claims (is_anonymous false)"
reg="$(copy reg "$world")"
need "$reg" "$g443"
cat "$tree/prelude.sql" "$claims" "$tree/anon_false.sql" "$tree/epoch_rest.sql" > "$tree/epoch_full.sql"
out="$(as_owner "$reg" -A -t -f "$tree/epoch_full.sql" 2>&1)" || fail "binding-epoch behavior under 002: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o POSTONA_THREADS_BINDING_EPOCH_BEHAVIOR_PASS <<<"$out" || fail "binding-epoch marker"
reg2="$(copy reg2 "$world")"
need "$reg2" "$g443"
cat "$tree/prelude.sql" "$claims" "$tree/anon_false.sql" "$recheck" > "$tree/recheck_full.sql"
out="$(as_owner "$reg2" -A -t -v mode=candidate -f "$tree/recheck_full.sql" 2>&1)" || fail "G4-42 behavior under 002: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o 'G4T_THREADS_RECHECK_BEHAVIOR_PASS mode=candidate' <<<"$out" || fail "G4-42 marker"

echo "== G4-43 3. install refusals and rollback"
only001="$(copy only001 "$pre")"
need "$only001" "$cand"
as_owner "$only001" -f "$tree/g5_session.sql" > /dev/null
got="$(apply "$only001" "$g443")"; [[ "$got" == G4T_SESSION_PRECONDITION_ENTRY_BODY* ]] || fail "without G4-42: $got"; echo "REFUSED_AS_EXPECTED $got"
nos22="$(copy nos22 "$pre")"
need "$nos22" "$cand"
as_owner "$nos22" -f "$tree/g5_predicate.sql" > /dev/null
need "$nos22" "$g442"
got="$(apply "$nos22" "$g443")"; [[ "$got" == G4T_SESSION_PRECONDITION_AUTHORITY* ]] || fail "without S2-2: $got"; echo "REFUSED_AS_EXPECTED $got"
got="$(apply "$d443" "$g443")"; [[ "$got" == G4T_SESSION_PRECONDITION_ENTRY_BODY* ]] || fail "re-apply: $got"; echo "REFUSED_AS_EXPECTED $got"
got="$(apply "$d442" "$g443_rb")"; [[ "$got" == G4T_SESSION_ROLLBACK_NOT_APPLIED* ]] || fail "rollback not applied: $got"; echo "REFUSED_AS_EXPECTED $got"
rb="$(copy rb "$world")"
need "$rb" "$g443"
need "$rb" "$g443_rb"
out="$(run_mine "$rb" g442)" || fail "mode=g442 after rollback: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -o 'G4T_PERSON_SESSION_BEHAVIOR_PASS mode=g442' <<<"$out" | sed 's/^/after rollback: /'

echo "== G4-43 4. negative controls"
survived=0
mutate_g443() { # <name> <perl substitution>
  local f="$tree/g443_mut_$1.sql" db
  perl -0pe "$2" "$g443" > "$f"
  cmp -s "$f" "$g443" && fail "mutant $1 did not change the candidate"
  perl -0pi -e "s/raise exception 'G4T_SESSION_POSTCONDITION_ENTRY_BODY';/null;/" "$f"
  db="$(copy "m_$1" "$world")"
  [[ "$(apply "$db" "$f")" == applied ]] || { echo "MUTANT_CAUGHT $1 (install refused)"; return; }
  if out="$(run_mine "$db" g443)"; then
    echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
  else
    echo "MUTANT_CAUGHT $1 by: $(grep -m1 -o 'FAIL [^:]*' <<<"$out")"
  fi
}
mutate_g443 check_removed "s/  if private.postona_personal_session\(\) is distinct from 'active' then/  if false then/"
mutate_g443 auth_required_allowed "s/  if private.postona_personal_session\(\) is distinct from 'active' then/  if private.postona_personal_session() not in ('active', 'AUTH_REQUIRED') then/"
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"
echo "G4T_PERSON_SESSION_ALL_PASS"
