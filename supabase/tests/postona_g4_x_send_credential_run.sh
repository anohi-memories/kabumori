#!/usr/bin/env bash
# G4-02 #19 (Issue #561): G4's X send credential read (supabase/candidates/postona_g4_credential_verdict/003_x_send_credential_read.sql)
# and the G4 credential source over it (x_send_credential_source.ts), on a disposable LOCAL PostgreSQL 17. Never production / managed /
# real Vault / OAuth / X. The tokens are this test's fake values.
# The world is the G4-43 runner's (postona_g4_threads_person_session_run.sh) lines before its G4T_VERDICT block, read here
# verbatim (md5-pinned, never changed) with G4T_VERDICT=1: the FULL G5 profile and the PERSONAL MVP profile, G4's real X OAuth SQL,
# the reviewed X verdict 002. Then:
#   1. install refusals (no 002 / 002 body drift), install, twice, ACL (service_role only), body md5
#   2. behavior on the full and the personal profile (postona_g4_x_send_credential_behavior.sql)
#   3. two-session races: the read holds the account row against a disconnect; a reconnect in flight makes the read wait and the read
#      then answers only the new generation with the new token
#   4. G3's contract (PR #699, read only): G3's adapter xGenerationSourceFromG4Raw over this source, G3's generationSourceViolations
#      against the real database (two connected, five not connected)
#   5. mutants of 003   6. rollback (+ drift refusal) and install again
# Roles are cluster-wide: run alone.
# Usage: TB_PGHOST=/private/tmp/<socket-dir> TB_PGPORT=<port> TB_PGSUPER=<superuser> supabase/tests/postona_g4_x_send_credential_run.sh
set -euo pipefail
export LC_ALL=C
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
if [ -z "${G4XS_SPLICED:-}" ]; then
  here="$(cd "$(dirname "$0")" && pwd)"
  src="$here/postona_g4_threads_person_session_run.sh"
  spliced="$(mktemp /private/tmp/g4xs-run.XXXXXX)"
  awk '/^# G4-02 #4: the read-only publish-credential verdicts/ {exit} {print}' "$src" > "$spliced.prefix"
  [ "$(md5 -q "$spliced.prefix")" = 70bd9ee771c77dff2befefdb4b7375cc ] || { echo "FAIL the G4-43 runner's world lines moved (pin)" >&2; exit 1; }
  python3 -I - "$spliced.prefix" "$here" <<'PY'
import sys
p, here = sys.argv[1], sys.argv[2]
s = open(p).read()
old = 'here="$(cd "$(dirname "$0")" && pwd)"\n'
assert s.count(old) == 1, "here anchor"
open(p, "w").write(s.replace(old, 'here="%s"\n' % here))
PY
  { cat "$spliced.prefix"; sed -n '/^# ---- G4XS BLOCK/,$p' "$self"; } > "$spliced"
  rm -f "$spliced.prefix"
  G4XS_SPLICED=1 G4T_VERDICT=1 bash "$spliced"; rc=$?
  rm -f "$spliced"
  exit $rc
fi
exit 99  # never reached: the block below runs only inside the spliced script

# ---- G4XS BLOCK (runs after the G4-43 world lines: $c $t $tree $world $g443 $stack $g5pv mvp_world copy need apply q as_owner) ----
echo "== G4-02 #19 X send credential read (003)"
G3=8ebf3a7b079a79817644a2317139c16cb7465ca4   # G3 PR #699 HEAD (read only)
git -C "$repo" cat-file -e "${G3}^{commit}" 2>/dev/null || fail "missing git objects for $G3 (fetch G3 PR #699)"
vd="$c/postona_g4_credential_verdict"; v2="$vd/002_x_publish_credential_verdict.sql"
v3="$vd/003_x_send_credential_read.sql"; v3_rb="$vd/003_x_send_credential_read_rollback.sql"
xc="$c/postona_g4_x_oauth_personal_epoch"; px="$c/postona_g4_x_oauth_personal_mvp"
beh="$t/postona_g4_x_send_credential_behavior.sql"
full_x() {  # name [003 file]: the full profile with G4's X 001-005 and the verdict 002
  local db; db="$(copy "$1" "$world")"
  for f in "$g443" "${stack[@]}" "$xc/001_x_oauth_personal_epoch.sql" "$xc/002_x_oauth_product_wiring.sql" \
    "$xc/003_x_disconnect_user_rpc.sql" "$xc/004_x_consume_preexchange_recheck.sql" "$xc/005_x_connect_lifecycle_t13.sql" "$v2"; do need "$db" "$f"; done
  echo "$db"
}
pers_x() {
  local db; db="$(mvp_world "$1")"
  for f in "$g5pv" "${stack[@]}" "$px/001_x_oauth_g5pv.sql" "$xc/002_x_oauth_product_wiring.sql" "$xc/003_x_disconnect_user_rpc.sql" \
    "$xc/004_x_consume_preexchange_recheck.sql" "$px/005_x_connect_lifecycle_t13_g5pv.sql" "$v2"; do need "$db" "$f"; done
  echo "$db"
}
as_super_q() { "${as_super[@]}" -d "$1" -c "$2"; }

# 1. install
base="$(full_x xsbase)"
nov="$(copy xsnov "$base")"; need "$nov" "$vd/002_x_publish_credential_verdict_rollback.sql"
r="$(apply "$nov" "$v3")"; [ "$r" = G4XS_PRECONDITION_VERDICT_002 ] || fail "003 without 002: $r"
echo "ok 003 refused without the verdict 002 ($r)"
drift="$(copy xsdrift "$base")"
{ q "$drift" -c "select pg_get_functiondef('postona_g4_credential.x_publish_credential_verdict(uuid,text)'::regprocedure)"; echo ';'; } \
  | sed "s/'REAUTH_REQUIRED'::text;/'REAUTH_REQUIRED'::text; -- drift/" > "$tree/xs_drift.sql"
[ "$(grep -c -- '-- drift' "$tree/xs_drift.sql")" = 1 ] || fail "drift copy not made"
q "$drift" -f "$tree/xs_drift.sql" > /dev/null
r="$(apply "$drift" "$v3")"; [ "$r" = G4XS_PRECONDITION_VERDICT_BODY ] || fail "003 over a changed verdict: $r"
echo "ok 003 refused over a changed verdict body ($r)"
need "$base" "$v3"
r="$(apply "$base" "$v3")"; [ "$r" = G4XS_ALREADY_APPLIED ] || fail "003 twice: $r"
echo "ok 003 installed on the full profile; twice refused ($r)"
acl="$(q "$base" -c "select string_agg(r || '=' || has_function_privilege(r, 'public.postona_x_send_credential_v1(text)', 'EXECUTE')::text, ' ' order by r) from unnest(array['anon','authenticated','authenticator','service_role']) r")"
[ "$acl" = "anon=false authenticated=false authenticator=false service_role=true" ] || fail "003 ACL: $acl"
echo "ok EXECUTE: $acl"
md5v3="$(q "$base" -c "select md5(prosrc) from pg_proc where oid = 'public.postona_x_send_credential_v1(text)'::regprocedure")"
echo "md5 postona_x_send_credential_v1 $md5v3"
[ "$(grep -c "'$md5v3'" "$v3_rb")" = 1 ] || fail "the rollback does not pin this body ($md5v3)"

# 2. behavior, both profiles
out="$(as_owner "$base" -A -t -v profile=full -f "$beh" 2>&1)" || { echo "$out"; fail "behavior (full)"; }
nfull="$(grep -cE '^[0-9]+\|[^|]*\|ok$' <<<"$out")"
grep -E '^[0-9]+\|' <<<"$out" | sed 's/^/  full /'
grep -q G4XS_BEHAVIOR_PASS <<<"$out" || fail "behavior marker (full)"
pv="$(pers_x xspers)"; need "$pv" "$v3"
out="$(as_owner "$pv" -A -t -v profile=personal -f "$beh" 2>&1)" || { echo "$out"; fail "behavior (personal)"; }
grep -E '^[0-9]+\|' <<<"$out" | sed 's/^/  personal /'
grep -q G4XS_BEHAVIOR_PASS <<<"$out" || fail "behavior marker (personal)"
echo "ok behavior: full $nfull cases ok, personal $(grep -cE '^[0-9]+\|[^|]*\|ok$' <<<"$out") cases ok"

# 3. two-session races (on a copy where the behavior left person 4901 connected and verified)
waiting_lock() {  # db app -> number of sessions of app waiting on a lock
  "${as_super[@]}" -d "$1" -c "select count(*) from pg_stat_activity where datname = current_database() and application_name = '$2' and wait_event_type = 'Lock'"
}
sleeping_in() { "${as_super[@]}" -d "$1" -c "select count(*) from pg_stat_activity where datname = current_database() and application_name = '$2' and wait_event = 'PgSleep'"; }
wait_for() {  # fn db app
  local i
  for i in $(seq 1 100); do [ "$("$1" "$2" "$3")" -ge 1 ] && return 0; sleep 0.1; done
  return 1
}
races() {  # db -> prints R1 / R2 lines; returns non-zero on a failed expectation
  local db="$1" a ok=0
  a="$(q "$db" -c "select g4xs.acct(4901)")"
  [ "$(q "$db" -c "select split_part(g4xs.r('$a'), '|', 1)")" = VERIFIED ] || { echo "R0 not verified"; return 1; }
  # R1: an open read (its transaction still running) holds the row: G4's disconnect waits until it ends
  PGAPPNAME=g4xs_r1_read "$psql_bin" -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$db" \
    -c "begin; set local role service_role; select code from public.postona_x_send_credential_v1('$a'); select pg_sleep(4); commit;" > "$tree/r1_read.out" 2>&1 &
  local p1=$!
  wait_for sleeping_in "$db" g4xs_r1_read || { echo "R1 read not parked"; return 1; }
  PGAPPNAME=g4xs_r1_disc "$psql_bin" -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$db" \
    -c "select g4xs.as_person(4901); select g4xs.try('select postona_g4_x_oauth.disconnect_x_connection()');" > "$tree/r1_disc.out" 2>&1 &
  local p2=$!
  if wait_for waiting_lock "$db" g4xs_r1_disc && [ "$(sleeping_in "$db" g4xs_r1_read)" = 1 ]; then echo "R1 disconnect waits for the open read: yes"
  else echo "R1 disconnect waits for the open read: NO"; ok=1; fi
  wait "$p1" "$p2" || true
  [ "$(grep -c VERIFIED "$tree/r1_read.out")" = 1 ] && [ "$(tail -1 "$tree/r1_disc.out")" = OK ] || { echo "R1 outputs: $(cat "$tree/r1_read.out" "$tree/r1_disc.out" | tr '\n' ' ')"; ok=1; }
  [ "$(q "$db" -c "select g4xs.r('$a')")" = "DISCONNECTED|-|-" ] && echo "R1 after the disconnect: DISCONNECTED, no token" || { echo "R1 after: $(q "$db" -c "select g4xs.r('$a')")"; ok=1; }
  # R2: a reconnect in flight (begin + complete in one open transaction) makes the read wait; the read answers only what committed:
  #     the new generation with the new token (never the old token, never the old generation)
  PGAPPNAME=g4xs_r2_conn "$psql_bin" -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$db" \
    -c "begin; select g4xs.begin_(4901, 'g4xs-race-r2-label'); select g4xs.complete_(4901, 'g4xs-race-r2-label', '2001'); select pg_sleep(3); commit;" > "$tree/r2_conn.out" 2>&1 &
  p1=$!
  wait_for sleeping_in "$db" g4xs_r2_conn || { echo "R2 reconnect not parked"; return 1; }
  PGAPPNAME=g4xs_r2_read "$psql_bin" -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$db" -c "select g4xs.r('$a');" > "$tree/r2_read.out" 2>&1 &
  p2=$!
  if wait_for waiting_lock "$db" g4xs_r2_read; then echo "R2 the read waits for the reconnect in flight: yes"; else echo "R2 the read waits for the reconnect in flight: NO"; ok=1; fi
  wait "$p1" "$p2" || true
  local want; want="VERIFIED|$(q "$db" -c "select g4xs.vgen(4901)")|fakeXat_g4xs-race-r2-label"
  [ "$(tail -1 "$tree/r2_read.out")" = "$want" ] && echo "R2 the waiting read answered the new generation + the new token" \
    || { echo "R2 read answered: $(tail -1 "$tree/r2_read.out" | cut -d'|' -f1-2) (want ${want%|*})"; ok=1; }
  return $ok
}
rc_db="$(copy xsrace "$base")"
races "$rc_db" || fail "races"

# 4. G3's contract (PR #699, read only) over this source and the real database
g3c="$tree/g3/supabase/functions/_shared/postona_reservations"; mkdir -p "$tree/g3"
git -C "$repo" archive "$G3" supabase/functions/_shared/postona_reservations | tar -x -C "$tree/g3"
for f in x_credential_generation.ts credential_generation_derivation.ts; do
  echo "$G3 $(shasum -a 256 "$g3c/$f" | cut -c1-16) G3 $f (read only)" >> "$tree/TB_MANIFEST.txt"
done
[ ! -e "$g3c/x_send_credential_source.ts" ] && [ ! -e "$g3c/postona_g4_x_send_credential_g3_contract_test.ts" ] || fail "G3 tree has G4's file names"
cp "$vd/x_send_credential_source.ts" "$t/postona_g4_x_send_credential_g3_contract_test.ts" "$g3c/"
ct="$(copy xscontract "$base")"   # the behavior already ran on $base: its helpers and persons 4901-4904 are there
q "$ct" -c "select g4xs.person(4921), g4xs.person(4922), g4xs.person(4923);
  select g4xs.begin_(4921, 'g4xs-k1-label'), g4xs.complete_(4921, 'g4xs-k1-label', '3001');
  select g4xs.begin_(4922, 'g4xs-k2-label'), g4xs.complete_(4922, 'g4xs-k2-label', '3002');
  select g4xs.begin_(4923, 'g4xs-k3-label'), g4xs.complete_(4923, 'g4xs-k3-label', '3003');
  select g4xs.as_person(4923); select postona_g4_x_oauth.disconnect_x_connection();" > /dev/null
accts="$(q "$ct" -c "select string_agg(g4xs.acct(p), ',' order by i) from unnest(array[4921, 4922, 4923, 4902, 4903, 4904]) with ordinality as x(p, i)")"
G4XS_PSQL="$psql_bin" G4XS_HOST="$host" G4XS_PORT="$port" G4XS_USER="$owner" G4XS_DB="$ct" G4XS_ACCOUNTS="$accts" \
  deno test --no-config --cached-only --deny-net --allow-run="$psql_bin" --allow-env=G4XS_PSQL,G4XS_HOST,G4XS_PORT,G4XS_USER,G4XS_DB,G4XS_ACCOUNTS,PGOPTIONS,LC_ALL \
  "$g3c/postona_g4_x_send_credential_g3_contract_test.ts" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tee "$tree/contract.out" | grep -E '^(G4XS_|ok \||FAILED|error)' || true
grep -q '^ok |' "$tree/contract.out" && ! grep -q 'FAILED' "$tree/contract.out" || { cat "$tree/contract.out"; fail "G3 contract"; }

# 5. mutants of 003
survived=0
mutant() {  # name old new check(full|race|install)
  local f="$tree/v3_$1.sql" db out
  python3 -I - "$v3" "$f" "$2" "$3" <<'PY'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src).read()
assert s.count(old) == 1, "mutant anchor: " + old
open(dst, "w").write(s.replace(old, new))
PY
  cmp -s "$f" "$v3" && fail "mutant $1 did not change 003"
  db="$(full_x "m_$1")"
  [[ "$(apply "$db" "$f")" == applied ]] || { echo "MUTANT_CAUGHT $1 (install refused: $(apply "$(full_x "m2_$1")" "$f"))"; return; }
  case "$4" in
    full) if out="$(as_owner "$db" -A -t -v profile=full -f "$beh" 2>&1)"; then echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
          else echo "MUTANT_CAUGHT $1 by: $(grep -E '\|FAIL ' <<<"$out" | cut -d'|' -f2 | paste -sd ';' -)"; fi ;;
    race) as_owner "$db" -A -t -v profile=full -f "$beh" > /dev/null 2>&1 || { echo "MUTANT_CAUGHT $1 by the behavior"; return; }
          if out="$(races "$db")"; then echo "MUTANT_SURVIVED $1"; survived=$((survived + 1))
          else echo "MUTANT_CAUGHT $1 by: $(grep -E 'NO|answered|outputs' <<<"$out" | paste -sd ';' -)"; fi ;;
    *) echo "MUTANT_SURVIVED $1 (installed)"; survived=$((survived + 1)) ;;
  esac
}
mutant verdict_ignored "  if v_verified is not true or v_code is distinct from 'VERIFIED' or v_generation is null" "  if v_generation is null" full
mutant token_shape_ignored "v_token !~ '^[!-~]+\$' or pg_catalog.length(v_token) not between 16 and 4096 then" "pg_catalog.length(v_token) not between 1 and 4096 then" full
# (not a mutant: deriving the owner another way is EQUIVALENT -- 002 refuses any person who is not the workspace's single owner with
#  'u_' || md5(person) as its id, so a wrong owner can never be VERIFIED; measured in G4-02 #19, the derived-owner mutant survived for
#  exactly that reason)
mutant no_row_lock "sa.platform = 'x' for share;" "sa.platform = 'x';" race
mutant authenticated_granted "grant execute on function public.postona_x_send_credential_v1(text) to service_role;" "grant execute on function public.postona_x_send_credential_v1(text) to service_role, authenticated;" install
[ "$survived" -eq 0 ] || fail "$survived mutant(s) survived"

# 6. rollback
rb="$(copy xsrb "$base")"
need "$rb" "$v3_rb"
[ -z "$(q "$rb" -c "select to_regprocedure('public.postona_x_send_credential_v1(text)')")" ] || fail "rollback left the function"
[ -n "$(q "$rb" -c "select to_regprocedure('postona_g4_credential.x_publish_credential_verdict(uuid,text)')")" ] || fail "rollback removed 002"
r="$(apply "$rb" "$v3_rb")"; [ "$r" = G4XS_ROLLBACK_NOT_APPLIED ] || fail "rollback twice: $r"
need "$rb" "$v3"
echo "ok 003 rollback (002 kept), twice refused ($r), install again"
rd="$(copy xsrbd "$base")"
{ q "$rd" -c "select pg_get_functiondef('public.postona_x_send_credential_v1(text)'::regprocedure)"; echo ';'; } | sed "s/'INPUT_INVALID'::text, null::text, null::text;/'INPUT_INVALID'::text, null::text, null::text; -- drift/" > "$tree/xs_rbdrift.sql"
q "$rd" -f "$tree/xs_rbdrift.sql" > /dev/null
r="$(apply "$rd" "$v3_rb")"; [ "$r" = G4XS_ROLLBACK_BODY_DRIFT ] || fail "rollback over a changed body: $r"
[ -n "$(q "$rd" -c "select to_regprocedure('public.postona_x_send_credential_v1(text)')")" ] || fail "a refused rollback changed something"
echo "ok rollback refused over a changed body ($r), nothing removed"
echo "G4XS_ALL_PASS"
exit 0
