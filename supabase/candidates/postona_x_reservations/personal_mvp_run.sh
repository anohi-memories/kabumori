#!/usr/bin/env bash
# G3-39: the X reservations / single post (001-006) + 008 on G5's PERSONAL MVP auth profile, on a THROW-AWAY LOCAL PostgreSQL 17 with fake data.
# The world is built exactly as G5-47's runner (supabase/tests/postona_personal_mvp_auth_pg_run.sh at 4c97140a, world "ne"): the G5 Draft chain
# at 21a5cad4 via `git archive` (read-only), then G5's MVP_INSTALL.sql from PR #550 head 4c97140a (blob-checked, read-only, not changed here).
# Then G3 001, 002, 003, G3's G4 TEST DOUBLE, 004, 005, 006 -- all by the lifecycle owner -- and:
#   FB  without 008: R1-MVP's g5pv token is refused by the FULL-profile adapters -> every create / single post refused, nothing written;
#   OC  (G3-43) 010 refusals (superuser; table / schema / cancel of another owner; another cancel version), nothing changed; apply (before
#       008: it does not depend on the profile); re-apply refused;
#   P   008 refusals (superuser; G5's W1 present; MV reachable by an API role; R1 not the MVP body), nothing changed; apply; re-apply refused;
#   M   behaviour with 008 (personal_mvp/behavior.sql);
#   LR  (G3-42) unfinished MVP-bound rows (planned / claimed / lease run out / uncertain / expired) refuse the rollback, nothing changed;
#       also: superuser, schema / table of another owner, half applied, a broken owner / ACL postcondition. Finish them (cancel -- G3-43:
#       every planned row, also of a person whose service ended; worker outcome; uncertain / expired single post: a TEST stand-in removal
#       -- their resolution is PENDING_POLICY), roll back with an expired non-single row left (G3-43); finished MVP rows stay untouched and
#       another person's FULL-bound row is claimed (the dispatch is not stopped);
#   RB  rollback restores 001's adapters exactly; a FULL-bound planned row refuses a re-apply (no mixing); re-apply.
#   EC  (G3-43) the person's own cancel without the service gate, the lease-expired audit (personal_mvp/owner_cancel.sql);
#   OR  (G3-43) 010's rollback: refusals (superuser, other owners, half applied, a widened ACL), 001's cancel back byte for byte (the ended
#       person cannot cancel again), rows and audit rows untouched; twice refused; re-apply, the ended person cancels.
# No network, no credential, no managed project; no OAuth, token, Vault, SNS or paid call. Roles are cluster-wide: run alone. Usage:
#   RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> personal_mvp_run.sh
# Optional: MVP_CANDIDATE / MVP_ROLLBACK / OC_CANDIDATE / OC_ROLLBACK (mutation runs).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
candidate="${MVP_CANDIDATE:-$here/008_postona_x_resv_personal_mvp.sql}"
rollback="${MVP_ROLLBACK:-$here/008_postona_x_resv_personal_mvp_rollback.sql}"
oc="${OC_CANDIDATE:-$here/010_postona_x_resv_owner_cancel.sql}"
ocrb="${OC_ROLLBACK:-$here/010_postona_x_resv_owner_cancel_rollback.sql}"
pm="$here/personal_mvp"
pin=21a5cad4b71de63265db8517da93c6efc60cdde8
mvp=4c97140a6f1f2e09da387ec66cf234633d9afdd0
owner="kb_postona_mvp_owner"
db="kabumori_postona_mvp_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
work="$(mktemp -d /private/tmp/kabumori-postona-mvp.XXXXXX)"
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
    || (select coalesce(string_agg(c.conname || pg_get_constraintdef(c.oid), ' ' order by c.conname), '') from pg_constraint c where c.conrelid = 'postona_x_resv.reservations'::regclass))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'"
}

procs_only() { sval -c "select md5(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || ':' || coalesce(array_to_string(p.proacl::text[], ','), '-') || ':' || p.proowner::regrole::text
  || ':' || p.provolatile::text || p.prosecdef::text, ' ' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'postona_x_resv'"; }

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

# --- G3 001-006 (+ G3's G4 TEST DOUBLE), by the lifecycle owner ------------------------------------------------------------------
for f in "$here/001_postona_x_reservations.sql" "$here/002_postona_x_resv_api_role.sql" "$here/003_postona_x_resv_g5_binding.sql" \
         "$here/../postona_x_oauth_t13_guard/g4_predicate_test_double.sql" "$here/004_postona_x_resv_dispatch.sql" \
         "$here/005_postona_x_single_post.sql" "$here/006_postona_x_single_post_live_fence.sql"; do
  own -f "$f" >/dev/null || fail "install $(basename "$f")"
done
# the API / worker roles are NOLOGIN roles for the future Edge / worker logins; the TEST WORLD lets the owner act as them
"${S[@]}" -d "$db" -c "grant postona_resv_api, postona_resv_worker to $owner with set true" >/dev/null
own -f "$pm/people.sql" >/dev/null
echo "OK world: G5 personal MVP (21a5cad4 + MVP_INSTALL 4c97140a) + G3 001-006"

# --- FB ------------------------------------------------------------------------------------------------------------------------
own -f "$pm/fail_before.sql" >/dev/null
echo "OK FB without 008: create / single post refused, nothing written"

# --- OC (G3-43) ----------------------------------------------------------------------------------------------------------------
trig() { sval -c "select coalesce(string_agg(tgname, ',' order by tgname), '') from pg_trigger where tgrelid = 'postona_x_resv.reservations'::regclass and not tgisinternal"; }
cancel_acl() { sval -c "select md5(prosrc) || ':' || proowner::regrole::text || ':' || coalesce(proacl::text, '-') from pg_proc where oid = 'postona_x_resv.cancel(uuid,integer)'::regprocedure"; }
pre10="$(catalog)/$(trig)"
pre10_cancel="$(cancel_acl)"
case "$pre10_cancel" in 9ac799ef3ee18dfad2800ed5557c1c0f:*) ;; *) fail "OC0 001's cancel is not the expected body: $pre10_cancel" ;; esac
expect_err "OC0 rollback before 010" G3_OWNER_CANCEL_ROLLBACK_NOT_APPLIED own -f "$ocrb"
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_err "OC1 apply as a superuser" G3_OWNER_CANCEL_OWNER own -f "$oc"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
for obj in "table postona_x_resv.reservations" "schema postona_x_resv" "function postona_x_resv.cancel(uuid, integer)"; do
  "${S[@]}" -d "$db" -c "alter $obj owner to authenticated" >/dev/null
  expect_err "OC2 $obj of another owner" G3_OWNER_CANCEL_OWNER own -f "$oc"
  "${S[@]}" -d "$db" -c "alter $obj owner to $owner" >/dev/null
done
cancel_def="$(val -c "select pg_get_functiondef('postona_x_resv.cancel(uuid,integer)'::regprocedure)")"
printf 'begin;\n%s;\n' "${cancel_def/CANCEL_TOO_LATE/CANCEL_TOO_LATE_X}" > "$work/oc_other.sql"
grep -q CANCEL_TOO_LATE_X "$work/oc_other.sql" || fail "OC3 probe not built"
expect_err "OC3 another cancel version" G3_OWNER_CANCEL_BASE_UNKNOWN own -f "$work/oc_other.sql" -f "$oc"
[ "$(catalog)/$(trig)" = "$pre10" ] || fail "OC: a refused apply changed the catalog"
[ "$(cancel_acl)" = "$pre10_cancel" ] || fail "OC: a refused apply changed cancel"
own -f "$oc" >/dev/null || fail "apply 010"
on10="$(catalog)/$(trig)"
[ "$(trig)" = reservations_lease_expired_audit ] || fail "OC4 trigger: $(trig)"
[ "$(cancel_acl | cut -d: -f2-)" = "$(printf '%s' "$pre10_cancel" | cut -d: -f2-)" ] || fail "OC4 cancel's owner / ACL moved"
expect_err "OC5 re-apply" G3_OWNER_CANCEL_BASE_UNKNOWN own -f "$oc"
[ "$(catalog)/$(trig)" = "$on10" ] || fail "OC5: a refused re-apply changed the catalog"
echo "OK OC: 010 refusals (superuser; table / schema / cancel of another owner; another cancel version), nothing changed; apply; re-apply refused"

# --- P -------------------------------------------------------------------------------------------------------------------------
pre="$(catalog)"
expect_err "P1 superuser" G3_MVP_PRECONDITION_OWNER_IS_SUPERUSER psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$candidate"
own -c "create function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint) returns text language sql stable as \$\$ select 'active' \$\$" >/dev/null
expect_err "P2 W1 present" G3_MVP_PRECONDITION_FULL_PROFILE_PRESENT own -f "$candidate"
own -c "drop function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint)" >/dev/null
own -c "grant execute on function private.postona_personal_worker_verdict(uuid, text, text, bigint) to postona_resv_worker" >/dev/null
expect_err "P3 MV reachable" G3_MVP_PRECONDITION_MV own -f "$candidate"
own -c "revoke execute on function private.postona_personal_worker_verdict(uuid, text, text, bigint) from postona_resv_worker" >/dev/null
r1def="$(val -c "select pg_get_functiondef('public.common_account_authorization_verdict(text,text,text)'::regprocedure)")"
own -c "do \$\$ begin execute replace(pg_get_functiondef('public.common_account_authorization_verdict(text,text,text)'::regprocedure), '''g5pv:''', '''g5xx:'''); end \$\$" >/dev/null
expect_err "P4 R1 not MVP" G3_MVP_PRECONDITION_R1_MVP own -f "$candidate"
printf '%s\n' "$r1def" > "$work/r1.sql"; own -f "$work/r1.sql" >/dev/null
[ "$(catalog)" = "$pre" ] || fail "P: a refused apply changed the catalog"
pre_procs="$(procs_only)"
pair="$(val -c "select conname from pg_constraint where conrelid = 'postona_x_resv.reservations'::regclass and pg_get_constraintdef(oid) = 'CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL)))'")"
[ -n "$pair" ] || fail "001's pair rule not found"
own -f "$candidate" >/dev/null || fail "apply 008"
applied="$(catalog)"
expect_err "P5 re-apply" G3_MVP_ALREADY_APPLIED own -f "$candidate"
[ "$(catalog)" = "$applied" ] || fail "P5: a refused re-apply changed the catalog"
echo "OK P: 4 refusals (nothing changed), apply, re-apply refused"

# --- M -------------------------------------------------------------------------------------------------------------------------
out="$(own -A -t -f "$pm/behavior.sql")" || fail "behavior"
printf '%s\n' "$out" | grep -qx G3_PERSONAL_MVP_BEHAVIOR_PASS || fail "behavior: no PASS line"
echo "OK M: behaviour with 008"

# --- LR (G3-42) -----------------------------------------------------------------------------------------------------------------
out="$(own -A -t -f "$pm/live_rows.sql")" || fail "live rows"
printf '%s\n' "$out" | grep -qx G3_LIVE_ROWS_SETUP_PASS || fail "live rows: no PASS line"
allrows() { sval -c "select md5(coalesce(string_agg(concat_ws('/', id, status, outcome_code, lease_token, lease_expires_at, bound_owner_epoch, bound_lifecycle_version, updated_at), ',' order by id), ''))
  || ':' || (select count(*) from postona_x_resv.audit) from postona_x_resv.reservations"; }
# counted on its own terms: rows with a generation and no owner epoch, in a state some path still updates (G3-43: an expired row only when
# single post can re-arm it)
expected_live() { sval -c "select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from postona_x_resv.reservations
  where bound_owner_epoch is null and bound_lifecycle_version is not null
    and (status in ('planned', 'claimed', 'uncertain') or (status = 'expired' and draft_id ~ '^single:')) group by status) s"; }
# expect_refused <label> <pattern> <psql args...>: refused, and neither the catalog nor any row moved
expect_refused() {
  local label="$1" pat="$2"; shift 2
  local c0 r0; c0="$(catalog)"; r0="$(allrows)"
  expect_err "$label" "$pat" "$@"
  [ "$(catalog)" = "$c0" ] || fail "$label: a refusal changed the catalog"
  [ "$(allrows)" = "$r0" ] || fail "$label: a refusal changed the rows"
}
live="$(expected_live)"
case "$live" in *claimed=*expired=1*planned=*uncertain=1*) ;; *) fail "LR0 live set $live" ;; esac
expect_refused "LR1 rollback, every unfinished state" "G3_MVP_ROLLBACK_LIVE_MVP_ROWS: $live\$" own -f "$rollback"
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_refused "LR2 rollback as a superuser" G3_MVP_ROLLBACK_OWNER own -f "$rollback"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
"${S[@]}" -d "$db" -c "alter table postona_x_resv.reservations owner to authenticated" >/dev/null
expect_err "LR3 rollback, table of another owner" G3_MVP_ROLLBACK_OWNER own -f "$rollback"
"${S[@]}" -d "$db" -c "alter table postona_x_resv.reservations owner to $owner" >/dev/null
"${S[@]}" -d "$db" -c "alter schema postona_x_resv owner to authenticated" >/dev/null
expect_err "LR4 rollback, schema of another owner" G3_MVP_ROLLBACK_OWNER own -f "$rollback"
"${S[@]}" -d "$db" -c "alter schema postona_x_resv owner to $owner" >/dev/null
own -c "alter table postona_x_resv.reservations rename constraint reservations_personal_mvp_bound to t42_off" >/dev/null
expect_refused "LR5 rollback, half applied" G3_MVP_ROLLBACK_PARTIAL_STATE own -f "$rollback"
own -c "alter table postona_x_resv.reservations rename constraint t42_off to reservations_personal_mvp_bound" >/dev/null
# the person cancels the planned rows, the worker records the claimed rows' outcome (the existing paths); each step still refuses
ids() { sval -c "select coalesce(string_agg(id::text || '/' || revision || '/' || coalesce(lease_token::text, '-') || '/' || user_id, ' ' order by id), '') from postona_x_resv.reservations
  where bound_owner_epoch is null and bound_lifecycle_version is not null and status = '$1' ${2:-}"; }
for r in $(ids planned); do
  IFS=/ read -r id rev _ uid <<<"$r"
  st="$(val -c "\\ir $pm/helpers.sql" -c "select pg_temp.api(format('select status from postona_x_resv.cancel(%L, %s)', '$id', $rev), '$uid')" | tail -1)"
  [ "$st" = cancelled ] || fail "LR6 $id: the person could not cancel ($st)"  # G3-43: also a person whose service ended
done
[ "$(sval -c "select r.status from postona_x_resv.reservations r join t42.ids i on i.id = r.id where i.name = 'lp'")" = cancelled ] || fail "LR6 A could not cancel lp"
expect_refused "LR6 rollback, claimed / uncertain / expired left" "G3_MVP_ROLLBACK_LIVE_MVP_ROWS: $(expected_live)\$" own -f "$rollback"
case "$(expected_live)" in *planned*) fail "LR6 a planned row left" ;; esac
for r in $(ids claimed "and lease_expires_at > now()"); do
  IFS=/ read -r id _ lease _ <<<"$r"
  [ "$(sval -c "set role postona_resv_worker; select postona_x_resv.finish('$id', '$lease', 'failed_before_send', null, 'TEST_STOP')")" = failed_before_send ] || fail "LR7 finish $id"
done
# a lease that ran out: the next claim_due round fences it to uncertain (it may have reached X)
sval -c "set role postona_resv_worker; select count(*) from postona_x_resv.claim_due('w42', 120, 50)" >/dev/null
[ "$(ids claimed)" = "" ] || fail "LR7 a claimed row left"
expect_refused "LR8 rollback, uncertain / expired left" "G3_MVP_ROLLBACK_LIVE_MVP_ROWS: expired=1,uncertain=[0-9]*\$" own -f "$rollback"
# TEST stand-in for the PENDING_POLICY resolution of an unknown outcome / an expired single-post row (no path finishes them today); the
# expired non-single row le stays (G3-43: nothing updates it, so it no longer refuses)
"${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where bound_owner_epoch is null and bound_lifecycle_version is not null and status = 'uncertain'" >/dev/null
expect_refused "LR9 rollback, an expired row left" "G3_MVP_ROLLBACK_LIVE_MVP_ROWS: expired=1\$" own -f "$rollback"
"${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where bound_owner_epoch is null and bound_lifecycle_version is not null and status = 'expired' and draft_id ~ '^single:'" >/dev/null
[ "$(sval -c "select count(*) from postona_x_resv.reservations where bound_owner_epoch is null and bound_lifecycle_version is not null and status = 'expired'")" -ge 1 ] \
  || fail "LR9 no expired non-single row left for the rollback"
[ "$(expected_live)" = "" ] || fail "LR9 left: $(expected_live)"
# a create that commits while the rollback waits for the table is seen: the rollback locks first, then counts (TEST stand-in insert of an
# MVP-bound planned row, held open 2 s by another session)
c0="$(catalog)"
own -c "begin" \
  -c "insert into postona_x_resv.reservations (batch_id, user_id, brand_id, social_account_id, draft_id, position, origin, mode, body, content_sha256,
    scheduled_at, fixed, status, consent_state, consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at, bound_lifecycle_version)
    select batch_id, user_id, brand_id, social_account_id, 'g42race', 49, origin, mode, body, content_sha256, scheduled_at, fixed, 'planned', consent_state,
           consent_sha256, consent_scheduled_at, consent_revision, consent_at, expires_at, bound_lifecycle_version
    from postona_x_resv.reservations where status = 'failed' and bound_owner_epoch is null and bound_lifecycle_version is not null order by id limit 1" \
  -c "select pg_sleep(2)" -c "commit" >/dev/null &
race=$!
sleep 0.5
expect_err "LR9b rollback, a create committed while it waits" "G3_MVP_ROLLBACK_LIVE_MVP_ROWS: planned=1\$" own -f "$rollback"
wait "$race" || fail "LR9b the concurrent create failed"
[ "$(catalog)" = "$c0" ] || fail "LR9b changed the catalog"
"${S[@]}" -d "$db" -c "delete from postona_x_resv.reservations where status = 'planned' and bound_owner_epoch is null and bound_lifecycle_version is not null" >/dev/null
# a rollback whose restore would also widen an ACL is stopped by its own postcondition (nothing changed)
sed 's|^-- Postconditions: the FULL adapters|grant select on postona_x_resv.reservations to authenticated;\n&|' "$rollback" > "$work/rb_acl.sql"
grep -q '^grant select on postona_x_resv.reservations to authenticated;$' "$work/rb_acl.sql" || fail "LR10 probe not built"
expect_refused "LR10 rollback with a widened ACL" "G3_MVP_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/rb_acl.sql"
finished="$(sval -c "select md5(string_agg(concat_ws('/', id, status, outcome_code, updated_at), ',' order by id)) from postona_x_resv.reservations where bound_owner_epoch is null")"
own -f "$rollback" >/dev/null || fail "LR11 rollback with only finished MVP rows"
out="$(own -A -t -f "$pm/live_rows_full.sql")" || fail "LR12 full world"
printf '%s\n' "$out" | grep -qx G3_LIVE_ROWS_FULL_PASS || fail "LR12 full world: no PASS line"
[ "$(sval -c "select md5(string_agg(concat_ws('/', id, status, outcome_code, updated_at), ',' order by id)) from postona_x_resv.reservations where bound_owner_epoch is null")" = "$finished" ] \
  || fail "LR12 a finished MVP row moved"
echo "OK LR: unfinished MVP rows ($live; every planned one cancelled by its person) refuse (every state, then each left one, a create committed while it waits), superuser / other owner / half applied / ACL postcondition refuse; rolled back with an expired non-single row; finished rows stay, B claimed"

# --- RB ------------------------------------------------------------------------------------------------------------------------
# (LR rolled 008 back: the checks below run on that rollback)
# the rollback restores the pre-008 procedures (bodies, ACLs, owners) exactly; the pair rule is back (NOT VALID: MVP-bound rows stay, never sent)
[ "$(procs_only)" = "$pre_procs" ] || fail "RB0 rollback does not restore 001-006 exactly"
expect_err "RB1 rollback twice" G3_MVP_ROLLBACK_NOT_APPLIED own -f "$rollback"
[ "$(val -c "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'postona_x_resv.reservations'::regclass and conname = '$pair'")" \
  = 'CHECK (((bound_owner_epoch IS NULL) = (bound_lifecycle_version IS NULL))) NOT VALID' ] || fail "RB2 pair rule"
[ "$(val -c "select count(*) from postona_x_resv.reservations r where r.status in ('planned', 'claimed') and postona_x_resv.row_publishable(r)")" = 0 ] \
  || fail "RB3 a row is publishable under the FULL adapters in the MVP world"
own -f "$candidate" >/dev/null || fail "RB4 re-apply after rollback"
own -f "$rollback" >/dev/null || fail "RB5 second rollback"
[ "$(procs_only)" = "$pre_procs" ] || fail "RB5 rollback not repeatable"
# no mixing: a planned row bound under the FULL profile refuses the apply
val -c "update postona_x_resv.reservations set status = 'planned', bound_owner_epoch = 3, bound_lifecycle_version = 1 where id = (select id from postona_x_resv.reservations where status = 'failed' order by id limit 1)" >/dev/null
before_mix="$(catalog)"
expect_err "RB6 mixed bindings" G3_MVP_PRECONDITION_MIXED_BINDINGS own -f "$candidate"
[ "$(catalog)" = "$before_mix" ] || fail "RB6 changed the catalog"
val -c "update postona_x_resv.reservations set status = 'failed', bound_owner_epoch = null, bound_lifecycle_version = null where status = 'planned' and bound_owner_epoch = 3" >/dev/null
own -f "$candidate" >/dev/null || fail "RB7 re-apply"
echo "OK RB: rollback restores 001's adapters, refuses twice, no mixing, re-apply"

# --- EC (G3-43) ----------------------------------------------------------------------------------------------------------------
out="$(own -A -t -f "$pm/owner_cancel.sql")" || fail "owner cancel: $out"
printf '%s\n' "$out" | grep -qx G3_OWNER_CANCEL_BEHAVIOR_PASS || fail "owner cancel: no PASS line"
echo "OK EC: own planned row cancelled with the X account unverified / the service ending / an old generation; another person, no session, stale or null revision, claimed, uncertain refused; lease run out -> uncertain with one audit row (claim_due, single post), another person claimed in the same round"

# --- OR (G3-43) ----------------------------------------------------------------------------------------------------------------
c9="$(sval -c "select i.id || '/' || r.revision || '/' || r.user_id from t43.ids i join postona_x_resv.reservations r on r.id = i.id where i.name = 'c9'")"
IFS=/ read -r c9id c9rev c9uid <<<"$c9"
cancel_c9() { val -c "\\ir $pm/helpers.sql" -c "select pg_temp.api(format('select status from postona_x_resv.cancel(%L, %s)', '$c9id', $c9rev), '$c9uid')" | tail -1; }
allrows10() { sval -c "select md5(coalesce(string_agg(concat_ws('/', id, status, revision, outcome_code, lease_token, updated_at), ',' order by id), ''))
  || ':' || (select md5(string_agg(concat_ws('/', id, action, detail), ',' order by id)) from postona_x_resv.audit) from postona_x_resv.reservations"; }
or0="$(catalog)/$(trig)"
"${S[@]}" -d "$db" -c "alter role $owner superuser" >/dev/null
expect_err "OR1 rollback as a superuser" G3_OWNER_CANCEL_ROLLBACK_OWNER own -f "$ocrb"
"${S[@]}" -d "$db" -c "alter role $owner nosuperuser" >/dev/null
for obj in "table postona_x_resv.reservations" "schema postona_x_resv" "function postona_x_resv.cancel(uuid, integer)"; do
  "${S[@]}" -d "$db" -c "alter $obj owner to authenticated" >/dev/null
  expect_err "OR2 rollback, $obj of another owner" G3_OWNER_CANCEL_ROLLBACK_OWNER own -f "$ocrb"
  "${S[@]}" -d "$db" -c "alter $obj owner to $owner" >/dev/null
done
own -c "alter trigger reservations_lease_expired_audit on postona_x_resv.reservations rename to t43_off" >/dev/null
expect_err "OR3 rollback, half applied" G3_OWNER_CANCEL_ROLLBACK_PARTIAL_STATE own -f "$ocrb"
own -c "alter trigger t43_off on postona_x_resv.reservations rename to reservations_lease_expired_audit" >/dev/null
sed 's|^-- 001.s cancel, verbatim$|grant select on postona_x_resv.reservations to authenticated;\n&|' "$ocrb" > "$work/ocrb_acl.sql"
grep -q '^grant select on postona_x_resv.reservations to authenticated;$' "$work/ocrb_acl.sql" || fail "OR4 probe not built"
expect_err "OR4 rollback with a widened ACL" "G3_OWNER_CANCEL_ROLLBACK_POSTCONDITION: an owner or ACL changed" own -f "$work/ocrb_acl.sql"
[ "$(catalog)/$(trig)" = "$or0" ] || fail "OR1-OR4: a refusal changed the catalog"
r10="$(allrows10)"
own -f "$ocrb" >/dev/null || fail "OR5 rollback"
[ "$(cancel_acl)" = "$pre10_cancel" ] || fail "OR5 not 001's cancel (body, owner, ACL)"
[ "$(trig)" = "" ] || fail "OR5 trigger left"
[ "$(allrows10)" = "$r10" ] || fail "OR5 a row or audit row moved"
[ "$(cancel_c9)" = "ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE" ] || fail "OR6 001's cancel: the ended person is refused again ($(cancel_c9))"
expect_err "OR7 rollback twice" G3_OWNER_CANCEL_ROLLBACK_NOT_APPLIED own -f "$ocrb"
own -f "$oc" >/dev/null || fail "OR8 re-apply"
[ "$(cancel_c9)" = cancelled ] || fail "OR8 re-applied: the ended person cancels c9"
echo "OK OR: 010 rollback refusals (superuser, other owners, half applied, a widened ACL), rollback = 001's cancel byte for byte (ended person refused again), rows / audit untouched, twice refused, re-apply"
echo G3_PERSONAL_MVP_PASS
