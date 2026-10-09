#!/usr/bin/env bash
# Disposable-only proof runner for 20261009120000_common_account_deletion_completion (common account
# Phase 3a with the PR112 H2 R1-R4 corrective). Builds the lifecycle suites' production-shaped baseline
# (fixtures, the real onboarding and social-mobile deletion migrations, Phase 1, Phase 2) on a LOCAL
# Unix-socket PostgreSQL, applies the candidate as a non-superuser owner, then proves: preflight
# refusals, the exact schema change (one Phase 1 rule replaced; the listed columns, rules, gate table and
# functions with their exact ACLs), refused re-apply, static source rules, the Phase 2 behavior suite
# still passing, this candidate's behavior (including the H2 R3/R4 reproductions, which must now fail),
# and two-session races (login removal vs read-back, start vs begin, two owners, an identity link vs the
# managed delete decision). Fake data only; never production.
#
# Wherever the behavior file runs "delete from auth.users" it is the TEST standing in for the managed
# Auth Admin delete; the candidate itself never removes a login.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_deletion_completion_run.sh
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${CAL_COMPLETION_CANDIDATE:-$migrations/20261009120000_common_account_deletion_completion.sql}"
owner="kb_cal_completion_owner"
db="kabumori_cal_completion_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
Q=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
tmp="$(mktemp -d /private/tmp/kabumori-cal-completion.XXXXXX)"
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
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
"${O[@]}" -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${O[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${O[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${O[@]}" -f "$here/common_account_lifecycle_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null

has_new_objects() {
  "${Q[@]}" -c "select to_regprocedure('public.complete_common_account_deletion(uuid,uuid)') is not null
    or to_regprocedure('public.common_account_deletion_storage_objects(uuid,integer)') is not null
    or to_regprocedure('public.claim_common_account_deletion(uuid,uuid,integer)') is not null
    or to_regclass('private.account_lifecycle_release_gates') is not null
    or exists (select 1 from pg_attribute where attrelid = 'private.account_lifecycle_operations'::regclass
                and attname in ('verified_at', 'owner_lease', 'external_step') and not attisdropped)"
}

# 1. Preflight. Without Phase 2 it refuses and creates nothing.
if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted a database without Phase 2" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING' <<<"$out" || { echo "FAIL preflight reason: $out" >&2; exit 1; }
[[ "$(has_new_objects)" == f ]] || { echo "FAIL preflight left objects" >&2; exit 1; }
"${O[@]}" -f "$migrations/20261006230000_common_account_service_start_intent.sql" >/dev/null

# The Phase 1 "completed" rule it replaces must be exactly the reviewed one.
rule_name="$("${Q[@]}" -c "select conname from pg_constraint where conrelid = 'private.account_lifecycle_operations'::regclass
  and pg_get_constraintdef(oid) = 'CHECK (((status <> ''completed''::text) OR (operation_type = ''service_deletion''::text)))'")"
[[ -n "$rule_name" ]] || { echo "FAIL baseline: Phase 1 completed rule not found" >&2; exit 1; }
"${Q[@]}" -c "alter table private.account_lifecycle_operations drop constraint $rule_name,
  add constraint $rule_name check (status <> 'completed' or operation_type in ('service_deletion', 'account_deletion'))" >/dev/null
if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted a changed completed rule" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_COMPLETED_RULE_CHANGED' <<<"$out" || { echo "FAIL preflight reason: $out" >&2; exit 1; }
[[ "$(has_new_objects)" == f ]] || { echo "FAIL preflight left objects" >&2; exit 1; }
"${Q[@]}" -c "alter table private.account_lifecycle_operations drop constraint $rule_name,
  add constraint $rule_name check (status <> 'completed' or operation_type = 'service_deletion')" >/dev/null
# A guard that is no longer 'shadow' is refused too.
"${Q[@]}" -c "alter table private.account_lifecycle_settings disable trigger user; delete from private.account_lifecycle_settings;" >/dev/null
if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL preflight accepted a missing settings row" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING' <<<"$out" || { echo "FAIL preflight reason: $out" >&2; exit 1; }
[[ "$(has_new_objects)" == f ]] || { echo "FAIL preflight left objects" >&2; exit 1; }
"${Q[@]}" -c "insert into private.account_lifecycle_settings default values; alter table private.account_lifecycle_settings enable trigger user;" >/dev/null
echo "COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_PASS"

# 2. Exactly this change: one Phase 1 rule replaced, nothing else removed or altered.
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
select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '-') from pg_policy
union all
select 'trg ' || tgrelid::regclass::text || ' ' || tgname || ' ' || tgenabled::text from pg_trigger where not tgisinternal
union all
select 'row ' || auth_delete_guard || '/' || integration_state || '/' || requirement_epoch from private.account_lifecycle_settings
order by 1;
SQL
}
catalog > "$tmp/before"
"${O[@]}" -f "$candidate" >/dev/null
catalog > "$tmp/after"
removed="$(comm -23 "$tmp/before" "$tmp/after")"
added="$(comm -13 "$tmp/before" "$tmp/after" | sed -E 's/^(fn [^ ]+) .*/\1/' | sort)"
want_removed="con private.account_lifecycle_operations $rule_name CHECK (((status <> 'completed'::text) OR (operation_type = 'service_deletion'::text)))"
[[ "$removed" == "$want_removed" ]] || { echo "FAIL change: unexpected removal/alteration: $removed" >&2; exit 1; }
want_added="$(sort "$here/common_account_deletion_completion_expected_catalog.txt")"
[[ "$added" == "$want_added" ]] || { echo "FAIL change: unexpected additions:" >&2; diff <(echo "$want_added") <(echo "$added") >&2 || true; exit 1; }
# Exact ACLs of the new functions: owner + service_role for the public ones, owner only for the private
# helpers; the gate table has no grant at all.
acl="$("${Q[@]}" -c "select string_agg(p.proname || '=' || coalesce(array_to_string(array(select split_part(a, '=', 1) from unnest(p.proacl::text[]) a order by 1), ','), 'NULL'), ' ' order by p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname = 'public' and p.proname in ('common_account_deletion_release_gate', 'claim_common_account_deletion',
          'renew_common_account_deletion_claim', 'release_common_account_deletion_claim', 'set_owned_common_account_deletion_checkpoint',
          'prepare_owned_common_account_auth_delete', 'begin_common_account_deletion_external_step',
          'settle_common_account_deletion_external_step', 'resolve_common_account_deletion_external_step',
          'complete_common_account_deletion', 'common_account_deletion_storage_objects', 'record_common_account_deletion_error'))
    or (n.nspname = 'private' and p.proname in ('account_lifecycle_gate_open', 'account_lifecycle_owned_operation',
          'account_lifecycle_residue', 'account_lifecycle_storage_inventory'))")"
want_acl="account_lifecycle_gate_open=$owner account_lifecycle_owned_operation=$owner account_lifecycle_residue=$owner account_lifecycle_storage_inventory=$owner"
for f in begin_common_account_deletion_external_step claim_common_account_deletion common_account_deletion_release_gate common_account_deletion_storage_objects \
         complete_common_account_deletion prepare_owned_common_account_auth_delete record_common_account_deletion_error release_common_account_deletion_claim \
         renew_common_account_deletion_claim resolve_common_account_deletion_external_step set_owned_common_account_deletion_checkpoint settle_common_account_deletion_external_step; do
  want_acl="$want_acl $f=$owner,service_role"
done
want_acl="$(tr ' ' '\n' <<<"$want_acl" | sort | tr '\n' ' ' | sed 's/ $//')"
acl="$(tr ' ' '\n' <<<"$acl" | sort | tr '\n' ' ' | sed 's/ $//')"
[[ "$acl" == "$want_acl" ]] || { echo "FAIL ACL: $acl" >&2; exit 1; }
[[ "$("${Q[@]}" -c "select coalesce(array_to_string(relacl::text[], ','), 'NULL') || '/' || relrowsecurity from pg_class where oid = 'private.account_lifecycle_release_gates'::regclass")" == "$owner=arwdDxtm/$owner/true" ]] \
  || { echo "FAIL gate table ACL/RLS" >&2; exit 1; }
[[ "$("${Q[@]}" -c "select gate || '/' || state || '/' || reason from private.account_lifecycle_release_gates")" == managed_auth_delete/blocked/IDENTITY_CHANGE_FENCE_MISSING ]] \
  || { echo "FAIL gate row" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_EXACT_CHANGE_PASS"

if out="$("${O[@]}" -f "$candidate" 2>&1)"; then echo "FAIL re-apply accepted" >&2; exit 1; fi
grep -q 'COMMON_ACCOUNT_DELETION_COMPLETION_ALREADY_APPLIED' <<<"$out" || { echo "FAIL re-apply reason: $out" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_REAPPLY_REFUSED_PASS"

# 3. Static rules on the candidate source (comments stripped).
code="$(sed -e 's/--.*$//' "$candidate")"
flat="$(tr '\n' ' ' <<<"$code" | tr ';' '\n')"
if grep -qiE '(delete[[:space:]]+from|update|insert[[:space:]]+into|truncate)[[:space:]]+(only[[:space:]]+)?(auth|storage|vault)\.' <<<"$flat"; then
  echo "FAIL the candidate writes to a managed schema (auth / storage / vault)" >&2; exit 1
fi
if grep -qiE 'delete[[:space:]]+from|truncate' <<<"$flat"; then echo "FAIL the candidate deletes rows" >&2; exit 1; fi
# The only insert is the gate's own 'blocked' row.
if grep -iE 'insert[[:space:]]+into' <<<"$flat" | grep -qvE "insert into private\.account_lifecycle_release_gates \(gate, state, reason\)[[:space:]]+values \('managed_auth_delete', 'blocked', 'IDENTITY_CHANGE_FENCE_MISSING'\)"; then
  echo "FAIL the candidate inserts rows other than the blocked gate" >&2; exit 1
fi
# The gate can only ever be created blocked; nothing in the file opens it.
grep -qE "state text not null constraint account_lifecycle_release_gates_blocked_only check \(state = 'blocked'\)" <<<"$code" \
  || { echo "FAIL the release gate is not schema-locked to blocked" >&2; exit 1; }
if grep -iE "update[[:space:]]+private\.account_lifecycle_release_gates|state[[:space:]]*=[[:space:]]*'open'" <<<"$flat" | grep -qvE "g\.state = 'open'"; then
  echo "FAIL the candidate opens the release gate" >&2; exit 1
fi
if grep -iE '(^|[^a-z_])update[[:space:]]+[a-z_]+\.' <<<"$flat" | grep -qvE 'update[[:space:]]+private\.account_lifecycle_operations[[:space:]]'; then
  echo "FAIL the candidate updates a table other than the lifecycle operations" >&2; exit 1
fi
if grep -qiE 'auth\.admin|/auth/v1|deleteUser|storage/v1' <<<"$code"; then echo "FAIL the candidate reaches for a managed API" >&2; exit 1; fi
if grep -qiE 'e-?mail' <<<"$code"; then echo "FAIL the candidate reads e-mail" >&2; exit 1; fi
if grep -oiE "auth_delete_guard[[:space:]]*(=|:=)[[:space:]]*'[a-z_]+'" <<<"$flat" | grep -qv "'shadow'"; then echo "FAIL guard mode" >&2; exit 1; fi
if grep -qi "'enforce" <<<"$code"; then echo "FAIL the candidate defines an enforcing guard mode" >&2; exit 1; fi
if grep -qiE 'create or replace|drop[[:space:]]+(table|function|view|trigger|policy|index|schema|column)' <<<"$code"; then
  echo "FAIL the candidate replaces or drops an existing object" >&2; exit 1
fi
if grep -iE '^[[:space:]]*grant ' <<<"$flat" | grep -qvE 'to service_role$'; then echo "FAIL a grant to a role other than service_role" >&2; exit 1; fi
fns="$(grep -ciE '^create function' <<<"$code")"
safe="$(grep -ciE 'security definer set search_path = '"''" <<<"$code")"
[[ "$fns" == 16 && "$safe" == 16 ]] || { echo "FAIL every function must be SECURITY DEFINER with an empty search_path ($fns/$safe)" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_STATIC_PASS"

# 4. Behavior: the Phase 2 suite is unaffected, then this candidate's own suite.
"${Q[@]}" -f "$here/common_account_service_start_intent_behavior.sql" | grep -qx 'COMMON_ACCOUNT_START_INTENT_BEHAVIOR_PASS' \
  || { echo "FAIL Phase 2 behavior after the candidate" >&2; "${Q[@]}" -f "$here/common_account_service_start_intent_behavior.sql" >&2 || true; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_PHASE2_UNCHANGED_PASS"
"${Q[@]}" -f "$here/common_account_deletion_completion_behavior.sql" | grep -qx 'COMMON_ACCOUNT_DELETION_COMPLETION_BEHAVIOR_PASS' \
  || { echo "FAIL behavior" >&2; "${Q[@]}" -f "$here/common_account_deletion_completion_behavior.sql" >&2 || true; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_BEHAVIOR_PASS"

# 5. Two-session races. The behavior suite opened the release gate in this database (test-only DDL),
#    so the managed-delete intent can be recorded here.
[[ "$("${Q[@]}" -c "select state from private.account_lifecycle_release_gates")" == open ]] || { echo "FAIL race setup: gate" >&2; exit 1; }
uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
svc() { "${Q[@]}" -c "begin; set local role service_role; $1; commit;"; }
ready_person() {  # uid -> operation id of a ready Kabumori-only deletion
  local u="$1" v op
  "${Q[@]}" -c "select public.fixture_login('$u'::uuid)" >/dev/null
  "${Q[@]}" -c "begin; set local request.jwt.claim.sub = '$u'; set local role authenticated; select public.start_kabumori_service(); commit;" >/dev/null
  v="$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
  op="$(svc "select public.begin_common_account_deletion('$u'::uuid, $v) ->> 'operation_id'")"
  svc "select public.withdraw_kabumori_service('$u'::uuid)" >/dev/null
  svc "select public.record_common_account_deletion_checkpoint('$u'::uuid, '$op'::uuid, 'session_revocation')" >/dev/null
  svc "select public.record_common_account_deletion_checkpoint('$u'::uuid, '$op'::uuid, 'storage_cleanup')" >/dev/null
  [[ "$(svc "select public.prepare_common_account_auth_delete('$u'::uuid, '$op'::uuid) ->> 'status'")" == ready_for_managed_auth_delete ]] \
    || { echo "FAIL race fixture not ready" >&2; exit 1; }
  echo "$op"
}
owned_intent() {  # uid op -> records the managed delete intent as the owner
  local lease
  lease="$(svc "select public.claim_common_account_deletion('$1'::uuid, '$2'::uuid, 600) ->> 'lease'")"
  [[ "$(svc "select public.begin_common_account_deletion_external_step('$1'::uuid, '$2'::uuid, '$lease'::uuid, 'managed_auth_delete') ->> 'status'")" == owned ]] \
    || { echo "FAIL race fixture intent" >&2; exit 1; }
}
op_status() { "${Q[@]}" -c "select status || '/' || coalesce(last_error_code, '-') from private.account_lifecycle_operations where id = '$1'"; }

# 5a. The removal is uncommitted (its guard holds the operation row) when the read-back arrives. The
#     read-back waits, then sees the committed removal and completes.
u="$(uid 601)"; op="$(ready_person "$u")"; owned_intent "$u" "$op"
( "${Q[@]}" -c "begin; delete from auth.users where id = '$u'; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$(svc "select public.complete_common_account_deletion('$u'::uuid, '$op'::uuid) ->> 'status'")"
wait "$holder"
[[ "$r" == completed && "$(op_status "$op")" == completed/- ]] || { echo "FAIL race removal-then-readback: $r / $(op_status "$op")" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_RACE_REMOVAL_THEN_READBACK_PASS"

# 5b. The read-back holds its transaction (login still present) when the removal arrives. The removal
#     waits for the operation row, then closes it as an unverified removal; nothing was completed early.
u="$(uid 602)"; op="$(ready_person "$u")"; owned_intent "$u" "$op"
( "${Q[@]}" -c "begin; set local role service_role; select public.complete_common_account_deletion('$u'::uuid, '$op'::uuid); reset role; select pg_sleep(1.5); commit;" > "$tmp/r5b" ) &
holder=$!
sleep 0.4
"${Q[@]}" -c "delete from auth.users where id = '$u'" >/dev/null
wait "$holder"
grep -q '"status": "login_present"' "$tmp/r5b" || { echo "FAIL race readback-then-removal answer: $(cat "$tmp/r5b")" >&2; exit 1; }
[[ "$(op_status "$op")" == login_removed/LOGIN_REMOVED_WHILE_READY_UNVERIFIED ]] || { echo "FAIL race readback-then-removal state: $(op_status "$op")" >&2; exit 1; }
[[ "$(svc "select public.complete_common_account_deletion('$u'::uuid, '$op'::uuid) ->> 'status'")" == completed ]] || { echo "FAIL race readback after removal" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_RACE_READBACK_THEN_REMOVAL_PASS"

# 5c. A service start (stale token) is uncommitted when the deletion begins, and the reverse: the
#     Phase 1 lock order still decides it with the candidate applied (start wins -> stale version refused;
#     begin wins -> start blocked).
u="$(uid 603)"
"${Q[@]}" -c "select public.fixture_login('$u'::uuid)" >/dev/null
( "${Q[@]}" -c "begin; set local request.jwt.claim.sub = '$u'; set local role authenticated; select public.start_kabumori_service(); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$(svc "select public.begin_common_account_deletion('$u'::uuid, 0) ->> 'status'")"
wait "$holder"
[[ "$r" == lifecycle_changed ]] || { echo "FAIL race start-then-begin: $r" >&2; exit 1; }
v="$("${Q[@]}" -c "select lifecycle_version from public.common_accounts where user_id = '$u'")"
( "${Q[@]}" -c "begin; set local role service_role; select public.begin_common_account_deletion('$u'::uuid, $v); reset role; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$("${Q[@]}" -c "begin; set local request.jwt.claim.sub = '$u'; set local role authenticated; select public.start_x_autopost_service()::text; commit;")"
wait "$holder"
[[ "$r" == *ACCOUNT_DELETION_IN_PROGRESS* ]] || { echo "FAIL race begin-then-start: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_RACE_START_VS_BEGIN_PASS"

# 5d. R1: two requests claim the same deletion at the same moment. The first holds its transaction; the
#     second waits on the account lock, then sees the committed lease: exactly one owner.
u="$(uid 604)"; op="$(ready_person "$u")"
( "${Q[@]}" -c "begin; set local role service_role; select public.claim_common_account_deletion('$u'::uuid, '$op'::uuid, 600); reset role; select pg_sleep(1.5); commit;" > "$tmp/r5d" ) &
holder=$!
sleep 0.4
r="$(svc "select public.claim_common_account_deletion('$u'::uuid, '$op'::uuid, 600)::text")"
wait "$holder"
grep -q '"status": "acquired"' "$tmp/r5d" && [[ "$r" == '{"status": "in_progress"}' ]] \
  && [[ "$("${Q[@]}" -c "select owner_fence from private.account_lifecycle_operations where id = '$op'")" == 1 ]] \
  || { echo "FAIL race two owners: $(cat "$tmp/r5d") / $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_RACE_ONE_OWNER_PASS"

# 5e. R3: an Apple identity link is in flight (uncommitted, holding the login's key-share lock) when the
#     managed delete is decided. The decision takes the exclusive login lock, so it waits, then sees the
#     new requirement and refuses; the readiness is dropped and nothing is recorded as intended.
u="$(uid 605)"; op="$(ready_person "$u")"
lease="$(svc "select public.claim_common_account_deletion('$u'::uuid, '$op'::uuid, 600) ->> 'lease'")"
( "${Q[@]}" -c "begin; insert into auth.identities (user_id, provider) values ('$u', 'apple'); select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
r="$(svc "select public.begin_common_account_deletion_external_step('$u'::uuid, '$op'::uuid, '$lease'::uuid, 'managed_auth_delete')::text")"
wait "$holder"
[[ "$r" == *'"status": "not_ready"'* && "$r" == *REQUIRED_CHECKPOINTS_CHANGED* ]] \
  && [[ "$("${Q[@]}" -c "select current_step || '/' || coalesce(external_step, '-') || '/' || (managed_delete_intent_at is null) from private.account_lifecycle_operations where id = '$op'")" == cleanup/-/true ]] \
  || { echo "FAIL race identity-link-then-intent: $r" >&2; exit 1; }
echo "COMMON_ACCOUNT_DELETION_COMPLETION_RACE_IDENTITY_LINK_THEN_INTENT_PASS"

echo "COMMON_ACCOUNT_DELETION_COMPLETION_ALL_PASS"
