#!/usr/bin/env bash
# Disposable-only proof runner for 20261006230000_common_account_service_start_intent (Phase 2, H1/C1 R1).
# Builds the lifecycle suite's production-shaped baseline (fixtures, the real onboarding and social-mobile
# deletion migrations, Phase 1) on a LOCAL Unix-socket PostgreSQL, applies the candidate as a non-superuser
# owner, then proves: preflight refusals, additive change (only the start helper is replaced), behavior, and
# two-session races (an end racing an automatic start, both orders; two restarts with one confirmation).
# Fake data only; never production.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_service_start_intent_run.sh
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${CAL_INTENT_CANDIDATE:-$migrations/20261006230000_common_account_service_start_intent.sql}"
owner="kb_cal_intent_owner"
db="kabumori_cal_intent_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
Q=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
cleanup() { "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
"${O[@]}" -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${O[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${O[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${O[@]}" -f "$here/common_account_lifecycle_fixture.sql" >/dev/null

# 1. Preflight: refuses without the Phase 1 foundation, creating nothing.
if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted a database without Phase 1" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_START_INTENT_PREFLIGHT_FOUNDATION_MISSING' <<<"$out" || { echo "FAIL preflight reason: $out" >&2; exit 1; }
[[ "$("${Q[@]}" -c "select coalesce(to_regprocedure('public.reactivate_kabumori_service(bigint)')::text, 'absent')")" == absent ]] \
  || { echo "FAIL preflight left objects" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_PREFLIGHT_PASS"

"${O[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null

# 2. Additive: everything but the replaced automatic-start helper is byte-identical in the catalog.
catalog() {
  "${Q[@]}" <<'SQL'
select 'fn ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'private', 'auth', 'storage') and p.prokind = 'f'
union all
select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce(array_to_string(c.relacl::text[], ','), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private', 'auth', 'storage')
union all
select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(array_to_string(a.attacl::text[], ','), '-')
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'private') and a.attnum > 0 and not a.attisdropped
union all
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where conrelid <> 0
union all
select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '-') from pg_policy
union all
select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || tgenabled::text from pg_trigger where not tgisinternal
union all
select 'row ' || auth_delete_guard || '/' || integration_state || '/' || requirement_epoch from private.account_lifecycle_settings
order by 1;
SQL
}
catalog > "${TMPDIR:-/tmp}/cal_intent_before.$$"
"${O[@]}" -f "$candidate" >/dev/null
catalog > "${TMPDIR:-/tmp}/cal_intent_after.$$"
removed="$(comm -23 "${TMPDIR:-/tmp}/cal_intent_before.$$" "${TMPDIR:-/tmp}/cal_intent_after.$$")"
added="$(comm -13 "${TMPDIR:-/tmp}/cal_intent_before.$$" "${TMPDIR:-/tmp}/cal_intent_after.$$" | sed -E 's/^(fn [^ ]+) .*/\1/' | sort)"
rm -f "${TMPDIR:-/tmp}/cal_intent_before.$$" "${TMPDIR:-/tmp}/cal_intent_after.$$"
[[ "$(sed -E 's/^(fn [^ ]+) .*/\1/' <<<"$removed")" == "fn private.account_lifecycle_start_service(uuid,text)" ]] \
  || { echo "FAIL additive: unexpected removal/change: $removed" >&2; exit 1; }
want_added="$(printf '%s\n' 'fn private.account_lifecycle_active_answer(uuid,text,boolean)' \
  'fn private.account_lifecycle_reactivate_service(uuid,text,bigint)' 'fn private.account_lifecycle_service_refusal(text)' \
  'fn private.account_lifecycle_start_service(uuid,text)' 'fn reactivate_kabumori_service(bigint)' 'fn reactivate_x_autopost_service(bigint)' | sort)"
[[ "$added" == "$want_added" ]] || { echo "FAIL additive: unexpected additions: $added" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_ADDITIVE_PASS"

# Re-applying refuses (no silent second install).
if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply accepted" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_START_INTENT_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply reason: $out" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_REAPPLY_REFUSED_PASS"

# 3. Behavior.
"${Q[@]}" -f "$here/common_account_service_start_intent_behavior.sql" | grep -qx 'COMMON_ACCOUNT_START_INTENT_BEHAVIOR_PASS' \
  || { echo "FAIL behavior" >&2; "${Q[@]}" -f "$here/common_account_service_start_intent_behavior.sql" >&2 || true; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_BEHAVIOR_PASS"

# 4. Two-session races. A session holds its transaction open (pg_sleep) after its call; the other
#    session's call queues on the lifecycle lock and runs after that commit.
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
as_user() {  # sub, sql -> output of sql as authenticated(sub)
  "${Q[@]}" -c "begin; set local request.jwt.claim.sub = '$1'; set local role authenticated; $2; commit;"
}
as_backend_hold() {  # sql, seconds -> run as service_role, hold the transaction open
  "${Q[@]}" -c "begin; set local role service_role; $1; reset role; select pg_sleep($2); commit;" >/dev/null
}
as_user_hold() {  # sub, sql, seconds
  "${Q[@]}" -c "begin; set local request.jwt.claim.sub = '$1'; set local role authenticated; $2; reset role; select pg_sleep($3); commit;" >/dev/null
}
login() { "${Q[@]}" -c "select public.fixture_login('$1'::uuid)" >/dev/null; }
ent() { "${Q[@]}" -c "select coalesce((select status from public.service_entitlements where user_id = '$1' and service_key = '$2'), 'none')"; }

# 4a. Kabumori withdrawal (backend) holds; the automatic start queues and must see ended.
u="$(uid 2001)"; login "$u"; as_user "$u" "select public.start_kabumori_service()" >/dev/null
( as_backend_hold "select public.withdraw_kabumori_service('$u'::uuid)" 1.5 ) &
holder=$!
sleep 0.4
r="$(as_user "$u" "select public.start_kabumori_service()::text")"
wait "$holder"
[[ "$r" == *'"status": "reenroll_required"'* && "$(ent "$u" kabumori)" == ended ]] \
  || { echo "FAIL race withdraw-then-start: $r / $(ent "$u" kabumori)" >&2; exit 1; }
[[ "$("${Q[@]}" -c "select exists (select 1 from public.profiles where id = '$u')")" == f ]] || { echo "FAIL race recreated the profile" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_RACE_END_THEN_START_PASS"

# 4b. The automatic start holds; the withdrawal queues; the final state is ended.
u="$(uid 2002)"; login "$u"; as_user "$u" "select public.start_kabumori_service()" >/dev/null
( as_user_hold "$u" "select public.start_kabumori_service()" 1.5 ) &
holder=$!
sleep 0.4
r="$("${Q[@]}" -c "begin; set local role service_role; select public.withdraw_kabumori_service('$u'::uuid)::text; commit;")"
wait "$holder"
[[ "$r" == *'"status": "ended"'* && "$(ent "$u" kabumori)" == ended ]] || { echo "FAIL race start-then-end: $r" >&2; exit 1; }
r="$(as_user "$u" "select public.start_kabumori_service()::text")"
[[ "$r" == *reenroll_required* && "$(ent "$u" kabumori)" == ended ]] || { echo "FAIL race start-then-end restart: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_RACE_START_THEN_END_PASS"

# 4c. X: the backend finishes the service deletion while an automatic start queues.
u="$(uid 2003)"; login "$u"; as_user "$u" "select public.start_x_autopost_service()" >/dev/null
op="$("${Q[@]}" -c "begin; set local role service_role; select public.begin_service_deletion('$u'::uuid, 'x_autopost') ->> 'operation_id'; commit;")"
( as_backend_hold "select public.finish_service_deletion('$u'::uuid, 'x_autopost', '$op'::uuid)" 1.5 ) &
holder=$!
sleep 0.4
r="$(as_user "$u" "select public.start_x_autopost_service()::text")"
wait "$holder"
[[ "$r" == *reenroll_required* && "$(ent "$u" x_autopost)" == ended ]] || { echo "FAIL race X end-then-start: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_RACE_X_END_THEN_START_PASS"

# 4d. Two restarts with the same confirmation: exactly one restarts; the other sees lifecycle_changed.
u="$(uid 2004)"; login "$u"; as_user "$u" "select public.start_kabumori_service()" >/dev/null
"${Q[@]}" -c "begin; set local role service_role; select public.withdraw_kabumori_service('$u'::uuid); commit;" >/dev/null
v="$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
( as_user_hold "$u" "select public.reactivate_kabumori_service($v)" 1.5 ) &
holder=$!
sleep 0.4
r="$(as_user "$u" "select public.reactivate_kabumori_service($v)::text")"
wait "$holder"
[[ "$r" == *lifecycle_changed* && "$(ent "$u" kabumori)" == active \
   && "$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")" == "$((v + 1))" ]] \
  || { echo "FAIL race double restart: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_RACE_ONE_USE_RESTART_PASS"

# 4e. A withdrawal holds while a restart with the pre-withdrawal confirmation queues: stays ended.
u="$(uid 2005)"; login "$u"; as_user "$u" "select public.start_kabumori_service()" >/dev/null
"${Q[@]}" -c "begin; set local role service_role; select public.withdraw_kabumori_service('$u'::uuid); commit;" >/dev/null
v="$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
as_user "$u" "select public.reactivate_kabumori_service($v)" >/dev/null
"${Q[@]}" -c "select 1" >/dev/null
( as_backend_hold "select public.withdraw_kabumori_service('$u'::uuid)" 1.5 ) &
holder=$!
sleep 0.4
r="$(as_user "$u" "select public.reactivate_kabumori_service($((v + 1)))::text")"
wait "$holder"
[[ "$r" == *lifecycle_changed* && "$(ent "$u" kabumori)" == ended ]] || { echo "FAIL race end-then-stale-restart: $r / $(ent "$u" kabumori)" >&2; exit 1; }
echo "COMMON_ACCOUNT_START_INTENT_RACE_END_THEN_STALE_RESTART_PASS"

echo "COMMON_ACCOUNT_START_INTENT_ALL_PASS"
