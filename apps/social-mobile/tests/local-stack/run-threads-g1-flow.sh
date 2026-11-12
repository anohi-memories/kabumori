#!/bin/bash
# G1 TASK 48: G1's Threads card inputs on G4's local runtime (disposable PostgreSQL 17 + the real publish / connect Edge in Deno +
# fake Threads / GoTrue / PostgREST, 127.0.0.1 only). Nothing here reaches a hosted project or Threads.
# Usage: run-threads-g1-flow.sh <tree>
#   <tree> is a THROW-AWAY checkout of this branch with G4 PR #664 merged locally (never pushed). This script appends
#   threads-g1-recovery.scenario.mjs (scenario 36) to G4's threads-connect-product-flow.e2e.mjs in that tree only, then runs G4's
#   runner for the personal profile (G4T_APP_FLOW=1). G4's files in this repository and in any PR are not changed.
# Needs what G4's runner needs: Homebrew PostgreSQL 17, deno with the wiring cache, node, and `npm ci` in <tree>/apps/social-mobile.
set -u
tree="${1:?usage: run-threads-g1-flow.sh <throw-away tree with G4 PR #664 merged>}"
here="$(cd "$(dirname "$0")" && pwd)"
e2e="$tree/apps/social-mobile/tests/threads-connect-product-flow.e2e.mjs"
runner="$tree/supabase/tests/postona_g4_threads_person_session_run.sh"
[ "$(cd "$tree" && git rev-parse --show-toplevel)" = "$(cd "$tree" && pwd -P)" ] || { echo "not a checkout: $tree"; exit 1; }
[ "$(cd "$here" && git rev-parse --show-toplevel)" != "$(cd "$tree" && pwd -P)" ] || { echo "refusing: <tree> must be a throw-away checkout, not this one"; exit 1; }
grep -q 'G4-02 #17' "$e2e" || { echo "G4 PR #664 (scenario 35) is not in $tree"; exit 1; }
[ -f "$runner" ] || { echo "no G4 runner in $tree"; exit 1; }
grep -q 'G1 TASK 48' "$e2e" || cat "$here/threads-g1-recovery.scenario.mjs" >> "$e2e"
cd "$tree" || exit 1
G4T_APP_FLOW=1 G4T_PROFILES="${G4T_PROFILES:-personal}" bash "$runner"
