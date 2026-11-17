#!/bin/bash
# G4-02 #19 (Issue #561): G4's X send credential source wired into G3's manual send, end to end on the REAL local Supabase runtime
# (GoTrue signed JWT -> Kong -> Edge -> PostgREST / Postgres -> G3's test-only fake X). Nothing reaches X, OAuth, a managed project or a
# paid API; the tokens are fake values written into the throw-away stack's own Vault by G4's real connect SQL.
#
# G3's code is G3's: this harness never changes this checkout's G3 paths. It composes, in a throw-away directory:
#   * G3 PR #699 HEAD (read only, `git archive`; its git objects through an `alternates` file, nothing written to this repository) and
#     runs G3's own local_stack/run.sh there, with these exact, counted insertions into the COPY:
#       - G4's 003 (this checkout) installed right after the G4 world's 006 / 007;
#       - one more twin, postona-x-single-post-g4cred-e2etest (postona_g4_x_send_credential_e2e/twin_index.ts): G3's manual-send twin
#         whose `credentials` is G4's real source (G3's adapter over x_send_credential_source.ts) instead of G3's fake snapshot;
#       - one more test step, L47 (postona_g4_x_send_credential_e2e/l47_step.ts.txt), at the end of G3's local_test.ts;
#       - the run stops after local_test.ts (G1's screen, pg_cron and G3's rollback are G3's proofs, not repeated here).
#   * G3's L0-L46 run unchanged before L47 (G3's evidence is re-measured as a side effect, not claimed as G4's).
# Needs what G3's run.sh needs (supabase CLI 2.116.0, podman with the images, deno, psql, openssl) and free ports 55921 / 55922.
# Run alone. Usage: supabase/tests/postona_g4_x_send_credential_e2e_run.sh
set -euo pipefail
export LC_ALL=C NO_COLOR=1
# G4-02 #20: 003 now answers only for a G3 send attempt (reservation id + lease + the manual send's session). G3 PR #699's manual send
# still calls credentialFor(account) with no attempt, so on this stack G4's source answers nothing and L47's "sent" cannot hold. This
# harness (G4-02 #19's account-only 003) is kept as the record of #19; it is re-enabled only once G3's port passes the attempt.
if [ "${G4XS_E2E_FORCE_19:-0}" != 1 ]; then
  echo "G4XS_E2E_NOT_APPLICABLE: needs G3's credentialFor(account, attempt) port (G4-02 #20); nothing was run" >&2
  exit 3
fi
G3=8ebf3a7b079a79817644a2317139c16cb7465ca4   # G3 PR #699 HEAD
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
fail() { echo "FAIL $*" >&2; exit 1; }
git -C "$repo" cat-file -e "${G3}^{commit}" 2>/dev/null || fail "missing git objects for $G3 (fetch G3 PR #699)"
objects="$(cd "$repo" && cd "$(git rev-parse --git-common-dir)" && pwd)/objects"
S="$(mktemp -d /private/tmp/g4xse.XXXXXX)"
cleanup() { if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$S"; else echo "kept $S"; fi; }
trap cleanup EXIT
mkdir -p "$S/repo"
git -C "$repo" archive "$G3" supabase apps/social-mobile/src | tar -x -C "$S/repo"   # local_test.ts imports G1 stores
git -C "$S/repo" init -q
echo "$objects" > "$S/repo/.git/objects/info/alternates"
[ "$(git -C "$S/repo" rev-parse --show-toplevel)" = "$(cd "$S/repo" && pwd -P)" ] || fail "scratch repo"
git -C "$S/repo" cat-file -e "${G3}^{commit}" || fail "alternates"
ls_dir="$S/repo/supabase/candidates/postona_reservations_rollout/local_stack"
mkdir -p "$ls_dir/postona-x-single-post-g4cred-e2etest" "$S/g4"
cp "$here/postona_g4_x_send_credential_e2e/twin_index.ts" "$ls_dir/postona-x-single-post-g4cred-e2etest/index.ts"
cp "$repo/supabase/candidates/postona_g4_credential_verdict/003_x_send_credential_read.sql" \
   "$repo/supabase/candidates/postona_g4_credential_verdict/x_send_credential_source.ts" "$S/g4/"
python3 -I - "$ls_dir/run.sh" "$ls_dir/local_test.ts" "$here/postona_g4_x_send_credential_e2e/l47_step.ts.txt" "$S/g4" <<'PY'
import sys
run, lt, step, g4 = sys.argv[1:5]
def rep(path, old, new):
    s = open(path).read()
    assert s.count(old) == 1, "G4XS anchor in %s: %s" % (path, old[:70])
    open(path, "w").write(s.replace(old, new))
# the new twin: verify_jwt, copied and type-checked like G3's own twins
rep(run, '"postona-x-approvals-localtest", "postona-x-single-post-e2etest"]:\n    s += f\'\\n[functions.{fn}]\\nverify_jwt = true\\n\'',
         '"postona-x-approvals-localtest", "postona-x-single-post-e2etest", "postona-x-single-post-g4cred-e2etest"]:\n    s += f\'\\n[functions.{fn}]\\nverify_jwt = true\\n\'')
rep(run, 'cp "$here/local_transport.ts" "$here/fake_x.ts" "$fns/_shared_g3ls/"\n',
         'cp "$here/local_transport.ts" "$here/fake_x.ts" "$fns/_shared_g3ls/"\nmkdir -p "$fns/_shared_g4"; cp "%s/x_send_credential_source.ts" "$fns/_shared_g4/"   # G4-02 #19\n' % g4)
rep(run, 'postona-x-approvals-localtest postona-x-single-post-e2etest; do\n',
         'postona-x-approvals-localtest postona-x-single-post-e2etest postona-x-single-post-g4cred-e2etest; do\n')
# G4's 003 after the world's 006 / 007 (the verdict 002 is already there)
rep(run, 'echo "OK world: G4\'s personal world at ${G4:0:8} on the real local schema (as postgres)"\n',
         'need "%s/003_x_send_credential_read.sql"   # G4-02 #19\n[ "$(own -A -t -c "select has_function_privilege(\'service_role\', \'public.postona_x_send_credential_v1(text)\', \'EXECUTE\')::text || has_function_privilege(\'authenticated\', \'public.postona_x_send_credential_v1(text)\', \'EXECUTE\')::text || has_function_privilege(\'anon\', \'public.postona_x_send_credential_v1(text)\', \'EXECUTE\')::text")" = truefalsefalse ] || fail "G4XS 003 ACL on the real image"\necho "OK G4XS 003 installed on the real image (EXECUTE: service_role only)"\necho "OK world: G4\'s personal world at ${G4:0:8} on the real local schema (as postgres)"\n' % g4)
# stop after G3's local_test.ts
rep(run, '    --allow-net="127.0.0.1:$API_PORT" --allow-run=psql "$here/local_test.ts"\n',
         '    --allow-net="127.0.0.1:$API_PORT" --allow-run=psql "$here/local_test.ts"\necho "G4XS_E2E_LOCAL_TEST_PASS"; exit 0   # G4-02 #19: G1 / cron / RB are G3\'s proofs\n')
# L47 at the end of G3's test
s = open(lt).read()
assert s.endswith("  });\n});\n"), "G4XS anchor: local_test.ts end"
open(lt, "w").write(s[: -len("});\n")] + open(step).read() + "});\n")
PY
echo "G4XS composed: G3 $G3 + G4 003 / source / twin / L47 (counted insertions; G3's checkout paths untouched)"
cd "$S" && bash "$ls_dir/run.sh" 2>&1 | tee "$S/run.log" | grep -E '^(OK|FAIL|G3LS_|G4XS_)|L4[67] |ok \||FAILED|error' || true
grep -q '^G4XS_E2E_LOCAL_TEST_PASS' "$S/run.log" && grep -q 'L47 G4-02 #19.* \.\.\. .*ok' "$S/run.log" || { tail -60 "$S/run.log"; fail "e2e"; }
grep -o 'G4XS_L47 .*' "$S/run.log"
echo "G4XS_E2E_ALL_PASS"
