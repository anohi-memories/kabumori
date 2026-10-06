#!/usr/bin/env bash
# Defect-detection proof for the publish-permission proofs. Each mutation
# breaks exactly one safety property in a COPY of the candidate (or of the
# rollout plan), runs the proof that guards it, and requires that proof to fail
# at the check that guards that property: every mutation names the failure it
# must produce, never a generic one. The real files are never edited.
#   sql  -> social_mobile_publish_permission_run.sh, in parallel (PUB_JOBS)
#   acl  -> social_mobile_publish_permission_acl.sh, one at a time (it changes
#           cluster-wide role memberships), after every sql mutation finished
#   plan -> social_mobile_publish_permission_rollout_test.ts against a copy of
#           social_mobile_publish_permission.md
# A mutation may change several sites at once (sites separated by \x1f) when one
# property is guarded at several places on purpose.
# Disposable local PostgreSQL only; same environment as the runners, plus python3 and deno.
# Usage: PUB_PGHOST=... PUB_PGPORT=... PUB_PGSUPER=... [PUB_JOBS=4] \
#        supabase/tests/social_mobile_publish_permission_mutations.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
candidate="$here/../migrations/20261003090000_social_mobile_publish_permission_boundary.sql"
plan_doc="$here/social_mobile_publish_permission.md"
jobs="${PUB_JOBS:-4}"
tmp="$(mktemp -d /private/tmp/kabumori-publish-permission-mutations.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
S=$'\x1f'

kinds=(); labels=(); olds=(); news=(); expects=()
mutation() { kinds+=("$1"); labels+=("$2"); olds+=("$3"); news+=("$4"); expects+=("$5"); }

# --- R1: authorization bound to the write ------------------------------------------
mutation sql "the caller's membership is read but not locked" \
  "    where bm.brand_id = v_brand_id and bm.user_id = v_user for share;" \
  "    where bm.brand_id = v_brand_id and bm.user_id = v_user;" \
  "FAIL R1a membership removed before the write"
mutation sql "member may switch publishing" \
  "v_role not in ('owner', 'admin')" \
  "v_role not in ('owner', 'admin', 'member')" \
  "FAIL viewer and member are refused for every request and learn no state"
mutation sql "a non-member proceeds to the locking phase" \
  $'  if not found or not exists (\n    select 1 from public.brand_memberships bm where bm.brand_id = v_brand_id and bm.user_id = v_user\n  ) then' \
  "  if not found then" \
  "FAIL foreign caller waited on another tenant's locks"
# --- R2: brand state bound to ON ----------------------------------------------------
mutation sql "the brand row is read but not locked" \
  "    select b.* into v_brand from public.brands b where b.id = v_brand_id for share;" \
  "    select b.* into v_brand from public.brands b where b.id = v_brand_id;" \
  "FAIL R1c: a permission-changing writer was not blocked by the switch: update public.brands"
mutation sql "ON does not require an active brand" \
  $'        when v_brand.is_active is distinct from true then \'BRAND_INACTIVE\'\n' \
  "" \
  "FAIL ON with brand inactive"
mutation sql "ON does not require a live brand" \
  $'        when v_brand.publish_mode is distinct from \'live\' then \'BRAND_PUBLISHING_NOT_LIVE\'\n' \
  "" \
  "FAIL ON with brand publish_mode disabled"
mutation sql "the pre-send check ignores an inactive brand" \
  $'      when b.is_active is distinct from true then \'BRAND_DISABLED\'\n' \
  "" \
  "FAIL runtime with brand inactive"
mutation sql "the pre-send check ignores the publish mode" \
  $'      when b.publish_mode is distinct from \'live\' then \'BRAND_PUBLISH_MODE_DISABLED\'\n' \
  "" \
  "FAIL runtime with brand publish_mode disabled"
mutation sql "the pre-send check ignores an account deletion" \
  $'      when exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id)\n        then \'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS\'\n' \
  "" \
  "FAIL no send is authorized during account deletion"
mutation sql "the pre-send check ignores a blocked refresh state" \
  $'      when st.status = \'uncertain\' then \'X_REFRESH_BLOCKED_UNCERTAIN\'\n' \
  "" \
  "FAIL runtime with refresh state uncertain"
# --- H2 F1: the pre-send check requires what ON requires, and no more ----------------
mutation sql "the pre-send check ignores a missing verified_at" \
  $'        or nullif(btrim(sa.platform_user_id), \'\') is null\n        or sa.verified_at is null then \'X_ACCOUNT_NOT_VERIFIED\'' \
  $'        or nullif(btrim(sa.platform_user_id), \'\') is null then \'X_ACCOUNT_NOT_VERIFIED\'' \
  "FAIL runtime with verified_at missing"
mutation sql "the pre-send check ignores a recorded connection error" \
  $'      when nullif(btrim(sa.last_connection_error_code), \'\') is not null then \'X_ACCOUNT_CONNECTION_DEGRADED\'\n' \
  "" \
  "FAIL runtime with connection error recorded"
mutation sql "the pre-send check treats a blank error code as an error" \
  "      when nullif(btrim(sa.last_connection_error_code), '') is not null then 'X_ACCOUNT_CONNECTION_DEGRADED'" \
  "      when sa.last_connection_error_code is not null then 'X_ACCOUNT_CONNECTION_DEGRADED'" \
  "FAIL a blank connection error code blocks neither ON nor the send"
mutation sql "the pre-send check refuses a refresh in progress" \
  $'      when st.status = \'uncertain\' then \'X_REFRESH_BLOCKED_UNCERTAIN\'\n' \
  $'      when st.status = \'refreshing\' then \'X_REFRESH_IN_PROGRESS\'\n      when st.status = \'uncertain\' then \'X_REFRESH_BLOCKED_UNCERTAIN\'\n' \
  "FAIL a refresh in progress is not a permission refusal"
# --- R3: the answer stays bound to the proven brand ----------------------------------
mutation sql "the account's brand is not re-checked under the lock" \
  "    if not found or v_account.brand_id is distinct from v_brand_id then" \
  "    if not found then" \
  "FAIL R3 account moved to a foreign brand"
# --- R4: ON readiness ---------------------------------------------------------------
mutation sql "a blank platform user id passes" \
  "          or nullif(btrim(v_account.platform_user_id), '') is null" \
  "          or v_account.platform_user_id is null" \
  "FAIL ON with platform user id empty"
mutation sql "verified_at is not required" \
  "          or v_account.verified_at is null then 'CONNECTION_NOT_VERIFIED'" \
  "          then 'CONNECTION_NOT_VERIFIED'" \
  "FAIL ON with verified_at missing"
mutation sql "the connection state is not required" \
  "        when v_account.connection_status is distinct from 'identity_verified'" \
  "        when false" \
  "FAIL ON with unconnected"
mutation sql "missing credential references pass" \
  $'        when v_account.vault_access_token_secret_id is null\n          or v_account.vault_refresh_token_secret_id is null then \'CREDENTIALS_MISSING\'\n' \
  "" \
  "FAIL ON with access reference missing"
mutation sql "identical access and refresh references pass" \
  "        when v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id" \
  "        when false" \
  "FAIL ON with access and refresh are the same reference"
mutation sql "a reference shared with another account passes" \
  "            where o.id <> v_account.id" \
  "            where false and o.id <> v_account.id" \
  "FAIL ON with a reference shared with another account"
mutation sql "a recorded connection error passes" \
  $'        when nullif(btrim(v_account.last_connection_error_code), \'\') is not null then \'CONNECTION_DEGRADED\'\n' \
  "" \
  "FAIL ON with connection error recorded"
mutation sql "a blocked refresh state passes" \
  "        if v_refresh_status in ('uncertain', 'reauth_required') then" \
  "        if false then" \
  "FAIL ON with refresh state uncertain"
mutation sql "ON during a held refresh lease is not busy" \
  "        elsif v_refresh_status = 'refreshing' then" \
  "        elsif false then" \
  "FAIL ON while a refresh lease is held -> busy"
# --- compare-and-set, exact mutation, OFF --------------------------------------------
mutation sql "the expected state is not compared" \
  "    if v_account.publish_enabled is distinct from p_expected_current_enabled then" \
  "    if false then" \
  "FAIL a stale expected value -> stale with the real value"
mutation sql "the switch also stamps updated_at" \
  $'    set publish_enabled = p_desired_enabled\n' \
  $'    set publish_enabled = p_desired_enabled, updated_at = now()\n' \
  "FAIL ON changed publish_enabled and nothing else"
mutation sql "OFF is subject to the ON prerequisites" \
  $'    if p_desired_enabled then\n      -- Same rules' \
  $'    if true then\n      -- Same rules' \
  "FAIL OFF works with a failed connection"
# --- lock order / bounded waiting / isolation ---------------------------------------
mutation sql "the table lock is not taken before the row locks" \
  $'    lock table public.social_accounts in row exclusive mode;\n' \
  "" \
  "FAIL lock order"
mutation sql "lock waits are unbounded" \
  $'set lock_timeout = \'3s\'\n' \
  "" \
  "FAIL the switch bounds its lock waits"
mutation sql "a snapshot isolation level is accepted" \
  "  if current_setting('transaction_isolation') <> 'read committed' then" \
  "  if false then" \
  "FAIL the switch ran under repeatable read"
# --- privileges / definition: now refused by the file itself, at apply ----------------
mutation sql "the switch is also granted to service_role" \
  "grant execute on function public.set_social_account_publish_enabled(text, boolean, boolean) to authenticated;" \
  "grant execute on function public.set_social_account_publish_enabled(text, boolean, boolean) to authenticated, service_role;" \
  "ERROR:  PUBLISH_PERMISSION_EFFECTIVE_ACL"
mutation sql "PUBLIC keeps the default EXECUTE (explicit revoke and clean-up both skip it)" \
  "from public, anon, authenticated, service_role;${S}    where a.grantee <> p.proowner" \
  "from anon, authenticated, service_role;${S}    where a.grantee <> p.proowner and a.grantee <> 0" \
  "ERROR:  PUBLISH_PERMISSION_EFFECTIVE_ACL"
mutation sql "the permission check is also granted to authenticated" \
  "grant execute on function public.assert_x_publish_permission_for_legacy_post(uuid, text, text) to service_role;" \
  "grant execute on function public.assert_x_publish_permission_for_legacy_post(uuid, text, text) to service_role, authenticated;" \
  "ERROR:  PUBLISH_PERMISSION_EFFECTIVE_ACL"
mutation sql "the switch runs with a non-empty search_path" \
  $'set search_path = \'\'\nset lock_timeout' \
  $'set search_path = \'public\'\nset lock_timeout' \
  "ERROR:  PUBLISH_PERMISSION_EFFECTIVE_ACL"
# --- H2 F2: exact and effective privileges under adverse role graphs (serial) --------
mutation acl "default grants are not removed from the new functions" \
  $'    execute format(\'revoke all on function %s from %s\', r.signature,\n      case when r.grantee = 0 then \'public\' else quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);\n' \
  $'    null;\n' \
  "FAIL ACL default grantee (schema)"
mutation acl "a grantable grant passes the postcondition" \
  "         and not (a.privilege_type = 'EXECUTE' and not a.is_grantable" \
  "         and not (a.privilege_type = 'EXECUTE'" \
  "FAIL ACL grantable grant"
mutation acl "direct grants are not checked" \
  "       where p.oid in (v_switch, v_check) and a.grantee <> p.proowner" \
  "       where false and p.oid in (v_switch, v_check) and a.grantee <> p.proowner" \
  "FAIL ACL grantable grant"
mutation acl "the app roles' effective privileges are not checked" \
  $'     or has_function_privilege(\'service_role\', v_switch, \'execute\') then\n    raise exception \'PUBLISH_PERMISSION_EFFECTIVE_ACL\';' \
  $'     or has_function_privilege(\'service_role\', v_switch, \'execute\') then\n    null;' \
  "FAIL ACL authenticated inherits service_role"
mutation acl "the creator is not compared with the helper's owner" \
  "is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then" \
  "is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) and false then" \
  "FAIL ACL creator is not the helper's owner"
mutation acl "a superuser creator is accepted" \
  "where r.rolname = current_user) is distinct from false then" \
  "where r.rolname = current_user) is distinct from false and false then" \
  "FAIL ACL helper owned by a superuser"
# --- H2 F3: the rollout order (the plan in the document) ------------------------------
mutation plan "the migration before the guarded runtime" \
  $'    { "id": "S1", "action": "deploy the guarded x-test-post", "set": { "runtime": ["old", "guarded"] } },\n    { "id": "S2", "action": "byte-verify the deploy; wait out older invocations; query h = 0", "set": { "runtime": ["guarded"] } },\n    { "id": "S3", "action": "apply 20261003090000 alone", "set": { "toggle": "usable", "check": "present" } },' \
  $'    { "id": "S1", "action": "apply 20261003090000 alone", "set": { "toggle": "usable", "check": "present" } },\n    { "id": "S2", "action": "deploy the guarded x-test-post", "set": { "runtime": ["old", "guarded"] } },\n    { "id": "S3", "action": "byte-verify the deploy; wait out older invocations; query h = 0", "set": { "runtime": ["guarded"] } },' \
  "forward: every state fails closed; old runtime and a usable switch never coexist =>"
mutation plan "older invocations are not drained before the migration" \
  '{ "id": "S2", "action": "byte-verify the deploy; wait out older invocations; query h = 0", "set": { "runtime": ["guarded"] } },' \
  '{ "id": "S2", "action": "byte-verify the deploy; wait out older invocations; query h = 0", "set": {} },' \
  "forward: every state fails closed; old runtime and a usable switch never coexist =>"
mutation plan "an abort rolls the runtime back before the switch is revoked" \
  $'      { "id": "B1", "action": "revoke the switch from authenticated", "set": { "toggle": "revoked" } },\n      { "id": "B2", "action": "revoke the check from service_role (guarded runtime fails closed)", "set": { "check": "revoked" } },\n      { "id": "B3", "action": "redeploy the previous x-test-post", "set": { "runtime": ["guarded", "old"] } },' \
  $'      { "id": "B3", "action": "redeploy the previous x-test-post", "set": { "runtime": ["guarded", "old"] } },\n      { "id": "B1", "action": "revoke the switch from authenticated", "set": { "toggle": "revoked" } },\n      { "id": "B2", "action": "revoke the check from service_role (guarded runtime fails closed)", "set": { "check": "revoked" } },' \
  "abort: every step after the preflight has an explicit abort path, and every state on it fails closed =>"
mutation plan "the Edge function is deployed before the read-back" \
  $'    { "id": "S4", "action": "read back definitions, direct ACL, effective privileges (i, j)", "set": {} },\n    { "id": "S5", "action": "deploy social-mobile-publish-setting with JWT verification on", "set": { "edge": "deployed" } },' \
  $'    { "id": "S5", "action": "deploy social-mobile-publish-setting with JWT verification on", "set": { "edge": "deployed" } },\n    { "id": "S4", "action": "read back definitions, direct ACL, effective privileges (i, j)", "set": {} },' \
  "forward order: guarded runtime only and the check in place before the switch; the Edge function and the app control last =>"
mutation plan "no abort path right after the migration" \
  '{ "from": ["S3", "S4"], "steps": [' \
  '{ "from": ["S4"], "steps": [' \
  "abort: every step after the preflight has an explicit abort path, and every state on it fails closed =>"

total="${#labels[@]}"
make_copy() { # source target olds news
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import sys
source, target, olds, news = sys.argv[1:5]
text = open(source, encoding="utf-8").read()
olds, news = olds.split("\x1f"), news.split("\x1f")
if len(olds) != len(news):
    sys.exit("mutation sites and replacements differ in number")
for old, new in zip(olds, news):
    if text.count(old) != 1:
        sys.exit(f"mutation site matched {text.count(old)} times")
    text = text.replace(old, new)
open(target, "w", encoding="utf-8").write(text)
PY
}
run_one() {
  local i="$1" work="$tmp/m$1" status=0
  mkdir -p "$work"
  case "${kinds[$i]}" in
    plan)
      if ! make_copy "$plan_doc" "$work/plan.md" "${olds[$i]}" "${news[$i]}"; then echo "INVALID" > "$work/result"; return; fi
      PUB_ROLLOUT_DOC="$work/plan.md" NO_COLOR=1 DENO_NO_PACKAGE_JSON=1 \
        deno test --no-config --allow-read --allow-env "$here/social_mobile_publish_permission_rollout_test.ts" > "$work/out" 2>&1 || status=$?
      ;;
    *)
      if ! make_copy "$candidate" "$work/mutant.sql" "${olds[$i]}" "${news[$i]}"; then echo "INVALID" > "$work/result"; return; fi
      local runner="$here/social_mobile_publish_permission_run.sh"
      [[ "${kinds[$i]}" == acl ]] && runner="$here/social_mobile_publish_permission_acl.sh"
      PUB_CANDIDATE="$work/mutant.sql" "$runner" > "$work/out" 2>&1 || status=$?
      ;;
  esac
  if [[ "$status" -ne 0 ]] && grep -qF -- "${expects[$i]}" "$work/out"; then
    echo "DETECTED" > "$work/result"
  elif [[ "$status" -ne 0 ]]; then
    echo "WRONG_REASON" > "$work/result"
  else
    echo "SURVIVED" > "$work/result"
  fi
}

# sql and plan mutations in parallel batches; acl mutations afterwards, one at a time.
parallel=(); serial=()
for i in $(seq 0 $((total - 1))); do
  if [[ "${kinds[$i]}" == acl ]]; then serial+=("$i"); else parallel+=("$i"); fi
done
k=0
while [[ "$k" -lt "${#parallel[@]}" ]]; do
  n=0
  while [[ "$n" -lt "$jobs" && "$k" -lt "${#parallel[@]}" ]]; do
    run_one "${parallel[$k]}" &
    k=$((k + 1)); n=$((n + 1))
  done
  wait
done
for i in "${serial[@]}"; do run_one "$i"; done

detected=0
for i in $(seq 0 $((total - 1))); do
  result="$(cat "$tmp/m$i/result")"
  if [[ "$result" == DETECTED ]]; then
    detected=$((detected + 1))
    echo "DETECTED  [${kinds[$i]}] ${labels[$i]}"
  else
    echo "$result  [${kinds[$i]}] ${labels[$i]}" >&2
    grep -E 'FAIL|ERROR|matched|=>' "$tmp/m$i/out" 2>/dev/null | grep -v '^NOTICE' | head -3 >&2 || true
  fi
done
[[ "$detected" -eq "$total" ]] || { echo "FAIL $((total - detected)) of $total mutations were not detected as expected" >&2; exit 1; }
echo "PUBLISH_PERMISSION_MUTATIONS_ALL_DETECTED $detected/$total"
