#!/usr/bin/env bash
# G4-02 #10 (Issue #561): the Threads Meta callback Edge over real local HTTP. No Supabase, no Meta, no Vault, no network
# beyond loopback. Two parts:
#   1. local_http_test.ts: the deployable entry and the gate-lifted handler (non-durable TEST store) served on 127.0.0.1.
#   2. the real supabase/functions/threads-meta-callbacks/index.ts started as its own process (unchanged; Deno's
#      DENO_SERVE_ADDRESS moves its Deno.serve() to 127.0.0.1:$G4MC_PORT) with NO --allow-env and network limited to that
#      one address: every route must answer 503 THREADS_META_CALLBACKS_DISABLED (reading the
#      environment would be refused by Deno, so a 503 DISABLED proves the gate answered before any secret was read) and the
#      process must print nothing but Deno's own "Listening on" line.
# Usage: bash supabase/tests/postona_threads_meta_callbacks_local_http_run.sh   (G4MC_PORT, default 18471, must be free)
#        G4MC_PROCESS_ONLY=1 runs part 2 alone.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
fail=0
pass=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1: expected [$2] got [$3]"; fi
}

if [ "${G4MC_PROCESS_ONLY:-0}" != "1" ]; then # 1 = part 2 alone (its negative control)
  deno test --no-config --cached-only --allow-net=127.0.0.1 supabase/functions/threads-meta-callbacks/local_http_test.ts
fi

PORT="${G4MC_PORT:-18471}"
BASE="http://127.0.0.1:$PORT"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is in use: pick another G4MC_PORT" >&2
  exit 2
fi
LOG="$(mktemp -t g4mc)"
THREADS_APP_SECRET=fake-threads-app-secret-0123456789abcdef \
THREADS_META_DELETION_STATUS_URL=https://postona.example/threads/deletion \
DENO_SERVE_ADDRESS="tcp:127.0.0.1:$PORT" \
  deno run --no-config --cached-only --allow-net="127.0.0.1:$PORT" supabase/functions/threads-meta-callbacks/index.ts >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -f "$LOG"' EXIT
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "$BASE/" 2>/dev/null; then break; fi
  sleep 0.1
done

DISABLED='{"ok":false,"error":"THREADS_META_CALLBACKS_DISABLED"}'
FORM='signed_request=abc.def'
for route in deauthorize data-deletion revoke; do
  out="$(curl -s -w ' %{http_code}' -X POST -H 'content-type: application/x-www-form-urlencoded' --data "$FORM" "$BASE/functions/v1/threads-meta-callbacks/$route")"
  check "index.ts POST $route" "$DISABLED 503" "$out"
done
out="$(curl -s -w ' %{http_code}' "$BASE/functions/v1/threads-meta-callbacks/deletion-status?code=Code0123456789ab")"
check "index.ts GET deletion-status" "$DISABLED 503" "$out"
out="$(curl -s -D - -o /dev/null "$BASE/functions/v1/threads-meta-callbacks/deauthorize" | tr -d '\r' | grep -i '^cache-control:' | tr 'A-Z' 'a-z')"
check "index.ts cache-control" "cache-control: no-store" "$out"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
lines="$(grep -cv "^Listening on http://127.0.0.1:$PORT/$" "$LOG" || true)"
check "index.ts printed nothing of its own" "0" "$lines"
echo "index.ts process checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
