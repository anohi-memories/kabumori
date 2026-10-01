#!/usr/bin/env bash
# Defect-detection proof for common_account_lifecycle_run.sh. Each mutation
# breaks exactly one safety property in a COPY of the candidate (or of the
# rollback), runs the full runner against that copy, and requires the runner to
# fail at the check that guards that property: every mutation names the exact
# failure it must produce, never a generic one. The real files are never edited.
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

# === First review, six findings ==================================================
# --- 1: no login deletion, no false completion -----------------------------------
mutation "prepare deletes the login itself" candidate \
  $'  v_required := private.account_lifecycle_required_checkpoints(p_user_id);\n  update private.account_lifecycle_operations\n     set current_step = \'ready_for_managed_auth_delete\', ready_at = now(),' \
  $'  v_required := private.account_lifecycle_required_checkpoints(p_user_id);\n  delete from auth.users where id = p_user_id;\n  update private.account_lifecycle_operations\n     set current_step = \'ready_for_managed_auth_delete\', ready_at = now(),' \
  "FAIL the candidate writes to a managed schema"
mutation "an account deletion may be recorded as completed" candidate \
  "  check (status <> 'completed' or operation_type = 'service_deletion')," \
  "" \
  "FAIL H1-1: an account deletion cannot be recorded as completed at all"
mutation "readiness ignores visible Storage ownership" candidate \
  "  v_managed := private.account_lifecycle_managed_ownership(p_user_id);" \
  "  v_managed := '{}';" \
  "FAIL H1-1: with a Storage object still owned"
mutation "readiness ignores the managed checkpoints" candidate \
  "  v_missing := array(select k from unnest(v_required) k where not p_checkpoints ? k order by k);" \
  "  v_missing := '{}';" \
  "FAIL not ready until the managed cleanups are attested"
mutation "an unreadable Storage shape is treated as clean" candidate \
  "      return array['MANAGED_STORAGE_SHAPE_UNKNOWN'];" \
  "      return '{}'::text[];" \
  "FAIL unknown Storage shape fails closed"
mutation "a failed Storage probe is treated as clean" candidate \
  "  return array['MANAGED_STORAGE_PROBE_FAILED'];" \
  "  return '{}'::text[];" \
  "FAIL an unreadable Storage probe fails closed"
# --- 2: preview / version ---------------------------------------------------------
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
# --- 3: backfill serialization ----------------------------------------------------
# Race 9 alone does not catch this one: INSERT ... ON CONFLICT happens to wait
# for the uncommitted hold. Race 10 does.
mutation "backfill does not take the lifecycle lock" candidate \
  "        v_account := private.account_lifecycle_lock(v_user, true);" \
  "        insert into public.common_accounts (user_id) values (v_user) on conflict (user_id) do nothing; select * into v_account from public.common_accounts c where c.user_id = v_user;" \
  "FAIL timed out waiting for: race10 hold blocked behind the backfill"
mutation "backfill grants to an account that is not active" candidate \
  $'      if v_account.status <> \'active\' then\n        if (v_plan.kabumori_candidate' \
  $'      if false then\n        if (v_plan.kabumori_candidate' \
  "FAIL backfill skips a non-active account"
# --- 4: admin exclusion -----------------------------------------------------------
mutation "an admin workspace owner is an X backfill candidate" candidate \
  "       x.user_id is not null and not x.is_admin as x_candidate," \
  "       x.user_id is not null as x_candidate," \
  "FAIL dry-run with exclusions"
# --- 5: exact preflight -----------------------------------------------------------
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
# --- 6: rollback needs an affirmed shadow state -----------------------------------
# The original defect: "refuse only if a row says otherwise".
mutation "rollback treats a missing settings row as safe" rollback \
  $'  if (select count(*) from private.account_lifecycle_settings) <> 1 then\n    raise exception \'COMMON_ACCOUNT_ROLLBACK_REFUSED_SETTINGS_NOT_AFFIRMED\';\n  end if;\n  if (select auth_delete_guard from private.account_lifecycle_settings) is distinct from \'shadow\' then\n    raise exception \'COMMON_ACCOUNT_ROLLBACK_REFUSED_GUARD_NOT_SHADOW\';\n  end if;\n  if (select integration_state from private.account_lifecycle_settings) is distinct from \'not_started\' then' \
  $'  if exists (select 1 from private.account_lifecycle_settings where auth_delete_guard <> \'shadow\') then\n    raise exception \'COMMON_ACCOUNT_ROLLBACK_REFUSED_GUARD_NOT_SHADOW\';\n  end if;\n  if exists (select 1 from private.account_lifecycle_settings where integration_state <> \'not_started\') then' \
  "FAIL rollback ran: missing settings row"
mutation "rollback ignores that integration started" rollback \
  "  if (select integration_state from private.account_lifecycle_settings) is distinct from 'not_started' then" \
  "  if false then" \
  "FAIL rollback ran: integration started"

# === Second review, F1-F4 =========================================================
# --- F1: no authorizing guard; stale readiness is never trusted --------------------
mutation "application-row removal falsely records managed login deletion" candidate \
  $'  if exists (select 1 from auth.users u where u.id = old.user_id) then\n    raise exception \'COMMON_ACCOUNT_ROW_DELETE_REQUIRES_LOGIN_REMOVAL\' using errcode = \'23503\';\n  end if;' \
  "" \
  "FAIL H1-observer: direct common-row deletion must not falsely record login removal"
mutation "missing settings do not refuse a login delete" candidate \
  "  if v_mode is distinct from 'shadow' then" \
  "  if false then" \
  "FAIL missing settings refuse every login delete"
mutation "an enforcing guard mode exists" candidate \
  "check (auth_delete_guard = 'shadow')," \
  "check (auth_delete_guard in ('shadow', 'enforce'))," \
  "FAIL the candidate defines an enforcing guard mode"
mutation "the removal of a ready login is recorded without the unverified mark" candidate \
  "           when current_step = 'ready_for_managed_auth_delete' then 'LOGIN_REMOVED_WHILE_READY_UNVERIFIED'" \
  "           when current_step = 'ready_for_managed_auth_delete' then null" \
  "FAIL H1-observer: actual Auth cascade still records login removal"
mutation "an authorization is not re-evaluated before use" candidate \
  $'  v_refusal := private.account_lifecycle_readiness_refusal(p_user_id, v_operation.checkpoints);\n  if v_refusal is not null then\n    v_problems :=' \
  $'  v_refusal := null;\n  if v_refusal is not null then\n    v_problems :=' \
  "FAIL H1-F1: a late admin membership makes the authorization stale"
mutation "readiness does not re-check the blockers" candidate \
  "  v_blockers := private.account_lifecycle_deletion_blockers(p_user_id, 'deleting');" \
  "  v_blockers := '{}';" \
  "FAIL H1-F1: a late admin membership makes the authorization stale"
# --- F2: readiness is bound to its requirements ------------------------------------
mutation "an account change does not withdraw readiness" candidate \
  "    perform private.account_lifecycle_invalidate_readiness(new.user_id, 'LIFECYCLE_VERSION_CHANGED');" \
  "    null;" \
  "FAIL invalidator: entitlement insert"
mutation "a requirement change does not move the epoch" candidate \
  "  update private.account_lifecycle_settings set requirement_epoch = requirement_epoch + 1;" \
  "  null;" \
  "FAIL H1-F2: a new always-required checkpoint invalidates a readiness"
mutation "an epoch change does not withdraw readiness" candidate \
  "    perform private.account_lifecycle_invalidate_readiness(null, 'REQUIREMENT_EPOCH_CHANGED');" \
  "    null;" \
  "FAIL H1-F2: a new always-required checkpoint invalidates a readiness"
mutation "an integration state change does not move the epoch" candidate \
  "    new.requirement_epoch := old.requirement_epoch + 1;" \
  "    null;" \
  "FAIL invalidator: integration state transition"
mutation "readiness is not bound to the lifecycle version" candidate \
  "  if v_account.lifecycle_version is distinct from v_operation.ready_lifecycle_version then" \
  "  if false then" \
  "FAIL binding: a readiness decided against another lifecycle version is stale"
mutation "readiness is not bound to the requirement epoch" candidate \
  "  if v_epoch is distinct from v_operation.ready_requirement_epoch then" \
  "  if false then" \
  "FAIL binding: a readiness decided against another requirement epoch is stale"
mutation "readiness is not bound to the required checkpoints" candidate \
  "  if private.account_lifecycle_required_checkpoints(p_user_id) is distinct from v_operation.ready_required_checkpoints then" \
  "  if false then" \
  "FAIL H1-F2: a late Apple identity makes the authorization stale"
mutation "prepare records no binding" candidate \
  "         ready_lifecycle_version = v_account.lifecycle_version," \
  "         ready_lifecycle_version = 0," \
  "FAIL the authorization is durable on the operation and reads as valid"
mutation "prepare does not serialize with requirement changes" candidate \
  "  select s.requirement_epoch into v_epoch from private.account_lifecycle_settings s for share;" \
  "  select s.requirement_epoch into v_epoch from private.account_lifecycle_settings s;" \
  "FAIL race11 readiness granted across a requirement change"
mutation "a cleared checkpoint keeps the readiness" candidate \
  $'     set checkpoints = checkpoints - p_checkpoint,\n         current_step = \'cleanup\', ready_at = null, ready_lifecycle_version = null,\n         ready_requirement_epoch = null, ready_required_checkpoints = null,\n         last_error_code = \'MANAGED_CHECKPOINT_CLEARED\', updated_at = now()' \
  $'     set checkpoints = checkpoints - p_checkpoint, updated_at = now()' \
  "FAIL invalidator: checkpoint cleared"
# --- F3: built-in checkpoint meaning ------------------------------------------------
mutation "a built-in checkpoint can be changed by ordinary maintenance" candidate \
  "  if tg_op in ('UPDATE', 'DELETE') and exists (" \
  "  if false and exists (" \
  "FAIL built-in immutable: delete from private.account_lifecycle_managed_checkpoints"
mutation "the registry is validated by name only" candidate \
  "     where c.requirement is distinct from b.requirement)" \
  "     where c.checkpoint_key is null)" \
  "FAIL H1-F3: built-in names with a weakened meaning make nothing ready"
mutation "rollback accepts built-in checkpoints with a weakened meaning" rollback \
  "     where c.requirement is distinct from b.requirement" \
  "     where c.checkpoint_key is null and b.checkpoint_key is not null" \
  "FAIL rollback ran: built-in checkpoint with a weakened meaning"
mutation "rollback ignores finished lifecycle operations" rollback \
  "  if exists (select 1 from private.account_lifecycle_operations) then" \
  "  if exists (select 1 from private.account_lifecycle_operations where status = 'in_progress') then" \
  "FAIL rollback ran: finished lifecycle operation"
# --- F4: entitlement identity -------------------------------------------------------
mutation "an entitlement can be transferred to another person" candidate \
  "  if new.user_id is distinct from old.user_id or new.service_key is distinct from old.service_key then" \
  "  if false then" \
  "FAIL H1-F4: an entitlement cannot be transferred to another person or service"

# === Accepted properties that must stay =============================================
mutation "the readiness check takes a shared login lock" candidate \
  "  v_account := private.account_lifecycle_lock(p_user_id, false, true);" \
  "  v_account := private.account_lifecycle_lock(p_user_id, false, false);" \
  "FAIL race4 prepare"
mutation "no FOR UPDATE on the account row" candidate \
  "  select * into v_row from public.common_accounts where user_id = p_user_id for update;" \
  "  select * into v_row from public.common_accounts where user_id = p_user_id;" \
  "FAIL race1 begin did not see the start"
# Without it a lifecycle call and a hard delete of the same login take their
# locks in opposite orders: race 8 deadlocks.
mutation "lifecycle calls do not lock the login row" candidate \
  "    perform 1 from auth.users where id = p_user_id for key share;" \
  "    perform 1 from auth.users where id = p_user_id;" \
  "FAIL race8 start"
mutation "a service can start while the account is deleting" candidate \
  $'  if v_account.status = \'deleting\' then\n    return jsonb_build_object(\'status\', \'blocked\', \'reason\', \'ACCOUNT_DELETION_IN_PROGRESS\');\n  end if;\n  if v_account.status <> \'active\' then' \
  $'  if v_account.status = \'locked\' then' \
  "FAIL no service can start while the account is deleting"
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
