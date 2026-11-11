#!/usr/bin/env bash
# G3-48: G3's X / Threads reservation consumers on G4's REAL publish-credential verdicts, on a THROW-AWAY LOCAL PostgreSQL 17.
# The world is G4's own: G4's runner (supabase/tests/postona_g4_threads_person_session_run.sh at the pinned G4 head, read from a
# temporary detached worktree, G4T_VERDICT=1) builds the PERSONAL profile world -- G5 MVP, G4's Threads g5pv binding + stack, G4's
# personal X OAuth 001-005, G4's verdict 001 + 002 -- and stops there (a patched copy that keeps the database; G4's files unchanged).
# Then, by G4's non-superuser lifecycle owner:
#   G3 X 001-006 + 008 + 010 + 012 and Threads 007 + 009 + 011 (G3's G4 TEST DOUBLES are NOT installed: the verdicts are real);
#   VI  013 / 014 refusals (superuser; G4's verdict body / ACL not the reviewed one; another G3 base), nothing changed; apply; re-apply;
#   VB  behaviour (g4_verdict/behavior.sql): X through G4's real connect / disconnect, Threads on G4's binding shape; claim pins, the
#       pre-send check re-verifies, A->B->A / disconnect / refresh / service end / another person never send;
#   VR  rollback refusals (superuser, half applied, a widened ACL), rollback = 001 / 006 / 007 byte for byte (DENY again), twice refused;
#       re-apply;
#   VW  (G3-49) 015 refusals (014 not applied, superuser, also the owner itself), apply, re-apply refused; the generation-bound X
#       worker (g4_verdict/bound_worker_e2e_test.ts) through the real bound store + driver + x_publisher (fake fetch) on G4's real
#       verdict; 015 rollback refusals (superuser, also the owner itself, another body, a widened ACL), rollback, twice refused, re-apply;
#   VH  (G3-50) the PRODUCT worker entry (postona-x-reservation-worker/http.ts, g4_verdict/worker_http_e2e_test.ts): a real Request ->
#       createWorkerHandler -> bound delivery -> 015 -> fake X; the production default and a token-only source claim / connect nothing.
# No network, no credential, no managed project; no OAuth, token, Vault, SNS or paid call. Roles are cluster-wide: run alone. Usage:
#   RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> g4_verdict_run.sh
# The cluster must listen on 127.0.0.1 too (G4's runner). Optional: G3V_013 / G3V_014 / G3V_015 / G3V_013_RB / G3V_014_RB / G3V_015_RB
# (mutation runs).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
th="$here/../postona_threads_reservations"
g4head=c6df19cc612ad586126e80b009589ef3456b215f
g4runner=supabase/tests/postona_g4_threads_person_session_run.sh
x013="${G3V_013:-$th/013_postona_threads_resv_g4_verdict.sql}"; x013rb="${G3V_013_RB:-$th/013_postona_threads_resv_g4_verdict_rollback.sql}"
x014="${G3V_014:-$here/014_postona_x_resv_g4_verdict.sql}"; x014rb="${G3V_014_RB:-$here/014_postona_x_resv_g4_verdict_rollback.sql}"
x015="${G3V_015:-$here/015_postona_x_resv_bound_pre_publish.sql}"; x015rb="${G3V_015_RB:-$here/015_postona_x_resv_bound_pre_publish_rollback.sql}"
fail() { echo "FAIL $*" >&2; exit 1; }
git -C "$repo" cat-file -e "${g4head}^{commit}" 2>/dev/null || { echo "RUN_NOT_AVAILABLE: G4 head $g4head missing; git fetch origin $g4head" >&2; exit 3; }
[ "$(git -C "$repo" rev-parse "${g4head}:${g4runner}")" = 3030b21cc45e42d86288b422ba2cabb3c3d13868 ] || fail "G4 runner is not the pinned blob"
g4w="$(mktemp -d /private/tmp/kabumori-g3g4.XXXXXX)"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
db=""; owner=""; suffix=""
cleanup() {
  [ -n "$owner" ] && "${S[@]}" -d postgres -c "alter role $owner nosuperuser" >/dev/null 2>&1 || true
  if [ -n "$suffix" ]; then
    for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_tb_${suffix}_%'" 2>/dev/null); do
      "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
    done
    for r in $("${S[@]}" -d postgres -c "select rolname from pg_roles where rolname ~ '^kb_tb_[a-z0-9]+_${suffix}\$' order by rolname desc" 2>/dev/null); do
      "${S[@]}" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true
    done
  fi
  "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
  git -C "$repo" worktree remove --force "$g4w" >/dev/null 2>&1 || rm -rf "$g4w"
}
trap cleanup EXIT
"${S[@]}" -d postgres -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true

# --- G4's world (its own runner, read-only extraction; a copy that stops after the personal verdict install) ----------------------
rmdir "$g4w"
git -C "$repo" worktree add -q --detach "$g4w" "$g4head"
python3 -I - "$g4w/$g4runner" "$g4w/supabase/tests/g3_world_only.sh" <<'PY'
import sys
s = open(sys.argv[1]).read()
keep = 'trap cleanup EXIT\n'
stop = '  echo "ok personal X 001-005 + the X verdict installed on the personal profile"\n'
assert s.count(keep) == 1 and s.count(stop) == 1, "G4 runner changed: patch points not found"
s = s.replace(keep, 'trap \'rm -rf "$tree"\' EXIT\n').replace(stop, stop + '  echo "G4_WORLD_DB=$pv OWNER=$owner"; exit 0\n')
open(sys.argv[2], 'w').write(s)
PY
out="$(cd "$g4w" && G4T_VERDICT=1 TB_PGHOST="$host" TB_PGPORT="$port" TB_PGSUPER="$super" bash supabase/tests/g3_world_only.sh 2>&1)" || { printf '%s\n' "$out" | tail -5 >&2; fail "G4 world"; }
db="$(sed -n 's/^G4_WORLD_DB=\([^ ]*\) OWNER=.*/\1/p' <<<"$out")"; owner="$(sed -n 's/^G4_WORLD_DB=.* OWNER=\(.*\)$/\1/p' <<<"$out")"
suffix="${owner##*_}"
[ -n "$db" ] && [ -n "$owner" ] || fail "G4 world: no database ($out)"
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
val() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
sval() { "${S[@]}" -d "$db" "$@"; }
expect_err() {
  local label="$1" pat="$2"; shift 2
  local o
  if o="$("$@" 2>&1)"; then fail "$label: succeeded"; fi
  printf '%s\n' "$o" | grep -q -- "$pat" || fail "$label: $o"
}
[ "$(sval -c "select string_agg(md5(prosrc), ',' order by proname) from pg_proc where oid in ('postona_g4_credential.threads_publish_credential_verdict(uuid,text)'::regprocedure,
  'postona_g4_credential.x_publish_credential_verdict(uuid,text)'::regprocedure)")" = "fb93a0ad84c44c6781521eec4618fff4,46643d50a4a6c6a82867061328de05bf" ] \
  || fail "G4's verdicts are not the pinned bodies"
[ "$(sval -c "select (select rolsuper from pg_roles where rolname = '$owner')::text || '/' || (select proowner::regrole::text from pg_proc where oid = 'postona_g4_credential.x_publish_credential_verdict(uuid,text)'::regprocedure)")" = "false/$owner" ] \
  || fail "G4's verdict owner is not the non-superuser lifecycle owner"
# G3-02 #14: the connection-generation check 014 calls, from G4 PR #617 (read only)
for f in 006_x_connect_profile_fence 007_x_refresh_precheck; do
  git -C "$repo" show "1d020c406cc982eedfa29a8b682c96db31888a68:supabase/candidates/postona_g4_x_oauth_personal_mvp/$f.sql" | own -f - >/dev/null || fail "G4 $f"
done
echo "OK world: G4's personal world at $g4head (G4's runner, G4T_VERDICT) with G4's verdicts (md5 pinned), owner $owner"

# --- G3 base --------------------------------------------------------------------------------------------------------------------------
for f in "$here/001_postona_x_reservations.sql" "$here/002_postona_x_resv_api_role.sql" "$here/003_postona_x_resv_g5_binding.sql" "$here/004_postona_x_resv_dispatch.sql" \
         "$here/005_postona_x_single_post.sql" "$here/006_postona_x_single_post_live_fence.sql" "$here/008_postona_x_resv_personal_mvp.sql" \
         "$here/010_postona_x_resv_owner_cancel.sql" "$here/012_postona_x_resv_owner_read.sql" "$th/007_postona_threads_reservations.sql" \
         "$th/009_postona_threads_resv_personal_mvp.sql" "$th/011_postona_threads_resv_uncertain_audit.sql"; do
  own -f "$f" >/dev/null || fail "install $(basename "$f")"
done
# the API / worker roles are NOLOGIN roles for the future Edge / worker logins; the TEST WORLD lets the owner act as them
sval -c "grant postona_resv_api, postona_resv_worker to $owner with set true" >/dev/null
echo "OK G3: X 001-006 + 008 + 010 + 012, Threads 007 + 009 + 011 on G4's world (no G4 test double)"

catalog() { sval -c "select md5(coalesce(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '-'), ' ' order by p.oid::regprocedure::text), ''))
  || (select md5(coalesce(string_agg(c.oid::regclass::text || '.' || a.attname, ',' order by 1), '')) from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.oid in ('postona_x_resv.reservations'::regclass, 'postona_threads_resv.reservations'::regclass) and a.attnum > 0 and not a.attisdropped)
  || (select coalesce(string_agg(tgname, ',' order by tgname), '') from pg_trigger where not tgisinternal and tgrelid in ('postona_x_resv.reservations'::regclass, 'postona_threads_resv.reservations'::regclass))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('postona_x_resv', 'postona_threads_resv', 'postona_g4_credential')"; }
expect_refused() {
  local label="$1" pat="$2"; shift 2
  local c0; c0="$(catalog)"
  expect_err "$label" "$pat" "$@"
  [ "$(catalog)" = "$c0" ] || fail "$label: a refusal changed the catalog"
}
pre_procs="$(sval -c "select string_agg(proname || '=' || md5(prosrc), ',' order by proname) from pg_proc where oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::regprocedure,
  'postona_x_resv.x_credential_generation(text)'::regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::regprocedure,
  'postona_threads_resv.g4_threads_account_verified(uuid,text)'::regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::regprocedure)")"
procs_now() { sval -c "select string_agg(proname || '=' || md5(prosrc), ',' order by proname) from pg_proc where oid in ('postona_x_resv.g4_x_account_verified(uuid,text)'::regprocedure,
  'postona_x_resv.x_credential_generation(text)'::regprocedure, 'postona_x_resv.row_publishable(postona_x_resv.reservations)'::regprocedure,
  'postona_threads_resv.g4_threads_account_verified(uuid,text)'::regprocedure, 'postona_threads_resv.threads_credential_generation(text)'::regprocedure)"; }

# --- VI -----------------------------------------------------------------------------------------------------------------------------
expect_err "VI0 013 rollback before 013" G3_THREADS_VERDICT_ROLLBACK_NOT_APPLIED own -f "$x013rb"
expect_err "VI0 014 rollback before 014" G3_X_VERDICT_ROLLBACK_NOT_APPLIED own -f "$x014rb"
expect_refused "VI1 013 as a superuser" G3_THREADS_VERDICT_OWNER sval -f "$x013"
expect_refused "VI1 014 as a superuser" G3_X_VERDICT_OWNER sval -f "$x014"
# the owner itself turned superuser (owns everything): still refused -- a superuser never installs these
sval -c "alter role $owner superuser" >/dev/null
expect_refused "VI1b 013, the owner is a superuser" G3_THREADS_VERDICT_OWNER own -f "$x013"
expect_refused "VI1b 014, the owner is a superuser" G3_X_VERDICT_OWNER own -f "$x014"
sval -c "alter role $owner nosuperuser" >/dev/null
work="$g4w/g3_work"; mkdir -p "$work"
tdef="$(val -c "select pg_get_functiondef('postona_g4_credential.threads_publish_credential_verdict(uuid,text)'::regprocedure)")"
printf 'begin;\n%s;\n' "${tdef/NOT_BOUND/NOT_BOUND_X}" > "$work/g4_other_t.sql"
grep -q NOT_BOUND_X "$work/g4_other_t.sql" || fail "VI2 probe not built"
expect_refused "VI2 013, G4's Threads verdict not the reviewed body" G3_THREADS_VERDICT_G4_VERDICT_UNKNOWN own -f "$work/g4_other_t.sql" -f "$x013"
xdef="$(val -c "select pg_get_functiondef('postona_g4_credential.x_publish_credential_verdict(uuid,text)'::regprocedure)")"
printf 'begin;\n%s;\n' "${xdef/LINEAGE_UNKNOWN/LINEAGE_UNKNOWN_X}" > "$work/g4_other_x.sql"
grep -q LINEAGE_UNKNOWN_X "$work/g4_other_x.sql" || fail "VI2 X probe not built"
expect_refused "VI2 014, G4's X verdict not the reviewed body" G3_X_VERDICT_G4_VERDICT_UNKNOWN own -f "$work/g4_other_x.sql" -f "$x014"
expect_refused "VI3 013, G4's Threads verdict executable by authenticated" G3_THREADS_VERDICT_G4_VERDICT_UNKNOWN \
  own -c "begin" -c "grant execute on function postona_g4_credential.threads_publish_credential_verdict(uuid, text) to authenticated" -f "$x013"
expect_refused "VI3 014, G4's X verdict executable by postona_resv_api" G3_X_VERDICT_G4_VERDICT_UNKNOWN \
  own -c "begin" -c "grant execute on function postona_g4_credential.x_publish_credential_verdict(uuid, text) to postona_resv_api" -f "$x014"
expect_refused "VI4 014 on another G3 base (a G4 test double)" G3_X_VERDICT_BASE_UNKNOWN \
  own -c "begin" -c "create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean language sql stable security definer set search_path = '' as \$\$ select true \$\$" -f "$x014"
sval -c "alter table postona_x_resv.reservations owner to authenticated" >/dev/null
expect_err "VI5 014, table of another owner" G3_X_VERDICT_OWNER own -f "$x014"
sval -c "alter table postona_x_resv.reservations owner to $owner" >/dev/null
sval -c "alter schema postona_threads_resv owner to authenticated" >/dev/null
expect_err "VI5 013, schema of another owner" G3_THREADS_VERDICT_OWNER own -f "$x013"
sval -c "alter schema postona_threads_resv owner to $owner" >/dev/null
own -f "$x013" >/dev/null || fail "apply 013"
own -f "$x014" >/dev/null || fail "apply 014"
applied="$(catalog)"
expect_refused "VI6 013 re-apply" G3_THREADS_VERDICT_BASE_UNKNOWN own -f "$x013"
expect_refused "VI6 014 re-apply" G3_X_VERDICT_BASE_UNKNOWN own -f "$x014"
[ "$(sval -c "select count(*) from pg_proc p, aclexplode(p.proacl) a where p.pronamespace = 'postona_g4_credential'::regnamespace and a.grantee <> '$owner'::regrole")" = 0 ] \
  || fail "VI7 G4's verdicts gained a grantee"
echo "OK VI: 013 / 014 refusals (superuser, also the owner itself; G4 verdict body / ACL not the reviewed one; another G3 base; table / schema of another owner), nothing changed; apply; re-apply refused; no GRANT"

# --- VB -----------------------------------------------------------------------------------------------------------------------------
out="$(own -A -t -f "$here/g4_verdict/behavior.sql" 2>&1)" || { printf '%s\n' "$out" | grep -E 'FAIL|ERROR' | head -20 >&2; fail "VB behaviour"; }
printf '%s\n' "$out" | grep -qx G3_G4_VERDICT_BEHAVIOR_PASS || fail "VB: no PASS line"
n="$(printf '%s\n' "$out" | grep -cE '^[0-9]+\|.*\|ok$')"
echo "OK VB: $n checks -- X through G4's real connect / disconnect: verified, claim pins the generation, pre-send re-verifies; disconnect, A->B->A, refresh in progress, lineage removed, service end, another person, single post reconnect never send; uncertain never re-claimed; Threads: verified only with G4's binding / custody, reconnect -> CREDENTIAL_CHANGED, custody expired, disconnect, A->B->A never reuses, service end; the real 2a-2 CHECK still refuses Threads publishing (U8)"

# --- VR -----------------------------------------------------------------------------------------------------------------------------
c_vr="$(catalog)"
expect_err "VR1 013 rollback as a superuser" G3_THREADS_VERDICT_ROLLBACK_OWNER sval -f "$x013rb"
expect_err "VR1 014 rollback as a superuser" G3_X_VERDICT_ROLLBACK_OWNER sval -f "$x014rb"
sval -c "alter role $owner superuser" >/dev/null
expect_err "VR1b 013 rollback, the owner is a superuser" G3_THREADS_VERDICT_ROLLBACK_OWNER own -f "$x013rb"
expect_err "VR1b 014 rollback, the owner is a superuser" G3_X_VERDICT_ROLLBACK_OWNER own -f "$x014rb"
sval -c "alter role $owner nosuperuser" >/dev/null
expect_err "VR2 014 rollback, half applied" G3_X_VERDICT_ROLLBACK_PARTIAL_STATE \
  own -c "begin" -c "drop trigger reservations_claim_credential_pin on postona_x_resv.reservations" -f "$x014rb"
python3 -I - "$x013rb" "$work/rb_half_t.sql" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.index("-- 007's g4_threads_account_verified, verbatim")
j = s.index("select false $$;", i) + len("select false $$;")
open(sys.argv[2], 'w').write("begin;\n" + s[i:j] + "\n")
PY
grep -q 'select false' "$work/rb_half_t.sql" || fail "VR2 probe not built"
expect_err "VR2 013 rollback, half applied" G3_THREADS_VERDICT_ROLLBACK_PARTIAL_STATE own -f "$work/rb_half_t.sql" -f "$x013rb"
sed "s|^-- 007's g4_threads_account_verified, verbatim\$|grant select on postona_threads_resv.reservations to authenticated;\\n&|" "$x013rb" > "$work/rb_acl_t.sql"
grep -q '^grant select on postona_threads_resv.reservations to authenticated;$' "$work/rb_acl_t.sql" || fail "VR3 probe not built"
expect_err "VR3 013 rollback with a widened ACL" "G3_THREADS_VERDICT_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/rb_acl_t.sql"
sed "s|^-- 001's g4_x_account_verified, verbatim\$|grant select on postona_x_resv.reservations to authenticated;\\n&|" "$x014rb" > "$work/rb_acl_x.sql"
grep -q '^grant select on postona_x_resv.reservations to authenticated;$' "$work/rb_acl_x.sql" || fail "VR3 X probe not built"
expect_err "VR3 014 rollback with a widened ACL" "G3_X_VERDICT_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/rb_acl_x.sql"
[ "$(catalog)" = "$c_vr" ] || fail "VR1-VR3: a refusal changed the catalog"
own -f "$x014rb" >/dev/null || fail "VR4 014 rollback"
own -f "$x013rb" >/dev/null || fail "VR4 013 rollback"
[ "$(procs_now)" = "$pre_procs" ] || fail "VR4 not 001 / 006 / 007 byte for byte"
[ "$(sval -c "select (select count(*) from pg_attribute where attrelid = 'postona_x_resv.reservations'::regclass and attname = 'claim_credential_generation' and not attisdropped)::text
  || '/' || (select count(*) from pg_trigger where tgname = 'reservations_claim_credential_pin')::text || '/' || (to_regprocedure('postona_x_resv.pin_claim_credential()') is null)::text")" = "0/0/true" ] \
  || fail "VR4 column / trigger left"
[ "$(sval -c "select postona_x_resv.g4_x_account_verified(gen_random_uuid(), 'x')::text || '/' || postona_threads_resv.g4_threads_account_verified(gen_random_uuid(), 't')::text")" = "false/false" ] \
  || fail "VR4 not DENY again"
expect_err "VR5 013 rollback twice" G3_THREADS_VERDICT_ROLLBACK_NOT_APPLIED own -f "$x013rb"
expect_err "VR5 014 rollback twice" G3_X_VERDICT_ROLLBACK_NOT_APPLIED own -f "$x014rb"
expect_refused "VW0 015 before 014" G3_X_BOUND_BASE_UNKNOWN own -f "$x015"
own -f "$x013" >/dev/null || fail "VR6 013 re-apply"
own -f "$x014" >/dev/null || fail "VR6 014 re-apply"
[ "$(catalog)" = "$applied" ] || fail "VR6 the re-applied catalog is not the first apply"
echo "OK VR: rollback refusals (superuser, also the owner itself, half applied, a widened ACL), rollback = 001 / 006 / 007 byte for byte (DENY again, no column / trigger), twice refused, re-apply = first apply"

# --- VW (G3-49) -----------------------------------------------------------------------------------------------------------------------
c_vw="$(catalog)"
expect_refused "VW1 015 as a superuser" G3_X_BOUND_OWNER sval -f "$x015"
sval -c "alter role $owner superuser" >/dev/null
expect_err "VW1b 015, the owner is a superuser" G3_X_BOUND_OWNER own -f "$x015"
sval -c "alter role $owner nosuperuser" >/dev/null
[ "$(catalog)" = "$c_vw" ] || fail "VW1: a refusal changed the catalog"
own -f "$x015" >/dev/null || fail "VW2 015 apply"
c_015="$(catalog)"
expect_refused "VW2 015 re-apply" G3_X_BOUND_BASE_UNKNOWN own -f "$x015"
[ "$(sval -c "select string_agg(a.grantee::regrole::text || '=' || a.privilege_type, ',' order by a.grantee::regrole::text) from pg_proc p, aclexplode(p.proacl) a
  where p.oid = 'postona_x_resv.pre_publish_check_bound(uuid,uuid)'::regprocedure")" = "$owner=EXECUTE,postona_resv_worker=EXECUTE" ] || fail "VW2 015 ACL not owner + worker"
[ "$(val -c "select g48.as_role('postona_resv_worker', null, 'select verdict || ''/'' || coalesce(credential_generation, ''null'') from postona_x_resv.pre_publish_check_bound(gen_random_uuid(), gen_random_uuid())')")" = "LEASE_LOST/null" ] \
  || fail "VW3 unknown row not LEASE_LOST/null"
val -c "select g48.as_role('postona_resv_api', null, 'select verdict from postona_x_resv.pre_publish_check_bound(gen_random_uuid(), gen_random_uuid())')" | grep -q '^ERR:permission denied' || fail "VW3 the API role reached 015"
# Rollout simulation (TEST WORLD only): the worker login is a member of postona_resv_worker, nothing else
wlogin="kb_tb_w49_${suffix}"
"${S[@]}" -d "$db" -c "create role $wlogin login noinherit" -c "grant postona_resv_worker to $wlogin" >/dev/null
vw_out="$work/bound_worker_e2e.out"
if ! RESV_LIVE_DB_URL="postgres://$wlogin@127.0.0.1:$port/$db" RESV_LIVE_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" \
  DENO_NO_PACKAGE_JSON=1 deno run --no-config --no-check --allow-net=127.0.0.1:"$port" --allow-read \
  --allow-env=RESV_LIVE_DB_URL,RESV_LIVE_OWNER_URL "$here/g4_verdict/bound_worker_e2e_test.ts" >"$vw_out" 2>&1; then
  sed 's/\x1b\[[0-9;]*m//g' "$vw_out" | grep -vE '^ok ' | head -30 >&2
  fail "VW worker e2e"
fi
grep -q '^G3_BOUND_WORKER_E2E_PASS ' "$vw_out" || fail "VW: no PASS line"
vw_res="$(grep '^G3_BOUND_WORKER_E2E_PASS ' "$vw_out")"
vh_out="$work/worker_http_e2e.out"
if ! RESV_LIVE_DB_URL="postgres://$wlogin@127.0.0.1:$port/$db" RESV_LIVE_OWNER_URL="postgres://$owner@127.0.0.1:$port/$db" \
  DENO_NO_PACKAGE_JSON=1 deno run --no-config --no-check --allow-net=127.0.0.1:"$port" --allow-read \
  --allow-env=RESV_LIVE_DB_URL,RESV_LIVE_OWNER_URL "$here/g4_verdict/worker_http_e2e_test.ts" >"$vh_out" 2>&1; then
  sed 's/\x1b\[[0-9;]*m//g' "$vh_out" | grep -vE '^ok ' | head -30 >&2
  fail "VH worker http e2e"
fi
grep -q '^G3_WORKER_HTTP_E2E_PASS ' "$vh_out" || fail "VH: no PASS line"
vh_res="$(grep '^G3_WORKER_HTTP_E2E_PASS ' "$vh_out")"
"${S[@]}" -d "$db" -c "drop owned by $wlogin" -c "drop role $wlogin" >/dev/null
echo "OK VW worker: ${vw_res#G3_BOUND_WORKER_E2E_PASS } -- TS derivation == DB (X, Threads); pinned == token generation -> one send with that token; disconnect / A->B->A / refresh after the token read -> NOT_PUBLISHABLE; stale token generation -> CREDENTIAL_GENERATION_CHANGED; lease too short -> RELEASED then one send; unknown -> uncertain, never re-sent; the worker login cannot call G4"
echo "OK VH: ${vh_res#G3_WORKER_HTTP_E2E_PASS } -- the product entry: production default / token-only source -> notAvailable, claim 0, connection 0, X 0; gate OFF 503, wrong secret 401; same generation -> one send with that token; disconnect / A->B->A -> NOT_PUBLISHABLE; other generation -> CREDENTIAL_GENERATION_CHANGED; lease too short -> RELEASED then one send; unknown -> uncertain, never re-sent"
expect_err "VW5 015 rollback as a superuser" G3_X_BOUND_ROLLBACK_OWNER sval -f "$x015rb"
sval -c "alter role $owner superuser" >/dev/null
expect_err "VW5b 015 rollback, the owner is a superuser" G3_X_BOUND_ROLLBACK_OWNER own -f "$x015rb"
sval -c "alter role $owner nosuperuser" >/dev/null
expect_err "VW6 015 rollback, another body" G3_X_BOUND_ROLLBACK_UNKNOWN own -c "begin" -c "create or replace function postona_x_resv.pre_publish_check_bound(p_reservation_id uuid, p_lease_token uuid)
  returns table (verdict text, credential_generation text) language sql security definer set search_path = '' as \$\$ select 'OK'::text, null::text \$\$" -f "$x015rb"
sed "s|^drop function postona_x_resv.pre_publish_check_bound(uuid, uuid);\$|grant execute on function postona_x_resv.pre_publish_check(uuid, uuid) to postona_resv_api;\\n&|" "$x015rb" > "$work/rb_acl_015.sql"
grep -q '^grant execute on function postona_x_resv.pre_publish_check(uuid, uuid) to postona_resv_api;$' "$work/rb_acl_015.sql" || fail "VW7 probe not built"
expect_err "VW7 015 rollback with a widened ACL" "G3_X_BOUND_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/rb_acl_015.sql"
[ "$(catalog)" = "$c_015" ] || fail "VW5-VW7: a refusal changed the catalog"
own -f "$x015rb" >/dev/null || fail "VW8 015 rollback"
[ "$(catalog)" = "$c_vw" ] || fail "VW8 rollback is not the catalog before 015"
expect_err "VW8 015 rollback twice" G3_X_BOUND_ROLLBACK_NOT_APPLIED own -f "$x015rb"
own -f "$x015" >/dev/null || fail "VW9 015 re-apply"
[ "$(catalog)" = "$c_015" ] || fail "VW9 the re-applied catalog is not the first apply"
echo "OK VW: 015 refusals (014 not applied, superuser, also the owner itself), apply = owner + worker EXECUTE only, re-apply refused, unknown row LEASE_LOST/null, API role denied; rollback refusals (superuser, also the owner itself, another body, a widened ACL), rollback = the catalog before 015, twice refused, re-apply = first apply"

# --- VG (G3-02 #15): 017, the read-only connection_generation on list / get ----------------------------------------------------------
x017="${G3V_017:-$here/017_postona_x_resv_connection_generation.sql}"; x017rb="$here/017_postona_x_resv_connection_generation_rollback.sql"
fnacl() { sval -c "select string_agg(p.proname || ':' || p.proowner || ':' || coalesce(p.proacl::text, '-') || ':' || p.prosecdef::text || ':' || p.provolatile::text, '|' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'postona_x_resv' and p.proname in ('list_reservations', 'get_reservation')"; }
acl0="$(fnacl)"; c_vg="$(catalog)"
expect_refused "VG1 017 as a superuser" G3_CONNECTION_GENERATION_OWNER sval -f "$x017"
sval -c "alter role $owner superuser" >/dev/null
expect_refused "VG1b 017, the owner is a superuser" G3_CONNECTION_GENERATION_OWNER own -f "$x017"
sval -c "alter role $owner nosuperuser" >/dev/null
expect_refused "VG2 017, another list body" G3_CONNECTION_GENERATION_BASE_UNKNOWN own -c "begin" -c "create or replace function postona_x_resv.list_reservations(p_social_account_id text) returns setof postona_x_resv.reservation_view language sql stable security definer set search_path = '' as \$\$ select null::postona_x_resv.reservation_view where false \$\$" -f "$x017"
expect_refused "VG2b 017, another verified body" G3_CONNECTION_GENERATION_BASE_UNKNOWN own -c "begin" -c "create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean language sql stable security definer set search_path = '' as \$\$ select true \$\$" -f "$x017"
own -f "$x017" >/dev/null || fail "VG3 017 apply"
[ "$(fnacl)" = "$acl0" ] || fail "VG3 the owner / ACL / definer / volatility of list / get changed: $acl0 -> $(fnacl)"
[ "$(sval -c "select coalesce(array_length(proacl, 1), 0) || ':' || prosecdef from pg_proc where oid = 'postona_x_resv.connection_generation_of(postona_x_resv.reservations)'::regprocedure")" = "1:false" ] || fail "VG3 the helper is reachable or a definer"
c_017="$(catalog)"
expect_refused "VG4 017 re-apply" G3_CONNECTION_GENERATION_BASE_UNKNOWN own -f "$x017"
out="$(own -A -t -f "$here/g4_verdict/connection_generation.sql" 2>&1)" || { printf '%s\n' "$out" | grep -E 'FAIL|ERROR' | head -20 >&2; fail "VG behaviour"; }
printf '%s\n' "$out" | grep -qx G3_CONNECTION_GENERATION_BEHAVIOR_PASS || fail "VG: no PASS line"
vg_n="$(printf '%s\n' "$out" | grep -c '|ok$' || true)"
[ "$(catalog)" = "$c_017" ] || fail "VG behaviour changed the catalog"
expect_err "VG5 017 rollback as a superuser" G3_CONNECTION_GENERATION_ROLLBACK_OWNER sval -f "$x017rb"
sed "s|^revoke all on function postona_x_resv.list_reservations(text), postona_x_resv.get_reservation(uuid) from public;\$|&\\ngrant execute on function postona_x_resv.get_reservation(uuid) to authenticated;|" "$x017rb" > "$work/rb_acl_017.sql"
grep -q 'get_reservation(uuid) to authenticated;$' "$work/rb_acl_017.sql" || fail "VG6 probe not built"
expect_err "VG6 017 rollback with a widened ACL" "G3_CONNECTION_GENERATION_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/rb_acl_017.sql"
[ "$(catalog)" = "$c_017" ] || fail "VG5-VG6: a refusal changed the catalog"
own -f "$x017rb" >/dev/null || fail "VG7 017 rollback"
[ "$(catalog)" = "$c_vg" ] || fail "VG7 rollback is not the catalog before 017"
[ "$(fnacl)" = "$acl0" ] || fail "VG7 ACL after the rollback"
[ -z "$(sval -c "select 1 from pg_type where typname = 'reservation_read_view'")" ] || fail "VG7 the type is still there"
expect_err "VG7 017 rollback twice" G3_CONNECTION_GENERATION_ROLLBACK_NOT_APPLIED own -f "$x017rb"
own -f "$x017" >/dev/null || fail "VG8 017 re-apply"
[ "$(catalog)" = "$c_017" ] || fail "VG8 the re-applied catalog is not the first apply"
echo "OK VG: 017 refusals (superuser, also the owner itself, another list / verified body, re-apply), apply keeps owner + ACL + definer of list / get, helper owner-only and not a definer, behaviour $vg_n checks, rollback refusals (superuser, widened ACL), rollback = the catalog before 017, re-apply = the first apply"

# --- VA (G3-02 #16): 018, post approval + the person's notifications ------------------------------------------------------------------
x018="${G3V_018:-$here/018_postona_x_resv_approvals.sql}"; x018rb="$here/018_postona_x_resv_approvals_rollback.sql"
c_va="$(catalog)"
expect_refused "VA1 018 as a superuser" G3_APPROVALS_OWNER sval -f "$x018"
sval -c "alter role $owner superuser" >/dev/null
expect_refused "VA1b 018, the owner is a superuser" G3_APPROVALS_OWNER own -f "$x018"
sval -c "alter role $owner nosuperuser" >/dev/null
own -f "$x017rb" >/dev/null || fail "VA2 017 rollback for the probe"
expect_refused "VA2 018 without 017" G3_APPROVALS_BASE_UNKNOWN own -f "$x018"
own -f "$x017" >/dev/null || fail "VA2 017 re-apply"
[ "$(catalog)" = "$c_va" ] || fail "VA2 the probe changed the catalog"
sed "s|^to postona_resv_api;\$|to postona_resv_api, authenticated;|" "$x018" > "$work/a_acl_018.sql"
grep -q '^to postona_resv_api, authenticated;$' "$work/a_acl_018.sql" || fail "VA3 probe not built"
expect_refused "VA3 018 with a widened grant" "G3_APPROVALS_POSTCONDITION" own -f "$work/a_acl_018.sql"
own -f "$x018" >/dev/null || fail "VA4 018 apply"
c_018="$(catalog)"
expect_refused "VA4 018 re-apply" G3_APPROVALS_ALREADY_APPLIED own -f "$x018"
out="$(own -A -t -f "$here/g4_verdict/approvals.sql" 2>&1)" || { printf '%s\n' "$out" | grep -E 'FAIL|ERROR' | head -20 >&2; fail "VA behaviour"; }
printf '%s\n' "$out" | grep -qx G3_APPROVALS_BEHAVIOR_PASS || fail "VA: no PASS line"
va_n="$(printf '%s\n' "$out" | grep -c '|ok$' || true)"
[ "$(catalog)" = "$c_018" ] || fail "VA behaviour changed the catalog"
# --- VR18 (G3-02 #18, H1 #38 P2): an ownership loss vs a notification write, in two real sessions (person 4843 of approvals.sql) -------
now_s() { python3 -I -c 'import time; print(f"{time.time():.3f}")'; }
rows43() { val -c "select (select count(*) from postona_x_resv.notifications where user_id = g48.u(4843))::text || '/' || (select count(*) from postona_x_resv.push_outbox where user_id = g48.u(4843))::text"; }
moved43() { own -c "update postona_x_resv.reservations set revision = revision + 1, updated_at = now() where id = (select reservation_id from postona_x_resv.approval_candidates where id = g48.id('g2'))" >/dev/null; }   # SYNTHETIC: a new reservation state to report
lose43() { echo "delete from public.brand_memberships where user_id = g48.u(4843) and brand_id = g48.ws(4843) and role = 'owner';"; }
own -c "create table g48.bm43 as select * from public.brand_memberships where user_id = g48.u(4843) and role = 'owner'" >/dev/null
restore43() { own -c "insert into public.brand_memberships select * from g48.bm43 b where not exists (select 1 from public.brand_memberships m where m.brand_id = b.brand_id and m.user_id = b.user_id)" >/dev/null; }
barrier() { own -c "create function g48.barrier() returns trigger language plpgsql as \$\$ begin perform pg_sleep($1); return new; end \$\$" -c "create trigger g3_barrier before insert on postona_x_resv.notifications for each row execute function g48.barrier()" >/dev/null; }
unbarrier() { own -c "drop trigger g3_barrier on postona_x_resv.notifications" -c "drop function g48.barrier()" >/dev/null; }
listing43() { val -c "select g48.ap_notes(4843)"; }
# W: the write passes its guard first and waits (a test-only BEFORE INSERT barrier, H1's fixture); the loss arrives during the wait
moved43; barrier 3; r0="$(rows43)"
listing43 > "$work/w_list.txt" 2>&1 & lp=$!
sleep 1
t0="$(now_s)"; own -c "set lock_timeout = '20s'" -c "$(lose43)" >/dev/null || fail "VR18-W the loss failed"; t1="$(now_s)"
wait "$lp" || fail "VR18-W the list failed: $(cat "$work/w_list.txt")"
unbarrier
waited="$(python3 -I -c "print('waited' if $t1 - $t0 >= 1.5 else 'not waited')")"
r1="$(rows43)"
[ "$waited" = waited ] || fail "VR18-W the loss committed during the notification write (rows $r0 -> $r1, the H1 #38 race)"
[ "$r1" = "$(python3 -I -c "a, b = '$r0'.split('/'); print(f'{int(a) + 1}/{int(b) + 1}')")" ] || fail "VR18-W expected the event written while still the owner: $r0 -> $r1"
restore43
# L: the loss is in flight first (uncommitted, held 3 s); the list waits for it and then writes nothing
moved43; r0="$(rows43)"
own -c "begin" -c "$(lose43)" -c "select pg_sleep(3)" -c "commit" >/dev/null & dp=$!
sleep 1
t0="$(now_s)"; answer="$(listing43)"; t1="$(now_s)"
wait "$dp" || fail "VR18-L the loss failed"
[ "$answer" = "-" ] || fail "VR18-L a former owner's list answered $answer"
[ "$(rows43)" = "$r0" ] || fail "VR18-L wrote $r0 -> $(rows43) after the loss committed"
python3 -I -c "import sys; sys.exit(0 if $t1 - $t0 >= 1.5 else 1)" || fail "VR18-L the list did not wait for the loss"
restore43
# B: the owner again, two lists at once: the event once
moved43; r0="$(rows43)"
listing43 >/dev/null & p1=$!; listing43 >/dev/null & p2=$!
wait "$p1" && wait "$p2" || fail "VR18-B a list failed"
[ "$(rows43)" = "$(python3 -I -c "a, b = '$r0'.split('/'); print(f'{int(a) + 1}/{int(b) + 1}')")" ] || fail "VR18-B two lists: $r0 -> $(rows43)"
# P: a change of the workspace's profile (the brands row G5's eligibility reads, SYNTHETIC) during a write waits for it (the brand lock)
moved43; barrier 3
listing43 > "$work/p_list.txt" 2>&1 & lp=$!
sleep 1
prof="$(val -c "select code_profile_key from public.brands where id = g48.ws(4843)")"
t0="$(now_s)"; own -c "set lock_timeout = '20s'" -c "update public.brands set code_profile_key = 'g3_other_profile' where id = g48.ws(4843)" >/dev/null || fail "VR18-P update"; t1="$(now_s)"
wait "$lp" || fail "VR18-P the list failed"
unbarrier
own -c "update public.brands set code_profile_key = '$prof' where id = g48.ws(4843)" >/dev/null
python3 -I -c "import sys; sys.exit(0 if $t1 - $t0 >= 1.5 else 1)" || fail "VR18-P the profile change did not wait for the write"
# S: G5's restart (it updates the account row) during a notification write waits for it (the account row lock)
moved43; own -c "update public.service_entitlements set status = 'ended', ended_at = now() where user_id = g48.u(4843) and service_key = 'x_autopost'" >/dev/null   # SYNTHETIC end
barrier 3
listing43 > "$work/s_list.txt" 2>&1 & lp=$!
sleep 1
t0="$(now_s)"; [ "$(val -c "set lock_timeout = '20s'" -c "select g48.cg_restart(4843)")" = active ] || fail "VR18-S restart"; t1="$(now_s)"
wait "$lp" || fail "VR18-S the list failed"
unbarrier
python3 -I -c "import sys; sys.exit(0 if $t1 - $t0 >= 1.5 else 1)" || fail "VR18-S the restart did not wait for the write"
own -c "drop table g48.bm43" >/dev/null
[ "$(catalog)" = "$c_018" ] || fail "VR18 left something in the catalog"
echo "OK VR18: the loss during a write waits for it (W, +1 while the owner); a loss in flight first makes the list wait and write 0 (L); two owner lists write once (B); a workspace profile change waits for a write (P); G5's restart waits for a write (S)"
# --- VG5 (G3-02 #19): G5 PR #645's ownership-lock trigger (pinned, read only, applied in this throw-away world only) against notify() --
g5head=a4d6c0eb56441abaf00717128720e5bf6209a329; g5dir=supabase/candidates/postona_workspace_ownership_lock
git -C "$repo" cat-file -e "${g5head}^{commit}" 2>/dev/null || { echo "RUN_NOT_AVAILABLE: G5 head $g5head missing; git fetch origin $g5head" >&2; exit 3; }
[ "$(git -C "$repo" rev-parse "${g5head}:${g5dir}/001_workspace_ownership_lock.sql")" = f434be5a1ca0663fe5b6efe5666cebc9f25e885c ] || fail "G5 001 is not the pinned blob"
[ "$(git -C "$repo" rev-parse "${g5head}:${g5dir}/001_workspace_ownership_lock_rollback.sql")" = 3a8d741d9a3aebab85e158eb2da1007c4d926679 ] || fail "G5 001 rollback is not the pinned blob"
git -C "$repo" show "${g5head}:${g5dir}/001_workspace_ownership_lock.sql" > "$work/g5wo.sql"
git -C "$repo" show "${g5head}:${g5dir}/001_workspace_ownership_lock_rollback.sql" > "$work/g5wo_rb.sql"
# one race: a membership write ($1) arrives while notify() waits in the barrier; prints "waited" or "not waited"; $2 undoes it
member_race() {
  moved43; barrier 3
  listing43 > "$work/g5_list.txt" 2>&1 & lp=$!
  sleep 1
  t0="$(now_s)"; own -c "set lock_timeout = '20s'" -c "$1" >/dev/null || fail "VG5 the write failed: $1"; t1="$(now_s)"
  wait "$lp" || fail "VG5 the list failed: $(cat "$work/g5_list.txt")"
  unbarrier
  grep -q '^ERR' "$work/g5_list.txt" && fail "VG5 the list answered an error during the race: $(cat "$work/g5_list.txt")"
  own -c "$2" >/dev/null
  python3 -I -c "print('waited' if $t1 - $t0 >= 1.5 else 'not waited')"
}
add_member="insert into public.brand_memberships (brand_id, user_id, role) values (g48.ws(4843), g48.u(4842), 'member')"
del_member="delete from public.brand_memberships where brand_id = g48.ws(4843) and user_id = g48.u(4842)"
add_other="insert into public.brand_memberships (brand_id, user_id, role) values (g48.ws(4842), g48.u(4843), 'owner')"
del_other="delete from public.brand_memberships where brand_id = g48.ws(4842) and user_id = g48.u(4843)"
demote="update public.brand_memberships set role = 'member' where brand_id = g48.ws(4843) and user_id = g48.u(4843)"
promote="update public.brand_memberships set role = 'owner' where brand_id = g48.ws(4843) and user_id = g48.u(4843)"
# BEFORE G5's trigger (the gap G3 PR #644 reported): a second member joining does not wait for the notification write
[ "$(member_race "$add_member" "$del_member")" = "not waited" ] || fail "VG5-B0 expected the open gap before G5's trigger"
own -f "$work/g5wo.sql" >/dev/null || fail "VG5 G5 001 apply"
# AFTER: every eligibility-changing membership write waits for the write, and the next list writes nothing
[ "$(member_race "$add_member" "$del_member")" = waited ] || fail "VG5-I1 a second member joining did not wait for the notification write"
[ "$(member_race "$add_other" "$del_other")" = waited ] || fail "VG5-I2 owning another workspace did not wait for the notification write"
[ "$(member_race "$demote" "$promote")" = waited ] || fail "VG5-I3 a role change did not wait for the notification write"
moved43; r0="$(rows43)"
own -c "$add_member" >/dev/null
answer="$(listing43)"
[ "$(rows43)" = "$r0" ] || fail "VG5-I4 a list after a second member joined wrote $r0 -> $(rows43)"
own -c "$del_member" >/dev/null
[ "$(rows43)" = "$r0" ] || fail "VG5-I4 the member removal wrote something"
answer="$(listing43)"
[ "$(rows43)" = "$(python3 -I -c "a, b = '$r0'.split('/'); print(f'{int(a) + 1}/{int(b) + 1}')")" ] || fail "VG5-I4 personal again: expected the pending event once ($r0 -> $(rows43))"
echo "OK VG5: G5 PR #645 001 (pinned a4d6c0eb, applied here only): BEFORE it a second member joining did not wait (the gap); AFTER it a second member (I1), owning another workspace (I2) and a role change (I3) each wait for a notification write; with a second member the list writes 0, personal again it writes the event once (I4)"
counts="$(sval -c "select (select count(*) from postona_x_resv.approval_candidates)::text || ':' || (select count(*) from postona_x_resv.notifications)::text")"
expect_err "VA5 018 rollback as a superuser" G3_APPROVALS_ROLLBACK_OWNER sval -c "set postona_resv_approval_rollback.discard = '$counts'" -f "$x018rb"
expect_err "VA6 018 rollback, counts not stated" G3_APPROVALS_ROLLBACK_ROWS own -f "$x018rb"
expect_err "VA6b 018 rollback, wrong counts" G3_APPROVALS_ROLLBACK_ROWS own -c "set postona_resv_approval_rollback.discard = '0:0'" -f "$x018rb"
[ "$(catalog)" = "$c_018" ] || fail "VA5-VA6: a refusal changed the catalog"
resv_before="$(sval -c "select count(*) from postona_x_resv.reservations where draft_id like 'appr:%'")"
own -c "set postona_resv_approval_rollback.discard = '$counts'" -f "$x018rb" >/dev/null || fail "VA7 018 rollback"
[ "$(catalog)" = "$c_va" ] || fail "VA7 rollback is not the catalog before 018"
[ "$(sval -c "select count(*) from postona_x_resv.reservations where draft_id like 'appr:%'")" = "$resv_before" ] || fail "VA7 the rollback touched reservations"
expect_err "VA7 018 rollback twice" G3_APPROVALS_ROLLBACK_NOT_APPLIED own -f "$x018rb"
own -f "$x018" >/dev/null || fail "VA8 018 re-apply"
[ "$(catalog)" = "$c_018" ] || fail "VA8 the re-applied catalog is not the first apply"
echo "OK VA: 018 refusals (superuser, also the owner itself, 017 missing, a widened grant, re-apply), behaviour $va_n checks, rollback refusals (superuser, counts not stated / wrong), rollback = the catalog before 018 and reservations kept ($resv_before), twice refused, re-apply = the first apply"
own -f "$work/g5wo_rb.sql" >/dev/null || fail "VG5 G5 001 rollback"
[ "$(val -c "select count(*) from pg_trigger where tgname = 'postona_workspace_ownership_lock'")" = 0 ] || fail "VG5 G5's trigger is still there"
echo "OK VG5-RB: G3 018 rollback / re-apply ran with G5's trigger in place (VA5-VA8); G5's own rollback then removed it"
echo G3_G4_VERDICT_PASS
