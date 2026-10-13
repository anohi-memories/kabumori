#!/bin/bash
# Re-runs every variant and compares with the recorded matrix (expected_matrix.txt). Exit 1 on any difference.
# Usage: check_expected.sh <psql args...>   (throwaway local Postgres only)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
actual="$(mktemp)"
while read -r variant; do
  echo "## $variant"
  VARIANT="$variant" "$here/run_matrix.sh" "$@" | grep -E '^u[0-9]'
done < "$here/variants.txt" > "$actual"
diff -u "$here/expected_matrix.txt" "$actual" && echo "J1-b matrix: all variants match the recorded expectation"
