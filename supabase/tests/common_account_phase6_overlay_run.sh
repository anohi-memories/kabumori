#!/usr/bin/env bash
# F5 Phase 6: G5's POSTONA end against F4's ACTUAL Threads source (a disposable, read-only SOURCE OVERLAY).
#
# 1. Builds a throwaway tree under /private/tmp: F4's exact head (git archive; nothing is checked out, merged or
#    pushed, and no F4 / G3 / G4 / H5 file is ever written back), then this checkout's G5 files over it, then
#    PR #124's two read-only files (as F4's own runner does), and the Threads registration candidate in place
#    of G5's (empty) provider registry:
#      F4  PR #169 fd15430ddcd640c5c7389582f37f1b478fc7204c   Threads T13 writer guards / cleanup / disconnect
#      G4  PR #124 c30f246409a77080cbc03aef6c4cb72b5481e125   OAuth / workspace candidate + its fixture
#      G5  this branch (Phase 1..6 migrations, account-delete, the registration and grant candidates)
# 2. On a LOCAL Unix-socket PostgreSQL 17, as a per-run non-superuser owner, builds the real world (Phase 1 / 2 /
#    3a / 3b / 4 / 5 / 6, X and Phase 2a-2 migrations, PR #124, the G4 publish stack, F4's cleanup and disconnect
#    candidates, F4's T13 fixture and guards candidate) and proves:
#      a. F4's own T13 behavior suite passes with Phase 6 present, and the exact ownership / ACL / ordering
#         evidence for F4's definer writers (the yes/no of the TASK);
#      b. the EXECUTE grant candidate: before it the adapter is refused and fails closed; after it the adapter runs;
#      c. G5's REAL orchestrator (TypeScript) with F4's REAL adapter (createThreadsProviderCleanupAdapter /
#         createThreadsCleanupRpcStore) against F4's REAL SQL and G5's REAL Phase 6 SQL: POSTONA alone, with the
#         acknowledgement; without it nothing changes; an in-flight publish reconciles; the Threads disconnect
#         is refused while the deletion runs; a stale service lease;
#      d. the handoff for F4: as shipped, F4's cleanup authorizes a service deletion WITHOUT a live lease; with
#         the one-line change (private.account_lifecycle_cleanup_authorized) an expired lease removes nothing.
# Nothing is applied to a managed database; fake data only. Requires the git objects of the two SHAs.
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
#        bash supabase/tests/common_account_phase6_overlay_run.sh
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
g5="${CAL_OVERLAY_G5_ROOT:-$repo}"   # where G5's files are read from (a mutated copy, in the mutation runs)
F4="${F4_SHA:-fd15430ddcd640c5c7389582f37f1b478fc7204c}"
PR124="${PR124_SHA:-c30f246409a77080cbc03aef6c4cb72b5481e125}"
fail() { echo "FAIL $*" >&2; exit 1; }
for sha in "$F4" "$PR124"; do git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"; done
sections="${CAL_OVERLAY_SECTIONS:-all}"
want() { [[ "$sections" == all || ",$sections," == *",$1,"* ]]; }

tree="$(mktemp -d /private/tmp/kabumori-phase6-overlay.XXXXXX)"
n="$$"
owner="kb_p6_overlay_owner_$n"
prefix="kabumori_p6_ov_${n}"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. The overlay ---------------------------------------------------------------------------------------------
git -C "$repo" archive "$F4" | tar -x -C "$tree"
echo "F4 $F4" > "$tree/OVERLAY_MANIFEST.txt"
# G5's own files over it (the F4 tree carries the older G5 files of its base).
for path in supabase/migrations/20261010051938_common_account_service_write_guard.sql \
            supabase/migrations/20261012130000_common_account_core_service_fence.sql \
            supabase/migrations/20261012230000_common_account_service_brand_state.sql \
            supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql \
            supabase/migrations/20261013140000_common_account_service_reconciliation_facts.sql \
            supabase/tests/common_account_write_guard_fixture.sql; do
  mkdir -p "$tree/$(dirname "$path")"
  cp "$g5/$path" "$tree/$path"
  echo "g5 $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/OVERLAY_MANIFEST.txt"
done
rm -rf "$tree/supabase/functions/account-delete"
cp -R "$g5/supabase/functions/account-delete" "$tree/supabase/functions/account-delete"
mkdir -p "$tree/supabase/candidates/common_account_provider_registration"
cp "$g5"/supabase/candidates/common_account_provider_registration/* "$tree/supabase/candidates/common_account_provider_registration/"
cp "$g5/supabase/tests/common_account_phase6_overlay_e2e_test.ts" "$g5/supabase/tests/common_account_phase6_overlay_probe.sql" "$tree/supabase/tests/"
# The Threads registration replaces G5's empty registry in the overlay only.
cp "$tree/supabase/candidates/common_account_provider_registration/provider_registry.threads.candidate.ts" \
   "$tree/supabase/functions/account-delete/provider_registry.ts"
for path in supabase/candidates/postona_threads_oauth_workspace_candidate.sql supabase/tests/postona_threads_oauth_test_fixture.sql; do
  [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the F4 base"
  git -C "$repo" archive "$PR124" -- "$path" | tar -x -C "$tree"
  echo "$PR124 $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/OVERLAY_MANIFEST.txt"
done
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
# Mutation runs only: ONE edit of F4's guards candidate, in the throw-away tree (never in a checkout).
if [[ -n "${CAL_OVERLAY_GUARDS_FIND:-}" ]]; then
  CAL_GUARDS_FILE="$c/postona_threads_lifecycle_guards/threads_writer_lifecycle_guards_candidate.sql" python3 -c '
import os, pathlib
path = pathlib.Path(os.environ["CAL_GUARDS_FILE"])
source = path.read_text()
find = os.environ["CAL_OVERLAY_GUARDS_FIND"]
assert source.count(find) == 1, "mutation anchor must occur exactly once"
path.write_text(source.replace(find, os.environ.get("CAL_OVERLAY_GUARDS_REPLACE", "")))
'
fi

# ---- 2. The real world (the sequence of F4's postona_threads_t13_run.sh, plus Phase 6) --------------------------
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb nocreaterole;
grant anon, authenticated, service_role to $owner;
SQL
as_owner() { local db="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { local db="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
create_db() { "${S[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" >/dev/null; }
copy() { local db="${prefix}_$1"; create_db "$db" "$2"; echo "$db"; }
apply() {
  local db="$1" file="$2" out
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$file" 2>&1)"; then echo applied
  else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}
world="${prefix}_world"
create_db "$world"
as_owner "$world" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
as_owner "$world" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$world" -f "$m/$f" >/dev/null
done
as_owner "$world" -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
  as_owner "$world" -f "$m/$f" >/dev/null
done
as_owner "$world" -f "$t/common_account_write_guard_fixture.sql" >/dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql \
         20261012230000_common_account_service_brand_state.sql 20261013120000_common_account_service_deletion_ownership.sql \
         20261013140000_common_account_service_reconciliation_facts.sql; do
  [[ "$(apply "$world" "$m/$f")" == applied ]] || fail "G5 $f did not apply: $(apply "$(copy "why_$RANDOM" "$world")" "$m/$f")"
done
as_owner "$world" -f "$t/postona_social_accounts_multi_provider_fixture.sql" >/dev/null
q "$world" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" >/dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$world" >/dev/null
q "$world" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" >/dev/null
[[ "$(apply "$world" "$m/20261007150000_postona_social_accounts_multi_provider.sql")" == applied ]] || fail "Phase 2a-2 did not apply"
"${S[@]}" -d "$world" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' >/dev/null
as_owner "$world" -f "$t/postona_threads_oauth_test_fixture.sql" >/dev/null
for f in "$c/postona_threads_oauth_workspace_candidate.sql" "$c/postona_threads_publish/threads_credential_custody_candidate.sql" \
         "$c/postona_threads_publish/threads_manual_publish_candidate.sql" "$c/postona_threads_publish/threads_publish_release_candidate.sql" \
         "$c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql" "$c/postona_threads_disconnect/threads_disconnect_candidate.sql"; do
  [[ "$(apply "$world" "$f")" == applied ]] || fail "$(basename "$f") did not apply on the real G5 world: $(apply "$(copy "why2_$RANDOM" "$world")" "$f")"
done
as_owner "$world" -f "$t/postona_threads_t13_fixture.sql" >/dev/null
echo "PASS world: real G5 (Phase 1..6) + X + 2a-2 + #124 + publish stack + F4 cleanup + disconnect"

guards="$c/postona_threads_lifecycle_guards/threads_writer_lifecycle_guards_candidate.sql"
gdb="${prefix}_guards"
create_db "$gdb" "$world"
[[ "$(apply "$gdb" "$guards")" == applied ]] || fail "F4 guards candidate did not apply with Phase 6 present: $(apply "$(copy "why3_$RANDOM" "$world")" "$guards")"

# ---- 3a. F4's writer guards: their behavior suite, and the ownership / ACL / ordering evidence ----------------------
if want guards; then
  bdb="$(copy behavior "$gdb")"        # F4's suite leaves its own people behind: it runs on a copy
  out="$(as_owner "$bdb" -A -t -f "$t/postona_threads_t13_behavior.sql" 2>&1)" || fail "F4 T13 behavior suite failed with Phase 6 present: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  grep -q T13_BEHAVIOR_OK <<<"$out" || fail "F4 T13 behavior suite incomplete"
  echo "PASS F4 T13 behavior suite with Phase 6 present"
  out="$(as_owner "$bdb" -A -t -f "$t/common_account_phase6_overlay_probe.sql" 2>&1)" || fail "ownership / ACL / ordering probe: $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  grep -q PHASE6_OVERLAY_PROBE_OK <<<"$out" || fail "probe incomplete: $out"
  grep '^EVIDENCE' <<<"$out" || true
  echo "PASS F4 writer guards: ownership, ACL and lock-order evidence (see the probe)"
fi

# ---- 3b. The EXECUTE grant candidate -------------------------------------------------------------------------------
grant="$c/common_account_provider_registration/threads_cleanup_execute_grant_candidate.sql"
if want grant; then
  db="$(copy grant "$gdb")"
  [[ "$(q "$db" -c "select has_function_privilege('service_role', 'public.cleanup_threads_provider_footprint(uuid)', 'EXECUTE')")" == f ]] \
    || fail "before the grant the deletion role must not reach F4's cleanup"
  [[ "$(apply "$db" "$grant")" == applied ]] || fail "grant candidate: $(apply "$(copy grant_why "$gdb")" "$grant")"
  [[ "$(apply "$db" "$grant")" == THREADS_CLEANUP_GRANT_PRECONDITION_ALREADY_REACHABLE ]] || fail "re-applying the grant must be refused"
  [[ "$(q "$db" -c "select has_function_privilege('service_role', 'public.threads_cleanup_authorized(uuid)', 'EXECUTE') or has_function_privilege('authenticated', 'public.cleanup_threads_provider_footprint(uuid)', 'EXECUTE')")" == f ]] \
    || fail "the internal predicate and the person's role must stay out"
  d2="$(copy grant_missing "$gdb")"
  q "$d2" -c "drop function public.threads_provider_connection_state(uuid)" >/dev/null
  [[ "$(apply "$d2" "$grant")" == THREADS_CLEANUP_GRANT_PRECONDITION_FUNCTION_MISSING ]] || fail "a missing function must refuse the grant"
  echo "PASS grant candidate: exact signatures, service_role only, re-apply and a missing function refused"
fi

# ---- 3c. G5's real orchestrator with F4's real adapter and SQL ----------------------------------------------------------
if want e2e; then
  pre="$(copy e2e_pre "$gdb")"        # grant NOT applied: the adapter must fail closed
  post="$(copy e2e_post "$gdb")"
  [[ "$(apply "$post" "$grant")" == applied ]] || fail "grant candidate (e2e)"
  ( cd "$tree" && CAL_E2E=1 PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$post" PGDATABASE_NOGRANT="$pre" \
      deno test --no-config --no-check --allow-run=psql --allow-env --allow-read supabase/tests/common_account_phase6_overlay_e2e_test.ts ) > "$tree/e2e.log" 2>&1 \
    || { cat "$tree/e2e.log" >&2; fail "overlay e2e"; }
  sed 's/\x1b\[[0-9;]*m//g' "$tree/e2e.log" | grep -E 'passed|failed' | tail -1
  ( cd "$tree" && deno check --no-config supabase/functions/account-delete/provider_registry.ts supabase/functions/account-delete/http.ts supabase/functions/_shared/social/threads_provider_cleanup.ts ) > "$tree/check.log" 2>&1 \
    || { cat "$tree/check.log" >&2; fail "type check of the registration against F4's module"; }
  echo "PASS overlay e2e: real orchestrator + F4's real adapter and SQL + G5's Phase 6 SQL; registration type-checks against F4's module"
fi

# ---- 3c'. Lock order, dynamically: an admin's writer behind Phase 6's lease RPC --------------------------------------------
# The workspace owner A's POSTONA deletion is owned (Phase 6 lease). A holder transaction keeps A's lifecycle rows
# locked (the renew of the lease) while an admin B's F4 writer arrives: B's writer must WAIT at A's lifecycle rows
# holding no workspace / account row lock (the order F4 documents), and be refused once the deletion state is visible.
if want order; then
  db="$(copy order "$gdb")"
  OA='00000000-0000-4000-8000-0000000000e1'; OB='00000000-0000-4000-8000-0000000000e2'
  q "$db" > /dev/null <<SQL
create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as \$\$ select true \$\$;
create table t13.ids (k text primary key, v text);
insert into t13.ids values ('acct', t13.person('$OA', 'order_a'));
select t13.login('$OB'); select t13.register('$OB');
insert into public.brand_memberships (brand_id, user_id, role) values (public.social_mobile_account_deletion_workspace('$OA'), '$OB', 'admin');
SQL
  # A's workspace has a second member, so G5's own begin refuses ("not self-service"); the deletion state is set the way
  # F4's T13 fixture does (G5's rows), with a live owner lease as claim_service_deletion would have written it.
  q "$db" -c "select t13.state('$OA'::uuid, 'service_deleting')" > /dev/null
  lease="$(q "$db" -c "select gen_random_uuid()")"
  q "$db" -c "update private.account_lifecycle_operations set owner_lease = '$lease', owner_lease_expires_at = clock_timestamp() + interval '10 minutes'
               where user_id = '$OA' and operation_type = 'service_deletion' and status = 'in_progress'" > /dev/null
  op="$(q "$db" -c "select id from private.account_lifecycle_operations where user_id = '$OA' and operation_type = 'service_deletion' and status = 'in_progress'")"
  [[ -n "$op" && -n "$lease" ]] || fail "order: deletion setup (op='$op' lease='$lease')"
  acct="$(q "$db" -c "select v from t13.ids where k = 'acct'")"
  q "$db" -c "begin; set local role service_role; select public.renew_service_deletion_claim('$OA'::uuid, 'x_autopost', '$op'::uuid, '$lease'::uuid); select pg_sleep(2.5); commit;" > "$tree/order_hold.log" 2>&1 &
  holder=$!; sleep 0.5
  ( PGAPPNAME=p6_writer q "$db" -c "select t13.as_user('$OB'::uuid, 'begin', '$acct', '$(uuidgen | tr 'A-Z' 'a-z')', 'order')" > "$tree/order_writer.log" 2>&1 ) &
  writer=$!; sleep 0.8
  obs="$(q "$db" -c "select a.wait_event_type || '/' || (select count(*) from pg_locks l join pg_class c on c.oid = l.relation
                      where l.pid = a.pid and l.granted and l.mode in ('RowShareLock', 'RowExclusiveLock') and c.relnamespace = 'public'::regnamespace
                        and c.relname in ('brands', 'brand_memberships', 'social_accounts', 'social_account_manual_publish_permissions', 'threads_manual_publish_attempts'))
                     from pg_stat_activity a where a.application_name = 'p6_writer' and a.state = 'active'")"
  wait "$holder" || true; wait "$writer" || true
  [[ "$obs" == Lock/0 ]] || fail "order: the admin's writer must wait at the owner's lifecycle rows holding no workspace row lock (observed '$obs')"
  grep -q '"code": "ACCOUNT_LIFECYCLE_BLOCKED"' "$tree/order_writer.log" || fail "order: the writer must be refused once the deletion is visible: $(tr '\n' ' ' < "$tree/order_writer.log")"
  grep -qi 'deadlock' "$tree/order_writer.log" "$tree/order_hold.log" && fail "order: a deadlock was reported"
  echo "PASS lock order (dynamic): the admin's writer waited at the owner's lifecycle rows with no workspace row lock, behind Phase 6's lease RPC, then was refused"
fi

# ---- 3d. The handoff for F4 (their file, not changed here) -----------------------------------------------------------------
if want handoff; then
  A='00000000-0000-4000-8000-0000000000d1'
  setup() {  # a connected person whose POSTONA service deletion holds a lease that has ENDED
    local db="$1"
    q "$db" -c "select t13.person('$A', 'handoff')" >/dev/null
    q "$db" -c "begin; set local role service_role; select public.begin_service_deletion('$A'::uuid, 'x_autopost'); commit;" >/dev/null
    local op; op="$(q "$db" -c "select id from private.account_lifecycle_operations where user_id = '$A' and operation_type = 'service_deletion' and status = 'in_progress'")"
    q "$db" -c "begin; set local role service_role; select public.claim_service_deletion('$A'::uuid, 'x_autopost', '$op'::uuid); commit;" >/dev/null
    q "$db" -c "update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 minute' where id = '$op'" >/dev/null
  }
  shipped="$(copy handoff_shipped "$gdb")"
  setup "$shipped"
  out="$(q "$shipped" -c "select public.cleanup_threads_provider_footprint('$A'::uuid)->>'outcome'")"
  [[ "$out" == local_removed_remote_unverified ]] || fail "as shipped, F4's cleanup is expected to act on an ENDED service lease (negative reproduction), got: $out"
  echo "NEGATIVE REPRODUCTION (F4 as shipped): the Threads footprint was removed under an ENDED service-deletion lease"
  patched="$(copy handoff_patched "$gdb")"
  q "$patched" -c "create or replace function public.threads_cleanup_authorized(p_user_id uuid) returns boolean language sql volatile security definer set search_path = '' as \$\$ select private.account_lifecycle_cleanup_authorized(p_user_id) \$\$" >/dev/null
  setup "$patched"
  out="$(q "$patched" -c "select public.cleanup_threads_provider_footprint('$A'::uuid)->>'outcome' || '/' || (public.cleanup_threads_provider_footprint('$A'::uuid)->>'code')")"
  [[ "$out" == blocked/DELETION_NOT_IN_PROGRESS ]] || fail "with the handoff change an ended lease must remove nothing, got: $out"
  [[ "$(q "$patched" -c "select count(*) from public.social_accounts where brand_id = public.social_mobile_account_deletion_workspace('$A'::uuid) and platform = 'threads'")" == 1 ]] \
    || fail "the Threads account must still be there"
  echo "PASS handoff: with private.account_lifecycle_cleanup_authorized an ended lease removes nothing"
  # F4's own T13 suite with the corrected function: its POSTONA-deletion cleanup case sets NO lease (it asserts the
  # shipped behavior), so it must fail there; with a live lease set first (what G5's claim writes) it passes.
  as_f4="$(copy handoff_f4 "$gdb")"
  q "$as_f4" -c "create or replace function public.threads_cleanup_authorized(p_user_id uuid) returns boolean language sql volatile security definer set search_path = '' as \$\$ select private.account_lifecycle_cleanup_authorized(p_user_id) \$\$" >/dev/null
  out="$(as_owner "$as_f4" -A -t -f "$t/postona_threads_t13_behavior.sql" 2>&1)" && fail "F4's suite is expected to need a lease for its POSTONA-deletion cleanup case"
  grep -q 'POSTONA deletion cleanup' <<<"$out" || fail "F4's suite failed somewhere else with the corrected function: $(grep -m1 ERROR <<<"$out")"
  leased="$tree/f4_behavior_with_lease.sql"
  CAL_SRC="$t/postona_threads_t13_behavior.sql" CAL_DST="$leased" python3 -c '
import os, pathlib
src = pathlib.Path(os.environ["CAL_SRC"]).read_text()
anchor = "  r := public.cleanup_threads_provider_footprint(pg_temp.u(\x27c2\x27));\n"
assert src.count(anchor) == 1
lease = ("  update private.account_lifecycle_operations set owner_lease = gen_random_uuid(),"
         " owner_lease_expires_at = clock_timestamp() + interval \x2710 minutes\x27"
         " where user_id = pg_temp.u(\x27c2\x27) and operation_type = \x27service_deletion\x27 and status = \x27in_progress\x27;\n")
pathlib.Path(os.environ["CAL_DST"]).write_text(src.replace(anchor, lease + anchor))
'
  as_f4b="$(copy handoff_f4b "$gdb")"
  q "$as_f4b" -c "create or replace function public.threads_cleanup_authorized(p_user_id uuid) returns boolean language sql volatile security definer set search_path = '' as \$\$ select private.account_lifecycle_cleanup_authorized(p_user_id) \$\$" >/dev/null
  out="$(as_owner "$as_f4b" -A -t -f "$leased" 2>&1)" || fail "F4's suite with the correction and a lease set: $(grep -m1 ERROR <<<"$out")"
  grep -q T13_BEHAVIOR_OK <<<"$out" || fail "F4's suite with the correction and a lease set did not complete"
  echo "PASS handoff: F4's T13 suite passes with the correction once its service-deletion case holds a lease (one added statement)"
fi

echo "PHASE6_OVERLAY_ALL_PASS"
