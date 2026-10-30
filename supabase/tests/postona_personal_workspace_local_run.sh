#!/bin/bash
# G5-51: the personal workspace first run (W0) and the lifecycle owner on the REAL local Supabase runtime (no managed project, no paid
# provider, nothing deployed). A throw-away local Supabase project (`supabase start`, project id g5ls, ports 557xx) runs the real containers:
# Postgres 17.6.1.165 with the real auth schema (RLS on auth.users / auth.sessions), GoTrue (real ES256 user JWTs with session_id /
# is_anonymous), PostgREST, Kong (verify_jwt) and the Edge runtime.
#   lifecycle owner  `postgres`, the image's own role (not a superuser; BYPASSRLS; the auth privileges no other role can be given: G6-26 F2)
#   G5               the world (the G5 Draft chain at 21a5cad4, as G6-26's runner builds it, as `postgres`) + this tree's candidates
#                    (MVP_INSTALL / R1 grant / W0 / preflight / stops / rollbacks), run BY THE TEST step by step
#   G6               PR #582 1a567ea8 (read-only `git archive`, blob-checked): the real entry and its localtest twin (loopback SUPABASE_URL, fake
#                    provider), the ledger / ai_calls / owner-held SQL as `postgres`
#   G1               PR #576 8d95307c (read-only archive, blob-checked; 3 import specifiers rewritten for Deno, counted): the app's real
#                    snapshot read (SupabaseSocialRepository over supabase-js 2.115.0 and the real PostgREST / RLS) and its assist client
# Needs: supabase CLI 2.116.0, a running Docker-API engine with the images below already present (never pulls; refuses instead), deno, psql,
# git. Everything it starts is stopped and removed at exit (`supabase stop --no-backup`).
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
G5W=21a5cad4b71de63265db8517da93c6efc60cdde8   # G5's Draft chain world (as G6-26 / PR #563's runners)
G6=1a567ea8facd36f20a767c999bd36f59db5d8740    # G6 PR #582 HEAD
G1=8d95307c7001a6456719c6a829ef41a83ab703c3    # G1 PR #576 HEAD
ENGINE="${G5LS_ENGINE:-podman}"
API_PORT=55721 DB_PORT=55722 FAKE_PORT=55799

[ "$(cd "${TMPDIR:-/tmp}" && supabase --version 2>/dev/null | head -1)" = 2.116.0 ] || { echo "G5LS_CLI_VERSION: needs supabase CLI 2.116.0"; exit 2; }
for image in postgres:17.6.1.165 gotrue:v2.196.0 postgrest:v16.1 kong:2.8.1 edge-runtime:v1.74.3 storage-api:v1.70.3; do
  "$ENGINE" image exists "public.ecr.aws/supabase/$image" || { echo "G5LS_IMAGE_MISSING: $image (this script does not pull)"; exit 2; }
done
for commit in "$G5W" "$G6" "$G1"; do git -C "$REPO" cat-file -e "$commit^{commit}" || { echo "G5LS_COMMIT_MISSING: $commit (git fetch origin)"; exit 2; }; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/g5ls.XXXXXX")"
SERVE_PID=""
cleanup() {
  [ -n "${G5LS_LOG_DIR:-}" ] && [ -f "$WORK/serve.log" ] && cp "$WORK/serve.log" "$G5LS_LOG_DIR/g5ls_serve.log" || true
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" >/dev/null 2>&1 || true
  (cd "$WORK/p" && supabase stop --no-backup >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- read-only copies, blob-checked ---------------------------------------------------------------------------------------------------
mkdir -p "$WORK/p" "$WORK/g5w" "$WORK/g6" "$WORK/g1"
git -C "$REPO" archive "$G5W" supabase/migrations supabase/tests | tar -x -C "$WORK/g5w"
git -C "$REPO" archive "$G6" supabase/functions/postona-post-assist supabase/functions/_shared supabase/tests/fixtures/g6_26_local_edge \
  supabase/migrations supabase/candidates/common_ai_g6 | tar -x -C "$WORK/g6"
git -C "$REPO" archive "$G1" apps/social-mobile/src/data apps/social-mobile/src/features/schedule apps/social-mobile/src/domain | tar -x -C "$WORK/g1"
for pair in "$G6:supabase/functions/postona-post-assist/index.ts:g6" "$G6:supabase/tests/fixtures/g6_26_local_edge/postona-post-assist-localtest/index.ts:g6" \
            "$G6:supabase/functions/_shared/ai_gateway/g5_rpc_transport.ts:g6" "$G6:supabase/candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql:g6" \
            "$G1:apps/social-mobile/src/data/post-assist-client.ts:g1" "$G1:apps/social-mobile/src/features/schedule/post-assist.ts:g1" \
            "$G1:apps/social-mobile/src/data/supabase-repository.ts:g1"; do
  commit="${pair%%:*}"; rest="${pair#*:}"; path="${rest%:*}"; dir="${rest##*:}"
  [ "$(git hash-object "$WORK/$dir/$path")" = "$(git -C "$REPO" rev-parse "$commit:$path")" ] || { echo "G5LS_BLOB_MISMATCH: $path"; exit 2; }
done
g1="$WORK/g1/apps/social-mobile/src"
sed -i.orig -e "s#from '@/domain/post-status'#from '../domain/post-status.ts'#" -e "s#from '@/domain/types'#from '../domain/types.ts'#" "$g1/data/supabase-repository.ts"
sed -i.orig -e "s#from './types'#from './types.ts'#" "$g1/domain/post-status.ts"
[ "$(diff "$g1/data/supabase-repository.ts.orig" "$g1/data/supabase-repository.ts" | grep -c '^>')" = 2 ] || { echo "G5LS_G1_REWRITE: not exactly 2 lines"; exit 2; }
[ "$(diff "$g1/domain/post-status.ts.orig" "$g1/domain/post-status.ts" | grep -c '^>')" = 1 ] || { echo "G5LS_G1_REWRITE: not exactly 1 line"; exit 2; }

# ---- the local project ------------------------------------------------------------------------------------------------------------------
(cd "$WORK/p" && supabase init --force --with-vscode-settings=false --with-intellij-settings=false >/dev/null 2>&1)
python3 -I - "$WORK/p/supabase/config.toml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('project_id = "p"', 'project_id = "g5ls"')
for old, new in [("54321", "55721"), ("54322", "55722"), ("54320", "55720"), ("54329", "55729"), ("54323", "55723"), ("54324", "55724"), ("54327", "55727")]:
    s = s.replace(f"port = {old}", f"port = {new}")
for sec in ["realtime", "studio", "local_smtp", "analytics"]:
    s, n = re.subn(r"(\[%s\]\n(?:#.*\n)*)enabled = true" % re.escape(sec), r"\1enabled = false", s, count=1); assert n == 1, sec
s, n = re.subn(r"(\[db\.seed\]\n(?:#.*\n)*)enabled = true", r"\1enabled = false", s, count=1); assert n == 1
s, n = re.subn(r"enable_anonymous_sign_ins = false", "enable_anonymous_sign_ins = true", s, count=1); assert n == 1
# the suite signs up ~45 people from one IP: lift the per-IP sign-up / sign-in limit (30 per 5 minutes) for this local project only
s, n = re.subn(r"sign_in_sign_ups = 30", "sign_in_sign_ups = 1000", s, count=1); assert n == 1
assert 'project_id = "g5ls"' in s
s += '\n[functions.postona-post-assist-localtest]\nverify_jwt = true\n'
open(p, "w").write(s)
PY
mkdir -p "$WORK/p/supabase/functions/postona-post-assist-localtest"
cp -R "$WORK/g6/supabase/functions/postona-post-assist" "$WORK/g6/supabase/functions/_shared" "$WORK/p/supabase/functions/"
cp "$WORK/g6/supabase/tests/fixtures/g6_26_local_edge/postona-post-assist-localtest/index.ts" "$WORK/p/supabase/functions/postona-post-assist-localtest/index.ts"
(cd "$WORK/p" && deno check --no-config --cached-only supabase/functions/postona-post-assist-localtest/index.ts >/dev/null 2>&1) || { echo "G5LS_CHECK_FAILED"; exit 2; }

(cd "$WORK/p" && supabase start -x studio,imgproxy,vector,supavisor,mailpit,realtime,logflare,postgres-meta >/dev/null 2>&1) || { echo "G5LS_START_FAILED"; exit 2; }
KEYS="$(cd "$WORK/p" && supabase status -o env 2>/dev/null)"
PUBLISHABLE="$(printf '%s\n' "$KEYS" | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$/\1/p')"
SECRET="$(printf '%s\n' "$KEYS" | sed -n 's/^SECRET_KEY="\(.*\)"$/\1/p')"
case "$PUBLISHABLE:$SECRET" in sb_publishable_*:sb_secret_*) ;; *) echo "G5LS_KEYS_UNEXPECTED"; exit 2 ;; esac

# ---- G5's world on the real schema, as `postgres` -------------------------------------------------------------------------------------
export PGPASSWORD=postgres   # the local image's fixed development password (not a secret; nothing here is reachable from outside)
m="$WORK/g5w/supabase/migrations"; t="$WORK/g5w/supabase/tests"
own() { psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres "$@"; }
# A fixture's stand-ins for auth / vault / storage fail on the real schema (the real objects exist; measured lines); anything else must not.
fixture() {
  local name="$1" allowed="$2" got
  got="$(psql -X -q -v ON_ERROR_STOP=0 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -f "$t/$name.sql" 2>&1 | sed -n "s/^psql:.*$name\.sql:\([0-9]*\): ERROR: .*/\1/p" | tr '\n' ' ' | sed 's/ $//')"
  [ "$got" = "$allowed" ] || { echo "G5LS_FIXTURE_UNEXPECTED_ERRORS $name: [$got] expected [$allowed]"; exit 2; }
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

# ---- G6's ledger side, as `postgres` -----------------------------------------------------------------------------------------------------
for f in migrations/20261010050613_ai_provider_budget_ledger.sql migrations/20261017120000_ai_consumer_call_store.sql migrations/20261017150000_ai_ledger_user_erasure.sql \
         migrations/20261020154536_ai_calls_owner_held_rc_guard.sql candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql; do
  own -f "$WORK/g6/supabase/$f" >/dev/null
done
own -c "insert into ai_ledger.budget_policies
  (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
  values ('g5ls.postona.post', 'openai', 'gpt-6-luna', 'postona', 'post_generation', 'user', true, 'day', 500, 5, 0.2)" >/dev/null

# ---- the Edge function (G6's localtest twin of the real entry) -------------------------------------------------------------------------
FEATURE='{"enabled":true,"revision":"g5-51-local-1","provider":"openai","model":"gpt-6-luna","reasoningEffort":"low","maxOutputTokens":800,"timeoutMs":20000,"maxAttempts":1,"maxCostUsdPerOperation":0.1,"maxInputBytes":8000,"entitlements":["postona:x_autopost"]}'
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
ready=""
for _ in $(seq 1 60); do
  answer="$(curl -s -X POST "http://127.0.0.1:$API_PORT/functions/v1/postona-post-assist-localtest" -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' -d '{}' || true)"
  [ "$answer" = '{"error":"POST_ASSIST_AUTH_REQUIRED","retry_same_key":false}' ] && { ready=1; break; }
  sleep 2
done
[ -n "$ready" ] || { echo "G5LS_SERVE_NOT_READY"; tail -5 "$WORK/serve.log"; exit 2; }

env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u OPENAI_API_KEY \
    G5LS_API="http://127.0.0.1:$API_PORT" G5LS_PUBLISHABLE="$PUBLISHABLE" G5LS_DB_PORT="$DB_PORT" G5LS_FAKE_PORT="$FAKE_PORT" \
    G5LS_MVP="$REPO/supabase/candidates/postona_personal_mvp_auth" G5LS_G1="$g1" G5LS_G6="$WORK/g6/supabase/functions/_shared" \
  deno test --no-config --no-check --cached-only \
    --allow-env=G5LS_API,G5LS_PUBLISHABLE,G5LS_DB_PORT,G5LS_FAKE_PORT,G5LS_MVP,G5LS_G1,G5LS_G6,PGPASSWORD \
    --allow-net="127.0.0.1:$API_PORT,127.0.0.1:$FAKE_PORT" --allow-read="$WORK,$REPO" --allow-run=psql \
    "$REPO/supabase/tests/postona_personal_workspace_local_test.ts"
