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
if [ -n "${G4T_APP_FLOW:-}${G4T_BRIDGE_FLOW:-}${G4T_VERDICT:-}" ]; then
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
  "$c/postona_threads_disconnect/threads_disconnect_candidate.sql"
  "$c/postona_g4_credential_verdict/001_threads_publish_credential_verdict.sql")
# G4-02 #11: a manual post also needs G4's credential verdict (after the verdict 001). G4MP_WITHOUT_VERDICT_GATE=1 leaves it out.
g4mp="$c/postona_g4_threads_manual_publish_verdict/001_manual_publish_requires_credential_verdict.sql"
g4mp_rb="$c/postona_g4_threads_manual_publish_verdict/001_manual_publish_requires_credential_verdict_rollback.sql"
stack_before_g4mp=("${stack[@]}")
[ "${G4MP_WITHOUT_VERDICT_GATE:-0}" = 1 ] || stack+=("$g4mp")
# G4-02 #12: each attempt is bound to the credential generation it was begun under (002, after 001).
# G4MG_WITHOUT_GENERATION_GATE=1 leaves it out (002 needs 001: also left out with G4MP_WITHOUT_VERDICT_GATE=1).
g4mg="$c/postona_g4_threads_manual_publish_verdict/002_manual_publish_attempt_credential_generation.sql"
g4mg_rb="$c/postona_g4_threads_manual_publish_verdict/002_manual_publish_attempt_credential_generation_rollback.sql"
stack_before_g4mg=("${stack[@]}")
[ "${G4MP_WITHOUT_VERDICT_GATE:-0}" = 1 ] || [ "${G4MG_WITHOUT_GENERATION_GATE:-0}" = 1 ] || stack+=("$g4mg")
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
# G4-02 #4: the read-only publish-credential verdicts G3's consumers bind to (X on the full profile, Threads on both).
if [ -n "${G4T_VERDICT:-}" ]; then
  vd="$c/postona_g4_credential_verdict"
  v1="$vd/001_threads_publish_credential_verdict.sql"; v1_rb="$vd/001_threads_publish_credential_verdict_rollback.sql"
  v2="$vd/002_x_publish_credential_verdict.sql"; v2_rb="$vd/002_x_publish_credential_verdict_rollback.sql"
  xc="$c/postona_g4_x_oauth_personal_epoch"
  xbeh="$t/postona_g4_credential_verdict_x_behavior.sql"
  full_with_x() {
    local db; db="$(copy "$1" "$world")"
    for f in "$g443" "${stack[@]}" "$xc/001_x_oauth_personal_epoch.sql" "$xc/002_x_oauth_product_wiring.sql" \
      "$xc/003_x_disconnect_user_rpc.sql" "$xc/004_x_consume_preexchange_recheck.sql" "$xc/005_x_connect_lifecycle_t13.sql" "$v2"; do
      need "$db" "$f"
    done
    echo "$db"
  }
  echo "== G4-02 #4 X verdict through G4's real X SQL (full profile)"
  vx="$(full_with_x verdictx)"
  out="$(as_owner "$vx" -A -t -v profile=full -f "$xbeh" 2>&1)" || { echo "$out"; fail "X verdict behavior"; }
  grep -E '^[0-9]+\|' <<<"$out"
  grep -q G4V_X_VERDICT_BEHAVIOR_PASS <<<"$out" || fail "X verdict marker"
  # mutant: the refresh-state check removed -> the behavior must fail on case 5
  sed "s/  select r.status into v_refresh from public.x_account_refresh_state_v2 r where r.social_account_id = v_account.id;/  v_refresh := null; -- MUTANT/" "$v2" > "$tree/v2_mutant.sql"
  [ "$(grep -c MUTANT "$tree/v2_mutant.sql")" = 1 ] || fail "X verdict mutant not made"
  vm="$(copy verdictxm "$world")"
  for f in "$g443" "${stack[@]}" "$xc/001_x_oauth_personal_epoch.sql" "$xc/002_x_oauth_product_wiring.sql" "$xc/003_x_disconnect_user_rpc.sql" \
    "$xc/004_x_consume_preexchange_recheck.sql" "$xc/005_x_connect_lifecycle_t13.sql" "$tree/v2_mutant.sql"; do need "$vm" "$f"; done
  if out="$(as_owner "$vm" -A -t -v profile=full -f "$xbeh" 2>&1)"; then fail "the X verdict behavior passed without the refresh-state check"; fi
  echo "MUTANT_CAUGHT x_refresh_state_ignored by: $(grep -E '\|FAIL ' <<<"$out" | cut -d'|' -f2 | paste -sd ';' -)"

  echo "== G4-02 #4 install / rollback / ACL"
  r="$(apply "$(mvp_world verdictp)" "$v1")"; [ "$r" = "G4_VERDICT_PRECONDITION_TABLE postona_threads_binding.bindings" ] || fail "001 without G4's binding: $r"
  echo "ok 001 refused without G4's Threads binding ($r)"
  pv="$(mvp_world verdictpv)"
  for f in "$g5pv" "${stack[@]}"; do need "$pv" "$f"; done
  echo "ok 001 installed on the PERSONAL profile (g5pv binding)"
  r="$(apply "$(copy verdictpvx "$pv")" "$v2")"; [ "$r" = G4_X_VERDICT_PRECONDITION_LINEAGE ] || fail "002 without G4's X lineage: $r"
  echo "ok 002 refused while G4's X OAuth is not installed ($r)"
  r="$(apply "$pv" "$v1")"; [ "$r" = G4_VERDICT_ALREADY_APPLIED ] || fail "001 twice: $r"
  # G4-02 #5: G4's X OAuth on the personal profile (001 / 005 g5pv builds + 002-004 verbatim), then the X verdict there too
  px="$c/postona_g4_x_oauth_personal_mvp"
  python3 -I "$repo/supabase/tests/postona_g4_x_oauth_personal_mvp_build.py" "$repo" --check > /dev/null || fail "personal X does not re-derive"
  r="$(apply "$(copy xmixfull "$world")" "$px/001_x_oauth_g5pv.sql")"; [ "$r" = G4X_G5PV_PRECONDITION_FULL_PROFILE ] || fail "personal X on full: $r"
  echo "ok personal X 001 refused on the full profile ($r)"
  r="$(apply "$(copy xmixpers "$pv")" "$xc/001_x_oauth_personal_epoch.sql")"
  [ "$r" = "G4X_PRECONDITION_AUTHORITY_MISSING private.account_lifecycle_brand_owner_epoch(text)" ] || fail "full X on personal: $r"
  echo "ok full X 001 refused on the personal profile ($r)"
  for f in "$px/001_x_oauth_g5pv.sql" "$xc/002_x_oauth_product_wiring.sql" "$xc/003_x_disconnect_user_rpc.sql" \
    "$xc/004_x_consume_preexchange_recheck.sql" "$px/005_x_connect_lifecycle_t13_g5pv.sql" "$v2"; do need "$pv" "$f"; done
  echo "ok personal X 001-005 + the X verdict installed on the personal profile"
  # G4-02 #7: the database's own profile answer (006): install refusals, ACL, and each thing that must turn it to 'mismatch'
  fence="$px/006_x_connect_profile_fence.sql"; fence_rb="$px/006_x_connect_profile_fence_rollback.sql"
  r="$(apply "$(copy fencefull "$vx")" "$fence")"; [ "$r" = G4X_FENCE_PRECONDITION_FULL_PROFILE ] || fail "fence on full: $r"
  echo "ok 006 refused on the full profile ($r)"
  r="$(apply "$(copy fenceno "$(mvp_world fencebase)")" "$fence")"; [ "$r" = G4X_FENCE_PRECONDITION_X_NOT_INSTALLED ] || fail "fence without X: $r"
  echo "ok 006 refused without the personal X ($r)"
  need "$pv" "$fence"
  r="$(apply "$pv" "$fence")"; [ "$r" = G4X_FENCE_ALREADY_APPLIED ] || fail "fence twice: $r"
  ask() { q "$1" -c "begin; set local role authenticated; select public.postona_x_connect_profile_v1(); rollback" | tail -1; }
  [ "$(ask "$pv")" = personal ] || fail "fence answer on personal: $(ask "$pv")"
  echo "ok authenticated asks: personal; anon / service_role cannot: $(q "$pv" -c "select has_function_privilege('anon', 'public.postona_x_connect_profile_v1()', 'EXECUTE'), has_function_privilege('service_role', 'public.postona_x_connect_profile_v1()', 'EXECUTE')" | tr '|' ' ')"
  [ "$(q "$pv" -c "select has_function_privilege('anon', 'public.postona_x_connect_profile_v1()', 'EXECUTE') or has_function_privilege('service_role', 'public.postona_x_connect_profile_v1()', 'EXECUTE')")" = f ] || fail "fence reachable by another API role"
  probe_fence() {  # label, SQL (as the owner) that makes the database not the personal build
    local db; db="$(copy "fp$RANDOM" "$pv")"
    q "$db" -c "$2" > /dev/null
    [ "$(ask "$db")" = mismatch ] || fail "fence still says personal: $1"
    echo "ok mismatch: $1"
  }
  probe_fence "F5's owner epoch function exists" "create function private.account_lifecycle_brand_owner_epoch(text) returns bigint language sql as 'select 1::bigint'"
  probe_fence "the generation helper is the full profile's body" "create or replace function postona_g4_x_oauth.require_owner_epoch(p_brand_id text) returns bigint language plpgsql volatile security definer set search_path = '' as \$\$ declare v_epoch bigint; begin return 1; end \$\$"
  probe_fence "begin is not the reviewed body" "create or replace function public.begin_social_mobile_x_oauth_connection(p_state_hash text, p_redirect_uri text, p_expires_at timestamptz) returns table (brand_id text, social_account_id text) language plpgsql security definer as \$\$ begin return; end \$\$"
  probe_fence "the generation helper is exposed" "grant execute on function postona_g4_x_oauth.require_owner_epoch(text) to authenticated"
  probe_fence "G5's MV is exposed" "grant execute on function private.postona_personal_worker_verdict(uuid,text,text,bigint) to authenticated"
  probe_fence "G5's MV is missing" "alter function private.postona_personal_worker_verdict(uuid,text,text,bigint) rename to mv_gone"
  # a second overload of a checked name
  probe_fence "a second function of a checked name" "create function postona_g4_x_oauth.require_owner_epoch(bigint) returns bigint language sql as 'select 1::bigint'"
  fr="$(copy fencerb "$pv")"
  need "$fr" "$fence_rb"
  [ -z "$(q "$fr" -c "select to_regprocedure('public.postona_x_connect_profile_v1()')")" ] || fail "fence rollback left the function"
  need "$fr" "$fence"
  echo "ok 006 rollback, then install again"
  q "$pv" -c "select 'md5 postona_x_connect_profile_v1 ' || md5(prosrc) from pg_proc where oid = 'public.postona_x_connect_profile_v1()'::regprocedure"
  # G4-02 #8: the refresh writer's precheck (007): install refusals, ACL, rollback
  pre7="$px/007_x_refresh_precheck.sql"; pre7_rb="$px/007_x_refresh_precheck_rollback.sql"
  r="$(apply "$(copy pre7full "$vx")" "$pre7")"; [ "$r" = G4X_PRECHECK_PRECONDITION_FULL_PROFILE ] || fail "007 on full: $r"
  echo "ok 007 refused on the full profile ($r)"
  no6="$(copy pre7no6 "$pv")"; need "$no6" "$fence_rb"
  r="$(apply "$no6" "$pre7")"; [ "$r" = "G4X_PRECHECK_PRECONDITION_DEPENDENCY public.postona_x_connect_profile_v1()" ] || fail "007 without 006: $r"
  echo "ok 007 refused without 006 ($r)"
  need "$pv" "$pre7"
  r="$(apply "$pv" "$pre7")"; [ "$r" = G4X_PRECHECK_ALREADY_APPLIED ] || fail "007 twice: $r"
  acl7="$(q "$pv" -c "select has_function_privilege('anon', 'public.postona_x_refresh_precheck_v1(text)', 'EXECUTE')::text || has_function_privilege('authenticated', 'public.postona_x_refresh_precheck_v1(text)', 'EXECUTE')::text || has_function_privilege('service_role', 'public.postona_x_refresh_precheck_v1(text)', 'EXECUTE')::text")"
  [ "$acl7" = falsefalsetrue ] || fail "007 ACL: $acl7"
  echo "ok 007 EXECUTE: service_role only (anon, authenticated: no)"
  r7="$(copy pre7rb "$pv")"; need "$r7" "$pre7_rb"; need "$r7" "$pre7"
  echo "ok 007 rollback, then install again"
  q "$pv" -c "select 'md5 postona_x_refresh_precheck_v1 ' || md5(prosrc) from pg_proc where oid = 'public.postona_x_refresh_precheck_v1(text)'::regprocedure"
  echo "== G4-02 #5 X verdict through G4's personal X SQL (personal profile)"
  out="$(as_owner "$pv" -A -t -v profile=personal -f "$xbeh" 2>&1)" || { echo "$out"; fail "X verdict behavior (personal)"; }
  grep -E '^[0-9]+\|' <<<"$out"
  grep -q G4V_X_VERDICT_BEHAVIOR_PASS <<<"$out" || fail "X verdict marker (personal)"
  # mutant: the personal generation helper returns a constant (the g5pv generation ignored) -> case 11 must fail
  python3 -I - "$px/001_x_oauth_g5pv.sql" "$tree/x001p_mutant.sql" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
old = "  return v_generation;\nend $$;\n"
assert text.count(old) == 1, "mutant anchor"
open(dst, "w").write(text.replace(old, "  return 1; -- MUTANT\nend $$;\n"))
PY
  pm="$(mvp_world xpmut)"
  for f in "$g5pv" "${stack[@]}" "$tree/x001p_mutant.sql" "$xc/002_x_oauth_product_wiring.sql" "$xc/003_x_disconnect_user_rpc.sql" \
    "$xc/004_x_consume_preexchange_recheck.sql" "$px/005_x_connect_lifecycle_t13_g5pv.sql" "$v2"; do need "$pm" "$f"; done
  if out="$(as_owner "$pm" -A -t -v profile=personal -f "$xbeh" 2>&1)"; then fail "the personal X behavior passed with a constant generation"; fi
  grep -qE '^28\|11 service end \+ restart between begin and complete\|FAIL' <<<"$out" || { echo "$out" | grep -E '\|FAIL'; fail "the mutant failed for another reason"; }
  echo "MUTANT_CAUGHT personal_generation_constant by: $(grep -E '\|FAIL ' <<<"$out" | cut -d'|' -f2 | paste -sd ';' -)"
  # the personal rollbacks are the full-profile ones, verbatim (005 -> 001), after the X verdict
  pr="$(copy xrb "$pv")"
  for f in "$px/007_x_refresh_precheck_rollback.sql" "$px/006_x_connect_profile_fence_rollback.sql" "$v2_rb" "$xc/005_x_connect_lifecycle_t13_rollback.sql" "$xc/004_x_consume_preexchange_recheck_rollback.sql" \
    "$xc/003_x_disconnect_user_rpc_rollback.sql" "$xc/002_x_oauth_product_wiring_rollback.sql" "$xc/001_x_oauth_personal_epoch_rollback.sql"; do need "$pr" "$f"; done
  [ -z "$(q "$pr" -c "select to_regnamespace('postona_g4_x_oauth')")" ] || fail "personal X rollback left the schema"
  echo "ok personal X rolled back with the full-profile rollbacks (005 -> 001), schema gone"
  su_db="$(copy verdictsu "$pv")"
  need "$su_db" "$v2_rb"; need "$su_db" "$v1_rb"
  r="$({ "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$su_db" -f "$v1" 2>&1 || true; } | sed -n 's/^.*ERROR: *//p' | head -1)"
  [ "$r" = G4_VERDICT_PRECONDITION_OWNER ] || fail "001 as superuser: $r"
  echo "ok 001 refused as a superuser ($r)"
  acl="$(q "$vx" -c "select string_agg(r || '=' || has_function_privilege(r, f, 'EXECUTE')::text, ',' order by r, f)
    from unnest(array['anon','authenticated','service_role','authenticator']) r,
         unnest(array['postona_g4_credential.threads_publish_credential_verdict(uuid,text)','postona_g4_credential.x_publish_credential_verdict(uuid,text)']::regprocedure[]) f")"
  [ "$(grep -o '=true' <<<"$acl" | wc -l | tr -d ' ')" = 0 ] || fail "an API role can execute a verdict: $acl"
  q "$vx" -c "select 'acl ' || p.proname || ' ' || array_to_string(p.proacl, ',') from pg_proc p where p.pronamespace = 'postona_g4_credential'::regnamespace order by 1"
  r="$(apply "$vx" "$v1_rb")"; [ "$r" = G4_VERDICT_ROLLBACK_002_FIRST ] || fail "001 rollback before 002: $r"
  need "$vx" "$v2_rb"; need "$vx" "$v1_rb"
  [ -z "$(q "$vx" -c "select to_regnamespace('postona_g4_credential')")" ] || fail "rollback left the schema"
  need "$vx" "$v1"; need "$vx" "$v2"
  echo "ok rollback order (002 first), schema gone, install again"
  q "$vx" -c "select 'md5 ' || p.proname || ' ' || md5(p.prosrc) from pg_proc p where p.pronamespace = 'postona_g4_credential'::regnamespace order by 1"
  echo "G4T_VERDICT_ALL_PASS"
  exit 0
fi

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

  if [ "${G4MP_WITHOUT_VERDICT_GATE:-0}" != 1 ]; then
    echo "== G4-02 #11 manual publish x credential verdict (postona_g4_threads_manual_publish_verdict/001)"
    # (a) fail-before: the same e2e on the stack WITHOUT 001 (so also without 002, which needs it) fails scenario 30 and
    #     #12's 31-32 and #13's 33, and nothing else
    nc_db="$(mvp_world appmut1)"
    for f in "$g5pv" "${stack_before_g4mp[@]}"; do need "$nc_db" "$f"; done
    if flow_run personal "$nc_db"; then fail "the e2e passed without the verdict gate"; fi
    [ "$(grep -E '^not ok' <<<"$out" | cut -d' ' -f3 | paste -sd ' ' -)" = "30 31 32 33" ] || { echo "$out"; fail "without 001: expected only scenarios 30 31 32 33 to fail"; }
    echo "FAIL_BEFORE without 001: $(grep -E '^# measured 30' <<<"$out" | cut -c1-260)"
    # (b) install / refusals / rollback on copies of a world that has the stack up to the verdict
    base_db="$(mvp_world g4mpbase)"
    for f in "$g5pv" "${stack_before_g4mp[@]}"; do need "$base_db" "$f"; done
    body_md5() { q "$1" -c "select md5(prosrc) from pg_proc where oid = 'public.threads_manual_publish_authorize(uuid,text,boolean)'::regprocedure"; }
    fn_acl() { q "$1" -c "select coalesce(proacl::text, 'null') from pg_proc where oid = 'public.threads_manual_publish_authorize(uuid,text,boolean)'::regprocedure"; }
    [ "$(body_md5 "$base_db")" = 8e97121f49f5b934dda0408f9b4044e9 ] || fail "the release candidate's authorize body moved: $(body_md5 "$base_db")"
    r="$(apply "$base_db" "$g4mp_rb")"; [ "$r" = G4MP_ROLLBACK_NOT_APPLIED ] || fail "rollback before install: $r"
    echo "ok rollback refused before install ($r)"
    db="$(copy "g4mp$RANDOM" "$base_db")"
    need "$db" "$g4mp"
    r="$(apply "$db" "$g4mp")"; [ "$r" = G4MP_PRECONDITION_ALREADY_APPLIED ] || fail "001 twice: $r"
    [ "$(fn_acl "$base_db")" = "$(fn_acl "$db")" ] || fail "001 changed the ACL: $(fn_acl "$base_db") -> $(fn_acl "$db")"
    need "$db" "$g4mp_rb"
    [ "$(body_md5 "$db")" = 8e97121f49f5b934dda0408f9b4044e9 ] || fail "rollback did not restore the release body"
    need "$db" "$g4mp"
    echo "ok install, ALREADY_APPLIED, ACL unchanged ($(fn_acl "$db")), rollback restores md5 8e97121f, install again"
    db="$(copy "g4mp$RANDOM" "$base_db")"
    q "$db" -c "drop function postona_g4_credential.threads_publish_credential_verdict(uuid, text)" > /dev/null
    r="$(apply "$db" "$g4mp")"; [ "$r" = G4MP_PRECONDITION_VERDICT ] || fail "001 without the verdict: $r"
    echo "ok refused without the verdict ($r)"
    db="$(copy "g4mp$RANDOM" "$base_db")"
    q "$db" -c "do \$x\$ begin execute replace(pg_get_functiondef('public.threads_manual_publish_authorize(uuid,text,boolean)'::regprocedure), 'return null;', 'return null; -- moved'); end \$x\$" > /dev/null
    r="$(apply "$db" "$g4mp")"; [ "$r" = G4MP_PRECONDITION_AUTHORIZE_UNPINNED ] || fail "001 on another authorize body: $r"
    echo "ok refused on an unpinned authorize body ($r)"
    db="$(copy "g4mp$RANDOM" "$base_db")"
    r="$({ "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$g4mp" 2>&1 || true; } | sed -n 's/^.*ERROR: *//p' | head -1)"
    [ "$r" = G4MP_PRECONDITION_OWNER ] || fail "001 as a superuser: $r"
    echo "ok refused as a superuser ($r)"
    # G4-02 #12 (H1 #40 P3): a verdict that is not the reviewed one refuses the install (nothing changed)
    verdict_fn="postona_g4_credential.threads_publish_credential_verdict(uuid,text)"
    [ "$(q "$base_db" -c "select md5(prosrc) from pg_proc where oid = '$verdict_fn'::regprocedure")" = fb93a0ad84c44c6781521eec4618fff4 ] \
      || fail "the installed verdict is not the reviewed body"
    synth_true="create or replace function postona_g4_credential.threads_publish_credential_verdict(p_user_id uuid, p_social_account_id text)
      returns table (verified boolean, credential_generation text, code text) language plpgsql stable security definer set search_path = ''
      as \$v\$ begin return query select true, 'g4t1:00000000-0000-4000-8000-000000000000'::text, 'VERIFIED'::text; end \$v\$"
    for drift in synthetic_true grant_authenticated search_path; do
      db="$(copy "g4mp$RANDOM" "$base_db")"
      case "$drift" in
        synthetic_true) q "$db" -c "$synth_true" > /dev/null
          [ "$(q "$db" -c "select verified::text || '|' || code from postona_g4_credential.threads_publish_credential_verdict(null, null)")" = "true|VERIFIED" ] \
            || fail "the synthetic verdict is not constant-true" ;;
        grant_authenticated) q "$db" -c "grant execute on function $verdict_fn to authenticated" > /dev/null ;;
        search_path) q "$db" -c "alter function $verdict_fn set search_path = public" > /dev/null ;;
      esac
      [ "$(q "$db" -c "select proowner = (select oid from pg_roles where rolname = current_user) and prosecdef from pg_proc where oid = '$verdict_fn'::regprocedure")" = t ] \
        || fail "drift $drift changed the owner / definer"
      before_md5="$(body_md5 "$db")"
      r="$(apply "$db" "$g4mp")"; [ "$r" = G4MP_PRECONDITION_VERDICT_UNPINNED ] || fail "001 on a drifted verdict ($drift): $r"
      [ "$(body_md5 "$db")" = "$before_md5" ] || fail "001 changed authorize on a drifted verdict ($drift)"
      echo "ok refused on a drifted verdict: $drift ($r, authorize unchanged)"
    done
    # (c) mutant: the verdict also gates the read-backs (confirm / reconcile) -> the unknown post of scenario 30 is stranded
    sed 's/^  if p_require_permission then$/  if true then -- MUTANT/' "$g4mp" > "$tree/g4mp_mutant_readback.sql"
    [ "$(grep -c MUTANT "$tree/g4mp_mutant_readback.sql")" = 1 ] || fail "read-back mutant not made"
    mut_db="$(mvp_world appmut2)"
    for f in "$g5pv" "${stack_before_g4mp[@]}" "$tree/g4mp_mutant_readback.sql"; do need "$mut_db" "$f"; done
    if flow_run personal "$mut_db"; then fail "the e2e passed with the verdict gating read-backs"; fi
    grep -E '^not ok 30 ' <<<"$out" > /dev/null || { echo "$out"; fail "the read-back mutant did not fail scenario 30"; }
    echo "MUTANT_CAUGHT verdict_gates_readbacks by: $(grep -E '^not ok' <<<"$out" | cut -c1-90 | paste -sd ';' -)"
  fi

  if [ "${G4MP_WITHOUT_VERDICT_GATE:-0}" != 1 ] && [ "${G4MG_WITHOUT_GENERATION_GATE:-0}" != 1 ]; then
    echo "== G4-02 #12 manual publish attempt x credential generation (postona_g4_threads_manual_publish_verdict/002)"
    begin_fn="public.begin_threads_manual_publish(text,uuid,text)"
    release_fn="public.release_threads_manual_publish_step(uuid,text,bigint,text,text)"
    fn_md5() { q "$1" -c "select md5(prosrc) from pg_proc where oid = '$2'::regprocedure"; }
    fn_acls() { q "$1" -c "select string_agg(oid::regprocedure::text || '=' || proowner::text || ':' || coalesce(proacl::text, 'null') || ':' || prosecdef::text || ':' || coalesce(proconfig::text, '-'), ' ' order by oid) from pg_proc where oid in ('$begin_fn'::regprocedure, '$release_fn'::regprocedure)"; }
    has_table() { q "$1" -c "select to_regclass('public.threads_manual_publish_attempt_generations') is not null"; }
    # G4-02 #13: the send fence (function md5, owner-only ACL, trigger type / enabled) or "none"
    fence() { q "$1" -c "select coalesce((select md5(p.prosrc) || ' acl=' || coalesce(p.proacl::text, 'null') || ' definer=' || p.prosecdef::text
        || ' trigger=' || coalesce((select string_agg(t.tgtype::text || t.tgenabled::text, ',') from pg_trigger t where t.tgname = 'threads_manual_publish_send_fence' and t.tgrelid = 'postona_threads_binding.bindings'::regclass), '-')
      from pg_proc p where p.oid = to_regprocedure('postona_threads_binding.manual_publish_send_fence()')),
      case when exists (select 1 from pg_trigger where tgname = 'threads_manual_publish_send_fence') then 'trigger-only' else 'none' end)"; }
    # (a) fail-before: the stack WITH 001 but WITHOUT 002 fails scenarios 31 and 32 (and #13's 33), and nothing else
    ng_db="$(mvp_world appmut3)"
    for f in "$g5pv" "${stack_before_g4mg[@]}"; do need "$ng_db" "$f"; done
    if flow_run personal "$ng_db"; then fail "the e2e passed without the generation gate"; fi
    [ "$(grep -E '^not ok' <<<"$out" | cut -d' ' -f3 | paste -sd ' ' -)" = "31 32 33" ] || { echo "$out"; fail "without 002: expected only scenarios 31 32 33 to fail"; }
    echo "FAIL_BEFORE without 002: $(grep -E '^# measured 31' <<<"$out" | cut -c1-900)"
    echo "FAIL_BEFORE without 002: $(grep -E '^# measured 32' <<<"$out" | cut -c1-400)"
    # (b) install / refusals / partial application / rollback on copies of a world with the stack up to 001
    gbase="$(mvp_world g4mgbase)"
    for f in "$g5pv" "${stack_before_g4mg[@]}"; do need "$gbase" "$f"; done
    [ "$(fn_md5 "$gbase" "$begin_fn") $(fn_md5 "$gbase" "$release_fn")" = "6ae40adbcd203592fbc3847c57f1bccf bd5bed5adcbef4d87614613f51c83dbf" ] \
      || fail "the candidates' begin / release bodies moved"
    r="$(apply "$gbase" "$g4mg_rb")"; [ "$r" = G4MG_ROLLBACK_NOT_APPLIED ] || fail "002 rollback before install: $r"
    echo "ok 002 rollback refused before install ($r)"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    need "$db" "$g4mg"
    [ "$(fn_md5 "$db" "$begin_fn") $(fn_md5 "$db" "$release_fn")" = "7d26e42edaf3f7f85083880814983c2e e92ec523bb1a7a3ba7ca53dce744fb82" ] || fail "002 bodies"
    [ "$(fn_acls "$gbase")" = "$(fn_acls "$db")" ] || fail "002 changed owner / ACL / settings: $(fn_acls "$gbase") -> $(fn_acls "$db")"
    fen="$(fence "$db")"
    [ "${fen%% *}" = 4992a4a16baad53a9eb17c3cfb71a3f6 ] && [[ "$fen" == *" definer=true trigger=23O" ]] || fail "002 fence: $fen"
    tbl="$(q "$db" -c "select relrowsecurity::text || ' ' || coalesce(relacl::text, 'null') || ' policies=' || (select count(*) from pg_policy where polrelid = c.oid) from pg_class c where oid = 'public.threads_manual_publish_attempt_generations'::regclass")"
    r="$(apply "$db" "$g4mg")"; [ "$r" = G4MG_PRECONDITION_ALREADY_APPLIED ] || fail "002 twice: $r"
    r="$(apply "$db" "$g4mp_rb")"; [ "$r" = G4MP_ROLLBACK_002_PRESENT ] || fail "001 rollback under 002: $r"
    need "$db" "$g4mg_rb"
    [ "$(fn_md5 "$db" "$begin_fn") $(fn_md5 "$db" "$release_fn") $(has_table "$db") $(fence "$db")" = "6ae40adbcd203592fbc3847c57f1bccf bd5bed5adcbef4d87614613f51c83dbf f none" ] \
      || fail "002 rollback did not restore the bodies / drop the table and the fence"
    [ "$(fn_acls "$gbase")" = "$(fn_acls "$db")" ] || fail "002 rollback changed owner / ACL / settings"
    need "$db" "$g4mg"
    need "$db" "$g4mg_rb"
    need "$db" "$g4mp_rb"
    echo "ok 002 install (bodies 7d26e42e / e92ec523, owner / ACL / definer / settings unchanged: $(fn_acls "$db" | md5 -q)), table: $tbl, fence: $fen"
    echo "ok 002 twice refused, 001 rollback refused under 002, 002 rollback restores 6ae40adb / bd5bed5a and drops the table and the fence, install again, then 002 -> 001 rollback"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    need "$db" "$g4mp_rb"
    r="$(apply "$db" "$g4mg")"; [ "$r" = G4MG_PRECONDITION_001 ] || fail "002 without 001: $r"
    echo "ok 002 refused without 001 ($r)"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    q "$db" -c "do \$x\$ begin execute replace(pg_get_functiondef('$begin_fn'::regprocedure), 'end loop;', 'end loop; -- moved'); end \$x\$" > /dev/null
    r="$(apply "$db" "$g4mg")"; [ "$r" = G4MG_PRECONDITION_BEGIN_UNPINNED ] || fail "002 on another begin body: $r"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    q "$db" -c "do \$x\$ begin execute replace(pg_get_functiondef('$release_fn'::regprocedure), 'v_token := null;', 'v_token := null; -- moved'); end \$x\$" > /dev/null
    r2="$(apply "$db" "$g4mg")"; [ "$r2" = G4MG_PRECONDITION_RELEASE_UNPINNED ] || fail "002 on another release body: $r2"
    echo "ok 002 refused on unpinned bodies ($r / $r2)"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    q "$db" -c "$synth_true" > /dev/null
    r="$(apply "$db" "$g4mg")"; [ "$r" = G4MG_PRECONDITION_VERDICT_UNPINNED ] || fail "002 on a constant-true verdict: $r"
    [ "$(has_table "$db") $(fn_md5 "$db" "$release_fn")" = "f bd5bed5adcbef4d87614613f51c83dbf" ] || fail "002 changed something on a drifted verdict"
    echo "ok 002 refused on a constant-true verdict ($r, nothing changed)"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    r="$({ "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$g4mg" 2>&1 || true; } | sed -n 's/^.*ERROR: *//p' | head -1)"
    [ "$r" = G4MG_PRECONDITION_OWNER ] || fail "002 as a superuser: $r"
    echo "ok 002 refused as a superuser ($r)"
    # partial states: the table alone (a half-made install) / the bodies without the table -> refused, never completed
    db="$(copy "g4mg$RANDOM" "$gbase")"
    q "$db" -c "create table public.threads_manual_publish_attempt_generations (attempt_id uuid primary key)" > /dev/null
    r="$(apply "$db" "$g4mg")"; [ "$r" = G4MG_PRECONDITION_ALREADY_APPLIED ] || fail "002 on a lone table: $r"
    r2="$(apply "$db" "$g4mg_rb")"; [ "$r2" = G4MG_ROLLBACK_NOT_APPLIED ] || fail "002 rollback on a lone table: $r2"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    need "$db" "$g4mg"
    q "$db" -c "drop table public.threads_manual_publish_attempt_generations" > /dev/null
    r3="$(apply "$db" "$g4mg")"; [ "$r3" = G4MG_PRECONDITION_ALREADY_APPLIED ] || fail "002 on bodies + fence without the table: $r3"
    r4="$(apply "$db" "$g4mg_rb")"; [ "$r4" = G4MG_ROLLBACK_NOT_APPLIED ] || fail "002 rollback on bodies without the table: $r4"
    echo "ok partial states refused: lone table ($r / $r2), bodies + fence without the table ($r3 / $r4)"
    # G4-02 #13: the fence alone / 002 without its trigger -> refused both ways
    db="$(copy "g4mg$RANDOM" "$gbase")"
    q "$db" -c "create function postona_threads_binding.manual_publish_send_fence() returns trigger language plpgsql as \$x\$ begin return new; end \$x\$" > /dev/null
    r="$(apply "$db" "$g4mg")"; [ "$r" = G4MG_PRECONDITION_ALREADY_APPLIED ] || fail "002 on a lone fence: $r"
    r2="$(apply "$db" "$g4mg_rb")"; [ "$r2" = G4MG_ROLLBACK_NOT_APPLIED ] || fail "002 rollback on a lone fence: $r2"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    need "$db" "$g4mg"
    q "$db" -c "drop trigger threads_manual_publish_send_fence on postona_threads_binding.bindings" > /dev/null
    r3="$(apply "$db" "$g4mg")"; [ "$r3" = G4MG_PRECONDITION_ALREADY_APPLIED ] || fail "002 without its trigger: $r3"
    r4="$(apply "$db" "$g4mg_rb")"; [ "$r4" = G4MG_ROLLBACK_NOT_APPLIED ] || fail "002 rollback without its trigger: $r4"
    echo "ok partial fence states refused: lone fence ($r / $r2), 002 without its trigger ($r3 / $r4)"
    # G4-02 #13 (H1 #41 P3): 001's rollback on a PARTIAL 002 is refused before anything changes
    md5s() { q "$1" -c "select string_agg(md5(prosrc), ' ' order by oid) from pg_proc where oid in ('public.threads_manual_publish_authorize(uuid,text,boolean)'::regprocedure, '$begin_fn'::regprocedure, '$release_fn'::regprocedure)"; }
    for partial in "drop table public.threads_manual_publish_attempt_generations" \
                   "drop table public.threads_manual_publish_attempt_generations; drop trigger threads_manual_publish_send_fence on postona_threads_binding.bindings; drop function postona_threads_binding.manual_publish_send_fence()" \
                   "drop table public.threads_manual_publish_attempt_generations; drop trigger threads_manual_publish_send_fence on postona_threads_binding.bindings"; do
      db="$(copy "g4mg$RANDOM" "$gbase")"
      need "$db" "$g4mg"
      q "$db" -c "$partial" > /dev/null
      m0="$(md5s "$db") $(fence "$db")"
      r="$(apply "$db" "$g4mp_rb")"; [ "$r" = G4MP_ROLLBACK_002_PARTIAL ] || fail "001 rollback on a partial 002 ($partial): $r"
      [ "$(md5s "$db") $(fence "$db")" = "$m0" ] || fail "001 rollback changed something on a partial 002 ($partial)"
      echo "ok 001 rollback refused on a partial 002 [$partial] ($r; authorize / begin / release + fence unchanged: $(md5s "$db" | tr ' ' '/'))"
    done
    db="$(copy "g4mg$RANDOM" "$gbase")"
    q "$db" -c "create function postona_threads_binding.manual_publish_send_fence() returns trigger language plpgsql as \$x\$ begin return new; end \$x\$" > /dev/null
    r="$(apply "$db" "$g4mp_rb")"; [ "$r" = G4MP_ROLLBACK_002_PARTIAL ] || fail "001 rollback with a lone fence: $r"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    q "$db" -c "do \$x\$ begin execute replace(pg_get_functiondef('$begin_fn'::regprocedure), 'end loop;', 'end loop; -- moved'); end \$x\$" > /dev/null
    m0="$(md5s "$db")"
    r2="$(apply "$db" "$g4mp_rb")"; [ "$r2" = G4MP_ROLLBACK_STACK_UNKNOWN ] || fail "001 rollback on an unknown begin body: $r2"
    [ "$(md5s "$db")" = "$m0" ] || fail "001 rollback changed something on an unknown stack"
    echo "ok 001 rollback refused with a lone fence ($r) and on an unknown begin body ($r2), nothing changed"
    # one transaction: a failing postcondition leaves nothing behind
    sed "s/is distinct from 'e92ec523bb1a7a3ba7ca53dce744fb82' then/is distinct from 'ffffffffffffffffffffffffffffffff' then/" "$g4mg" > "$tree/g4mg_broken_post.sql"
    [ "$(grep -c ffffffffffffffffffffffffffffffff "$tree/g4mg_broken_post.sql")" = 1 ] || fail "broken-postcondition copy not made"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    r="$(apply "$db" "$tree/g4mg_broken_post.sql")"; [ "$r" = G4MG_POSTCONDITION_BODY ] || fail "broken postcondition: $r"
    [ "$(has_table "$db") $(fn_md5 "$db" "$begin_fn") $(fn_md5 "$db" "$release_fn") $(fence "$db")" = "f 6ae40adbcd203592fbc3847c57f1bccf bd5bed5adcbef4d87614613f51c83dbf none" ] \
      || fail "a failed 002 left something behind"
    echo "ok a failed postcondition rolls the whole 002 back ($r: no table, no fence, both bodies original)"
    sed "s/= '4992a4a16baad53a9eb17c3cfb71a3f6'\$/= 'ffffffffffffffffffffffffffffffff'/" "$g4mg" > "$tree/g4mg_broken_fence.sql"
    [ "$(grep -c "= 'ffffffffffffffffffffffffffffffff'" "$tree/g4mg_broken_fence.sql")" = 1 ] || fail "broken-fence copy not made"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    r="$(apply "$db" "$tree/g4mg_broken_fence.sql")"; [ "$r" = G4MG_POSTCONDITION_FENCE ] || fail "broken fence postcondition: $r"
    [ "$(has_table "$db") $(fence "$db")" = "f none" ] || fail "a failed fence postcondition left something behind"
    echo "ok a failed fence postcondition rolls the whole 002 back ($r)"
    # (c) mutants (the postcondition's expected md5 follows the mutant body so that it installs)
    make_mutant() { # name old new
      sed -e "s/is distinct from 'e92ec523bb1a7a3ba7ca53dce744fb82' then/is distinct from (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = v_release) then/" \
          -e "$2" "$g4mg" > "$tree/g4mg_mutant_$1.sql"
      [ "$(grep -c MUTANT "$tree/g4mg_mutant_$1.sql")" = 1 ] || fail "mutant $1 not made"
    }
    make_mutant no_binding_lock 's/^    perform 1 from postona_threads_binding.bindings b where b.social_account_id = v_row.social_account_id for share;$/    null; -- MUTANT/'
    make_mutant no_generation_compare 's/^    if v_bound is null or v_verified is distinct from true or v_generation is distinct from v_bound then$/    if v_bound is null or v_verified is distinct from true then -- MUTANT/'
    make_mutant gates_readbacks "s/^  if p_step in ('create_container', 'check_container', 'publish') then\$/  if true then -- MUTANT/"
    # G4-02 #14: gates_readbacks is caught by 30 (a read-back under a connection error); 31 (d) no longer reconnects while the
    # outcome is unknown (the fence refuses it), so the generation does not move there and the mutant cannot show in 31
    for m in no_binding_lock:32 no_generation_compare:31 gates_readbacks:30; do
      name="${m%%:*}"; expect="${m##*:}"
      mut_db="$(mvp_world "appmg$RANDOM")"
      for f in "$g5pv" "${stack_before_g4mg[@]}" "$tree/g4mg_mutant_$name.sql"; do need "$mut_db" "$f"; done
      if flow_run personal "$mut_db"; then fail "the e2e passed with mutant $name"; fi
      grep -E "^not ok $expect " <<<"$out" > /dev/null || { echo "$out"; fail "mutant $name did not fail scenario $expect"; }
      echo "MUTANT_CAUGHT $name by: $(grep -E '^not ok' <<<"$out" | cut -c1-90 | paste -sd ';' -) | $(grep -E "^# measured $expect" <<<"$out" | cut -c1-300)"
    done
    echo "== G4-02 #13 send onset vs reconnect (002's send fence + the Edge's start window) and 001's rollback on a partial 002"
    # (d) fail-before: PR #650's 002 exactly as H1 #41 reviewed it (no fence) fails scenarios 31 (G4-02 #14: (d), a reconnect
    #     while the outcome is unknown) and 33, and nothing else
    git -C "$repo" show 141d44fdf704bd0877a2976e9cf2c5d6dd8694f4:supabase/candidates/postona_g4_threads_manual_publish_verdict/002_manual_publish_attempt_credential_generation.sql > "$tree/g4mg_pr650.sql"
    [ "$(md5 -q "$tree/g4mg_pr650.sql")" != "$(md5 -q "$g4mg")" ] && ! grep -q manual_publish_send_fence "$tree/g4mg_pr650.sql" || fail "PR #650's 002 not extracted"
    pr650_db="$(mvp_world appsf650)"
    for f in "$g5pv" "${stack_before_g4mg[@]}" "$tree/g4mg_pr650.sql"; do need "$pr650_db" "$f"; done
    if flow_run personal "$pr650_db"; then fail "the e2e passed with PR #650's 002 (no send fence)"; fi
    [ "$(grep -E '^not ok' <<<"$out" | cut -d' ' -f3 | paste -sd ' ' -)" = "31 33" ] || { echo "$out"; fail "with PR #650's 002: expected only scenarios 31 33 to fail"; }
    echo "FAIL_BEFORE with PR #650's 002: $(grep -E '^# measured 33' <<<"$out" | cut -c1-1200)"
    # (e) mutants of the fence (its md5 pin follows the mutant body so that it installs); each must fail exactly its scenarios
    make_fence_mutant() { # name sed-expression [extra sed-expression]
      sed -e "s/= '4992a4a16baad53a9eb17c3cfb71a3f6'\$/= pg_catalog.md5(p.prosrc)/" -e "$2" ${3:+-e "$3"} "$g4mg" > "$tree/g4sf_mutant_$1.sql"
      [ "$(grep -c MUTANT "$tree/g4sf_mutant_$1.sql")" = 1 ] || fail "fence mutant $1 not made"
    }
    make_fence_mutant insert_only 's/^  before insert or update on postona_threads_binding.bindings$/  before insert on postona_threads_binding.bindings -- MUTANT/' 's/and t.tgtype = 23 and/and t.tgtype = 7 and/'
    make_fence_mutant publishing_only "s/^                and t.status in ('publishing', 'uncertain')) then\$/                and t.status = 'publishing') then -- MUTANT/"
    make_fence_mutant no_isolation_guard "s/^  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then\$/  if false then -- MUTANT/"
    # insert_only: the completion's INSERT ... ON CONFLICT DO UPDATE fires the BEFORE INSERT trigger before the conflict check,
    # so the app's reconnects are still refused; only a plain UPDATE of the binding (33 (e)) shows the mutant
    for m in "insert_only:33" "publishing_only:31 33" "no_isolation_guard:33"; do
      name="${m%%:*}"; expect="${m##*:}"
      mut_db="$(mvp_world "appsf$RANDOM")"
      for f in "$g5pv" "${stack_before_g4mg[@]}" "$tree/g4sf_mutant_$name.sql"; do need "$mut_db" "$f"; done
      if flow_run personal "$mut_db"; then fail "the e2e passed with fence mutant $name"; fi
      [ "$(grep -E '^not ok' <<<"$out" | cut -d' ' -f3 | paste -sd ' ' -)" = "$expect" ] || { echo "$out"; fail "fence mutant $name: expected only scenarios $expect to fail"; }
      echo "MUTANT_CAUGHT fence_$name by: $(grep -E '^not ok' <<<"$out" | cut -c1-90 | paste -sd ';' -) | $(grep -E '^# +(AssertionError|Expected|actual|expected|\(.\))' <<<"$out" | head -3 | cut -c1-160 | paste -sd ';' -)"
    done
    echo "== G4-02 #14 the send lease is a recorded state (no clock) and 002's rollback refuses a drifted fence / trigger / table"
    # (f) fail-before: #13's 002 exactly as H1 #42 reviewed it (PR #651 @ aed29e94: the lease lapses after 120 s on the
    #     database's clock) fails scenario 33 ((d) H1 #42: a reconnect committed while only the database's clock was ahead, then
    #     the old attempt posted) and 31 ((d) a reconnect while the outcome is unknown), and nothing else
    git -C "$repo" show aed29e945d679476085c8a0664f2394c56a61baf:supabase/candidates/postona_g4_threads_manual_publish_verdict/002_manual_publish_attempt_credential_generation.sql > "$tree/g4mg_pr651.sql"
    grep -q "interval '120 seconds') then" "$tree/g4mg_pr651.sql" && [ "$(md5 -q "$tree/g4mg_pr651.sql")" != "$(md5 -q "$g4mg")" ] || fail "#13's 002 not extracted"
    pr651_db="$(mvp_world appsf651)"
    for f in "$g5pv" "${stack_before_g4mg[@]}" "$tree/g4mg_pr651.sql"; do need "$pr651_db" "$f"; done
    if flow_run personal "$pr651_db"; then fail "the e2e passed with #13's 002 (a lease on the database's clock)"; fi
    [ "$(grep -E '^not ok' <<<"$out" | cut -d' ' -f3 | paste -sd ' ' -)" = "31 33" ] || { echo "$out"; fail "with #13's 002: expected only scenarios 31 33 to fail"; }
    echo "FAIL_BEFORE with #13's 002: $(grep -E '^# measured 33' <<<"$out" | cut -c1-1400)"
    echo "FAIL_BEFORE with #13's 002: $(grep -E '^# measured 31' <<<"$out" | cut -c1-600)"
    # (g) H1 #42 P3: 002's rollback refuses a fence / trigger / table that is not as 002 left it, before ANY change
    shape() { q "$1" -c "select concat_ws(' ',
        (select string_agg(md5(prosrc), '/' order by oid) from pg_proc where oid in ('$begin_fn'::regprocedure, '$release_fn'::regprocedure)),
        (select string_agg(md5(p.prosrc) || ':' || p.proowner || ':' || coalesce(p.proacl::text, '-') || ':' || p.prosecdef || ':' || p.provolatile::text || ':' || coalesce(p.proconfig::text, '-'), ',')
           from pg_proc p where p.proname = 'manual_publish_send_fence'),
        (select string_agg(t.tgname || ':' || t.tgtype || ':' || t.tgenabled::text || ':' || t.tgattr::text || ':' || coalesce(pg_get_expr(t.tgqual, t.tgrelid), '-'), ',' order by t.tgname)
           from pg_trigger t where t.tgrelid = 'postona_threads_binding.bindings'::regclass and not t.tgisinternal),
        (select relrowsecurity || ':' || coalesce(relacl::text, '-') || ':' || (select count(*) from pg_policy where polrelid = c.oid)
           from pg_class c where c.oid = to_regclass('public.threads_manual_publish_attempt_generations')))"; }
    fence_fn="postona_threads_binding.manual_publish_send_fence()"
    for drift in "FENCE:alter table postona_threads_binding.bindings disable trigger threads_manual_publish_send_fence" \
                 "FENCE:alter table postona_threads_binding.bindings enable replica trigger threads_manual_publish_send_fence" \
                 "FENCE:alter table postona_threads_binding.bindings enable always trigger threads_manual_publish_send_fence" \
                 "FENCE:drop trigger threads_manual_publish_send_fence on postona_threads_binding.bindings; create trigger threads_manual_publish_send_fence before update of oauth_state_id on postona_threads_binding.bindings for each row execute function $fence_fn" \
                 "FENCE:drop trigger threads_manual_publish_send_fence on postona_threads_binding.bindings; create trigger threads_manual_publish_send_fence before insert or update on postona_threads_binding.bindings for each row when (false) execute function $fence_fn" \
                 "FENCE:drop trigger threads_manual_publish_send_fence on postona_threads_binding.bindings; create trigger threads_manual_publish_send_fence after insert or update on postona_threads_binding.bindings for each row execute function $fence_fn" \
                 "FENCE:create trigger threads_manual_publish_send_fence_2 before update on postona_threads_binding.bindings for each row execute function $fence_fn" \
                 "FENCE:alter function $fence_fn security invoker" \
                 "FENCE:alter function $fence_fn reset search_path" \
                 "FENCE:alter function $fence_fn stable" \
                 "FENCE:grant execute on function $fence_fn to authenticated" \
                 "FENCE:do \$x\$ begin execute replace(pg_get_functiondef('$fence_fn'::regprocedure), '''uncertain''', '''failed'''); end \$x\$" \
                 "TABLE:grant select on public.threads_manual_publish_attempt_generations to authenticated" \
                 "TABLE:alter table public.threads_manual_publish_attempt_generations disable row level security" \
                 "TABLE:create policy g4mg_drift on public.threads_manual_publish_attempt_generations for select using (true)"; do
      kind="${drift%%:*}"; sql="${drift#*:}"
      db="$(copy "g4mg$RANDOM" "$gbase")"
      need "$db" "$g4mg"
      q "$db" -c "$sql" > /dev/null
      s0="$(shape "$db")"
      r="$(apply "$db" "$g4mg_rb")"; [ "$r" = "G4MG_ROLLBACK_${kind}_DRIFT" ] || fail "002 rollback on a drifted $kind [$sql]: $r"
      [ "$(shape "$db")" = "$s0" ] || fail "002 rollback changed something on a drifted $kind [$sql]"
      echo "ok 002 rollback refused on a drifted $kind ($r, nothing changed) [${sql:0:110}]"
    done
    # the shape check is the install's own: a drifted install postcondition copy is refused too (a trigger created disabled)
    perl -pe 's/^(  for each row execute function postona_threads_binding\.manual_publish_send_fence\(\);)$/$1\nalter table postona_threads_binding.bindings disable trigger threads_manual_publish_send_fence; -- MUTANT/' "$g4mg" > "$tree/g4mg_disabled.sql"
    [ "$(grep -c MUTANT "$tree/g4mg_disabled.sql")" = 1 ] || fail "disabled-trigger install copy not made"
    db="$(copy "g4mg$RANDOM" "$gbase")"
    r="$(apply "$db" "$tree/g4mg_disabled.sql")"; [ "$r" = G4MG_POSTCONDITION_FENCE ] || fail "002 installing a disabled trigger: $r"
    [ "$(has_table "$db") $(fence "$db")" = "f none" ] || fail "a refused 002 left something behind"
    echo "ok 002 install refused when its trigger would be disabled ($r, nothing left)"
    # the normal path still removes every candidate object: 002 -> rollback -> 001 rollback
    db="$(copy "g4mg$RANDOM" "$gbase")"
    need "$db" "$g4mg"
    need "$db" "$g4mg_rb"
    need "$db" "$g4mp_rb"
    [ "$(has_table "$db") $(fence "$db") $(q "$db" -c "select count(*) from pg_trigger where tgname like 'threads_manual_publish_send_fence%'")" = "f none 0" ] || fail "002 -> 001 rollback left a candidate object"
    echo "ok 002 rollback -> 001 rollback leaves no table / fence / trigger"
  fi
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
