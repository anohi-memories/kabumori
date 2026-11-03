#!/usr/bin/env bash
# Reproducible focused source integration. No merge, remote/production calls or shared edits.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
tree="$(mktemp -d /private/tmp/h5-wiring-overlay.XXXXXX)"
g4=98287392327eabfd5092a3ba89dde51a2e8beff6
g5=ccea1fe8132c6f573a768f0df5a033a05c62ef2c
git -C "$repo" archive "$g4" supabase apps/social-mobile/src/domain/threads-connect.ts apps/social-mobile/src/domain/threads-manual-publish.ts | tar -x -C "$tree"
[[ ! -e "$tree/supabase/candidates/postona_threads_auth_runtime" ]] || exit 1
git -C "$repo" archive b4fa672f97592e87682671454e868a92098cbd56 \
 supabase/candidates/postona_threads_oauth_workspace_candidate.sql supabase/candidates/postona_threads_edge \
 supabase/functions/_shared/social/threads_connect_rpc_contract.ts | tar -x -C "$tree"
# Copy only H5-owned working source, not .agent/G4/G5 originals or secrets.
(cd "$repo" && tar -cf - supabase/candidates/postona_threads_auth_runtime supabase/functions/threads-oauth-connect-user) | tar -x -C "$tree"
[[ ! -e "$tree/supabase/functions/account-delete/provider_cleanup.ts" ]] || exit 1
git -C "$repo" archive "$g5" supabase/functions/account-delete/provider_cleanup.ts | tar -x -C "$tree"
cd "$tree"
deno test --cached-only --config supabase/candidates/postona_threads_auth_runtime/wiring/deno.json --allow-read=supabase,apps \
 supabase/candidates/postona_threads_auth_runtime/wiring/composed_handler.smoke.ts \
 supabase/candidates/postona_threads_auth_runtime/wiring/source_isolation.smoke.ts
echo "PASS source overlay=$tree G4=$g4 G5=$g5 H5_PARENT=b4fa672f97592e87682671454e868a92098cbd56 + H5-only working diff"
