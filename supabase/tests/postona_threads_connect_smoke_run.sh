#!/usr/bin/env bash
# G4/F4 POSTONA Threads CONNECT + CLEANUP composite smoke (TypeScript only; no database, no network).
#
# Builds a throwaway combined source tree under /private/tmp from this checkout's working tree (HEAD plus
# local edits) and BOUNDED, READ-ONLY copies of the exact protected candidates:
#   PR #124 c30f246409a77080cbc03aef6c4cb72b5481e125   (G4 OAuth/workspace SQL + RPC contract)
#   PR #135 e38788d6677082138f0990453c7d2f00549666d0   (H1 mock OAuth Edge)
#   PR #159 163675c62835e84417905f98f97ceedd4dd1bcd9   (H5 runtime + verifier, latest; stacked on PR #139)
#   PR #152 ccea1fe8132c6f573a768f0df5a033a05c62ef2c   (G5 provider cleanup port, H4-P4-R1 lease repair:
#                                                       provider_cleanup.ts only)
# Nothing is merged, checked out or pushed; an overlay path that already exists stops the run. Then runs
# supabase/candidates/postona_threads_integration/connect_cleanup_smoke.ts there with deno test (fakes only).
# Requires the git objects of the four SHAs. Usage: supabase/tests/postona_threads_connect_smoke_run.sh
set -euo pipefail
export LC_ALL=C
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
fail() { echo "FAIL $*" >&2; exit 1; }
PR124=c30f246409a77080cbc03aef6c4cb72b5481e125
PR135=e38788d6677082138f0990453c7d2f00549666d0
PR159=163675c62835e84417905f98f97ceedd4dd1bcd9
PR152=ccea1fe8132c6f573a768f0df5a033a05c62ef2c
for sha in "$PR124" "$PR135" "$PR159" "$PR152"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done
tree="$(mktemp -d /private/tmp/kabumori-threads-conn.XXXXXX)"
trap 'if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi' EXIT
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/INTEGRATION_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $path" >> "$tree/INTEGRATION_MANIFEST.txt"; done
}
overlay "$PR124" supabase/functions/_shared/social/threads_connect_rpc_contract.ts
overlay "$PR135" supabase/candidates/postona_threads_edge
overlay "$PR159" supabase/candidates/postona_threads_auth_runtime supabase/functions/threads-oauth-connect-user
overlay "$PR152" supabase/functions/account-delete/provider_cleanup.ts
cd "$tree"
deno test --no-config --no-lock --allow-env --allow-read supabase/candidates/postona_threads_integration/connect_cleanup_smoke.ts > "$tree/smoke.log" 2>&1 \
  || { tail -30 "$tree/smoke.log" >&2; fail "connect_cleanup_smoke.ts"; }
grep -q G4_CONNECT_SMOKE_PASS "$tree/smoke.log" && grep -q G4_CLEANUP_PORT_SMOKE_PASS "$tree/smoke.log" || fail "smoke markers missing"
cat "$tree/INTEGRATION_MANIFEST.txt"
echo "ALL PASS (connect contract x H5 runtime, cleanup adapter x G5 port; fakes only. NOT_RUN: real Meta, owner transport, managed Supabase, app link)"
