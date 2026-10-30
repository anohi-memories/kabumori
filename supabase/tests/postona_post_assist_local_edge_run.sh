#!/bin/bash
# G6-26: POSTONA's AI post assist on the REAL local Supabase runtime (no managed project, no paid provider, nothing deployed).
#
# A throw-away local Supabase project (`supabase start`, project id g6le, ports 556xx) runs the real containers: Postgres 17.6.1.165 with
# the real auth schema, GoTrue (real ES256 user JWTs with session_id / is_anonymous), PostgREST, Kong (verify_jwt) and the Edge runtime.
# `supabase functions serve` runs two functions there:
#   postona-post-assist            the real entry, unchanged (index.ts at this commit)
#   postona-post-assist-localtest  the same handler, given a loopback SUPABASE_URL alias and a fake provider (tests/fixtures/g6_26_local_edge)
# On that database: G5's world (the G5 Draft chain at 21a5cad4, as PR #563's runner builds it; the fixtures' stand-ins for auth / vault /
# storage fail on the real schema and only those known statements may fail), G5-50's source pin (PR #569, read with `git archive`,
# blob-checked) MVP_INSTALL.sql run by a non-superuser lifecycle owner (BYPASSRLS and auth-table privileges like the image's `postgres`),
# and G6's ledger + ai_calls + owner-held SQL run as `postgres`. The G1 client is PR #576's own file (blob-checked), run by the test with
# supabase-js 2.115.0 (the app's locked version) against the real Kong.
#
# Needs: supabase CLI 2.116.0, a running Docker-API engine with the images below already present (this script never pulls; it refuses
# instead), deno, psql, git. Everything it starts is stopped and removed at exit (`supabase stop --no-backup`).
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
G5M=5c882f01f262e5ccdecbc967da4f8dfbaaaff0e0   # G5 PR #569 HEAD (G5-50's pinned source)
G5W=21a5cad4b71de63265db8517da93c6efc60cdde8   # G5's Draft chain world (as PR #563's runner)
G1=8d95307c7001a6456719c6a829ef41a83ab703c3    # G1 PR #576 HEAD
ENGINE="${G6LE_ENGINE:-podman}"
API_PORT=55621 DB_PORT=55622 FAKE_PORT=55699

[ "$(cd "${TMPDIR:-/tmp}" && supabase --version 2>/dev/null | head -1)" = 2.116.0 ]   # (outside the repo: the CLI writes supabase/.temp where it runs) || { echo "G6LE_CLI_VERSION: needs supabase CLI 2.116.0 (its image set below)"; exit 2; }
for image in postgres:17.6.1.165 gotrue:v2.196.0 postgrest:v16.1 kong:2.8.1 edge-runtime:v1.74.3 storage-api:v1.70.3; do
  "$ENGINE" image exists "public.ecr.aws/supabase/$image" || { echo "G6LE_IMAGE_MISSING: $image (this script does not pull)"; exit 2; }
done
for commit in "$G5M" "$G5W" "$G1"; do git -C "$REPO" cat-file -e "$commit^{commit}"; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/g6le.XXXXXX")"
SERVE_PID=""
cleanup() {
  [ -n "${G6LE_LOG_DIR:-}" ] && [ -f "$WORK/serve.log" ] && cp "$WORK/serve.log" "$G6LE_LOG_DIR/g6le_serve.log" || true
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" >/dev/null 2>&1 || true
  (cd "$WORK/p" && supabase stop --no-backup >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- the local project --------------------------------------------------------------------------------------------------------------
mkdir -p "$WORK/p" "$WORK/g5w" "$WORK/g5m" "$WORK/g1"
(cd "$WORK/p" && supabase init --force --with-vscode-settings=false --with-intellij-settings=false >/dev/null 2>&1)
python3 -I - "$WORK/p/supabase/config.toml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('project_id = "p"', 'project_id = "g6le"')
for old, new in [("54321", "55621"), ("54322", "55622"), ("54320", "55620"), ("54329", "55629"), ("54323", "55623"), ("54324", "55624"), ("54327", "55627")]:
    s = s.replace(f"port = {old}", f"port = {new}")
for sec in ["realtime", "studio", "local_smtp", "analytics"]:
    s, n = re.subn(r"(\[%s\]\n(?:#.*\n)*)enabled = true" % re.escape(sec), r"\1enabled = false", s, count=1); assert n == 1, sec
s, n = re.subn(r"(\[db\.seed\]\n(?:#.*\n)*)enabled = true", r"\1enabled = false", s, count=1); assert n == 1
s, n = re.subn(r"enable_anonymous_sign_ins = false", "enable_anonymous_sign_ins = true", s, count=1); assert n == 1
assert 'project_id = "g6le"' in s
s += '\n[functions.postona-post-assist]\nverify_jwt = true\n\n[functions.postona-post-assist-localtest]\nverify_jwt = true\n'
open(p, "w").write(s)
PY
mkdir -p "$WORK/p/supabase/functions/postona-post-assist-localtest"
cp -R "$REPO/supabase/functions/postona-post-assist" "$REPO/supabase/functions/_shared" "$WORK/p/supabase/functions/"   # the working tree, as every runner here
cp "$REPO/supabase/tests/fixtures/g6_26_local_edge/postona-post-assist-localtest/index.ts" "$WORK/p/supabase/functions/postona-post-assist-localtest/index.ts"
# the wrapper's imports resolve only next to _shared: type-check both entries where they are served
(cd "$WORK/p" && deno check --no-config --cached-only supabase/functions/postona-post-assist/index.ts supabase/functions/postona-post-assist-localtest/index.ts >/dev/null 2>&1) \
  || { echo "G6LE_CHECK_FAILED"; exit 2; }

git -C "$REPO" archive "$G5W" supabase/migrations supabase/tests | tar -x -C "$WORK/g5w"
git -C "$REPO" archive "$G5M" supabase/candidates/postona_personal_mvp_auth | tar -x -C "$WORK/g5m"
git -C "$REPO" archive "$G1" apps/social-mobile/src/data/post-assist-client.ts | tar -x -C "$WORK/g1"
MVP="$WORK/g5m/supabase/candidates/postona_personal_mvp_auth"
for pair in MVP_INSTALL.sql:eebaabf2629575901947c0664d6f0002526d3273 MVP_R1_EXECUTE_GRANT.sql:9a8a94d159412868ed21968cea385f18188e626e \
            MVP_R1_EXECUTE_REVOKE.sql:aa08f51b05388b1f11cf812430c4ebf59516bc78; do
  [ "$(git hash-object "$MVP/${pair%%:*}")" = "${pair##*:}" ] || { echo "G6LE_G5_BLOB_MISMATCH: ${pair%%:*}"; exit 2; }
done
G1_CLIENT="$WORK/g1/apps/social-mobile/src/data/post-assist-client.ts"
[ "$(git hash-object "$G1_CLIENT")" = "$(git -C "$REPO" rev-parse "$G1:apps/social-mobile/src/data/post-assist-client.ts")" ]

(cd "$WORK/p" && supabase start -x studio,imgproxy,vector,supavisor,mailpit,realtime,logflare,postgres-meta >/dev/null 2>&1) || { echo "G6LE_START_FAILED"; exit 2; }
KEYS="$(cd "$WORK/p" && supabase status -o env 2>/dev/null)"
PUBLISHABLE="$(printf '%s\n' "$KEYS" | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$/\1/p')"
SECRET="$(printf '%s\n' "$KEYS" | sed -n 's/^SECRET_KEY="\(.*\)"$/\1/p')"
case "$PUBLISHABLE:$SECRET" in sb_publishable_*:sb_secret_*) ;; *) echo "G6LE_KEYS_UNEXPECTED"; exit 2 ;; esac

# ---- G5's world on the real schema --------------------------------------------------------------------------------------------------
export PGPASSWORD=postgres   # the local image's fixed development password (not a secret; nothing here is reachable from outside)
ADMIN=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U supabase_admin -d postgres)
"${ADMIN[@]}" >/dev/null <<'SQL'
create role g6le_owner login password 'postgres' nosuperuser nocreatedb createrole bypassrls;
grant anon, authenticated, service_role to g6le_owner;
grant create on database postgres to g6le_owner;
grant usage, create on schema public to g6le_owner;
grant usage on schema auth to g6le_owner;
grant all on auth.users, auth.sessions, auth.identities to g6le_owner;
SQL
m="$WORK/g5w/supabase/migrations"; t="$WORK/g5w/supabase/tests"
own() { psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U g6le_owner -d postgres "$@"; }
# A fixture's stand-ins for auth / vault / storage may fail on the real schema (the real objects exist); anything else must not.
fixture() {
  local name="$1" allowed="$2" got
  got="$(psql -X -q -v ON_ERROR_STOP=0 -h 127.0.0.1 -p "$DB_PORT" -U g6le_owner -d postgres -f "$t/$name.sql" 2>&1 | sed -n "s/^psql:.*$name\.sql:\([0-9]*\): ERROR: .*/\1/p" | tr '\n' ' ' | sed 's/ $//')"
  [ "$got" = "$allowed" ] || { echo "G6LE_FIXTURE_UNEXPECTED_ERRORS $name: [$got] expected [$allowed]"; exit 2; }
}
fixture social_mobile_account_deletion_fixture "12 13 16 20 21 22 30 36 39"
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified 20260928160000_social_mobile_account_deletion_candidate; do own -f "$m/$f.sql" >/dev/null; done
fixture common_account_lifecycle_fixture "15 21 26 31 38"
fixture common_account_phase9_auth_fixture "12 13 14 15 16"
own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
         20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
         20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
         20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
  own -f "$m/$f.sql" >/dev/null
done
# TEST-WORLD stand-in for G3's L-1 revoke (P3), as PR #563's runner. auth.uid() is the image's own (no override here).
own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
own -f "$MVP/MVP_INSTALL.sql" >/dev/null

# ---- G6's ledger side, as `postgres` (the role Supabase migrations run as) ----------------------------------------------------------
PG=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres)
for f in migrations/20261010050613_ai_provider_budget_ledger.sql migrations/20261017120000_ai_consumer_call_store.sql migrations/20261017150000_ai_ledger_user_erasure.sql \
         migrations/20261020154536_ai_calls_owner_held_rc_guard.sql candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql; do
  "${PG[@]}" -f "$REPO/supabase/$f" >/dev/null
done
"${PG[@]}" -c "insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
  values ('g6le.postona.post', 'openai', 'gpt-6-luna', 'postona', 'post_generation', 'user', true, 'day', 200, 5, 0.2)" >/dev/null

# ---- the functions ------------------------------------------------------------------------------------------------------------------
FEATURE='{"enabled":true,"revision":"g6-26-local-1","provider":"openai","model":"gpt-6-luna","reasoningEffort":"low","maxOutputTokens":800,"timeoutMs":20000,"maxAttempts":1,"maxCostUsdPerOperation":0.1,"maxInputBytes":8000,"entitlements":["postona:x_autopost"]}'
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
# Ready = both functions themselves answer (G6's own 401 for a request carrying only the publishable apikey). Right after `functions serve`
# replaces the Edge container, the local gateway's first request can still fail (500 "An unexpected error occurred"): wait past it.
for fn in postona-post-assist-localtest postona-post-assist; do
  ready=""
  for _ in $(seq 1 60); do
    answer="$(curl -s -X POST "http://127.0.0.1:$API_PORT/functions/v1/$fn" -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' -d '{}' || true)"
    [ "$answer" = '{"error":"POST_ASSIST_AUTH_REQUIRED","retry_same_key":false}' ] && { ready=1; break; }
    sleep 2
  done
  [ -n "$ready" ] || { echo "G6LE_SERVE_NOT_READY $fn"; tail -5 "$WORK/serve.log"; exit 2; }
done

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u OPENAI_API_KEY \
    G6LE_API="http://127.0.0.1:$API_PORT" G6LE_PUBLISHABLE="$PUBLISHABLE" G6LE_DB_PORT="$DB_PORT" G6LE_FAKE_PORT="$FAKE_PORT" \
    G6LE_MVP="$MVP" G6LE_G1_CLIENT="$G1_CLIENT" \
  deno test --no-config --cached-only --allow-env=G6LE_API,G6LE_PUBLISHABLE,G6LE_DB_PORT,G6LE_FAKE_PORT,G6LE_MVP,G6LE_G1_CLIENT,PGPASSWORD \
    --allow-net="127.0.0.1:$API_PORT,127.0.0.1:$FAKE_PORT" --allow-read="$WORK" --allow-run=psql \
    "$REPO/supabase/tests/postona_post_assist_local_edge_test.ts"
