#!/usr/bin/env bash
# x-test-post caller compatibility proof (G3 Issue #318 TASK 5/50). OFFLINE: copies supabase/functions twice into a
# temporary directory -- once with index.ts as on main (BEFORE PR #349), once as in this branch (AFTER) -- and runs the
# deny-net matrix against each real handler, then the rollout-model tests. No network, no database, no secrets.
# Usage: caller_compat_run.sh [<git ref of the BEFORE index.ts, default origin/main>]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
before_ref="${1:-origin/main}"
tmp="$(mktemp -d /private/tmp/xtp-compat.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
for v in main pr349; do
  mkdir -p "$tmp/$v/supabase"
  cp -R "$repo/supabase/functions" "$tmp/$v/supabase/functions"
done
git -C "$repo" show "$before_ref:supabase/functions/x-test-post/index.ts" > "$tmp/main/supabase/functions/x-test-post/index.ts"
grep -q "authorizeXTestPostCaller" "$tmp/main/supabase/functions/x-test-post/index.ts" && { echo "FAIL the BEFORE ref already has the gate"; exit 1; }
grep -q "authorizeXTestPostCaller" "$tmp/pr349/supabase/functions/x-test-post/index.ts" || { echo "FAIL this branch lacks PR #349's gate"; exit 1; }
for v in main pr349; do
  if ! XTP_INDEX="$tmp/$v/supabase/functions/x-test-post/index.ts" XTP_VERSION="$v" XTP_MATRIX_OUT="$tmp/matrix_$v.json" DENO_NO_PACKAGE_JSON=1 \
    deno test --no-config --no-check --no-lock --allow-read --allow-write="$tmp" --allow-env "$here/caller_compat_matrix_test.ts" >"$tmp/out_$v" 2>&1; then
    cat "$tmp/out_$v"; echo "FAIL matrix $v"; exit 1
  fi
  grep -E "passed|failed" "$tmp/out_$v" | tail -1
  echo "MATRIX_${v}_PASS"
done
DENO_NO_PACKAGE_JSON=1 deno test --no-config --no-lock --allow-read "$here/rollout_model_test.ts" >"$tmp/out_model" 2>&1 || { cat "$tmp/out_model"; echo "FAIL rollout model"; exit 1; }
grep -E "passed|failed" "$tmp/out_model" | tail -1
echo "ROLLOUT_MODEL_PASS"
if [[ -n "${XTP_MATRIX_KEEP:-}" ]]; then cp "$tmp"/matrix_*.json "$XTP_MATRIX_KEEP"/; fi
echo "X_TEST_POST_CALLER_COMPAT_ALL_PASS"
