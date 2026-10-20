#!/usr/bin/env bash
# G3 brand_memberships API privilege candidate (001_brand_memberships_api_privilege_revoke.sql): proven on a THROW-AWAY LOCAL PostgreSQL 17 with
# fake data. PRIVILEGE QUERIES AND SAFE NORMAL PATHS ONLY: the suite reads the catalog (has_table_privilege, pg_has_role, aclexplode) before and
# after the candidate and exercises the legitimate SELECT / service_role writes. It demonstrates no misuse of any privilege, grants no extra
# privilege and adds no role membership. Nothing is applied anywhere else; no network; no credential; no managed project.
#
#   BM_PGHOST=/private/tmp/<socket> BM_PGPORT=<port> BM_PGSUPER=<local superuser> bash brand_memberships_privileges_run.sh
# Optional:
#   BM_G5_TREE    a read-only copy of G5's PR #358 tree (git archive 4f4ece89af51a345c0e71cb3876278789a4f3896): adds the apply-order section
#                 (G3 candidate -> G5 PR #303 install -> G5 PR #358 install, and the rollback order) with G5's REAL candidate files, unedited.
#   BM_CANDIDATE / BM_ROLLBACK  another copy of the two files (the mutation script points them at mutants).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${BM_PGHOST:?BM_PGHOST required}"; port="${BM_PGPORT:?BM_PGPORT required}"; super="${BM_PGSUPER:?BM_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: BM_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
cand="${BM_CANDIDATE:-$here/001_brand_memberships_api_privilege_revoke.sql}"
rb="${BM_ROLLBACK:-$here/001_brand_memberships_api_privilege_revoke_rollback.sql}"
g5="${BM_G5_TREE:-}"
n="$$"; owner="kb_bm_owner_$n"; other="kb_bm_other_$n"; grantor="kb_bm_grantor_$n"; prefix="kabumori_bm_$n"
db="${prefix}_main"; fresh="${prefix}_fresh"; plain="${prefix}_plain"; order="${prefix}_order"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-bm.XXXXXX)"
cleanup() {
  local d
  rm -rf "$tmp"
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" -c "drop role if exists $other" -c "drop role if exists $grantor" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

# The API roles as in the G5 runners (created only when missing; no membership is added between them).
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create role $other login nosuperuser;
create database $db owner $owner;
create database $fresh owner $owner;
create database $plain owner $owner;
create database ${prefix}_tpl owner $owner;
create role $grantor nologin;
grant $grantor to $owner;
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
val() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }

# The model baseline (as the G5 runners build it from repository files): the fake-only fixture (default table privileges to anon / authenticated /
# service_role, as a model of the platform default [A]), the X onboarding RPC, the deletion candidate, then the REAL membership migration.
baseline() {
  local d="$1" with_membership_migration="$2"
  own "$d" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
  own "$d" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
  own "$d" -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
  own "$d" -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
  if [ "$with_membership_migration" = yes ]; then own "$d" -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null; fi
}
baseline "$db" yes
baseline "$fresh" yes
baseline "$plain" no
baseline "${prefix}_tpl" yes

# The prestate artifact (TASK 16/50): 001 prints "BM_PRIV_PRESTATE <line>"; the rollback takes that line as -v bm_prestate.
apply_cand() { local d="$1" out="$tmp/apply_$RANDOM"
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$cand" >"$out" 2>&1 || { cat "$out" >&2; return 1; }
  sed -n 's/^BM_PRIV_PRESTATE //p' "$out" | tail -1; }
rollback_with() { local d="$1" a="$2"; shift 2; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -v bm_prestate="$a" -f "$rb" "$@"; }
rb_fail() { local d="$1" a="$2" code="$3" label="$4"
  if rollback_with "$d" "$a" >"$tmp/out" 2>&1; then fail "$label: the rollback ran"; fi
  grep -q "$code" "$tmp/out" || fail "$label: wrong refusal: $(grep ERROR "$tmp/out" | head -1)"; }
newdb() { local d="${prefix}_$1"; "${S[@]}" -d postgres -c "create database $d owner $owner template ${prefix}_tpl" >/dev/null; echo "$d"; }

# Catalog readers (read-only).
PRIVS="array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']"
priv() { val "$1" -c "select string_agg(r || '=' || coalesce((select string_agg(p, ',' order by p) from unnest($PRIVS) p
  where has_table_privilege(r, 'public.brand_memberships', p)), '-'), ' ' order by r)
  from unnest(array['anon','authenticated','authenticator','public','service_role']) r"; }
acl() { val "$1" -c "select coalesce(array_to_string(relacl, ','), 'NULL') from pg_class where oid = 'public.brand_memberships'::regclass"; }
# every role an API role is a MEMBER of (itself included), with its own privileges
reach() { val "$1" -c "select string_agg(a.rolname || '>' || r.rolname || ':' || coalesce((select string_agg(p, ',' order by p) from unnest($PRIVS) p
  where has_table_privilege(r.oid, 'public.brand_memberships', p)), '-'), ' ' order by a.rolname, r.rolname)
  from pg_roles a join pg_roles r on pg_has_role(a.oid, r.oid, 'MEMBER') where a.rolname in ('anon','authenticated','service_role','authenticator')"; }
# a G3 copy of the decision order of G5 PR #303's private.account_lifecycle_owner_epoch_exposure() (same CASE, same codes) so the L-1 check can be
# read BEFORE G5 is installed; the order section compares it with G5's real function
exposure_equiv() { val "$1" -c "with api as (select r.oid, r.rolname from pg_roles r where r.rolname in ('anon','authenticated','service_role','authenticator')),
  reach as (select a.rolname as api, r.oid as role_oid, r.rolsuper as super from api a join pg_roles r on pg_has_role(a.oid, r.oid, 'MEMBER')),
  owner_role as (select c.relowner as oid from pg_class c where c.oid = 'public.brand_memberships'::regclass)
  select coalesce(case
    when exists (select 1 from reach x where x.super) then 'API_ROLE_CAN_BECOME_SUPERUSER'
    when exists (select 1 from reach x, owner_role o where x.role_oid = o.oid) then 'API_ROLE_CAN_BECOME_OWNER'
    when exists (select 1 from reach x where has_parameter_privilege(x.role_oid, 'session_replication_role', 'SET')) then 'API_ROLE_CAN_SKIP_TRIGGERS'
    when exists (select 1 from reach x where has_table_privilege(x.role_oid, 'public.brand_memberships', 'TRIGGER')) then 'API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS'
    when exists (select 1 from reach x where x.api in ('anon','authenticated') and (has_table_privilege(x.role_oid, 'public.brand_memberships', 'INSERT')
      or has_table_privilege(x.role_oid, 'public.brand_memberships', 'UPDATE') or has_table_privilege(x.role_oid, 'public.brand_memberships', 'DELETE')
      or has_table_privilege(x.role_oid, 'public.brand_memberships', 'TRUNCATE') or has_table_privilege(x.role_oid, 'public.brand_memberships', 'REFERENCES')))
      then 'API_ROLE_CAN_WRITE_MEMBERSHIPS'
    else null end, 'NONE')"; }
rls() { val "$1" -c "select relrowsecurity::text || '/' || relforcerowsecurity::text || '/' || (select count(*) from pg_policy where polrelid = 'public.brand_memberships'::regclass)::text
  from pg_class where oid = 'public.brand_memberships'::regclass"; }
expect() { [ "$2" = "$3" ] || fail "$1: expected [$3] got [$2]"; }
apply_fail() { local d="$1" code="$2" label="$3" as="${4:-$owner}"
  if psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$as" -d "$d" -f "$cand" >"$tmp/out" 2>&1; then fail "$label: applied"; fi
  grep -q "$code" "$tmp/out" || fail "$label: wrong refusal: $(grep ERROR "$tmp/out" | head -1)"; }

PRE_PRIV="anon=- authenticated=MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE authenticator=- public=- service_role=DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"
POST_PRIV="anon=- authenticated=MAINTAIN,SELECT authenticator=- public=- service_role=DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRUNCATE,UPDATE"

# ---- C0: the state BEFORE the candidate (catalog only) ----
expect "C0 privileges before" "$(priv "$db")" "$PRE_PRIV"
expect "C0 G5 L-1 check before (G3 copy)" "$(exposure_equiv "$db")" "API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS"
expect "C0 RLS on, not forced, policies" "$(rls "$db")" "true/false/1"
PRE_ACL="$(acl "$db")"
PRE_REACH="$(reach "$db")"
echo "C0 acl before: $PRE_ACL"
echo "C0 member reach before: $PRE_REACH"
pass "C0 before: authenticated keeps TRIGGER/TRUNCATE/REFERENCES, service_role keeps TRIGGER; the G5 L-1 check would refuse"

# ---- C1: preconditions refuse (nothing changes) ----
apply_fail "$db" BM_PRIV_PRECONDITION_NOT_TABLE_OWNER "C1 not the table owner" "$other"
expect "C1 unchanged after non-owner" "$(acl "$db")" "$PRE_ACL"
apply_fail "$plain" BM_PRIV_PRECONDITION_RLS_DISABLED "C1 membership migration not applied (RLS off)"
# RLS on but the migration's self-select policy not there yet (a stricter state: no row is readable)
own "$plain" -c "alter table public.brand_memberships enable row level security" >/dev/null
apply_fail "$plain" BM_PRIV_PRECONDITION_SELF_SELECT_POLICY_MISSING "C1 RLS on without the self-select policy"
"${S[@]}" -d postgres -c "create database ${prefix}_empty owner $owner" >/dev/null
apply_fail "${prefix}_empty" BM_PRIV_PRECONDITION_TABLE_MISSING "C1 table missing (applied before the membership migration)"
apply_fail "$db" BM_PRIV_PRECONDITION_RUN_AS_SUPERUSER "C1 superuser" "$super"
expect "C1 unchanged after refusals" "$(acl "$db")" "$PRE_ACL"
pass "C1 refusals: non-owner, RLS off, RLS on without the self-select policy, table missing, superuser; nothing changed"

# ---- K1: a writer holding the table makes the candidate time out (lock_timeout 5s); nothing changes ----
uid_a=00000000-0000-4000-8000-0000000000a1; uid_b=00000000-0000-4000-8000-0000000000b2
own "$db" >/dev/null <<SQL
insert into auth.users (id) values ('$uid_a'), ('$uid_b'), ('00000000-0000-4000-8000-0000000000c3');
insert into public.brands (id) values ('bm_brand_a'), ('bm_brand_b');
insert into public.brand_memberships (brand_id, user_id, role) values ('bm_brand_a', '$uid_a', 'owner'), ('bm_brand_b', '$uid_b', 'owner');
SQL
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "begin" -c "set local role service_role" \
  -c "update public.brand_memberships set role = 'owner' where brand_id = 'bm_brand_b'" -c "select pg_sleep(9)" -c "commit" >/dev/null 2>"$tmp/k1w" &
k1w=$!
for _ in $(seq 1 100); do
  [ "$("${S[@]}" -d "$db" -c "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.relation = 'public.brand_memberships'::regclass and l.mode = 'RowExclusiveLock' and a.state <> 'idle'")" -ge 1 ] && break
  sleep 0.1
done
start=$(date +%s)
apply_fail "$db" "lock timeout" "K1 behind a writer"
expect "K1 unchanged after lock timeout" "$(acl "$db")" "$PRE_ACL"
[ $(( $(date +%s) - start )) -le 8 ] || fail "K1 waited longer than the lock_timeout"
wait "$k1w" || fail "K1 writer failed: $(cat "$tmp/k1w")"
pass "K1 behind an open writer: lock timeout, nothing changed, the writer committed"

# ---- C2 + K2: apply while a reader holds the table (readers are not blocked) ----
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "begin" -c "set local role authenticated" \
  -c "select set_config('request.jwt.claim.sub', '$uid_a', true)" -c "select count(*) from public.brand_memberships" -c "select pg_sleep(4)" -c "commit" >"$tmp/k2r" 2>&1 &
k2r=$!
for _ in $(seq 1 100); do
  [ "$("${S[@]}" -d "$db" -c "select count(*) from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.relation = 'public.brand_memberships'::regclass and l.mode = 'AccessShareLock' and a.query like '%pg_sleep%'")" -ge 1 ] && break
  sleep 0.1
done
A_DB="$(apply_cand "$db")"
[ "$("${S[@]}" -d "$db" -c "select count(*) from pg_stat_activity where query like '%pg_sleep(4)%' and state = 'active' and pid <> pg_backend_pid()")" = 1 ] || fail "K2 the reader was not still open while the candidate committed"
wait "$k2r" || fail "K2 reader failed: $(cat "$tmp/k2r")"
pass "K2 the candidate committed while a reader's transaction was still open"

expect "C2 privileges after" "$(priv "$db")" "$POST_PRIV"
expect "C2 G5 L-1 check after (G3 copy)" "$(exposure_equiv "$db")" "NONE"
expect "C2 RLS unchanged" "$(rls "$db")" "true/false/1"
POST_ACL="$(acl "$db")"; POST_REACH="$(reach "$db")"
echo "C2 acl after: $POST_ACL"
echo "C2 member reach after: $POST_REACH"
case " $POST_REACH " in *TRIGGER*) fail "C2 an API role still reaches TRIGGER: $POST_REACH" ;; esac
expect "C2 end-user reach after" "$(val "$db" -c "select string_agg(a.rolname || '>' || r.rolname, ' ' order by 1) from pg_roles a join pg_roles r on pg_has_role(a.oid, r.oid, 'MEMBER')
  where a.rolname in ('anon','authenticated') and (has_table_privilege(r.oid, 'public.brand_memberships', 'TRUNCATE') or has_table_privilege(r.oid, 'public.brand_memberships', 'REFERENCES')
  or has_table_privilege(r.oid, 'public.brand_memberships', 'INSERT') or has_table_privilege(r.oid, 'public.brand_memberships', 'UPDATE') or has_table_privilege(r.oid, 'public.brand_memberships', 'DELETE'))")" ""
expect "C2 PUBLIC acl entries" "$(val "$db" -c "select count(*) from pg_class c, aclexplode(c.relacl) e where c.oid = 'public.brand_memberships'::regclass and e.grantee = 0")" "0"
expect "C2 grant options held by API roles" "$(val "$db" -c "select count(*) from pg_class c, aclexplode(c.relacl) e join pg_roles r on r.oid = e.grantee
  where c.oid = 'public.brand_memberships'::regclass and r.rolname in ('anon','authenticated','service_role','authenticator') and e.is_grantable")" "0"
expect "C2 end-user BYPASSRLS" "$(val "$db" -c "select count(*) from pg_roles where rolname in ('anon','authenticated') and rolbypassrls")" "0"
pass "C2 after: no TRIGGER for any API role or member path, no TRUNCATE/REFERENCES/write for anon/authenticated, PUBLIC empty, RLS unchanged"

# ---- C3: the legitimate paths still work (safe normal operations only) ----
expect "C3 authenticated reads only its own row (RLS)" "$(val "$db" -c "begin" -c "set local role authenticated" \
  -c "select set_config('request.jwt.claim.sub', '$uid_a', true)" -c "select string_agg(brand_id, ',') from public.brand_memberships" -c "commit" | /usr/bin/grep -v '^$' | tail -1)" "bm_brand_a"
expect "C3 anon reads nothing (no SELECT)" "$(val "$db" -c "select has_table_privilege('anon', 'public.brand_memberships', 'SELECT')::text")" "false"
own "$db" >/dev/null <<SQL
begin;
set local role service_role;
insert into public.brand_memberships (brand_id, user_id, role) values ('bm_brand_a', '00000000-0000-4000-8000-0000000000c3', 'member');
update public.brand_memberships set role = 'viewer' where brand_id = 'bm_brand_a' and user_id = '00000000-0000-4000-8000-0000000000c3';
delete from public.brand_memberships where brand_id = 'bm_brand_a' and user_id = '00000000-0000-4000-8000-0000000000c3';
commit;
SQL
expect "C3 service_role DML left no row" "$(val "$db" -c "select count(*) from public.brand_memberships where user_id = '00000000-0000-4000-8000-0000000000c3'")" "0"
# the owner path the definer RPCs and the deletion saga use (they run as the table owner)
own "$db" -c "insert into public.brand_memberships (brand_id, user_id, role) values ('bm_brand_b', '$uid_a', 'viewer')" -c "delete from public.brand_memberships where brand_id = 'bm_brand_b' and user_id = '$uid_a'" >/dev/null
expect "C3 owner path" "$(val "$db" -c "select count(*) from public.brand_memberships")" "2"
pass "C3 normal paths: authenticated own-row SELECT, service_role insert/update/delete, owner writes"

# ---- C4: idempotent re-apply, and two applies at the same time ----
B_DB="$(apply_cand "$db")"
[[ "$A_DB" == v1\|* && "$B_DB" == v1\|* && "$A_DB" != "$B_DB" ]] || fail "C4 the two runs did not print two different prestate lines"
expect "C4 re-apply same acl" "$(acl "$db")" "$POST_ACL"
own "$db" -f "$cand" >"$tmp/c4a" 2>&1 & c4a=$!
own "$db" -f "$cand" >"$tmp/c4b" 2>&1 & c4b=$!
wait "$c4a" || fail "C4 concurrent apply A: $(cat "$tmp/c4a")"
wait "$c4b" || fail "C4 concurrent apply B: $(cat "$tmp/c4b")"
expect "C4 concurrent applies same acl" "$(acl "$db")" "$POST_ACL"
pass "C4 re-apply and two concurrent applies: both succeed, same final ACL"

# ---- C5: rollback restores the exact previous ACL from the FIRST run's prestate; re-apply restores the candidate's ----
if own "$db" -f "$rb" >"$tmp/out" 2>&1; then fail "C5 a rollback without the prestate ran"; fi
grep -q BM_PRIV_ROLLBACK_PRESTATE_REQUIRED "$tmp/out" || fail "C5 no-prestate refusal: $(grep ERROR "$tmp/out" | head -1)"
expect "C5 no prestate: unchanged" "$(acl "$db")" "$POST_ACL"
rollback_with "$db" "$B_DB" >/dev/null
expect "C5 the re-apply's prestate (already hardened) puts nothing back" "$(acl "$db")" "$POST_ACL"
rollback_with "$db" "$A_DB" >/dev/null
expect "C5 rollback acl" "$(acl "$db")" "$PRE_ACL"
expect "C5 rollback privileges" "$(priv "$db")" "$PRE_PRIV"
expect "C5 rollback member reach" "$(reach "$db")" "$PRE_REACH"
expect "C5 G5 L-1 check after rollback (G3 copy)" "$(exposure_equiv "$db")" "API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS"
if psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$other" -d "$db" -f "$rb" >"$tmp/out" 2>&1; then fail "C5 rollback by a non-owner ran"; fi
grep -q BM_PRIV_ROLLBACK_NOT_TABLE_OWNER "$tmp/out" || fail "C5 non-owner rollback refusal: $(grep ERROR "$tmp/out" | head -1)"
own "$db" -f "$cand" >/dev/null
expect "C5 re-apply acl" "$(acl "$db")" "$POST_ACL"
expect "C5 re-apply privileges" "$(priv "$db")" "$POST_PRIV"
pass "C5 rollback needs the prestate line; the hardened re-apply's line puts nothing back; the first run's line = exact previous ACL (non-owner refused); re-apply = the candidate's ACL"

# ---- C6: a freshly built schema (migration order: fixture -> membership migration -> candidate) gives the same ACL ----
expect "C6 fresh before" "$(acl "$fresh")" "$PRE_ACL"
own "$fresh" -f "$cand" >/dev/null
expect "C6 fresh after" "$(acl "$fresh")" "$POST_ACL"
own "$plain" -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
own "$plain" -f "$cand" >/dev/null
expect "C6 late membership migration then candidate" "$(priv "$plain")" "$POST_PRIV"
pass "C6 regenerated schemas: same ACL; the candidate works once the membership migration is in"

# ---- P: every prestate the candidate accepts -- the rollback never widens (TASK 16/50, H3 C3 R1) ----
HARDEN="revoke trigger, truncate, references on table public.brand_memberships from authenticated; revoke trigger on table public.brand_memberships from service_role"
# P0 the finding, reproduced with the ORIGINAL rollback of PR #370 (05ef903c): a prehardened table, forward no-op, the old rollback widens it
git -C "$repo" show 05ef903c31c120634906fa8b62481711f4a37a4c:supabase/candidates/postona_brand_memberships_privileges/001_brand_memberships_api_privilege_revoke_rollback.sql >"$tmp/rb_05ef903c.sql"
d="$(newdb p0)"; own "$d" -c "$HARDEN" >/dev/null
expect "P0 prehardened = the candidate's after-state" "$(priv "$d")" "$POST_PRIV"
a="$(apply_cand "$d")"; expect "P0 forward is a no-op" "$(priv "$d")" "$POST_PRIV"
own "$d" -f "$tmp/rb_05ef903c.sql" >/dev/null
expect "P0 the ORIGINAL rollback widens (H3 R1 reproduced)" "$(priv "$d")" "$PRE_PRIV"
pass "P0 H3 R1 reproduced: on a prehardened table the original fixed-GRANT rollback adds authenticated TRIGGER/TRUNCATE/REFERENCES and service_role TRIGGER"
# P1 the same prestate with the new rollback: nothing to put back
d="$(newdb p1)"; own "$d" -c "$HARDEN" >/dev/null; P1PRE="$(acl "$d")"
a="$(apply_cand "$d")"; expect "P1 forward no-op" "$(acl "$d")" "$P1PRE"
rb_fail "$d" "" BM_PRIV_ROLLBACK_PRESTATE_REQUIRED "P1 empty prestate"
if own "$d" -f "$rb" >"$tmp/out" 2>&1; then fail "P1 rollback without -v ran"; fi
grep -q BM_PRIV_ROLLBACK_PRESTATE_REQUIRED "$tmp/out" || fail "P1 no -v: $(grep ERROR "$tmp/out" | head -1)"
rollback_with "$d" "$a" >/dev/null
expect "P1 the new rollback widens nothing" "$(acl "$d")" "$P1PRE"
pass "P1 prehardened: forward no-op; the new rollback refuses without the line and, with it, puts nothing back (ACL identical)"
# P2 partially hardened: only authenticated TRIGGER was gone before
d="$(newdb p2)"; own "$d" -c "revoke trigger on table public.brand_memberships from authenticated" >/dev/null; P2PRE="$(acl "$d")"; P2PRIV="$(priv "$d")"
a="$(apply_cand "$d")"; expect "P2 forward hardens the rest" "$(priv "$d")" "$POST_PRIV"
rollback_with "$d" "$a" >/dev/null
expect "P2 rollback = the partial prestate exactly" "$(acl "$d")" "$P2PRE"
expect "P2 authenticated TRIGGER stays absent" "$(priv "$d")" "$P2PRIV"
pass "P2 partially hardened: the rollback puts back only what this run removed"
# P3 re-apply: the first line restores the original; the second line is a no-op; the first line twice is refused
d="$(newdb p3)"; a1="$(apply_cand "$d")"; a2="$(apply_cand "$d")"
rollback_with "$d" "$a2" >/dev/null; expect "P3 second run's line: no-op" "$(priv "$d")" "$POST_PRIV"
rollback_with "$d" "$a1" >/dev/null; expect "P3 first run's line: original" "$(acl "$d")" "$PRE_ACL"
rb_fail "$d" "$a1" BM_PRIV_ROLLBACK_PRESTATE_MISMATCH "P3 the first line again"
expect "P3 unchanged after the refused repeat" "$(acl "$d")" "$PRE_ACL"
pass "P3 re-apply: lines are per run; the original comes back once, a repeat is refused"
# P4 another grantor: the owner's REVOKE cannot remove it -> the forward refuses (postcondition), nothing changes
d="$(newdb p4)"; own "$d" -c "grant trigger on table public.brand_memberships to $grantor with grant option" >/dev/null
own "$d" -c "begin" -c "set local role $grantor" -c "grant trigger on table public.brand_memberships to authenticated" -c "commit" >/dev/null
P4PRE="$(acl "$d")"
if psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$cand" >"$tmp/out" 2>&1; then fail "P4 forward applied over another grantor's TRIGGER"; fi
grep -q BM_PRIV_POSTCONDITION_API_ROLE_HAS_TRIGGER "$tmp/out" || fail "P4 wrong refusal: $(grep ERROR "$tmp/out" | head -1)"
expect "P4 unchanged" "$(acl "$d")" "$P4PRE"
pass "P4 another grantor's TRIGGER for authenticated: the forward refuses (postcondition), ACL unchanged"
# P5 a grant option on a removed item: the forward removes it; the rollback refuses to put it back
d="$(newdb p5)"; own "$d" -c "revoke trigger on table public.brand_memberships from authenticated" -c "grant trigger on table public.brand_memberships to authenticated with grant option" >/dev/null
a="$(apply_cand "$d")"; expect "P5 forward" "$(priv "$d")" "$POST_PRIV"
[[ "$a" == *"authenticated=r*"* || "$a" == *"t*"* ]] || fail "P5 the prestate line does not show the grant option: $a"
rb_fail "$d" "$a" BM_PRIV_ROLLBACK_GRANT_OPTION_UNSUPPORTED "P5 grant option"
expect "P5 unchanged (still hardened)" "$(priv "$d")" "$POST_PRIV"
pass "P5 a removed item carried a grant option: the rollback refuses, nothing is put back"
# P6 something changed after the forward: refused until the state is what the forward left
d="$(newdb p6)"; a="$(apply_cand "$d")"; own "$d" -c "grant select on table public.brand_memberships to anon" >/dev/null
rb_fail "$d" "$a" BM_PRIV_ROLLBACK_PRESTATE_MISMATCH "P6 changed after"
own "$d" -c "revoke select on table public.brand_memberships from anon" >/dev/null
rollback_with "$d" "$a" >/dev/null; expect "P6 after the change is undone" "$(acl "$d")" "$PRE_ACL"
pass "P6 a change after the forward: the rollback refuses (MISMATCH) until the state is what the forward left"
# P7 a line of another database, or a tampered line
d="$(newdb p7)"; b="$(apply_cand "$d")"
rb_fail "$d" "$a" BM_PRIV_ROLLBACK_PRESTATE_OTHER_OBJECT "P7 another database's line"
last="${b: -1}"; flip=0; [[ "$last" == 0 ]] && flip=1   # always a DIFFERENT last hex digit
rb_fail "$d" "${b%?}$flip" BM_PRIV_ROLLBACK_PRESTATE_CORRUPT "P7 tampered sha"
rb_fail "$d" "$(sed 's/|\([0-9a-f]\{64\}\)$/,anon=t\/'"$owner"'|\1/' <<<"$b")" BM_PRIV_ROLLBACK_PRESTATE_CORRUPT "P7 an added item without a matching sha"
rb_fail "$d" "v1|garbage" BM_PRIV_ROLLBACK_PRESTATE_CORRUPT "P7 garbage"
expect "P7 unchanged" "$(priv "$d")" "$POST_PRIV"
pass "P7 another database's line -> OTHER_OBJECT; tampered / garbage lines -> CORRUPT; nothing changes"
# P8 a prestate that gave anon TRIGGER: the forward removes it; the rollback never gives anything to anon / PUBLIC
d="$(newdb p8)"; own "$d" -c "grant trigger on table public.brand_memberships to anon" >/dev/null
a="$(apply_cand "$d")"; expect "P8 forward" "$(priv "$d")" "$POST_PRIV"
rb_fail "$d" "$a" BM_PRIV_ROLLBACK_GRANTEE_UNSUPPORTED "P8 anon"
expect "P8 unchanged" "$(priv "$d")" "$POST_PRIV"
pass "P8 anon / PUBLIC are never given anything back"
# P9 a line NOT printed by a successful run (made by hand, valid sha): another grantor's item that has since gone -> MISMATCH, nothing granted
d="$(newdb p9)"; own "$d" -c "grant trigger on table public.brand_memberships to $grantor with grant option" >/dev/null
own "$d" -c "begin" -c "set local role $grantor" -c "grant trigger on table public.brand_memberships to authenticated" -c "commit" >/dev/null
body="v1|$d|$(val "$d" -c "select 'public.brand_memberships'::regclass::oid")|$(val "$d" -c "select array_to_string(relacl, ',') from pg_class where oid = 'public.brand_memberships'::regclass")"
line="$body|$(printf '%s' "$body" | shasum -a 256 | cut -d' ' -f1)"
own "$d" -c "begin" -c "set local role $grantor" -c "revoke trigger on table public.brand_memberships from authenticated" -c "commit" >/dev/null
own "$d" -c "$HARDEN" >/dev/null; P9NOW="$(acl "$d")"
rb_fail "$d" "$line" BM_PRIV_ROLLBACK_PRESTATE_MISMATCH "P9 another grantor's item in a hand-made line"
expect "P9 unchanged" "$(acl "$d")" "$P9NOW"
pass "P9 a hand-made line with another grantor's item (since removed): refused as MISMATCH -- the rollback only counts the owner's own grants as removable"

# ---- Q: H3 C3 (TASK 6) counterexamples, TASK 17/50 -- concurrency (R1) and relation identity (R2) ----
# A test-only copy of a file with "select pg_sleep(N);" inserted after a marker line pauses it at that point (no product file is changed).
OLD=d3ff513bdf184f2c8f80950733d229936f49d83d
git -C "$repo" show "$OLD:supabase/candidates/postona_brand_memberships_privileges/001_brand_memberships_api_privilege_revoke.sql" >"$tmp/fwd_old.sql"
git -C "$repo" show "$OLD:supabase/candidates/postona_brand_memberships_privileges/001_brand_memberships_api_privilege_revoke_rollback.sql" >"$tmp/rb_old.sql"
pause_after() { awk -v m="$2" -v n="$3" '{ print } !done && index($0, m) == 1 { print "select pg_sleep(" n ");"; done = 1 }' "$1"; }
pause_before() { awk -v m="$2" -v n="$3" '!done && index($0, m) == 1 { print "select pg_sleep(" n ");"; done = 1 } { print }' "$1"; }
sleeping_in() { local d="$1" i; for i in $(seq 1 100); do
  [ "$("${S[@]}" -d "$d" -c "select count(*) from pg_stat_activity where datname = '$d' and query like '%pg_sleep(%' and state = 'active' and pid <> pg_backend_pid()")" -ge 1 ] && return 0; sleep 0.1; done; return 1; }
ae_held() { local d="$1" i; for i in $(seq 1 100); do
  [ "$("${S[@]}" -d "$d" -c "select count(*) from pg_locks l join pg_database b on b.oid = l.database where b.datname = '$d' and l.mode = 'AccessExclusiveLock' and l.granted and l.locktype = 'relation'")" -ge 1 ] && return 0; sleep 0.1; done; return 1; }
has_priv() { val "$1" -c "select has_table_privilege('$2', 'public.brand_memberships', '$3')"; }
REPLACE_TABLE="alter table public.brand_memberships rename to brand_memberships_replaced; create table public.brand_memberships (brand_id text, user_id uuid, role text);
  revoke all on table public.brand_memberships from anon; revoke insert, update, delete on table public.brand_memberships from anon, authenticated;
  revoke trigger, truncate, references on table public.brand_memberships from public, anon, authenticated; revoke trigger on table public.brand_memberships from service_role"

# Q1 R1 reproduced on the reviewed head (d3ff513b): another owner session's REVOKE commits between the prestate and the REVOKE; the rollback re-grants it
d="$(newdb q1)"; pause_before "$tmp/fwd_old.sql" "revoke trigger, truncate, references" 3 >"$tmp/q1.sql"
psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$tmp/q1.sql" >"$tmp/q1.out" 2>&1 & bg=$!
sleeping_in "$d" || fail "Q1 the paused forward never paused"
own "$d" -c "set lock_timeout = '1s'" -c "revoke truncate on table public.brand_memberships from authenticated" >"$tmp/q1o" 2>&1 || fail "Q1 the concurrent REVOKE was blocked on the old head: $(cat "$tmp/q1o")"
wait "$bg" || fail "Q1 old forward: $(cat "$tmp/q1.out")"
a="$(sed -n 's/^BM_PRIV_PRESTATE //p' "$tmp/q1.out")"
own "$d" -v bm_prestate="$a" -f "$tmp/rb_old.sql" >/dev/null
expect "Q1 the old rollback re-grants the TRUNCATE another session removed" "$(has_priv "$d" authenticated TRUNCATE)" "t"
pass "Q1 H3 R1 reproduced on d3ff513b: a concurrent REVOKE commits inside the forward; the old rollback re-grants it"

# Q2 R1 fixed: the forward claims the table's pg_class row before the prestate; a concurrent REVOKE waits and fails (lock_timeout, or
# "tuple concurrently updated" once the forward commits); the rollback then restores exactly the forward's prestate
d="$(newdb q2)"; Q2PRE="$(acl "$d")"; pause_after "$cand" "-- (prestate taken" 3 >"$tmp/q2.sql"
psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$tmp/q2.sql" >"$tmp/q2.out" 2>&1 & bg=$!
sleeping_in "$d" || fail "Q2 the paused forward never paused"
if own "$d" -c "set lock_timeout = '1s'" -c "revoke truncate on table public.brand_memberships from authenticated" >"$tmp/q2o" 2>&1; then fail "Q2 a concurrent REVOKE committed inside the forward"; fi
grep -q "lock timeout" "$tmp/q2o" || fail "Q2 the concurrent REVOKE did not wait: $(cat "$tmp/q2o")"
own "$d" -c "revoke truncate on table public.brand_memberships from authenticated" >"$tmp/q2w" 2>&1 & w=$!
wait "$bg" || fail "Q2 forward: $(cat "$tmp/q2.out")"
if wait "$w"; then fail "Q2 the waiting REVOKE committed after the forward"; fi
grep -q "tuple concurrently updated" "$tmp/q2w" || fail "Q2 the waiting REVOKE: $(cat "$tmp/q2w")"
expect "Q2 forward result" "$(priv "$d")" "$POST_PRIV"
rollback_with "$d" "$(sed -n 's/^BM_PRIV_PRESTATE //p' "$tmp/q2.out")" >/dev/null
expect "Q2 rollback = the forward's prestate exactly" "$(acl "$d")" "$Q2PRE"
pass "Q2 R1 fixed: inside the forward a concurrent REVOKE times out, a waiting one fails with 'tuple concurrently updated'; the rollback restores exactly the prestate"

# Q3 the same on the rollback side: a concurrent ACL change during the rollback cannot commit; the result is exactly the prestate
d="$(newdb q3)"; Q3PRE="$(acl "$d")"; a="$(apply_cand "$d")"; pause_after "$rb" "-- (claimed" 3 >"$tmp/q3.sql"
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -v bm_prestate="$a" -f "$tmp/q3.sql" >"$tmp/q3.out" 2>&1 & bg=$!
sleeping_in "$d" || fail "Q3 the paused rollback never paused"
if own "$d" -c "set lock_timeout = '1s'" -c "revoke select on table public.brand_memberships from authenticated" >"$tmp/q3o" 2>&1; then fail "Q3 a concurrent REVOKE committed inside the rollback"; fi
grep -q "lock timeout" "$tmp/q3o" || fail "Q3 the concurrent REVOKE did not wait: $(cat "$tmp/q3o")"
wait "$bg" || fail "Q3 rollback: $(cat "$tmp/q3.out")"
expect "Q3 rollback = the prestate exactly" "$(acl "$d")" "$Q3PRE"
pass "Q3 R1 on the rollback side: a concurrent REVOKE times out; the rollback's result is exactly the prestate"

# Q4 R2 reproduced on the reviewed head: while the old rollback waits for the table lock, the table is renamed and replaced; it grants on the new one
d="$(newdb q4)"; a="$(apply_cand "$d")"
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -c "begin" -c "lock table public.brand_memberships in access exclusive mode" -c "select pg_sleep(2)" -c "$REPLACE_TABLE" -c "commit" >"$tmp/q4h" 2>&1 & h=$!
ae_held "$d" || fail "Q4 the replacing session never held the lock"
own "$d" -v bm_prestate="$a" -f "$tmp/rb_old.sql" >"$tmp/q4.out" 2>&1 & bg=$!
wait "$h" || fail "Q4 replacement: $(cat "$tmp/q4h")"
wait "$bg" || fail "Q4 the old rollback refused (expected it to run): $(cat "$tmp/q4.out")"
expect "Q4 the old rollback granted TRIGGER on the NEW table" "$(has_priv "$d" authenticated TRIGGER)" "t"
pass "Q4 H3 R2 reproduced on d3ff513b: the old rollback checked the OID before the lock and granted the old line's privileges on the replacement table"

# Q5 R2 fixed: the same replacement -> the rollback refuses after the lock; the new table is unchanged
d="$(newdb q5)"; a="$(apply_cand "$d")"
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -c "begin" -c "lock table public.brand_memberships in access exclusive mode" -c "select pg_sleep(2)" -c "$REPLACE_TABLE" -c "commit" >"$tmp/q5h" 2>&1 & h=$!
ae_held "$d" || fail "Q5 the replacing session never held the lock"
rollback_with "$d" "$a" >"$tmp/q5.out" 2>&1 & bg=$!
wait "$h" || fail "Q5 replacement: $(cat "$tmp/q5h")"
if wait "$bg"; then fail "Q5 the rollback ran on the replacement table"; fi
grep -q BM_PRIV_ROLLBACK_TABLE_REPLACED "$tmp/q5.out" || fail "Q5 wrong refusal: $(grep ERROR "$tmp/q5.out" | head -1)"
expect "Q5 the new table unchanged" "$(has_priv "$d" authenticated TRIGGER)" "f"
pass "Q5 R2 fixed: a rename / replacement while the rollback waited for the lock -> TABLE_REPLACED, nothing granted"

# Q6 an owner change while the rollback waits -> NOT_TABLE_OWNER after the lock
d="$(newdb q6)"; a="$(apply_cand "$d")"; Q6NOW="$(priv "$d")"
"${S[@]}" -d "$d" -c "begin" -c "lock table public.brand_memberships in access exclusive mode" -c "select pg_sleep(2)" -c "alter table public.brand_memberships owner to $other" -c "commit" >"$tmp/q6h" 2>&1 & h=$!
ae_held "$d" || fail "Q6 the owner-changing session never held the lock"
rollback_with "$d" "$a" >"$tmp/q6.out" 2>&1 & bg=$!
wait "$h" || fail "Q6 owner change: $(cat "$tmp/q6h")"
if wait "$bg"; then fail "Q6 the rollback ran after an owner change"; fi
grep -q BM_PRIV_ROLLBACK_NOT_TABLE_OWNER "$tmp/q6.out" || fail "Q6 wrong refusal: $(grep ERROR "$tmp/q6.out" | head -1)"
pass "Q6 an owner change while the rollback waited -> NOT_TABLE_OWNER after the lock, nothing granted"

# Q7 G5's owner-epoch objects appear while the rollback waits -> refused after the lock (a test-only marker function of G5's name)
d="$(newdb q7)"; a="$(apply_cand "$d")"
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -c "begin" -c "lock table public.brand_memberships in access exclusive mode" -c "select pg_sleep(2)" \
  -c "create schema if not exists private" -c "create function private.account_lifecycle_owner_epoch_exposure() returns text language sql as 'select null::text'" -c "commit" >"$tmp/q7h" 2>&1 & h=$!
ae_held "$d" || fail "Q7 the marker session never held the lock"
rollback_with "$d" "$a" >"$tmp/q7.out" 2>&1 & bg=$!
wait "$h" || fail "Q7 marker: $(cat "$tmp/q7h")"
if wait "$bg"; then fail "Q7 the rollback ran while G5 appeared"; fi
grep -q BM_PRIV_ROLLBACK_REFUSED_OWNER_EPOCH_INSTALLED "$tmp/q7.out" || fail "Q7 wrong refusal: $(grep ERROR "$tmp/q7.out" | head -1)"
expect "Q7 unchanged" "$(priv "$d")" "$POST_PRIV"
pass "Q7 G5's owner epoch appearing while the rollback waited -> refused after the lock, nothing granted"

# Q8 the forward too: a replacement while it waits for the lock -> TABLE_REPLACED, the new table unchanged
d="$(newdb q8)"
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -c "begin" -c "lock table public.brand_memberships in access exclusive mode" -c "select pg_sleep(2)" \
  -c "alter table public.brand_memberships rename to brand_memberships_replaced" -c "create table public.brand_memberships (brand_id text, user_id uuid, role text)" -c "commit" >"$tmp/q8h" 2>&1 & h=$!
ae_held "$d" || fail "Q8 the replacing session never held the lock"
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$cand" >"$tmp/q8.out" 2>&1 & bg=$!
wait "$h" || fail "Q8 replacement: $(cat "$tmp/q8h")"
if wait "$bg"; then fail "Q8 the forward ran on the replacement table"; fi
grep -q BM_PRIV_PRECONDITION_TABLE_REPLACED "$tmp/q8.out" || fail "Q8 wrong refusal: $(grep ERROR "$tmp/q8.out" | head -1)"
expect "Q8 the new table keeps its own ACL" "$(has_priv "$d" authenticated TRIGGER)" "t"
pass "Q8 the forward: a replacement while it waited -> TABLE_REPLACED, nothing revoked on the new table"

# Q9 the claim does not block readers: a SELECT during the paused forward completes within 1 s
d="$(newdb q9)"; pause_after "$cand" "-- (prestate taken" 3 >"$tmp/q9.sql"
psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$tmp/q9.sql" >"$tmp/q9.out" 2>&1 & bg=$!
sleeping_in "$d" || fail "Q9 the paused forward never paused"
own "$d" -c "set lock_timeout = '1s'" -c "begin" -c "set local role authenticated" -c "select count(*) from public.brand_memberships" -c "commit" >"$tmp/q9r" 2>&1 || fail "Q9 a reader was blocked: $(cat "$tmp/q9r")"
wait "$bg" || fail "Q9 forward: $(cat "$tmp/q9.out")"
pass "Q9 readers are not blocked by the row claim (writers still wait for the table lock, as K1)"
# Q10 the claim must be ACL-neutral: an owner that revoked its own SELECT is refused before the claim (the claim would have changed the ACL)
d="$(newdb q10)"; own "$d" -c "revoke select on table public.brand_memberships from $owner" >/dev/null; Q10PRE="$(acl "$d")"
if psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$cand" >"$tmp/q10.out" 2>&1; then fail "Q10 the forward ran with the owner's SELECT missing"; fi
grep -q BM_PRIV_PRECONDITION_OWNER_ACL_INCOMPLETE "$tmp/q10.out" || fail "Q10 wrong refusal: $(grep ERROR "$tmp/q10.out" | head -1)"
expect "Q10 unchanged" "$(acl "$d")" "$Q10PRE"
pass "Q10 the owner's own SELECT missing -> OWNER_ACL_INCOMPLETE before the claim; the ACL is unchanged"

# ---- O: apply order with G5's REAL candidate files (optional) ----
if [ -n "$g5" ]; then
  [ -f "$g5/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" ] && \
  [ -f "$g5/supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql" ] || fail "BM_G5_TREE does not hold G5 PR #358's tree"
  gm="$g5/supabase/migrations"; gt="$g5/supabase/tests"
  oe="$g5/supabase/candidates/common_account_brand_owner_epoch"; av="$g5/supabase/candidates/common_account_authorization_verdict"
  "${S[@]}" -d postgres -c "create database $order owner $owner" >/dev/null
  # G5's own baseline (common_account_authorization_verdict_pg_run.sh), WITHOUT its TEST-WORLD revoke stand-in: the G3 candidate takes its place
  own "$order" -f "$gt/social_mobile_account_deletion_fixture.sql" >/dev/null
  own "$order" -f "$gm/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
  for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own "$order" -f "$gm/$f" >/dev/null; done
  own "$order" -f "$gt/common_account_lifecycle_fixture.sql" >/dev/null
  own "$order" -f "$gt/common_account_phase9_auth_fixture.sql" >/dev/null
  own "$order" -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null
  own "$order" -f "$gm/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
  for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
           20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
           20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
           20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
    own "$order" -f "$gm/$f.sql" >/dev/null
  done
  own "$order" -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
  g5_try() { local f="$1" code="$2" label="$3"
    if own "$order" -f "$f" >"$tmp/out" 2>&1; then fail "$label: G5 file installed"; fi
    grep -q "$code" "$tmp/out" || fail "$label: wrong refusal: $(grep ERROR "$tmp/out" | head -1)"; }
  oexp() { val "$order" -c "select coalesce(private.account_lifecycle_owner_epoch_exposure(), 'NONE')"; }

  expect "O0 order world privileges before" "$(priv "$order")" "$PRE_PRIV"
  g5_try "$oe/001_brand_owner_epoch.sql" OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS "O1 PR #303 before the G3 candidate"
  g5_try "$av/001_authorization_verdict.sql" AUTH_VERDICT_PRECONDITION_MISSING "O1 PR #358 before PR #303"
  expect "O1 nothing installed" "$(val "$order" -c "select (to_regprocedure('private.account_lifecycle_owner_epoch_exposure()') is null and to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is null)::text")" "true"
  pass "O1 G5 refuses before L-1: PR #303 OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS, PR #358 needs PR #303"

  A_ORDER="$(apply_cand "$order")"
  expect "O2 order world privileges after" "$(priv "$order")" "$POST_PRIV"
  own "$order" -f "$oe/001_brand_owner_epoch.sql" >/dev/null || fail "O2 PR #303 install after the G3 candidate"
  expect "O2 G5's real L-1 check" "$(oexp)" "NONE"
  expect "O2 G3 copy agrees with G5's function" "$(exposure_equiv "$order")" "NONE"
  own "$order" -f "$av/001_authorization_verdict.sql" >/dev/null || fail "O2 PR #358 install after PR #303"
  expect "O2 R1/W1/W2 exist" "$(val "$order" -c "select (to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is not null and to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is not null and to_regprocedure('public.common_account_worker_brand_verdict(text,text,bigint,bigint)') is not null)::text")" "true"
  pass "O2 G3 candidate -> PR #303 install (G5 exposure NONE) -> PR #358 install"

  if rollback_with "$order" "$A_ORDER" >"$tmp/out" 2>&1; then fail "O3 G3 rollback ran while G5 is installed"; fi
  grep -q BM_PRIV_ROLLBACK_REFUSED_OWNER_EPOCH_INSTALLED "$tmp/out" || fail "O3 wrong refusal: $(grep ERROR "$tmp/out" | head -1)"
  expect "O3 privileges unchanged" "$(priv "$order")" "$POST_PRIV"
  expect "O3 G5 exposure still NONE" "$(oexp)" "NONE"
  pass "O3 the G3 rollback refuses while G5's owner epoch is installed"

  own "$order" -f "$av/001_authorization_verdict_rollback.sql" >/dev/null
  own "$order" -f "$oe/001_brand_owner_epoch_rollback.sql" >/dev/null
  rollback_with "$order" "$A_ORDER" >/dev/null
  expect "O4 privileges after the full rollback" "$(priv "$order")" "$PRE_PRIV"
  g5_try "$oe/001_brand_owner_epoch.sql" OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS "O4 PR #303 re-install without L-1"
  own "$order" -f "$cand" >/dev/null
  own "$order" -f "$oe/001_brand_owner_epoch.sql" >/dev/null || fail "O4 PR #303 re-install after the G3 re-apply"
  own "$order" -f "$av/001_authorization_verdict.sql" >/dev/null || fail "O4 PR #358 re-install"
  expect "O4 G5 exposure after the re-install" "$(oexp)" "NONE"
  pass "O4 rollback order PR #358 -> PR #303 -> G3; re-install needs the G3 candidate again; then G5 re-installs"
else
  echo "O_NOT_RUN: BM_G5_TREE not set (apply order with G5's real files not exercised)"
fi

echo "BRAND_MEMBERSHIPS_PRIVILEGES_ALL_PASS"
