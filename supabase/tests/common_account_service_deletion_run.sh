#!/usr/bin/env bash
# Disposable-only proof runner for 20261013120000_common_account_service_deletion_ownership (common account
# Phase 6, F5: the owner lease for the POSTONA-only service deletion, the durable provider results and the
# acknowledgement). Builds the lifecycle suites' production-shaped baseline (fixtures, the real onboarding and
# social-mobile deletion migrations, Phase 1, Phase 2, Phase 3a, the Phase 3b guard, the Phase 4 fence, the
# Phase 5 workspace state) on a LOCAL Unix-socket PostgreSQL, applies the candidate as a non-superuser owner and
# proves: preflight refusals, the exact schema change, refused re-apply, static source rules, the behavior suite,
# two-session races (a lease that ends while the finish waits for a lock; two claims; a freeze) and the rollback
# (and a re-apply after it). Fake data only.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_service_deletion_run.sh
# Optional: CAL_SERVICE_DELETION_CANDIDATE=<file> (mutation runs), CAL_SERVICE_DELETION_SECTIONS=behavior,races,...
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${CAL_SERVICE_DELETION_CANDIDATE:-$migrations/20261013120000_common_account_service_deletion_ownership.sql}"
rollback_file="${CAL_SERVICE_DELETION_ROLLBACK:-$here/common_account_service_deletion_rollback.sql}"
sections="${CAL_SERVICE_DELETION_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
owner="kb_cal_svc_del_owner"
tag="$$"
tpl_pre="kabumori_cal_sd_pre_$tag"
tpl="kabumori_cal_sd_tpl_$tag"
db_exact="kabumori_cal_sd_exact_$tag"
db_run="kabumori_cal_sd_run_$tag"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
psql_o() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
psql_q() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
tmp="$(mktemp -d /private/tmp/kabumori-cal-svc-del.XXXXXX)"
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
"${S[@]}" -d postgres -c "create database $tpl template $tpl_pre owner $owner" >/dev/null
for f in 20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state; do
  psql_o "$tpl" -f "$migrations/$f.sql" >/dev/null
done
echo "COMMON_ACCOUNT_SERVICE_DELETION_BASELINE_READY"

"${S[@]}" -d postgres -c "create database $db_exact template $tpl owner $owner" >/dev/null
"${S[@]}" -d postgres -c "create database $db_run template $tpl owner $owner" >/dev/null
O=(psql_o "$db_exact")

has_new_objects() {
  psql_q "$1" -c "select to_regprocedure('public.finish_owned_service_deletion(uuid,text,uuid,uuid)') is not null"
}
refused_with() {  # database code -> the candidate is refused with it and leaves nothing behind
  local out
  if out="$(psql_o "$1" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted: expected $2" >&2; exit 1; fi
  grep -q "$2" <<<"$out" || { echo "FAIL preflight reason (expected $2): $out" >&2; exit 1; }
  [[ "$(has_new_objects "$1")" == f ]] || { echo "FAIL preflight left objects ($2)" >&2; exit 1; }
}

if want preflight; then
  d="kabumori_cal_sd_pf_$tag"
  # A legacy body that is not the Phase 1 original: refused (the replacement would silently change behavior).
  "${S[@]}" -d postgres -c "create database $d template $tpl owner $owner" >/dev/null
  psql_q "$d" -c "create or replace function public.abort_service_deletion(p_user_id uuid, p_service_key text, p_operation_id uuid) returns jsonb language sql security definer set search_path = '' as \$f\$ select '{}'::jsonb \$f\$" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_LEGACY_DRIFT
  "${S[@]}" -d postgres -c "drop database $d with (force)" >/dev/null
  # No Phase 3a ownership functions: refused.
  "${S[@]}" -d postgres -c "create database $d template $tpl owner $owner" >/dev/null
  psql_q "$d" -c "drop function public.release_common_account_deletion_claim(uuid, uuid, uuid); drop function public.renew_common_account_deletion_claim(uuid, uuid, uuid, integer)" >/dev/null
  psql_q "$d" -c "alter function private.account_lifecycle_owned_operation(uuid,uuid,uuid) rename to account_lifecycle_owned_operation_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_FOUNDATION_MISSING
  "${S[@]}" -d postgres -c "drop database $d with (force)" >/dev/null
  # Release order (Phase 7): without the Phase 4 state decision, or without the Phase 5 workspace-owner state, refused.
  "${S[@]}" -d postgres -c "create database $d template $tpl owner $owner" >/dev/null
  psql_q "$d" -c "alter function public.common_account_brand_service_state(text,text) rename to common_account_brand_service_state_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_BRAND_STATE_MISSING
  "${S[@]}" -d postgres -c "drop database $d with (force)" >/dev/null
  "${S[@]}" -d postgres -c "create database $d template $tpl owner $owner" >/dev/null
  psql_q "$d" -c "alter function private.account_lifecycle_service_state_refusal(uuid,text) rename to account_lifecycle_service_state_refusal_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_CORE_FENCE_MISSING
  "${S[@]}" -d postgres -c "drop database $d with (force)" >/dev/null
  echo "COMMON_ACCOUNT_SERVICE_DELETION_PREFLIGHT_PASS"
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
  "${O[@]}" -f "$tmp/rolled_back.sql" >/dev/null 2>&1
  catalog > "$tmp/rolled_back"
  cmp -s "$tmp/before" "$tmp/rolled_back" || { echo "FAIL transaction rollback: the catalog changed" >&2; exit 1; }
  "${O[@]}" -f "$candidate" >/dev/null 2>&1
  catalog > "$tmp/after"
  norm() { sed -E 's/^(fn [^ ]+) [0-9a-f]{32} /\1 /'; }
  removed="$(comm -23 "$tmp/before" "$tmp/after" | norm | LC_ALL=C sort)"
  added="$(comm -13 "$tmp/before" "$tmp/after" | norm | LC_ALL=C sort)"
  # Removed: only the two replaced legacy bodies (same name and ACL, new body) and the old scope constraint.
  expected_removed="$(grep -E '^(fn public\.(finish|abort)_service_deletion\(uuid,text,uuid\) )|^con private\.account_lifecycle_operations account_lifecycle_operations_owner_scope ' "$tmp/before" | norm | LC_ALL=C sort)"
  [[ "$removed" == "$expected_removed" && "$(wc -l <<<"$removed" | tr -d ' ')" == 3 ]] \
    || { echo "FAIL change: unexpected removal/alteration:" >&2; echo "$removed" >&2; exit 1; }
  fns="$(grep '^fn ' <<<"$added" | cut -d' ' -f2)"
  expected_fns="$(printf '%s\n' \
    'private.account_lifecycle_abort_service_deletion(uuid,text,uuid)' 'private.account_lifecycle_cleanup_authorized(uuid)' \
    'private.account_lifecycle_finish_service_deletion(uuid,text,uuid)' 'private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid)' \
    'public.abort_owned_service_deletion(uuid,text,uuid,uuid)' 'public.abort_service_deletion(uuid,text,uuid)' \
    'public.acknowledge_owned_remote_unverified(uuid,text,uuid,uuid,text[])' 'public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)' \
    'public.common_account_provider_snapshot(uuid)' 'public.finish_owned_service_deletion(uuid,text,uuid,uuid)' \
    'public.finish_service_deletion(uuid,text,uuid)' 'public.record_owned_service_deletion_provider_result(uuid,text,uuid,uuid,text,text)' \
    'public.release_service_deletion_claim(uuid,text,uuid,uuid)' 'public.renew_service_deletion_claim(uuid,text,uuid,uuid,integer)' | LC_ALL=C sort)"
  [[ "$(LC_ALL=C sort <<<"$fns")" == "$expected_fns" ]] || { echo "FAIL change: unexpected functions:" >&2; echo "$fns" >&2; exit 1; }
  # Added besides functions: exactly the three columns and the three constraints.
  others="$(grep -v '^fn ' <<<"$added" | cut -d' ' -f1-3 | LC_ALL=C sort)"
  expected_others="$(printf '%s\n' \
    'col private.account_lifecycle_operations.provider_results jsonb' \
    'col private.account_lifecycle_operations.remote_unverified_ack_at timestamp' \
    'col private.account_lifecycle_operations.remote_unverified_ack_providers text[]' \
    'con private.account_lifecycle_operations account_lifecycle_operations_ack_shape' \
    'con private.account_lifecycle_operations account_lifecycle_operations_owner_scope' \
    'con private.account_lifecycle_operations account_lifecycle_operations_provider_results_shape' | LC_ALL=C sort)"
  [[ "$others" == "$expected_others" ]] || { echo "FAIL change: unexpected additions:" >&2; echo "$others" >&2; exit 1; }
  echo "COMMON_ACCOUNT_SERVICE_DELETION_EXACT_CHANGE_PASS"
  if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply accepted" >&2; exit 1; fi
  grep -q 'COMMON_ACCOUNT_SERVICE_OWNERSHIP_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply reason: $out" >&2; exit 1; }
  echo "COMMON_ACCOUNT_SERVICE_DELETION_REAPPLY_REFUSED_PASS"
else
  "${O[@]}" -f "$candidate" >/dev/null 2>&1
fi

if want static; then
  code="$(sed -e 's/--.*$//' "$candidate")"
  flat="$(tr '\n' ' ' <<<"$code" | tr ';' '\n')"
  if grep -qiE 'auth\.sessions|auth\.identities|auth\.admin|storage\.|vault\.|/auth/v1' <<<"$code"; then echo "FAIL the candidate reaches for GoTrue tables, Storage or Vault" >&2; exit 1; fi
  if grep -qiE '(^|[[:space:]])cascade([[:space:]]|;|$)' <<<"$flat"; then echo "FAIL CASCADE appears" >&2; exit 1; fi
  if grep -qiE 'security[[:space:]]+invoker|delete[[:space:]]+from|truncate|drop[[:space:]]+(table|schema|column|trigger|policy)' <<<"$code"; then echo "FAIL unexpected statement" >&2; exit 1; fi
  # Every function is a definer with an empty search_path.
  n_fn="$(grep -ciE '^create (or replace )?function' <<<"$code")"
  n_ok="$(grep -ciE 'security definer set search_path = ' <<<"$code")"
  [[ "$n_fn" == "$n_ok" && "$n_fn" -ge 14 ]] || { echo "FAIL every function must be SECURITY DEFINER with an empty search_path ($n_fn/$n_ok)" >&2; exit 1; }
  # No grant to an API role other than service_role.
  if grep -iE '^[[:space:]]*grant[[:space:]]' <<<"$code" | grep -viE 'to service_role;' >/dev/null; then echo "FAIL a grant to something other than service_role" >&2; exit 1; fi
  echo "COMMON_ACCOUNT_SERVICE_DELETION_STATIC_PASS"
fi

R=(psql_o "$db_run")
RQ=(psql_q "$db_run")
"${R[@]}" -f "$candidate" >/dev/null 2>&1

if want behavior; then
  "${RQ[@]}" -f "$here/common_account_service_deletion_behavior.sql" > "$tmp/behavior" 2>&1 || true
  grep -qx 'COMMON_ACCOUNT_SERVICE_DELETION_BEHAVIOR_PASS' "$tmp/behavior" || { echo "FAIL behavior" >&2; cat "$tmp/behavior" >&2; exit 1; }
  echo "COMMON_ACCOUNT_SERVICE_DELETION_BEHAVIOR_PASS"
fi

uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
svc() { "${RQ[@]}" -c "begin; set local role service_role; $1; commit;"; }
person() {  # n -> starts POSTONA through the real start RPC, and creates the person's workspace
  local u; u="$(uid "$1")"
  "${RQ[@]}" -c "select public.fixture_login('$u'::uuid)" >/dev/null
  "${RQ[@]}" -c "begin; set local request.jwt.claim.sub = '$u'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; select public.start_x_autopost_service(); commit;" >/dev/null
  "${RQ[@]}" -c "insert into public.brands (id, code_profile_key) values (public.social_mobile_account_deletion_workspace('$u'::uuid), 'social_mobile_user_v1') on conflict do nothing;
                 insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace('$u'::uuid), '$u'::uuid, 'owner') on conflict do nothing" >/dev/null
}
begin_op() { svc "select public.begin_service_deletion('$1'::uuid, 'x_autopost') ->> 'operation_id'"; }
claim() { svc "select public.claim_service_deletion('$1'::uuid, 'x_autopost', '$2'::uuid) ->> 'lease'"; }
status() { "${RQ[@]}" -c "select status from public.service_entitlements where user_id = '$1' and service_key = 'x_autopost'"; }
lock_waiters() {
  "${RQ[@]}" -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%$1%' and pid <> pg_backend_pid()"
}

if want races; then
  # R1. The lease ends WHILE the finish waits for the account lock: nothing is ended (after-await verification
  #     on the wall clock; a transaction-start check would pass).
  u="$(uid 801)"; person 801; op="$(begin_op "$u")"; lease="$(claim "$u" "$op")"
  svc "select public.record_owned_service_deletion_provider_result('$u'::uuid, 'x_autopost', '$op'::uuid, '$lease'::uuid, 'x', 'done')" >/dev/null
  "${RQ[@]}" -c "delete from public.brand_memberships where brand_id = public.social_mobile_account_deletion_workspace('$u'::uuid); delete from public.brands where id = public.social_mobile_account_deletion_workspace('$u'::uuid)" >/dev/null
  "${RQ[@]}" -c "update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '900 milliseconds' where id = '$op'" >/dev/null
  ( "${RQ[@]}" -c "begin; update public.common_accounts set status = status where user_id = '$u'; select pg_sleep(1.6); commit;" >/dev/null ) &
  holder=$!
  sleep 0.3
  ( svc "select public.finish_owned_service_deletion('$u'::uuid, 'x_autopost', '$op'::uuid, '$lease'::uuid) ->> 'status'" > "$tmp/r1" ) &
  finisher=$!
  sleep 0.4
  waiting="$(lock_waiters finish_owned_service_deletion)"
  wait "$holder"; wait "$finisher"
  [[ "$waiting" == 1 && "$(cat "$tmp/r1")" == lease_lost && "$(status "$u")" == deleting ]] \
    || { echo "FAIL race lease-ends-while-waiting: waiting=$waiting answer=$(cat "$tmp/r1") status=$(status "$u")" >&2; exit 1; }
  echo "COMMON_ACCOUNT_SERVICE_DELETION_RACE_LEASE_ENDS_WHILE_WAITING_PASS"

  # R2. Two claims race for an ended lease: exactly one acquires; the fence moves once.
  u="$(uid 802)"; person 802; op="$(begin_op "$u")"; claim "$u" "$op" >/dev/null
  "${RQ[@]}" -c "update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second' where id = '$op'" >/dev/null
  ( svc "select public.claim_service_deletion('$u'::uuid, 'x_autopost', '$op'::uuid) ->> 'status'" > "$tmp/r2a" ) &
  one=$!
  ( svc "select public.claim_service_deletion('$u'::uuid, 'x_autopost', '$op'::uuid) ->> 'status'" > "$tmp/r2b" ) &
  two=$!
  wait "$one"; wait "$two"
  got="$(cat "$tmp/r2a" "$tmp/r2b" | LC_ALL=C sort | tr '\n' ' ')"
  [[ "$got" == "acquired in_progress " && "$("${RQ[@]}" -c "select owner_fence from private.account_lifecycle_operations where id = '$op'")" == 2 ]] \
    || { echo "FAIL race two claims: $got" >&2; exit 1; }
  echo "COMMON_ACCOUNT_SERVICE_DELETION_RACE_TWO_CLAIMS_PASS"

  # R3. A whole-account freeze commits while the owner's record waits: the owner still finishes (one chain of
  #     ownership, no deadlock), and a NEW service-only claim after the freeze is refused.
  u="$(uid 803)"; person 803; op="$(begin_op "$u")"; lease="$(claim "$u" "$op")"
  svc "select public.record_owned_service_deletion_provider_result('$u'::uuid, 'x_autopost', '$op'::uuid, '$lease'::uuid, 'x', 'done')" >/dev/null
  "${RQ[@]}" -c "delete from public.brand_memberships where brand_id = public.social_mobile_account_deletion_workspace('$u'::uuid); delete from public.brands where id = public.social_mobile_account_deletion_workspace('$u'::uuid)" >/dev/null
  v="$("${RQ[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
  ( "${RQ[@]}" -c "begin; set local role service_role; select public.begin_common_account_deletion('$u'::uuid, $v); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
  holder=$!
  sleep 0.3
  ( svc "select public.finish_owned_service_deletion('$u'::uuid, 'x_autopost', '$op'::uuid, '$lease'::uuid) ->> 'status'" > "$tmp/r3" ) &
  finisher=$!
  sleep 0.4
  waiting="$(lock_waiters finish_owned_service_deletion)"
  wait "$holder"; wait "$finisher"
  [[ "$waiting" == 1 && "$(cat "$tmp/r3")" == ended && "$(status "$u")" == ended ]] \
    || { echo "FAIL race freeze: waiting=$waiting answer=$(cat "$tmp/r3") status=$(status "$u")" >&2; exit 1; }
  echo "COMMON_ACCOUNT_SERVICE_DELETION_RACE_FREEZE_PASS"
fi

if want rollback; then
  psql_q "$db_exact" -c "update private.account_lifecycle_operations set owner_lease = null, owner_lease_expires_at = null where operation_type = 'service_deletion'" >/dev/null
  "${O[@]}" -f "$rollback_file" >/dev/null
  [[ "$(has_new_objects "$db_exact")" == f ]] || { echo "FAIL rollback: functions remain" >&2; exit 1; }
  catalog > "$tmp/rolled_back_after"
  # The same catalog as before, apart from the additive columns (kept by design) and their constraints.
  diff <(grep -v -e 'provider_results' -e 'remote_unverified_ack' -e 'account_lifecycle_operations_ack_shape' "$tmp/before") \
       <(grep -v -e 'provider_results' -e 'remote_unverified_ack' -e 'account_lifecycle_operations_ack_shape' "$tmp/rolled_back_after") >/dev/null \
    || { echo "FAIL rollback: the catalog differs beyond the kept columns" >&2; diff "$tmp/before" "$tmp/rolled_back_after" >&2 || true; exit 1; }
  if out="$("${O[@]}" -f "$rollback_file" 2>&1)"; then echo "FAIL rollback ran twice" >&2; exit 1; fi
  grep -q COMMON_ACCOUNT_SERVICE_OWNERSHIP_ROLLBACK_NOT_APPLIED <<<"$out" || { echo "FAIL rollback reason: $out" >&2; exit 1; }
  "${O[@]}" -f "$candidate" >/dev/null 2>&1 || { echo "FAIL rollback: re-apply" >&2; exit 1; }
  # A lease held by a running owner stops the rollback.
  q="$(uid 899)"
  psql_q "$db_exact" -c "select public.fixture_login('$q'::uuid)" >/dev/null
  psql_q "$db_exact" -c "begin; set local request.jwt.claim.sub = '$q'; set local request.jwt.claim.role = 'authenticated'; set local role authenticated; select public.start_x_autopost_service(); commit;" >/dev/null
  qop="$(psql_q "$db_exact" -c "begin; set local role service_role; select public.begin_service_deletion('$q'::uuid, 'x_autopost') ->> 'operation_id'; commit;")"
  psql_q "$db_exact" -c "begin; set local role service_role; select public.claim_service_deletion('$q'::uuid, 'x_autopost', '$qop'::uuid); commit;" >/dev/null
  if out="$("${O[@]}" -f "$rollback_file" 2>&1)"; then echo "FAIL rollback ran with a lease held" >&2; exit 1; fi
  grep -q COMMON_ACCOUNT_SERVICE_OWNERSHIP_ROLLBACK_LEASES_OPEN <<<"$out" || { echo "FAIL rollback lease reason: $out" >&2; exit 1; }
  echo "COMMON_ACCOUNT_SERVICE_DELETION_ROLLBACK_PASS"
fi

echo "COMMON_ACCOUNT_SERVICE_DELETION_ALL_PASS"
