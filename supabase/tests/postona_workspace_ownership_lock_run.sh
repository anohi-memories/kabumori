#!/usr/bin/env bash
# G5-02 task 8: the workspace-ownership lock contract (supabase/candidates/postona_workspace_ownership_lock) against G3 PR #644's notification
# write, on a THROW-AWAY LOCAL PostgreSQL 17. Everything else is read only:
#   world   G4's personal world at c6df19cc, built by G4's own runner (a temporary detached worktree; the same world-only patch G3's
#           rollout_test_run.sh applies), plus G4 PR #617's 006 / 007, as G3 PR #644 does
#   G3      PR #644 737074b2's own rollout bundle (rollout.sh + MANIFEST.tsv), from a temporary detached worktree: 17 install steps up to 018
#   test    postona_workspace_ownership_lock_test.ts: the races BEFORE this candidate (each FAIL reproduced), then the install, then AFTER
# No network, no credential, no managed project; no OAuth, token, Vault, SNS, push or paid call. Roles are cluster-wide: run alone. Usage:
#   CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/postona_workspace_ownership_lock_run.sh
# The cluster must listen on 127.0.0.1 too (G4's runner).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
g4head=c6df19cc612ad586126e80b009589ef3456b215f
g4runner=supabase/tests/postona_g4_threads_person_session_run.sh
g4pr617=1d020c406cc982eedfa29a8b682c96db31888a68
g3head=737074b2ba89bf893c9360504af3b7acf931cb34
fail() { echo "FAIL $*" >&2; exit 1; }
for c in "$g4head" "$g4pr617" "$g3head"; do git -C "$repo" cat-file -e "${c}^{commit}" 2>/dev/null || { echo "RUN_NOT_AVAILABLE: $c missing; git fetch origin $c" >&2; exit 3; }; done
[ "$(git -C "$repo" rev-parse "${g4head}:${g4runner}")" = 3030b21cc45e42d86288b422ba2cabb3c3d13868 ] || fail "G4 runner is not the pinned blob"
[ "$(git -C "$repo" rev-parse "${g3head}:supabase/candidates/postona_x_reservations/018_postona_x_resv_approvals.sql")" = b60e33fa012e781c2ea2ea70bb5600848befc551 ] || fail "G3 018 is not the pinned blob"
g4w="$(mktemp -d /private/tmp/kabumori-g5wo4.XXXXXX)"; g3w="$(mktemp -d /private/tmp/kabumori-g5wo3.XXXXXX)"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
db=""; owner=""; suffix=""
cleanup() {
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
  git -C "$repo" worktree remove --force "$g3w" >/dev/null 2>&1 || rm -rf "$g3w"
}
trap cleanup EXIT
"${S[@]}" -d postgres -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true

# --- G4's world (G4's own runner, read-only; the world-only patch G3 PR #644's rollout_test_run.sh applies) ------------------------------
rmdir "$g4w" "$g3w"
git -C "$repo" worktree add -q --detach "$g4w" "$g4head"
git -C "$repo" worktree add -q --detach "$g3w" "$g3head"
python3 -I - "$g4w/$g4runner" "$g4w/supabase/tests/g5_world_only.sh" <<'PY'
import sys
s = open(sys.argv[1]).read()
keep = 'trap cleanup EXIT\n'
stop = '  echo "ok personal X 001-005 + the X verdict installed on the personal profile"\n'
assert s.count(keep) == 1 and s.count(stop) == 1, "G4 runner changed: patch points not found"
s = s.replace(keep, 'trap \'rm -rf "$tree"\' EXIT\n').replace(stop, stop + '  echo "G4_WORLD_DB=$pv OWNER=$owner"; exit 0\n')
open(sys.argv[2], 'w').write(s)
PY
out="$(cd "$g4w" && G4T_VERDICT=1 TB_PGHOST="$host" TB_PGPORT="$port" TB_PGSUPER="$super" bash supabase/tests/g5_world_only.sh 2>&1)" || { printf '%s\n' "$out" | tail -5 >&2; fail "G4 world"; }
db="$(sed -n 's/^G4_WORLD_DB=\([^ ]*\) OWNER=.*/\1/p' <<<"$out")"; owner="$(sed -n 's/^G4_WORLD_DB=.* OWNER=\(.*\)$/\1/p' <<<"$out")"
suffix="${owner##*_}"
[ -n "$db" ] && [ -n "$owner" ] || fail "G4 world: no database ($out)"
own() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
for f in 006_x_connect_profile_fence 007_x_refresh_precheck; do
  git -C "$repo" show "${g4pr617}:supabase/candidates/postona_g4_x_oauth_personal_mvp/$f.sql" | own -f - >/dev/null || fail "G4 $f"
done
echo "OK world: G4's personal world at $g4head (G4's runner), owner $owner"

# --- G3 PR #644's own rollout (17 steps up to 018), read only -------------------------------------------------------------------------
att="g3ro-throwaway-$(openssl rand -hex 16)"
"${S[@]}" -d "$db" -c "alter database $db set g3ro.throwaway_attestation = '$att'" >/dev/null
(env G3RO_PGHOST="$host" G3RO_PGPORT="$port" G3RO_DB="$db" G3RO_OWNER="$owner" G3RO_DB_ATTESTATION="$att" \
  bash "$g3w/supabase/candidates/postona_reservations_rollout/rollout.sh" install >/dev/null) || fail "G3 rollout install"
[ "$(own -c "select to_regprocedure('postona_x_resv.notify(uuid,text,text,text,uuid,uuid,integer,text,timestamptz)') is not null")" = t ] || fail "G3 018 notify missing"
echo "OK G3 PR #644 ($g3head) installed: 17 steps"

# --- the races, before and after this tree's candidate ------------------------------------------------------------------------------
( cd "$repo" && env G5WO_HOST="$host" G5WO_PORT="$port" G5WO_SUPER="$super" G5WO_OWNER="$owner" G5WO_DB="$db" \
    G5WO_CANDIDATE="$repo/supabase/candidates/postona_workspace_ownership_lock" G5WO_MVP="$repo/supabase/candidates/postona_personal_mvp_auth" \
    deno test --no-config --no-check --deny-net --allow-read="$repo" --allow-env --allow-run=psql ${G5WO_FILTER:+--filter "$G5WO_FILTER"} \
    "$here/postona_workspace_ownership_lock_test.ts" )
