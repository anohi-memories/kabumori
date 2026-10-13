#!/usr/bin/env bash
# F5 Phase 8: the common account (Phase 1..8) + F3's X service-end saga + F4's Threads cleanup, assembled in ONE
# disposable local database from the REAL sources of three stacks, none of them modified:
#
#   F5  this checkout (PR #121 -> #152 -> #165 -> #178 -> #183 -> Phase 8)           G5 owns the common lifecycle
#   F3  PR #189 head (PR #145 -> #151 -> #163 -> #168 -> #182 -> #189)               X reservations, publish guard, saga stop
#   F4  PR #180 head (PR #167 -> #169 -> #180) + G4 PR #124 (two read-only files)    Threads OAuth / publish / cleanup / guards
#
# The F3 and F4 trees come from `git archive` of their branch heads into a throw-away directory; the repository,
# the branches and the worktrees of F3, F4, G4 and H5 are never touched. Nothing here connects to a managed project.
# Local Unix-socket PostgreSQL 17 only, fake data only, no X / Threads / Meta call (revocations are fakes).
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_phase8_integrated_run.sh
# Optional: F3_SHA, F4_SHA, PR124_SHA (default: the heads pinned below); CAL_P8_SECTIONS=world,x_regression,...;
#           KEEP=1 keeps the assembled tree.
set -euo pipefail
export LC_ALL=C PGTZ=UTC

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
F3="${F3_SHA:-4fd7084d067d2a9f589fd7fecaee70720bc60812}"
F4="${F4_SHA:-7c4f457834cddb42b72be6b74996e643b213e8c8}"
PR124="${PR124_SHA:-c30f246409a77080cbc03aef6c4cb72b5481e125}"
sections="${CAL_P8_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }
fail() { echo "FAIL $*" >&2; exit 1; }
for sha in "$F3" "$F4" "$PR124"; do git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"; done

tree="$(mktemp -d /private/tmp/kabumori-phase8-integrated.XXXXXX)"
n="$$"
owner="kb_p8_owner_$n"
prefix="kabumori_p8_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  if [[ "${CAL_P8_KEEP_DBS:-0}" != 1 ]]; then
    for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
      "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
    done
    "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
    "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. The three read-only trees ---------------------------------------------------------------------------------
mkdir -p "$tree/f3" "$tree/f4" "$tree/g4"
git -C "$repo" archive "$F3" | tar -x -C "$tree/f3"
git -C "$repo" archive "$F4" | tar -x -C "$tree/f4"
for path in supabase/candidates/postona_threads_oauth_workspace_candidate.sql supabase/tests/postona_threads_oauth_test_fixture.sql; do
  mkdir -p "$tree/g4/$(dirname "$path")"
  git -C "$repo" archive "$PR124" -- "$path" | tar -x -C "$tree/g4"
done
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
f3c="$tree/f3/supabase/candidates"; f4c="$tree/f4/supabase/candidates"; f4t="$tree/f4/supabase/tests"
x_ent="$f3c/postona_x_publish_entitlement"; x_resv="$f3c/postona_x_reservations"
{
  echo "F3 $F3"; echo "F4 $F4"; echo "PR124 $PR124"; echo "F5 $(git -C "$repo" rev-parse HEAD) (+ working tree)"
} > "$tree/MANIFEST.txt"

# ---- 2. Roles and databases ---------------------------------------------------------------------------------------
# Leftovers of an earlier run that kept its databases (CAL_P8_KEEP_DBS=1) hold the role this assembly recreates.
for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_p8\_%'"); do
  "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null
done
"${S[@]}" -d postgres >/dev/null <<SQL
drop role if exists postona_resv_api;
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
apply() {  # database file -> "applied" or the first error message
  local d="$1" file="$2" out
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$file" 2>&1)"; then echo applied
  else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}
must() {  # database file label
  local out; out="$(apply "$1" "$2")"
  [[ "$out" == applied ]] || fail "$3 did not apply: $out"
}

# ---- 3. The world (the production order of the real migrations; candidates after them) ----------------------------
# The stages are functions so that the apply-order section can rebuild a stage on an earlier snapshot.
f5_base() {  # database: main's migrations + F5 Phase 1, 2, 3a (the common account foundation)
  local d="$1" f
  own "$d" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
  own "$d" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
  for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
    own "$d" -f "$m/$f" >/dev/null
  done
  own "$d" -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
  for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
    own "$d" -f "$m/$f" >/dev/null
  done
}
f5_fence() {  # database: Phase 3b writer guard + Phase 4 core fence
  local d="$1" f
  own "$d" -f "$t/common_account_write_guard_fixture.sql" >/dev/null
  "${S[@]}" -d "$d" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
  for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql; do
    must "$d" "$m/$f" "F5 $f"
  done
}
f5_rest() {  # database: Phase 5 workspace state, Phase 6 service-deletion ownership, Phase 8 reconciliation facts
  local d="$1" f
  for f in 20261012230000_common_account_service_brand_state.sql 20261013120000_common_account_service_deletion_ownership.sql \
           20261013140000_common_account_service_reconciliation_facts.sql; do
    must "$d" "$m/$f" "F5 $f"
  done
}
x_resv_stack() {  # database [shared-role]: F3's Stage 3B stand-ins and authority, reservations 001-003
  local d="$1" f002="$x_resv/002_postona_x_resv_api_role.sql"
  own "$d" -f "$x_ent/test_stand_ins.sql" >/dev/null
  must "$d" "$m/20261006160200_x_account_publish_authority.sql" "the real Stage 3B authority migration"
  must "$d" "$x_resv/001_postona_x_reservations.sql" "F3 reservations 001"
  if [[ "${2:-}" == shared-role ]]; then
    # HARNESS ADAPTATION (the role is cluster-wide and already exists from the first build): the same file without its
    # `create role` and its role-exists refusal; every other statement (grants, ownership checks) is F3's own.
    sed -e "/^create role postona_resv_api /d" -e "s/ or to_regrole('postona_resv_api') is not null//" "$f002" > "$tree/002_shared_role.sql"
    [[ "$(diff "$f002" "$tree/002_shared_role.sql" | grep -c '^[<>]')" == 3 ]] || fail "the shared-role adaptation of F3 002 changed more than one deleted and one edited line"
    f002="$tree/002_shared_role.sql"
  fi
  must "$d" "$f002" "F3 reservations 002"
  # TEST STAND-IN: the tests act as the reservation API role (as PostgREST would after the JWT role switch)
  "${S[@]}" -d postgres -c "grant postona_resv_api to $owner with set true, inherit true" >/dev/null
  must "$d" "$x_resv/003_postona_x_resv_g5_binding.sql" "F3 reservations 003 (G5 binding)"
}
x_ent_stack() {  # database: F3's entitlement guard 001 and saga stop 002 (001 needs F5 Phase 5)
  local d="$1"
  must "$d" "$x_ent/001_x_publish_entitlement_guard.sql" "F3 entitlement guard 001"
  must "$d" "$x_ent/002_x_service_end_saga_stop.sql" "F3 saga stop 002"
}
x_stack() {  # database: all of F3's SQL (needs F5 through Phase 5)
  x_resv_stack "$1"
  x_ent_stack "$1"
}
threads_social_accounts() {  # database: the multi-provider social_accounts migration (real) and what it needs
  local d="$1"
  own "$d" -f "$t/postona_social_accounts_multi_provider_fixture.sql" >/dev/null
  val "$d" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" >/dev/null
  awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | val "$d" >/dev/null
  val "$d" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" >/dev/null
  must "$d" "$m/20261007150000_postona_social_accounts_multi_provider.sql" "the real multi-provider migration (Phase 2a-2)"
  "${S[@]}" -d "$d" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' >/dev/null
  own "$d" -f "$tree/g4/supabase/tests/postona_threads_oauth_test_fixture.sql" >/dev/null
}
threads_base() {  # database: multi-provider social_accounts, PR #124 OAuth/workspace, the G4 publish stack (F4's three)
  local d="$1" f
  threads_social_accounts "$d"
  must "$d" "$tree/g4/supabase/candidates/postona_threads_oauth_workspace_candidate.sql" "PR124 OAuth/workspace candidate"
  for f in postona_threads_publish/threads_credential_custody_candidate.sql postona_threads_publish/threads_manual_publish_candidate.sql \
           postona_threads_publish/threads_publish_release_candidate.sql; do
    must "$d" "$f4c/$f" "F4 $f"
  done
}
threads_lifecycle() {  # database: F4's cleanup (live lease) + disconnect candidates, T13 helpers, the writer guards
  local d="$1" f
  for f in postona_threads_cleanup/threads_provider_cleanup_candidate.sql postona_threads_disconnect/threads_disconnect_candidate.sql; do
    must "$d" "$f4c/$f" "F4 $f"
  done
  own "$d" -f "$f4t/postona_threads_t13_fixture.sql" >/dev/null
  must "$d" "$f4c/postona_threads_lifecycle_guards/threads_writer_lifecycle_guards_candidate.sql" "F4 writer guards"
}

world="${prefix}_world"
mk "$world"
f5_base "$world"
snap_p3a="$(copy snap_p3a "$world")"          # F5 Phase 1, 2, 3a only
f5_fence "$world"
snap_p4="$(copy snap_p4 "$world")"            # + Phase 3b, 4: what F3's candidates and F4's publish stack need from G5
f5_rest "$world"
x_stack "$world"
# F3's own suites assume F3's own baseline (account defaults of its fixtures); they run on THIS snapshot (F5 Phase 1..8 +
# F3 only), which is F3's world with the current F5 chain under it. The Threads steps below change social_accounts.
x_only="$(copy xonly "$world")"
echo "PASS world/x: F5 Phase 1..8 + the real saga SQL + Stage 3B authority + F3 reservations 001-003 + entitlement guard 001 + saga stop 002"
threads_base "$world"
threads_lifecycle "$world"
echo "PASS world/threads: + multi-provider social_accounts + PR124 + G4 publish stack + F4 cleanup (live lease) + disconnect + writer guards"
echo "PHASE8_WORLD_READY $world"

# ---- 4. The activation variants -------------------------------------------------------------------------------------
# GRANTED: F5's reviewed EXECUTE grant candidate for F4's cleanup pair applied (the state in which the Threads adapter
# can work). NOT GRANTED: the shipped state (the adapter is refused by the database and fails closed).
granted="$(copy granted "$world")"
must "$granted" "$repo/supabase/candidates/common_account_provider_registration/threads_cleanup_execute_grant_candidate.sql" "F5 cleanup grant candidate"
nogrant="$(copy nogrant "$world")"

# ---- 5. The overlay of Edge functions (F5 + F3's saga + F4's adapter; nothing of F3/F4 is modified) -----------------
ov="$tree/overlay/supabase"
mkdir -p "$ov/functions" "$ov/tests" "$ov/functions/_shared/social"
cp -R "$repo/supabase/functions/account-delete" "$ov/functions/account-delete"
cp -R "$tree/f3/supabase/functions/social-mobile-account-delete" "$ov/functions/social-mobile-account-delete"
cp "$tree/f4/supabase/functions/_shared/social/threads_provider_cleanup.ts" "$ov/functions/_shared/social/threads_provider_cleanup.ts"
cp "$ov/functions/account-delete/provider_registry.ts" "$ov/functions/account-delete/provider_registry.empty.ts"
cp "$repo/supabase/candidates/common_account_provider_registration/provider_registry.threads.candidate.ts" "$ov/functions/account-delete/provider_registry.ts"
cp "$repo/supabase/tests/common_account_phase8_integrated_test.ts" "$ov/tests/"

# The order database: the granted world + F3's own test double for G4's "X account verified" predicate (as F3's
# g5_binding suite uses it), so that a reservation write can succeed and hold its locks. Release gates open (the
# whole-account flow is exercised). Test doubles only; no candidate is changed.
ordered="$(copy ordered "$granted")"
val "$ordered" -c "create or replace function postona_x_resv.g4_x_account_verified(p_user_id uuid, p_social_account_id text) returns boolean language sql stable security definer set search_path = '' as \$\$ select true \$\$;
  create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as \$\$ select true \$\$;
  alter table private.account_lifecycle_release_gates drop constraint if exists account_lifecycle_release_gates_blocked_only;
  update private.account_lifecycle_release_gates set state = 'open';" >/dev/null

# Phase 8 rolled back (F5's own rollback file, on a copy of the granted world) for the "code newer / older than the database" tests.
rolled="$(copy rolled_back "$granted")"
own "$rolled" -f "$t/common_account_service_reconciliation_rollback.sql" >/dev/null
# The Phase 7 Edge code (the head of PR #183, pinned) as the "older code" of those tests.
P7="${F5_P7_SHA:-f2565cc0412f8127f95f00a728d16bf83af74667}"
git -C "$repo" cat-file -e "${P7}^{commit}" 2>/dev/null || fail "missing git objects for the Phase 7 head $P7"
mkdir -p "$tree/p7"
git -C "$repo" archive "$P7" supabase/functions/account-delete | tar -x -C "$tree/p7"
cp -R "$tree/p7/supabase/functions/account-delete" "$ov/functions/account-delete-p7"
cp "$repo/supabase/candidates/common_account_provider_registration/provider_registry.threads.candidate.ts" "$ov/functions/account-delete-p7/provider_registry.ts"
echo "F5-Phase7 $P7" >> "$tree/MANIFEST.txt"

# The same order database with F3's lock_own repaired (proof overlay: G5's locks BEFORE the reservation row). Used only
# by the lock-order finding F3-L1's "fix proof" test.
ordered_fix="$(copy ordered_fix "$ordered")"
own "$ordered_fix" -f "$t/common_account_phase8_f3_lock_order_fix_proof.sql" >/dev/null

run_deno() {  # test-file
  ( cd "$tree/overlay" && CAL_E2E=1 PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$granted" PGDATABASE_NOGRANT="$nogrant" PGDATABASE_ORDER="$ordered" PGDATABASE_ORDER_FIX="$ordered_fix" PGDATABASE_P8_ROLLED_BACK="$rolled" \
      deno test --no-config --no-check --allow-run=psql --allow-env --allow-read "$1" ) > "$tree/deno.log" 2>&1 \
    || { sed 's/\x1b\[[0-9;]*m//g' "$tree/deno.log" | grep -v '^$' | head -80 >&2; fail "$1"; }
  sed 's/\x1b\[[0-9;]*m//g' "$tree/deno.log" | grep -E "observed:" || true
  sed 's/\x1b\[[0-9;]*m//g' "$tree/deno.log" | grep -E "passed|failed" | tail -1
}

if want e2e; then
  run_deno supabase/tests/common_account_phase8_integrated_test.ts
  ( cd "$tree/overlay" && deno check --no-config supabase/functions/account-delete/http.ts supabase/functions/account-delete/provider_registry.ts supabase/functions/social-mobile-account-delete/http.ts ) > "$tree/check.log" 2>&1 \
    || { cat "$tree/check.log" >&2; fail "type check of the assembled functions"; }
  echo "PASS e2e: F5 Edge handler -> F3 saga handler -> real SQL, F4's real adapter; the assembled functions type-check together"
fi

# ---- 6. F3's and F4's OWN behavior suites, unchanged, on the assembled world (regression of their contracts) ------------
if want regression; then
  d="$(copy reg_x_entitlement "$x_only")"
  out="$(own "$d" -A -t -f "$x_ent/behavior.sql" 2>&1)" || { echo "$out" | tail -5 >&2; fail "F3 entitlement guard behavior suite on the assembled world"; }
  for marker in E1_ACTIVE_ALLOWS_PASS E2_LIFECYCLE_REFUSES_PREDICATE_PASS E3_EXISTING_CHECKS_UNCHANGED_PASS \
                E4_GRANT_NEEDS_ACTIVE_SERVICE_PASS E5_SECOND_CHECK_REFUSES_PASS E6_X_STOP_CONTRACT_PASS X_PUBLISH_ENTITLEMENT_BEHAVIOR_PASS; do
    grep -q "$marker" <<<"$out" || fail "F3 entitlement behavior: missing $marker"
  done
  echo "PASS regression/F3 entitlement guard behavior suite (unchanged) on the assembled world"
  d="$(copy reg_x_saga "$x_only")"
  out="$(own "$d" -A -t -f "$x_ent/saga_behavior.sql" 2>&1)" || { echo "$out" | tail -5 >&2; fail "F3 saga stop behavior suite on the assembled world"; }
  for marker in S1_LEASE_IDEMPOTENT_ACL_PASS S3_FROZEN_STILL_STOPS_PASS S5_IN_FLIGHT_AND_UNCERTAIN_PASS X_SAGA_STOP_BEHAVIOR_PASS; do
    grep -q "$marker" <<<"$out" || fail "F3 saga behavior: missing $marker"
  done
  echo "PASS regression/F3 saga stop behavior suite (unchanged) on the assembled world"
  d="$(copy reg_threads "$world")"
  out="$(own "$d" -A -t -f "$f4t/postona_threads_t13_behavior.sql" 2>&1)" || { echo "$out" | tail -5 >&2; fail "F4 T13 behavior suite on the assembled world"; }
  grep -q T13_BEHAVIOR_OK <<<"$out" || fail "F4 T13 behavior suite incomplete"
  echo "PASS regression/F4 T13 writer-guard behavior suite (unchanged) on the assembled world"
fi
# ---- 7. Apply order, dependencies, activation gates -------------------------------------------------------------------
fp() { val "$1" -f "$t/common_account_phase8_catalog.sql" | shasum -a 256 | cut -d' ' -f1; }
expect_refusal() {  # database file expected-code label: the file is refused with the code and nothing changed
  local d="$1" file="$2" code="$3" label="$4" before after out
  before="$(fp "$d")"
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$file" 2>&1)"; then fail "$label was applied (expected $code)"; fi
  grep -q "$code" <<<"$out" || fail "$label: expected $code, got: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  after="$(fp "$d")"
  [[ "$before" == "$after" ]] || fail "$label left a change behind"
  echo "PASS apply/refused: $label -> $code (nothing changed)"
}
if want apply; then
  # 7a. F3's reservations binding needs G5's Phase 3b + 4 under it; F3's entitlement guard needs Phase 5 (the workspace
  #     state); F3's saga stop needs F3's entitlement guard.
  d="$(copy ao_pre_fence "$snap_p3a")"
  own "$d" -f "$x_ent/test_stand_ins.sql" >/dev/null
  must "$d" "$m/20261006160200_x_account_publish_authority.sql" "the real Stage 3B authority migration (pre-fence world)"
  must "$d" "$x_resv/001_postona_x_reservations.sql" "F3 reservations 001 (pre-fence world)"
  # (002 only creates the cluster-wide API role, which the finished world already has: it is not part of this refusal)
  expect_refusal "$d" "$x_resv/003_postona_x_resv_g5_binding.sql" POSTONA_RESV_G5_BINDING_PRECONDITION_G5_MISSING "F3 reservations 003 without G5 Phase 3b/4"
  d="$(copy ao_pre_p5 "$snap_p4")"
  own "$d" -f "$x_ent/test_stand_ins.sql" >/dev/null
  must "$d" "$m/20261006160200_x_account_publish_authority.sql" "the real Stage 3B authority migration (pre-Phase-5 world)"
  expect_refusal "$d" "$x_ent/001_x_publish_entitlement_guard.sql" X_PUBLISH_ENTITLEMENT_PRECONDITION_G5_MISSING "F3 entitlement guard 001 without G5 Phase 5"
  expect_refusal "$d" "$x_ent/002_x_service_end_saga_stop.sql" X_SAGA_STOP_PRECONDITION_MISSING "F3 saga stop 002 without F3 entitlement guard 001"
  # 7b. F4's cleanup needs F5 Phase 6 (the lease-bound cleanup predicate); PR #124's OAuth needs the Phase 3b writer guard (T13).
  d="$(copy ao_pre_p6 "$snap_p4")"
  threads_base "$d"
  expect_refusal "$d" "$f4c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql" THREADS_CLEANUP_PRECONDITION_LIFECYCLE "F4 cleanup without F5 Phase 6"
  d="$(copy ao_pre_fence_threads "$snap_p3a")"
  threads_social_accounts "$d"
  expect_refusal "$d" "$tree/g4/supabase/candidates/postona_threads_oauth_workspace_candidate.sql" POSTONA_THREADS_OAUTH_PRECONDITION_T13_MISSING "PR #124 Threads OAuth/workspace without G5 Phase 3b (T13)"
  # 7c. The order may differ: F3's reservations (003) right after Phase 4, then Phase 5, F3's entitlement guard + saga
  #     stop, then Phase 6 and 8 -- the schema must be the same as the canonical order.
  d="$(copy ao_alt "$snap_p4")"
  x_resv_stack "$d" shared-role
  must "$d" "$m/20261012230000_common_account_service_brand_state.sql" "F5 Phase 5 (alternative order)"
  x_ent_stack "$d"
  must "$d" "$m/20261013120000_common_account_service_deletion_ownership.sql" "F5 Phase 6 (alternative order)"
  must "$d" "$m/20261013140000_common_account_service_reconciliation_facts.sql" "F5 Phase 8 (alternative order)"
  val "$x_only" -f "$t/common_account_phase8_catalog.sql" > "$tree/cat_canonical.txt"
  val "$d" -f "$t/common_account_phase8_catalog.sql" > "$tree/cat_alt.txt"
  if ! cmp -s "$tree/cat_canonical.txt" "$tree/cat_alt.txt"; then diff "$tree/cat_canonical.txt" "$tree/cat_alt.txt" | head -30 >&2; fail "apply order: the alternative order gives another schema"; fi
  echo "PASS apply/commutes: P4 -> F3 reservations -> P5 -> F3 entitlement guard + saga -> P6 -> P8 == P4..P8 -> F3 ($(wc -l < "$tree/cat_alt.txt" | tr -d ' ') catalog lines)"
  # 7d. Every file of the three stacks is refused on the finished world, and nothing changes.
  d="$(copy reapply "$granted")"
  before="$(fp "$d")"
  accepted=""
  while read -r label file; do
    [[ -n "$label" ]] || continue
    if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "${file/\$M/$m}" 2>&1)"; then accepted="$accepted $label"
    else echo "  re-apply refused: $label -> $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1 | cut -c1-90)"; fi
  done <<EOF
F5_P1 $m/20261001150000_common_account_lifecycle_foundation.sql
F5_P2 $m/20261006230000_common_account_service_start_intent.sql
F5_P3a $m/20261009120000_common_account_deletion_completion.sql
F5_P3b $m/20261010051938_common_account_service_write_guard.sql
F5_P4 $m/20261012130000_common_account_core_service_fence.sql
F5_P5 $m/20261012230000_common_account_service_brand_state.sql
F5_P6 $m/20261013120000_common_account_service_deletion_ownership.sql
F5_P8 $m/20261013140000_common_account_service_reconciliation_facts.sql
F3_STAGE3B $m/20261006160200_x_account_publish_authority.sql
F3_RESV001 $x_resv/001_postona_x_reservations.sql
F3_RESV002 $x_resv/002_postona_x_resv_api_role.sql
F3_RESV003 $x_resv/003_postona_x_resv_g5_binding.sql
F3_ENT001 $x_ent/001_x_publish_entitlement_guard.sql
F3_SAGA002 $x_ent/002_x_service_end_saga_stop.sql
F4_MULTI_PROVIDER $m/20261007150000_postona_social_accounts_multi_provider.sql
F4_CUSTODY $f4c/postona_threads_publish/threads_credential_custody_candidate.sql
F4_MANUAL $f4c/postona_threads_publish/threads_manual_publish_candidate.sql
F4_RELEASE $f4c/postona_threads_publish/threads_publish_release_candidate.sql
F4_CLEANUP $f4c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql
F4_DISCONNECT $f4c/postona_threads_disconnect/threads_disconnect_candidate.sql
F4_GUARDS $f4c/postona_threads_lifecycle_guards/threads_writer_lifecycle_guards_candidate.sql
G4_PR124_OAUTH $tree/g4/supabase/candidates/postona_threads_oauth_workspace_candidate.sql
EOF
  after="$(fp "$d")"
  [[ "$before" == "$after" ]] || fail "a re-apply changed the finished world"
  [[ -z "$accepted" ]] || echo "  (accepted as a no-op, catalog unchanged:$accepted)"
  echo "PASS apply/reapply: 22 files of three stacks re-applied on the finished world; the catalog is unchanged"
  # 7e. The activation gates as shipped.
  [[ "$(val "$world" -c "select count(*) from private.account_lifecycle_release_gates where gate = 'managed_auth_delete' and state = 'blocked' and reason = 'IDENTITY_CHANGE_FENCE_MISSING'")" == 1 ]] \
    || fail "managed_auth_delete is not BLOCKED as shipped"
  [[ "$(val "$world" -c "select count(*) from pg_constraint where conrelid = 'private.account_lifecycle_release_gates'::regclass and conname = 'account_lifecycle_release_gates_blocked_only'")" == 1 ]] \
    || fail "the gate can be opened without a schema change"
  # no EXECUTE for service_role on F4's cleanup pair, no registration, as shipped (the e2e I3/I4 prove what happens)
  [[ "$(val "$nogrant" -c "select has_function_privilege('service_role', 'public.cleanup_threads_provider_footprint(uuid)', 'EXECUTE')")" == f ]] || fail "the cleanup grant is present as shipped"
  grep -q "adapters: \[\]" "$repo/supabase/functions/account-delete/provider_registry.ts" || fail "the shipped registry registers a provider"
  echo "PASS apply/gates: managed_auth_delete BLOCKED (check constraint), F4 cleanup pair not granted, provider registry empty -- all as shipped"
fi

# ---- 7b. Rollback across the stacks, with read-backs ------------------------------------------------------------------
if want rollback; then
  # (1) the cross-stack ladder on F5 + F3: F3's three rollbacks, then F5 Phase 8, 6, 5 -- the catalog must return to the
  #     state "Phase 4 + F3 reservations 001/002 + Stage 3B" (the files F3 ships no rollback for), apart from the
  #     documented additive remnants of F5 Phase 6 and 8.
  ref="$(copy rb_ref "$snap_p4")"
  own "$ref" -f "$x_ent/test_stand_ins.sql" >/dev/null
  must "$ref" "$m/20261006160200_x_account_publish_authority.sql" "the real Stage 3B authority migration (rollback reference)"
  must "$ref" "$x_resv/001_postona_x_reservations.sql" "F3 reservations 001 (rollback reference)"
  sed -e "/^create role postona_resv_api /d" -e "s/ or to_regrole('postona_resv_api') is not null//" "$x_resv/002_postona_x_resv_api_role.sql" > "$tree/002_shared_role.sql"
  must "$ref" "$tree/002_shared_role.sql" "F3 reservations 002 (rollback reference)"
  d="$(copy rb_ladder "$x_only")"
  step() {  # label file
    local out; out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$2" 2>&1)" || fail "rollback of $1 failed: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
    echo "  rolled back: $1"
  }
  step "F3 saga stop 002" "$x_ent/002_x_service_end_saga_stop_rollback.sql"
  step "F3 entitlement guard 001" "$x_ent/001_x_publish_entitlement_guard_rollback.sql"
  step "F3 reservations G5 binding 003" "$x_resv/003_postona_x_resv_g5_binding_rollback.sql"
  step "F5 Phase 8" "$t/common_account_service_reconciliation_rollback.sql"
  step "F5 Phase 6" "$t/common_account_service_deletion_rollback.sql"
  step "F5 Phase 5" "$t/common_account_brand_state_rollback.sql"
  val "$ref" -f "$t/common_account_phase8_catalog.sql" > "$tree/cat_ref.txt"
  val "$d" -f "$t/common_account_phase8_catalog.sql" > "$tree/cat_rolled.txt"
  comm -23 <(sort "$tree/cat_ref.txt") <(sort "$tree/cat_rolled.txt") > "$tree/rb_gone.txt" || true
  comm -13 <(sort "$tree/cat_ref.txt") <(sort "$tree/cat_rolled.txt") > "$tree/rb_extra.txt" || true
  if [[ -s "$tree/rb_gone.txt" ]]; then cat "$tree/rb_gone.txt" | head -20 >&2; fail "the ladder removed something the earlier state had"; fi
  # documented remnants: Phase 6 and Phase 8 keep their additive columns and the check constraints on them (data survives)
  grep -v -E '^(col|con) private\.account_lifecycle_operations[. ](provider_results|remote_unverified_ack_at|remote_unverified_ack_providers|account_lifecycle_operations_ack_shape|account_lifecycle_operations_provider_results_shape|reconciliation|account_lifecycle_operations_reconciliation_shape)' "$tree/rb_extra.txt" > "$tree/rb_unexpected.txt" || true
  if [[ -s "$tree/rb_unexpected.txt" ]]; then head -20 "$tree/rb_unexpected.txt" >&2; fail "the ladder left more than the documented additive remnants"; fi
  echo "PASS rollback/ladder: F3 saga 002 -> entitlement 001 -> binding 003 -> F5 Phase 8 -> 6 -> 5 return the catalog to Phase 4 + F3 reservations 001/002 (documented Phase 6/8 remnants only: $(wc -l < "$tree/rb_extra.txt" | tr -d ' ') lines)"

  # (2) F5 alone rolled back while F3 and F4 stay applied (the dangerous partial rollback): what still answers, and how.
  d="$(copy rb_partial "$granted")"
  U="00000000-0000-4000-8000-0000000d0001"
  val "$d" -c "select t13.person('$U'::uuid, 'rbp')" >/dev/null
  acct="$(val "$d" -c "select a.id from public.social_accounts a where a.brand_id = public.social_mobile_account_deletion_workspace('$U'::uuid) and a.platform = 'threads'")"
  ans() {  # one statement on the partial-rollback database: its first output line, or the error message
    local o; o="$(val "$d" -c "$1" 2>&1)" || true
    if grep -q ERROR <<<"$o"; then sed -n 's/^.*ERROR: *//p' <<<"$o" | head -1 | cut -c1-70; else head -1 <<<"$o" | cut -c1-70; fi
  }
  readback() {  # -> "<F3 decision>|<F4 cleanup authorization>|<F4 publish begin>"
    echo "$(ans "select postona_x_resv.g5_x_autopost_allowed('$U'::uuid)::text")|$(ans "select public.threads_cleanup_authorized('$U'::uuid)::text")|$(ans "select t13.timed_begin('$U'::uuid, '$acct', gen_random_uuid())")"
  }
  base_view="$(readback)"
  echo "  read-back at the finished world:  $base_view"
  [[ "$base_view" == true\|false\|* ]] || fail "unexpected read-back at the finished world: $base_view"
  for r in "common_account_service_reconciliation_rollback.sql:F5 Phase 8" "common_account_service_deletion_rollback.sql:F5 Phase 6" \
           "common_account_brand_state_rollback.sql:F5 Phase 5" "common_account_core_fence_rollback.sql:F5 Phase 4"; do
    out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -f "$t/${r%%:*}" 2>&1)" || fail "partial rollback of ${r##*:} was refused: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
    view="$(readback)"
    echo "  read-back after ${r##*:}: $view"
    # F3's decision never turns into an error or an unexpected "true for everyone": it stays t for this ACTIVE person and
    # F4's cleanup authorization is never true (an error once Phase 6 is gone = it cannot authorize anything).
    IFS='|' read -r a b c <<<"$view"
    [[ "$a" == true ]] || fail "F3's decision after ${r##*:}: $a"
    [[ "$b" != true ]] || fail "F4's cleanup authorization became true after ${r##*:}"
  done
  echo "PASS rollback/partial: with F3 and F4 applied, rolling F5 back Phase 8 -> 6 -> 5 -> 4 keeps the shared fence functions F3/F4 use; F4's cleanup authorization turns into an error (fail closed), never true"
fi

# ---- 8. The privilege boundary of the assembled world ---------------------------------------------------------------
if want acl; then
  for v in granted nogrant; do
    d="$granted"; [[ "$v" == nogrant ]] && d="$nogrant"
    out="$(psql -X -q -v ON_ERROR_STOP=1 -v variant="$v" -h "$host" -p "$port" -U "$owner" -d "$d" -f "$t/common_account_phase8_integrated_acl.sql" 2>&1)" \
      || { echo "$out" | tail -6 >&2; fail "privilege boundary ($v world)"; }
    grep -q ACL_ALL_PASS <<<"$out" || fail "privilege boundary incomplete ($v world)"
    echo "PASS acl/$v: $(grep -c '^ACL_._.*_PASS' <<<"$out") checks (definer search_path, owner, authenticated surface, no user-id argument, service surface, table writes, reservation API role, guard triggers)"
  done
fi
echo "PHASE8_ALL_PASS"
