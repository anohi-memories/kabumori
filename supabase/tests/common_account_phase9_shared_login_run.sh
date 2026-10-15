#!/usr/bin/env bash
# F5 Phase 9: POSTONA-first shared sign-in and enrollment, proven OFFLINE.
#
# One disposable local PostgreSQL 17 holding the production-shaped baseline plus the whole common-account chain
# (Phase 1, 2, 3a, 3b, 4, 5, 6, 8) -- and NOTHING of F3 / F4 / G4 (POSTONA's login and enrollment must not depend on
# them) and nothing of Kabumori's own tables beyond the fixture's `profiles`. In front of it two test seams:
#
#   fake GoTrue     an HTTP stand-in that creates `auth.users` / `auth.identities` / `auth.sessions` rows and mints
#                   HS256 access tokens carrying `sub`, `session_id`, `role`, `exp` (sign-up, password / provider
#                   sign-in, refresh, sign-out, admin delete)
#   fake PostgREST  an HTTP stand-in that verifies the token, takes role + claims from it and calls ONLY the named
#                   public RPC as that database role in one transaction (SQLSTATE -> HTTP status)
#
# The POSTONA and Kabumori enrollment modules run unmodified against them (real fetch, real RPC names).
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_phase9_shared_login_run.sh
# Optional: CAL_P9_SECTIONS=world,fence,e2e   CAL_P9_KEEP=1 keeps the databases (name printed);
#           CAL_P9_FENCE=<file> runs the fence proofs against another copy of the migration (mutation runs).
set -euo pipefail
export LC_ALL=C PGTZ=UTC

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
sections="${CAL_P9_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
fail() { echo "FAIL $*" >&2; exit 1; }

n="$$"
owner="kb_p9_owner_$n"
prefix="kabumori_p9_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-phase9.XXXXXX)"
cleanup() {
  local d
  if [[ "${CAL_P9_KEEP:-0}" != 1 ]]; then
    for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
      "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
    done
    "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
    rm -rf "$tmp"
  else
    echo "kept databases ${prefix}_* and $tmp"
  fi
}
trap cleanup EXIT

# ---- roles and databases --------------------------------------------------------------------------------------------
for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_p9\_%'"); do
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
must() {  # database file label
  local out
  if ! out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$1" -f "$2" 2>&1)"; then
    fail "$3 did not apply: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  fi
}

# ---- 1. the world: production-shaped baseline + the whole chain ---------------------------------------------------
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
         20261013140000_common_account_service_reconciliation_facts.sql; do
  must "$world" "$m/$f" "$f"
done
echo "PASS world: baseline + Phase 1, 2, 3a, 3b, 4, 5, 6, 8 (no F3 / F4 / G4)"

# the same world with and without the Phase 9 fence (the "without" is the fail-before evidence)
fence_mig="${CAL_P9_FENCE:-$m/20261015090000_common_account_enrollment_session_fence.sql}"
fence_rb="$t/common_account_enrollment_fence_rollback.sql"
catalog() { val "$1" -f "$t/common_account_phase8_catalog.sql"; }
nofence="$(copy nofence "$world")"
fenced="$(copy fenced "$world")"
must "$fenced" "$fence_mig" "the Phase 9 enrollment fence"
echo "PHASE9_WORLD_READY $world"

# ---- 2. the migration's own proof -----------------------------------------------------------------------------------
if want fence; then
  has_fence() { val "$1" -c "select to_regprocedure('private.account_lifecycle_enrollment_fence(uuid,boolean)') is not null"; }
  refused_with() {  # database code [fence-present: t|f] -> refused with it, nothing left behind
    local d="$1" code="$2" present="${3:-f}" out before after
    before="$(catalog "$d" | shasum -a 256)"
    if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$fence_mig" 2>&1)"; then fail "preflight accepted: expected $code"; fi
    grep -q "$code" <<<"$out" || fail "preflight reason (expected $code): $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
    [[ "$(has_fence "$d")" == "$present" ]] || fail "preflight changed the fence ($code)"
    after="$(catalog "$d" | shasum -a 256)"
    [[ "$before" == "$after" ]] || fail "preflight changed the catalog ($code)"
  }
  d="$(copy pf_chain "$world")"; val "$d" -c "alter function private.account_lifecycle_start_service(uuid,text) rename to account_lifecycle_start_service_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_CHAIN_MISSING
  d="$(copy pf_chain2 "$world")"; val "$d" -c "alter function private.account_lifecycle_reactivate_service(uuid,text,bigint) rename to account_lifecycle_reactivate_service_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_CHAIN_MISSING
  d="$(copy pf_drift "$world")"
  val "$d" -c "create or replace function public.start_x_autopost_service() returns jsonb language sql volatile security definer set search_path = '' as \$f\$ select private.account_lifecycle_start_service((select auth.uid()), 'x_autopost') /* edited */ \$f\$" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_DRIFT
  d="$(copy pf_acl "$world")"; val "$d" -c "grant execute on function public.reactivate_x_autopost_service(bigint) to anon" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_ACL
  d="$(copy pf_sessions "$world")"; val "$d" -c "alter table auth.sessions rename to sessions_moved" >/dev/null
  refused_with "$d" COMMON_ACCOUNT_ENROLLMENT_FENCE_PREFLIGHT_AUTH_SESSIONS
  refused_with "$fenced" COMMON_ACCOUNT_ENROLLMENT_FENCE_ALREADY_APPLIED t
  echo "PASS fence/preflight: missing chain, drifted body, widened ACL, no session table and a second apply are refused with their own code; nothing is left behind"

  # exact change: one new internal function; the five public ones keep name, signature, owner and ACL (only the body moves)
  strip() { sed -E 's/^(fn [^ ]+) [0-9a-f]{32} /\1 /'; }
  catalog "$world" | strip | LC_ALL=C sort > "$tmp/cat_before"
  catalog "$fenced" | strip | LC_ALL=C sort > "$tmp/cat_after"
  removed="$(comm -23 "$tmp/cat_before" "$tmp/cat_after")"
  added="$(comm -13 "$tmp/cat_before" "$tmp/cat_after")"
  [[ -z "$removed" ]] || { echo "$removed" >&2; fail "the migration removed or altered something besides function bodies"; }
  [[ "$(wc -l <<<"$added" | tr -d ' ')" == 1 && "$added" == "fn private.account_lifecycle_enrollment_fence(uuid,boolean) "* ]] || { echo "$added" >&2; fail "unexpected additions"; }
  bodies_changed="$(catalog "$world" | LC_ALL=C sort | comm -23 - <(catalog "$fenced" | LC_ALL=C sort) | wc -l | tr -d ' ')"
  [[ "$bodies_changed" == 5 ]] || fail "expected exactly five replaced bodies, saw $bodies_changed"
  echo "PASS fence/exact: one internal function added, five public bodies replaced, no table, column, grant, policy or trigger changed"

  # static: nothing destructive, no widening
  code="$(sed -e 's/--.*$//' "$fence_mig")"
  if grep -qiE '(^|[[:space:]])cascade([[:space:]]|;|$)' <<<"$code"; then fail "CASCADE appears"; fi
  if grep -qiE 'delete[[:space:]]+from|truncate|drop[[:space:]]+(table|schema|column|trigger|policy|function)|create[[:space:]]+table|alter[[:space:]]+table|auth\.users[[:space:]]+(set|for update)' <<<"$code"; then fail "unexpected statement in the migration"; fi
  if grep -iE '^[[:space:]]*grant[[:space:]]' <<<"$code" | grep -viE 'to authenticated;' >/dev/null; then fail "a grant to something other than authenticated"; fi
  [[ "$(grep -ciE 'security definer set search_path = ' <<<"$code")" == 6 ]] || fail "all six functions must be SECURITY DEFINER with an empty search_path"
  echo "PASS fence/static: no CASCADE, no table change, no destructive statement, grants only to authenticated"

  out="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$fenced" -f "$t/common_account_phase9_fence_behavior.sql" 2>&1)" \
    || { echo "$out" | tail -8 >&2; fail "fence behavior suite"; }
  grep -qx COMMON_ACCOUNT_ENROLLMENT_FENCE_BEHAVIOR_PASS <<<"$out" || fail "fence behavior suite incomplete"
  echo "PASS fence/behavior: both claim sources, guest sessions, live / expired / foreign / missing sessions, unreadable session table (fail closed)"

  # rollback: the five bodies are exactly Phase 1/2/4's again (md5 pins), the catalog is the unfenced world's, a re-apply works
  d="$(copy rb "$fenced")"
  own "$d" -f "$fence_rb" >/dev/null
  [[ "$(has_fence "$d")" == f ]] || fail "rollback left the fence"
  cmp -s <(catalog "$world") <(catalog "$d") || fail "rollback did not restore the unfenced catalog byte for byte"
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$fence_rb" 2>&1)"; then fail "rollback ran twice"; fi
  grep -q COMMON_ACCOUNT_ENROLLMENT_FENCE_ROLLBACK_NOT_APPLIED <<<"$out" || fail "second rollback reason"
  own "$d" -f "$fence_mig" >/dev/null
  cmp -s <(catalog "$fenced") <(catalog "$d") || fail "re-apply after rollback does not reach the fenced catalog"
  echo "PASS fence/rollback: bodies restored byte for byte, second rollback refused, re-apply reaches the same catalog"
fi

# ---- 3. the apps' real modules over the seams -----------------------------------------------------------------------
if want e2e; then
  ( cd "$repo" && CAL_E2E=1 PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$fenced" PGDATABASE_NOFENCE="$nofence" \
      deno test --no-config --no-check --allow-run=psql --allow-net=127.0.0.1 --allow-env --allow-read supabase/tests/common_account_phase9_shared_login_test.ts ) > "$tmp/deno.log" 2>&1 \
    || { sed 's/\x1b\[[0-9;]*m//g' "$tmp/deno.log" | grep -v '^$' | head -60 >&2; fail "shared sign-in end-to-end"; }
  sed 's/\x1b\[[0-9;]*m//g' "$tmp/deno.log" | grep -E "passed|failed" | tail -1
  echo "PASS e2e: the POSTONA and Kabumori enrollment modules (unmodified) against the fake GoTrue / PostgREST seams and the real SQL"
fi
echo "PHASE9_ALL_PASS"
