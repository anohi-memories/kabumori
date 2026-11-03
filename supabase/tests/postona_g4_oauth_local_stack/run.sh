#!/bin/bash
# G4-02 #6 (Issue #561): X / Threads connect on the REAL local Supabase runtime: app hook -> supabase-js -> Kong (verify_jwt) -> Edge runtime
# -> real GoTrue / PostgREST / PG 17.6, with only X and Threads faked. No managed project, no real provider, nothing deployed.
#   world  G4's PERSONAL world (G5 lifecycle + T13, G5 MVP_INSTALL, PR #124, custody, Threads g5pv binding + stack, personal X 001-005, both
#          verdicts), from this tree, as `postgres` (the image's non-superuser owner), the way G3-02 #1 measured it on the real schema.
#   Edge   the real entries as in source (gates closed) and three g4ls twins (see their headers: only the static gate and the transport differ).
#   test   apps/social-mobile/tests/oauth-local-stack.e2e.mjs, with real user JWTs (ES256) from real GoTrue. It must exit by itself.
# GoTrue's issuer is set to H5's dummy project URL, because H5's strict config only accepts a managed-shaped project URL (test config only).
# SYNTHETIC, labelled in the test: G5's first-run workspace (G5 W0, not on this stack) = start_x_autopost_service() under the person's real
# claims; a service end / end + restart = the rows as G5's end leaves them.
# Needs: supabase CLI 2.116.0, a running podman machine holding the images (never pulls), deno, psql, node, `npm ci --ignore-scripts` in
# apps/social-mobile. Everything it starts is removed at exit (`supabase stop --no-backup`); the podman machine is left as it was. Run alone.
set -euo pipefail
export LC_ALL=C PGOPTIONS='-c client_min_messages=warning'
here="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$here" rev-parse --show-toplevel)"
PR178=83334a091ded5571cf595fd99d7a035627564735   # G5 write guard chain, as G4's runners overlay it
G5MVP=9846c0f062626db1dd4d9e8c10d5b1573e7f4982   # G5 MVP_INSTALL (blob eebaabf2)
G5CHAIN=21a5cad4b71de63265db8517da93c6efc60cdde8 # G5 lifecycle chain (MVP P1)
API_PORT=56021 DB_PORT=56022
ISSUER_ORIGIN="https://aaaaaaaaaaaaaaaaaaaa.supabase.co"  # H5's offline.fixture.ts projectUrl
fail() { echo "FAIL $*" >&2; exit 1; }

[ "$(cd "${TMPDIR:-/tmp}" && supabase --version 2>/dev/null | head -1)" = 2.116.0 ] || { echo "G4LS_CLI_VERSION: needs supabase CLI 2.116.0"; exit 2; }
for image in postgres:17.6.1.165 gotrue:v2.196.0 postgrest:v16.1 kong:2.8.1 edge-runtime:v1.74.3 storage-api:v1.70.3; do
  podman image exists "public.ecr.aws/supabase/$image" || { echo "G4LS_IMAGE_MISSING: $image (this script does not pull)"; exit 2; }
done
for commit in "$PR178" "$G5MVP" "$G5CHAIN"; do git -C "$REPO" cat-file -e "$commit^{commit}" || { echo "G4LS_COMMIT_MISSING: $commit (git fetch origin)"; exit 2; }; done
[ "$(git -C "$REPO" rev-parse "$G5MVP:supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql")" = eebaabf2629575901947c0664d6f0002526d3273 ] || fail "G5 MVP_INSTALL blob moved (pin)"
[ -d "$REPO/apps/social-mobile/node_modules/@supabase/supabase-js" ] || { echo "G4LS_APP_DEPS: run npm ci --ignore-scripts in apps/social-mobile"; exit 2; }
if lsof -nP -iTCP:"$API_PORT" -iTCP:"$DB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "G4LS_PORTS_BUSY: $API_PORT / $DB_PORT"; exit 2; fi

WORK="$(mktemp -d /private/tmp/g4ls.XXXXXX)"
SERVE_PID=""
cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" >/dev/null 2>&1 || true
  (cd "$WORK/p" && supabase stop --no-backup >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- the SQL, from this tree + the pinned G5 parts ------------------------------------------------------------------------------------
mkdir -p "$WORK/p" "$WORK/t/supabase"
cp -R "$REPO/supabase/migrations" "$REPO/supabase/tests" "$REPO/supabase/candidates" "$WORK/t/supabase/"
for path in supabase/tests/common_account_write_guard_fixture.sql supabase/migrations/20261010051938_common_account_service_write_guard.sql \
            supabase/migrations/20261012130000_common_account_core_service_fence.sql supabase/migrations/20261012230000_common_account_service_brand_state.sql \
            supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql; do
  [ -e "$WORK/t/$path" ] && fail "overlay overlap: $path"
  git -C "$REPO" show "$PR178:$path" > "$WORK/t/$path"
done
git -C "$REPO" show "$G5MVP:supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql" > "$WORK/t/g5_mvp_install.sql"
for f in 20261013140000_common_account_service_reconciliation_facts 20261015090000_common_account_enrollment_session_fence \
         20261015120000_common_account_x_unconfirmed_snapshot_record; do
  git -C "$REPO" show "$G5CHAIN:supabase/migrations/$f.sql" > "$WORK/t/g5chain_$f.sql"
done
python3 -I "$REPO/supabase/tests/postona_g4_x_oauth_personal_mvp_build.py" "$REPO" --check > /dev/null || fail "the personal X files do not re-derive"

# ---- the local project ----------------------------------------------------------------------------------------------------------------
(cd "$WORK/p" && supabase init --force --with-vscode-settings=false --with-intellij-settings=false >/dev/null 2>&1)
python3 -I - "$WORK/p/supabase/config.toml" "$ISSUER_ORIGIN" <<'PY'
import re, sys
p, origin = sys.argv[1], sys.argv[2]; s = open(p).read()
s = s.replace('project_id = "p"', 'project_id = "g4ls"')
for old, new in [("54321", "56021"), ("54322", "56022"), ("54320", "56020"), ("54329", "56029"), ("54323", "56023"), ("54324", "56024"), ("54327", "56027")]:
    s = s.replace(f"port = {old}", f"port = {new}")
for sec in ["realtime", "studio", "local_smtp", "analytics"]:
    s, n = re.subn(r"(\[%s\]\n(?:#.*\n)*)enabled = true" % re.escape(sec), r"\1enabled = false", s, count=1); assert n == 1, sec
s, n = re.subn(r"(\[db\.seed\]\n(?:#.*\n)*)enabled = true", r"\1enabled = false", s, count=1); assert n == 1
s, n = re.subn(r"enable_anonymous_sign_ins = false", "enable_anonymous_sign_ins = true", s, count=1); assert n == 1
s, n = re.subn(r'# jwt_issuer = ""', f'jwt_issuer = "{origin}/auth/v1"', s, count=1); assert n == 1
s, n = re.subn(r"sign_in_sign_ups = \d+", "sign_in_sign_ups = 1000", s, count=1); assert n == 1
for fn in ["threads-oauth-connect-user", "x-oauth-connect-user", "social-mobile-threads-disconnect", "g4ls-threads-connect", "g4ls-x-connect", "g4ls-threads-disconnect"]:
    s += f'\n[functions.{fn}]\nverify_jwt = true\n'
open(p, "w").write(s)
PY
src="$REPO/supabase"; dst="$WORK/p/supabase"; fns="$dst/functions"
mkdir -p "$fns/_shared_g4ls" "$dst/candidates"
cp -R "$src/functions/_shared" "$fns/"
for d in threads-oauth-connect-user x-oauth-connect-user social-mobile-threads-disconnect social-mobile-threads-publish; do cp -R "$src/functions/$d" "$fns/"; done
for d in postona_g4_threads_personal_auth postona_threads_auth_runtime; do cp -R "$src/candidates/$d" "$dst/candidates/"; done
cp "$here/lib.ts" "$fns/_shared_g4ls/"
for d in g4ls-threads-connect g4ls-x-connect g4ls-threads-disconnect; do
  mkdir -p "$fns/$d"; cp "$here/$d/index.ts" "$fns/$d/"; cp "$src/functions/threads-oauth-connect-user/deno.json" "$fns/$d/"
done

(cd "$WORK/p" && supabase start -x studio,imgproxy,vector,supavisor,mailpit,realtime,logflare,postgres-meta >"$WORK/start.log" 2>&1) || { tail -5 "$WORK/start.log"; echo "G4LS_START_FAILED"; exit 2; }
PUBLISHABLE="$(cd "$WORK/p" && supabase status -o env 2>/dev/null | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$/\1/p')"
SERVICE_KEY="$(cd "$WORK/p" && supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY="\(.*\)"$/\1/p')"
[ -n "$SERVICE_KEY" ] || { echo "G4LS_KEYS_UNEXPECTED"; exit 2; }
case "$PUBLISHABLE" in sb_publishable_*) ;; *) echo "G4LS_KEYS_UNEXPECTED"; exit 2 ;; esac
echo "OK local stack g4ls (ports $API_PORT / $DB_PORT)"

# ---- G4's personal world on the real schema, as `postgres` ------------------------------------------------------------------------------
export PGPASSWORD=postgres   # the local image's fixed development password (not a secret; nothing here is reachable from outside)
t="$WORK/t/supabase/tests"; m="$WORK/t/supabase/migrations"; c="$WORK/t/supabase/candidates"; pub="$c/postona_threads_publish"
own() { psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres "$@"; }
need() { own -f "$1" >/dev/null 2>"$WORK/err.txt" || { head -3 "$WORK/err.txt" >&2; fail "$(basename "$1") did not apply"; }; }
fixture() {  # <file> <the measured error lines: the stand-ins for objects the real image already has>
  local got
  got="$(psql -X -q -v ON_ERROR_STOP=0 -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -f "$1" 2>&1 | sed -n "s/^psql:.*$(basename "$1" .sql)\.sql:\([0-9]*\): ERROR: .*/\1/p" | tr '\n' ' ' | sed 's/ $//')"
  [ "$got" = "$2" ] || fail "fixture $(basename "$1"): error lines [$got], expected [$2]"
}
fixture "$t/social_mobile_account_deletion_fixture.sql" "12 13 16 20 21 22 30 36 39"
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true   # as G4's runner (its auth stand-ins exist)
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified 20260928160000_social_mobile_account_deletion_candidate; do need "$m/$f.sql"; done
fixture "$t/common_account_lifecycle_fixture.sql" "15 21 26 31 38"
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion; do need "$m/$f.sql"; done
fixture "$t/common_account_write_guard_fixture.sql" "23 30"
for f in 20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state; do need "$m/$f.sql"; done
fixture "$t/postona_social_accounts_multi_provider_fixture.sql" ""
own -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" >/dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | own >/dev/null
own -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" >/dev/null
need "$m/20261007150000_postona_social_accounts_multi_provider.sql"
need "$m/20261013120000_common_account_service_deletion_ownership.sql"
fixture "$t/postona_threads_oauth_test_fixture.sql" "9 10 21 25 33 53"
own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null 2>&1 || true   # as G4's runner
# TEST-WORLD stand-in for G3's L-1 revoke (G5 MVP prerequisite P3), as G4's / G5's runners
own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke insert, update, delete, truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
for f in "$WORK"/t/g5chain_20261013140000_common_account_service_reconciliation_facts.sql "$WORK"/t/g5chain_20261015090000_common_account_enrollment_session_fence.sql \
         "$WORK"/t/g5chain_20261015120000_common_account_x_unconfirmed_snapshot_record.sql "$WORK/t/g5_mvp_install.sql" "$c/postona_threads_oauth_workspace_candidate.sql" \
         "$pub/threads_credential_custody_candidate.sql" "$c/postona_g4_threads_personal_mvp/001_threads_binding_g5pv.sql" \
         "$c/postona_threads_binding_epoch/002_custody_connect_proof.sql" "$c/postona_threads_auth_runtime/claim_candidate.sql" "$pub/threads_manual_publish_candidate.sql" \
         "$pub/threads_publish_release_candidate.sql" "$c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql" \
         "$c/postona_threads_disconnect/threads_disconnect_candidate.sql" "$c/postona_g4_credential_verdict/001_threads_publish_credential_verdict.sql" \
         "$c/postona_g4_x_oauth_personal_mvp/001_x_oauth_g5pv.sql" "$c/postona_g4_x_oauth_personal_epoch/002_x_oauth_product_wiring.sql" \
         "$c/postona_g4_x_oauth_personal_epoch/003_x_disconnect_user_rpc.sql" "$c/postona_g4_x_oauth_personal_epoch/004_x_consume_preexchange_recheck.sql" \
         "$c/postona_g4_x_oauth_personal_mvp/005_x_connect_lifecycle_t13_g5pv.sql" "$c/postona_g4_x_oauth_personal_mvp/006_x_connect_profile_fence.sql" "$c/postona_g4_credential_verdict/002_x_publish_credential_verdict.sql" "$c/postona_g4_x_oauth_personal_mvp/007_x_refresh_precheck.sql"; do
  need "$f"
done
echo "OK world: G4's personal world on the real local schema (as postgres)"
# G4-02 #8: the REAL X refresh core (main 20260925140000) instead of the deletion fixture's stand-in table, as G4-40's runner tests it
own -c "drop trigger social_accounts_x_refresh_reset_on_reconnect on public.social_accounts; drop function public.x_account_refresh_reset_on_reconnect(); drop table public.x_account_refresh_state_v2 cascade" >/dev/null
need "$m/20260925140000_x_account_credential_refresh_core.sql"
# G4-02 #9: the rest of what the real writer (VaultAccountXAuth) calls: the pre-send permission check and the per-account rollout authority
need "$m/20261003090000_social_mobile_publish_permission_boundary.sql"
own -c "drop table public.x_account_refresh_rollout cascade" >/dev/null   # the deletion fixture's stand-in
need "$m/20260926032054_x_account_refresh_rollout_authority.sql"
echo "OK the real X refresh core + publish permission + rollout authority"
ATTESTATION="$(openssl rand -hex 32)"
own -v k="$ATTESTATION" >/dev/null <<'SQL'
delete from vault.secrets where name = 'postona_threads_connect_attestation_v1';
select vault.create_secret(:'k', 'postona_threads_connect_attestation_v1');
SQL
own -c "select postona_g4_x_oauth.set_x_disconnect_enabled(true)" >/dev/null

ENV_FILE="$WORK/functions.env"
(umask 077; {
  printf 'X_CLIENT_ID=g4ls-x-client\nX_CLIENT_SECRET=g4ls-x-secret\nPOSTONA_X_AUTH_PROFILE=personal\nG4LS_DB_PASSWORD=postgres\n'
  printf 'G4LS_ATTESTATION_KEY=%s\n' "$ATTESTATION"
} > "$ENV_FILE")
(cd "$WORK/p" && exec supabase functions serve --env-file "$ENV_FILE" >"$WORK/serve.log" 2>&1) &
SERVE_PID=$!
ready=""
for _ in $(seq 1 90); do
  answer="$(curl -s -X POST "http://127.0.0.1:$API_PORT/functions/v1/threads-oauth-connect-user" -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' -d '{"action":"start"}' || true)"
  case "$answer" in *THREADS_CONNECT_DISABLED*) ready=1; break ;; esac
  sleep 2
done
[ -n "$ready" ] || { tail -20 "$WORK/serve.log"; fail "functions serve not ready: $answer"; }
# Each function's first request loads its dependencies (a cold start, not what is tested): warm them first, answers ignored.
for fn in g4ls-threads-connect/default g4ls-x-connect/__x_calls g4ls-threads-disconnect social-mobile-threads-disconnect x-oauth-connect-user; do
  curl -s -o /dev/null --max-time 150 -X POST "http://127.0.0.1:$API_PORT/functions/v1/$fn" -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' -d '{}' || true
done
echo "OK functions served and warmed"

t0=$SECONDS
if out="$(cd "$REPO/apps/social-mobile" && env FLOW_DEBUG="${FLOW_DEBUG:-}" LS_API="http://127.0.0.1:$API_PORT" LS_PUBLISHABLE="$PUBLISHABLE" LS_SERVICE_KEY="$SERVICE_KEY" LS_DB_PORT="$DB_PORT" \
    node --experimental-transform-types --test --test-reporter=tap tests/oauth-local-stack.e2e.mjs 2>&1)"; then
  grep -E '^(ok|not ok|# (pass|fail|tests|measured))' <<<"$out"
  echo "node exited by itself with status 0 after $((SECONDS - t0)) s"
  echo "G4LS_OAUTH_LOCAL_STACK_ALL_PASS"
else
  echo "$out"
  [ -n "${FLOW_DEBUG:-}" ] && tail -40 "$WORK/serve.log"
  fail "the local-stack e2e"
fi
