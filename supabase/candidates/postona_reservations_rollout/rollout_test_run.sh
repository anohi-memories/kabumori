#!/usr/bin/env bash
# G3-51: the rollout bundle (rollout.sh + preflight.sql + MANIFEST.tsv) on a THROW-AWAY LOCAL PostgreSQL 17, in G4's PERSONAL world built by
# G4's own runner at the pinned head (as g4_verdict_run.sh: G5 MVP, G4's Threads g5pv binding + stack, G4's personal X 001-005, G4's verdict
# 001 + 002; read from a temporary detached worktree, G4's files unchanged). Phases:
#   RM  manifest: a non-/tmp host refused; a tampered sha refused before anything is read from the database;
#   RP  preflight refusals, each with the WHOLE database fingerprint unchanged: superuser (also the owner itself); G4's X verdict ACL widened;
#       G4's Threads verdict body altered; a G5 function widened / of another owner; U8 CHECK dropped; a default privilege for authenticated;
#       a partial G3 schema; no CREATEROLE; rollback mode on a fresh database;
#   RI  install (15 steps) + postcheck; a second install / preflight refused, nothing changed; postcheck refuses an exposed function / a
#       LOGIN worker role;
#   RS  smoke.sql (person reserve / read / cancel, another person sees nothing, claim pins G4's generation, bound check, outcome; Threads
#       create refused by U8; authenticated / anon reach nothing);
#   RB  rollback refusals with nothing changed (a live row; finished rows not stated / wrongly stated; consumers not stated; Threads rows
#       wrongly stated; a member that can SET the API / worker roles), then the full rollback: G3's catalog equals the fresh one; a second rollback refused;
#   RF  a step failing mid-install (a manifest whose 015 fails): the 14 applied steps are rolled back, G3's catalog equals the fresh one;
#       a failing first step leaves nothing;
#   RA  re-install: G3's catalog equals the first install exactly.
# No network, no credential, no managed project; no OAuth, token, Vault, SNS or paid call. Roles are cluster-wide: run alone. Usage:
#   RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> rollout_test_run.sh
# The cluster must listen on 127.0.0.1 too (G4's runner). Optional: G3RO_PREFLIGHT_SQL (mutation runs: a copy of preflight.sql).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
g4head=c6df19cc612ad586126e80b009589ef3456b215f
g4runner=supabase/tests/postona_g4_threads_person_session_run.sh
fail() { echo "FAIL $*" >&2; exit 1; }
git -C "$repo" cat-file -e "${g4head}^{commit}" 2>/dev/null || { echo "RUN_NOT_AVAILABLE: G4 head $g4head missing; git fetch origin $g4head" >&2; exit 3; }
[ "$(git -C "$repo" rev-parse "${g4head}:${g4runner}")" = 3030b21cc45e42d86288b422ba2cabb3c3d13868 ] || fail "G4 runner is not the pinned blob"
g4w="$(mktemp -d /private/tmp/kabumori-g3ro.XXXXXX)"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
db=""; owner=""; suffix=""; bundle=""
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

# --- G4's world (its own runner, read-only extraction; a copy that stops after the personal verdict install) ----------------------------
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
work="$g4w/g3_work"; mkdir -p "$work"
own() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
sval() { "${S[@]}" -d "$db" "$@"; }
echo "OK world: G4's personal world at $g4head (G4's runner, G4T_VERDICT), owner $owner"

# the bundle under test (a copy only when a mutated preflight is given; the manifest's paths still resolve to this checkout)
bundle="$here"
if [ -n "${G3RO_PREFLIGHT_SQL:-}" ]; then
  bundle="$work/bundle"; mkdir -p "$bundle"
  cp "$here/rollout.sh" "$here/MANIFEST.tsv" "$bundle/"; cp "$G3RO_PREFLIGHT_SQL" "$bundle/preflight.sql"
  sed -i '' "s|^root=.*|root=\"$here/..\"|" "$bundle/rollout.sh"
fi
ro() {  # <mode> [env assignments...]
  local m="$1"; shift
  env G3RO_PGHOST="$host" G3RO_PGPORT="$port" G3RO_DB="$db" G3RO_OWNER="$owner" "$@" bash "$bundle/rollout.sh" "$m"
}
# the WHOLE database: every function / relation / constraint / namespace outside the system schemas, roles, memberships, default privileges
dbfp() { sval -c "select md5(string_agg(x, '|' order by x)) from (
  select 'p:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || pg_get_userbyid(p.proowner) || ':' || coalesce(p.proacl::text, '-') || ':' || p.prosecdef::text as x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'
  union all select 'c:' || c.oid::regclass::text || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, '-') from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname !~ '^(pg_|information_schema)'
  union all select 'k:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated::text from pg_constraint
    where connamespace in (select oid from pg_namespace where nspname !~ '^(pg_|information_schema)')
  union all select 'n:' || nspname || ':' || pg_get_userbyid(nspowner) || ':' || coalesce(nspacl::text, '-') from pg_namespace where nspname !~ '^(pg_|information_schema)'
  union all select 'r:' || rolname || ':' || rolsuper::text || rolcreaterole::text || rolcanlogin::text || rolbypassrls::text from pg_roles where rolname !~ '^pg_'
  union all select 'm:' || pg_get_userbyid(roleid) || '>' || pg_get_userbyid(member) || ':' || pg_get_userbyid(grantor) from pg_auth_members
  union all select 'd:' || pg_get_userbyid(defaclrole) || ':' || defaclnamespace::text || ':' || defaclobjtype::text || ':' || defaclacl::text from pg_default_acl) s"; }
# G3's catalog only (rows not included)
g3fp() { sval -c "select md5(coalesce(string_agg(x, '|' order by x), '')) from (
  select 'p:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '-') as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('postona_x_resv', 'postona_threads_resv')
  union all select 'c:' || c.oid::regclass::text || ':' || coalesce(c.relacl::text, '-') from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('postona_x_resv', 'postona_threads_resv')
  union all select 'a:' || attrelid::regclass::text || '.' || attname from pg_attribute where attnum > 0 and not attisdropped
    and attrelid in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('postona_x_resv', 'postona_threads_resv'))
  union all select 't:' || tgname from pg_trigger where not tgisinternal and tgrelid in (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('postona_x_resv', 'postona_threads_resv'))
  union all select 'n:' || nspname || ':' || coalesce(nspacl::text, '-') from pg_namespace where nspname in ('postona_x_resv', 'postona_threads_resv')
  union all select 'r:' || rolname from pg_roles where rolname in ('postona_resv_api', 'postona_resv_worker')) s"; }
expect_ro() {  # <label> <pattern> <mode> [env...]: refused with the pattern, the whole database unchanged
  local label="$1" pat="$2"; shift 2
  local before o
  before="$(dbfp)"
  if o="$(ro "$@" 2>&1)"; then fail "$label: succeeded ($o)"; fi
  printf '%s\n' "$o" | grep -q -- "$pat" || fail "$label: $o"
  [ "$(dbfp)" = "$before" ] || fail "$label: the refusal changed the database"
}

# --- RM -------------------------------------------------------------------------------------------------------------------------------
o="$(env G3RO_PGHOST=db.example.invalid G3RO_PGPORT=5432 G3RO_DB=postgres G3RO_OWNER=postgres bash "$bundle/rollout.sh" preflight 2>&1)" && fail "RM1 a remote host was accepted"
printf '%s\n' "$o" | grep -q G3_ROLLOUT_REFUSED_HOST || fail "RM1: $o"
awk -F '\t' 'BEGIN { OFS = "\t" } $2 == "x012" && $1 == "install" { $4 = "0" substr($4, 2) } { print }' "$here/MANIFEST.tsv" > "$work/m_tampered.tsv"
cmp -s "$work/m_tampered.tsv" "$here/MANIFEST.tsv" && fail "RM2 probe not built"
expect_ro "RM2 tampered manifest sha" "G3_ROLLOUT_MANIFEST_SHA: install x012" install G3RO_MANIFEST="$work/m_tampered.tsv"
echo "OK RM: a non-/tmp host refused (no managed / production mode); a tampered sha refused before the database is touched"

# --- RP -------------------------------------------------------------------------------------------------------------------------------
fresh_g3="$(g3fp)"
expect_ro "RP1 as a superuser" G3_ROLLOUT_PREFLIGHT_SUPERUSER preflight G3RO_OWNER="$super"
sval -c "alter role $owner superuser" >/dev/null
before_su="$(dbfp)"
o="$(ro preflight 2>&1)" && fail "RP1b owner superuser accepted"
printf '%s\n' "$o" | grep -q G3_ROLLOUT_PREFLIGHT_SUPERUSER || fail "RP1b: $o"
[ "$(dbfp)" = "$before_su" ] || fail "RP1b changed the database"
sval -c "alter role $owner nosuperuser" >/dev/null
own -c "grant execute on function postona_g4_credential.x_publish_credential_verdict(uuid,text) to authenticated" >/dev/null
expect_ro "RP2 G4 X verdict granted to authenticated" "G3_ROLLOUT_PREFLIGHT_G4_VERDICT: postona_g4_credential.x_publish_credential_verdict" preflight
own -c "revoke execute on function postona_g4_credential.x_publish_credential_verdict(uuid,text) from authenticated" >/dev/null
own -c "select pg_get_functiondef('postona_g4_credential.threads_publish_credential_verdict(uuid,text)'::regprocedure)" > "$work/g4t.sql"
grep -q 'CREATE OR REPLACE FUNCTION' "$work/g4t.sql" || fail "RP3 probe: no definition"
own -c "select set_config('g3ro.t', '1', false)" -c "do \$\$ declare d text := pg_get_functiondef('postona_g4_credential.threads_publish_credential_verdict(uuid,text)'::regprocedure);
  begin execute replace(d, 'AS \$function\$', 'AS \$function\$ -- altered' || chr(10)); end \$\$" >/dev/null
expect_ro "RP3 G4 Threads verdict body altered" "G3_ROLLOUT_PREFLIGHT_G4_VERDICT: postona_g4_credential.threads_publish_credential_verdict" preflight
own -f "$work/g4t.sql" >/dev/null
[ "$(sval -c "select md5(prosrc) from pg_proc where oid = 'postona_g4_credential.threads_publish_credential_verdict(uuid,text)'::regprocedure")" = fb93a0ad84c44c6781521eec4618fff4 ] || fail "RP3 restore"
own -c "grant execute on function private.postona_personal_session() to authenticated" >/dev/null
expect_ro "RP4 G5 function granted to authenticated" "G3_ROLLOUT_PREFLIGHT_G5_NOT_OWNER_ONLY: private.postona_personal_session()" preflight
own -c "revoke execute on function private.postona_personal_session() from authenticated" >/dev/null
sval -c "alter function private.account_lifecycle_brand_owner(text) owner to authenticated" >/dev/null
expect_ro "RP4b G5 function of another owner" "G3_ROLLOUT_PREFLIGHT_G5_NOT_OWNER_ONLY: private.account_lifecycle_brand_owner(text)" preflight
sval -c "alter function private.account_lifecycle_brand_owner(text) owner to $owner" >/dev/null
u8="$(sval -c "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.social_accounts'::regclass and conname = 'social_accounts_meta_publish_disabled'")"
[ -n "$u8" ] || fail "RP5: U8 CHECK not in G4's world"
sval -c "alter table public.social_accounts drop constraint social_accounts_meta_publish_disabled" >/dev/null
expect_ro "RP5 U8 CHECK dropped" G3_ROLLOUT_PREFLIGHT_U8_CHECK_MISSING preflight
sval -c "alter table public.social_accounts add constraint social_accounts_meta_publish_disabled $u8" >/dev/null
own -c "alter default privileges grant execute on functions to authenticated" >/dev/null
expect_ro "RP6 default privilege for authenticated" "G3_ROLLOUT_PREFLIGHT_DEFAULT_PRIVILEGES: f:\\*" preflight
own -c "alter default privileges revoke execute on functions from authenticated" >/dev/null
own -c "create schema postona_x_resv" >/dev/null
expect_ro "RP7 a partial G3 schema" "G3_ROLLOUT_PREFLIGHT_NOT_FRESH: partial" preflight
own -c "drop schema postona_x_resv" >/dev/null
createrole="$(sval -c "select rolcreaterole from pg_roles where rolname = '$owner'")"
[ "$createrole" = t ] || fail "RP8: the lifecycle owner has no CREATEROLE in G4's world"
sval -c "alter role $owner nocreaterole" >/dev/null
expect_ro "RP8 no CREATEROLE" G3_ROLLOUT_PREFLIGHT_CREATEROLE preflight
sval -c "alter role $owner createrole" >/dev/null
expect_ro "RP9 rollback on a fresh database" "G3_ROLLOUT_PREFLIGHT_NOT_INSTALLED: fresh" rollback
[ "$(g3fp)" = "$fresh_g3" ] || fail "RP: G3's catalog moved"
o="$(ro preflight)" || fail "RP10 preflight on the restored world: $o"
printf '%s\n' "$o" | grep -q '^G3_ROLLOUT_PREFLIGHT_PASS fresh install_steps=15$' || fail "RP10: $o"
echo "OK RP: preflight refusals (superuser, also the owner itself; G4 X verdict widened; G4 Threads verdict altered; G5 function widened / of another owner; U8 dropped; a default privilege; a partial schema; no CREATEROLE; rollback on fresh), each with the whole database unchanged; restored world passes"

# --- RI -------------------------------------------------------------------------------------------------------------------------------
pre_install="$(dbfp)"
o="$(ro install 2>&1)" || fail "RI1 install: $o"
printf '%s\n' "$o" | grep -q '^G3_ROLLOUT_INSTALLED steps=15 ' || fail "RI1: $o"
installed_g3="$(g3fp)"
[ "$installed_g3" != "$fresh_g3" ] || fail "RI1 nothing installed"
[ "$(sval -c "select count(*) from pg_constraint where conname = 'social_accounts_meta_publish_disabled'")" = 1 ] || fail "RI1 U8 touched"
[ "$(sval -c "select coalesce(string_agg(a.grantee::regrole::text, ','), '') from pg_proc p, aclexplode(p.proacl) a where p.oid in ('postona_g4_credential.x_publish_credential_verdict(uuid,text)'::regprocedure,
  'postona_g4_credential.threads_publish_credential_verdict(uuid,text)'::regprocedure) and a.grantee::regrole::text <> '$owner'")" = "" ] || fail "RI1 G4 verdict ACL widened"
expect_ro "RI2 install twice" "G3_ROLLOUT_PREFLIGHT_NOT_FRESH: installed" install
expect_ro "RI3 preflight after install" "G3_ROLLOUT_PREFLIGHT_NOT_FRESH: installed" preflight
postcheck() { own -v mode=postcheck -f "$bundle/preflight.sql" 2>&1; }
own -c "grant execute on function postona_x_resv.list_reservations(text) to authenticated" >/dev/null
o="$(postcheck)" && fail "RI4 an exposed function passed the postcheck"
printf '%s\n' "$o" | grep -q "G3_ROLLOUT_PREFLIGHT_POSTCHECK_EXPOSED: postona_x_resv.list_reservations(text)" || fail "RI4: $o"
own -c "revoke execute on function postona_x_resv.list_reservations(text) from authenticated" >/dev/null
own -c "alter role postona_resv_worker login" >/dev/null
o="$(postcheck)" && fail "RI5 a LOGIN worker role passed the postcheck"
printf '%s\n' "$o" | grep -q G3_ROLLOUT_PREFLIGHT_POSTCHECK_ROLES || fail "RI5: $o"
own -c "alter role postona_resv_worker nologin" >/dev/null
postcheck | grep -q '^G3_ROLLOUT_PREFLIGHT_OK postcheck installed$' || fail "RI6 postcheck after restore"
[ "$(g3fp)" = "$installed_g3" ] || fail "RI4-RI6 G3's catalog moved"
echo "OK RI: 15 steps installed, postcheck (nothing exposed to PUBLIC / anon / authenticated / service_role, roles NOLOGIN, G4 verdicts owner-only, U8 kept); install / preflight again refused, nothing changed; postcheck refuses an exposed function / a LOGIN role"

# --- RS -------------------------------------------------------------------------------------------------------------------------------
# TEST WORLD only: the owner may act as the API / worker / client roles to drive the smoke (the real logins are members of one role each)
sval -c "grant postona_resv_api, postona_resv_worker, authenticated, anon to $owner with set true" >/dev/null
out="$(own -f "$here/smoke.sql" 2>&1)" || { printf '%s\n' "$out" | grep -E 'FAIL|ERROR' | head -10 >&2; fail "RS smoke"; }
printf '%s\n' "$out" | grep -qx G3_ROLLOUT_SMOKE_PASS || { printf '%s\n' "$out" | grep FAIL | head -10 >&2; fail "RS: no PASS line"; }
n="$(printf '%s\n' "$out" | grep -cE '^[0-9]+\|.*\|ok$')"
sval -c "revoke authenticated, anon from $owner" >/dev/null
echo "OK RS: $n smoke checks -- reserve / read back / cancel by the person, another person sees nothing, claim pins G3's value of G4's generation, the bound check answers it, outcome recorded; Threads create refused by U8; authenticated / anon reach nothing"

# --- RB -------------------------------------------------------------------------------------------------------------------------------
own -c "select g51.xreserve(5101, 'r3', 7)" >/dev/null
expect_ro "RB1 rollback with a live (planned) row" "G3_ROLLOUT_ROLLBACK_LIVE_ROWS: X/Threads 1/0" rollback
[ "$(own -c "select g51.as_role('postona_resv_api', 5101, format('select status from postona_x_resv.cancel(%L, 1)', g51.id('r3')))")" = cancelled ] || fail "RB1 cancel"
xrows="$(sval -c "select (select count(*) from postona_x_resv.reservations)::text || ':' || (select count(*) from postona_x_resv.batches)::text || ':' || (select count(*) from postona_x_resv.audit)::text")"
consumers="$(sval -c "select coalesce(string_agg(p.oid::regprocedure::text, ',' order by p.oid::regprocedure::text), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('postona_x_resv', 'postona_threads_resv') and n.nspname !~ '^(pg_catalog|information_schema|pg_toast|pg_temp_|pg_toast_temp_)' and p.prosrc ~* 'postona_x_resv'")"
[ -n "$consumers" ] || fail "RB: the smoke helpers should be consumers"
expect_ro "RB2 finished X rows not stated" "G3_ROLLOUT_ROLLBACK_X_ROWS_NOT_STATED: G3RO_X_DISCARD_ROWS must be $xrows" rollback
expect_ro "RB2b finished X rows wrongly stated" G3_ROLLOUT_ROLLBACK_X_ROWS_NOT_STATED rollback G3RO_X_DISCARD_ROWS=0:0:0
expect_ro "RB3 Threads rows wrongly stated" "G3_ROLLOUT_ROLLBACK_THREADS_ROWS_NOT_STATED: G3RO_THREADS_DISCARD_ROWS must be 0:0" rollback G3RO_X_DISCARD_ROWS="$xrows" G3RO_THREADS_DISCARD_ROWS=1:0
expect_ro "RB4 consumers not stated" "G3_ROLLOUT_ROLLBACK_CONSUMERS_NOT_STATED" rollback G3RO_X_DISCARD_ROWS="$xrows"
expect_ro "RB4b a member that can SET the API / worker roles" "G3_ROLLOUT_ROLLBACK_ROLE_MEMBERS: postona_resv_api>$owner,postona_resv_worker>$owner" rollback G3RO_X_DISCARD_ROWS="$xrows" G3RO_ACK_CONSUMERS="$consumers"
# the TEST WORLD's options go (the owner keeps the implicit ADMIN-only membership the rollbacks expect)
sval -c "revoke set option for postona_resv_api, postona_resv_worker from $owner" -c "revoke inherit option for postona_resv_api, postona_resv_worker from $owner" >/dev/null
o="$(ro rollback G3RO_X_DISCARD_ROWS="$xrows" G3RO_ACK_CONSUMERS="$consumers" 2>&1)" || fail "RB5 rollback: $o"
printf '%s\n' "$o" | grep -q '^G3_ROLLOUT_ROLLED_BACK steps=15$' || fail "RB5: $o"
[ "$(g3fp)" = "$fresh_g3" ] || fail "RB5 G3's catalog is not the fresh one"
expect_ro "RB6 rollback twice" "G3_ROLLOUT_PREFLIGHT_NOT_INSTALLED: fresh" rollback
echo "OK RB: rollback refused with a live row, unstated / wrong finished-row counts, unstated consumers, a member that can SET the roles (nothing changed); full rollback = G3's fresh catalog; twice refused"

# --- RF -------------------------------------------------------------------------------------------------------------------------------
printf '%s\n' "begin;" "create function postona_x_resv.g3ro_broken() returns integer language sql as 'select 1';" "select 1 / 0;" "commit;" > "$work/broken.sql"
bsha="$(shasum -a 256 "$work/broken.sql" | cut -d ' ' -f 1)"
awk -F '\t' -v f="$work/broken.sql" -v s="$bsha" 'BEGIN { OFS = "\t" } $1 == "install" && $2 == "x015" { $3 = f; $4 = s } { print }' "$here/MANIFEST.tsv" > "$work/m_fail15.tsv"
grep -q "$bsha" "$work/m_fail15.tsv" || fail "RF1 probe not built"
o="$(ro install G3RO_MANIFEST="$work/m_fail15.tsv" G3RO_ACK_CONSUMERS="$consumers" 2>&1)" && fail "RF1 a failing step was accepted"
printf '%s\n' "$o" | grep -q '^G3_ROLLOUT_INSTALL_FAILED_AT: x015' || fail "RF1: $o"
printf '%s\n' "$o" | grep -q '^G3_ROLLOUT_INSTALL_ROLLED_BACK' || fail "RF1 not rolled back: $o"
[ "$(g3fp)" = "$fresh_g3" ] || fail "RF1 G3's catalog is not the fresh one"
awk -F '\t' -v f="$work/broken.sql" -v s="$bsha" 'BEGIN { OFS = "\t" } $1 == "install" && $2 == "x001" { $3 = f; $4 = s } { print }' "$here/MANIFEST.tsv" > "$work/m_fail01.tsv"
o="$(ro install G3RO_MANIFEST="$work/m_fail01.tsv" 2>&1)" && fail "RF2 a failing first step was accepted"
printf '%s\n' "$o" | grep -q '^G3_ROLLOUT_INSTALL_ROLLED_BACK' || fail "RF2: $o"
[ "$(g3fp)" = "$fresh_g3" ] || fail "RF2 G3's catalog is not the fresh one"
echo "OK RF: 015 failing mid-install -> the 14 applied steps rolled back (G3's fresh catalog); a failing first step leaves nothing"

# --- RA -------------------------------------------------------------------------------------------------------------------------------
o="$(ro install 2>&1)" || fail "RA re-install: $o"
[ "$(g3fp)" = "$installed_g3" ] || fail "RA the re-installed catalog is not the first install"
echo "OK RA: re-install = the first install"
echo G3_ROLLOUT_TEST_PASS
