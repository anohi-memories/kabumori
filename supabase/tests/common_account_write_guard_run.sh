#!/usr/bin/env bash
# Disposable-only proof runner for 20261010051938_common_account_service_write_guard (common account
# Phase 3b, G5: the shared service-write guard, not wired). Builds the lifecycle suites' production-shaped
# baseline (fixtures, the real onboarding and social-mobile deletion migrations, Phase 1, Phase 2,
# Phase 3a) on a LOCAL Unix-socket PostgreSQL, applies the candidate as a non-superuser owner, then
# proves: preflight refusals, the exact schema change (one function, owner-only EXECUTE), refused
# re-apply, static source rules, the behavior suite, fail-closed environments, two-session races and the
# emergency rollback. Fake data only; never production.
#
# TEST STAND-INS, never in the candidate: "delete from auth.users" is a login removal (the managed Auth
# Admin delete or a route that bypasses it); "insert into auth.identities" is GoTrue linking an identity;
# "insert into / delete from auth.sessions" is GoTrue issuing / revoking a session. Section 6f opens the
# Phase 3a release gate by TEST-ONLY DDL in this throwaway database to reach the managed-delete intent.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_write_guard_run.sh
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${CAL_WRITE_GUARD_CANDIDATE:-$migrations/20261010051938_common_account_service_write_guard.sql}"
owner="kb_cal_write_guard_owner"
db="kabumori_cal_write_guard_$$"
guard='private.account_lifecycle_assert_active_service_write(uuid,text)'
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
Q=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
tmp="$(mktemp -d /private/tmp/kabumori-cal-write-guard.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database $db owner $owner;
SQL
"${O[@]}" -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${O[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${O[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${O[@]}" -f "$here/common_account_lifecycle_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
"${O[@]}" -f "$migrations/20261006230000_common_account_service_start_intent.sql" >/dev/null
"${O[@]}" -f "$migrations/20261009120000_common_account_deletion_completion.sql" >/dev/null

has_new_objects() {
  "${Q[@]}" -c "select exists (select 1 from pg_proc where proname = 'account_lifecycle_assert_active_service_write')"
}
refused_with() {  # code -> the candidate is refused with it and leaves nothing behind
  local out
  if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted: expected $1" >&2; exit 1; fi
  grep -q "$1" <<<"$out" || { echo "FAIL preflight reason (expected $1): $out" >&2; exit 1; }
  [[ "$(has_new_objects)" == f ]] || { echo "FAIL preflight left objects ($1)" >&2; exit 1; }
}

# 1. Preflight. No auth.sessions yet (the guard fixture adds it): refused.
refused_with COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_SHAPE
"${O[@]}" -f "$here/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$db" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
"${Q[@]}" -c "alter table auth.sessions rename column not_after to not_after_moved" >/dev/null
refused_with COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_SHAPE
"${Q[@]}" -c "alter table auth.sessions rename column not_after_moved to not_after" >/dev/null
"${Q[@]}" -c "revoke select on auth.sessions from $owner" >/dev/null
refused_with COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_AUTH_SESSIONS_UNREADABLE
"${Q[@]}" -c "grant select on auth.sessions to $owner" >/dev/null
for drift in authenticated service_role kb_cal_auth_child; do
  "${S[@]}" -d "$db" -c "grant execute on function private.account_lifecycle_lock(uuid,boolean,boolean) to $drift" >/dev/null
  if [[ "$drift" == kb_cal_auth_child ]]; then
    # A grant to a child role is not a grant to an API role: accepted only if no API role reaches it.
    if ! out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight refused an unrelated child grant: $out" >&2; exit 1; fi
    "${O[@]}" -f "$here/common_account_write_guard_rollback.sql" >/dev/null
  else
    refused_with COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_LOCK_ACL_CHANGED
  fi
  "${S[@]}" -d "$db" -c "revoke execute on function private.account_lifecycle_lock(uuid,boolean,boolean) from $drift" >/dev/null
done
"${S[@]}" -d "$db" -c "grant execute on function private.account_lifecycle_lock(uuid,boolean,boolean) to public" >/dev/null
refused_with COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_LOCK_ACL_CHANGED
"${S[@]}" -d "$db" -c "revoke execute on function private.account_lifecycle_lock(uuid,boolean,boolean) from public" >/dev/null
"${Q[@]}" -c "alter function private.account_lifecycle_lock(uuid,boolean,boolean) rename to account_lifecycle_lock_moved" >/dev/null
refused_with COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_FOUNDATION_MISSING
"${Q[@]}" -c "alter function private.account_lifecycle_lock_moved(uuid,boolean,boolean) rename to account_lifecycle_lock" >/dev/null
echo "COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_PASS"

# 2. Exactly this change: one function added, owner-only EXECUTE; nothing removed or altered.
catalog() {
  "${Q[@]}" <<'SQL'
select 'fn ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'private', 'auth', 'storage', 'vault') and p.prokind = 'f'
union all
select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce(array_to_string(c.relacl::text[], ','), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private', 'auth', 'storage', 'vault')
union all
select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(array_to_string(a.attacl::text[], ','), '-')
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'private', 'auth', 'storage', 'vault') and a.attnum > 0 and not a.attisdropped
union all
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where conrelid <> 0
union all
select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '-') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-') from pg_policy
union all
select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || tgenabled::text from pg_trigger where not tgisinternal
union all
select 'nsp ' || nspname || ' ' || coalesce(array_to_string(nspacl::text[], ','), '-') from pg_namespace where nspname in ('public', 'private', 'auth', 'storage', 'vault')
union all
select 'gate ' || gate || '/' || state from private.account_lifecycle_release_gates
union all
select 'row ' || auth_delete_guard || '/' || integration_state || '/' || requirement_epoch from private.account_lifecycle_settings
order by 1;
SQL
}
catalog > "$tmp/before"
sed -e 's/^commit;$/rollback;/' "$candidate" > "$tmp/rolled_back.sql"
[[ "$(grep -c '^rollback;$' "$tmp/rolled_back.sql")" == 1 ]] || { echo "FAIL rollback copy" >&2; exit 1; }
"${O[@]}" -f "$tmp/rolled_back.sql" >/dev/null
catalog > "$tmp/rolled_back"
cmp -s "$tmp/before" "$tmp/rolled_back" || { echo "FAIL transaction rollback: the catalog changed" >&2; diff "$tmp/before" "$tmp/rolled_back" >&2 || true; exit 1; }
"${O[@]}" -f "$candidate" >/dev/null
catalog > "$tmp/after"
removed="$(comm -23 "$tmp/before" "$tmp/after")"
added="$(comm -13 "$tmp/before" "$tmp/after")"
[[ -z "$removed" ]] || { echo "FAIL change: unexpected removal/alteration:" >&2; echo "$removed" >&2; exit 1; }
[[ "$(sed -E 's/^(fn [^ ]+) [0-9a-f]{32} /\1 /' <<<"$added")" == "fn private.account_lifecycle_assert_active_service_write(uuid,text) $owner=X/$owner" ]] \
  || { echo "FAIL change: unexpected additions:" >&2; echo "$added" >&2; exit 1; }
[[ "$("${Q[@]}" -c "select pronamespace::regnamespace::text || '/' || proowner::regrole::text from pg_proc where oid = '$guard'::regprocedure")" == "private/$owner" ]] \
  || { echo "FAIL change: schema/owner" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_EXACT_CHANGE_PASS"

if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply accepted" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_WRITE_GUARD_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply reason: $out" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_REAPPLY_REFUSED_PASS"

# 3. Static rules on the candidate source (comments stripped).
code="$(sed -e 's/--.*$//' "$candidate")"
flat="$(tr '\n' ' ' <<<"$code" | tr ';' '\n')"
if grep -qiE '(^|[^a-z_])(insert[[:space:]]+into|update[[:space:]]+[a-z_]+\.|delete[[:space:]]+from|truncate|merge[[:space:]]+into)' <<<"$flat"; then
  echo "FAIL the candidate writes rows" >&2; exit 1
fi
if grep -qiE '(^|[[:space:]])grant[[:space:]]' <<<"$flat"; then echo "FAIL the candidate grants a privilege" >&2; exit 1; fi
if grep -qiE 'create[[:space:]]+or[[:space:]]+replace|drop[[:space:]]+(table|function|view|trigger|policy|index|schema|column)|alter[[:space:]]+(table|function|default|schema|policy|role)|create[[:space:]]+(trigger|policy|table|view|role)|security[[:space:]]+invoker' <<<"$code"; then
  echo "FAIL the candidate creates, replaces, alters or drops something beyond its one function" >&2; exit 1
fi
if grep -qiE 'release_gates|auth_delete_guard|enforc' <<<"$code"; then echo "FAIL the candidate touches the release gate or the guard mode" >&2; exit 1; fi
if grep -qiE 'auth\.sessions[^;]*for[[:space:]]+(update|no[[:space:]]+key|share|key)' <<<"$flat"; then echo "FAIL the candidate locks GoTrue session rows" >&2; exit 1; fi
if grep -qiE 'auth\.admin|/auth/v1|deleteUser|storage/v1|vault\.' <<<"$code"; then echo "FAIL the candidate reaches for a managed API or Vault" >&2; exit 1; fi
fns="$(grep -ciE '^create function' <<<"$code")"
safe="$(grep -ciE 'volatile security definer set search_path = '"''" <<<"$code")"
[[ "$fns" == 1 && "$safe" == 1 ]] || { echo "FAIL the one function must be VOLATILE SECURITY DEFINER with an empty search_path ($fns/$safe)" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_STATIC_PASS"

# 4. Behavior.
"${Q[@]}" -f "$here/common_account_write_guard_behavior.sql" > "$tmp/behavior" 2>&1 || true
grep -qx 'COMMON_ACCOUNT_WRITE_GUARD_BEHAVIOR_PASS' "$tmp/behavior" || { echo "FAIL behavior" >&2; cat "$tmp/behavior" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_BEHAVIOR_PASS"

# 5. Fail-closed environments.
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
svc() { "${Q[@]}" -c "begin; set local role service_role; $1; commit;"; }
person() {  # uid services... -> login, entitlements through the real start RPCs
  local u="$1"; shift
  "${Q[@]}" -c "select public.fixture_login('$u'::uuid)" >/dev/null
  for s in "$@"; do
    "${Q[@]}" -c "begin; set local request.jwt.claim.sub = '$u'; set local role authenticated; select public.start_${s}_service(); commit;" >/dev/null
  done
}
session() { "${Q[@]}" -c "insert into auth.sessions (user_id) values ('$1') returning id" | head -1; }
claims() { echo "set local request.jwt.claim.sub = '$1'; set local request.jwt.claim.role = 'authenticated'; set local request.jwt.claim.session_id = '$2';"; }
write() {  # uid session service [isolation] -> the writer's output or error
  "${Q[@]}" -c "begin isolation level ${4:-read committed}; $(claims "$1" "$2") set local role authenticated; select public.fixture_guarded_service_write('$3'); commit;" 2>&1 || true
}
footprints() { "${Q[@]}" -c "select count(*) from public.fixture_service_footprint where user_id = '$1'"; }

u="$(uid 501)"; person "$u" x_autopost; s="$(session "$u")"
for iso in 'repeatable read' serializable; do
  [[ "$(write "$u" "$s" x_autopost "$iso")" == *ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE* ]] || { echo "FAIL fail-closed: $iso accepted" >&2; exit 1; }
done
"${S[@]}" -d "$db" -c "revoke select on auth.sessions from $owner" >/dev/null
[[ "$(write "$u" "$s" x_autopost)" == *ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE* ]] || { echo "FAIL fail-closed: unreadable sessions accepted" >&2; exit 1; }
"${S[@]}" -d "$db" -c "grant select on auth.sessions to $owner" >/dev/null
[[ "$(footprints "$u")" == 0 ]] || { echo "FAIL fail-closed: something was written" >&2; exit 1; }
[[ "$(write "$u" "$s" x_autopost)" =~ ^[0-9]+$ ]] || { echo "FAIL fail-closed setup: the restored environment does not write" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_FAIL_CLOSED_ENV_PASS"

# 6. Two-session races.
lock_waiters() {  # pattern -> number of backends of this database waiting on a lock while running it
  "${Q[@]}" -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%$1%' and pid <> pg_backend_pid()"
}

# 6a. The deletion begins first (uncommitted, holding the account) when a writer arrives: the writer
#     waits, then sees the committed deletion and writes nothing.
u="$(uid 601)"; person "$u" x_autopost; s="$(session "$u")"
v="$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
( "${Q[@]}" -c "begin; set local role service_role; select public.begin_common_account_deletion('$u'::uuid, $v); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$(write "$u" "$s" x_autopost)"
wait "$holder"
[[ "$r" == *ACCOUNT_DELETION_IN_PROGRESS* && "$(footprints "$u")" == 0 ]] || { echo "FAIL race begin-then-write: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_RACE_BEGIN_THEN_WRITE_PASS"

# 6b. The write holds its transaction when the deletion begins: the deletion WAITS for it (observed), so
#     the write is committed before the deletion exists and its cleanup sees it; the next write is refused.
u="$(uid 602)"; person "$u" x_autopost; s="$(session "$u")"
v="$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
( "${Q[@]}" -c "begin; $(claims "$u" "$s") set local role authenticated; select public.fixture_guarded_service_write('x_autopost'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
( svc "select public.begin_common_account_deletion('$u'::uuid, $v) ->> 'status'" > "$tmp/r6b" ) &
beginner=$!
sleep 0.4
waiting="$(lock_waiters begin_common_account_deletion)"
wait "$holder"; wait "$beginner"
[[ "$waiting" == 1 && "$(cat "$tmp/r6b")" == started && "$(footprints "$u")" == 1 ]] \
  || { echo "FAIL race write-then-begin: waiting=$waiting begin=$(cat "$tmp/r6b") footprints=$(footprints "$u")" >&2; exit 1; }
[[ "$(write "$u" "$s" x_autopost)" == *ACCOUNT_DELETION_IN_PROGRESS* && "$(footprints "$u")" == 1 ]] || { echo "FAIL race write-then-begin: next write" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_RACE_WRITE_THEN_BEGIN_PASS"

# 6c. A POSTONA-only deletion begins first: the writer waits on the entitlement and is refused.
u="$(uid 603)"; person "$u" x_autopost kabumori; s="$(session "$u")"
( "${Q[@]}" -c "begin; set local role service_role; select public.begin_service_deletion('$u'::uuid, 'x_autopost'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$(write "$u" "$s" x_autopost)"
wait "$holder"
[[ "$r" == *SERVICE_DELETION_IN_PROGRESS* && "$(footprints "$u")" == 0 ]] || { echo "FAIL race service-deletion-then-write: $r" >&2; exit 1; }
[[ "$(write "$u" "$s" kabumori)" =~ ^[0-9]+$ ]] || { echo "FAIL race service-deletion: the other service is not affected" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_RACE_SERVICE_DELETION_THEN_WRITE_PASS"

# 6d. The session is revoked while the writer waits for the account lock: the session is read AFTER the
#     wait, so the revocation is seen and nothing is written.
u="$(uid 604)"; person "$u" x_autopost; s1="$(session "$u")"; s2="$(session "$u")"
( "${Q[@]}" -c "begin; $(claims "$u" "$s1") set local role authenticated; select public.fixture_guarded_service_write('x_autopost'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.3
( write "$u" "$s2" x_autopost > "$tmp/r6d" ) &
waiter=$!
sleep 0.4
waiting="$(lock_waiters fixture_guarded_service_write)"
"${Q[@]}" -c "delete from auth.sessions where id = '$s2'" >/dev/null
wait "$holder"; wait "$waiter"
[[ "$waiting" == 1 && "$(cat "$tmp/r6d")" == *ACCOUNT_LIFECYCLE_AUTH_REQUIRED* && "$(footprints "$u")" == 1 ]] \
  || { echo "FAIL race revoke-while-waiting: waiting=$waiting $(cat "$tmp/r6d") footprints=$(footprints "$u")" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_RACE_SESSION_REVOKED_WHILE_WAITING_PASS"

# 6e. A login removal is uncommitted when the writer arrives: the writer's key-share lock on the login
#     waits, then finds no login and writes nothing (a still-valid token of a removed person).
u="$(uid 605)"; person "$u" x_autopost; s="$(session "$u")"
( "${Q[@]}" -c "begin; delete from auth.users where id = '$u'; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$(write "$u" "$s" x_autopost)"
wait "$holder"
[[ "$r" == *ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND* && "$(footprints "$u")" == 0 ]] || { echo "FAIL race removal-then-write: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_RACE_REMOVAL_THEN_WRITE_PASS"

# 6g. A writer that hands the guard another person's id is refused before it touches that person's rows:
#     while the other person's account is locked, it answers at once instead of queueing on the lock.
victim="$(uid 607)"; person "$victim" x_autopost; vs="$(session "$victim")"
u="$(uid 608)"; person "$u" x_autopost; s="$(session "$u")"
( "${Q[@]}" -c "begin; $(claims "$victim" "$vs") set local role authenticated; select public.fixture_guarded_service_write('x_autopost'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$("${Q[@]}" -c "begin; set local lock_timeout = '300ms'; $(claims "$u" "$s") set local role authenticated; select public.fixture_guarded_write_for('$victim', 'x_autopost'); commit;" 2>&1 || true)"
wait "$holder"
[[ "$r" == *ACCOUNT_LIFECYCLE_AUTH_REQUIRED* && "$(footprints "$victim")" == 1 && "$(footprints "$u")" == 0 ]] \
  || { echo "FAIL race foreign-id: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_RACE_FOREIGN_ID_REFUSED_WITHOUT_LOCKING_PASS"

# 6f. NEGATIVE REPRODUCTION of the Auth blocker, and what the guard still holds. After the managed-delete
#     intent commits, nothing in the database stops an identity link (GoTrue's insert) or a new session:
#     the intent's identity evidence is already stale. The guard still refuses every service write of
#     that person, through the new session too.
"${Q[@]}" -c "alter table private.account_lifecycle_release_gates drop constraint account_lifecycle_release_gates_blocked_only;
              update private.account_lifecycle_release_gates set state = 'open'" >/dev/null   # TEST-ONLY DDL
u="$(uid 606)"; person "$u" kabumori
v="$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
op="$(svc "select public.begin_common_account_deletion('$u'::uuid, $v) ->> 'operation_id'")"
svc "select public.withdraw_kabumori_service('$u'::uuid)" >/dev/null
"${Q[@]}" -c "select public.record_common_account_deletion_checkpoint('$u'::uuid, '$op'::uuid, 'session_revocation')" >/dev/null
"${Q[@]}" -c "select public.record_common_account_deletion_checkpoint('$u'::uuid, '$op'::uuid, 'storage_cleanup')" >/dev/null
[[ "$("${Q[@]}" -c "select public.prepare_common_account_auth_delete('$u'::uuid, '$op'::uuid) ->> 'status'")" == ready_for_managed_auth_delete ]] \
  || { echo "FAIL race 6f setup: not ready" >&2; exit 1; }
lease="$(svc "select public.claim_common_account_deletion('$u'::uuid, '$op'::uuid, 600) ->> 'lease'")"
[[ "$(svc "select public.begin_common_account_deletion_external_step('$u'::uuid, '$op'::uuid, '$lease'::uuid, 'managed_auth_delete') ->> 'status'")" == owned ]] \
  || { echo "FAIL race 6f setup: intent" >&2; exit 1; }
"${Q[@]}" -c "insert into auth.identities (user_id, provider) values ('$u', 'google')" >/dev/null \
  || { echo "FAIL race 6f: expected the database to accept a post-intent identity link (nothing in SQL can fence it)" >&2; exit 1; }
s="$(session "$u")"
[[ "$("${Q[@]}" -c "select array_to_string(managed_delete_identity_providers, ',') from private.account_lifecycle_operations where id = '$op'")" == email \
   && "$("${Q[@]}" -c "select string_agg(provider, ',' order by provider) from auth.identities where user_id = '$u'")" == email,google ]] \
  || { echo "FAIL race 6f: evidence shape" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_POST_INTENT_LINK_NOT_FENCED_BY_DATABASE (expected: the Auth identity blocker remains)"
for service in kabumori x_autopost; do
  [[ "$(write "$u" "$s" "$service")" == *ACCOUNT_DELETION_IN_PROGRESS* ]] || { echo "FAIL race 6f: a write through the new session ($service)" >&2; exit 1; }
done
[[ "$(footprints "$u")" == 0 ]] || { echo "FAIL race 6f: something was written" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_RACE_POST_INTENT_LINK_WRITE_REFUSED_PASS"

# 7. Emergency rollback: only the guard goes; its callers then fail closed; it can be re-applied.
"${O[@]}" -f "$here/common_account_write_guard_rollback.sql" >/dev/null
u="$(uid 701)"; person "$u" x_autopost; s="$(session "$u")"
[[ "$(write "$u" "$s" x_autopost)" == *'account_lifecycle_assert_active_service_write'*'does not exist'* && "$(footprints "$u")" == 0 ]] \
  || { echo "FAIL rollback: a caller did not fail closed" >&2; exit 1; }
catalog > "$tmp/rolled_back_after"
# The same catalog as before the candidate, apart from the gate that section 6f opened by test-only DDL.
for f in before rolled_back_after; do grep -v -e '^gate ' -e ' account_lifecycle_release_gates_blocked_only ' "$tmp/$f" > "$tmp/$f.cmp"; done
cmp -s "$tmp/before.cmp" "$tmp/rolled_back_after.cmp" \
  || { echo "FAIL rollback: catalog differs beyond the test-only gate DDL" >&2; diff "$tmp/before.cmp" "$tmp/rolled_back_after.cmp" >&2 || true; exit 1; }
if out="$("${O[@]}" -f "$here/common_account_write_guard_rollback.sql" 2>&1)"; then echo "FAIL rollback ran twice" >&2; exit 1; fi
grep -q COMMON_ACCOUNT_WRITE_GUARD_ROLLBACK_NOT_APPLIED <<<"$out" || { echo "FAIL rollback reason: $out" >&2; exit 1; }
"${O[@]}" -f "$candidate" >/dev/null
[[ "$(write "$u" "$s" x_autopost)" =~ ^[0-9]+$ ]] || { echo "FAIL rollback: re-apply does not restore the guard" >&2; exit 1; }
echo "COMMON_ACCOUNT_WRITE_GUARD_ROLLBACK_PASS"

echo "COMMON_ACCOUNT_WRITE_GUARD_ALL_PASS"
