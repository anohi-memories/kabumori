#!/usr/bin/env bash
# G4-02 #11 (Issue #561): the deployable manual publish entry, supabase/functions/social-mobile-threads-publish/index.ts, started
# unchanged as its own process (Deno's DENO_SERVE_ADDRESS moves its Deno.serve() to 127.0.0.1:$G4PG_PORT) with NO --allow-env
# and network limited to that one address. Every action must answer 503 THREADS_PUBLISH_DISABLED: reading the environment
# would be refused by Deno, so the answer proves the static gate closed the door before any secret, store or provider was
# touched. It must print nothing but Deno's "Listening on" line. No Supabase, no Threads, no Vault.
# Usage: bash supabase/tests/postona_g4_threads_publish_process_gate_run.sh   (G4PG_PORT, default 18472, must be free)
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT" || exit 1
fail=0
pass=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1: expected [$2] got [$3]"; fi
}
PORT="${G4PG_PORT:-18472}"
BASE="http://127.0.0.1:$PORT/functions/v1/social-mobile-threads-publish"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is in use: pick another G4PG_PORT" >&2
  exit 2
fi
LOG="$(mktemp -t g4pg)"
SUPABASE_URL=https://flow.supabase.test SUPABASE_ANON_KEY=sb_publishable_flow_fake_0123456789 \
THREADS_PUBLISH_ATTESTATION_KEY=fake_publish_attestation_key_0123456789abcdef0123456789 \
DENO_SERVE_ADDRESS="tcp:127.0.0.1:$PORT" \
  deno run --no-config --cached-only --allow-net="127.0.0.1:$PORT" supabase/functions/social-mobile-threads-publish/index.ts >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -f "$LOG"' EXIT
for _ in $(seq 1 50); do
  if curl -s -o /dev/null -X OPTIONS "$BASE" 2>/dev/null; then break; fi
  sleep 0.1
done

DISABLED='{"success":false,"error":"THREADS_PUBLISH_DISABLED"} 503'
TOKEN='eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2ln'
for body in \
  '{"action":"publish","social_account_id":"sa_0123456789abcdef01234567","idempotency_key":"6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b","text":"gate"}' \
  '{"action":"account_state","social_account_id":"sa_0123456789abcdef01234567"}' \
  '{"action":"set_permission","social_account_id":"sa_0123456789abcdef01234567","desired_enabled":true,"expected_current_enabled":false}' \
  '{"action":"reconcile","attempt_id":"6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b"}'; do
  action="$(sed -E 's/^\{"action":"([a-z_]+)".*$/\1/' <<<"$body")"
  out="$(curl -s -w ' %{http_code}' -X POST -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" --data "$body" "$BASE")"
  check "index.ts POST $action" "$DISABLED" "$out"
done
out="$(curl -s -w ' %{http_code}' -X POST -H 'content-type: application/json' --data '{}' "$BASE")"
check "index.ts POST without a token" "$DISABLED" "$out"
out="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE")"
check "index.ts OPTIONS (CORS preflight only)" "204" "$out"
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
lines="$(grep -cv "^Listening on http://127.0.0.1:$PORT/$" "$LOG" || true)"
check "index.ts printed nothing of its own" "0" "$lines"
echo "publish index.ts process checks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
