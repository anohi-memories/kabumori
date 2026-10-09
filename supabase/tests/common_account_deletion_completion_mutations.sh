#!/usr/bin/env bash
# Defect-detection proof for common_account_deletion_completion_run.sh (with the PR112 H2 R1-R4 corrective). Each mutation breaks exactly one
# safety property in a COPY of the candidate, runs the full runner against that copy, and requires the
# runner to fail with the named message that guards that property. The real file is never edited.
# Disposable local PostgreSQL only; same environment as the runner, plus python3. Runs one mutation at a
# time by default (the runner creates cluster-wide roles).
# Usage: CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... [CAL_JOBS=1] \
#        bash supabase/tests/common_account_deletion_completion_mutations.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
candidate="$here/../migrations/20261009120000_common_account_deletion_completion.sql"
jobs="${CAL_JOBS:-1}"
tmp="$(mktemp -d /private/tmp/kabumori-cal-completion-mutations.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

labels=(); olds=(); news=(); expects=()
mutation() { labels+=("$1"); olds+=("$2"); news+=("$3"); expects+=("$4"); }

# --- the read-back never reports a deletion that did not happen ------------------------------------
mutation "completion does not check that the login is gone" \
  $'  if exists (select 1 from auth.users u where u.id = p_user_id) then\n    return jsonb_build_object(\'status\', \'login_present\', \'login_deleted\', false);\n  end if;\n' \
  "" \
  "FAIL A: completion while the login exists says so and changes nothing"
mutation "completion ignores residual Storage ownership" \
  $'  v_managed := private.account_lifecycle_managed_ownership(p_user_id);' \
  $'  v_managed := \'{}\';' \
  "FAIL C1: residual Storage is not verified"
mutation "completion ignores residual service data" \
  $'  if (v_footprint ->> \'kabumori\')::boolean or (v_footprint ->> \'x_autopost\')::boolean\n     or (v_footprint ->> \'x_foreign\')::boolean or (v_footprint ->> \'admin\')::boolean then' \
  "  if false then" \
  "FAIL C2: residual X workspace is not verified"
mutation "completion accepts a login removed after the readiness was withdrawn" \
  $'  elsif v_operation.current_step <> \'ready_for_managed_auth_delete\' then' \
  "  elsif false then" \
  "FAIL C5: a readiness withdrawn after the intent is not verified"
mutation "completion ignores a required checkpoint dropped after the intent" \
  $'  elsif exists (select 1 from unnest(v_operation.managed_delete_required_checkpoints) k where not v_operation.checkpoints ? k) then' \
  "  elsif false then" \
  "FAIL C6: a required checkpoint dropped after the intent"
mutation "completion ignores an intent decided against other requirements" \
  $'  elsif v_operation.ready_required_checkpoints is distinct from v_operation.managed_delete_required_checkpoints then' \
  "  elsif false then" \
  "FAIL C6: an intent decided against other requirements"
mutation "the table accepts a completion without a recorded managed intent" \
  $'        and managed_delete_intent_at is not null and external_step is null and owner_lease is null)),' \
  $'        and external_step is null and owner_lease is null)),' \
  "FAIL change: unexpected additions"
mutation "an aborted deletion can be completed" \
  $'  if not found or v_operation.status = \'aborted\' then' \
  "  if not found then" \
  "FAIL D: an aborted deletion is never completed"
mutation "completion writes to auth" \
  $'  update private.account_lifecycle_operations\n     set status = \'completed\', verified_at = now()' \
  $'  delete from auth.users where id = p_user_id;\n  update private.account_lifecycle_operations\n     set status = \'completed\', verified_at = now()' \
  "FAIL the candidate writes to a managed schema"
# --- R3: the managed delete -----------------------------------------------------------------------------
mutation "completion accepts a login removed without the managed delete intent (H2 R3)" \
  $'  elsif v_operation.managed_delete_intent_at is null or v_operation.external_step is distinct from \'managed_auth_delete\' then' \
  "  elsif false then" \
  "FAIL G0/R3: H2_R3_LATE_APPLE_COMPLETED_WITHOUT_REVOCATION is now impossible"
mutation "the managed delete intent ignores the release gate" \
  $'    if not private.account_lifecycle_gate_open(\'managed_auth_delete\') then' \
  "    if false then" \
  "FAIL G0: no managed delete intent can be recorded while the gate is blocked"
mutation "the release gate can be opened by a setting" \
  $'  state text not null constraint account_lifecycle_release_gates_blocked_only check (state = \'blocked\'),' \
  $'  state text not null constraint account_lifecycle_release_gates_blocked_only check (state in (\'blocked\', \'open\')),' \
  "FAIL change: unexpected additions"
mutation "the managed delete intent does not re-evaluate the readiness" \
  $'    v_problems := private.account_lifecycle_authorization_problems(p_user_id, p_operation_id);' \
  $'    v_problems := \'{}\';' \
  "FAIL C2: a workspace seen at the intent drops the readiness"
mutation "the managed delete intent is decided without the exclusive login lock" \
  $'  v_account := private.account_lifecycle_lock(p_user_id, false, p_step = \'managed_auth_delete\');' \
  $'  v_account := private.account_lifecycle_lock(p_user_id, false);' \
  "FAIL race identity-link-then-intent"
# --- R4: a completed deletion asked again --------------------------------------------------------------
mutation "a completed deletion is reported without a fresh residue check (H2 R4)" \
  $'    v_reason := private.account_lifecycle_residue(p_user_id);\n    if v_reason is null then' \
  $'    v_reason := null;\n    if v_reason is null then' \
  "FAIL R4: H2_R4_LATE_STORAGE_STILL_COMPLETED is now impossible"
mutation "a later residue rewrites the historical verification" \
  $'       set last_error_code = v_reason, updated_at = now()\n     where id = v_operation.id;\n    return jsonb_build_object(\'status\', \'residue_found\'' \
  $'       set last_error_code = v_reason, verified_at = now(), updated_at = now()\n     where id = v_operation.id;\n    return jsonb_build_object(\'status\', \'residue_found\'' \
  "FAIL R4: H2_R4_LATE_STORAGE_STILL_COMPLETED is now impossible"
# --- R1: one owner -------------------------------------------------------------------------------------
mutation "a live lease does not stop a second owner" \
  $'  if v_operation.owner_lease is not null and v_operation.owner_lease_expires_at > now() then\n    return jsonb_build_object(\'status\', \'in_progress\');\n  end if;\n  if v_operation.external_step is not null then' \
  $'  if v_operation.external_step is not null then' \
  "FAIL R1: a second request"
mutation "ownership is not checked against the lease token" \
  $'  if not found or p_lease is null or v_operation.owner_lease is distinct from p_lease\n     or v_operation.owner_lease_expires_at <= now() then' \
  $'  if not found or v_operation.owner_lease_expires_at <= now() then' \
  "FAIL R1: a guessed lease owns nothing"
mutation "an expired lease still owns the deletion" \
  $'     or v_operation.owner_lease_expires_at <= now() then' \
  "     or false then" \
  "FAIL R1: an expired lease owns nothing"
mutation "the fence does not move on a new owner" \
  "         owner_fence = owner_fence + 1, updated_at = now()" \
  "         owner_fence = owner_fence, updated_at = now()" \
  "FAIL A: ownership taken (fence 1)"
mutation "an owned checkpoint does not check ownership" \
  $'  v_account := private.account_lifecycle_lock(p_user_id, false);\n  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);\n  if v_operation.id is null or v_account.user_id is null then\n    return jsonb_build_object(\'status\', \'lease_lost\');\n  end if;\n  if p_recorded then' \
  $'  v_account := private.account_lifecycle_lock(p_user_id, false);\n  if p_recorded then' \
  "FAIL R1: the stale owner is refused"
mutation "an owned readiness does not check ownership" \
  $'  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);\n  if v_operation.id is null or v_account.user_id is null then\n    return jsonb_build_object(\'status\', \'lease_lost\');\n  end if;\n  return public.prepare_common_account_auth_delete' \
  $'  return public.prepare_common_account_auth_delete' \
  "FAIL R1: the stale owner is refused"
mutation "the Apple checkpoint can be written as a plain checkpoint" \
  $'  if p_checkpoint is null or p_checkpoint not in (\'session_revocation\', \'storage_cleanup\') or p_recorded is null then' \
  $'  if p_checkpoint is null or p_checkpoint not in (\'session_revocation\', \'storage_cleanup\', \'apple_revocation\') or p_recorded is null then' \
  "FAIL R1: the Apple checkpoint is never written as a plain checkpoint"
# --- R2: the Apple step ---------------------------------------------------------------------------------
mutation "an unsettled Apple step is cleared (replayed) on takeover" \
  $'    if v_operation.external_step = \'apple_revocation\' then' \
  "    if false then" \
  "FAIL R2: afterwards: reconciliation"
mutation "a possibly running external step is not waited for" \
  $'    if v_operation.external_step_started_at > now() - interval \'900 seconds\' then' \
  "    if false then" \
  "FAIL R2: within the settle window a takeover waits"
mutation "a second external step may start while one is unsettled" \
  $'  if v_operation.external_step is not null then\n    return jsonb_build_object(\'status\', \'step_in_flight\', \'step\', v_operation.external_step);\n  end if;\n' \
  "" \
  "FAIL R2: one in flight at a time"
mutation "a recorded Apple revocation can be started again" \
  $'    if v_operation.checkpoints ? \'apple_revocation\' then' \
  "    if false then" \
  "FAIL R2: a recorded revocation is never repeated"
mutation "a settle without ownership is accepted" \
  $'  v_account := private.account_lifecycle_lock(p_user_id, false);\n  v_operation := private.account_lifecycle_owned_operation(p_user_id, p_operation_id, p_lease);\n  if v_operation.id is null or v_account.user_id is null then\n    return jsonb_build_object(\'status\', \'lease_lost\');\n  end if;\n  if v_operation.external_step is distinct from p_step then' \
  $'  v_account := private.account_lifecycle_lock(p_user_id, false);\n  select * into v_operation from private.account_lifecycle_operations where id = p_operation_id;\n  if v_operation.external_step is distinct from p_step then' \
  "FAIL R2: a settle without ownership records nothing"
mutation "an operator may reconcile while an owner holds the deletion" \
  $'  if v_operation.owner_lease is not null and v_operation.owner_lease_expires_at > now() then\n    return jsonb_build_object(\'status\', \'in_progress\');\n  end if;\n  if v_operation.external_step is distinct from \'apple_revocation\' then' \
  $'  if v_operation.external_step is distinct from \'apple_revocation\' then' \
  "FAIL R2: no reconciliation while an owner holds the deletion"
# --- identity: the verified person only -------------------------------------------------------------
mutation "completion finds the operation by its id alone" \
  $'   where id = p_operation_id and operation_type = \'account_deletion\'\n     and subject_sha256 = public.social_mobile_account_deletion_subject(p_user_id)\n   for update;' \
  $'   where id = p_operation_id and operation_type = \'account_deletion\'\n   for update;' \
  "FAIL D: another person cannot complete this operation by naming its id"
mutation "an error code can be written on another person's operation" \
  $'   where id = p_operation_id and user_id = p_user_id\n     and operation_type = \'account_deletion\' and status = \'in_progress\';\n  if not found or v_account.user_id is null then\n    return jsonb_build_object(\'status\', \'not_found\');\n  end if;\n  return jsonb_build_object(\'status\', \'recorded\');' \
  $'   where id = p_operation_id\n     and operation_type = \'account_deletion\' and status = \'in_progress\';\n  if not found or v_account.user_id is null then\n    return jsonb_build_object(\'status\', \'not_found\');\n  end if;\n  return jsonb_build_object(\'status\', \'recorded\');' \
  "FAIL G: not on another person's operation"
mutation "free text is accepted as an error code" \
  $'  if p_error_code is null or p_error_code !~ \'^[A-Z][A-Z0-9_]{1,63}$\' then' \
  "  if p_error_code is null then" \
  "FAIL G: free text (an e-mail) is refused"
# --- concurrency -------------------------------------------------------------------------------------
mutation "the read-back does not wait for an uncommitted removal" \
  $'     and subject_sha256 = public.social_mobile_account_deletion_subject(p_user_id)\n   for update;' \
  $'     and subject_sha256 = public.social_mobile_account_deletion_subject(p_user_id);' \
  "FAIL race removal-then-readback"
mutation "the read-back runs outside READ COMMITTED" \
  $'  if current_setting(\'transaction_isolation\') <> \'read committed\' then\n    raise exception \'ACCOUNT_LIFECYCLE_REQUIRES_READ_COMMITTED\';\n  end if;\n  -- Only the operation row' \
  "  -- Only the operation row" \
  "FAIL D: only READ COMMITTED"
# --- Storage inventory is never falsely empty ---------------------------------------------------------
mutation "the deprecated owner column is not listed" \
  $'    v_object_owner := v_object_owner || \' or o.owner::text = $1\';' \
  "    null;" \
  "FAIL B: inventory is paged"
mutation "the inventory never says there is more" \
  $'  execute format(\'select count(*) > $2 from (select 1 from storage.objects o where %s limit $2 + 1) c\', v_object_owner)\n    into v_more using p_user_id::text, p_limit;' \
  "  v_more := false;" \
  "FAIL B: inventory is paged"
mutation "an owned bucket is not reported" \
  $'  execute format(\'select exists (select 1 from storage.buckets b where %s)\', v_bucket_owner)\n    into v_buckets using p_user_id::text;' \
  "  v_buckets := false;" \
  "FAIL F: an owned bucket is reported"
mutation "an unknown Storage shape reads as empty" \
  $'      return jsonb_build_object(\'status\', \'unknown_shape\');\n    end if;\n  end loop;' \
  $'      return jsonb_build_object(\'status\', \'ok\', \'objects\', \'[]\'::jsonb, \'more\', false, \'buckets_owned\', false);\n    end if;\n  end loop;' \
  "FAIL F: an unexpected Storage shape is never"
mutation "a Storage read failure reads as empty" \
  $'  return jsonb_build_object(\'status\', \'probe_failed\');' \
  $'  return jsonb_build_object(\'status\', \'ok\', \'objects\', \'[]\'::jsonb, \'more\', false, \'buckets_owned\', false);' \
  "FAIL F: a Storage read failure is never"
# --- privileges ---------------------------------------------------------------------------------------
mutation "a client role may complete a deletion" \
  "grant execute on function public.complete_common_account_deletion(uuid, uuid) to service_role;" \
  "grant execute on function public.complete_common_account_deletion(uuid, uuid) to service_role, authenticated;" \
  "FAIL ACL"
mutation "a client role may claim a deletion" \
  "grant execute on function public.claim_common_account_deletion(uuid, uuid, integer) to service_role;" \
  "grant execute on function public.claim_common_account_deletion(uuid, uuid, integer) to service_role, authenticated;" \
  "FAIL ACL"
mutation "the private Storage helper keeps default privileges" \
  "revoke all on function private.account_lifecycle_storage_inventory(uuid, integer) from public, anon, authenticated, service_role;" \
  "" \
  "FAIL ACL"
mutation "the gate table keeps default privileges" \
  "revoke all on table private.account_lifecycle_release_gates from public, anon, authenticated, service_role;" \
  "" \
  "FAIL change: unexpected additions"

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
  CAL_COMPLETION_CANDIDATE="$work/mutant.sql" bash "$here/common_account_deletion_completion_run.sh" > "$work/out" 2>&1 || status=$?
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
    grep -E 'FAIL|ERROR' "$tmp/m$i/out" 2>/dev/null | head -3 >&2 || true
  fi
done
[[ "$detected" -eq "$total" ]] || { echo "FAIL $((total - detected)) of $total mutations were not detected as expected" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_MUTATIONS_ALL_DETECTED $detected/$total"
