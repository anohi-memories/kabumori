#!/usr/bin/env bash
# Disposable-only proof runner for 20261012230000_common_account_service_brand_state (common account Phase 5,
# F5: the service entitlement seen from a workspace, for workers with no person's session). Builds the
# lifecycle suites' production-shaped baseline (fixtures, the real onboarding and social-mobile deletion
# migrations, Phase 1, Phase 2, Phase 3a, the Phase 3b guard, the Phase 4 fence) on a LOCAL Unix-socket
# PostgreSQL, applies the candidate as a non-superuser owner and proves: preflight refusals, the exact schema
# change (four functions, ACLs), refused re-apply, static source rules, the behavior suite (decision
# equivalence with the Phase 4 locking decision in every state), two-session races (the ordering variant
# against a freeze; the predicate never blocks) and the dependency-aware rollback. Fake data only.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_brand_state_run.sh
# Optional: CAL_BRAND_STATE_CANDIDATE=<file> (mutation runs), CAL_BRAND_STATE_SECTIONS=behavior,races,...
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${CAL_BRAND_STATE_CANDIDATE:-$migrations/20261012230000_common_account_service_brand_state.sql}"
rollback_file="${CAL_BRAND_STATE_ROLLBACK:-$here/common_account_brand_state_rollback.sql}"
sections="${CAL_BRAND_STATE_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
owner="kb_cal_brand_state_owner"
tag="$$"
tpl_pre="kabumori_cal_bs_pre_$tag"
tpl="kabumori_cal_bs_tpl_$tag"
db_exact="kabumori_cal_bs_exact_$tag"
db_run="kabumori_cal_bs_run_$tag"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
psql_o() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
psql_q() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
tmp="$(mktemp -d /private/tmp/kabumori-cal-brand-state.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  for d in "$db_run" "$db_exact" "$tpl" "$tpl_pre"; do
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
"${P[@]}" -f "$migrations/20261010051938_common_account_service_write_guard.sql" >/dev/null
"${S[@]}" -d postgres -c "create database $tpl template $tpl_pre owner $owner" >/dev/null
psql_o "$tpl" -f "$migrations/20261012130000_common_account_core_service_fence.sql" >/dev/null
echo "COMMON_ACCOUNT_BRAND_STATE_BASELINE_READY"

"${S[@]}" -d postgres -c "create database $db_exact template $tpl owner $owner" >/dev/null
"${S[@]}" -d postgres -c "create database $db_run template $tpl owner $owner" >/dev/null
O=(psql_o "$db_exact")

has_new_objects() {
  psql_q "$1" -c "select exists (select 1 from pg_proc where proname in ('account_lifecycle_brand_owner', 'account_lifecycle_service_state_readonly',
                                                                      'account_lifecycle_assert_brand_service_active', 'common_account_brand_service_state'))"
}
refused_with() {  # database code -> the candidate is refused with it and leaves nothing behind
  local out
  if out="$(psql_o "$1" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted: expected $2" >&2; exit 1; fi
  grep -q "$2" <<<"$out" || { echo "FAIL preflight reason (expected $2): $out" >&2; exit 1; }
  [[ "$(has_new_objects "$1")" == f ]] || { echo "FAIL preflight left objects ($2)" >&2; exit 1; }
}

if want preflight; then
  "${S[@]}" -d postgres -c "create database kabumori_cal_bs_pf_$tag template $tpl_pre owner $owner" >/dev/null
  refused_with "kabumori_cal_bs_pf_$tag" COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_FOUNDATION_MISSING   # no Phase 4 decision
  "${S[@]}" -d postgres -c "drop database kabumori_cal_bs_pf_$tag with (force)" >/dev/null
  "${S[@]}" -d postgres -c "create database kabumori_cal_bs_pf_$tag template $tpl owner $owner" >/dev/null
  psql_q "kabumori_cal_bs_pf_$tag" -c "alter table public.brand_memberships rename column role to role_moved" >/dev/null
  refused_with "kabumori_cal_bs_pf_$tag" COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_BRAND_SHAPE
  psql_q "kabumori_cal_bs_pf_$tag" -c "alter table public.brand_memberships rename column role_moved to role" >/dev/null
  "${S[@]}" -d "kabumori_cal_bs_pf_$tag" -c "grant execute on function private.account_lifecycle_service_state_refusal(uuid,text) to service_role" >/dev/null
  refused_with "kabumori_cal_bs_pf_$tag" COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_DECISION_ACL_CHANGED
  "${S[@]}" -d postgres -c "drop database kabumori_cal_bs_pf_$tag with (force)" >/dev/null
  echo "COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_PASS"
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
order by 1;
SQL
}

if want exact; then
  catalog > "$tmp/before"
  sed -e 's/^commit;$/rollback;/' "$candidate" > "$tmp/rolled_back.sql"
  [[ "$(grep -c '^rollback;$' "$tmp/rolled_back.sql")" == 1 ]] || { echo "FAIL rollback copy" >&2; exit 1; }
  "${O[@]}" -f "$tmp/rolled_back.sql" >/dev/null
  catalog > "$tmp/rolled_back"
  cmp -s "$tmp/before" "$tmp/rolled_back" || { echo "FAIL transaction rollback: the catalog changed" >&2; exit 1; }
  "${O[@]}" -f "$candidate" >/dev/null
  catalog > "$tmp/after"
  removed="$(comm -23 "$tmp/before" "$tmp/after")"
  added="$(comm -13 "$tmp/before" "$tmp/after")"
  [[ -z "$removed" ]] || { echo "FAIL change: unexpected removal/alteration:" >&2; echo "$removed" >&2; exit 1; }
  expected="$(printf '%s\n' \
    "fn private.account_lifecycle_assert_brand_service_active(text,text) $owner=X/$owner" \
    "fn private.account_lifecycle_brand_owner(text) $owner=X/$owner" \
    "fn private.account_lifecycle_service_state_readonly(uuid,text) $owner=X/$owner" \
    "fn public.common_account_brand_service_state(text,text) $owner=X/$owner,service_role=X/$owner" | LC_ALL=C sort)"
  [[ "$(sed -E 's/^(fn [^ ]+) [0-9a-f]{32} /\1 /' <<<"$added" | LC_ALL=C sort)" == "$expected" ]] \
    || { echo "FAIL change: unexpected additions:" >&2; echo "$added" >&2; exit 1; }
  echo "COMMON_ACCOUNT_BRAND_STATE_EXACT_CHANGE_PASS"
  if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply accepted" >&2; exit 1; fi
  grep -q 'COMMON_ACCOUNT_BRAND_STATE_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply reason: $out" >&2; exit 1; }
  echo "COMMON_ACCOUNT_BRAND_STATE_REAPPLY_REFUSED_PASS"
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
  if grep -qiE 'create[[:space:]]+or[[:space:]]+replace|drop[[:space:]]+(table|function|view|trigger|policy|index|schema|column)|alter[[:space:]]+(table|function|default|schema|policy|role)|create[[:space:]]+(trigger|policy|table|view|role)|security[[:space:]]+invoker' <<<"$code"; then
    echo "FAIL the candidate changes something beyond its four functions" >&2; exit 1
  fi
  [[ "$(grep -ciE '^create function' <<<"$code")" == 4 && "$(grep -ciE 'security definer set search_path = ' <<<"$code")" == 4 ]] \
    || { echo "FAIL four definer functions with an empty search_path" >&2; exit 1; }
  # Only the ordering variant may lock: the other three are plain reads.
  locks="$(grep -ciE 'for[[:space:]]+(no[[:space:]]+key[[:space:]]+)?update|for[[:space:]]+(key[[:space:]]+)?share' <<<"$code" || true)"
  [[ "$locks" == 0 ]] || { echo "FAIL a row lock appears in the candidate (the locking is the Phase 4 decision's)" >&2; exit 1; }
  if grep -qiE 'auth\.sessions|auth\.identities|auth\.admin|storage\.|vault\.' <<<"$code"; then echo "FAIL the candidate reaches for GoTrue tables, Storage or Vault" >&2; exit 1; fi
  echo "COMMON_ACCOUNT_BRAND_STATE_STATIC_PASS"
fi

R=(psql_o "$db_run")
RQ=(psql_q "$db_run")
"${R[@]}" -f "$candidate" >/dev/null

if want behavior; then
  "${RQ[@]}" -f "$here/common_account_brand_state_behavior.sql" > "$tmp/behavior" 2>&1 || true
  grep -qx 'COMMON_ACCOUNT_BRAND_STATE_BEHAVIOR_PASS' "$tmp/behavior" || { echo "FAIL behavior" >&2; cat "$tmp/behavior" >&2; exit 1; }
  echo "COMMON_ACCOUNT_BRAND_STATE_BEHAVIOR_PASS"
fi

uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
svc() { "${RQ[@]}" -c "begin; set local role service_role; $1; commit;"; }
person() {  # uid services... -> login, entitlements through the real start RPCs, and the person's own workspace
  local u="$1"; shift
  "${RQ[@]}" -c "select public.fixture_login('$u'::uuid)" >/dev/null
  for s in "$@"; do
    "${RQ[@]}" -c "begin; set local request.jwt.claim.sub = '$u'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; select public.start_${s}_service(); commit;" >/dev/null
  done
  "${RQ[@]}" -c "insert into public.brands (id, code_profile_key) values (public.social_mobile_account_deletion_workspace('$u'::uuid), 'social_mobile_user_v1') on conflict do nothing;
                 insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace('$u'::uuid), '$u'::uuid, 'owner') on conflict do nothing" >/dev/null
}
ws() { "${RQ[@]}" -c "select public.social_mobile_account_deletion_workspace('$1'::uuid)"; }
version() { "${RQ[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$1'"; }
lock_waiters() {
  "${RQ[@]}" -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%$1%' and pid <> pg_backend_pid()"
}
now_s() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }

if want races; then
  # R1. A freeze holds the account: the ORDERING variant waits (observed) and then refuses; the advisory
  #     predicate does not wait and answers from the committed state (it orders nothing, by design).
  u="$(uid 801)"; person "$u" x_autopost; v="$(version "$u")"; b="$(ws "$u")"
  ( "${RQ[@]}" -c "begin; set local role service_role; select public.begin_common_account_deletion('$u'::uuid, $v); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.4
  t0="$(now_s)"
  adv="$("${RQ[@]}" -c "begin; set local role service_role; select public.common_account_brand_service_state('$b', 'x_autopost'); commit;" 2>&1 || true)"
  t1="$(now_s)"
  ( "${RQ[@]}" -c "begin; select private.account_lifecycle_assert_brand_service_active('$b', 'x_autopost'); commit;" > "$tmp/r1" 2>&1 || true ) &
  writer=$!
  sleep 0.4
  waiting="$(lock_waiters account_lifecycle_assert_brand_service_active)"
  wait "$holder"; wait "$writer"
  [[ "$adv" == active ]] || { echo "FAIL race: the advisory predicate should answer the committed state while a freeze is uncommitted, got: $adv" >&2; exit 1; }
  perl -e "exit((($t1 - $t0) < 1.0) ? 0 : 1)" || { echo "FAIL race: the advisory predicate waited" >&2; exit 1; }
  [[ "$waiting" == 1 && "$(cat "$tmp/r1")" == *ACCOUNT_DELETION_IN_PROGRESS* ]] \
    || { echo "FAIL race freeze-then-assert: waiting=$waiting $(cat "$tmp/r1")" >&2; exit 1; }
  [[ "$("${RQ[@]}" -c "begin; set local role service_role; select public.common_account_brand_service_state('$b', 'x_autopost'); commit;")" == ACCOUNT_DELETION_IN_PROGRESS ]] \
    || { echo "FAIL race: after the freeze the predicate must refuse" >&2; exit 1; }
  echo "COMMON_ACCOUNT_BRAND_STATE_RACE_FREEZE_PASS"

  # R2. The ordering variant holds its locks: a freeze that arrives WAITS for it (observed), so the writer's
  #     authority change commits before any deletion exists.
  u="$(uid 802)"; person "$u" x_autopost; v="$(version "$u")"; b="$(ws "$u")"
  ( "${RQ[@]}" -c "begin; select private.account_lifecycle_assert_brand_service_active('$b', 'x_autopost'); select pg_sleep(1.5); commit;" >/dev/null 2>&1 ) &
  holder=$!
  sleep 0.4
  ( svc "select public.begin_common_account_deletion('$u'::uuid, $v) ->> 'status'" > "$tmp/r2" ) &
  beginner=$!
  sleep 0.4
  waiting="$(lock_waiters begin_common_account_deletion)"
  wait "$holder"; wait "$beginner"
  [[ "$waiting" == 1 && "$(cat "$tmp/r2")" == started ]] || { echo "FAIL race assert-then-freeze: waiting=$waiting $(cat "$tmp/r2")" >&2; exit 1; }
  echo "COMMON_ACCOUNT_BRAND_STATE_RACE_ASSERT_THEN_FREEZE_PASS"

  # R3. A long freeze: the ordering variant's wait ends as a retryable 55P03 after about 3 s, nothing held.
  u="$(uid 803)"; person "$u" x_autopost; v="$(version "$u")"; b="$(ws "$u")"
  ( "${RQ[@]}" -c "begin; set local role service_role; select public.begin_common_account_deletion('$u'::uuid, $v); reset role; select pg_sleep(5.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.5
  t0="$(now_s)"
  r="$("${RQ[@]}" -v VERBOSITY=verbose -c "begin; select private.account_lifecycle_assert_brand_service_active('$b', 'x_autopost'); commit;" 2>&1 || true)"
  t1="$(now_s)"
  wait "$holder"
  elapsed="$(perl -e "printf '%.1f', $t1 - $t0")"
  [[ "$r" == *"55P03: ACCOUNT_LIFECYCLE_BUSY"* ]] || { echo "FAIL race bounded wait: expected 55P03 ACCOUNT_LIFECYCLE_BUSY, got: $r" >&2; exit 1; }
  perl -e "exit(($elapsed >= 2.5 && $elapsed <= 4.8) ? 0 : 1)" || { echo "FAIL race bounded wait: waited ${elapsed}s" >&2; exit 1; }
  echo "COMMON_ACCOUNT_BRAND_STATE_RACE_BOUNDED_WAIT_PASS (waited ${elapsed}s)"
fi

if want rollback; then
  "${O[@]}" -f "$rollback_file" >/dev/null
  [[ "$(has_new_objects "$db_exact")" == f ]] || { echo "FAIL rollback: functions remain" >&2; exit 1; }
  catalog > "$tmp/rolled_back_after"
  cmp -s "$tmp/before" "$tmp/rolled_back_after" || { echo "FAIL rollback: the catalog differs from before the candidate" >&2; diff "$tmp/before" "$tmp/rolled_back_after" >&2 || true; exit 1; }
  if out="$("${O[@]}" -f "$rollback_file" 2>&1)"; then echo "FAIL rollback ran twice" >&2; exit 1; fi
  grep -q COMMON_ACCOUNT_BRAND_STATE_ROLLBACK_NOT_APPLIED <<<"$out" || { echo "FAIL rollback reason: $out" >&2; exit 1; }
  "${O[@]}" -f "$candidate" >/dev/null || { echo "FAIL rollback: re-apply" >&2; exit 1; }
  # A POSTONA worker function that calls the predicate (untracked by PostgreSQL): the rollback keeps the functions.
  psql_q "$db_exact" -c "create function public.fixture_worker_predicate(p_brand text) returns text language sql stable security invoker set search_path = ''
                         as \$f\$ select public.common_account_brand_service_state(p_brand, 'x_autopost') \$f\$" >/dev/null
  "${O[@]}" -f "$rollback_file" >/dev/null 2>&1 || { echo "FAIL rollback (caller): the run" >&2; exit 1; }
  [[ "$(has_new_objects "$db_exact")" == t ]] || { echo "FAIL rollback (caller): the functions were removed under another function" >&2; exit 1; }
  psql_q "$db_exact" -c "drop function public.fixture_worker_predicate(text)" >/dev/null
  "${O[@]}" -f "$rollback_file" >/dev/null 2>&1 || { echo "FAIL rollback (caller): the final run" >&2; exit 1; }
  [[ "$(has_new_objects "$db_exact")" == f ]] || { echo "FAIL rollback (caller): the functions remain after the caller left" >&2; exit 1; }
  echo "COMMON_ACCOUNT_BRAND_STATE_ROLLBACK_PASS"
fi

echo "COMMON_ACCOUNT_BRAND_STATE_ALL_PASS"
