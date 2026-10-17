#!/usr/bin/env bash
# Phase 13 D-3: F4's sandbox preflight refuses until every condition holds (offline, synthetic inputs, nothing printed but names and booleans).
# The F4 script is not in this tree: it is extracted from git at the commit and blob that docs/common-account/phase13-migration-dag.json pins,
# the blob id is verified, and only its pure decision function is called (see the .mjs). No app directory, environment file, network or
# credential is used.
#   bash supabase/tests/common_account_phase13_d3_f4_refusal.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${P13D3_REPO_ROOT:-$(cd "$here/../.." && pwd)}"
commit=60e4a4c059a9d7304e5a48a7b3219ab801e822ae
path=apps/social-mobile/scripts/postona-sandbox-preflight.mjs
pinned=b2ec507904e38e97cafb7928fafd075d71dfdb82

# the pin must be the one the DAG file records (so the DAG file and this wrapper cannot drift apart)
if ! grep -q "$pinned" "$root/docs/common-account/phase13-migration-dag.json" || ! grep -q "$commit" "$root/docs/common-account/phase13-migration-dag.json"; then
  echo "D3_F4_REFUSAL|PIN|FAIL|the DAG file does not pin this blob / commit"; exit 1
fi
gitroot="${P13D3_GIT_ROOT:-$root}"
actual="$(git -C "$gitroot" rev-parse "$commit:$path" 2>/dev/null || true)"
if [ "$actual" != "$pinned" ]; then
  echo "D3_F4_REFUSAL|PIN|FAIL|git does not have the pinned blob (fetch the PR head first)"; exit 1
fi
work="$(mktemp -d "${TMPDIR:-/tmp}/p13d3-f4.XXXXXX")"
trap 'rm -rf "$work"' EXIT
git -C "$gitroot" show "$commit:$path" > "$work/postona-sandbox-preflight.mjs"
echo "D3_F4_REFUSAL|PIN|PASS|blob verified"
node "$here/common_account_phase13_d3_f4_refusal.mjs" "$work/postona-sandbox-preflight.mjs" "$root"
