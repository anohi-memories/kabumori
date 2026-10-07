#!/usr/bin/env bash
# READ-ONLY production preflight / read-back for 20261006230000_common_account_service_start_intent
# (runbook: docs/common-account/phase2-production-apply.md). Same mechanism as
# ../common_account_lifecycle_preflight/run.sh: each ./sql file is exactly one SELECT with catalog /
# aggregate output only (no PII), run against production project wsmznyzcvmuitkglfeuj through the
# Supabase Management API (`supabase db query`), then checked by check.py against expected.json.
#
#   run.sh before                       same-day preflight (01-04); writes out/before-<time>/baseline.json
#   run.sh after <baseline.json>        read-back after Stage A (01-05), history row still absent
#   run.sh after <baseline.json> --history   read-back after Stage C (history row recorded)
#
# Exit code: 0 only when every check passes. Nothing here writes; the CLI's linked mode prints
# "Initialising login role..." (its own temporary login role).
set -u

ref="wsmznyzcvmuitkglfeuj"
here="$(cd "$(dirname "$0")" && pwd)"
mode="${1:-}"
case "$mode" in
  before) ;;
  after) [[ -f "${2:-}" ]] || { echo "usage: run.sh after <baseline.json> [--history]" >&2; exit 2; } ;;
  *) echo "usage: run.sh before | after <baseline.json> [--history]" >&2; exit 2 ;;
esac

# Refuse any file that is not a single read-only SELECT. String literals are removed before the
# keyword scan, so privilege names such as 'EXECUTE' inside has_function_privilege(...) are allowed.
for f in "$here"/sql/*.sql; do
  body="$(sed -e 's/--.*$//' "$f" | sed -e "s/'[^']*'//g")"
  if grep -qiwE 'insert|update|delete|drop|alter|create|truncate|grant|revoke|call|copy|vacuum|analyze|refresh|merge|lock|notify|listen|set|reset|begin|commit|rollback|do|execute|prepare|discard|cluster|reindex|comment|security|import|load' <<<"$body"; then
    echo "REFUSED $(basename "$f"): contains a non-SELECT keyword" >&2
    exit 2
  fi
  if grep -qiE 'decrypted_secret|vault\.|pg_read|pg_ls_|pg_stat_file|dblink|pg_sleep|set_config|nextval|setval|pg_terminate|pg_cancel|pg_advisory|lo_|pg_notify|pg_reload|pg_rotate|pg_switch|pg_create|pg_drop|pg_promote|pg_file|pg_stat_reset|\.query|raw_user_meta|raw_app_meta|email|phone|encrypted_password|identity_data' <<<"$body"; then
    echo "REFUSED $(basename "$f"): touches a forbidden object or column" >&2
    exit 2
  fi
  if [ "$(grep -o ';' <<<"$body" | wc -l | tr -d ' ')" != "1" ]; then
    echo "REFUSED $(basename "$f"): must be exactly one statement" >&2
    exit 2
  fi
done

out="$here/out/$mode-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
fail=0
for f in "$here"/sql/*.sql; do
  n="$(basename "$f" .sql)"
  # The smoke calls helpers that exist only after the apply.
  if [[ "$mode" == before && "$n" == 05_* ]]; then continue; fi
  if supabase db query --linked --project-ref "$ref" --output-format json -f "$f" >"$out/$n.json" 2>"$out/$n.err" \
    && ! grep -q '"_tag":"Error"' "$out/$n.json"; then
    echo "OK    $n"
  else
    echo "FAIL  $n  ($out/$n.json, $out/$n.err)"
    fail=1
  fi
done
[[ $fail == 0 ]] || { echo "STOP: a query failed; nothing was checked"; exit 1; }

echo
if [[ "$mode" == before ]]; then
  python3 "$here/check.py" before "$out"
else
  python3 "$here/check.py" after "$out" "$2" ${3:+"$3"}
fi
