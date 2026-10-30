#!/bin/bash
# Mutation check for the observer pause gate: weakens the gate one way per run in a COPY of supabase/functions and requires
# pause_gate_test.ts to FAIL. A control (unmutated copy) must pass first. Nothing in the repository is modified.
set -uo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
work="/private/tmp/claude-501/f8-observer-mutation"
rm -rf "/private/tmp/claude-501/f8-observer-mutation"
mkdir -p "$work"
work="$(cd "$work" && pwd -P)"
MISSED=0
copy() { mkdir -p "$work/$1/supabase/functions" && cp -R "$repo/supabase/functions/." "$work/$1/supabase/functions/"; }
runtest() { (cd "$work/$1" && deno test --no-config --no-lock --node-modules-dir=none --allow-read="$work/$1" --allow-run --allow-env --no-check supabase/functions/news-discovery-observer/pause_gate_test.ts >/dev/null 2>&1); }
# mutant <name> <file> <old> <new> [<file2> <old2> <new2>]
mutant() {
  local name="$1"; shift
  copy "$name"
  python3 - "$work/$name/supabase/functions/news-discovery-observer" "$@" <<'PYEOF' || { echo "ERROR $name: anchor not found"; MISSED=1; return; }
import sys
base = sys.argv[1]
args = sys.argv[2:]
for i in range(0, len(args), 3):
    path, old, new = args[i], args[i + 1], args[i + 2]
    text = open(f"{base}/{path}").read()
    if text.count(old) != 1:
        raise SystemExit(f"anchor must match once, got {text.count(old)}: {old[:50]!r}")
    open(f"{base}/{path}", "w").write(text.replace(old, new))
PYEOF
  if runtest "$name"; then echo "NOT DETECTED  $name"; MISSED=1; else echo "detected      $name"; fi
}
copy control
if runtest control; then echo "control (unmutated copy) passes"; else echo "control FAILED: the harness cannot run the unmutated copy"; exit 1; fi
mutant remove_entry_gate observer_handler.ts '    if (pause !== "running") {' '    if (false) {'
mutant pause_check_not_wired index.ts '  pauseCheck: () => enforceNewsPauseEntry(supabaseUrl, serviceRoleKey, fetch),
' ''
mutant remove_egress_guard index.ts 'installNewsPauseGuard();

const supabaseUrl' '
const supabaseUrl'
mutant guard_installed_after_capture index.ts 'installNewsPauseGuard();

const supabaseUrl' 'const supabaseUrl' index.ts '  pauseCheck: () => enforceNewsPauseEntry(supabaseUrl, serviceRoleKey, fetch),
}));' '  pauseCheck: () => enforceNewsPauseEntry(supabaseUrl, serviceRoleKey, fetch),
}));
installNewsPauseGuard();'
mutant guard_never_refuses pause_gate.ts '        throw new NewsPausedError(state === "running" ? "paused" : state);' '        return await options.fetchImpl(input, init);'
mutant accept_missing_or_null pause_gate.ts 'return rows[0]?.is_active === true ? "running" : "paused";' 'return rows[0]?.is_active !== false ? "running" : "paused";'
mutant unreadable_is_running pause_gate.ts '    } catch {
      return "unreadable";
    }
  })();' '    } catch {
      return "running";
    }
  })();'
mutant read_deadline_removed pause_gate.ts '    return await Promise.race([read, deadline]);' '    return await read;'
mutant stale_true_not_fenced pause_gate.ts '      return stopped <= startSequence;' '      return true;'
mutant entry_stop_not_recorded pause_gate.ts '  if (!coordinator.complete(mine, state)) return state === "running" ? "paused" : state;
  return "running";' '  return state;'
mutant egress_uses_private_coordinator pause_gate.ts '    coordinator: sharedPauseCoordinator,
' ''
mutant database_writes_pass_guard pause_gate.ts '  if (verb !== "GET" && verb !== "HEAD") return false;' '  if (verb === "") return false;'
if [ "$MISSED" = "0" ]; then echo "observer mutation check: all mutants detected"; else echo "observer mutation check: PROBLEM (see above)"; exit 1; fi
