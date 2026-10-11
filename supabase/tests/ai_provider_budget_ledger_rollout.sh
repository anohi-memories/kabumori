#!/usr/bin/env bash
# Operator runner for the AI provider budget ledger (migration 20261010050613) on a Supabase project (Phase 1d).
# Runbook: docs/ai-provider/PHASE1D_ACTIVATION_RUNBOOK.md. Run it from the repository root of a checkout whose
# migration file has exactly the merged bytes (pinned below).
#
#   check                 read-only: target identity, preflight verdict, fingerprint of the existing business objects
#   status                read-only: target identity, then read-back when the ledger exists, preflight otherwise
#   apply                 Stage 0 identity + preflight + "before" fingerprint + identity again -> Stage A migration
#                         (once) -> Stage B read-back -> Stage C history row -> Stage D read-back + "after" fingerprint
#                         compared with "before"
#   apply --resume-history   only for "schema verified / history row missing": Stage C -> Stage D read-back
#   policies              the Phase 1d test-phase policies (refused unless the ledger has none) -> read-back
#   stop                  stop switch: every policy disabled -> read-back (all calls then refused before sending)
#   rollback              only while the ledger holds no reservation and no usage event: rollback.sql and the
#                         history row removed -> preflight READY again
#
# Which project is written (checked before ANY database step of every command, and again right before the migration):
#   1. CLI: supabase >= 2.116.0 < 3 whose `db query` has --linked / --project-ref / --agent. Every call is
#      `supabase db query --workdir <fresh empty dir> --linked --project-ref $AIL_ROLLOUT_REF --output-format json
#       --agent no -f FILE`: in CLI 2.116 the ref comes from --project-ref first (then SUPABASE_PROJECT_ID, then the
#      workdir's supabase/.temp/project-ref, which the empty workdir does not have), and the SQL is sent to the
#      Management API at /v1/projects/$AIL_ROLLOUT_REF/database/query. SUPABASE_PROJECT_ID naming another project is
#      refused.
#   2. Database: ai_provider_budget_ledger_target_identity.sql must show that this database's own cron jobs call
#      exactly https://$AIL_ROLLOUT_REF.supabase.co/... and that the Kabumori / POSTONA / common-account objects and
#      history rows exist. Anything else is STOP 10 before a write.
# Writes need AIL_ROLLOUT_ACK set to the exact phrase of the command (printed when missing). Nothing is retried,
# repaired or skipped. CLI output is never trusted as success by itself: reads must be exactly one result row of the
# expected shape (else STOP 16), writes are judged only by a separate read-back. Outputs (catalog facts, counts and
# project refs only) go to $AIL_ROLLOUT_OUT (default ~/.kabumori-ai-ledger-rollout).
#
# Exit codes: 0 done / status printed, 2 refused by a guard, 10 STOP precondition (incl. target not verified),
# 11 STOP Stage A failed and the ledger is confirmed absent (nothing changed), 12 STOP Stage A outcome unknown or
# inconsistent, 13 STOP Stage B read-back mismatch, 14 STOP history row step failed (schema verified, history
# missing: use --resume-history), 15 STOP postflight mismatch, 16 STOP unreadable or unexpected CLI output.
set -euo pipefail
export LC_ALL=C

VERSION="20261010050613"
NAME="ai_provider_budget_ledger"
# Merged source bytes (PR #119 head 8ef3843f, main merge e6a8bdbb). Stage A refuses any other bytes.
MIGRATION_SHA256="680aeb3f2e540b184476b0c1e3534d8586b4857ec29856e40793ed44eff35737"
CLI_MIN_MINOR=116

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$HERE/../migrations/${VERSION}_${NAME}.sql"
PREFLIGHT="$HERE/ai_provider_budget_ledger_preflight.sql"
READBACK="$HERE/ai_provider_budget_ledger_readback.sql"
FINGERPRINT="$HERE/ai_provider_budget_ledger_existing_fingerprint.sql"
IDENTITY="$HERE/ai_provider_budget_ledger_target_identity.sql"
POLICIES="$HERE/ai_provider_budget_ledger_initial_policies.sql"
ROLLBACK="$HERE/ai_provider_budget_ledger_rollback.sql"
GATE=(python3 -I "$HERE/ai_provider_budget_ledger_gate.py" --require-array)

say() { printf '%s\n' "$*"; }
stop() { say "STOP[$1] $2"; exit "$1"; }
refuse() { say "REFUSED $1" >&2; exit 2; }

COMMAND="${1:-}"
OPTION="${2:-}"
REF="${AIL_ROLLOUT_REF:-}"
[[ "$REF" =~ ^[a-z]{20}$ ]] || refuse "AIL_ROLLOUT_REF must be the 20-letter project ref"
command -v supabase >/dev/null || refuse "supabase CLI not found"
command -v python3 >/dev/null || refuse "python3 not found"
case "$COMMAND" in check|status|apply|policies|stop|rollback) ;; *) refuse "usage: $0 check | status | apply [--resume-history] | policies | stop | rollback" ;; esac

# ---- CLI compatibility (before any database step) -------------------------------------------------------------------
if [[ -n "${SUPABASE_PROJECT_ID:-}" && "$SUPABASE_PROJECT_ID" != "$REF" ]]; then
  refuse "SUPABASE_PROJECT_ID names another project; unset it"
fi
CLI_VERSION="$(supabase --version 2>/dev/null | head -n 1 | tr -d '[:space:]')"
if [[ ! "$CLI_VERSION" =~ ^2\.([0-9]+)\.([0-9]+)$ ]] || (( BASH_REMATCH[1] < CLI_MIN_MINOR )); then
  refuse "supabase CLI '$CLI_VERSION' is not supported (needs 2.$CLI_MIN_MINOR.0 or later 2.x: --project-ref with --linked, --agent)"
fi
HELP="$(supabase db query --help 2>&1 || true)"
for flag in --linked --project-ref --file --output-format --agent --workdir; do
  [[ "$HELP" == *"$flag"* ]] || refuse "supabase db query --help does not list $flag"
done

umask 077
RUN_DIR="${AIL_ROLLOUT_OUT:-$HOME/.kabumori-ai-ledger-rollout}/$(date +%Y%m%d-%H%M%S)-$COMMAND"
mkdir -p "$RUN_DIR"
# A fresh, empty CLI project directory: no supabase/.temp/project-ref the CLI could fall back to.
CLI_WORKDIR="$RUN_DIR/cli-workdir"
mkdir -p "$CLI_WORKDIR"
LOG="$RUN_DIR/run.log"
say "run: $COMMAND $OPTION ref=$REF cli=$CLI_VERSION out=$RUN_DIR" | tee -a "$LOG"

# sql <file> <output name>: one SQL file through the Management API of exactly $REF; returns the CLI exit status.
sql() {
  local status=0
  [[ ! -e "$CLI_WORKDIR/supabase/.temp/project-ref" ]] || stop 10 "a linked project ref appeared in the CLI workdir"
  supabase db query --workdir "$CLI_WORKDIR" --linked --project-ref "$REF" --output-format json --agent no -f "$1" \
    >"$RUN_DIR/$2.json" 2>"$RUN_DIR/$2.err" || status=$?
  say "  sql $2: exit $status" >>"$LOG"
  return "$status"
}

# judge <output name> <gate args...>: the verdict lines go to the log and the terminal. Unreadable output is STOP 16.
judge() {
  local name="$1"; shift
  local status=0
  "${GATE[@]}" "$@" <"$RUN_DIR/$name.json" >"$RUN_DIR/$name.verdict" || status=$?
  tee -a "$LOG" <"$RUN_DIR/$name.verdict"
  [ "$status" -ne 2 ] || stop 16 "unreadable or unexpected output in $name.json"
  return "$status"
}

# field <output name> <kind> <expression on r>: 0 true, 1 false; unreadable output is STOP 16.
field() {
  local status=0
  "${GATE[@]}" field "$2" "$3" <"$RUN_DIR/$1.json" >"$RUN_DIR/$1.field" || status=$?
  [ "$status" -ne 2 ] || { cat "$RUN_DIR/$1.field" >>"$LOG"; stop 16 "unreadable or unexpected output in $1.json"; }
  return "$status"
}

need_ack() {
  local phrase="$1"
  [[ "${AIL_ROLLOUT_ACK:-}" == "$phrase" ]] || refuse "set AIL_ROLLOUT_ACK to exactly: $phrase"
}

# verify_target <output name>: the database reached is $REF's (cron jobs call exactly it) and is Kabumori's.
verify_target() {
  sql "$IDENTITY" "$1" || stop 10 "target identity query did not run (see $RUN_DIR/$1.err); nothing written"
  judge "$1" identity "$REF" || stop 10 "target is not verified as $REF; nothing written"
}

# ledger_present <output name>: 0 present, 1 absent (STOP 16 when unreadable, 12 when the query fails).
ledger_present() {
  sql "$PREFLIGHT" "$1" || return 2
  field "$1" preflight '(not r["target_absent"]["schema_ai_ledger_absent"]) or r["target_absent"]["public_ai_ledger_functions"] > 0'
}

# Write steps are single statements or self-checking files whose output is never parsed: every write is judged by a
# separate read-back.
history_sql() {
  local file="$RUN_DIR/history.sql"
  printf '%s\n' "insert into supabase_migrations.schema_migrations (version, name) values ('$VERSION', '$NAME') on conflict (version) do nothing;" >"$file"
  echo "$file"
}

stage_d() {
  sql "$READBACK" readback_after || stop 15 "post-apply read-back failed to run"
  judge readback_after readback none || stop 15 "post-apply read-back mismatch"
  field readback_after readback 'r["history_row"] == 1' || stop 15 "history row is not exactly 1"
}

# Guards that need no database: the exact phrase of a write command, and the migration bytes.
case "$COMMAND" in
  apply)
    need_ack "apply ${VERSION}_${NAME} to $REF"
    actual="$(shasum -a 256 "$MIGRATION" | cut -d' ' -f1)"
    [[ "$actual" == "$MIGRATION_SHA256" ]] || refuse "migration bytes differ from the merged source ($actual)"
    [[ -z "$OPTION" || "$OPTION" == "--resume-history" ]] || refuse "unknown option $OPTION" ;;
  policies) need_ack "insert phase1d test policies into $REF" ;;
  stop) need_ack "disable all ai_ledger policies in $REF" ;;
  rollback) need_ack "drop the empty ai_ledger in $REF" ;;
esac

verify_target identity
case "$COMMAND" in
  check)
    sql "$PREFLIGHT" preflight || stop 16 "preflight did not run (see $RUN_DIR/preflight.err)"
    status=0; judge preflight preflight || status=$?
    sql "$FINGERPRINT" fingerprint || stop 16 "fingerprint did not run"
    "${GATE[@]}" field fingerprint 'r["ai_ledger_rpcs"] >= 0' <"$RUN_DIR/fingerprint.json" >/dev/null || stop 16 "unreadable fingerprint"
    say "fingerprint saved: $RUN_DIR/fingerprint.json" | tee -a "$LOG"
    [ "$status" -eq 0 ] || stop 10 "preflight is NOT_READY"
    say "DONE check: target verified, READY_TO_APPLY" | tee -a "$LOG"
    ;;

  status)
    present=0; ledger_present preflight || present=$?
    case "$present" in
      0) sql "$READBACK" readback || stop 16 "read-back did not run"
         expect=none
         if field readback readback 'r["rows"]["budget_policies"] > 0 and r["rows"]["budget_policies_enabled"] == 0'; then expect=stopped
         elif field readback readback 'r["rows"]["budget_policies"] > 0'; then expect=test; fi
         judge readback readback "$expect" || stop 15 "read-back mismatch" ;;
      1) judge preflight preflight || true; say "ledger absent" ;;
      *) stop 16 "could not classify the target" ;;
    esac
    ;;

  apply)
    if [[ "$OPTION" == "--resume-history" ]]; then
      sql "$READBACK" readback_before_history || stop 10 "read-back did not run"
      judge readback_before_history readback none || stop 10 "schema is not verified; history step refused"
      sql "$(history_sql)" history || stop 14 "history row step failed again"
      stage_d
      say "DONE apply --resume-history" | tee -a "$LOG"
      exit 0
    fi
    # Stage 0: same-run preflight and baseline, then the target identity once more right before the write.
    sql "$PREFLIGHT" stage0_preflight || stop 10 "preflight did not run"
    judge stage0_preflight preflight || stop 10 "preflight is NOT_READY"
    sql "$FINGERPRINT" fingerprint_before || stop 10 "baseline fingerprint did not run"
    field fingerprint_before fingerprint 'r["ai_ledger_rpcs"] == 0' || stop 10 "baseline fingerprint already shows ledger RPCs"
    verify_target identity_before_stage_a
    # Stage A: the exact migration, once.
    say "Stage A: applying ${VERSION}_${NAME} to $REF" | tee -a "$LOG"
    stage_a=0; sql "$MIGRATION" stage_a || stage_a=$?
    present=0; ledger_present after_stage_a || present=$?
    if [ "$stage_a" -ne 0 ]; then
      case "$present" in
        1) stop 11 "Stage A failed and the ledger is absent: nothing changed (see $RUN_DIR/stage_a.err)" ;;
        0) stop 12 "Stage A reported failure but the ledger exists: outcome unknown, do not retry" ;;
        *) stop 12 "Stage A failed and the target could not be classified" ;;
      esac
    fi
    [ "$present" -eq 0 ] || stop 12 "Stage A reported success but the ledger is absent: do not retry; check status"
    # Stage B: catalog read-back before any history row.
    sql "$READBACK" readback_stage_b || stop 12 "read-back after Stage A did not run"
    judge readback_stage_b readback none || stop 13 "read-back after Stage A does not match"
    # Stage C: history row.
    sql "$(history_sql)" history || stop 14 "history row step failed: schema verified, run apply --resume-history"
    # Stage D: read-back with history, and existing business objects unchanged.
    stage_d
    sql "$FINGERPRINT" fingerprint_after || stop 15 "after fingerprint did not run"
    cstatus=0
    "${GATE[@]}" compare "$RUN_DIR/fingerprint_before.json" "$RUN_DIR/fingerprint_after.json" --expect-rpcs 7 >"$RUN_DIR/compare.verdict" || cstatus=$?
    tee -a "$LOG" <"$RUN_DIR/compare.verdict"
    [ "$cstatus" -ne 2 ] || stop 16 "unreadable fingerprint output"
    [ "$cstatus" -eq 0 ] || stop 15 "existing business objects changed between the baseline and now"
    say "DONE apply: ledger present, read back, history row 1, existing objects unchanged (+7 RPCs)" | tee -a "$LOG"
    ;;

  policies)
    sql "$READBACK" readback_before_policies || stop 10 "read-back did not run"
    judge readback_before_policies readback none || stop 10 "ledger not verified, or policies already present"
    sql "$POLICIES" policies || stop 12 "policy step failed (the file refuses when rows exist; check status before anything else)"
    sql "$READBACK" readback_policies || stop 15 "read-back after policies did not run"
    judge readback_policies readback test || stop 15 "policies do not read back exactly"
    say "DONE policies: shared market report (system, Anthropic, Opus 5.5) only" | tee -a "$LOG"
    ;;

  stop)
    file="$RUN_DIR/stop.sql"
    printf '%s\n' "update ai_ledger.budget_policies set enabled = false, updated_at = now() where enabled;" >"$file"
    sql "$file" stop || stop 12 "stop switch did not run: disable the Anthropic key in the Console now"
    sql "$READBACK" readback_stop || stop 15 "read-back after the stop switch did not run"
    field readback_stop readback 'r["rows"]["budget_policies_enabled"] == 0' || stop 15 "policies still enabled"
    say "DONE stop: every policy disabled; every reservation is now refused before any provider request" | tee -a "$LOG"
    ;;

  rollback)
    sql "$READBACK" readback_before_rollback || stop 10 "read-back did not run"
    field readback_before_rollback readback 'r["rows"]["reservations"] == 0 and r["rows"]["usage_events"] == 0 and r["rows"]["billing_observations"] == 0' \
      || stop 10 "the ledger holds rows: export them and decide with ChatGPT and the user first"
    sql "$ROLLBACK" rollback || stop 12 "rollback failed: check status before anything else"
    file="$RUN_DIR/history_delete.sql"
    printf '%s\n' "delete from supabase_migrations.schema_migrations where version = '$VERSION';" >"$file"
    sql "$file" history_delete || stop 14 "history row delete failed"
    sql "$PREFLIGHT" preflight_after_rollback || stop 15 "preflight after rollback did not run"
    judge preflight_after_rollback preflight || stop 15 "target is not back to READY_TO_APPLY"
    field preflight_after_rollback preflight 'not r["history"]["has_20261010050613_ai_ledger"]' || stop 15 "history row still present"
    say "DONE rollback: ledger and history row removed" | tee -a "$LOG"
    ;;
esac
