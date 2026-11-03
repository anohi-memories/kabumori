#!/bin/bash
# G6-27: how POSTONA's AI post assist answers G1's real calls while G5's and G6's SQL are adopted step by step, on the REAL local
# Supabase runtime (no managed project, no paid provider, nothing deployed).
#
# A throw-away local Supabase project (`supabase start`, project id g6pp, ports 558xx) runs the real containers (Postgres 17.6.1.165 with
# the real auth schema, GoTrue ES256 user JWTs, PostgREST, Kong with verify_jwt, the Edge runtime). `supabase functions serve` runs:
#   postona-post-assist-localtest  this tree's handler (G6-26's test-only twin of the real entry: loopback SUPABASE_URL alias, fake provider)
#   postona-post-assist-before     the same twin on G6-26's _shared (PR #582 1a567ea8, read with `git archive`): the "before" of every fix
# The database starts as G5's world only (the G5 Draft chain at 21a5cad4, built as `postgres` as G5's PR #590 runner does). The TEST then
# adopts, as `postgres`, G5's PR #590 candidates (2c8087fc, blob-checked: MVP_INSTALL / W0 install / R1 + W0 grants) and later G6's
# ledger + ai_calls + owner-held SQL, and asks at every stage through G1's PR #592 files (eb8f5e98, blob-checked): the W0 first run
# (domain/personal-workspace.ts), the composer's request and outcome (features/schedule/post-assist.ts) and the client
# (data/post-assist-client.ts), with supabase-js 2.115.0 against the real Kong.
#
# Needs: supabase CLI 2.116.0, a running Docker-API engine with the images below already present (this script never pulls; it refuses
# instead), deno, psql, git with the pinned commits fetched. Everything it starts is stopped and removed at exit.
# G6PP_SRC (optional) = another copy of supabase/functions to serve as "after" (the mutation runs); default: this working tree.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
G5P=2c8087fc71d56b133dc3f6be21ea665cc8d44663   # G5 PR #590 HEAD (W0 + R1-MVP candidates)
G5W=21a5cad4b71de63265db8517da93c6efc60cdde8   # G5's Draft chain world (as G6-26 / G5's runners)
G1=eb8f5e983d2a2a7d4e3716368cf3c20f2ca76370    # G1 PR #592 HEAD
G6B=1a567ea8facd36f20a767c999bd36f59db5d8740   # G6 PR #582 HEAD (G6-26): the "before"
SRC="${G6PP_SRC:-$REPO/supabase/functions}"
ENGINE="${G6LE_ENGINE:-podman}"
API_PORT=55821 DB_PORT=55822 FAKE_PORT=55899

if [ "$(cd "${TMPDIR:-/tmp}" && supabase --version 2>/dev/null | head -1)" != 2.116.0 ]; then   # (outside the repo: the CLI writes supabase/.temp where it runs)
  echo "G6PP_CLI_VERSION: needs supabase CLI 2.116.0 (its image set below)"; exit 2
fi
for image in postgres:17.6.1.165 gotrue:v2.196.0 postgrest:v16.1 kong:2.8.1 edge-runtime:v1.74.3 storage-api:v1.70.3; do
  "$ENGINE" image exists "public.ecr.aws/supabase/$image" || { echo "G6PP_IMAGE_MISSING: $image (this script does not pull)"; exit 2; }
done
for commit in "$G5P" "$G5W" "$G1" "$G6B"; do git -C "$REPO" cat-file -e "$commit^{commit}" || { echo "G6PP_COMMIT_MISSING: $commit (git fetch origin)"; exit 2; }; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/g6pp.XXXXXX")"
SERVE_PID=""
cleanup() {
  [ -n "${G6PP_LOG_DIR:-}" ] && [ -f "$WORK/serve.log" ] && cp "$WORK/serve.log" "$G6PP_LOG_DIR/g6pp_serve.log" || true
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" >/dev/null 2>&1 || true
  (cd "$WORK/p" && supabase stop --no-backup >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- sources (read-only archives, blob-checked) ---------------------------------------------------------------------------------------
mkdir -p "$WORK/p" "$WORK/g5w" "$WORK/g5p" "$WORK/g1" "$WORK/g6b" "$WORK/g6sql"
git -C "$REPO" archive "$G5W" supabase/migrations supabase/tests | tar -x -C "$WORK/g5w"
git -C "$REPO" archive "$G5P" supabase/candidates/postona_personal_mvp_auth | tar -x -C "$WORK/g5p"
git -C "$REPO" archive "$G1" apps/social-mobile/src/data/post-assist-client.ts apps/social-mobile/src/features/schedule/post-assist.ts \
  apps/social-mobile/src/domain/personal-workspace.ts apps/social-mobile/src/domain/service-enrollment.ts | tar -x -C "$WORK/g1"
git -C "$REPO" archive "$G6B" supabase/functions/_shared | tar -x -C "$WORK/g6b"
MVP="$WORK/g5p/supabase/candidates/postona_personal_mvp_auth"
check_blob() { [ "$(git hash-object "$1")" = "$(git -C "$REPO" rev-parse "$2")" ] || { echo "G6PP_BLOB_MISMATCH: $2"; exit 2; }; }
for f in MVP_INSTALL.sql MVP_W0_INSTALL.sql MVP_R1_EXECUTE_GRANT.sql MVP_W0_EXECUTE_GRANT.sql MVP_R1_EXECUTE_REVOKE.sql; do
  check_blob "$MVP/$f" "$G5P:supabase/candidates/postona_personal_mvp_auth/$f"
done
# G5's R1 files are byte for byte PR #569's (the pin G6-26 ran): the W0 stack only adds files
for pair in MVP_INSTALL.sql:eebaabf2629575901947c0664d6f0002526d3273 MVP_R1_EXECUTE_GRANT.sql:9a8a94d159412868ed21968cea385f18188e626e \
            MVP_R1_EXECUTE_REVOKE.sql:aa08f51b05388b1f11cf812430c4ebf59516bc78; do
  [ "$(git hash-object "$MVP/${pair%%:*}")" = "${pair##*:}" ] || { echo "G6PP_G5_R1_CHANGED: ${pair%%:*}"; exit 2; }
done
G1SRC="$WORK/g1/apps/social-mobile/src"
for f in data/post-assist-client.ts features/schedule/post-assist.ts domain/personal-workspace.ts domain/service-enrollment.ts; do
  check_blob "$G1SRC/$f" "$G1:apps/social-mobile/src/$f"
done
for f in migrations/20261010050613_ai_provider_budget_ledger.sql migrations/20261017120000_ai_consumer_call_store.sql migrations/20261017150000_ai_ledger_user_erasure.sql \
         migrations/20261020154536_ai_calls_owner_held_rc_guard.sql candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql; do
  cp "$REPO/supabase/$f" "$WORK/g6sql/"
done

# ---- the local project --------------------------------------------------------------------------------------------------------------
(cd "$WORK/p" && supabase init --force --with-vscode-settings=false --with-intellij-settings=false >/dev/null 2>&1)
python3 -I - "$WORK/p/supabase/config.toml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('project_id = "p"', 'project_id = "g6pp"')
for old, new in [("54321", "55821"), ("54322", "55822"), ("54320", "55820"), ("54329", "55829"), ("54323", "55823"), ("54324", "55824"), ("54327", "55827")]:
    s = s.replace(f"port = {old}", f"port = {new}")
for sec in ["realtime", "studio", "local_smtp", "analytics"]:
    s, n = re.subn(r"(\[%s\]\n(?:#.*\n)*)enabled = true" % re.escape(sec), r"\1enabled = false", s, count=1); assert n == 1, sec
s, n = re.subn(r"(\[db\.seed\]\n(?:#.*\n)*)enabled = true", r"\1enabled = false", s, count=1); assert n == 1
assert 'project_id = "g6pp"' in s
s += '\n[functions.postona-post-assist-localtest]\nverify_jwt = true\n\n[functions.postona-post-assist-before]\nverify_jwt = true\n'
open(p, "w").write(s)
PY
F="$WORK/p/supabase/functions"
mkdir -p "$F/postona-post-assist-localtest" "$F/postona-post-assist-before"
cp -R "$SRC/_shared" "$F/_shared"
cp -R "$WORK/g6b/supabase/functions/_shared" "$F/_shared_g626"
WRAPPER="$REPO/supabase/tests/fixtures/g6_26_local_edge/postona-post-assist-localtest/index.ts"
cp "$WRAPPER" "$F/postona-post-assist-localtest/index.ts"
sed 's#"\.\./_shared/#"../_shared_g626/#' "$WRAPPER" > "$F/postona-post-assist-before/index.ts"
[ "$(diff "$WRAPPER" "$F/postona-post-assist-before/index.ts" | grep -c '^>')" = 1 ] || { echo "G6PP_BEFORE_REWRITE: not exactly 1 line"; exit 2; }
(cd "$WORK/p" && deno check --no-config --cached-only supabase/functions/postona-post-assist-localtest/index.ts supabase/functions/postona-post-assist-before/index.ts >/dev/null 2>&1) \
  || { echo "G6PP_CHECK_FAILED"; exit 2; }

(cd "$WORK/p" && supabase start -x studio,imgproxy,vector,supavisor,mailpit,realtime,logflare,postgres-meta >/dev/null 2>&1) || { echo "G6PP_START_FAILED"; exit 2; }
KEYS="$(cd "$WORK/p" && supabase status -o env 2>/dev/null)"
PUBLISHABLE="$(printf '%s\n' "$KEYS" | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$/\1/p')"
SECRET="$(printf '%s\n' "$KEYS" | sed -n 's/^SECRET_KEY="\(.*\)"$/\1/p')"
case "$PUBLISHABLE:$SECRET" in sb_publishable_*:sb_secret_*) ;; *) echo "G6PP_KEYS_UNEXPECTED"; exit 2 ;; esac

# ---- G5's world on the real schema, as `postgres` (no G5 candidate and no G6 SQL yet: the test adopts them) ------------------------------
export PGPASSWORD=postgres   # the local image's fixed development password (not a secret; nothing here is reachable from outside)
m="$WORK/g5w/supabase/migrations"; t="$WORK/g5w/supabase/tests"
own() { psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres "$@"; }
# A fixture's stand-ins for auth / vault / storage fail on the real schema (the real objects exist; measured lines); anything else must not.
fixture() {
  local name="$1" allowed="$2" got
  got="$(psql -X -q -v ON_ERROR_STOP=0 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -f "$t/$name.sql" 2>&1 | sed -n "s/^psql:.*$name\.sql:\([0-9]*\): ERROR: .*/\1/p" | tr '\n' ' ' | sed 's/ $//')"
  [ "$got" = "$allowed" ] || { echo "G6PP_FIXTURE_UNEXPECTED_ERRORS $name: [$got] expected [$allowed]"; exit 2; }
}
fixture social_mobile_account_deletion_fixture "12 13 16 20 21 22 30 36 39"
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified 20260928160000_social_mobile_account_deletion_candidate; do own -f "$m/$f.sql" >/dev/null; done
fixture common_account_lifecycle_fixture "15 21 26 31 38"
fixture common_account_phase9_auth_fixture "12 13 14 15 16"
own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null 2>&1
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
         20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
         20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
         20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
  own -f "$m/$f.sql" >/dev/null 2>&1
done
# TEST-WORLD stand-in for G3's L-1 revoke (P3), as the earlier runners
own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null

# ---- the functions ------------------------------------------------------------------------------------------------------------------
# maxAttempts 2: a provider 429 (known unsent) is asked once more, after the recheck right before it (the in-flight generation test)
FEATURE='{"enabled":true,"revision":"g6-27-local-1","provider":"openai","model":"gpt-6-luna","reasoningEffort":"low","maxOutputTokens":800,"timeoutMs":20000,"maxAttempts":2,"maxCostUsdPerOperation":0.2,"maxInputBytes":8000,"entitlements":["postona:x_autopost"]}'
ENV_FILE="$WORK/functions.env"
(umask 077; {
  printf 'AI_GATEWAY_SERVICE_KEY=%s\n' "$SECRET"
  printf "POSTONA_POST_ASSIST_FEATURE='%s'\n" "$FEATURE"
  printf 'POSTONA_POST_ASSIST_ALLOWED_ORIGINS=http://localhost:8081\n'
  printf 'OPENAI_API_KEY=test-openai-key-NOT-REAL-0000000000\n'
  printf 'G6LE_FAKE_PROVIDER_URL=http://host.containers.internal:%s\n' "$FAKE_PORT"
} > "$ENV_FILE")
(cd "$WORK/p" && exec supabase functions serve --env-file "$ENV_FILE" >"$WORK/serve.log" 2>&1) &
SERVE_PID=$!
# Ready = both functions themselves answer (G6's own 401 for a request carrying only the publishable apikey); see G6-26 F5.
for fn in postona-post-assist-localtest postona-post-assist-before; do
  ready=""
  for _ in $(seq 1 60); do
    answer="$(curl -s -X POST "http://127.0.0.1:$API_PORT/functions/v1/$fn" -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' -d '{}' || true)"
    [ "$answer" = '{"error":"POST_ASSIST_AUTH_REQUIRED","retry_same_key":false}' ] && { ready=1; break; }
    sleep 2
  done
  [ -n "$ready" ] || { echo "G6PP_SERVE_NOT_READY $fn"; tail -5 "$WORK/serve.log"; exit 2; }
done

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u OPENAI_API_KEY \
    G6PP_API="http://127.0.0.1:$API_PORT" G6PP_PUBLISHABLE="$PUBLISHABLE" G6PP_DB_PORT="$DB_PORT" G6PP_FAKE_PORT="$FAKE_PORT" \
    G6PP_MVP="$MVP" G6PP_G6SQL="$WORK/g6sql" G6PP_G1="$G1SRC" \
  deno test --no-config --cached-only \
    --allow-env=G6PP_API,G6PP_PUBLISHABLE,G6PP_DB_PORT,G6PP_FAKE_PORT,G6PP_MVP,G6PP_G6SQL,G6PP_G1,PGPASSWORD \
    --allow-net="127.0.0.1:$API_PORT,127.0.0.1:$FAKE_PORT" --allow-read="$WORK" --allow-run=psql \
    "$REPO/supabase/tests/postona_post_assist_g5_pin_local_test.ts"
