#!/usr/bin/env bash
# G3-40: the Threads reservations (007) + 009 on G5's PERSONAL MVP auth profile, on a THROW-AWAY LOCAL PostgreSQL 17 with fake data.
# The world is built exactly as G5-47's runner (supabase/tests/postona_personal_mvp_auth_pg_run.sh at 4c97140a, world "ne"): the G5 Draft chain
# at 21a5cad4 via `git archive` (read-only), then G5's MVP_INSTALL.sql from PR #550 head 4c97140a (blob-checked, read-only, not changed here).
# Then G3 001-006 (+ G3's X G4 TEST DOUBLE; 007 reuses caller() and the two roles), the TEST STAND-INS of the Threads runners (2a-2's
# platform rule, G4's custody / refresh-lease table shapes), 007 (its precondition now takes MV in place of W1; refusals checked) and
# G3's Threads G4 TEST DOUBLE -- all by the lifecycle owner -- and:
#   FB  without 009: R1-MVP's g5pv token is refused by the FULL-profile adapters -> every create refused, nothing written; a full-pair row is
#       never claimed (no W1);
#   P   009 refusals (superuser; G5's W1 present; MV reachable by an API role; R1 not the MVP body), nothing changed; apply; re-apply refused;
#   M   behaviour with 009 (personal_mvp/behavior.sql);
#   EC  (G3-43) 011 (the lease-expired audit): refusals (superuser, table / schema of another owner), nothing changed; apply; re-apply
#       refused; the person's own cancel after the service ended / the account unverified / an old generation (007, unchanged) and the
#       audit (personal_mvp/owner_cancel.sql); 011's rollback refusals (superuser, other owners, half applied, a widened ACL); rollback =
#       the procedures before 011, rows / audit untouched; twice refused (rolled back here: 007's own rollback is not taught about 011);
#   LR  (G3-42) unfinished MVP-bound rows (planned / claimed / lease run out / uncertain) refuse the rollback, nothing changed; also:
#       superuser, schema / table of another owner, half applied, a broken owner / ACL postcondition. Finish them (cancel -- G3-43: every
#       planned row, also of a person whose service ended; worker outcome; uncertain: a TEST stand-in removal -- its resolution is
#       PENDING_POLICY), roll back; finished MVP rows stay untouched and another
#       person's FULL-bound row is claimed (the dispatch is not stopped);
#   RB  rollback restores 007's adapters exactly; a FULL-bound planned row refuses a re-apply (no mixing); re-apply; 007's rollback still drops all.
# No network, no credential, no managed project; no OAuth, token, Vault, SNS or paid call. Roles are cluster-wide: run alone. Usage:
#   RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> personal_mvp_run.sh
# Optional: THREADS_MVP_CANDIDATE / THREADS_MVP_ROLLBACK / THREADS_RESV_CANDIDATE / AU_CANDIDATE / AU_ROLLBACK (mutation runs).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
resv="$here/../postona_x_reservations"
t007="${THREADS_RESV_CANDIDATE:-$here/007_postona_threads_reservations.sql}"
candidate="${THREADS_MVP_CANDIDATE:-$here/009_postona_threads_resv_personal_mvp.sql}"
au="${AU_CANDIDATE:-$here/011_postona_threads_resv_uncertain_audit.sql}"
aurb="${AU_ROLLBACK:-$here/011_postona_threads_resv_uncertain_audit_rollback.sql}"
rollback="${THREADS_MVP_ROLLBACK:-$here/009_postona_threads_resv_personal_mvp_rollback.sql}"
pm="$here/personal_mvp"
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
mvp=4c97140a6f1f2e09da387ec66cf234633d9afdd0
owner="kb_postona_thmvp_owner"
db="kabumori_postona_thmvp_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
work="$(mktemp -d /private/tmp/kabumori-postona-thmvp.XXXXXX)"
drop_roles() {
  "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
}
cleanup() {
  rm -rf "$work"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  drop_roles
  "${S[@]}" -d postgres -c "alter role $owner nosuperuser" >/dev/null 2>&1 || true  # G3-42 LR2 turns it on for one probe
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

for c in "$pin" "$mvp"; do git -C "$repo" cat-file -e "$c^{commit}" 2>/dev/null || { echo "RUN_NOT_AVAILABLE: commit $c missing; run git fetch origin." >&2; exit 3; }; done
tree="$work/pinned"; mkdir -p "$tree"
git -C "$repo" archive "$pin" supabase/migrations supabase/tests | tar -x -C "$tree"
[ "$(git hash-object "$tree/supabase/migrations/20261010051938_common_account_service_write_guard.sql")" = da587631cfe8872e3ccf6fd521b919a5439c6574 ] \
  || fail "the world's T13 is not the reviewed blob"
[ "$(git -C "$repo" rev-parse "$mvp:supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql")" = eebaabf2629575901947c0664d6f0002526d3273 ] \
  || fail "G5 MVP_INSTALL.sql at $mvp is not the expected blob"
git -C "$repo" show "$mvp:supabase/candidates/postona_personal_mvp_auth/MVP_INSTALL.sql" > "$work/MVP_INSTALL.sql"
m="$tree/supabase/migrations"; t="$tree/supabase/tests"

drop_roles
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
alter role $owner nosuperuser;  -- a failed run may have left the LR2 superuser probe on
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
val() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
sval() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" "$@"; }
# expect_err <label> <pattern> <psql args...>: the command fails with an ERROR matching <pattern>
expect_err() {
  local label="$1" pat="$2"; shift 2
  local out
  if out="$("$@" 2>&1)"; then fail "$label: succeeded"; fi
  printf '%s\n' "$out" | grep -q -- "$pat" || fail "$label: $out"
}
catalog() {
  sval -c "select md5(coalesce(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-') || ':' || p.proowner::regrole::text
    || ':' || p.provolatile::text || p.prosecdef::text, ' ' order by p.oid::regprocedure::text), '')
    || (select coalesce(string_agg(c.conname || pg_get_constraintdef(c.oid), ' ' order by c.conname), '') from pg_constraint c where c.conrelid = to_regclass('postona_threads_resv.reservations')))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'"
}

procs_only() { sval -c "select md5(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-') || ':' || p.proowner::regrole::text
  || ':' || p.provolatile::text || p.prosecdef::text, ' ' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'postona_threads_resv'"; }

# --- the G5 personal MVP world (as G5-47's "ne") ---------------------------------------------------------------------------------
own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own -f "$m/$f" >/dev/null; done
own -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
own -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
own -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null
own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
         20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
         20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
         20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
  own -f "$m/$f.sql" >/dev/null
done
# TEST-WORLD stand-in for G3's L-1 revoke (P3), exactly as the G5 suites do
own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
# TEST-WORLD auth.uid() reading both claim sources (as the G5 suites); managed behaviour NOT_VERIFIED
own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
own -f "$work/MVP_INSTALL.sql" >/dev/null
[ "$(val -c "select (strpos(prosrc, '''g5pv:''') > 0)::text || '/' || (to_regprocedure('private.postona_personal_worker_verdict(uuid,text,text,bigint)') is not null)::text
  || '/' || (to_regprocedure('private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)') is null)::text
  from pg_proc where oid = 'public.common_account_authorization_verdict(text,text,text)'::regprocedure")" = true/true/true ] || fail "world: not G5's personal MVP profile"

# --- G3 001-006 (+ G3's X G4 TEST DOUBLE), by the lifecycle owner ----------------------------------------------------------------
for f in "$resv/001_postona_x_reservations.sql" "$resv/002_postona_x_resv_api_role.sql" "$resv/003_postona_x_resv_g5_binding.sql" \
         "$resv/../postona_x_oauth_t13_guard/g4_predicate_test_double.sql" "$resv/004_postona_x_resv_dispatch.sql" \
         "$resv/005_postona_x_single_post.sql" "$resv/006_postona_x_single_post_live_fence.sql"; do
  own -f "$f" >/dev/null || fail "install $(basename "$f")"
done
# the API / worker roles are NOLOGIN roles for the future Edge / worker logins; the TEST WORLD lets the owner act as them
"${S[@]}" -d "$db" -c "grant postona_resv_api, postona_resv_worker to $owner with set true" >/dev/null
own -f "$here/tests/multi_provider_stand_in.sql" >/dev/null
own -f "$here/tests/test_tables.sql" >/dev/null

# --- 007 in the MVP world: needs R1 and ONE safe worker verdict (here MV) ----------------------------------------------------------
pre007="$(catalog)"
own -c "alter function private.postona_personal_worker_verdict(uuid, text, text, bigint) rename to postona_personal_worker_verdict_off" >/dev/null
expect_err "P007a no worker verdict" POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT own -f "$t007"
own -c "alter function private.postona_personal_worker_verdict_off(uuid, text, text, bigint) rename to postona_personal_worker_verdict" >/dev/null
own -c "grant execute on function private.postona_personal_worker_verdict(uuid, text, text, bigint) to postona_resv_worker" >/dev/null
expect_err "P007b MV reachable" POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT own -f "$t007"
own -c "revoke execute on function private.postona_personal_worker_verdict(uuid, text, text, bigint) from postona_resv_worker" >/dev/null
own -c "alter function private.postona_personal_worker_verdict(uuid, text, text, bigint) security invoker" >/dev/null
expect_err "P007c MV not definer" POSTONA_THREADS_RESV_PRECONDITION_G5_VERDICT own -f "$t007"
own -c "alter function private.postona_personal_worker_verdict(uuid, text, text, bigint) security definer" >/dev/null
[ "$(catalog)" = "$pre007" ] || fail "P007: a refused 007 changed the catalog"
own -f "$t007" >/dev/null || fail "install 007 in the MVP world"
own -f "$here/tests/g4_g5_test_doubles.sql" >/dev/null
own -f "$pm/people.sql" >/dev/null
echo "OK world: G5 personal MVP (21a5cad4 + MVP_INSTALL 4c97140a) + G3 001-006 + 007 (3 refusals first)"

# --- FB ------------------------------------------------------------------------------------------------------------------------
own -f "$pm/fail_before.sql" >/dev/null
echo "OK FB without 009: create refused, nothing written; a full-pair row never claimed"

# --- P -------------------------------------------------------------------------------------------------------------------------
pre="$(catalog)"
expect_err "P1 superuser" G3_THREADS_MVP_PRECONDITION_OWNER_IS_SUPERUSER psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$candidate"
own -c "create function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint) returns text language sql stable as \$\$ select 'active' \$\$" >/dev/null
expect_err "P2 W1 present" G3_THREADS_MVP_PRECONDITION_FULL_PROFILE_PRESENT own -f "$candidate"
own -c "drop function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint)" >/dev/null
own -c "grant execute on function private.postona_personal_worker_verdict(uuid, text, text, bigint) to postona_resv_worker" >/dev/null
expect_err "P3 MV reachable" G3_THREADS_MVP_PRECONDITION_MV own -f "$candidate"
own -c "revoke execute on function private.postona_personal_worker_verdict(uuid, text, text, bigint) from postona_resv_worker" >/dev/null
r1def="$(val -c "select pg_get_functiondef('public.common_account_authorization_verdict(text,text,text)'::regprocedure)")"
own -c "do \$\$ begin execute replace(pg_get_functiondef('public.common_account_authorization_verdict(text,text,text)'::regprocedure), '''g5pv:''', '''g5xx:'''); end \$\$" >/dev/null
expect_err "P4 R1 not MVP" G3_THREADS_MVP_PRECONDITION_R1_MVP own -f "$candidate"
printf '%s\n' "$r1def" > "$work/r1.sql"; own -f "$work/r1.sql" >/dev/null
[ "$(catalog)" = "$pre" ] || fail "P: a refused apply changed the catalog"
pre_procs="$(procs_only)"
pair="$(val -c "select conname from pg_constraint where conrelid = 'postona_threads_resv.reservations'::regclass and pg_get_constraintdef(oid) = 'CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL)))'")"
[ -n "$pair" ] || fail "007's pair rule not found"
own -f "$candidate" >/dev/null || fail "apply 009"
applied="$(catalog)"
expect_err "P5 re-apply" G3_THREADS_MVP_ALREADY_APPLIED own -f "$candidate"
[ "$(catalog)" = "$applied" ] || fail "P5: a refused re-apply changed the catalog"
echo "OK P: 4 refusals (nothing changed), apply, re-apply refused"

# --- M -------------------------------------------------------------------------------------------------------------------------
out="$(own -A -t -f "$pm/behavior.sql")" || fail "behavior"
printf '%s\n' "$out" | grep -qx G3_THREADS_PERSONAL_MVP_BEHAVIOR_PASS || fail "behavior: no PASS line"
echo "OK M: behaviour with 009"

# --- EC (G3-43) ----------------------------------------------------------------------------------------------------------------
trig() { sval -c "select coalesce(string_agg(tgname, ',' order by tgname), '') from pg_trigger where tgrelid = 'postona_threads_resv.reservations'::regclass and not tgisinternal"; }
allrows11() { sval -c "select md5(coalesce(string_agg(concat_ws('/', id, status, outcome_code, lease_token, updated_at), ',' order by id), ''))
  || ':' || (select md5(string_agg(concat_ws('/', id, action, detail), ',' order by id)) from postona_threads_resv.audit) from postona_threads_resv.reservations"; }
pre11="$(catalog)/$(trig)"
pre11_procs="$(procs_only)"
expect_err "AU0 rollback before 011" G3_THREADS_LEASE_AUDIT_ROLLBACK_NOT_APPLIED own -f "$aurb"
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_err "AU1 apply as a superuser" G3_THREADS_LEASE_AUDIT_OWNER own -f "$au"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
for obj in "table postona_threads_resv.reservations" "schema postona_threads_resv"; do
  "${S[@]}" -d "$db" -c "alter $obj owner to authenticated" >/dev/null
  expect_err "AU2 $obj of another owner" G3_THREADS_LEASE_AUDIT_OWNER own -f "$au"
  "${S[@]}" -d "$db" -c "alter $obj owner to $owner" >/dev/null
done
[ "$(catalog)/$(trig)" = "$pre11" ] || fail "AU: a refused apply changed the catalog"
own -f "$au" >/dev/null || fail "apply 011"
[ "$(trig)" = reservations_lease_expired_audit ] || fail "AU3 trigger: $(trig)"
on11="$(catalog)/$(trig)"
expect_err "AU4 re-apply" G3_THREADS_LEASE_AUDIT_BASE_UNKNOWN own -f "$au"
[ "$(catalog)/$(trig)" = "$on11" ] || fail "AU4: a refused re-apply changed the catalog"
out="$(own -A -t -f "$pm/owner_cancel.sql")" || fail "owner cancel: $out"
printf '%s\n' "$out" | grep -qx G3_THREADS_OWNER_CANCEL_BEHAVIOR_PASS || fail "owner cancel: no PASS line"
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_err "AU5 rollback as a superuser" G3_THREADS_LEASE_AUDIT_ROLLBACK_OWNER own -f "$aurb"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
for obj in "table postona_threads_resv.reservations" "schema postona_threads_resv"; do
  "${S[@]}" -d "$db" -c "alter $obj owner to authenticated" >/dev/null
  expect_err "AU6 rollback, $obj of another owner" G3_THREADS_LEASE_AUDIT_ROLLBACK_OWNER own -f "$aurb"
  "${S[@]}" -d "$db" -c "alter $obj owner to $owner" >/dev/null
done
own -c "alter trigger reservations_lease_expired_audit on postona_threads_resv.reservations rename to t43_off" >/dev/null
expect_err "AU7 rollback, half applied" G3_THREADS_LEASE_AUDIT_ROLLBACK_PARTIAL_STATE own -f "$aurb"
own -c "alter trigger t43_off on postona_threads_resv.reservations rename to reservations_lease_expired_audit" >/dev/null
sed 's|^drop function postona_threads_resv.audit_lease_expired();$|&\ngrant select on postona_threads_resv.reservations to authenticated;|' "$aurb" > "$work/aurb_acl.sql"
grep -q '^grant select on postona_threads_resv.reservations to authenticated;$' "$work/aurb_acl.sql" || fail "AU8 probe not built"
expect_err "AU8 rollback with a widened ACL" "G3_THREADS_LEASE_AUDIT_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/aurb_acl.sql"
r11="$(allrows11)"
[ "$(catalog)/$(trig)" = "$on11" ] || fail "AU5-AU8: a refusal changed the catalog"
own -f "$aurb" >/dev/null || fail "AU9 rollback"
[ "$(procs_only)" = "$pre11_procs" ] || fail "AU9 not the procedures before 011"
[ "$(trig)" = "" ] || fail "AU9 trigger left"
[ "$(allrows11)" = "$r11" ] || fail "AU9 a row or audit row moved"
expect_err "AU10 rollback twice" G3_THREADS_LEASE_AUDIT_ROLLBACK_NOT_APPLIED own -f "$aurb"
echo "OK EC: 011 refusals (nothing changed), apply, re-apply refused; own planned row cancelled with the account unverified / the service ending / an old generation; after the end the receipt reads pending -> cancelled / uncertain (G3-44; another person, no subject, ended session refused); another person, no session, claimed, uncertain refused; lease run out -> uncertain with one audit row, receipt uncertain, another person claimed in the same round; 011 rollback refusals, rollback = procedures before 011, rows / audit untouched, twice refused"

# --- LR (G3-42) -----------------------------------------------------------------------------------------------------------------
out="$(own -A -t -f "$pm/live_rows.sql")" || fail "live rows"
printf '%s\n' "$out" | grep -qx G3_THREADS_LIVE_ROWS_SETUP_PASS || fail "live rows: no PASS line"
allrows() { sval -c "select md5(coalesce(string_agg(concat_ws('/', id, status, outcome_code, lease_token, lease_expires_at, bound_owner_epoch, bound_lifecycle_version, updated_at), ',' order by id), ''))
  || ':' || (select count(*) from postona_threads_resv.audit) from postona_threads_resv.reservations"; }
# counted on its own terms: rows with a generation and no owner epoch, in a state some path still updates
expected_live() { sval -c "select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from postona_threads_resv.reservations
  where bound_owner_epoch is null and bound_lifecycle_version is not null and status in ('planned', 'claimed', 'uncertain') group by status) s"; }
# expect_refused <label> <pattern> <psql args...>: refused, and neither the catalog nor any row moved
expect_refused() {
  local label="$1" pat="$2"; shift 2
  local c0 r0; c0="$(catalog)"; r0="$(allrows)"
  expect_err "$label" "$pat" "$@"
  [ "$(catalog)" = "$c0" ] || fail "$label: a refusal changed the catalog"
  [ "$(allrows)" = "$r0" ] || fail "$label: a refusal changed the rows"
}
live="$(expected_live)"
case "$live" in *claimed=*planned=*uncertain=*) ;; *) fail "LR0 live set $live" ;; esac
expect_refused "LR1 rollback, every unfinished state" "G3_THREADS_MVP_ROLLBACK_LIVE_MVP_ROWS: $live\$" own -f "$rollback"
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_refused "LR2 rollback as a superuser" G3_THREADS_MVP_ROLLBACK_OWNER own -f "$rollback"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
"${S[@]}" -d "$db" -c "alter table postona_threads_resv.reservations owner to authenticated" >/dev/null
expect_err "LR3 rollback, table of another owner" G3_THREADS_MVP_ROLLBACK_OWNER own -f "$rollback"
"${S[@]}" -d "$db" -c "alter table postona_threads_resv.reservations owner to $owner" >/dev/null
"${S[@]}" -d "$db" -c "alter schema postona_threads_resv owner to authenticated" >/dev/null
expect_err "LR4 rollback, schema of another owner" G3_THREADS_MVP_ROLLBACK_OWNER own -f "$rollback"
"${S[@]}" -d "$db" -c "alter schema postona_threads_resv owner to $owner" >/dev/null
own -c "alter table postona_threads_resv.reservations rename constraint reservations_personal_mvp_bound to t42_off" >/dev/null
expect_refused "LR5 rollback, half applied" G3_THREADS_MVP_ROLLBACK_PARTIAL_STATE own -f "$rollback"
own -c "alter table postona_threads_resv.reservations rename constraint t42_off to reservations_personal_mvp_bound" >/dev/null
# the person cancels the planned rows, the worker records the claimed rows' outcome (the existing paths); each step still refuses
ids() { sval -c "select coalesce(string_agg(id::text || '/' || coalesce(lease_token::text, '-') || '/' || user_id, ' ' order by id), '') from postona_threads_resv.reservations
  where bound_owner_epoch is null and bound_lifecycle_version is not null and status = '$1' ${2:-}"; }
for r in $(ids planned); do
  IFS=/ read -r id _ uid <<<"$r"
  st="$(val -c "\\ir $pm/helpers.sql" -c "select pg_temp.api(format('select postona_threads_resv.cancel_reservation(%L)', '$id'), '$uid')" | tail -1)"
  [ "$st" = cancelled ] || fail "LR6 $id: the person could not cancel ($st)"  # G3-43: also a person whose service ended
done
[ "$(sval -c "select r.status from postona_threads_resv.reservations r join t42.ids i on i.id = r.id where i.name = 'lp'")" = cancelled ] || fail "LR6 A could not cancel lp"
expect_refused "LR6 rollback, claimed / uncertain left" "G3_THREADS_MVP_ROLLBACK_LIVE_MVP_ROWS: $(expected_live)\$" own -f "$rollback"
case "$(expected_live)" in *planned*) fail "LR6 a planned row left" ;; esac
for r in $(ids claimed "and lease_expires_at > clock_timestamp()"); do
  IFS=/ read -r id lease _ <<<"$r"
  [ "$(sval -c "set role postona_resv_worker; select postona_threads_resv.record('$id', '$lease', 'failed_before_send', null, 'TEST_STOP', 'simulated')")" = failed_before_send ] \
    || fail "LR7 record $id"
done
# a lease that ran out: the next claim_due round fences it to uncertain (it may have reached Threads)
sval -c "set role postona_resv_worker; select count(*) from postona_threads_resv.claim_due('w42', 120, 50)" >/dev/null
[ "$(ids claimed)" = "" ] || fail "LR7 a claimed row left"
expect_refused "LR8 rollback, uncertain left" "G3_THREADS_MVP_ROLLBACK_LIVE_MVP_ROWS: uncertain=[0-9]*\$" own -f "$rollback"
# TEST stand-in for the PENDING_POLICY resolution of an unknown outcome (no path finishes it today)
"${S[@]}" -d "$db" -c "delete from postona_threads_resv.reservations where bound_owner_epoch is null and bound_lifecycle_version is not null and status = 'uncertain'" >/dev/null
# a create that commits while the rollback waits for the table is seen: the rollback locks first, then counts (TEST stand-in insert of an
# MVP-bound planned row, held open 2 s by another session)
c0="$(catalog)"
own -c "begin" \
  -c "insert into postona_threads_resv.reservations (user_id, brand_id, social_account_id, client_request_id, body, content_sha256, scheduled_at, status,
    bound_lifecycle_version)
    select user_id, brand_id, social_account_id, gen_random_uuid(), body, content_sha256, scheduled_at, 'planned', bound_lifecycle_version
    from postona_threads_resv.reservations where status = 'failed' and bound_owner_epoch is null and bound_lifecycle_version is not null order by id limit 1" \
  -c "select pg_sleep(2)" -c "commit" >/dev/null &
race=$!
sleep 0.5
expect_err "LR9b rollback, a create committed while it waits" "G3_THREADS_MVP_ROLLBACK_LIVE_MVP_ROWS: planned=1\$" own -f "$rollback"
wait "$race" || fail "LR9b the concurrent create failed"
[ "$(catalog)" = "$c0" ] || fail "LR9b changed the catalog"
"${S[@]}" -d "$db" -c "delete from postona_threads_resv.reservations where status = 'planned' and bound_owner_epoch is null and bound_lifecycle_version is not null" >/dev/null
# a rollback whose restore would also widen an ACL is stopped by its own postcondition (nothing changed)
sed 's|^-- Postconditions: the FULL adapters|grant select on postona_threads_resv.reservations to authenticated;\n&|' "$rollback" > "$work/rb_acl.sql"
grep -q '^grant select on postona_threads_resv.reservations to authenticated;$' "$work/rb_acl.sql" || fail "LR10 probe not built"
expect_refused "LR10 rollback with a widened ACL" "G3_THREADS_MVP_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/rb_acl.sql"
finished="$(sval -c "select md5(string_agg(concat_ws('/', id, status, outcome_code, updated_at), ',' order by id)) from postona_threads_resv.reservations where bound_owner_epoch is null")"
own -f "$rollback" >/dev/null || fail "LR11 rollback with only finished MVP rows"
out="$(own -A -t -f "$pm/live_rows_full.sql")" || fail "LR12 full world"
printf '%s\n' "$out" | grep -qx G3_THREADS_LIVE_ROWS_FULL_PASS || fail "LR12 full world: no PASS line"
[ "$(sval -c "select md5(string_agg(concat_ws('/', id, status, outcome_code, updated_at), ',' order by id)) from postona_threads_resv.reservations where bound_owner_epoch is null")" = "$finished" ] \
  || fail "LR12 a finished MVP row moved"
echo "OK LR: unfinished MVP rows ($live; every planned one cancelled by its person) refuse (every state, then each left one, a create committed while it waits), superuser / other owner / half applied / ACL postcondition refuse; finished rows stay, B claimed"

# --- RB ------------------------------------------------------------------------------------------------------------------------
# (LR rolled 009 back: the checks below run on that rollback)
# the rollback restores the pre-009 procedures (bodies, ACLs, owners) exactly; the pair rule is back (NOT VALID: MVP-bound rows stay, never sent)
[ "$(procs_only)" = "$pre_procs" ] || fail "RB0 rollback does not restore 007 exactly"
expect_err "RB1 rollback twice" G3_THREADS_MVP_ROLLBACK_NOT_APPLIED own -f "$rollback"
[ "$(val -c "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'postona_threads_resv.reservations'::regclass and conname = '$pair'")" \
  = 'CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL))) NOT VALID' ] || fail "RB2 pair rule"
[ "$(val -c "select count(*) from postona_threads_resv.reservations r where r.status in ('planned', 'claimed') and postona_threads_resv.g5_bound_state(r) = 'active'")" = 0 ] \
  || fail "RB3 a row is active under the FULL adapters in the MVP world"
own -f "$candidate" >/dev/null || fail "RB4 re-apply after rollback"
own -f "$rollback" >/dev/null || fail "RB5 second rollback"
[ "$(procs_only)" = "$pre_procs" ] || fail "RB5 rollback not repeatable"
# no mixing: a planned row bound under the FULL profile refuses the apply
val -c "update postona_threads_resv.reservations set status = 'planned', outcome_code = null, bound_owner_epoch = 3, bound_lifecycle_version = 1 where id = (select id from postona_threads_resv.reservations where status = 'failed' order by id limit 1)" >/dev/null
before_mix="$(catalog)"
expect_err "RB6 mixed bindings" G3_THREADS_MVP_PRECONDITION_MIXED_BINDINGS own -f "$candidate"
[ "$(catalog)" = "$before_mix" ] || fail "RB6 changed the catalog"
val -c "update postona_threads_resv.reservations set status = 'failed', bound_owner_epoch = null, bound_lifecycle_version = null where status = 'planned' and bound_owner_epoch = 3" >/dev/null
own -f "$candidate" >/dev/null || fail "RB7 re-apply"
# 007's own rollback still drops the schema with 009 applied (only 007's object names)
own -f "$here/007_postona_threads_reservations_rollback.sql" >/dev/null || fail "RB8 007 rollback with 009 applied"
[ "$(val -c "select (to_regnamespace('postona_threads_resv') is null)::text")" = true ] || fail "RB8 schema left"
echo "OK RB: rollback restores 007's adapters, refuses twice, no mixing, re-apply; 007 rollback drops all"
echo G3_THREADS_PERSONAL_MVP_PASS
