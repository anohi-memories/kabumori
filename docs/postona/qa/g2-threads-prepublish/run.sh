#!/usr/bin/env bash
# G2 QA runner: composes G3's dispatcher (PR #356, pinned commit) with G4's send port (this branch, PR #359 base) offline.
# No network permission is granted; G3's file is read from git at its pinned commit into a temp dir.
set -euo pipefail
G3_COMMIT="${G3_COMMIT:-12fcba7e076e467595ae58d93af05cb09e354c6a}"
root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$root" cat-file -e "$G3_COMMIT" 2>/dev/null || git -C "$root" fetch -q origin "$G3_COMMIT"
git -C "$root" show "$G3_COMMIT:supabase/functions/_shared/postona_reservations/threads_dispatch.ts" > "$tmp/threads_dispatch.ts"
cd "$root"
G3_DISPATCH_PATH="$tmp/threads_dispatch.ts" deno test --no-config --cached-only --no-check \
  --allow-read="$root,$tmp" --allow-env=G3_DISPATCH_PATH \
  docs/postona/qa/g2-threads-prepublish/g2_threads_prepublish_boundary_test.ts "$@"
