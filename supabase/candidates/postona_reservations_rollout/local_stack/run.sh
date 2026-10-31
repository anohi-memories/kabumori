#!/bin/bash
# G3-02 #1 / #2 (Issue #589): X / Threads reservations on the REAL local Supabase runtime (no managed project, no SNS, no paid provider,
# nothing deployed). A throw-away local Supabase project (`supabase start`, project id g3ls, ports 559xx) runs the real containers:
# Postgres 17.6.1.165 with the real auth / vault / storage schemas, GoTrue (real ES256 user JWTs with session_id / is_anonymous), Kong
# (verify_jwt) and the Edge runtime.
#   world   G4's PERSONAL world as G4's runner builds it (G4 PR #580 c6df19cc, read-only `git archive`; L105-L158 + mvp_world + the
#           G4T_VERDICT personal path: G5 lifecycle + T13, G5 MVP_INSTALL, PR #124, Threads custody, G4's g5pv binding + stack, personal
#           X 001-005, both verdicts), applied as `postgres` (the image's own non-superuser owner). The fixtures' stand-ins for auth /
#           vault / storage fail on the real schema (measured lines); anything else must not.
#   G3      this tree's rollout bundle: rollout.sh preflight / install over 127.0.0.1 (15 steps + postcheck) and, after the test,
#           rollout.sh rollback (the test's login members revoked first, rows stated exactly); G3's schemas and roles must be gone.
#   Edge    the real entries (release gates OFF: 503) and their localtest twins (gate passed as enabled; permission ports and the X
#           credential source NOT overridden: deny), behind the real Kong / GoTrue.
#   G5 W0   G5's accepted first-run workspace (PR #590 2c8087fc: MVP_W0_INSTALL + MVP_W0_EXECUTE_GRANT, blob-pinned, unchanged), so the
#           person starts the service and gets the workspace over PostgREST with their own JWT.
#   test    local_test.ts (phases L0-L12, real HTTP; G3-02 #2: create / reschedule / reconfirm decided in the database).
#   e2e     G3-02 #9: a TEST ONLY worker twin (postona-x-reservation-worker-e2etest) with a FAKE credential snapshot and a fake X in a
#           g3ls_test schema (a throw-away login reaches only that schema; both dropped before RB); L19-L24.
# Test-world stand-ins (not G3's to decide; labelled in the test): a service end = the entitlement row as G5's end leaves it; a Threads
# connection = G4's binding_row shape (as smoke.sql); the API / worker LOGIN members (a separately approved rollout step) = two
# throw-away login roles with random passwords, kept only in a 0600 file inside the work dir.
# Needs: supabase CLI 2.116.0, a running Docker-API engine (podman) with the images below already present (never pulls; refuses
# instead), deno, psql, git, openssl. Everything it starts is stopped and removed at exit (`supabase stop --no-backup`). Run alone.
set -euo pipefail
export LC_ALL=C PGOPTIONS='-c client_min_messages=warning'
here="$(cd "$(dirname "$0")" && pwd)"
bundle="$(cd "$here/.." && pwd)"
REPO="$(git -C "$here" rev-parse --show-toplevel)"
G4=c6df19cc612ad586126e80b009589ef3456b215f      # G4 PR #580 HEAD (personal X + verdicts)
PR178=83334a091ded5571cf595fd99d7a035627564735   # G5 write guard chain, as G4's runner overlays it
G5MVP=9846c0f062626db1dd4d9e8c10d5b1573e7f4982   # G5 MVP_INSTALL (blob eebaabf2, as G4's runner pins it)
G5CHAIN=21a5cad4b71de63265db8517da93c6efc60cdde8 # G5 lifecycle chain (MVP P1)
G5W0=2c8087fc71d56b133dc3f6be21ea665cc8d44663    # G5 PR #590 HEAD (G5-02 #1, accepted): W0 install + grant
ENGINE="${G3LS_ENGINE:-podman}"
API_PORT=55921 DB_PORT=55922
fail() { echo "FAIL $*" >&2; exit 1; }

[ "$(cd "${TMPDIR:-/tmp}" && supabase --version 2>/dev/null | head -1)" = 2.116.0 ] || { echo "G3LS_CLI_VERSION: needs supabase CLI 2.116.0"; exit 2; }
for image in postgres:17.6.1.165 gotrue:v2.196.0 postgrest:v16.1 kong:2.8.1 edge-runtime:v1.74.3 storage-api:v1.70.3; do
  "$ENGINE" image exists "public.ecr.aws/supabase/$image" || { echo "G3LS_IMAGE_MISSING: $image (this script does not pull)"; exit 2; }
done
for commit in "$G4" "$PR178" "$G5MVP" "$G5CHAIN" "$G5W0"; do git -C "$REPO" cat-file -e "$commit^{commit}" || { echo "G3LS_COMMIT_MISSING: $commit (git fetch origin)"; exit 2; }; done
[ "$(git -C "$REPO" rev-parse "$G5MVP:supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql")" = eebaabf2629575901947c0664d6f0002526d3273 ] || fail "G5 MVP_INSTALL blob moved"
if lsof -nP -iTCP:"$API_PORT" -iTCP:"$DB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "G3LS_PORTS_BUSY: $API_PORT / $DB_PORT (another stack?)"; exit 2; fi

WORK="$(mktemp -d /private/tmp/g3ls.XXXXXX)"
SERVE_PID=""
cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" >/dev/null 2>&1 || true
  (cd "$WORK/p" && supabase stop --no-backup >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- read-only copies -------------------------------------------------------------------------------------------------------------------
mkdir -p "$WORK/p" "$WORK/t"
git -C "$REPO" archive "$G4" supabase/migrations supabase/tests supabase/candidates | tar -x -C "$WORK/t"
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

# ---- the local project ------------------------------------------------------------------------------------------------------------------
(cd "$WORK/p" && supabase init --force --with-vscode-settings=false --with-intellij-settings=false >/dev/null 2>&1)
python3 -I - "$WORK/p/supabase/config.toml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('project_id = "p"', 'project_id = "g3ls"')
for old, new in [("54321", "55921"), ("54322", "55922"), ("54320", "55920"), ("54329", "55929"), ("54323", "55923"), ("54324", "55924"), ("54327", "55927")]:
    s = s.replace(f"port = {old}", f"port = {new}")
for sec in ["realtime", "studio", "local_smtp", "analytics"]:
    s, n = re.subn(r"(\[%s\]\n(?:#.*\n)*)enabled = true" % re.escape(sec), r"\1enabled = false", s, count=1); assert n == 1, sec
s, n = re.subn(r"(\[db\.seed\]\n(?:#.*\n)*)enabled = true", r"\1enabled = false", s, count=1); assert n == 1
s, n = re.subn(r"enable_anonymous_sign_ins = false", "enable_anonymous_sign_ins = true", s, count=1); assert n == 1
assert 'project_id = "g3ls"' in s
for fn in ["postona-x-reservations-localtest", "postona-threads-reservations-localtest", "postona-x-reservation-worker-localtest", "postona-x-reservation-worker-e2etest"]:
    s += f'\n[functions.{fn}]\nverify_jwt = true\n'
open(p, "w").write(s)
PY
fns="$WORK/p/supabase/functions"
mkdir -p "$fns/_shared" "$fns/_shared_g3ls"
for d in postona-x-reservations postona-threads-reservations postona-x-reservation-worker postona-x-single-post; do cp -R "$REPO/supabase/functions/$d" "$fns/"; done
cp -R "$REPO/supabase/functions/_shared/postona_reservations" "$fns/_shared/"
cp "$here/local_transport.ts" "$fns/_shared_g3ls/"
# Mutation runs only (G3LS_MUTANT): one exact replacement in a COPY that runs (the bundle copy's manifest paths still resolve to
# this checkout); the checkout is never changed. Without a mutant the bundle's own rollout.sh runs.
mkdir -p "$WORK/bundle"; cp "$bundle/rollout.sh" "$bundle/preflight.sql" "$bundle/MANIFEST.tsv" "$WORK/bundle/"
sed -i '' "s|^root=.*|root=\"$bundle/..\"|" "$WORK/bundle/rollout.sh"
mutate() { python3 -I -c 'import sys; p, o, n = sys.argv[1:4]; s = open(p).read(); assert s.count(o) == 1, "G3LS_MUTANT target"; open(p, "w").write(s.replace(o, n))' "$@"; }
case "${G3LS_MUTANT:-}" in
  "") ;;
  host_any) mutate "$WORK/bundle/rollout.sh" '/private/tmp/*|/tmp/*|127.0.0.1) ;;' '*) ;;' ;;
  no_session_claim) mutate "$fns/_shared/postona_reservations/postgres_db.ts" 'session_id: subject.sessionId, ' '' ;;
  x_default_lookalike) mutate "$fns/postona-x-reservations/http.ts" 'overrides.permissions ?? PERMISSIONS_DECIDED_IN_DATABASE' 'overrides.permissions ?? { ...PERMISSIONS_DECIDED_IN_DATABASE }' ;;
  threads_default_lookalike) mutate "$fns/postona-threads-reservations/http.ts" 'overrides.permissions ?? THREADS_PERMISSIONS_DECIDED_IN_DATABASE' 'overrides.permissions ?? { ...THREADS_PERMISSIONS_DECIDED_IN_DATABASE }' ;;
  no_set_role) mutate "$fns/_shared/postona_reservations/postgres_db.ts" 'await client.queryArray({ text: `SET LOCAL ROLE ${API_ROLE}` });' '' ;;
  bound_generation_ignored) mutate "$fns/_shared/postona_reservations/x_bound_delivery.ts" '        || credential.generation !== checked.credentialGeneration) {' '        ) {' ;;
  unknown_as_rejected) mutate "$fns/_shared/postona_reservations/x_publisher.ts" 'return { kind: "unknown", code: controller.signal.aborted ? "X_TIMEOUT" : "X_TRANSPORT_UNKNOWN" };' 'return { kind: "rejected_before_send", code: "X_TRANSPORT_UNKNOWN" };' ;;
  *) fail "unknown G3LS_MUTANT" ;;
esac
RO_SH="$bundle/rollout.sh"; [ "${G3LS_MUTANT:-}" = host_any ] && RO_SH="$WORK/bundle/rollout.sh"
for d in postona-x-reservations-localtest postona-threads-reservations-localtest postona-x-reservation-worker-localtest postona-x-reservation-worker-e2etest; do
  mkdir -p "$fns/$d"; cp "$here/$d/index.ts" "$fns/$d/"
  (cd "$WORK/p" && deno check --no-config --cached-only "supabase/functions/$d/index.ts" >/dev/null 2>&1) || fail "deno check $d"
done

(cd "$WORK/p" && supabase start -x studio,imgproxy,vector,supavisor,mailpit,realtime,logflare,postgres-meta >/dev/null 2>&1) || { echo "G3LS_START_FAILED"; exit 2; }
PUBLISHABLE="$(cd "$WORK/p" && supabase status -o env 2>/dev/null | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$/\1/p')"
JWT_SECRET="$(cd "$WORK/p" && supabase status -o env 2>/dev/null | sed -n 's/^JWT_SECRET="\(.*\)"$/\1/p')"   # this throw-away stack's own; only mints an EXPIRED token (L2)
[ -n "$JWT_SECRET" ] || { echo "G3LS_KEYS_UNEXPECTED"; exit 2; }
case "$PUBLISHABLE" in sb_publishable_*) ;; *) echo "G3LS_KEYS_UNEXPECTED"; exit 2 ;; esac
echo "OK local stack g3ls (ports $API_PORT / $DB_PORT)"

# ---- RM: the bundle's host rule (nothing is read from any database) ---------------------------------------------------------------------
for h in localhost 127.0.0.2 ::1 db.example.invalid; do
  o="$(G3RO_PGHOST="$h" G3RO_PGPORT="$DB_PORT" G3RO_DB=postgres G3RO_OWNER=postgres bash "$RO_SH" preflight 2>&1)" && fail "RM host $h accepted"
  grep -q G3_ROLLOUT_REFUSED_HOST <<<"$o" || fail "RM host $h: $o"
done
echo "OK RM hosts localhost / 127.0.0.2 / ::1 / db.example.invalid refused"

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
         "$c/postona_g4_x_oauth_personal_mvp/005_x_connect_lifecycle_t13_g5pv.sql" "$c/postona_g4_credential_verdict/002_x_publish_credential_verdict.sql"; do
  need "$f"
done
echo "OK world: G4's personal world at ${G4:0:8} on the real local schema (as postgres)"
w0dir=supabase/candidates/postona_personal_mvp_auth
for pair in MVP_W0_INSTALL.sql:f68bc61f35b3041e2147f216da7ceb56c822105d MVP_W0_EXECUTE_GRANT.sql:c7c20852ce951fd1cdfe5eda538038232b1da85c; do
  [ "$(git -C "$REPO" rev-parse "$G5W0:$w0dir/${pair%%:*}")" = "${pair#*:}" ] || fail "G5 ${pair%%:*} blob moved"
  git -C "$REPO" show "$G5W0:$w0dir/${pair%%:*}" > "$WORK/t/${pair%%:*}"
  need "$WORK/t/${pair%%:*}"
done
echo "OK G5 W0 (PR #590 ${G5W0:0:8}) installed and given to authenticated, as G5's files do"

# ---- G3: the rollout bundle over 127.0.0.1 ----------------------------------------------------------------------------------------------
# G3-02 #4 (H4-16 P2): this throw-away stack's database is marked by its creator (the image's superuser supabase_admin, the same fixed
# development password); rollout.sh refuses any target without exactly this mark, whatever answers on 127.0.0.1
ATT="g3ro-throwaway-$(openssl rand -hex 16)"
psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$DB_PORT" -U supabase_admin -d postgres -c "alter database postgres set g3ro.throwaway_attestation = '$ATT'" >/dev/null \
  || fail "the throw-away database could not be marked"
mode=preflight; o="$(env G3RO_PGHOST=127.0.0.1 G3RO_PGPORT="$DB_PORT" G3RO_DB=postgres G3RO_OWNER=postgres G3RO_DB_ATTESTATION="g3ro-throwaway-$(openssl rand -hex 16)" bash "$RO_SH" preflight 2>&1)" \
  && fail "a different attestation was accepted"
grep -q G3_ROLLOUT_ATTESTATION_MISMATCH <<<"$o" || fail "attestation mismatch: $o"
ro() { env G3RO_PGHOST=127.0.0.1 G3RO_PGPORT="$DB_PORT" G3RO_DB=postgres G3RO_OWNER=postgres G3RO_DB_ATTESTATION="$ATT" "$@" bash "$RO_SH" "$mode"; }
mode=preflight; o="$(ro 2>&1)" || fail "preflight: $o"; grep -q '^G3_ROLLOUT_PREFLIGHT_PASS fresh install_steps=15$' <<<"$o" || fail "preflight: $o"
mode=install; o="$(ro 2>&1)" || fail "install: $o"; grep -q '^G3_ROLLOUT_INSTALLED steps=15 ' <<<"$o" || fail "install: $o"
mode=install; o="$(ro 2>&1)" && fail "a second install succeeded"; grep -q G3_ROLLOUT_PREFLIGHT_REFUSED <<<"$o" || fail "second install: $o"
echo "OK G3 rollout.sh preflight + install (15 steps + postcheck) on the real local stack (attested; another attestation refused); a second install refused"

# the test's LOGIN members (stand-ins for the separately approved rollout step): random passwords, never printed, 0600 file only
API_PW="$(openssl rand -hex 24)"; WORKER_PW="$(openssl rand -hex 24)"; WORKER_SECRET="$(openssl rand -hex 24)"; TEST_PW="$(openssl rand -hex 24)"
own -v a="$API_PW" -v k="$WORKER_PW" >/dev/null <<'SQL'
create role g3ls_api_login login noinherit password :'a';
create role g3ls_worker_login login noinherit password :'k';
grant postona_resv_api to g3ls_api_login with inherit false, set true;
grant postona_resv_worker to g3ls_worker_login with inherit false, set true;
SQL
# G3-02 #9 TEST ONLY: the e2e twin's fake credential snapshot and fake X record (g3ls_test), reached only by a throw-away login that
# reaches nothing else; dropped before RB.
own -v t="$TEST_PW" >/dev/null <<'SQL'
create schema g3ls_test;
create table g3ls_test.x_token_snapshot (social_account_id text primary key, token text not null, generation text not null);
create table g3ls_test.x_calls (id bigint generated always as identity primary key, bearer_sha256 text not null, text text not null, at timestamptz not null default now());
create table g3ls_test.x_mode (one boolean primary key default true check (one), mode text not null check (mode in ('ok', 'reject_401', 'unknown')));
insert into g3ls_test.x_mode (mode) values ('ok');
create role g3ls_test_login login noinherit password :'t';
grant usage on schema g3ls_test to g3ls_test_login;
grant select on g3ls_test.x_token_snapshot, g3ls_test.x_mode to g3ls_test_login;
grant select, insert on g3ls_test.x_calls to g3ls_test_login;
SQL
ENV_FILE="$WORK/functions.env"
(umask 077; {
  printf 'POSTONA_RESV_DATABASE_URL=postgres://g3ls_api_login:%s@db:5432/postgres\n' "$API_PW"
  printf 'POSTONA_RESV_WORKER_DATABASE_URL=postgres://g3ls_worker_login:%s@db:5432/postgres\n' "$WORKER_PW"
  printf 'POSTONA_RESV_WORKER_SECRET=%s\n' "$WORKER_SECRET"
  printf 'G3LS_TEST_DB_URL=postgres://g3ls_test_login:%s@db:5432/postgres\n' "$TEST_PW"
} > "$ENV_FILE")
(cd "$WORK/p" && exec supabase functions serve --env-file "$ENV_FILE" >"$WORK/serve.log" 2>&1) &
SERVE_PID=$!
ready=""
for _ in $(seq 1 60); do
  answer="$(curl -s -X POST "http://127.0.0.1:$API_PORT/functions/v1/postona-x-reservations-localtest" -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' -d '{}' || true)"
  [ "$answer" = '{"ok":false,"code":"REQUEST_INVALID"}' ] && { ready=1; break; }
  sleep 2
done
[ -n "$ready" ] || { tail -5 "$WORK/serve.log"; fail "functions serve not ready"; }

env -u PGPASSWORD G3LS_API="http://127.0.0.1:$API_PORT" G3LS_PUBLISHABLE="$PUBLISHABLE" G3LS_DB_PORT="$DB_PORT" \
    G3LS_API_PW="$API_PW" G3LS_WORKER_PW="$WORKER_PW" G3LS_WORKER_SECRET="$WORKER_SECRET" G3LS_JWT_SECRET="$JWT_SECRET" \
  deno test --no-config --no-check --cached-only \
    --allow-env=G3LS_API,G3LS_PUBLISHABLE,G3LS_DB_PORT,G3LS_API_PW,G3LS_WORKER_PW,G3LS_WORKER_SECRET,G3LS_JWT_SECRET \
    --allow-net="127.0.0.1:$API_PORT" --allow-run=psql "$here/local_test.ts"

own -c "drop schema g3ls_test cascade" -c "drop role g3ls_test_login" >/dev/null   # G3-02 #9 test-only objects, before RB

# ---- RB: rollback on the real stack: each refusal before any change, then the full rollback -----------------------------------------
g3count() { own -A -t -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('postona_x_resv', 'postona_threads_resv')"; }
before="$(g3count)"
rb_refused() {  # <label> <code> [env...]: refused with the code, G3's functions all still there
  local label="$1" want="$2"; shift 2
  mode=rollback; o="$(ro "$@" 2>&1)" && fail "RB $label: rollback succeeded"
  grep -q "$want" <<<"$o" || fail "RB $label: $o"
  [ "$(g3count)" = "$before" ] || fail "RB $label: changed G3"
}
rb_refused "planned + uncertain rows (L6 / L8)" G3_ROLLOUT_ROLLBACK_LIVE_ROWS
# operator; 'expired' too: G3-02 #9's delivery runs sweep L17's send-now-shaped row to expired, which a send now's retry could re-arm (008 counts it live)
own -c "update postona_x_resv.reservations set status = 'failed', outcome_code = 'G3LS_TEST_END' where status in ('planned', 'claimed', 'expired')" >/dev/null
unsure="$(own -A -t -c "select count(*) from postona_x_resv.reservations where status = 'uncertain'")"   # L9 (+ L22's unknown send)
[ "$unsure" -ge 1 ] || fail "the test left no uncertain row (L9)"
rb_refused "the uncertain rows alone" "G3_ROLLOUT_ROLLBACK_LIVE_ROWS: X/Threads $unsure/0"
own -c "update postona_x_resv.reservations set status = 'failed', outcome_code = 'G3LS_TEST_END_RESOLVED' where status = 'uncertain'" >/dev/null   # operator, after checking X
xrows="$(own -A -t -c "select (select count(*) from postona_x_resv.reservations) || ':' || (select count(*) from postona_x_resv.batches) || ':' || (select count(*) from postona_x_resv.audit)")"
trows="$(own -A -t -c "select (select count(*) from postona_threads_resv.reservations) || ':' || (select count(*) from postona_threads_resv.audit)")"
rb_refused "finished rows not stated" G3_ROLLOUT_ROLLBACK_X_ROWS_NOT_STATED
rb_refused "the test's login members" G3_ROLLOUT_ROLLBACK_ROLE_MEMBERS G3RO_X_DISCARD_ROWS="$xrows" G3RO_THREADS_DISCARD_ROWS="$trows"
own -c "drop role g3ls_api_login" -c "drop role g3ls_worker_login" >/dev/null
mode=rollback; o="$(ro G3RO_X_DISCARD_ROWS="$xrows" G3RO_THREADS_DISCARD_ROWS="$trows" 2>&1)" || fail "rollback: $o"
grep -q '^G3_ROLLOUT_ROLLED_BACK steps=15$' <<<"$o" || fail "rollback: $o"
left="$(own -A -t -c "select (select count(*) from pg_namespace where nspname in ('postona_x_resv', 'postona_threads_resv')) || '/' || (select count(*) from pg_roles where rolname in ('postona_resv_api', 'postona_resv_worker'))")"
[ "$left" = "0/0" ] || fail "G3 left after the rollback: $left"
mode=preflight; o="$(ro 2>&1)" || fail "preflight after rollback: $o"; grep -q 'G3_ROLLOUT_PREFLIGHT_PASS fresh' <<<"$o" || fail "preflight after rollback: $o"
echo "OK RB refused before any change: live rows, the uncertain rows alone, rows not stated, login members; then 15 steps rolled back (X $xrows, Threads $trows discarded), G3 schemas + roles gone, preflight fresh again"
echo "G3LS_LOCAL_STACK_PASS"
