#!/usr/bin/env bash
# F4 R2c seam runner: this checkout's POSTONA service-end client against F5 PR #193's ACTUAL lifecycle handlers.
# Extracts supabase/functions/account-delete and supabase/functions/social-mobile-account-delete from the exact F5
# commit READ-ONLY (git archive) into a throwaway /private/tmp directory, runs postona-end-f5.seam.mjs with node, and
# deletes the extraction. Nothing is checked out, merged or pushed. Requires the git objects of the F5 commit
# (git fetch origin claude/f5-phase8-x-threads-lifecycle-integrated-security-20261013) and this app's node_modules.
# Usage (from anywhere): apps/social-mobile/tests/seam/run-postona-end-f5-seam.sh [F5_COMMIT]
set -euo pipefail
export LC_ALL=C
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
f5="${1:-314aeac47a02ce80aea3d94426a563dfbe57ad7c}"
git -C "$repo" cat-file -e "${f5}^{commit}" 2>/dev/null || { echo "FAIL missing git objects for $f5" >&2; exit 1; }
tmp="$(mktemp -d /private/tmp/kabumori-f4-r2c-seam.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
git -C "$repo" archive "$f5" -- supabase/functions/account-delete supabase/functions/social-mobile-account-delete | tar -x -C "$tmp"
echo "F5 $f5 account-delete: $(cd "$tmp/supabase/functions/account-delete" && cat lifecycle_logic.ts fake_lifecycle.ts | shasum -a 256 | cut -c1-16)"
cd "$here/../.."
F5_DIR="$tmp" node --test tests/seam/postona-end-f5.seam.mjs
