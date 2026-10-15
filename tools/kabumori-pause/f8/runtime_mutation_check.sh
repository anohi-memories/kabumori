#!/bin/bash
# Mutation check for the F8 runtime candidate: copies the function sources to a temp dir, weakens the gate in one way per
# run, and requires pause_gate_test.ts to FAIL. Nothing in the repository is modified; no network, no database.
set -uo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
base="$(cd "$(mktemp -d)" && pwd -P)"
run_mutant() {
  local name="$1" file="$2" old="$3" new="$4"
  local dir="$base/$name"
  mkdir -p "$dir/supabase/functions"
  cp -R "$repo/supabase/functions/." "$dir/supabase/functions/"
  python3 - "$dir/supabase/functions/important-news-monitor/$file" "$old" "$new" <<'PYEOF'
import sys
path, old, new = sys.argv[1:4]
text = open(path).read()
if text.count(old) != 1:
    raise SystemExit(f"mutation anchor must match once, got {text.count(old)}")
open(path, "w").write(text.replace(old, new))
PYEOF
  [ $? -eq 0 ] || { echo "ERROR $name: could not apply mutation"; return; }
  if (cd "$dir" && deno test --no-config --no-lock --node-modules-dir=none --allow-read="$dir" --allow-run --allow-env --no-check supabase/functions/important-news-monitor/pause_gate_test.ts >/dev/null 2>&1); then
    echo "NOT DETECTED  $name"; MISSED=1
  else
    echo "detected      $name"
  fi
}
MISSED=0
# control: an identity edit must PASS in this harness (otherwise "detected" below could just mean "the copy cannot run")
control_dir="$base/control"; mkdir -p "$control_dir/supabase/functions"
cp -R "$repo/supabase/functions/." "$control_dir/supabase/functions/"
if (cd "$control_dir" && deno test --no-config --no-lock --node-modules-dir=none --allow-read="$control_dir" --allow-run --allow-env --no-check supabase/functions/important-news-monitor/pause_gate_test.ts >/dev/null 2>&1); then
  echo "control (unmutated copy) passes"
else
  echo "control FAILED: the harness cannot run the unmutated copy"; rm -rf "$base"; exit 1
fi
run_mutant remove_entry_gate index.ts '  if (pauseState !== "running") {' '  if (false) {'
run_mutant remove_egress_guard index.ts 'installNewsPauseGuard();' '// removed'
run_mutant guard_never_refuses pause_gate.ts '        throw new NewsPausedError(state);' '        return await options.fetchImpl(input, init);'
run_mutant accept_missing_or_null pause_gate.ts 'return rows[0]?.is_active === true ? "running" : "paused";' 'return rows[0]?.is_active !== false ? "running" : "paused";'
run_mutant unreadable_is_running pause_gate.ts '    } catch {
      return "unreadable";
    }
  })();' '    } catch {
      return "running";
    }
  })();'
run_mutant database_writes_pass_the_guard pause_gate.ts '  if (verb !== "GET" && verb !== "HEAD") return false;' '  if (verb === "") return false;'
run_mutant no_config_allows pause_gate.ts '    if (!config) throw new NewsPausedError("unreadable");' '    if (!config) return await options.fetchImpl(input, init);'
# J2-R1 mutants: the stale-true fence, the hard read deadline and the cache fence
run_mutant stale_true_not_fenced pause_gate.ts '      if (stopSequence > mine) {' '      if (false) {'
run_mutant read_deadline_removed pause_gate.ts '    return await Promise.race([read, deadline]);' '    return await read;'
# (the cache fence `cache.sequence > stopSequence` is defence in depth next to `cache = null` on every stop; removing only
#  one of the two is an equivalent mutant, so it is intentionally not listed)
run_mutant stop_observation_not_recorded pause_gate.ts '        stopSequence = Math.max(stopSequence, mine);' '        void mine;'
rm -rf "$base"
if [ "$MISSED" = "0" ]; then echo "runtime mutation check: all mutants detected"; else echo "runtime mutation check: SOME MUTANTS NOT DETECTED"; exit 1; fi
