#!/usr/bin/env bash
# READ-ONLY production preflight / read-back bundle for 20261001150000_common_account_lifecycle_foundation
# (see ../common_account_lifecycle_rollout.md). Run before the apply (Phase A) and again after it (read-back).
#
# Runs each file in ./sql (exactly one SELECT, catalog / aggregate output only, no PII)
# against production project wsmznyzcvmuitkglfeuj through the Supabase Management API
# (`supabase db query`). The query text writes nothing; note that the CLI's linked mode prints
# "Initialising login role..." (its own temporary login role). Results land in ./out as JSON (git-ignored).
#
# Usage: bash supabase/tests/common_account_lifecycle_preflight/run.sh      (all files)
#        bash supabase/tests/common_account_lifecycle_preflight/run.sh 03   (only files whose name starts with 03)
set -u

ref="wsmznyzcvmuitkglfeuj"
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/out"
mkdir -p "$out"

# Refuse any file that is not a single read-only SELECT. String literals are removed before the
# keyword scan, so privilege names such as 'UPDATE' inside has_table_privilege(...) are allowed.
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

only="${1:-}"
ok=0
fail=0
for f in "$here"/sql/*.sql; do
  n="$(basename "$f" .sql)"
  if [ -n "$only" ] && [ "${n#"$only"}" = "$n" ]; then
    continue
  fi
  if supabase db query --linked --project-ref "$ref" --output-format json -f "$f" >"$out/$n.json" 2>"$out/$n.err" \
    && ! grep -q '"_tag":"Error"' "$out/$n.json"; then
    echo "OK    $n"
    ok=$((ok + 1))
  else
    echo "FAIL  $n  (out/$n.json, out/$n.err)"
    fail=$((fail + 1))
  fi
done

echo
echo "done: ok=$ok fail=$fail  ->  $out"
