#!/bin/bash
# G1 TASK 49: hold G4's Threads world with G1's loopback gateway for a real iOS Simulator check (scenario 37), after G4's 35 scenarios
# and G1's scenario 36 ran. Nothing here reaches a hosted project or Threads; the gateway binds 127.0.0.1 only.
# Usage: G1T49_RIG_DIR=<empty dir> [G1T49_RIG_PORT=56990] run-threads-native-rig.sh <tree>
#   <tree>: a THROW-AWAY checkout of this branch with G4 PR #664 merged locally (never pushed). Scenarios 36 and 37 are appended to
#   G4's e2e there only. The rig writes <dir>/seed.json (gateway URL, the generated rig password) when ready, and is released by
#   creating <dir>/done; <dir>/final.json and <dir>/requests.log are the evidence. Then G4's runner continues (37 skips).
#   Also needs TB_PGHOST / TB_PGPORT / TB_PGSUPER for G4's runner (a disposable local PostgreSQL 17).
set -u
tree="${1:?usage: run-threads-native-rig.sh <throw-away tree with G4 PR #664 merged>}"
: "${G1T49_RIG_DIR:?G1T49_RIG_DIR (an empty directory for seed / evidence) required}"
here="$(cd "$(dirname "$0")" && pwd)"
e2e="$tree/apps/social-mobile/tests/threads-connect-product-flow.e2e.mjs"
[ "$(cd "$here" && git rev-parse --show-toplevel)" != "$(cd "$tree" && pwd -P)" ] || { echo "refusing: <tree> must be a throw-away checkout"; exit 1; }
grep -q 'G4-02 #17' "$e2e" || { echo "G4 PR #664 (scenario 35) is not in $tree"; exit 1; }
[ -z "$(ls -A "$G1T49_RIG_DIR" 2>/dev/null)" ] || { echo "G1T49_RIG_DIR must be empty"; exit 1; }
grep -q 'G1 TASK 48' "$e2e" || cat "$here/threads-g1-recovery.scenario.mjs" >> "$e2e"
grep -q 'G1 TASK 49' "$e2e" || cat "$here/threads-native-rig.scenario.mjs" >> "$e2e"
cd "$tree" || exit 1
G1T49_RIG_DIR="$G1T49_RIG_DIR" G4T_APP_FLOW=1 G4T_PROFILES="${G4T_PROFILES:-personal}" bash supabase/tests/postona_g4_threads_person_session_run.sh
