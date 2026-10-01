#!/usr/bin/env bash
# Defect-detection proof for common_account_lifecycle_run.sh. Each mutation
# breaks exactly one safety property in a COPY of the candidate (or of the
# rollback), runs the full runner against that copy, and requires the runner to
# fail at the check that guards the property. The real files are never edited.
# Disposable local PostgreSQL only; same environment as the runner, plus python3.
# Usage: CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... [CAL_JOBS=4] \
#        supabase/tests/common_account_lifecycle_mutations.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
candidate="$here/../migrations/20261001150000_common_account_lifecycle_foundation.sql"
rollback="$here/common_account_lifecycle_rollback.sql"
jobs="${CAL_JOBS:-4}"
tmp="$(mktemp -d /private/tmp/kabumori-common-account-mutations.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

labels=(); targets=(); olds=(); news=(); expects=()
mutation() { labels+=("$1"); targets+=("$2"); olds+=("$3"); news+=("$4"); expects+=("$5"); }

# --- H1 counterexample 1: no login deletion, no false completion -------------
mutation "prepare deletes the login itself" candidate \
  $'  update private.account_lifecycle_operations\n     set current_step = \'ready_for_managed_auth_delete\', ready_at = now()' \
  $'  delete from auth.users where id = p_user_id;\n  update private.account_lifecycle_operations\n     set current_step = \'ready_for_managed_auth_delete\', ready_at = now()' \
  "FAIL the candidate writes to a managed schema"
mutation "an account deletion may be recorded as completed" candidate \
  "  check (status <> 'completed' or operation_type = 'service_deletion')," \
  "" \
  "FAIL H1-1: an account deletion cannot be recorded as completed at all"
mutation "prepare ignores visible Storage ownership" candidate \
  "  v_managed := private.account_lifecycle_managed_ownership(p_user_id);" \
  "  v_managed := '{}';" \
  "FAIL H1-1: with a Storage object still owned"
mutation "prepare ignores the managed checkpoints" candidate \
  "  v_missing := array(select k from unnest(v_required) k where not v_operation.checkpoints ? k order by k);" \
  "  v_missing := '{}';" \
  "FAIL not ready until the managed cleanups are attested"
mutation "an unreadable Storage shape is treated as clean" candidate \
  "      return array['MANAGED_STORAGE_SHAPE_UNKNOWN'];" \
  "      return '{}'::text[];" \
  "FAIL unknown Storage shape fails closed"
# --- H1 counterexample 2: preview / version --------------------------------------
mutation "an entitlement change does not move the version" candidate \
  $'create trigger account_lifecycle_touch_entitlement\n  after insert or update or delete on public.service_entitlements' \
  $'create trigger account_lifecycle_touch_entitlement\n  after delete on public.service_entitlements' \
  "FAIL every backfilled entitlement moved its account version"
mutation "an absent account previews as version 1" candidate \
  "    'lifecycle_version', coalesce(v_account.lifecycle_version, 0)," \
  "    'lifecycle_version', coalesce(v_account.lifecycle_version, 1)," \
  "FAIL an absent account previews as version 0"
mutation "the confirmed version is not checked" candidate \
  "  if p_expected_lifecycle_version is distinct from v_version then" \
  "  if false then" \
  "FAIL H1-2: the empty preview"
mutation "a row created concurrently is accepted for an absent preview" candidate \
  "    if v_account.lifecycle_version <> 1 or v_account.status <> 'active' or exists (" \
  "    if false and exists (" \
  "FAIL race1 absent preview accepted"
# --- H1 counterexample 3: backfill serialization ---------------------------------
mutation "backfill does not take the lifecycle lock" candidate \
  "        v_account := private.account_lifecycle_lock(v_user, true);" \
  "        insert into public.common_accounts (user_id) values (v_user) on conflict (user_id) do nothing; select * into v_account from public.common_accounts c where c.user_id = v_user;" \
  "FAIL timed out waiting for: race10 hold blocked behind the backfill"
mutation "backfill grants to an account that is not active" candidate \
  $'      if v_account.status <> \'active\' then\n        if (v_plan.kabumori_candidate' \
  $'      if false then\n        if (v_plan.kabumori_candidate' \
  "FAIL backfill skips a non-active account"
# --- H1 counterexample 4: admin exclusion ----------------------------------------
mutation "an admin workspace owner is an X backfill candidate" candidate \
  "       x.user_id is not null and not x.is_admin as x_candidate," \
  "       x.user_id is not null as x_candidate," \
  "FAIL dry-run with exclusions"
# --- H1 counterexample 5: exact preflight ----------------------------------------
mutation "preflight does not bind the referencing column" candidate \
  $'             = array(select jsonb_array_elements_text(v_spec -> \'c\'))' \
  $'             is not null' \
  "FAIL preflight accepted: foreign key on the wrong column"
mutation "preflight does not check the delete action" candidate \
  "         and c.confdeltype::text = v_spec ->> 'del'" \
  "" \
  "FAIL preflight accepted: foreign key with another delete action"
mutation "preflight accepts a deferrable or unvalidated key" candidate \
  $'         and c.convalidated\n         and not c.condeferrable' \
  "" \
  "FAIL preflight accepted: deferrable foreign key"
# --- H1 counterexample 6: rollback needs an affirmed shadow state ------------------
# The original defect: "refuse only if a row says otherwise".
mutation "rollback treats a missing settings row as safe" rollback \
  $'  if (select count(*) from private.account_lifecycle_settings) <> 1 then\n    raise exception \'COMMON_ACCOUNT_ROLLBACK_REFUSED_SETTINGS_NOT_AFFIRMED\';\n  end if;\n  if (select auth_delete_guard from private.account_lifecycle_settings) is distinct from \'shadow\' then\n    raise exception \'COMMON_ACCOUNT_ROLLBACK_REFUSED_GUARD_ENFORCING\';\n  end if;\n  if (select integration_state from private.account_lifecycle_settings) is distinct from \'not_started\' then' \
  $'  if exists (select 1 from private.account_lifecycle_settings where auth_delete_guard <> \'shadow\') then\n    raise exception \'COMMON_ACCOUNT_ROLLBACK_REFUSED_GUARD_ENFORCING\';\n  end if;\n  if exists (select 1 from private.account_lifecycle_settings where integration_state <> \'not_started\') then' \
  "FAIL rollback ran: missing settings row"
mutation "rollback ignores that integration started" rollback \
  "  if (select integration_state from private.account_lifecycle_settings) is distinct from 'not_started' then" \
  "  if false then" \
  "FAIL rollback ran: integration started"
# --- Lifecycle serialization (accepted properties that must stay) ------------------
mutation "the readiness check takes a shared login lock" candidate \
  "  v_account := private.account_lifecycle_lock(p_user_id, false, true);" \
  "  v_account := private.account_lifecycle_lock(p_user_id, false, false);" \
  "FAIL race4 prepare"
mutation "no FOR UPDATE on the account row" candidate \
  "  select * into v_row from public.common_accounts where user_id = p_user_id for update;" \
  "  select * into v_row from public.common_accounts where user_id = p_user_id;" \
  "FAIL race1 begin did not see the start"
mutation "lifecycle calls do not lock the login row" candidate \
  "    perform 1 from auth.users where id = p_user_id for key share;" \
  "    perform 1 from auth.users where id = p_user_id;" \
  "FAIL"
mutation "a service can start while the account is deleting" candidate \
  $'  if v_account.status = \'deleting\' then\n    return jsonb_build_object(\'status\', \'blocked\', \'reason\', \'ACCOUNT_DELETION_IN_PROGRESS\');\n  end if;\n  if v_account.status <> \'active\' then' \
  $'  if v_account.status = \'locked\' then' \
  "FAIL no service can start while the account is deleting"
mutation "readiness does not re-check the blockers" candidate \
  "  v_blockers := private.account_lifecycle_deletion_blockers(p_user_id, 'deleting');" \
  "  v_blockers := '{}';" \
  "FAIL race3 readiness not revalidated"
# --- Guard --------------------------------------------------------------------
mutation "the guard never refuses" candidate \
  "  if coalesce(v_mode, 'enforce') <> 'shadow' then" \
  "  if false then" \
  "FAIL enforce: a hard delete of an active account is refused"
mutation "the guard does not re-check managed ownership at the delete" candidate \
  $'       or cardinality(private.account_lifecycle_managed_ownership(old.user_id)) > 0 then' \
  $'       then' \
  "FAIL enforce: ready is re-checked at the delete"
mutation "the guard accepts an operation that is not ready" candidate \
  "            and o.status = 'in_progress' and o.current_step = 'ready_for_managed_auth_delete')" \
  "            and o.status = 'in_progress')" \
  "FAIL enforce: an operation that is not ready does not authorize a delete"
mutation "enforce can be switched on before integration" candidate \
  $'  updated_at timestamptz not null default now(),\n  check (auth_delete_guard = \'shadow\' or integration_state = \'started\')' \
  $'  updated_at timestamptz not null default now()' \
  "FAIL enforce is refused while integration is not started"
# --- ACL / additive ---------------------------------------------------------------
mutation "PUBLIC keeps EXECUTE on a backend RPC" candidate \
  "revoke all on function public.prepare_common_account_auth_delete(uuid, uuid) from public, anon, authenticated, service_role;" \
  "revoke all on function public.prepare_common_account_auth_delete(uuid, uuid) from anon, authenticated, service_role;" \
  "FAIL anon prepare_common_account_auth_delete"
mutation "the client can read internal classification columns" candidate \
  "grant select (user_id, service_key, status, activated_at, ended_at, updated_at)" \
  "grant select" \
  "FAIL no table-level privilege for any client role"
mutation "the candidate changes a grant on an existing table" candidate \
  "-- 1. Tables ---" \
  $'revoke select on table public.brand_memberships from authenticated;\n-- 1. Tables ---' \
  "FAIL the candidate changed or removed an existing definition"

total="${#labels[@]}"
run_one() {
  local i="$1" work="$tmp/m$1" source
  mkdir -p "$work"
  if [[ "${targets[$i]}" == candidate ]]; then source="$candidate"; else source="$rollback"; fi
  if ! python3 - "$source" "$work/mutant.sql" "${olds[$i]}" "${news[$i]}" <<'PY'
import sys
source, target, old, new = sys.argv[1:5]
text = open(source, encoding="utf-8").read()
if text.count(old) != 1:
    sys.exit(f"mutation site matched {text.count(old)} times")
open(target, "w", encoding="utf-8").write(text.replace(old, new))
PY
  then echo "INVALID" > "$work/result"; return; fi
  local status=0
  if [[ "${targets[$i]}" == candidate ]]; then
    CAL_CANDIDATE="$work/mutant.sql" "$here/common_account_lifecycle_run.sh" > "$work/out" 2>&1 || status=$?
  else
    CAL_ROLLBACK="$work/mutant.sql" "$here/common_account_lifecycle_run.sh" > "$work/out" 2>&1 || status=$?
  fi
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
    grep -E 'FAIL|ERROR' "$tmp/m$i/out" 2>/dev/null | grep -v '^NOTICE' | head -3 >&2 || true
  fi
done
[[ "$detected" -eq "$total" ]] || { echo "FAIL $((total - detected)) of $total mutations were not detected as expected" >&2; exit 1; }
echo "COMMON_ACCOUNT_MUTATIONS_ALL_DETECTED $detected/$total"
