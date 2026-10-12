#!/usr/bin/env bash
# Disposable-only proof runner for 20261012130000_common_account_core_service_fence (common account
# Phase 4, G5: the service row fence and the closed Kabumori profile root). Builds the lifecycle
# suites' production-shaped baseline (fixtures, the real onboarding and social-mobile deletion
# migrations, Phase 1, Phase 2, Phase 3a, the Phase 3b writer guard and its fixture) once as a template
# on a LOCAL Unix-socket PostgreSQL, applies the candidate as a non-superuser owner, then proves:
# preflight refusals, the exact schema change, refused re-apply, static source rules, the behavior suite
# (vertical slice, isolation, fence, ensure_my_profile, equivalence with the writer guard), fail-closed
# environments, two-session races and the emergency rollback. Fake data only; never production.
#
# TEST STAND-INS, never in the candidate: "delete from auth.users" is a login removal;
# "insert into/delete from auth.sessions" is GoTrue issuing / revoking a session; owner UPDATEs build
# states no client can reach.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_core_fence_run.sh
# Optional: CAL_CORE_FENCE_CANDIDATE=<file> (mutation runs), CAL_CORE_FENCE_SECTIONS=behavior,races,...
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${CAL_CORE_FENCE_CANDIDATE:-$migrations/20261012130000_common_account_core_service_fence.sql}"
guard_migration="$migrations/20261010051938_common_account_service_write_guard.sql"
sections="${CAL_CORE_FENCE_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
owner="kb_cal_core_fence_owner"
tag="$$"
tpl_pre="kabumori_cal_cf_pre_$tag"
tpl="kabumori_cal_cf_tpl_$tag"
db_exact="kabumori_cal_cf_exact_$tag"
db_run="kabumori_cal_cf_run_$tag"
db_dep="kabumori_cal_cf_dep_$tag"
rollback_file="${CAL_CORE_FENCE_ROLLBACK:-$here/common_account_core_fence_rollback.sql}"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
psql_o() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
psql_q() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
tmp="$(mktemp -d /private/tmp/kabumori-cal-core-fence.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  for d in "$db_dep" "$db_run" "$db_exact" "$tpl" "$tpl_pre"; do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
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
create database $tpl_pre owner $owner;
SQL
P=(psql_o "$tpl_pre")
"${P[@]}" -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
"${P[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${P[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${P[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${P[@]}" -f "$here/common_account_lifecycle_fixture.sql" >/dev/null
"${P[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
"${P[@]}" -f "$migrations/20261006230000_common_account_service_start_intent.sql" >/dev/null
"${P[@]}" -f "$migrations/20261009120000_common_account_deletion_completion.sql" >/dev/null
"${P[@]}" -f "$here/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$tpl_pre" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
"${S[@]}" -d postgres -c "create database $tpl template $tpl_pre owner $owner" >/dev/null
psql_o "$tpl" -f "$guard_migration" >/dev/null
echo "COMMON_ACCOUNT_CORE_FENCE_BASELINE_READY"

"${S[@]}" -d postgres -c "create database $db_exact template $tpl owner $owner" >/dev/null
"${S[@]}" -d postgres -c "create database $db_run template $tpl owner $owner" >/dev/null
O=(psql_o "$db_exact")
Q=(psql_q "$db_exact")

has_new_objects() {
  psql_q "$1" -c "select exists (select 1 from pg_proc where proname in ('account_lifecycle_service_state_refusal', 'account_lifecycle_service_insert_fence'))
                    or exists (select 1 from pg_trigger where tgname = 'account_lifecycle_profile_root_fence')"
}
refused_with() {  # database code -> the candidate is refused with it and leaves nothing behind
  local out
  if out="$(psql_o "$1" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted: expected $2" >&2; exit 1; fi
  grep -q "$2" <<<"$out" || { echo "FAIL preflight reason (expected $2): $out" >&2; exit 1; }
  [[ "$(has_new_objects "$1")" == f ]] || { echo "FAIL preflight left objects ($2)" >&2; exit 1; }
}

if want preflight; then
  # 1a. Without the Phase 3b guard: refused.
  "${S[@]}" -d postgres -c "create database kabumori_cal_cf_pf_$tag template $tpl_pre owner $owner" >/dev/null
  refused_with "kabumori_cal_cf_pf_$tag" COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_FOUNDATION_MISSING
  "${S[@]}" -d postgres -c "drop database kabumori_cal_cf_pf_$tag with (force)" >/dev/null
  # 1b. ensure_my_profile() no longer the original (already definer): refused.
  "${S[@]}" -d postgres -c "create database kabumori_cal_cf_pf_$tag template $tpl owner $owner" >/dev/null
  psql_q "kabumori_cal_cf_pf_$tag" -c "alter function public.ensure_my_profile() security definer" >/dev/null
  refused_with "kabumori_cal_cf_pf_$tag" COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_ENSURE_MY_PROFILE_SHAPE
  "${S[@]}" -d postgres -c "drop database kabumori_cal_cf_pf_$tag with (force)" >/dev/null
  # 1c. The lifecycle lock reachable by an API role: refused (and a grant to a child role is not one).
  "${S[@]}" -d postgres -c "create database kabumori_cal_cf_pf_$tag template $tpl owner $owner" >/dev/null
  for drift in authenticated service_role; do
    "${S[@]}" -d "kabumori_cal_cf_pf_$tag" -c "grant execute on function private.account_lifecycle_lock(uuid,boolean,boolean) to $drift" >/dev/null
    refused_with "kabumori_cal_cf_pf_$tag" COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_LOCK_ACL_CHANGED
    "${S[@]}" -d "kabumori_cal_cf_pf_$tag" -c "revoke execute on function private.account_lifecycle_lock(uuid,boolean,boolean) from $drift" >/dev/null
  done
  "${S[@]}" -d "kabumori_cal_cf_pf_$tag" -c "grant execute on function private.account_lifecycle_lock(uuid,boolean,boolean) to public" >/dev/null
  refused_with "kabumori_cal_cf_pf_$tag" COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_LOCK_ACL_CHANGED
  "${S[@]}" -d postgres -c "drop database kabumori_cal_cf_pf_$tag with (force)" >/dev/null
  echo "COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_PASS"
fi

catalog() {
  psql_q "$db_exact" <<'SQL'
select 'fn ' || n.nspname || '.' || p.proname || '(' || array_to_string(p.proargtypes::regtype[], ',') || ') ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(array_to_string(p.proacl::text[], ','), '-')
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
select 'trg ' || (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = tgrelid) || ' ' || tgname || ' ' || tgenabled::text
  from pg_trigger where not tgisinternal
union all
select 'nsp ' || nspname || ' ' || coalesce(array_to_string(nspacl::text[], ','), '-') from pg_namespace where nspname in ('public', 'private', 'auth', 'storage', 'vault')
union all
select 'gate ' || gate || '/' || state from private.account_lifecycle_release_gates
union all
select 'row ' || auth_delete_guard || '/' || integration_state || '/' || requirement_epoch from private.account_lifecycle_settings
order by 1;
SQL
}

if want exact; then
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
  norm() { sed -E 's/^(fn [^ ]+) [0-9a-f]{32} /\1 /'; }
  ensure_acl="$(grep -E '^fn public\.ensure_my_profile\(\) ' "$tmp/before" | norm)"
  [[ -n "$ensure_acl" && "$(norm <<<"$removed")" == "$ensure_acl" ]] \
    || { echo "FAIL change: unexpected removal/alteration (only ensure_my_profile's body may change):" >&2; echo "$removed" >&2; exit 1; }
  expected_added="$(printf '%s\n' \
    "$ensure_acl" \
    "fn private.account_lifecycle_service_insert_fence() $owner=X/$owner" \
    "fn private.account_lifecycle_service_state_refusal(uuid,text) $owner=X/$owner" \
    "trg public.profiles account_lifecycle_profile_root_fence O" | LC_ALL=C sort)"
  [[ "$(norm <<<"$added" | LC_ALL=C sort)" == "$expected_added" ]] \
    || { echo "FAIL change: unexpected additions:" >&2; echo "$added" >&2; exit 1; }
  # md5 differs for the body of ensure_my_profile, same ACL: the grants did not move.
  [[ "$(psql_q "$db_exact" -c "select proowner::regrole::text || '/' || prosecdef from pg_proc where oid = 'public.ensure_my_profile()'::regprocedure")" == "$owner/true" ]] \
    || { echo "FAIL change: ensure_my_profile owner/definer" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_EXACT_CHANGE_PASS"

  if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply accepted" >&2; exit 1; fi
  grep -q 'COMMON_ACCOUNT_CORE_FENCE_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply reason: $out" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_REAPPLY_REFUSED_PASS"
else
  "${O[@]}" -f "$candidate" >/dev/null
fi

if want static; then
  code="$(sed -e 's/--.*$//' "$candidate")"
  flat="$(tr '\n' ' ' <<<"$code" | tr ';' '\n')"
  if grep -qiE '(^|[^a-z_])(insert[[:space:]]+into|update[[:space:]]+[a-z_]+\.|delete[[:space:]]+from|truncate|merge[[:space:]]+into)' <<<"$flat"; then
    echo "FAIL the candidate writes rows" >&2; exit 1
  fi
  [[ "$(grep -ciE '(^|[[:space:]])grant[[:space:]]' <<<"$flat")" == 1 ]] || { echo "FAIL the candidate must have exactly one grant" >&2; exit 1; }
  grep -qiE '^[[:space:]]*grant[[:space:]]+execute[[:space:]]+on[[:space:]]+function[[:space:]]+public\.ensure_my_profile\(\)[[:space:]]+to[[:space:]]+authenticated[[:space:]]*$' <<<"$flat" \
    || { echo "FAIL the one grant must be ensure_my_profile() to authenticated" >&2; exit 1; }
  if grep -qiE 'drop[[:space:]]+(table|function|view|trigger|policy|index|schema|column)|alter[[:space:]]+(table|function|default|schema|policy|role)|create[[:space:]]+(policy|table|view|role)|security[[:space:]]+invoker|disable[[:space:]]+trigger' <<<"$code"; then
    echo "FAIL the candidate drops, alters or creates something beyond its three objects and one replaced function" >&2; exit 1
  fi
  [[ "$(grep -ciE '^create function' <<<"$code")" == 2 && "$(grep -ciE '^create trigger' <<<"$code")" == 1 \
     && "$(grep -ciE '^create or replace function' <<<"$code")" == 1 ]] || { echo "FAIL object count" >&2; exit 1; }
  [[ "$(grep -ciE 'security definer set search_path = ' <<<"$code")" == 3 ]] || { echo "FAIL every function must be SECURITY DEFINER with an empty search_path" >&2; exit 1; }
  if grep -qiE 'release_gates|auth_delete_guard|enforc' <<<"$code"; then echo "FAIL the candidate touches the release gate or the guard mode" >&2; exit 1; fi
  if grep -qiE 'auth\.sessions|auth\.identities|auth\.admin|/auth/v1|deleteUser|storage\.|storage/v1|vault\.' <<<"$code"; then echo "FAIL the candidate reaches for GoTrue tables, Storage or Vault" >&2; exit 1; fi
  if grep -qiE 'for[[:space:]]+(no[[:space:]]+key[[:space:]]+)?update|for[[:space:]]+share|for[[:space:]]+key[[:space:]]+share' <<<"$code" \
     && ! grep -qiE 'for update' <<<"$code"; then echo "FAIL unexpected row lock form" >&2; exit 1; fi
  echo "COMMON_ACCOUNT_CORE_FENCE_STATIC_PASS"
fi

# Everything below runs on its own database copy.
R=(psql_o "$db_run")
RQ=(psql_q "$db_run")
"${R[@]}" -f "$candidate" >/dev/null
"${R[@]}" -f "$here/common_account_core_fence_fixture.sql" >/dev/null

if want behavior; then
  "${RQ[@]}" -f "$here/common_account_core_fence_behavior.sql" > "$tmp/behavior" 2>&1 || true
  grep -qx 'COMMON_ACCOUNT_CORE_FENCE_BEHAVIOR_PASS' "$tmp/behavior" || { echo "FAIL behavior" >&2; cat "$tmp/behavior" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_BEHAVIOR_PASS"
fi

uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
svc() { "${RQ[@]}" -c "begin; set local role service_role; $1; commit;"; }
person() {  # uid services... -> login, entitlements through the real start RPCs
  local u="$1"; shift
  "${RQ[@]}" -c "select public.fixture_login('$u'::uuid)" >/dev/null
  for s in "$@"; do
    "${RQ[@]}" -c "begin; set local request.jwt.claim.sub = '$u'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; select public.start_${s}_service(); commit;" >/dev/null
  done
}
claims() { echo "set local request.jwt.claim.sub = '$1'; set local request.jwt.claim.role = 'authenticated'; set local request.jwt.claim.session_id = '${2:-}';"; }
fenced() {  # uid [for_id] [isolation] -> the insert's error text (empty on success)
  "${RQ[@]}" -c "begin isolation level ${3:-read committed}; $(claims "$1") set local role authenticated; insert into public.fixture_fenced_rows (owner_id) values ('${2:-$1}'); commit;" 2>&1 || true
}
rows() { "${RQ[@]}" -c "select count(*) from public.fixture_fenced_rows where owner_id = '$1'"; }
profiles() { "${RQ[@]}" -c "select count(*) from public.profiles where id = '$1'"; }
version() { "${RQ[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$1'"; }
lock_waiters() {  # pattern -> number of backends of this database waiting on a lock while running it
  "${RQ[@]}" -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%$1%' and pid <> pg_backend_pid()"
}
now_s() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }

if want races; then
  [[ "$("${RQ[@]}" -c "select to_regclass('public.fixture_fenced_rows') is not null")" == t ]] || { echo "FAIL races: fixture missing" >&2; exit 1; }

  # R1. The deletion begins first (uncommitted, holding the account) when a write arrives: the write
  #     waits (observed), then sees the committed deletion and writes nothing.
  u="$(uid 801)"; person "$u" x_autopost; v="$(version "$u")"
  ( "${RQ[@]}" -c "begin; set local role service_role; select public.begin_common_account_deletion('$u'::uuid, $v); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.4
  ( fenced "$u" > "$tmp/r1" ) &
  writer=$!
  sleep 0.4
  waiting="$(lock_waiters fixture_fenced_rows)"
  wait "$holder"; wait "$writer"
  [[ "$waiting" == 1 && "$(cat "$tmp/r1")" == *ACCOUNT_DELETION_IN_PROGRESS* && "$(rows "$u")" == 0 ]] \
    || { echo "FAIL race begin-then-write: waiting=$waiting $(cat "$tmp/r1") rows=$(rows "$u")" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_BEGIN_THEN_WRITE_PASS"

  # R2. The write holds its transaction when the deletion begins: the deletion WAITS for it (observed),
  #     so the row is committed before the deletion exists; the next write is refused.
  u="$(uid 802)"; person "$u" x_autopost; v="$(version "$u")"
  ( "${RQ[@]}" -c "begin; $(claims "$u") set local role authenticated; insert into public.fixture_fenced_rows (owner_id) values ('$u'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.4
  ( svc "select public.begin_common_account_deletion('$u'::uuid, $v) ->> 'status'" > "$tmp/r2" ) &
  beginner=$!
  sleep 0.4
  waiting="$(lock_waiters begin_common_account_deletion)"
  wait "$holder"; wait "$beginner"
  [[ "$waiting" == 1 && "$(cat "$tmp/r2")" == started && "$(rows "$u")" == 1 ]] \
    || { echo "FAIL race write-then-begin: waiting=$waiting begin=$(cat "$tmp/r2") rows=$(rows "$u")" >&2; exit 1; }
  [[ "$(fenced "$u")" == *ACCOUNT_DELETION_IN_PROGRESS* && "$(rows "$u")" == 1 ]] || { echo "FAIL race write-then-begin: next write" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_WRITE_THEN_BEGIN_PASS"

  # R3. A long freeze: the write's wait is bounded and ends as a retryable code that wrote nothing.
  u="$(uid 803)"; person "$u" x_autopost; v="$(version "$u")"
  ( "${RQ[@]}" -c "begin; set local role service_role; select public.begin_common_account_deletion('$u'::uuid, $v); reset role; select pg_sleep(5.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.5
  t0="$(now_s)"
  # VERBOSITY=verbose shows the SQLSTATE: the documented retryable class is 55P03 (lock_not_available), not 42501.
  r="$("${RQ[@]}" -v VERBOSITY=verbose -c "begin; $(claims "$u") set local role authenticated; insert into public.fixture_fenced_rows (owner_id) values ('$u'); commit;" 2>&1 || true)"
  t1="$(now_s)"
  wait "$holder"
  elapsed="$(perl -e "printf '%.1f', $t1 - $t0")"
  [[ "$r" == *"55P03: ACCOUNT_LIFECYCLE_BUSY"* && "$(rows "$u")" == 0 ]] || { echo "FAIL race lock-timeout: expected 55P03 ACCOUNT_LIFECYCLE_BUSY, got: $r rows=$(rows "$u")" >&2; exit 1; }
  perl -e "exit(($elapsed >= 2.5 && $elapsed <= 4.8) ? 0 : 1)" || { echo "FAIL race lock-timeout: waited ${elapsed}s, expected about 3s" >&2; exit 1; }
  [[ "$(fenced "$u")" == *ACCOUNT_DELETION_IN_PROGRESS* ]] || { echo "FAIL race lock-timeout: after the freeze" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_BOUNDED_WAIT_PASS (waited ${elapsed}s)"

  # R4. The same through the Kabumori profile root: an old build's ensure_my_profile() in flight, then a freeze.
  u="$(uid 804)"; person "$u" kabumori
  "${RQ[@]}" -c "delete from public.profiles where id = '$u'" >/dev/null   # stand-in: the root is missing
  v="$(version "$u")"
  ( "${RQ[@]}" -c "begin; $(claims "$u") set local role authenticated; select public.ensure_my_profile(); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.4
  ( svc "select public.begin_common_account_deletion('$u'::uuid, $v) ->> 'status'" > "$tmp/r4" ) &
  beginner=$!
  sleep 0.4
  waiting="$(lock_waiters begin_common_account_deletion)"
  wait "$holder"; wait "$beginner"
  [[ "$waiting" == 1 && "$(cat "$tmp/r4")" == started && "$(profiles "$u")" == 1 ]] \
    || { echo "FAIL race profile-root: waiting=$waiting begin=$(cat "$tmp/r4") profiles=$(profiles "$u")" >&2; exit 1; }
  "${RQ[@]}" -c "delete from public.profiles where id = '$u'" >/dev/null   # the orchestrator's Kabumori step
  r="$("${RQ[@]}" -c "begin; $(claims "$u") set local role authenticated; select public.ensure_my_profile(); commit;" 2>&1 || true)"
  [[ "$r" == *ACCOUNT_DELETION_IN_PROGRESS* && "$(profiles "$u")" == 0 ]] || { echo "FAIL race profile-root: after the freeze: $r" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_PROFILE_ROOT_PASS"

  # R5. Double submit of the start: one account, one entitlement, one profile; exactly one 'started'.
  u="$(uid 805)"; "${RQ[@]}" -c "select public.fixture_login('$u'::uuid)" >/dev/null
  ( "${RQ[@]}" -c "begin; $(claims "$u") set local role authenticated; select public.start_kabumori_service() ->> 'started'; reset role; select pg_sleep(1.2); commit;" > "$tmp/r5a" ) &
  first=$!
  sleep 0.3
  ( "${RQ[@]}" -c "begin; $(claims "$u") set local role authenticated; select public.start_kabumori_service() ->> 'started'; commit;" > "$tmp/r5b" ) &
  second=$!
  wait "$first"; wait "$second"
  started="$(cat "$tmp/r5a" "$tmp/r5b" | grep -c '^true$' || true)"
  [[ "$started" == 1 && "$("${RQ[@]}" -c "select count(*) from public.common_accounts where user_id = '$u'")" == 1 \
     && "$("${RQ[@]}" -c "select count(*) from public.service_entitlements where user_id = '$u'")" == 1 && "$(profiles "$u")" == 1 ]] \
    || { echo "FAIL race double-submit: started=$started" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_DOUBLE_SUBMIT_PASS"

  # R6. Naming another person's id never queues on their account: answered at once while their account is locked.
  victim="$(uid 806)"; person "$victim" x_autopost; u="$(uid 807)"; person "$u" x_autopost
  ( "${RQ[@]}" -c "begin; $(claims "$victim") set local role authenticated; insert into public.fixture_fenced_rows (owner_id) values ('$victim'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.4
  t0="$(now_s)"
  r="$("${RQ[@]}" -c "begin; set local lock_timeout = '300ms'; $(claims "$u") set local role authenticated; insert into public.fixture_fenced_rows (owner_id) values ('$victim'); commit;" 2>&1 || true)"
  t1="$(now_s)"
  wait "$holder"
  [[ "$r" == *ACCOUNT_LIFECYCLE_AUTH_REQUIRED* && "$(rows "$victim")" == 1 && "$(rows "$u")" == 0 ]] || { echo "FAIL race foreign-id: $r" >&2; exit 1; }
  perl -e "exit((($t1 - $t0) < 1.0) ? 0 : 1)" || { echo "FAIL race foreign-id: it queued" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_FOREIGN_ID_REFUSED_WITHOUT_LOCKING_PASS"

  # R7. A POSTONA-only end begins first: the write waits on the entitlement and is refused; Kabumori is not affected.
  u="$(uid 808)"; person "$u" x_autopost kabumori
  ( "${RQ[@]}" -c "begin; set local role service_role; select public.begin_service_deletion('$u'::uuid, 'x_autopost'); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.4
  r="$(fenced "$u")"
  wait "$holder"
  [[ "$r" == *SERVICE_DELETION_IN_PROGRESS* && "$(rows "$u")" == 0 ]] || { echo "FAIL race service-deletion-then-write: $r" >&2; exit 1; }
  "${RQ[@]}" -c "delete from public.profiles where id = '$u'" >/dev/null
  r="$("${RQ[@]}" -c "begin; $(claims "$u") set local role authenticated; select public.ensure_my_profile(); commit;" 2>&1 || true)"
  [[ "$(profiles "$u")" == 1 ]] || { echo "FAIL race service-deletion: Kabumori is affected: $r" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_SERVICE_DELETION_THEN_WRITE_PASS"

  # R8. A login removal is uncommitted when the write arrives: it waits, then finds no login.
  u="$(uid 809)"; person "$u" x_autopost
  ( "${RQ[@]}" -c "begin; delete from auth.users where id = '$u'; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.4
  r="$(fenced "$u")"
  wait "$holder"
  [[ "$r" == *ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND* && "$(rows "$u")" == 0 ]] || { echo "FAIL race removal-then-write: $r" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_RACE_REMOVAL_THEN_WRITE_PASS"
fi

if want e2e; then
  # The real orchestrator (TypeScript, unmodified) against the real SQL of this database, through psql.
  ( cd "$here/../.." && CAL_E2E=1 PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$db_run" \
      deno test --no-config --no-check --allow-run=psql --allow-env --allow-read supabase/tests/common_account_phase4_e2e_test.ts ) > "$tmp/e2e" 2>&1 \
    || { echo "FAIL e2e" >&2; cat "$tmp/e2e" >&2; exit 1; }
  grep -q ' 4 passed | 0 failed' "$tmp/e2e" || { echo "FAIL e2e: expected 4 passed" >&2; cat "$tmp/e2e" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_E2E_PASS"
fi

if want failclosed; then
  u="$(uid 901)"; person "$u" x_autopost
  for iso in 'repeatable read' serializable; do
    [[ "$(fenced "$u" "$u" "$iso")" == *ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE* ]] || { echo "FAIL fail-closed: $iso accepted" >&2; exit 1; }
  done
  [[ "$(rows "$u")" == 0 ]] || { echo "FAIL fail-closed: something was written" >&2; exit 1; }
  r="$(fenced "$u")"
  [[ -z "$r" && "$(rows "$u")" == 1 ]] || { echo "FAIL fail-closed setup: the normal write does not work: [$r]" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_FAIL_CLOSED_ENV_PASS"
fi

if want rollback; then
  catalog > "$tmp/after_candidate"
  "${O[@]}" -f "$rollback_file" >/dev/null
  catalog > "$tmp/rolled_back_after"
  # The same catalog as before the candidate, apart from ensure_my_profile's body hash being the original's.
  diff <(grep -v '^fn public.ensure_my_profile()' "$tmp/before") <(grep -v '^fn public.ensure_my_profile()' "$tmp/rolled_back_after") >/dev/null \
    || { echo "FAIL rollback: catalog differs" >&2; diff "$tmp/before" "$tmp/rolled_back_after" >&2 || true; exit 1; }
  cmp -s <(grep '^fn public.ensure_my_profile()' "$tmp/before" | sed -E 's/ [0-9a-f]{32} / /') \
         <(grep '^fn public.ensure_my_profile()' "$tmp/rolled_back_after" | sed -E 's/ [0-9a-f]{32} / /') \
    || { echo "FAIL rollback: ensure_my_profile ACL changed" >&2; exit 1; }
  [[ "$(psql_q "$db_exact" -c "select prosecdef from pg_proc where oid = 'public.ensure_my_profile()'::regprocedure")" == f ]] \
    || { echo "FAIL rollback: ensure_my_profile is not the legacy invoker function again" >&2; exit 1; }
  if out="$("${O[@]}" -f "$rollback_file" 2>&1)"; then echo "FAIL rollback ran twice" >&2; exit 1; fi
  grep -q COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_NOT_APPLIED <<<"$out" || { echo "FAIL rollback reason: $out" >&2; exit 1; }
  "${O[@]}" -f "$candidate" >/dev/null
  echo "COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_PASS"

  # H4-P4-R2: another owner's insert fence is never removed (or opened) by this rollback. A DROP of the shared
  # function cannot succeed while a trigger depends on it, and DROP ... CASCADE would remove that owner's
  # protection: so the rollback takes back only what G5 attached (the profile trigger, the legacy bootstrap)
  # and keeps the shared functions, working, for as long as anything else uses them.
  "${S[@]}" -d postgres -c "create database $db_dep template $tpl owner $owner" >/dev/null
  psql_o "$db_dep" -f "$candidate" >/dev/null
  psql_o "$db_dep" -f "$here/common_account_core_fence_fixture.sql" >/dev/null   # a table of another owner with the fence attached
  RQ=(psql_q "$db_dep")
  D=(psql_o "$db_dep")
  u="$(uid 951)"; person "$u" x_autopost kabumori; v="$(version "$u")"
  "${RQ[@]}" -c "select public.fixture_login('$(uid 952)'::uuid)" >/dev/null
  if ! out="$("${D[@]}" -f "$rollback_file" 2>&1)"; then echo "FAIL rollback with another owner's trigger attached: $out" >&2; exit 1; fi
  [[ "$("${RQ[@]}" -c "select count(*) from pg_trigger where tgname = 'account_lifecycle_profile_root_fence' and not tgisinternal")" == 0 ]] \
    || { echo "FAIL rollback (dependents): the profile trigger is still there" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "select prosecdef from pg_proc where oid = 'public.ensure_my_profile()'::regprocedure")" == f ]] \
    || { echo "FAIL rollback (dependents): ensure_my_profile is not the legacy function" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "select to_regprocedure('private.account_lifecycle_service_insert_fence()') is not null and to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is not null")" == t ]] \
    || { echo "FAIL rollback (dependents): the shared functions were removed under another owner's trigger" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "select tgenabled from pg_trigger where tgname = 'fixture_fenced_rows_fence'")" == O ]] \
    || { echo "FAIL rollback (dependents): the other owner's trigger was changed" >&2; exit 1; }
  # The other owner's fence still refuses a write for a frozen account, and still allows an active one.
  [[ -z "$(fenced "$u")" && "$(rows "$u")" == 1 ]] || { echo "FAIL rollback (dependents): an active person's write" >&2; exit 1; }
  svc "select public.begin_common_account_deletion('$u'::uuid, $v) ->> 'status'" >/dev/null
  [[ "$(fenced "$u")" == *ACCOUNT_DELETION_IN_PROGRESS* && "$(rows "$u")" == 1 ]] \
    || { echo "FAIL rollback (dependents): the other owner's fence no longer refuses a frozen account" >&2; exit 1; }
  # The profile fence is gone by design (the legacy window is back): a login with no entitlement can insert one.
  r="$("${RQ[@]}" -c "begin; $(claims "$(uid 952)") set local role authenticated; insert into public.profiles (id) values ('$(uid 952)'); commit;" 2>&1 || true)"
  [[ -z "$r" && "$(profiles "$(uid 952)")" == 1 ]] || { echo "FAIL rollback (dependents): the legacy profile insert is not restored: [$r]" >&2; exit 1; }
  # Re-running changes nothing and still succeeds; the shared functions stay while the trigger exists.
  "${D[@]}" -f "$rollback_file" >/dev/null 2>&1 || { echo "FAIL rollback (dependents): not repeatable" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "select to_regprocedure('private.account_lifecycle_service_insert_fence()') is not null")" == t ]] \
    || { echo "FAIL rollback (dependents): a repeat removed the shared functions" >&2; exit 1; }
  # The other owner detaches its own trigger (its reviewed step); the next run removes the shared functions.
  "${RQ[@]}" -c "drop trigger fixture_fenced_rows_fence on public.fixture_fenced_rows" >/dev/null
  "${D[@]}" -f "$rollback_file" >/dev/null 2>&1 || { echo "FAIL rollback (dependents): the final run" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "select to_regprocedure('private.account_lifecycle_service_insert_fence()') is null and to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is null")" == t ]] \
    || { echo "FAIL rollback (dependents): the shared functions remain after the last dependent left" >&2; exit 1; }
  # Nothing left to roll back: refused as not applied; and the candidate can be applied again.
  if out="$("${D[@]}" -f "$rollback_file" 2>&1)"; then echo "FAIL rollback (dependents): ran with nothing applied" >&2; exit 1; fi
  grep -q COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_NOT_APPLIED <<<"$out" || { echo "FAIL rollback (dependents) reason: $out" >&2; exit 1; }
  "${D[@]}" -f "$candidate" >/dev/null || { echo "FAIL rollback (dependents): re-apply" >&2; exit 1; }
  # Another owner's FUNCTION that calls the decision (PostgreSQL does not track calls in function bodies):
  # found by the source scan, so the shared functions are kept for it too.
  "${RQ[@]}" -c "create function public.fixture_other_owner_writer() returns text language plpgsql security definer set search_path = ''
                 as \$f\$ begin return private.account_lifecycle_service_state_refusal('$u'::uuid, 'x_autopost'); end \$f\$" >/dev/null
  "${D[@]}" -f "$rollback_file" >/dev/null 2>&1 || { echo "FAIL rollback (function caller): the run" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "select to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is not null and to_regprocedure('private.account_lifecycle_service_insert_fence()') is not null")" == t ]] \
    || { echo "FAIL rollback (function caller): the shared functions were removed under another owner's function" >&2; exit 1; }
  "${RQ[@]}" -c "drop function public.fixture_other_owner_writer()" >/dev/null
  "${D[@]}" -f "$rollback_file" >/dev/null 2>&1 || { echo "FAIL rollback (function caller): the final run" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "select to_regprocedure('private.account_lifecycle_service_state_refusal(uuid,text)') is null and to_regprocedure('private.account_lifecycle_service_insert_fence()') is null")" == t ]] \
    || { echo "FAIL rollback (function caller): the shared functions remain" >&2; exit 1; }
  echo "COMMON_ACCOUNT_CORE_FENCE_ROLLBACK_DEPENDENTS_PASS"
fi

echo "COMMON_ACCOUNT_CORE_FENCE_ALL_PASS"
