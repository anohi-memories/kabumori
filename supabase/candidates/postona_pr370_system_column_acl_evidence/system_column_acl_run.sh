#!/usr/bin/env bash
# G3 TASK 19/50 evidence (Issue #318): the residual P2 of PR #370 (H3 C3 TASK 8) -- system-column ACLs are not serialised by the
# candidate's claim -- reproduced on a THROW-AWAY LOCAL PostgreSQL 17 with fake data, plus a DESIGN PROTOTYPE of option A1 (docs:
# docs/postona/g3-pr370-system-column-acl-contract-20261022.md). PR #370's two SQL files are read with `git show` at a pinned head and
# copied to a temporary directory; this file changes no product file. The A1 prototype exists only inside those temporary copies: it is
# NOT a source candidate and is not to be applied anywhere.
# Catalog queries and denial / wait probes only: no privilege is used to read or write table data, no foreign key is created.
#
#   SA_PGHOST=/private/tmp/<socket> SA_PGPORT=<port> SA_PGSUPER=<local superuser> bash system_column_acl_run.sh
# Optional: SA_PR370_REV (default: the head H3 reviewed, 547d9f920b124c9af286408eca696b10c67efe79).
# Roles are cluster-wide (anon / authenticated / service_role / authenticator are created when missing): run alone.
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${SA_PGHOST:?SA_PGHOST required}"; port="${SA_PGPORT:?SA_PGPORT required}"; super="${SA_PGSUPER:?SA_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: SA_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
rev="${SA_PR370_REV:-547d9f920b124c9af286408eca696b10c67efe79}"
n="$$"; owner="kb_sa_owner_$n"; prefix="kabumori_sa_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-sa.XXXXXX)"
cleanup() {
  local d
  rm -rf "$tmp"
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }
expect() { [ "$2" = "$3" ] || fail "$1: expected [$3] got [$2]"; }

dir=supabase/candidates/postona_brand_memberships_privileges
git -C "$repo" show "$rev:$dir/001_brand_memberships_api_privilege_revoke.sql" >"$tmp/fwd.sql"
git -C "$repo" show "$rev:$dir/001_brand_memberships_api_privilege_revoke_rollback.sql" >"$tmp/rb.sql"
echo "PR #370 files read at $rev"

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb;
create database ${prefix}_tpl owner $owner;
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
val() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
# the same model baseline as PR #370's runner (repository files only)
own "${prefix}_tpl" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own "${prefix}_tpl" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
own "${prefix}_tpl" -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
own "${prefix}_tpl" -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
own "${prefix}_tpl" -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
newdb() { local d="${prefix}_$1"; "${S[@]}" -d postgres -c "create database $d owner $owner template ${prefix}_tpl" >/dev/null; echo "$d"; }

acl() { val "$1" -c "select coalesce(array_to_string(relacl, ','), 'NULL') from pg_class where oid = 'public.brand_memberships'::regclass"; }
colacl() { val "$1" -c "select coalesce(string_agg(attname || '=' || array_to_string(attacl, ','), ' ' order by attnum), '-') from pg_attribute
  where attrelid = 'public.brand_memberships'::regclass and attacl is not null"; }
prestate_of() { sed -n 's/^BM_PRIV_PRESTATE //p' "$1" | tail -1; }
apply() { local d="$1" f="$2" out="$tmp/apply_$RANDOM"
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$f" >"$out" 2>&1 || { cat "$out" >&2; return 1; }
  prestate_of "$out"; }
rollback() { local d="$1" f="$2" a="$3"; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -v bm_prestate="$a" -f "$f"; }
# test-only copies: "select pg_sleep(N);" after / before the first line that starts with a marker
pause_after() { awk -v m="$2" -v n="$3" '{ print } !done && index($0, m) == 1 { print "select pg_sleep(" n ");"; done = 1 }' "$1"; }
pause_before() { awk -v m="$2" -v n="$3" '!done && index($0, m) == 1 { print "select pg_sleep(" n ");"; done = 1 } { print }' "$1"; }
sleeping_in() { local d="$1" i; for i in $(seq 1 100); do
  [ "$("${S[@]}" -d "$d" -c "select count(*) from pg_stat_activity where datname = '$d' and query like '%pg_sleep(%' and state = 'active' and pid <> pg_backend_pid()")" -ge 1 ] && return 0; sleep 0.1; done; return 1; }
# start file $2 in the background (paused), wait until it sleeps, run one statement $3 in another owner session with lock_timeout 1s
# (rc in $race_rc, output in $tmp/race), then wait for the background file (rc in $bg_rc, output in $tmp/bg)
race() { local d="$1" f="$2" stmt="$3" a="${4:-}"
  if [ -n "$a" ]; then psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -v bm_prestate="$a" -f "$f" >"$tmp/bg" 2>&1 & else
    psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$f" >"$tmp/bg" 2>&1 & fi
  local bg=$!
  sleeping_in "$d" || fail "race: the paused file never paused"
  race_rc=0; own "$d" -c "set lock_timeout = '1s'" -c "$stmt" >"$tmp/race" 2>&1 || race_rc=$?
  bg_rc=0; wait "$bg" || bg_rc=$?; }
SYS_GRANT="grant select (ctid) on table public.brand_memberships to anon"
USER_GRANT="grant select (brand_id) on table public.brand_memberships to anon"
LATE_FWD="select 'BM_PRIV_PRESTATE '"   # the forward's last statement before COMMIT (after every check)
LATE_RB="commit;"                       # the rollback's COMMIT (after its final DO)

# ---- R: the residual P2 on PR #370 (reproduced, NOT fixed) ----
# R1 forward: after the last check, a system-column GRANT commits and the forward commits too -> a column ACL survives the run
d="$(newdb r1)"; pause_before "$tmp/fwd.sql" "$LATE_FWD" 3 >"$tmp/r1.sql"
race "$d" "$tmp/r1.sql" "$SYS_GRANT"
expect "R1 the system-column GRANT committed during the forward" "$race_rc" "0"
expect "R1 the forward committed" "$bg_rc" "0"
expect "R1 a column ACL survives the forward" "$(colacl "$d")" "ctid=anon=r/$owner"
a_r1="$(prestate_of "$tmp/bg")"
# R1b availability: that run's own rollback is now refused
if rollback "$d" "$tmp/rb.sql" "$a_r1" >"$tmp/out" 2>&1; then fail "R1b the rollback ran over the late column ACL"; fi
grep -q BM_PRIV_ROLLBACK_COLUMN_ACL_UNSUPPORTED "$tmp/out" || fail "R1b wrong refusal: $(grep ERROR "$tmp/out" | head -1)"
pass "R1 forward: a system-column GRANT after the last check commits with the forward (ACL left: ctid=anon); the run's own rollback is then refused"
# R2 contrast: the same race on a USER column waits and fails (the claim covers it)
d="$(newdb r2)"; pause_before "$tmp/fwd.sql" "$LATE_FWD" 3 >"$tmp/r2.sql"
race "$d" "$tmp/r2.sql" "$USER_GRANT"
[ "$race_rc" != 0 ] && grep -q "lock timeout" "$tmp/race" || fail "R2 the user-column GRANT was not blocked: $(cat "$tmp/race")"
expect "R2 the forward committed" "$bg_rc" "0"
expect "R2 no column ACL" "$(colacl "$d")" "-"
pass "R2 contrast: the same GRANT on a user column times out (55P03) and no column ACL is left"
# R3 rollback: after its final DO, a system-column GRANT commits and the rollback commits too (H3 C3 TASK 8's additional trace)
d="$(newdb r3)"; pre="$(acl "$d")"; a="$(apply "$d" "$tmp/fwd.sql")"; pause_before "$tmp/rb.sql" "$LATE_RB" 3 >"$tmp/r3.sql"
race "$d" "$tmp/r3.sql" "$SYS_GRANT" "$a"
expect "R3 the system-column GRANT committed during the rollback" "$race_rc" "0"
expect "R3 the rollback committed" "$bg_rc" "0"
expect "R3 table ACL = the prestate" "$(acl "$d")" "$pre"
expect "R3 a column ACL survives the rollback" "$(colacl "$d")" "ctid=anon=r/$owner"
pass "R3 rollback: a system-column GRANT after its final check commits with it -- 'no column ACL at COMMIT' does not hold for the rollback either"
# R4 contrast on the rollback: a user-column GRANT at the same point waits and fails
d="$(newdb r4)"; a="$(apply "$d" "$tmp/fwd.sql")"; pause_before "$tmp/rb.sql" "$LATE_RB" 3 >"$tmp/r4.sql"
race "$d" "$tmp/r4.sql" "$USER_GRANT" "$a"
[ "$race_rc" != 0 ] && grep -q "lock timeout" "$tmp/race" || fail "R4 the user-column GRANT was not blocked: $(cat "$tmp/race")"
expect "R4 the rollback committed" "$bg_rc" "0"; expect "R4 no column ACL" "$(colacl "$d")" "-"
pass "R4 contrast: on the rollback the user-column GRANT times out and no column ACL is left"
# R5 non-restorable narrowing: an owner-granted REFERENCES (xmin) committed between the prestate and the REVOKE is removed by the
# table-level REVOKE (it reaches every column, system columns included) and is not in the prestate, so the rollback cannot give it back
d="$(newdb r5)"; pre="$(acl "$d")"; pause_after "$tmp/fwd.sql" "-- (prestate taken" 3 >"$tmp/r5.sql"
race "$d" "$tmp/r5.sql" "grant references (xmin) on table public.brand_memberships to authenticated"
expect "R5 the GRANT committed inside the forward" "$race_rc" "0"; expect "R5 the forward committed" "$bg_rc" "0"
expect "R5 removed by the forward's REVOKE" "$(colacl "$d")" "-"
rollback "$d" "$tmp/rb.sql" "$(prestate_of "$tmp/bg")" >/dev/null
expect "R5 after the rollback: prestate, without that GRANT" "$(acl "$d")|$(colacl "$d")" "$pre|-"
pass "R5 a system-column REFERENCES granted inside the forward is removed by its REVOKE and not restored (narrowing only, outside 'restore exactly what the run removed')"

# ---- A1: DESIGN PROTOTYPE (test-only copies; not a candidate) -- claim the SYSTEM columns' rows too ----
# The owner grants ITSELF a column privilege on every system column and revokes it in the same transaction: each system column's
# pg_attribute row is rewritten twice by this transaction (row locked until COMMIT) and its ACL comes back to what it was, except an
# owner->owner entry that already existed on a system column (removed: the residual corner of A1, measured in A4).
SYSCOLS="tableoid, cmax, xmax, cmin, xmin, ctid"
DANCE_SQL="do \$\$ begin
  execute pg_catalog.format('grant select ($SYSCOLS) on table public.brand_memberships to %I', current_user);
  execute pg_catalog.format('revoke select ($SYSCOLS) on table public.brand_memberships from %I', current_user);
end \$\$;"
printf '%s\n' "$DANCE_SQL" >"$tmp/dance.sql"
proto() { awk -v f="$tmp/dance.sql" '{ print } !done && index($0, "-- (claimed") == 1 { while ((getline l < f) > 0) print l; close(f); done = 1 }' "$1"; }
proto "$tmp/fwd.sql" >"$tmp/fwd_a1.sql"; proto "$tmp/rb.sql" >"$tmp/rb_a1.sql"
grep -q "revoke select ($SYSCOLS)" "$tmp/fwd_a1.sql" && grep -q "revoke select ($SYSCOLS)" "$tmp/rb_a1.sql" || fail "A1 prototype insertion point not found"
# A1 the race of R1 on the prototype forward: the system-column GRANT times out, the forward commits, no column ACL
d="$(newdb a1)"; pause_before "$tmp/fwd_a1.sql" "$LATE_FWD" 3 >"$tmp/a1.sql"
race "$d" "$tmp/a1.sql" "$SYS_GRANT"
[ "$race_rc" != 0 ] && grep -q "lock timeout" "$tmp/race" || fail "A1 the system-column GRANT was not blocked: $(cat "$tmp/race")"
expect "A1 the forward committed" "$bg_rc" "0"; expect "A1 no column ACL" "$(colacl "$d")" "-"
pass "A1 prototype forward: the late system-column GRANT times out (55P03); no column ACL at COMMIT"
# A2 the race of R3 on the prototype rollback
d="$(newdb a2)"; pre="$(acl "$d")"; a="$(apply "$d" "$tmp/fwd_a1.sql")"; pause_before "$tmp/rb_a1.sql" "$LATE_RB" 3 >"$tmp/a2.sql"
race "$d" "$tmp/a2.sql" "$SYS_GRANT" "$a"
[ "$race_rc" != 0 ] && grep -q "lock timeout" "$tmp/race" || fail "A2 the system-column GRANT was not blocked: $(cat "$tmp/race")"
expect "A2 the rollback committed" "$bg_rc" "0"; expect "A2 table ACL = the prestate" "$(acl "$d")" "$pre"; expect "A2 no column ACL" "$(colacl "$d")" "-"
pass "A2 prototype rollback: the late system-column GRANT times out; result = the prestate, no column ACL"
# A3 a waiting system-column GRANT fails after the prototype's COMMIT ("tuple concurrently updated"), and the prototype changes no ACL
d="$(newdb a3)"; pre="$(acl "$d")"; pause_before "$tmp/fwd_a1.sql" "$LATE_FWD" 3 >"$tmp/a3.sql"
psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$tmp/a3.sql" >"$tmp/bg" 2>&1 & bg=$!
sleeping_in "$d" || fail "A3 never paused"
own "$d" -c "grant references (xmin) on table public.brand_memberships to authenticated" >"$tmp/a3w" 2>&1 & w=$!
wait "$bg" || fail "A3 forward: $(cat "$tmp/bg")"
if wait "$w"; then fail "A3 the waiting system-column GRANT committed"; fi
grep -q "tuple concurrently updated" "$tmp/a3w" || fail "A3 the waiting GRANT: $(cat "$tmp/a3w")"
expect "A3 no column ACL" "$(colacl "$d")" "-"
rollback "$d" "$tmp/rb_a1.sql" "$(prestate_of "$tmp/bg")" >/dev/null; expect "A3 rollback = prestate" "$(acl "$d")|$(colacl "$d")" "$pre|-"
pass "A3 prototype: a waiting system-column GRANT fails with 'tuple concurrently updated' after COMMIT; forward + rollback = prestate"
# A4 the claim alone: every system column's row carries this transaction's xid, no ACL changes, no table lock is taken by it;
# another grantee's entry is kept; an existing owner->owner entry on a system column is REMOVED (A1's residual corner)
d="$(newdb a4)"
expect "A4 dance alone" "$(val "$d" -c "begin" -c "$DANCE_SQL" -c "select bool_and(xmin = pg_current_xact_id()::xid)::text || '/' || count(*) || '/' || count(attacl) || '/' ||
    coalesce((select string_agg(mode, ',') from pg_locks where relation = 'public.brand_memberships'::regclass and pid = pg_backend_pid()), 'none')
    from pg_attribute where attrelid = 'public.brand_memberships'::regclass and attnum < 0" -c "rollback" | /usr/bin/grep -v '^$' | tail -1)" "true/6/0/none"
own "$d" -c "grant select (ctid) on table public.brand_memberships to anon" >/dev/null; own "$d" -c "$DANCE_SQL" >/dev/null
expect "A4 another grantee's entry kept" "$(colacl "$d")" "ctid=anon=r/$owner"
own "$d" -c "revoke select (ctid) on table public.brand_memberships from anon" -c "grant select (ctid) on table public.brand_memberships to $owner" >/dev/null
expect "A4 an owner->owner entry before" "$(colacl "$d")" "ctid=$owner=r/$owner"
own "$d" -c "$DANCE_SQL" >/dev/null
expect "A4 the corner: the owner->owner entry is removed by the dance" "$(colacl "$d")" "-"
pass "A4 prototype claim alone: 6 system-column rows rewritten in-transaction, no ACL change, no table lock; other grantees kept; an existing owner->owner system-column entry is removed (corner)"

echo "SYSTEM_COLUMN_ACL_EVIDENCE_ALL_PASS"
