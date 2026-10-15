#!/usr/bin/env bash
# Release preflight for the whole common-account chain (F5 Phase 7). DISPOSABLE LOCAL POSTGRESQL ONLY; nothing here
# connects to, reads from or writes to a managed project. One command that proves, on fake data:
#
#   chain     the nine candidate migrations apply in file-name order on the production-shaped baseline; each one
#             refuses out-of-order application with its own fixed code and leaves the catalog byte-identical; each
#             refuses a second application; Phase 3a and Phase 3b commute (so a ledger gap cannot corrupt state);
#             every file is one BEGIN/COMMIT; no duplicate version prefix in supabase/migrations.
#   probe     supabase/preflight/common_account_release_probe.sql (the READ-ONLY probe to run later in a disposable
#             managed project) passes on the full chain, STOPs without the disposable gate, is read-only by
#             construction, and each of 19 deliberate regressions flips the check it is meant to flip.
#   rollback  the emergency rollbacks of Phase 9 -> 8 -> 6 -> 5 -> 4 -> 3b in reverse order restore the previous
#             catalog exactly (documented additive remnants of Phases 6 and 8 only); a forward re-apply reaches the same final
#             catalog; Phase 1's rollback refuses while any later phase is present.
#   matrix    (deno) the Phase 6 provider-state matrix against the real SQL: no fake success, ever.
#   notices   (deno) every server error code has a user-facing notice; the unverified-authorization notice and the
#             POSTONA-end vs common-ID-deletion difference are pinned.
#   runners   the per-phase runners and their mutation suites, as one pass/fail line each.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_release_preflight_run.sh
# Optional: CAL_PREFLIGHT_SECTIONS=chain,probe,rollback,matrix,notices,runners (default: all but runners;
#           CAL_PREFLIGHT_SECTIONS=all runs everything, minutes).
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
migrations="$repo/supabase/migrations"
probe="$repo/supabase/preflight/common_account_release_probe.sql"
sections="${CAL_PREFLIGHT_SECTIONS:-chain,probe,rollback,matrix,notices}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
owner="kb_cal_rp_owner"
other_owner="kb_cal_rp_other_owner"
tag="$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
psql_o() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
psql_q() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
tmp="$(mktemp -d /private/tmp/kabumori-cal-release-preflight.XXXXXX)"
cleanup() {
  local d
  for d in $("${S[@]}" -A -t -d postgres -c "select datname from pg_database where datname like 'kabumori_cal_rp_%_$tag'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "revoke $owner from authenticator" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
db() { echo "kabumori_cal_rp_$1_$tag"; }
mk() { "${S[@]}" -d postgres -c "create database $1 ${2:+template $2} owner $owner" >/dev/null; }
drop_db() { "${S[@]}" -d postgres -c "drop database if exists $1 with (force)" >/dev/null; }

# ---- the chain, in release order ---------------------------------------------------------------------------------
CHAIN_FILES=(
  20261001150000_common_account_lifecycle_foundation.sql
  20261006230000_common_account_service_start_intent.sql
  20261009120000_common_account_deletion_completion.sql
  20261010051938_common_account_service_write_guard.sql
  20261012130000_common_account_core_service_fence.sql
  20261012230000_common_account_service_brand_state.sql
  20261013120000_common_account_service_deletion_ownership.sql
  20261013140000_common_account_service_reconciliation_facts.sql
  20261015090000_common_account_enrollment_session_fence.sql
)
CHAIN_NAMES=(P1 P2 P3a P3b P4 P5 P6 P8 P9)
ALREADY_APPLIED=(
  COMMON_ACCOUNT_FOUNDATION_ALREADY_APPLIED
  COMMON_ACCOUNT_START_INTENT_ALREADY_APPLIED
  COMMON_ACCOUNT_DELETION_COMPLETION_ALREADY_APPLIED
  COMMON_ACCOUNT_WRITE_GUARD_ALREADY_APPLIED
  COMMON_ACCOUNT_CORE_FENCE_ALREADY_APPLIED
  COMMON_ACCOUNT_BRAND_STATE_ALREADY_APPLIED
  COMMON_ACCOUNT_SERVICE_OWNERSHIP_ALREADY_APPLIED
  COMMON_ACCOUNT_RECONCILIATION_ALREADY_APPLIED
  COMMON_ACCOUNT_ENROLLMENT_FENCE_ALREADY_APPLIED
)
# "<migration number>|<state it is applied to: 0 = baseline, k = baseline + first k phases>|<expected refusal>"
ORDER_CASES=(
  "2|0|COMMON_ACCOUNT_START_INTENT_PREFLIGHT_FOUNDATION_MISSING"
  "3|0|COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING"
  "3|1|COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING"
  "4|0|COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_FOUNDATION_MISSING"
  "5|0|COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_FOUNDATION_MISSING"
  "5|3|COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_FOUNDATION_MISSING"
  "6|0|COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_FOUNDATION_MISSING"
  "6|4|COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_FOUNDATION_MISSING"
  "7|0|COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_FOUNDATION_MISSING"
  "7|4|COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_CORE_FENCE_MISSING"
  "7|5|COMMON_ACCOUNT_SERVICE_OWNERSHIP_PREFLIGHT_BRAND_STATE_MISSING"
  "8|0|COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_PHASE6_MISSING"
  "8|6|COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_PHASE6_MISSING"
  "9|0|COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_CHAIN_MISSING"
  "9|7|COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_CHAIN_MISSING"
)

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = '$other_owner') then create role $other_owner nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
SQL

# ---- static properties of the files -------------------------------------------------------------------------------
check_static() {
  local f prev="" listed expected i
  for f in "${CHAIN_FILES[@]}"; do
    [[ -f "$migrations/$f" ]] || fail "static: missing migration $f"
    [[ "$(grep -c '^begin;$' "$migrations/$f")" == 1 && "$(grep -c '^commit;$' "$migrations/$f")" == 1 ]] \
      || fail "static: $f must be exactly one BEGIN ... COMMIT (the schema-first rollout sends the file as written)"
    [[ -z "$prev" || "$prev" < "$f" ]] || fail "static: chain order is not file-name order at $f"
    prev="$f"
  done
  # supabase CLI applies by version prefix: a duplicate prefix anywhere in the directory is a hard failure there.
  local dup
  dup="$(ls "$migrations" | sed -n 's/^\([0-9]\{14\}\)_.*\.sql$/\1/p' | sort | uniq -d | head -3 | tr '\n' ' ')"
  [[ -z "$dup" ]] || fail "static: duplicate migration version prefix: $dup"
  # the listing order of the directory keeps the chain members in release order
  listed="$(ls "$migrations" | grep -F -x -f <(printf '%s\n' "${CHAIN_FILES[@]}") | tr '\n' ' ')"
  expected="$(printf '%s ' "${CHAIN_FILES[@]}")"
  [[ "$listed" == "$expected" ]] || fail "static: directory order differs from the release order"
  # no migration of the chain depends on a LATER member by name (a cheap check for copy/paste dependencies)
  for i in 0 1 2 3 4 5 6 7 8; do
    local j
    for ((j = i + 1; j < 9; j++)); do
      if grep -q "${CHAIN_FILES[$j]%.sql}" "$migrations/${CHAIN_FILES[$i]}"; then
        fail "static: ${CHAIN_NAMES[$i]} names the later migration ${CHAIN_NAMES[$j]}"
      fi
    done
  done
}

# ---- worlds ------------------------------------------------------------------------------------------------------
fingerprint_sql="$tmp/fingerprint.sql"
cat > "$fingerprint_sql" <<'SQL'
select 'fn ' || n.nspname || '.' || p.proname || '(' || array_to_string(p.proargtypes::regtype[], ',') || ') ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(array_to_string(p.proacl::text[], ','), '-')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'private') and p.prokind = 'f' and p.proname not like 'fixture\_%'
union all
select 'rel ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || coalesce(array_to_string(c.relacl::text[], ','), '-')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'private') and c.relname not like 'fixture\_%' and c.relname <> 'kabumori_disposable_marker'
union all
select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(array_to_string(a.attacl::text[], ','), '-')
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('public', 'private') and a.attnum > 0 and not a.attisdropped and c.relname not like 'fixture\_%' and c.relname <> 'kabumori_disposable_marker'
union all
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
  from pg_constraint where conrelid <> 0 and connamespace in ('public'::regnamespace, 'private'::regnamespace)
 and conrelid::regclass::text not like '%fixture\_%' and conrelid::regclass::text not like '%kabumori_disposable_marker%'
union all
select 'pol ' || polrelid::regclass::text || ' ' || polname || ' ' || coalesce(pg_get_expr(polqual, polrelid), '-') from pg_policy
union all
select 'trg ' || (select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = tgrelid) || ' ' || tgname || ' ' || tgenabled::text
  from pg_trigger where not tgisinternal and tgname not like 'fixture\_%'
order by 1;
SQL
fp() { psql_q "$1" -f "$fingerprint_sql"; }
fp_md5() { fp "$1" | md5; }

build_baseline() {  # the production-shaped baseline of every lifecycle suite
  local d="$1"
  psql_o "$d" -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
  psql_o "$d" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
  psql_o "$d" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
  psql_o "$d" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
  psql_o "$d" -f "$here/common_account_lifecycle_fixture.sql" >/dev/null
}
apply_guard_fixture() {  # test stand-ins of the Phase 3b suite (auth.sessions, writers); never part of a candidate
  psql_o "$1" -f "$here/common_account_write_guard_fixture.sql" >/dev/null
  "${S[@]}" -d "$1" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
}

T0="$(db t0)"; T1="$(db t1)"; T2="$(db t2)"; T3="$(db t3)"; T3F="$(db t3f)"; T4="$(db t4)"; T5="$(db t5)"; T6="$(db t6)"; T7="$(db t7)"; T8="$(db t8)"; T9="$(db t9)"
tpl_of() {  # state number -> template database
  case "$1" in 0) echo "$T0" ;; 1) echo "$T1" ;; 2) echo "$T2" ;; 3) echo "$T3F" ;; 4) echo "$T4" ;; 5) echo "$T5" ;; 6) echo "$T6" ;; 7) echo "$T7" ;; 8) echo "$T8" ;; 9) echo "$T9" ;; esac
}
ensure_worlds() {
  [[ -n "${WORLDS_READY:-}" ]] && return 0
  mk "$T0"; build_baseline "$T0"
  mk "$T1" "$T0"; psql_o "$T1" -f "$migrations/${CHAIN_FILES[0]}" >/dev/null
  mk "$T2" "$T1"; psql_o "$T2" -f "$migrations/${CHAIN_FILES[1]}" >/dev/null
  mk "$T3" "$T2"; psql_o "$T3" -f "$migrations/${CHAIN_FILES[2]}" >/dev/null
  mk "$T3F" "$T3"; apply_guard_fixture "$T3F"
  mk "$T4" "$T3F"; psql_o "$T4" -f "$migrations/${CHAIN_FILES[3]}" >/dev/null
  mk "$T5" "$T4"; psql_o "$T5" -f "$migrations/${CHAIN_FILES[4]}" >/dev/null
  mk "$T6" "$T5"; psql_o "$T6" -f "$migrations/${CHAIN_FILES[5]}" >/dev/null
  mk "$T7" "$T6"; psql_o "$T7" -f "$migrations/${CHAIN_FILES[6]}" >/dev/null
  mk "$T8" "$T7"; psql_o "$T8" -f "$migrations/${CHAIN_FILES[7]}" >/dev/null
  mk "$T9" "$T8"; psql_o "$T9" -f "$migrations/${CHAIN_FILES[8]}" >/dev/null
  WORLDS_READY=1
}

refused_with() {  # database file code -> refused with exactly that code; the catalog is byte-identical afterwards
  local d="$1" f="$2" code="$3" before after out
  before="$(fp_md5 "$d")"
  if out="$(psql_o "$d" -f "$f" 2>&1)"; then fail "accepted out of order: $(basename "$f") (expected $code)"; fi
  grep -q "$code" <<<"$out" || fail "wrong refusal for $(basename "$f"): expected $code, got: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  after="$(fp_md5 "$d")"
  [[ "$before" == "$after" ]] || fail "$(basename "$f") left a trace behind its refusal ($code)"
}

# =====================================================================================================================
if want chain; then
  check_static
  echo "PASS chain/static: nine single-transaction files, release order = file order, no duplicate version prefix"
  ensure_worlds
  echo "PASS chain/in-order: Phase 1, 2, 3a, (guard fixture), 3b, 4, 5, 6, 8, 9 apply on the production-shaped baseline"
  n=0
  for entry in "${ORDER_CASES[@]}"; do
    k="${entry%%|*}"; rest="${entry#*|}"; base="${rest%%|*}"; code="${rest#*|}"
    d="$(db "ooo$n")"; n=$((n + 1))
    mk "$d" "$(tpl_of "$base")"
    # Phase 3b and later are meant to run on a world that has the guard stand-ins the suites use.
    if [[ "$k" -ge 4 && "$base" -lt 3 ]]; then apply_guard_fixture "$d"; fi
    refused_with "$d" "$migrations/${CHAIN_FILES[$((k - 1))]}" "$code"
    drop_db "$d"
  done
  echo "PASS chain/dependency: ${#ORDER_CASES[@]} out-of-order applications refused with their own code, nothing left behind"
  i=0
  for f in "${CHAIN_FILES[@]}"; do
    d="$(db "again$i")"
    mk "$d" "$T9"
    refused_with "$d" "$migrations/$f" "${ALREADY_APPLIED[$i]}"
    drop_db "$d"
    i=$((i + 1))
  done
  echo "PASS chain/reapply: each of the nine refuses a second application with its own code"
  # Phase 3b has no Phase 3a requirement (it never calls it). The release order puts 3a first; if a ledger ever had
  # them the other way round, the final catalog must be the same.
  d="$(db commute)"
  mk "$d" "$T2"
  apply_guard_fixture "$d"
  psql_o "$d" -f "$migrations/${CHAIN_FILES[3]}" >/dev/null
  psql_o "$d" -f "$migrations/${CHAIN_FILES[2]}" >/dev/null
  [[ "$(fp_md5 "$d")" == "$(fp_md5 "$T4")" ]] || fail "Phase 3a after Phase 3b does not reach the in-order catalog"
  drop_db "$d"
  echo "PASS chain/commutation: Phase 3a after Phase 3b reaches the same catalog as the release order"
fi

# =====================================================================================================================
run_probe() {  # database [session setting yes|no]
  local d="$1" gate="${2:-yes}"
  if [[ "$gate" == yes ]]; then
    PGOPTIONS='-c kabumori.disposable_probe=yes' psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$probe"
  else
    psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$probe"
  fi
}
probe_line() { grep -E "^$2\\|" <<<"$1" | head -1; }
install_ledger() {  # the managed project's ledger, stood in with the nine versions
  psql_q "$1" -c "create schema if not exists supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text);
                  insert into supabase_migrations.schema_migrations (version, name)
                  select split_part(v, '_', 1), substr(v, 16) from unnest(array[
                    '20261001150000_x', '20261006230000_x', '20261009120000_x', '20261010051938_x', '20261012130000_x', '20261012230000_x', '20261013120000_x', '20261013140000_x', '20261015090000_x']) v" >/dev/null
}
install_marker() {
  psql_q "$1" -c "create table if not exists public.kabumori_disposable_marker (project_ref text primary key, created_at timestamptz default now());
                  insert into public.kabumori_disposable_marker (project_ref) values ('local-disposable') on conflict do nothing" >/dev/null
}

if want probe; then
  ensure_worlds
  # read-only by construction: no statement keyword that writes, outside comments and string literals' words
  stripped="$tmp/probe.stripped.sql"
  sed -E -e 's/--.*$//' -e "s/'[^']*'//g" "$probe" > "$stripped"
  if grep -Eiw '(insert|update|delete|create|drop|alter|grant|revoke|truncate|copy|call|do|vacuum|reindex|cluster|refresh|comment|lock|notify|listen|set_config|pg_terminate_backend|pg_cancel_backend|dblink)' "$stripped" \
       | grep -viE "set local|current_setting|begin read only" | head -3 | grep -q .; then
    echo "static: possible writing keyword in the probe:" >&2
    grep -Eiw '(insert|update|delete|create|drop|alter|grant|revoke|truncate|copy|call|do|vacuum|reindex|cluster|refresh|comment|lock|notify|listen|set_config)' "$stripped" | head -5 >&2
    fail "the probe is not provably read-only"
  fi
  grep -q '^begin read only;$' "$probe" || fail "the probe must run in one READ ONLY transaction"
  echo "PASS probe/static: one read-only transaction, no writing keyword"

  pd="$(db probe)"
  mk "$pd" "$T9"
  out="$(run_probe "$pd" yes)"
  [[ "$(probe_line "$out" G0_disposable_gate)" == G0_disposable_gate\|STOP\|* ]] || fail "the probe must STOP without the disposable marker"
  [[ "$(wc -l <<<"$out" | tr -d ' ')" == 2 ]] || fail "a stopped probe must print only the STOP line and the result"
  install_marker "$pd"
  out="$(run_probe "$pd" no)"
  [[ "$(probe_line "$out" G0_disposable_gate)" == G0_disposable_gate\|STOP\|* ]] || fail "the probe must STOP without the session setting"
  out="$(run_probe "$pd" yes)"
  [[ "$(probe_line "$out" RELEASE_PREFLIGHT)" == RELEASE_PREFLIGHT\|PASS\|fail=0\ * ]] || { echo "$out" >&2; fail "the probe must PASS on the full chain"; }
  grep -q '^A3_ledger|WARN|' <<<"$out" || fail "an absent ledger must be a WARN (managed-only)"
  echo "PASS probe/gate: STOP without marker and without session setting; PASS (fail=0) on the full chain: $(probe_line "$out" RELEASE_PREFLIGHT)"

  install_ledger "$pd"
  out="$(run_probe "$pd" yes)"
  grep -q '^A3_ledger|PASS|' <<<"$out" && grep -q '^A4_ledger_no_gap|PASS|' <<<"$out" || { echo "$out" >&2; fail "a complete ledger must pass A3/A4"; }
  echo "PASS probe/ledger: a complete ledger passes"

  # deliberate regressions: name | owner-or-super | SQL | expected check id | expected status
  mutate() {  # label as sql id status
    local label="$1" as="$2" sqltext="$3" id="$4" status="$5" md out line
    md="$(db "m$RANDOM")"
    mk "$md" "$pd"
    if [[ "$as" == super ]]; then "${S[@]}" -d "$md" -c "$sqltext" >/dev/null; else psql_q "$md" -c "$sqltext" >/dev/null; fi
    out="$(run_probe "$md" yes)"
    line="$(probe_line "$out" "$id")"
    drop_db "$md"
    [[ "$line" == "$id|$status|"* ]] || { echo "$out" >&2; fail "regression not caught: $label (expected $id|$status, got: ${line:-none})"; }
    if [[ "$status" == FAIL ]]; then
      [[ "$(probe_line "$out" RELEASE_PREFLIGHT)" == RELEASE_PREFLIGHT\|FAIL\|* ]] || fail "regression did not fail the release line: $label"
    fi
  }
  mutate "an internal lock function reachable by authenticated" owner "grant execute on function private.account_lifecycle_lock(uuid,boolean,boolean) to authenticated" B2_function_attributes FAIL
  mutate "a service function open to PUBLIC" owner "grant execute on function public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer) to public" B3_function_public_execute FAIL
  mutate "a definer function without a pinned search_path" owner "alter function public.start_kabumori_service() reset search_path" B2_function_attributes FAIL
  mutate "RLS disabled on common_accounts" owner "alter table public.common_accounts disable row level security" C2_rls_enabled_on_tables FAIL
  mutate "an extra policy on service_entitlements" owner "create policy p_extra on public.service_entitlements for select to anon using (true)" C5_policies_exact FAIL
  mutate "a table-level SELECT grant to authenticated" owner "grant select on public.service_entitlements to authenticated" C3_no_table_level_api_grants FAIL
  mutate "the account delete guard trigger disabled" owner "alter table public.common_accounts disable trigger account_lifecycle_guard_account_delete" D1_triggers_present_and_enabled FAIL
  mutate "an unknown lifecycle function" owner "create function private.account_lifecycle_extra() returns int language sql as \$f\$ select 1 \$f\$" B4_function_unknown FAIL
  mutate "a function owned by another role" super "alter function public.begin_service_deletion(uuid,text) owner to $other_owner" B5_owner_uniform FAIL
  mutate "the managed delete gate open" owner "alter table private.account_lifecycle_release_gates drop constraint account_lifecycle_release_gates_blocked_only; update private.account_lifecycle_release_gates set state = 'open'" E1_release_gate_blocked FAIL
  mutate "integration started (state drift)" owner "update private.account_lifecycle_settings set integration_state = 'started'" E2_settings_affirmed WARN
  mutate "a phase function missing" owner "drop function public.claim_service_deletion(uuid,text,uuid,uuid,uuid,integer)" A2_phase_all_present FAIL
  mutate "a ledger gap (3b present, 3a missing)" owner "delete from supabase_migrations.schema_migrations where version = '20261009120000'" A4_ledger_no_gap FAIL
  mutate "a lifecycle trigger on auth.users" owner "create trigger rp_extra after delete on auth.users for each row execute function private.account_lifecycle_touch_account()" D3_no_chain_trigger_on_auth_users FAIL
  mutate "the Phase 6 columns dropped" owner "alter table private.account_lifecycle_operations drop column provider_results cascade" E4_phase6_columns FAIL
  mutate "the Phase 8 reconciliation column dropped" owner "alter table private.account_lifecycle_operations drop column reconciliation" E4_phase8_column FAIL
  mutate "a restart wrapper without the enrollment fence" owner "create or replace function public.reactivate_x_autopost_service(p_expected_lifecycle_version bigint) returns jsonb language sql volatile security definer set search_path = '' as \$f\$ select private.account_lifecycle_reactivate_service((select auth.uid()), 'x_autopost', p_expected_lifecycle_version) \$f\$" E5_enrollment_fence_wired FAIL
  # B6 changes a cluster-wide role membership: granted, probed and revoked in one go (never left behind)
  md="$(db mb6)"; mk "$md" "$pd"
  "${S[@]}" -d postgres -c "grant $owner to authenticator" >/dev/null
  out="$(run_probe "$md" yes)" || true
  "${S[@]}" -d postgres -c "revoke $owner from authenticator" >/dev/null
  drop_db "$md"
  [[ "$(probe_line "$out" B6_owner_is_not_an_api_role_member)" == B6_owner_is_not_an_api_role_member\|FAIL\|* ]] || fail "an API role inheriting the owner must fail B6"
  # K1 positive and negative (a per-database setting: nothing leaks to other tests)
  md="$(db mk1)"; mk "$md" "$pd"
  "${S[@]}" -d postgres -c "alter role authenticator in database $md set pgrst.db_schemas = 'public,graphql_public'" >/dev/null
  out="$(run_probe "$md" yes)"; [[ "$(probe_line "$out" K1_private_schema_not_exposed)" == K1_private_schema_not_exposed\|PASS\|* ]] || fail "K1 must pass when private is not exposed"
  "${S[@]}" -d postgres -c "alter role authenticator in database $md set pgrst.db_schemas = 'public,private'" >/dev/null
  out="$(run_probe "$md" yes)"; [[ "$(probe_line "$out" K1_private_schema_not_exposed)" == K1_private_schema_not_exposed\|FAIL\|* ]] || fail "K1 must fail when private is exposed"
  drop_db "$md"
  echo "PASS probe/regressions: 19 deliberate regressions (18 SQL changes + the owner membership) each flip the check they are meant to flip"

  # a world that stopped at an earlier phase must not pass A2 (and must say which phases are missing)
  md="$(db early)"; mk "$md" "$T8"; install_marker "$md"
  out="$(run_probe "$md" yes)"
  [[ "$(probe_line "$out" A2_phase_all_present)" == A2_phase_all_present\|FAIL\|absent:\ P9 ]] || fail "a world without Phase 9 must fail A2 and name Phase 9"
  [[ "$(probe_line "$out" A1_phase_prefix)" == A1_phase_prefix\|PASS\|* ]] || fail "a world that stopped cleanly after Phase 8 is a prefix"
  [[ "$(probe_line "$out" RELEASE_PREFLIGHT)" == RELEASE_PREFLIGHT\|FAIL\|* ]] || fail "a world without Phase 9 must fail the release line"
  drop_db "$md"
  md="$(db early8)"; mk "$md" "$T7"; install_marker "$md"
  out="$(run_probe "$md" yes)"
  [[ "$(probe_line "$out" A2_phase_all_present)" == A2_phase_all_present\|FAIL\|absent:\ P8,P9 ]] || fail "a world without Phases 8 and 9 must name both"
  drop_db "$md"
  md="$(db early6)"; mk "$md" "$T6"; install_marker "$md"
  out="$(run_probe "$md" yes)"
  [[ "$(probe_line "$out" A2_phase_all_present)" == A2_phase_all_present\|FAIL\|absent:\ P6,P8,P9 ]] || fail "a world without Phases 6, 8 and 9 must name all three"
  drop_db "$md"
  md="$(db early2)"; mk "$md" "$T5"; install_marker "$md"
  out="$(run_probe "$md" yes)"
  [[ "$(probe_line "$out" A2_phase_all_present)" == A2_phase_all_present\|FAIL\|absent:\ P5,P6,P8,P9 ]] || fail "a world without Phases 5, 6, 8 and 9 must name all four"
  drop_db "$md"
  echo "PASS probe/partial: a world that stopped after Phase 4, 5, 6 or 8 fails the release line and names what is missing"
fi

# =====================================================================================================================
if want rollback; then
  ensure_worlds
  snap() { fp "$1" | grep -v ' kb_cal_rp_owner=X/' ; }
  fp "$T3F" > "$tmp/s_t3f.txt"; fp "$T4" > "$tmp/s_t4.txt"; fp "$T5" > "$tmp/s_t5.txt"; fp "$T6" > "$tmp/s_t6.txt"; fp "$T7" > "$tmp/s_t7.txt"
  fp "$T8" > "$tmp/s_t8.txt"; fp "$T9" > "$tmp/s_t9.txt"
  rb="$(db rb)"
  mk "$rb" "$T9"
  # Phase 6 keeps its additive columns and the two check constraints on them on purpose (data survives a rollback);
  # nothing else of any phase may remain.
  remnants="$tmp/remnants.txt"
  cat > "$remnants" <<'TXT'
col private.account_lifecycle_operations.provider_results jsonb -
col private.account_lifecycle_operations.remote_unverified_ack_at timestamp with time zone -
col private.account_lifecycle_operations.remote_unverified_ack_providers text[] -
con private.account_lifecycle_operations account_lifecycle_operations_ack_shape CHECK (((remote_unverified_ack_at IS NULL) = (remote_unverified_ack_providers IS NULL)))
con private.account_lifecycle_operations account_lifecycle_operations_provider_results_shape CHECK ((jsonb_typeof(provider_results) = 'object'::text))
col private.account_lifecycle_operations.reconciliation jsonb -
con private.account_lifecycle_operations account_lifecycle_operations_reconciliation_shape CHECK (((jsonb_typeof(reconciliation) = 'object'::text) AND ((reconciliation - 'x_posts_unconfirmed'::text) = '{}'::jsonb) AND ((NOT (reconciliation ? 'x_posts_unconfirmed'::text)) OR (jsonb_typeof((reconciliation -> 'x_posts_unconfirmed'::text)) = 'number'::text))))
TXT
  # Phase 4's rollback puts public.ensure_my_profile() back as the REAL migration 20260924100000 defines it; the
  # test baseline carries the lifecycle fixture's stand-in instead. That one function is therefore compared by value
  # (the real migration's definition, applied in a scratch copy) and left out of the catalog comparison.
  ens="$(db ens)"; mk "$ens" "$T0"
  psql_o "$ens" -f "$migrations/20260924100000_ensure_my_profile.sql" >/dev/null || fail "real ensure_my_profile migration"
  real_ensure_md5="$(psql_q "$ens" -c "select md5(pg_get_functiondef('public.ensure_my_profile()'::regprocedure))")"
  drop_db "$ens"
  step() {  # label file expected-snapshot
    local label="$1" file="$2" ref="$3" now
    psql_o "$rb" -f "$file" >/dev/null 2>&1 || fail "rollback of $label was refused or failed"
    fp "$rb" | grep -v '^fn public.ensure_my_profile() ' > "$tmp/now.txt"
    grep -v '^fn public.ensure_my_profile() ' "$ref" > "$tmp/ref.txt"; ref="$tmp/ref.txt"
    # what is in the rolled-back catalog but not in the reference must be exactly the documented remnants (or nothing)
    comm -13 "$ref" "$tmp/now.txt" > "$tmp/extra.txt" || true
    comm -23 "$ref" "$tmp/now.txt" > "$tmp/gone.txt" || true
    [[ ! -s "$tmp/gone.txt" ]] || { cat "$tmp/gone.txt" >&2; fail "rollback of $label removed something the previous state had"; }
    if [[ -s "$tmp/extra.txt" ]]; then
      sort "$remnants" > "$tmp/remnants.sorted"; sort "$tmp/extra.txt" > "$tmp/extra.sorted"
      [[ -z "$(comm -13 "$tmp/remnants.sorted" "$tmp/extra.sorted")" ]] || { comm -13 "$tmp/remnants.sorted" "$tmp/extra.sorted" >&2; fail "rollback of $label left more than the documented remnants"; }
    fi
  }
  step "Phase 9" "$here/common_account_enrollment_fence_rollback.sql" "$tmp/s_t8.txt"
  step "Phase 8" "$here/common_account_service_reconciliation_rollback.sql" "$tmp/s_t7.txt"
  step "Phase 6" "$here/common_account_service_deletion_rollback.sql" "$tmp/s_t6.txt"
  step "Phase 5" "$here/common_account_brand_state_rollback.sql" "$tmp/s_t5.txt"
  step "Phase 4" "$here/common_account_core_fence_rollback.sql" "$tmp/s_t4.txt"
  [[ "$(psql_q "$rb" -c "select md5(pg_get_functiondef('public.ensure_my_profile()'::regprocedure))")" == "$real_ensure_md5" ]] \
    || fail "Phase 4 rollback did not put the real ensure_my_profile() back"
  step "Phase 3b" "$here/common_account_write_guard_rollback.sql" "$tmp/s_t3f.txt"
  echo "PASS rollback/reverse: Phase 9 -> 8 -> 6 -> 5 -> 4 -> 3b each restore the previous catalog exactly (Phase 6 and 8 additive remnants only)"
  # forward again from the rolled-back state: the same final catalog
  for i in 3 4 5 6 7 8; do psql_o "$rb" -f "$migrations/${CHAIN_FILES[$i]}" >/dev/null || fail "re-apply of ${CHAIN_NAMES[$i]} after rollback"; done
  [[ "$(fp_md5 "$rb")" == "$(fp_md5 "$T9")" ]] || fail "re-applying forward after the rollbacks does not reach the final catalog"
  drop_db "$rb"
  echo "PASS rollback/reapply: forward again reaches the identical final catalog"
  # Phase 1 drops tables and its dependants are plpgsql (no recorded dependency): it must refuse by itself
  for st in 2 9; do
    d="$(db "p1rb$st")"; mk "$d" "$(tpl_of "$st")"
    before="$(fp_md5 "$d")"
    out="$(psql_o "$d" -f "$here/common_account_lifecycle_rollback.sql" 2>&1)" && fail "Phase 1 rollback ran with a later phase present (state $st)"
    grep -q "COMMON_ACCOUNT_ROLLBACK_REFUSED_LATER_PHASE_PRESENT\|because other objects depend" <<<"$out" || fail "Phase 1 rollback refusal at state $st: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
    [[ "$(fp_md5 "$d")" == "$before" ]] || fail "Phase 1 rollback left a trace at state $st"
    drop_db "$d"
  done
  echo "PASS rollback/phase1: refused while Phase 2 or any later phase is present; nothing removed"
  # Phase 1 on its own still restores the baseline exactly
  d="$(db p1only)"; mk "$d" "$T1"
  psql_o "$d" -f "$here/common_account_lifecycle_rollback.sql" >/dev/null || fail "Phase 1 rollback on a Phase-1-only world"
  [[ "$(fp_md5 "$d")" == "$(fp_md5 "$T0")" ]] || fail "Phase 1 rollback on its own did not restore the baseline"
  drop_db "$d"
  echo "PASS rollback/phase1-alone: the baseline is restored exactly"
fi

# =====================================================================================================================
deno_test() {  # database test-file
  ( cd "$repo" && CAL_E2E=1 PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$1" \
      deno test --no-config --no-check --allow-run=psql --allow-env --allow-read "$2" ) > "$tmp/deno.log" 2>&1 \
    || { sed 's/\x1b\[[0-9;]*m//g' "$tmp/deno.log" >&2; fail "$2"; }
  sed 's/\x1b\[[0-9;]*m//g' "$tmp/deno.log" | grep -E "passed|failed" | tail -1
}
if want matrix; then
  ensure_worlds
  md="$(db matrix)"; mk "$md" "$T9"
  psql_o "$md" -f "$here/common_account_core_fence_fixture.sql" >/dev/null
  # TEST STAND-IN: the platform check widened as the real Phase 2a-2 migration (20261007150000) does
  psql_o "$md" -c "alter table public.social_accounts drop constraint social_accounts_platform_check;
                   alter table public.social_accounts add constraint social_accounts_platform_check check (platform in ('x', 'threads'))" >/dev/null
  deno_test "$md" supabase/tests/common_account_phase7_provider_matrix_test.ts
  drop_db "$md"
  echo "PASS matrix: provider-state matrix against the real SQL"
fi
if want notices; then
  ( cd "$repo" && deno test --no-config --no-check --allow-read supabase/tests/common_account_phase7_notices_test.ts ) > "$tmp/deno.log" 2>&1 \
    || { sed 's/\x1b\[[0-9;]*m//g' "$tmp/deno.log" >&2; fail "notices"; }
  sed 's/\x1b\[[0-9;]*m//g' "$tmp/deno.log" | grep -E "passed|failed" | tail -1
  echo "PASS notices: server codes covered, unverified-authorization notice pinned"
fi

# =====================================================================================================================
if want runners; then
  for r in common_account_lifecycle_run.sh common_account_service_start_intent_run.sh common_account_deletion_completion_run.sh \
           common_account_write_guard_run.sh common_account_core_fence_run.sh common_account_brand_state_run.sh common_account_service_deletion_run.sh \
           common_account_service_reconciliation_run.sh; do
    if bash "$here/$r" > "$tmp/runner.log" 2>&1; then
      echo "PASS runners/$r: $(tail -1 "$tmp/runner.log")"
    else
      tail -15 "$tmp/runner.log" >&2
      fail "runners/$r"
    fi
  done
fi

echo "COMMON_ACCOUNT_RELEASE_PREFLIGHT_ALL_PASS"
