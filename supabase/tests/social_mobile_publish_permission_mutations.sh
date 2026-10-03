#!/usr/bin/env bash
# Defect-detection proof for social_mobile_publish_permission_run.sh. Each
# mutation breaks exactly one safety property in a COPY of the candidate, runs
# the full runner against that copy, and requires the runner to fail at the
# check that guards that property: every mutation names the failure it must
# produce, never a generic one. The real file is never edited.
# Disposable local PostgreSQL only; same environment as the runner, plus python3.
# Usage: PUB_PGHOST=... PUB_PGPORT=... PUB_PGSUPER=... [PUB_JOBS=4] \
#        supabase/tests/social_mobile_publish_permission_mutations.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
candidate="$here/../migrations/20261003090000_social_mobile_publish_permission_boundary.sql"
jobs="${PUB_JOBS:-4}"
tmp="$(mktemp -d /private/tmp/kabumori-publish-permission-mutations.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

labels=(); olds=(); news=(); expects=()
mutation() { labels+=("$1"); olds+=("$2"); news+=("$3"); expects+=("$4"); }

# --- R1: authorization bound to the write ------------------------------------------
mutation "the caller's membership is read but not locked" \
  "    where bm.brand_id = v_brand_id and bm.user_id = v_user for share;" \
  "    where bm.brand_id = v_brand_id and bm.user_id = v_user;" \
  "FAIL R1a membership removed before the write"
mutation "member may switch publishing" \
  "v_role not in ('owner', 'admin')" \
  "v_role not in ('owner', 'admin', 'member')" \
  "FAIL viewer and member are refused for every request and learn no state"
mutation "a non-member proceeds to the locking phase" \
  $'  if not found or not exists (\n    select 1 from public.brand_memberships bm where bm.brand_id = v_brand_id and bm.user_id = v_user\n  ) then' \
  "  if not found then" \
  "FAIL foreign caller waited on another tenant's locks"
# --- R2: brand state bound to ON ----------------------------------------------------
mutation "the brand row is read but not locked" \
  "    select b.* into v_brand from public.brands b where b.id = v_brand_id for share;" \
  "    select b.* into v_brand from public.brands b where b.id = v_brand_id;" \
  "FAIL R1c: a permission-changing writer was not blocked by the switch: update public.brands"
mutation "ON does not require an active brand" \
  $'        when v_brand.is_active is distinct from true then \'BRAND_INACTIVE\'\n' \
  "" \
  "FAIL ON with brand inactive"
mutation "ON does not require a live brand" \
  $'        when v_brand.publish_mode is distinct from \'live\' then \'BRAND_PUBLISHING_NOT_LIVE\'\n' \
  "" \
  "FAIL ON with brand publish_mode disabled"
mutation "the pre-send check ignores an inactive brand" \
  $'      when b.is_active is distinct from true then \'BRAND_DISABLED\'\n' \
  "" \
  "FAIL runtime with brand inactive"
mutation "the pre-send check ignores the publish mode" \
  $'      when b.publish_mode is distinct from \'live\' then \'BRAND_PUBLISH_MODE_DISABLED\'\n' \
  "" \
  "FAIL runtime with brand publish_mode disabled"
mutation "the pre-send check ignores an account deletion" \
  $'      when exists (select 1 from public.social_mobile_account_deletions d where d.workspace_id = sa.brand_id)\n        then \'SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS\'\n' \
  "" \
  "FAIL no send is authorized during account deletion"
mutation "the pre-send check ignores a blocked refresh state" \
  $'      when st.status = \'uncertain\' then \'X_REFRESH_BLOCKED_UNCERTAIN\'\n' \
  "" \
  "FAIL runtime with refresh state uncertain"
# --- R3: the answer stays bound to the proven brand ----------------------------------
mutation "the account's brand is not re-checked under the lock" \
  "    if not found or v_account.brand_id is distinct from v_brand_id then" \
  "    if not found then" \
  "FAIL R3 account moved to a foreign brand"
# --- R4: ON readiness ---------------------------------------------------------------
mutation "a blank platform user id passes" \
  "          or nullif(btrim(v_account.platform_user_id), '') is null" \
  "          or v_account.platform_user_id is null" \
  "FAIL ON with platform user id empty"
mutation "verified_at is not required" \
  "          or v_account.verified_at is null then 'CONNECTION_NOT_VERIFIED'" \
  "          then 'CONNECTION_NOT_VERIFIED'" \
  "FAIL ON with verified_at missing"
mutation "the connection state is not required" \
  "        when v_account.connection_status is distinct from 'identity_verified'" \
  "        when false" \
  "FAIL ON with unconnected"
mutation "missing credential references pass" \
  $'        when v_account.vault_access_token_secret_id is null\n          or v_account.vault_refresh_token_secret_id is null then \'CREDENTIALS_MISSING\'\n' \
  "" \
  "FAIL ON with access reference missing"
mutation "identical access and refresh references pass" \
  "        when v_account.vault_access_token_secret_id = v_account.vault_refresh_token_secret_id" \
  "        when false" \
  "FAIL ON with access and refresh are the same reference"
mutation "a reference shared with another account passes" \
  "            where o.id <> v_account.id" \
  "            where false and o.id <> v_account.id" \
  "FAIL ON with a reference shared with another account"
mutation "a recorded connection error passes" \
  $'        when nullif(btrim(v_account.last_connection_error_code), \'\') is not null then \'CONNECTION_DEGRADED\'\n' \
  "" \
  "FAIL ON with connection error recorded"
mutation "a blocked refresh state passes" \
  "        if v_refresh_status in ('uncertain', 'reauth_required') then" \
  "        if false then" \
  "FAIL ON with refresh state uncertain"
mutation "ON during a held refresh lease is not busy" \
  "        elsif v_refresh_status = 'refreshing' then" \
  "        elsif false then" \
  "FAIL ON while a refresh lease is held -> busy"
# --- compare-and-set, exact mutation, OFF --------------------------------------------
mutation "the expected state is not compared" \
  "    if v_account.publish_enabled is distinct from p_expected_current_enabled then" \
  "    if false then" \
  "FAIL a stale expected value -> stale with the real value"
mutation "the switch also stamps updated_at" \
  $'    set publish_enabled = p_desired_enabled\n' \
  $'    set publish_enabled = p_desired_enabled, updated_at = now()\n' \
  "FAIL ON changed publish_enabled and nothing else"
mutation "OFF is subject to the ON prerequisites" \
  $'    if p_desired_enabled then\n      -- Same rules' \
  $'    if true then\n      -- Same rules' \
  "FAIL OFF works with a failed connection"
# --- lock order / bounded waiting / isolation ---------------------------------------
mutation "the table lock is not taken before the row locks" \
  $'    lock table public.social_accounts in row exclusive mode;\n' \
  "" \
  "FAIL lock order"
mutation "lock waits are unbounded" \
  $'set lock_timeout = \'3s\'\n' \
  "" \
  "FAIL the switch bounds its lock waits"
mutation "a snapshot isolation level is accepted" \
  "  if current_setting('transaction_isolation') <> 'read committed' then" \
  "  if false then" \
  "FAIL the switch ran under repeatable read"
# --- privileges / definition ----------------------------------------------------------
mutation "the switch is also granted to service_role" \
  "grant execute on function public.set_social_account_publish_enabled(text, boolean, boolean) to authenticated;" \
  "grant execute on function public.set_social_account_publish_enabled(text, boolean, boolean) to authenticated, service_role;" \
  "FAIL the switch is executable by authenticated only"
mutation "default PUBLIC execute is left in place" \
  "from public, anon, authenticated, service_role;" \
  "from anon, authenticated, service_role;" \
  "FAIL the switch is executable by authenticated only"
mutation "the permission check is also granted to authenticated" \
  "grant execute on function public.assert_x_publish_permission_for_legacy_post(uuid, text, text) to service_role;" \
  "grant execute on function public.assert_x_publish_permission_for_legacy_post(uuid, text, text) to service_role, authenticated;" \
  "FAIL the permission check is executable by service_role only"
mutation "the switch runs with a non-empty search_path" \
  $'set search_path = \'\'\nset lock_timeout' \
  $'set search_path = \'public\'\nset lock_timeout' \
  "FAIL both functions are SECURITY DEFINER with an empty search_path"

total="${#labels[@]}"
run_one() {
  local i="$1" work="$tmp/m$1"
  mkdir -p "$work"
  if ! python3 - "$candidate" "$work/mutant.sql" "${olds[$i]}" "${news[$i]}" <<'PY'
import sys
source, target, old, new = sys.argv[1:5]
text = open(source, encoding="utf-8").read()
if text.count(old) != 1:
    sys.exit(f"mutation site matched {text.count(old)} times")
open(target, "w", encoding="utf-8").write(text.replace(old, new))
PY
  then echo "INVALID" > "$work/result"; return; fi
  local status=0
  PUB_CANDIDATE="$work/mutant.sql" "$here/social_mobile_publish_permission_run.sh" > "$work/out" 2>&1 || status=$?
  if [[ "$status" -ne 0 ]] && grep -qF "${expects[$i]}" "$work/out"; then
    echo "DETECTED" > "$work/result"
  elif [[ "$status" -ne 0 ]]; then
    echo "WRONG_REASON" > "$work/result"
  else
    echo "SURVIVED" > "$work/result"
  fi
}

i=0
while [[ "$i" -lt "$total" ]]; do
  n=0
  while [[ "$n" -lt "$jobs" && "$i" -lt "$total" ]]; do
    run_one "$i" &
    i=$((i + 1)); n=$((n + 1))
  done
  wait
done

detected=0
for i in $(seq 0 $((total - 1))); do
  result="$(cat "$tmp/m$i/result")"
  if [[ "$result" == DETECTED ]]; then
    detected=$((detected + 1))
    echo "DETECTED  ${labels[$i]}"
  else
    echo "$result  ${labels[$i]}" >&2
    grep -E 'FAIL|ERROR|matched' "$tmp/m$i/out" 2>/dev/null | grep -v '^NOTICE' | head -3 >&2 || true
  fi
done
[[ "$detected" -eq "$total" ]] || { echo "FAIL $((total - detected)) of $total mutations were not detected as expected" >&2; exit 1; }
echo "PUBLISH_PERMISSION_MUTATIONS_ALL_DETECTED $detected/$total"
