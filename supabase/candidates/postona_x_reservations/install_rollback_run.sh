#!/usr/bin/env bash
# G3-41: install order, FULL reverse rollback and re-apply of every G3 reservation candidate -- X 001-006 + 008 and Threads 007 + 009 --
# including the new 001 / 002 rollbacks, on a THROW-AWAY LOCAL PostgreSQL 17 with fake data, in G5's PERSONAL MVP world (built as
# personal_mvp_run.sh: the G5 Draft chain at 21a5cad4 via `git archive`, then MVP_INSTALL.sql from PR #550 head 4c97140a, blob-checked;
# both read-only, not changed here). Phases:
#   I   before 001: 002 refused, both new rollbacks answer NOT_APPLIED (catalog unchanged); install all; re-applying 001 / 002 refused;
#   D   personal_mvp/behavior.sql leaves rows in every state (published / failed / uncertain / planned ...);
#   R   reverse order (G3-42: 008's rollback first refuses while an MVP-bound row is unfinished; they are finished first). While a later layer is there, the 002 and 001 rollbacks refuse and change nothing (also: 004's rollback with Threads
#       007 present fails as a whole). Then 002's refusals (a member that can SET the role; a foreign privilege; half applied), 002
#       rollback, 001's refusals (a foreign object; a foreign grant; a consumer function, wrong acknowledgement; live rows; finished rows
#       not / wrongly counted; a view depending on a table), 001 rollback with the exact counts and consumer list. Every refusal leaves the
#       catalog and the rows as they were; after the last step the whole catalog equals the one before 001 (roles included);
#   A   re-apply everything: the catalog equals the first install exactly; install_rollback/smoke.sql (no double send after re-apply).
# No network, no credential, no managed project; no OAuth, token, Vault, SNS or paid call. Roles are cluster-wide: run alone. Usage:
#   RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> install_rollback_run.sh
# Optional: RB001 / RB002 (mutation runs).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
th="$here/../postona_threads_reservations"
rb001="${RB001:-$here/001_postona_x_reservations_rollback.sql}"
rb002="${RB002:-$here/002_postona_x_resv_api_role_rollback.sql}"
pm="$here/personal_mvp"
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
mvp=4c97140a6f1f2e09da387ec66cf234633d9afdd0
owner="kb_postona_rb41_owner"
db="kabumori_postona_rb41_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
work="$(mktemp -d /private/tmp/kabumori-postona-rb41.XXXXXX)"
drop_roles() {
  "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true
}
cleanup() {
  rm -rf "$work"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  drop_roles
  "${S[@]}" -d postgres -c "alter role $owner nosuperuser" >/dev/null 2>&1 || true
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
alter role $owner nosuperuser;  -- a failed run may have left the R3f / R4n superuser probe on
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
# The whole catalog outside the system schemas (test schemas t39 / t41 excluded): functions (body, ACL, owner, volatility, definer),
# relations (kind, owner, ACL), constraints, schemas (owner, ACL), the two G3 roles (attributes) and every membership that touches them.
catalog() {
  sval -c "set search_path = ''; select md5(concat_ws('|',
    (select string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-') || ':' || p.proowner::regrole::text
       || ':' || p.provolatile::text || p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ','), '-'), ' ' order by p.oid::regprocedure::text)
     from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema|t39\$|t41\$)'),
    (select string_agg(n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relowner::regrole::text || ':' || coalesce(array_to_string(c.relacl::text[], ','), '-'),
       ' ' order by n.nspname, c.relname)
     from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema|t39\$|t41\$)'),
    (select string_agg(n.nspname || '.' || co.conname || '=' || pg_catalog.pg_get_constraintdef(co.oid) || ':' || co.convalidated::text, ' ' order by n.nspname, co.conname)
     from pg_catalog.pg_constraint co join pg_catalog.pg_namespace n on n.oid = co.connamespace where n.nspname !~ '^(pg_|information_schema|t39\$|t41\$)'),
    (select string_agg(n.nspname || ':' || n.nspowner::regrole::text || ':' || coalesce(array_to_string(n.nspacl::text[], ','), '-'), ' ' order by n.nspname)
     from pg_catalog.pg_namespace n where n.nspname !~ '^(pg_|information_schema|t39\$|t41\$)'),
    (select string_agg(r.rolname || ':' || r.rolcanlogin::text || r.rolinherit::text || r.rolsuper::text || r.rolbypassrls::text, ' ' order by r.rolname)
     from pg_catalog.pg_roles r where r.rolname in ('postona_resv_api', 'postona_resv_worker')),
    (select string_agg(m.roleid::regrole::text || '>' || m.member::regrole::text || ':' || m.admin_option::text || m.inherit_option::text || m.set_option::text,
       ' ' order by m.roleid::regrole::text, m.member::regrole::text)
     from pg_catalog.pg_auth_members m where m.roleid::regrole::text in ('postona_resv_api', 'postona_resv_worker')
        or m.member::regrole::text in ('postona_resv_api', 'postona_resv_worker'))))"
}
rows() { sval -c "select concat_ws(':', (select count(*) from postona_x_resv.reservations), (select count(*) from postona_x_resv.batches), (select count(*) from postona_x_resv.audit))"; }
# expect_refused <label> <pattern> <psql args...>: refused, and neither the catalog nor the X rows moved
expect_refused() {
  local label="$1" pat="$2"; shift 2
  local c0 r0; c0="$(catalog)"; r0="$(rows)"
  expect_err "$label" "$pat" "$@"
  [ "$(catalog)" = "$c0" ] || fail "$label: a refusal changed the catalog"
  [ "$(rows)" = "$r0" ] || fail "$label: a refusal changed the rows"
}

# --- the G5 personal MVP world (as G5-47's "ne") + the Threads TEST stand-ins (no G3 reservation object yet) ----------------------------
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
own -f "$th/tests/multi_provider_stand_in.sql" >/dev/null
own -f "$th/tests/test_tables.sql" >/dev/null
pre="$(catalog)"
echo "OK world: G5 personal MVP (21a5cad4 + MVP_INSTALL 4c97140a) + Threads test stand-ins"

# --- I: install order ---------------------------------------------------------------------------------------------------------------
expect_err "I0a 002 before 001" POSTONA_RESV_API_PRECONDITION_001_MISSING own -f "$here/002_postona_x_resv_api_role.sql"
expect_err "I0b 001 rollback before 001" POSTONA_RESV_ROLLBACK_NOT_APPLIED own -f "$rb001"
expect_err "I0c 002 rollback before 002" POSTONA_RESV_API_ROLLBACK_NOT_APPLIED own -f "$rb002"
[ "$(catalog)" = "$pre" ] || fail "I0: a refusal changed the catalog"
install_all() {
  for f in "$here/001_postona_x_reservations.sql" "$here/002_postona_x_resv_api_role.sql" "$here/003_postona_x_resv_g5_binding.sql" \
           "$here/../postona_x_oauth_t13_guard/g4_predicate_test_double.sql" "$here/004_postona_x_resv_dispatch.sql" \
           "$here/005_postona_x_single_post.sql" "$here/006_postona_x_single_post_live_fence.sql"; do
    own -f "$f" >/dev/null || fail "install $(basename "$f")"
  done
  # the API / worker roles are NOLOGIN roles for the future Edge / worker logins; the TEST WORLD lets the owner act as them
  "${S[@]}" -d "$db" -c "grant postona_resv_api, postona_resv_worker to $owner with set true" >/dev/null
  for f in "$here/008_postona_x_resv_personal_mvp.sql" "$th/007_postona_threads_reservations.sql" "$th/tests/g4_g5_test_doubles.sql" \
           "$th/009_postona_threads_resv_personal_mvp.sql"; do
    own -f "$f" >/dev/null || fail "install $(basename "$f")"
  done
}
install_all
full="$(catalog)"
expect_refused "I1 re-apply 001" POSTONA_RESV_ALREADY_APPLIED own -f "$here/001_postona_x_reservations.sql"
expect_refused "I2 re-apply 002" POSTONA_RESV_API_ALREADY_APPLIED own -f "$here/002_postona_x_resv_api_role.sql"
echo "OK I: 002 before 001 refused, both rollbacks NOT_APPLIED before install (nothing changed); X 001-006 + 008, Threads 007 + 009 installed; re-apply refused"

# --- D: rows in many states ---------------------------------------------------------------------------------------------------------
own -f "$pm/people.sql" >/dev/null
out="$(own -A -t -f "$pm/behavior.sql")" || fail "behavior"
printf '%s\n' "$out" | grep -qx G3_PERSONAL_MVP_BEHAVIOR_PASS || fail "behavior: no PASS line"
own -c "drop schema t39 cascade" >/dev/null
states="$(sval -c "select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from postona_x_resv.reservations group by status) s")"
echo "OK D: X rows after behavior: $states (rows:batches:audit = $(rows))"

# --- R: reverse order ---------------------------------------------------------------------------------------------------------------
expect_refused "R1a 002 rollback, all layers on" "POSTONA_RESV_API_ROLLBACK_LATER_LAYER_PRESENT: 003,004,005,006,008,threads_007" own -f "$rb002"
expect_refused "R1b 001 rollback, all layers on" "POSTONA_RESV_ROLLBACK_LATER_LAYER_PRESENT: 002,003,004,005,006,008,threads_007" own -f "$rb001"
own -f "$th/009_postona_threads_resv_personal_mvp_rollback.sql" >/dev/null || fail "Threads 009 rollback"
# 004's rollback drops the worker role, which Threads 007 still grants to: it fails as a whole (nothing changed) while 007 is there
expect_refused "R2a 004 rollback with Threads 007 on" "postona_resv_worker" own -f "$here/004_postona_x_resv_dispatch_rollback.sql"
expect_refused "R2b 001 rollback, Threads 007 on" "threads_007" own -f "$rb001"
own -f "$th/007_postona_threads_reservations_rollback.sql" >/dev/null || fail "Threads 007 rollback"
expect_refused "R2c 002 rollback, X 008 on" "POSTONA_RESV_API_ROLLBACK_LATER_LAYER_PRESENT: 003,004,005,006,008\$" own -f "$rb002"
# G3-42: 008's rollback refuses while an MVP-bound row is unfinished (the restored pair rule would refuse its next UPDATE and stop claim_due
# for everyone). Finish them first: the person cancels a planned row, the worker records a claimed row's outcome; an uncertain / expired
# one (or a planned row its person can no longer cancel) has no path today -- removed here as a TEST stand-in (PENDING_POLICY).
expect_refused "R2c2 008 rollback, unfinished MVP rows" "G3_MVP_ROLLBACK_LIVE_MVP_ROWS: " own -f "$here/008_postona_x_resv_personal_mvp_rollback.sql"
for r in $(sval -c "select coalesce(string_agg(id || '/' || revision || '/' || user_id, ' '), '') from postona_x_resv.reservations where status = 'planned' and bound_owner_epoch is null and bound_lifecycle_version is not null"); do
  IFS=/ read -r id rev uid <<<"$r"
  st="$(val -c "\\ir $pm/helpers.sql" -c "select pg_temp.api(format('select status from postona_x_resv.cancel(%L, %s)', '$id', $rev), '$uid')" | tail -1)"
  [ "$st" = cancelled ] || "${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where id = '$id'" >/dev/null
done
for r in $(sval -c "select coalesce(string_agg(id || '/' || lease_token, ' '), '') from postona_x_resv.reservations where status = 'claimed' and lease_expires_at > now() and bound_owner_epoch is null"); do
  IFS=/ read -r id lease <<<"$r"
  [ "$(sval -c "set role postona_resv_worker; select postona_x_resv.finish('$id', '$lease', 'failed_before_send', null, 'TEST_STOP')")" = failed_before_send ] || fail "R2c2 finish $id"
done
"${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where bound_owner_epoch is null and bound_lifecycle_version is not null and status in ('claimed', 'uncertain', 'expired')" >/dev/null
for f in 008_postona_x_resv_personal_mvp_rollback 006_postona_x_single_post_live_fence_rollback 005_postona_x_single_post_rollback; do
  own -f "$here/$f.sql" >/dev/null || fail "$f"
done
expect_refused "R2d 002 rollback, 004 on" "POSTONA_RESV_API_ROLLBACK_LATER_LAYER_PRESENT: 003,004\$" own -f "$rb002"
own -f "$here/004_postona_x_resv_dispatch_rollback.sql" >/dev/null || fail "004 rollback"
expect_refused "R2e 002 rollback, 003 on" "POSTONA_RESV_API_ROLLBACK_LATER_LAYER_PRESENT: 003\$" own -f "$rb002"
expect_refused "R2f 001 rollback, 002 + 003 on" "POSTONA_RESV_ROLLBACK_LATER_LAYER_PRESENT: 002,003\$" own -f "$rb001"
own -f "$here/003_postona_x_resv_g5_binding_rollback.sql" >/dev/null || fail "003 rollback"
echo "OK R1-R2: later layers refuse both new rollbacks (nothing changed); Threads 009, 007, X 008, 006, 005, 004, 003 rolled back"

# 002: a membership that can SET the role (the test world's) refuses; the owner's own ADMIN-only grant does not
expect_refused "R3a 002 rollback, member" POSTONA_RESV_API_ROLLBACK_MEMBERS own -f "$rb002"
"${S[@]}" -d "$db" -c "revoke set option for postona_resv_api from $owner" >/dev/null
"${S[@]}" -d "$db" -c "grant authenticated to postona_resv_api" >/dev/null
expect_refused "R3b 002 rollback, role is a member" POSTONA_RESV_API_ROLLBACK_MEMBERS own -f "$rb002"
"${S[@]}" -d "$db" -c "revoke authenticated from postona_resv_api" >/dev/null
own -c "grant select on public.brands to postona_resv_api" >/dev/null
expect_refused "R3c 002 rollback, foreign privilege" POSTONA_RESV_API_ROLLBACK_FOREIGN_PRIVILEGES own -f "$rb002"
own -c "revoke select on public.brands from postona_resv_api" >/dev/null
own -c "grant execute on function postona_x_resv.sha256_hex(text) to postona_resv_api" >/dev/null
expect_refused "R3d 002 rollback, extra grant in the schema" POSTONA_RESV_API_ROLLBACK_FOREIGN_PRIVILEGES own -f "$rb002"
own -c "revoke execute on function postona_x_resv.sha256_hex(text) from postona_resv_api" >/dev/null
own -c "alter function postona_x_resv.get_reservation(uuid) rename to get_reservation_off" >/dev/null
expect_refused "R3e 002 rollback, half applied" POSTONA_RESV_API_ROLLBACK_PARTIAL_STATE own -f "$rb002"
own -c "alter function postona_x_resv.get_reservation_off(uuid) rename to get_reservation" >/dev/null
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_refused "R3f 002 rollback as a superuser" POSTONA_RESV_API_ROLLBACK_OWNER own -f "$rb002"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
own -f "$rb002" >/dev/null || fail "R3 002 rollback"
[ "$(val -c "select (to_regrole('postona_resv_api') is null and to_regprocedure('postona_x_resv.get_reservation(uuid)') is null)::text")" = true ] || fail "R3: 002 still there"
expect_refused "R3g 002 rollback twice" POSTONA_RESV_API_ROLLBACK_NOT_APPLIED own -f "$rb002"
echo "OK R3: 002 refusals (SET member, role in a role, foreign privilege, extra grant, half applied, superuser), rollback, twice refused"

# 001: refusals, each with nothing changed
own -c "create function postona_x_resv.t41_extra() returns integer language sql as 'select 1'" >/dev/null
expect_refused "R4a 001 rollback, foreign object" "POSTONA_RESV_ROLLBACK_FOREIGN_OBJECTS: postona_x_resv.t41_extra()" own -f "$rb001"
own -c "drop function postona_x_resv.t41_extra()" >/dev/null
own -c "create function postona_x_resv.caller(p text) returns uuid language sql as 'select null::uuid'" >/dev/null
expect_refused "R4b 001 rollback, foreign overload" "POSTONA_RESV_ROLLBACK_FOREIGN_OBJECTS: postona_x_resv.caller(text)" own -f "$rb001"
own -c "drop function postona_x_resv.caller(text)" >/dev/null
"${S[@]}" -d "$db" -c "alter function postona_x_resv.sha256_hex(text) owner to authenticated" >/dev/null
expect_refused "R4b2 001 rollback, function of another owner" "POSTONA_RESV_ROLLBACK_FOREIGN_OBJECTS: postona_x_resv.sha256_hex(text)" own -f "$rb001"
"${S[@]}" -d "$db" -c "alter function postona_x_resv.sha256_hex(text) owner to $owner" >/dev/null
own -c "grant usage on schema postona_x_resv to authenticated" >/dev/null
expect_refused "R4c 001 rollback, foreign schema grant" POSTONA_RESV_ROLLBACK_FOREIGN_GRANTS own -f "$rb001"
own -c "revoke usage on schema postona_x_resv from authenticated" >/dev/null
own -c "grant execute on function postona_x_resv.sha256_hex(text) to public" >/dev/null
expect_refused "R4d 001 rollback, PUBLIC function grant" POSTONA_RESV_ROLLBACK_FOREIGN_GRANTS own -f "$rb001"
own -c "revoke execute on function postona_x_resv.sha256_hex(text) from public" >/dev/null
own -c "grant select (id) on postona_x_resv.audit to service_role" >/dev/null
expect_refused "R4e 001 rollback, column grant" POSTONA_RESV_ROLLBACK_FOREIGN_GRANTS own -f "$rb001"
own -c "revoke select (id) on postona_x_resv.audit from service_role" >/dev/null
# a consumer outside the schema (stand-in for the F3 publish_enabled T13 guard, which calls G4's X predicate)
own -c "create function public.t41_consumer(p_user uuid, p_account text) returns boolean language plpgsql stable as \$\$ begin return postona_x_resv.g4_x_account_verified(p_user, p_account); end \$\$" >/dev/null
expect_refused "R4f 001 rollback, consumer" "POSTONA_RESV_ROLLBACK_CONSUMERS_PRESENT: public.t41_consumer(uuid,text)" own -f "$rb001"
expect_refused "R4g 001 rollback, wrong consumer list" POSTONA_RESV_ROLLBACK_CONSUMERS_PRESENT own -c "set postona_resv_rollback.ack_consumers = 'public.other()'" -f "$rb001"
ack="set postona_resv_rollback.ack_consumers = 'public.t41_consumer(uuid,text)'"
# live rows: planned / claimed / uncertain are never dropped. The MVP-bound ones were finished before 008's rollback (R2c2); these are
# unbound rows (TEST stand-ins, as an operator who has not resolved them would leave them), which the restored pair rule takes.
ins_row() {  # <status> <draft> <position> <extra columns> <extra values>
  "${S[@]}" -d "$db" -c "insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
    scheduled_at, fixed, status, consent_state, consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at$4)
    select batch_id, user_id, brand_id, social_account_id, '$2', $3, origin, mode, body, content_sha256, scheduled_at, fixed, '$1', consent_state,
           consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at$5
    from postona_x_resv.reservations where status = 'failed' order by id limit 1" >/dev/null
}
ins_row planned t41p 47 "" ""
ins_row claimed t41c 48 ", lease_token, lease_expires_at, claimed_by" ", gen_random_uuid(), now() + interval '2 minutes', 'w41'"
live="$(sval -c "select count(*) from postona_x_resv.reservations where status in ('planned', 'claimed', 'uncertain')")"
[ "$live" = 2 ] || fail "R4h: live stand-ins $live"
expect_refused "R4h 001 rollback, live rows" POSTONA_RESV_ROLLBACK_LIVE_ROWS own -c "$ack" -c "set postona_resv_rollback.discard_rows = '$(rows)'" -f "$rb001"
# one live status at a time: the operator resolves (exports, then removes) each; the rollback refuses while any is left.
"${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where status = 'planned'" >/dev/null
[ "$(sval -c "select count(*) from postona_x_resv.reservations where status = 'claimed'")" -gt 0 ] || fail "R4i: no claimed row to test with"
expect_refused "R4i 001 rollback, a claimed row left" POSTONA_RESV_ROLLBACK_LIVE_ROWS own -c "$ack" -c "set postona_resv_rollback.discard_rows = '$(rows)'" -f "$rb001"
"${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where status = 'claimed'" >/dev/null
# an uncertain row (outcome unknown: may have been sent), unbound so the restored pair rule takes it
"${S[@]}" -d "$db" -c "insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
  scheduled_at, fixed, status, consent_state, consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at, outcome_code)
  select batch_id, user_id, brand_id, social_account_id, 't41u', 49, origin, mode, body, content_sha256, scheduled_at, fixed, 'uncertain', consent_state,
         consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at, 'LEASE_EXPIRED'
  from postona_x_resv.reservations where status = 'failed' order by id limit 1" >/dev/null
expect_refused "R4j 001 rollback, an uncertain row" POSTONA_RESV_ROLLBACK_LIVE_ROWS own -c "$ack" -c "set postona_resv_rollback.discard_rows = '$(rows)'" -f "$rb001"
"${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where status = 'uncertain'" >/dev/null
counts="$(rows)"
expect_refused "R4k 001 rollback, rows not counted" "POSTONA_RESV_ROLLBACK_ROWS_NOT_ACKNOWLEDGED: $counts" own -c "$ack" -f "$rb001"
expect_refused "R4l 001 rollback, wrong counts" POSTONA_RESV_ROLLBACK_ROWS_NOT_ACKNOWLEDGED own -c "$ack" -c "set postona_resv_rollback.discard_rows = '${counts%%:*}:0:0'" -f "$rb001"
own -c "create view public.t41_view as select id from postona_x_resv.audit" >/dev/null
expect_refused "R4m 001 rollback, dependent view" POSTONA_RESV_ROLLBACK_FOREIGN_DEPENDENTS own -c "$ack" -c "set postona_resv_rollback.discard_rows = '$counts'" -f "$rb001"
own -c "drop view public.t41_view" >/dev/null
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_refused "R4n 001 rollback as a superuser" POSTONA_RESV_ROLLBACK_OWNER own -c "$ack" -c "set postona_resv_rollback.discard_rows = '$counts'" -f "$rb001"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
own -c "$ack" -c "set postona_resv_rollback.discard_rows = '$counts'" -f "$rb001" >/dev/null || fail "R4 001 rollback"
[ "$(val -c "select (to_regnamespace('postona_x_resv') is null)::text")" = true ] || fail "R4: schema still there"
# the acknowledged consumer is untouched and now fails (closed), never answers true
expect_err "R4o consumer fails closed" "postona_x_resv" own -c "select public.t41_consumer(gen_random_uuid(), 'x')"
expect_refused_nors() { local c0; c0="$(catalog)"; expect_err "$@"; [ "$(catalog)" = "$c0" ] || fail "$1: changed the catalog"; }
expect_refused_nors "R4p 001 rollback twice" POSTONA_RESV_ROLLBACK_NOT_APPLIED own -f "$rb001"
own -c "drop function public.t41_consumer(uuid, text)" >/dev/null
[ "$(catalog)" = "$pre" ] || fail "R4: the catalog after the full rollback is not the one before 001"
echo "OK R4: 001 refusals (foreign object / overload / owner, schema / PUBLIC / column grant, consumer, wrong ack, live rows, uncounted / wrong counts, dependent view, superuser), rollback, consumer fails closed, twice refused; whole catalog = before 001"

# --- A: re-apply ------------------------------------------------------------------------------------------------------------------
install_all
[ "$(catalog)" = "$full" ] || fail "A: the re-applied catalog is not the first install"
out="$(own -A -t -f "$here/install_rollback/smoke.sql")" || fail "smoke"
printf '%s\n' "$out" | grep -qx G3_INSTALL_ROLLBACK_SMOKE_PASS || fail "smoke: no PASS line"
echo "OK A: re-applied catalog = first install; smoke (send once, lease lost -> uncertain never re-sent, generation move refused)"
echo G3_RESV_INSTALL_ROLLBACK_PASS
