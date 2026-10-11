#!/usr/bin/env bash
# Operator runner for the AI provider budget ledger (migration 20261010050613) on a Supabase project (Phase 1d).
# Runbook: docs/ai-provider/PHASE1D_ACTIVATION_RUNBOOK.md. Run it from the repository root of a checkout whose
# migration file has exactly the merged bytes (pinned below).
#
#   check                 read-only: preflight verdict + fingerprint of the existing business objects
#   status                read-only: read-back when the ledger exists, preflight otherwise
#   apply                 Stage 0 preflight + "before" fingerprint -> Stage A migration (once) -> Stage B read-back
#                         -> Stage C history row -> Stage D read-back + "after" fingerprint compared with "before"
#   apply --resume-history   only for "schema verified / history row missing": Stage C -> Stage D read-back
#   policies              the Phase 1d test-phase policies (refused unless the ledger has none) -> read-back
#   stop                  stop switch: every policy disabled -> read-back (all calls then refused before sending)
#   rollback              only while the ledger holds no reservation and no usage event: rollback.sql and the
#                         history row removed -> preflight READY again
#
# Every database step is `supabase db query --linked --project-ref $AIL_ROLLOUT_REF --output-format json -f FILE`
# (Management API, as postgres; no database password here). Writes need AIL_ROLLOUT_ACK set to the exact phrase of
# the command (printed when missing). Nothing is retried, repaired or skipped: any surprise is a STOP with a fixed
# exit code. Outputs (catalog facts and counts only) go to $AIL_ROLLOUT_OUT (default ~/.kabumori-ai-ledger-rollout).
#
# Exit codes: 0 done / status printed, 2 refused by a guard, 10 STOP precondition, 11 STOP Stage A failed and the
# ledger is confirmed absent (nothing changed), 12 STOP Stage A outcome unknown or inconsistent, 13 STOP Stage B
# read-back mismatch, 14 STOP history row step failed (schema verified, history missing: use --resume-history),
# 15 STOP postflight mismatch, 16 STOP unreadable output.
set -euo pipefail
export LC_ALL=C

VERSION="20261010050613"
NAME="ai_provider_budget_ledger"
# Merged source bytes (PR #119 head 8ef3843f, main merge e6a8bdbb). Stage A refuses any other bytes.
MIGRATION_SHA256="680aeb3f2e540b184476b0c1e3534d8586b4857ec29856e40793ed44eff35737"

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../migrations/${VERSION}_${NAME}.sql"
PREFLIGHT="$HERE/ai_provider_budget_ledger_preflight.sql"
READBACK="$HERE/ai_provider_budget_ledger_readback.sql"
FINGERPRINT="$HERE/ai_provider_budget_ledger_existing_fingerprint.sql"
POLICIES="$HERE/ai_provider_budget_ledger_initial_policies.sql"
ROLLBACK="$HERE/ai_provider_budget_ledger_rollback.sql"
GATE=(python3 -I "$HERE/ai_provider_budget_ledger_gate.py")

say() { printf '%s\n' "$*"; }
stop() { say "STOP[$1] $2"; exit "$1"; }
refuse() { say "REFUSED $1" >&2; exit 2; }

COMMAND="${1:-}"
OPTION="${2:-}"
REF="${AIL_ROLLOUT_REF:-}"
[[ "$REF" =~ ^[a-z]{20}$ ]] || refuse "AIL_ROLLOUT_REF must be the 20-letter project ref"
command -v supabase >/dev/null || refuse "supabase CLI not found"
command -v python3 >/dev/null || refuse "python3 not found"

umask 077
RUN_DIR="${AIL_ROLLOUT_OUT:-$HOME/.kabumori-ai-ledger-rollout}/$(date +%Y%m%d-%H%M%S)-${COMMAND:-none}"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/run.log"
say "run: $COMMAND ${OPTION} ref=$REF out=$RUN_DIR" | tee -a "$LOG"

# sql <file> <output name>: runs one SQL file; output saved; returns the CLI exit status.
sql() {
  local status=0
  supabase db query --linked --project-ref "$REF" --output-format json -f "$1" >"$RUN_DIR/$2.json" 2>"$RUN_DIR/$2.err" || status=$?
  say "  sql $2: exit $status" >>"$LOG"
  return "$status"
}

# judge <gate args...> < output: prints the verdict lines into the log and the terminal.
judge() {
  local name="$1"; shift
  local status=0
  "${GATE[@]}" "$@" <"$RUN_DIR/$name.json" | tee -a "$LOG" || status=${PIPESTATUS[0]}
  return "$status"
}

need_ack() {
  local phrase="$1"
  [[ "${AIL_ROLLOUT_ACK:-}" == "$phrase" ]] || refuse "set AIL_ROLLOUT_ACK to exactly: $phrase"
}

ledger_present() {
  # 0 = present, 1 = absent, 2 = unknown (output unreadable). Uses the preflight's target fields.
  sql "$PREFLIGHT" "$1" || return 2
  python3 -I -c '
import json, sys
sys.path.insert(0, sys.argv[2])
from ai_provider_budget_ledger_gate import load_result
try:
    r = load_result(open(sys.argv[1]).read())
except Exception:
    sys.exit(2)
t = r["target_absent"]
present = (not t["schema_ai_ledger_absent"]) or t["public_ai_ledger_functions"] > 0
absent = t["schema_ai_ledger_absent"] and t["public_ai_ledger_functions"] == 0
sys.exit(0 if present else 1 if absent else 2)' "$RUN_DIR/$1.json" "$HERE"
}

# Write steps are single statements whose output is never parsed: every write is judged by a separate read-back.
history_sql() {
  local file="$RUN_DIR/history.sql"
  printf '%s\n' "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', '$NAME') on conflict (version) do nothing;" >"$file"
  echo "$file"
}

# field <output name> <python expression on r>: exit 0 when the expression is true for the saved result.
field() {
  python3 -I -c 'import sys; sys.path.insert(0, sys.argv[3]); from ai_provider_budget_ledger_gate import load_result; r = load_result(open(sys.argv[1]).read()); sys.exit(0 if eval(sys.argv[2], {}, {"r": r}) else 1)' \
    "$RUN_DIR/$1.json" "$2" "$HERE"
}

stage_d() {
  sql "$READBACK" readback_after || stop 15 "post-apply read-back failed to run"
  judge readback_after readback none || stop 15 "post-apply read-back mismatch"
  field readback_after 'r["history_row"] == 1' || stop 15 "history row is not exactly 1"
}

case "$COMMAND" in
  check)
    sql "$PREFLIGHT" preflight || stop 16 "preflight did not run (see $RUN_DIR/preflight.err)"
    status=0; judge preflight preflight || status=$?
    sql "$FINGERPRINT" fingerprint || stop 16 "fingerprint did not run"
    say "fingerprint saved: $RUN_DIR/fingerprint.json" | tee -a "$LOG"
    [ "$status" -eq 0 ] || stop 10 "preflight is NOT_READY"
    say "DONE check: READY_TO_APPLY" | tee -a "$LOG"
    ;;

  status)
    present=0; ledger_present preflight || present=$?
    case "$present" in
      0) sql "$READBACK" readback || stop 16 "read-back did not run"
         expect=none
         if field readback 'r["rows"]["budget_policies"] > 0 and r["rows"]["budget_policies_enabled"] == 0'; then expect=stopped
         elif field readback 'r["rows"]["budget_policies"] > 0'; then expect=test; fi
         judge readback readback "$expect" || stop 15 "read-back mismatch" ;;
      1) judge preflight preflight || true; say "ledger absent" ;;
      *) stop 16 "could not classify the target" ;;
    esac
    ;;

  apply)
    need_ack "apply ${VERSION}_${NAME} to $REF"
    actual="$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)"
    [[ "$actual" == "$MIGRATION_SHA256" ]] || refuse "migration bytes differ from the merged source ($actual)"
    if [[ "$OPTION" == "--resume-history" ]]; then
      sql "$READBACK" readback_before_history || stop 10 "read-back did not run"
      judge readback_before_history readback none || stop 10 "schema is not verified; history step refused"
      sql "$(history_sql)" history || stop 14 "history row step failed again"
      stage_d
      say "DONE apply --resume-history" | tee -a "$LOG"
      exit 0
    fi
    [[ -z "$OPTION" ]] || refuse "unknown option $OPTION"
    # Stage 0: same-run preflight and baseline.
    sql "$PREFLIGHT" stage0_preflight || stop 10 "preflight did not run"
    judge stage0_preflight preflight || stop 10 "preflight is NOT_READY"
    sql "$FINGERPRINT" fingerprint_before || stop 10 "baseline fingerprint did not run"
    # Stage A: the exact migration, once.
    say "Stage A: applying ${VERSION}_${NAME}" | tee -a "$LOG"
    if ! sql "$MIGRATION" stage_a; then
      present=0; ledger_present after_stage_a || present=$?
      case "$present" in
        1) stop 11 "Stage A failed and the ledger is absent: nothing changed (see $RUN_DIR/stage_a.err)" ;;
        0) stop 12 "Stage A reported failure but the ledger exists: outcome unknown, do not retry" ;;
        *) stop 12 "Stage A failed and the target could not be classified" ;;
      esac
    fi
    # Stage B: catalog read-back before any history row.
    sql "$READBACK" readback_stage_b || stop 12 "read-back after Stage A did not run"
    judge readback_stage_b readback none || stop 13 "read-back after Stage A does not match"
    # Stage C: history row.
    sql "$(history_sql)" history || stop 14 "history row step failed: schema verified, run apply --resume-history"
    # Stage D: read-back with history, and existing business objects unchanged.
    stage_d
    sql "$FINGERPRINT" fingerprint_after || stop 15 "after fingerprint did not run"
    "${GATE[@]}" compare "$RUN_DIR/fingerprint_before.json" "$RUN_DIR/fingerprint_after.json" --expect-rpcs 7 | tee -a "$LOG" \
      || stop 15 "existing business objects changed between the baseline and now"
    say "DONE apply: ledger present, read back, history row 1, existing objects unchanged (+7 RPCs)" | tee -a "$LOG"
    ;;

  policies)
    need_ack "insert phase1d test policies into $REF"
    sql "$READBACK" readback_before_policies || stop 10 "read-back did not run"
    judge readback_before_policies readback none || stop 10 "ledger not verified, or policies already present"
    sql "$POLICIES" policies || stop 12 "policy step failed (the file refuses when rows exist; check status before anything else)"
    sql "$READBACK" readback_policies || stop 15 "read-back after policies did not run"
    judge readback_policies readback test || stop 15 "policies do not read back exactly"
    say "DONE policies: shared market report (system, Anthropic, Opus 5.5) only" | tee -a "$LOG"
    ;;

  stop)
    need_ack "disable all ai_ledger policies in $REF"
    file="$RUN_DIR/stop.sql"
    printf '%s\n' "update ai_ledger.budget_policies set enabled = false, updated_at = now() where enabled;" >"$file"
    sql "$file" stop || stop 12 "stop switch did not run: disable the Anthropic key in the Console now"
    sql "$READBACK" readback_stop || stop 15 "read-back after the stop switch did not run"
    field readback_stop 'r["rows"]["budget_policies_enabled"] == 0' || stop 15 "policies still enabled"
    say "DONE stop: every policy disabled; every reservation is now refused before any provider request" | tee -a "$LOG"
    ;;

  rollback)
    need_ack "drop the empty ai_ledger in $REF"
    sql "$READBACK" readback_before_rollback || stop 10 "read-back did not run"
    field readback_before_rollback 'r["rows"]["reservations"] == 0 and r["rows"]["usage_events"] == 0 and r["rows"]["billing_observations"] == 0' \
      || stop 10 "the ledger holds rows: export them and decide with ChatGPT and the user first"
    sql "$ROLLBACK" rollback || stop 12 "rollback failed: check status before anything else"
    file="$RUN_DIR/history_delete.sql"
    printf '%s\n' "delete from supabase_migrations.schema_migrations where version = '$VERSION';" >"$file"
    sql "$file" history_delete || stop 14 "history row delete failed"
    sql "$PREFLIGHT" preflight_after_rollback || stop 15 "preflight after rollback did not run"
    judge preflight_after_rollback preflight || stop 15 "target is not back to READY_TO_APPLY"
    field preflight_after_rollback 'not r["history"]["has_20261010050613_ai_ledger"]' || stop 15 "history row still present"
    say "DONE rollback: ledger and history row removed" | tee -a "$LOG"
    ;;

  *) refuse "usage: $0 check | status | apply [--resume-history] | policies | stop | rollback" ;;
esac
