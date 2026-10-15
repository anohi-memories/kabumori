#!/usr/bin/env bash
# Disposable-only proof runner for 20261015120000_common_account_x_unconfirmed_snapshot_record (common account
# Phase 10, F5: the durable record of the X unconfirmed-post evidence SET that the snapshot acknowledgement binds to).
#
# Builds the production-shaped baseline + the whole common-account chain through Phase 9 (the state the candidate is
# applied on) on a LOCAL Unix-socket PostgreSQL as a non-superuser owner and proves: preflight refusals (nothing left
# behind), the exact catalog change (one constraint replaced by its widening, one function added), a refused re-apply,
# static source rules, the behavior suite, a two-session race (no lost snapshot), and the emergency rollback (both
# the data-free and the data-keeping case). Fake data only; never production.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_x_unconfirmed_snapshot_run.sh
# Optional: CAL_XU_CANDIDATE=<file> (mutation runs), CAL_XU_ROLLBACK=<file>,
#           CAL_XU_SECTIONS=preflight,exact,static,behavior,race,rollback
set -euo pipefail
export LC_ALL=C PGTZ=UTC

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
candidate="${CAL_XU_CANDIDATE:-$m/20261015120000_common_account_x_unconfirmed_snapshot_record.sql}"
rollback_file="${CAL_XU_ROLLBACK:-$t/common_account_x_unconfirmed_snapshot_rollback.sql}"
sections="${CAL_XU_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
fail() { echo "FAIL $*" >&2; exit 1; }

n="$$"
owner="kb_xu_owner_$n"
prefix="kabumori_xu_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-xu.XXXXXX)"
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_xu\_%'"); do
  "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null
done
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
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
val() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
mk() { "${S[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" >/dev/null; }
copy() { local d="${prefix}_$1"; mk "$d" "$2"; echo "$d"; }
must() {
  local out
  if ! out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$1" -f "$2" 2>&1)"; then
    fail "$3 did not apply: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  fi
}
catalog() { val "$1" -f "$t/common_account_phase8_catalog.sql"; }
has_fn() { val "$1" -c "select to_regprocedure('public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text)') is not null"; }

new_operation() {  # database user-uuid -> prints "<operation> <lease>" (a claimed POSTONA service deletion with its workspace)
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$1" -v u="$2" <<'SQL' | tail -1
select public.fixture_login(:'u'::uuid);
begin;
select set_config('request.jwt.claim.sub', :'u', true) as a, set_config('request.jwt.claim.role', 'authenticated', true) as b, set_config('request.jwt.claims', '', true) as c \gset
set local role authenticated;
select (public.start_x_autopost_service() ->> 'status') as started \gset
reset role;
insert into public.brands (id, code_profile_key) values (public.social_mobile_account_deletion_workspace(:'u'::uuid), 'social_mobile_user_v1') on conflict (id) do nothing;
insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace(:'u'::uuid), :'u'::uuid, 'owner') on conflict do nothing;
set local role service_role;
select (public.begin_service_deletion(:'u'::uuid, 'x_autopost') ->> 'operation_id') as op \gset
select (public.claim_service_deletion(:'u'::uuid, 'x_autopost', :'op'::uuid) ->> 'lease') as lease \gset
reset role;
commit;
select :'op' || ' ' || :'lease';
SQL
}

# ---- the world: baseline + Phase 1 .. 9 ------------------------------------------------------------------------------
world="${prefix}_world"
mk "$world"
own "$world" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$world" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  own "$world" -f "$m/$f" >/dev/null
done
own "$world" -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
own "$world" -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql \
         20261009120000_common_account_deletion_completion.sql; do
  must "$world" "$m/$f" "$f"
done
own "$world" -f "$t/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$world" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql \
         20261012230000_common_account_service_brand_state.sql 20261013120000_common_account_service_deletion_ownership.sql \
         20261013140000_common_account_service_reconciliation_facts.sql 20261015090000_common_account_enrollment_session_fence.sql; do
  must "$world" "$m/$f" "$f"
done
echo "PASS world: baseline + Phase 1, 2, 3a, 3b, 4, 5, 6, 8, 9 (the state the candidate is applied on)"

# ---- 1. preflight ---------------------------------------------------------------------------------------------------
refused_with() {  # database code [as_super] -> refused with that code, catalog byte-identical afterwards
  local d="$1" code="$2" who="${3:-owner}" out before after
  before="$(catalog "$d" | shasum -a 256)"
  if [[ "$who" == super ]]; then
    out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$d" -f "$candidate" 2>&1)" && fail "preflight accepted: expected $code"
  else
    out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$candidate" 2>&1)" && fail "preflight accepted: expected $code"
  fi
  grep -q "$code" <<<"$out" || fail "preflight reason (expected $code): $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  after="$(catalog "$d" | shasum -a 256)"
  [[ "$before" == "$after" ]] || fail "the refused apply changed the catalog ($code)"
}
if want preflight; then
  d="$(copy pf_p8 "$world")"; val "$d" -c "alter function public.common_account_service_end_result(uuid,text) rename to common_account_service_end_result_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_PHASE8_MISSING
  d="$(copy pf_p6 "$world")"; val "$d" -c "alter function private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid) rename to account_lifecycle_owned_service_operation_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_PHASE8_MISSING
  d="$(copy pf_shape "$world")"; val "$d" -c "alter table private.account_lifecycle_operations drop constraint account_lifecycle_operations_reconciliation_shape" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_SHAPE
  # a row carrying a key that is neither of this file's two (the shape check bypassed by hand) is refused, not adopted
  d="$(copy pf_foreign "$world")"
  read -r fop flease <<<"$(new_operation "$d" 00000000-0000-4000-8000-0000000000f1)"
  [[ -n "$fop" ]] || fail "preflight setup: no operation"
  val "$d" -c "alter table private.account_lifecycle_operations drop constraint account_lifecycle_operations_reconciliation_shape" \
           -c "alter table private.account_lifecycle_operations add constraint account_lifecycle_operations_reconciliation_shape check (jsonb_typeof(reconciliation) = 'object' or reconciliation ? 'x_posts_unconfirmed')" \
           -c "update private.account_lifecycle_operations set reconciliation = '{\"other\": 1}'::jsonb where id = '$fop'::uuid" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_SHAPE
  d2="$(copy pf_acl "$world")"; val "$d2" -c "grant execute on function private.account_lifecycle_owned_service_operation(uuid,text,uuid,uuid) to service_role" >/dev/null
  refused_with "$d2" COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_OWNER_CHECK_ACL
  refused_with "$world" COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_OWNER super
  # a superuser that OWNS the table is still refused (the owner clause alone would let it through)
  d3="$(copy pf_superowner "$world")"; "${S[@]}" -d "$d3" -c "alter table private.account_lifecycle_operations owner to $super" >/dev/null
  refused_with "$d3" COMMON_ACCOUNT_X_UNCONFIRMED_PREFLIGHT_OWNER super
  echo "PASS preflight: a missing Phase 8 / Phase 6 function, a missing shape constraint, a reachable owner check and a superuser apply are refused with their own code; the catalog is byte-identical afterwards"
fi

# ---- 2. exact change --------------------------------------------------------------------------------------------------
applied="$(copy applied "$world")"
must "$applied" "$candidate" "the candidate"
echo "PASS apply: the candidate applies on the Phase 9 world as a non-superuser owner"
if want exact; then
  strip() { sed -E 's/^(fn [^ ]+) [0-9a-f]{32} /\1 /'; }
  catalog "$world" | strip | LC_ALL=C sort > "$tmp/before"
  catalog "$applied" | strip | LC_ALL=C sort > "$tmp/after"
  removed="$(comm -23 "$tmp/before" "$tmp/after")"
  added="$(comm -13 "$tmp/before" "$tmp/after")"
  [[ "$(wc -l <<<"$removed" | tr -d ' ')" == 1 && "$removed" == "con private.account_lifecycle_operations account_lifecycle_operations_reconciliation_shape CHECK "* ]] \
    || { echo "$removed" >&2; fail "exact change: more than the one constraint was altered or removed"; }
  [[ "$(wc -l <<<"$added" | tr -d ' ')" == 2 ]] || { echo "$added" >&2; fail "exact change: expected exactly two additions"; }
  grep -q '^con private.account_lifecycle_operations account_lifecycle_operations_reconciliation_shape CHECK .*x_unconfirmed_snapshots' <<<"$added" || fail "exact change: the widened constraint is missing"
  fn_line="$(grep '^fn public.record_owned_service_deletion_x_unconfirmed(uuid,text,uuid,uuid,integer,text) ' <<<"$added")"
  [[ -n "$fn_line" ]] || fail "exact change: the recorder function is missing"
  acl="${fn_line##* }"
  [[ "$acl" == *"service_role=X/"* && "$(tr ',' '\n' <<<"$acl" | wc -l | tr -d ' ')" == 2 ]] || fail "exact change: the function ACL is not owner + service_role ($acl)"
  # a second apply is refused and changes nothing
  refused_with "$applied" COMMON_ACCOUNT_X_UNCONFIRMED_ALREADY_APPLIED
  echo "PASS exact: one constraint widened (same name), one service_role-only function added; no table, column, grant, policy, trigger or existing function changed; a second apply is refused"
fi

# ---- 3. static -------------------------------------------------------------------------------------------------------
if want static; then
  code="$(sed -e 's/--.*$//' "$candidate")"
  flat="$(tr '\n' ' ' <<<"$code" | tr ';' '\n')"
  if grep -qiE 'auth\.sessions|auth\.identities|auth\.users|auth\.admin|storage\.|vault\.|/auth/v1' <<<"$code"; then fail "the candidate reaches for GoTrue tables, Storage or Vault"; fi
  if grep -qiE '(^|[[:space:]])cascade([[:space:]]|;|$)' <<<"$flat"; then fail "CASCADE appears"; fi
  if grep -qiE 'security[[:space:]]+invoker|delete[[:space:]]+from|truncate|create or replace|drop[[:space:]]+(table|schema|column|trigger|policy|function)|create[[:space:]]+table|alter[[:space:]]+function|insert[[:space:]]+into' <<<"$code"; then fail "unexpected statement"; fi
  [[ "$(grep -ciE 'drop[[:space:]]+constraint' <<<"$code")" == 1 ]] || fail "exactly one constraint may be dropped (the one it re-adds)"
  [[ "$(grep -ciE '^create function' <<<"$code")" == 1 && "$(grep -ciE 'security definer set search_path = ' <<<"$code")" == 1 ]] || fail "exactly one SECURITY DEFINER function with an empty search_path"
  if grep -iE '^[[:space:]]*grant[[:space:]]' <<<"$code" | grep -viE 'to service_role;' >/dev/null; then fail "a grant to something other than service_role"; fi
  # the lease is checked after the locks, through the same helper as every other owner recorder
  [[ "$(grep -c 'private.account_lifecycle_lock(p_user_id, false)' <<<"$code")" == 1 && "$(grep -c 'private.account_lifecycle_owned_service_operation(p_user_id, p_service_key, p_operation_id, p_lease)' <<<"$code")" == 1 ]] \
    || fail "the recorder must use the common lock and the owner check"
  echo "PASS static: no CASCADE, no destructive statement, no GoTrue/Storage/Vault, one definer function, grants only to service_role"
fi

# ---- 4. behavior ------------------------------------------------------------------------------------------------------
if want behavior; then
  out="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$applied" -f "$t/common_account_x_unconfirmed_snapshot_behavior.sql" 2>&1)" \
    || { echo "$out" | tail -8 >&2; fail "behavior suite"; }
  grep -qx COMMON_ACCOUNT_X_UNCONFIRMED_BEHAVIOR_PASS <<<"$out" || fail "behavior suite incomplete"
  echo "PASS behavior: pair recorded once, count sticky at its maximum, evidence sets appended and capped at sixteen, leases and ownership, read-back after the end, constraint last line"
fi

# ---- 5. race: two sessions record different sets for one operation; neither may be lost ------------------------------
if want race; then
  d="$(copy race "$world")"
  must "$d" "$candidate" "the candidate (race)"
  user_id='00000000-0000-4000-8000-0000000000a1'
  read -r op lease <<<"$(new_operation "$d" "$user_id")"
  [[ -n "$op" && -n "$lease" ]] || fail "race setup"
  s1="$(printf '%064d' 1 | tr '0' 'a')"; s2="$(printf '%064d' 1 | tr '0' 'b')"; s3="$(printf '%064d' 1 | tr '0' 'c')"
  rec() {  # snapshot hold_seconds
    psql -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$d" -v ON_ERROR_STOP=1 -c "begin; set local role service_role;
      select public.record_owned_service_deletion_x_unconfirmed('$user_id'::uuid, 'x_autopost', '$op'::uuid, '$lease'::uuid, 3, '$1');
      select pg_sleep($2); commit;" > "$tmp/race_$1.out" 2>&1
  }
  rec "$s1" 2 & p1=$!
  sleep 0.4
  rec "$s2" 0 & p2=$!
  rec "$s3" 0 & p3=$!
  wait "$p1" "$p2" "$p3" || fail "a racing recorder failed: $(cat "$tmp"/race_*.out | head -3)"
  got="$(val "$d" -c "select jsonb_array_length(reconciliation -> 'x_unconfirmed_snapshots') || ':' || (reconciliation ->> 'x_posts_unconfirmed') from private.account_lifecycle_operations where id = '$op'::uuid")"
  [[ "$got" == "3:3" ]] || fail "race: lost an evidence set or the count ($got)"
  echo "PASS race: three concurrent recorders of different sets all land (lock order login -> account -> operation row, no lost update)"
fi

# ---- 6. rollback -----------------------------------------------------------------------------------------------------
if want rollback; then
  # (a) nothing recorded: the catalog is the Phase 9 world's, byte for byte; a second rollback is refused; re-apply is the same catalog
  d="$(copy rb_clean "$world")"
  must "$d" "$candidate" "the candidate (rollback)"
  out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$rollback_file" 2>&1)" || fail "rollback: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  [[ "$(has_fn "$d")" == f ]] || fail "rollback left the function"
  cmp -s <(catalog "$world") <(catalog "$d") || fail "rollback did not restore the Phase 8 catalog byte for byte"
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$rollback_file" 2>&1)"; then fail "rollback ran twice"; fi
  grep -q COMMON_ACCOUNT_X_UNCONFIRMED_ROLLBACK_NOT_APPLIED <<<"$out" || fail "second rollback reason"
  must "$d" "$candidate" "re-apply after the rollback"
  cmp -s <(catalog "$applied") <(catalog "$d") || fail "re-apply after the rollback differs from a fresh apply"
  # (b) evidence on record: the function goes, the wider constraint and the data stay, a re-apply is accepted
  user_id='00000000-0000-4000-8000-0000000000b1'
  read -r op lease <<<"$(new_operation "$d" "$user_id")"
  [[ -n "$op" && -n "$lease" ]] || fail "rollback (b) setup"
  snap="$(printf '%064d' 1 | tr '0' 'd')"
  val "$d" -c "set local role service_role; select public.record_owned_service_deletion_x_unconfirmed('$user_id'::uuid, 'x_autopost', '$op'::uuid, '$lease'::uuid, 4, '$snap')" >/dev/null
  before_facts="$(val "$d" -c "select reconciliation::text from private.account_lifecycle_operations where id = '$op'::uuid")"
  [[ "$before_facts" == *"$snap"* ]] || fail "rollback (b) setup: the pair was not recorded"
  out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$rollback_file" 2>&1)" || fail "rollback (b): $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  grep -q COMMON_ACCOUNT_X_UNCONFIRMED_ROLLBACK_KEPT_WIDER_SHAPE <<<"$out" || fail "rollback (b) did not say it kept the wider shape"
  [[ "$(has_fn "$d")" == f ]] || fail "rollback (b) left the function"
  [[ "$(val "$d" -c "select reconciliation::text from private.account_lifecycle_operations where id = '$op'::uuid")" == "$before_facts" ]] || fail "rollback (b) lost the recorded evidence"
  must "$d" "$candidate" "re-apply over the kept wider constraint"
  [[ "$(val "$d" -c "select reconciliation::text from private.account_lifecycle_operations where id = '$op'::uuid")" == "$before_facts" ]] || fail "re-apply lost the recorded evidence"
  cmp -s <(catalog "$applied") <(catalog "$d") || fail "re-apply over the kept constraint differs from a fresh apply"
  echo "PASS rollback: clean rollback restores Phase 8 byte for byte, second rollback refused, re-apply = fresh apply; with evidence on record the data and the wider shape stay and a re-apply is accepted"
fi
echo "XU_ALL_PASS"
