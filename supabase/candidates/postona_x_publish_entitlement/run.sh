#!/usr/bin/env bash
# F3 X publish entitlement guard — proof on a disposable LOCAL PostgreSQL only. Never a remote project.
# Baseline: G5's production-shaped world from the G5/F5 candidate SOURCE (PR #165 = #152 + #121 + main's lifecycle
# migrations, including the Phase 5 brand-state candidate), Stage 3B stand-ins, the REAL Stage 3B publish
# authority migration from this repository, and the F3 reservation candidate (001 + 002). Then: the state before
# the candidate (fail-before), refusals, the candidate, behaviour, two-session races, rollback.
# Usage: RESV_PGHOST=/private/tmp/<socket-dir> RESV_PGPORT=<port> RESV_PGSUPER=<local superuser> \
#        RESV_G5_SOURCE_DIR=<dir with supabase/migrations + supabase/tests of the G5/F5 candidate commit> run.sh
# Optional: XPUB_CANDIDATE=<file> (mutation runs). Without the G5 source: RUN_NOT_AVAILABLE (exit 3).
# Roles are cluster-wide: run alone.
set -euo pipefail

host="${RESV_PGHOST:?RESV_PGHOST (local socket dir) required}"
port="${RESV_PGPORT:?RESV_PGPORT required}"
super="${RESV_PGSUPER:?RESV_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: RESV_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${RESV_G5_SOURCE_DIR:-}"
if [[ -z "$g5" || ! -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]]; then
  echo "RUN_NOT_AVAILABLE: RESV_G5_SOURCE_DIR does not hold the G5/F5 candidate source (PR #165)" >&2; exit 3
fi
export LC_ALL=C PGTZ=UTC

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
candidate="${XPUB_CANDIDATE:-$here/001_x_publish_entitlement_guard.sql}"
rollback="$here/001_x_publish_entitlement_guard_rollback.sql"
authority="$repo/supabase/migrations/20261006160200_x_account_publish_authority.sql"
resv="$repo/supabase/candidates/postona_x_reservations"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_postona_xpub_owner"
db="kabumori_postona_xpub_$$"
nog5="kabumori_postona_xpub_nog5_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona-xpub.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  for d in "$db" "$nog5"; do "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done
  "${S[@]}" -d postgres -c "drop role if exists postona_resv_api" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${S[@]}" -d postgres -c "drop role if exists postona_resv_api" >/dev/null
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database $db owner $owner;
create database $nog5 owner $owner;
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
val() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }

baseline() {  # $1 = database, $2 = with_g5 (yes|no)
  own "$1" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
  own "$1" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
  own "$1" -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
  own "$1" -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
  own "$1" -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
  own "$1" -f "$m/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
  own "$1" -f "$m/20261006230000_common_account_service_start_intent.sql" >/dev/null
  own "$1" -f "$m/20261009120000_common_account_deletion_completion.sql" >/dev/null
  if [[ "$2" == yes ]]; then
    own "$1" -f "$tests/common_account_write_guard_fixture.sql" >/dev/null
    "${S[@]}" -d "$1" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
    own "$1" -f "$m/20261010051938_common_account_service_write_guard.sql" >/dev/null
    own "$1" -f "$m/20261012130000_common_account_core_service_fence.sql" >/dev/null
    own "$1" -f "$m/20261012230000_common_account_service_brand_state.sql" >/dev/null
  fi
  own "$1" -f "$here/test_stand_ins.sql" >/dev/null
  own "$1" -f "$authority" >/dev/null
}
baseline "$db" yes
own "$db" -f "$resv/001_postona_x_reservations.sql" >/dev/null
own "$db" -f "$resv/002_postona_x_resv_api_role.sql" >/dev/null
echo "BASELINE_G5_STAGE3B_RESERVATIONS_READY"

# F0: fail-before. The unchanged Stage 3B predicate allows a post whose owner's x_autopost service has ENDED,
# and the unchanged setter grants a live window for it: the gap this candidate closes.
before="$(val "$db" <<'SQL'
\set u 00000000-0000-4000-8000-000000000099
select public.fixture_login(:'u');
select set_config('request.jwt.claim.sub', :'u', false);
set role authenticated;
select (public.start_x_autopost_service() ->> 'status');
reset role;
select set_config('request.jwt.claim.sub', '', false);
select public.social_mobile_account_deletion_workspace(:'u') as ws \gset
insert into public.brands (id, code_profile_key) values (:'ws', 'social_mobile_user_v1') on conflict do nothing;
insert into public.brand_memberships values (:'ws', :'u', 'owner') on conflict do nothing;
insert into public.brand_settings (brand_id, enabled_post_types) values (:'ws', '["brand_post"]') on conflict (brand_id) do update set enabled_post_types = '["brand_post"]';
insert into t3b.consent values (:'ws', '{"approvalMode":"auto_post_preference"}') on conflict do nothing;
insert into public.social_accounts (id, brand_id) values ('xfailbefore', :'ws');
update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost';
set role service_role;
select public.set_x_account_publish_authority('xfailbefore', 'enabled', 'OPS', now() - interval '1 minute', now() + interval '1 day');
insert into public.scheduled_posts (brand_id, post_type, status) values (:'ws', 'brand_post', 'running') returning id as p \gset
select 'BEFORE:' || public.check_x_account_publish_authority(:'p', 'xfailbefore', :'ws');
reset role;
SQL
)"
grep -q "BEFORE:allowed" <<<"$before" || fail "fail-before not reproduced: $before"
own "$db" -c "delete from public.scheduled_posts where brand_id in (select brand_id from public.social_accounts where id = 'xfailbefore')" \
  -c "delete from public.x_account_publish_authority where social_account_id = 'xfailbefore'" >/dev/null
echo "F0_FAIL_BEFORE_REPRODUCED (ended service: predicate 'allowed', grant 'enabled')"

# R0: refusals. Without G5's Phase 5 primitives the candidate refuses; a failure leaves nothing; no re-apply.
baseline "$nog5" no
if own "$nog5" -f "$candidate" >"$tmp/r0" 2>&1; then fail "applied without G5"; fi
grep -q X_PUBLISH_ENTITLEMENT_PRECONDITION_G5_MISSING "$tmp/r0" || fail "R0 wrong refusal: $(tail -1 "$tmp/r0")"
perl -pe 's/^commit;$/select 1\/0;\ncommit;/' "$candidate" > "$tmp/fail.sql"
if own "$db" -f "$tmp/fail.sql" >/dev/null 2>&1; then fail "injected failure applied"; fi
[[ "$(val "$db" -c "select to_regprocedure('public.postona_x_stop_account_publishing(text,text)') is null and prosrc !~ 'VAULT_PUBLISH_SERVICE_NOT_ACTIVE' from pg_proc where oid = 'public.check_x_account_publish_authority(uuid,text,text)'::regprocedure")" == t ]] \
  || fail "partial apply left behind"
own "$db" -f "$candidate" >/dev/null
if own "$db" -f "$candidate" >"$tmp/r0" 2>&1; then fail "re-apply accepted"; fi
grep -q X_PUBLISH_ENTITLEMENT_ALREADY_APPLIED "$tmp/r0" || fail "re-apply refused for another reason: $(tail -1 "$tmp/r0")"
echo "R0_REFUSALS_ROLLBACK_REAPPLY_PASS"

# B1: behaviour.
own "$db" -f "$here/behavior.sql" >"$tmp/b1" 2>&1 || { cat "$tmp/b1"; fail "behaviour"; }
for marker in E1_ACTIVE_ALLOWS_PASS E2_LIFECYCLE_REFUSES_PREDICATE_PASS E3_EXISTING_CHECKS_UNCHANGED_PASS \
              E4_GRANT_NEEDS_ACTIVE_SERVICE_PASS E5_SECOND_CHECK_REFUSES_PASS E6_X_STOP_CONTRACT_PASS X_PUBLISH_ENTITLEMENT_BEHAVIOR_PASS; do
  grep -q "$marker" "$tmp/b1" || { cat "$tmp/b1"; fail "missing $marker"; }
  echo "$marker"
done

# Two-session races on person A of the behaviour suite.
A='00000000-0000-4000-8000-000000000051'
ACC="x$(echo "$A" | tr -d '-')"
svc() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "set role service_role" -c "$1"; }
grant_sql="select public.set_x_account_publish_authority('$ACC', 'enabled', 'OPS_RACE', now() - interval '1 minute', now() + interval '2 days')"
own "$db" -c "update public.x_account_publish_authority set state = 'off', reason_code = 'RACE_SETUP', starts_at = null, expires_at = null where social_account_id = '$ACC'" >/dev/null
# C1: a freeze holds the owner's lifecycle locks first: the grant waits (<= 3 s), refuses BUSY, changes nothing.
own "$db" -c "begin; select private.account_lifecycle_lock('$A', false); select pg_sleep(6); commit;" >/dev/null 2>&1 &
holder=$!
sleep 1
start=$(date +%s)
if svc "$grant_sql" >"$tmp/c1" 2>&1; then fail "C1 grant passed a held fence"; fi
elapsed=$(( $(date +%s) - start ))
grep -q VAULT_PUBLISH_SERVICE_BUSY "$tmp/c1" || fail "C1 wrong refusal: $(cat "$tmp/c1")"
[[ $elapsed -ge 2 ]] || fail "C1 did not wait (${elapsed}s)"
wait $holder
[[ "$(val "$db" -c "select state from public.x_account_publish_authority where social_account_id = '$ACC'")" == off ]] || fail "C1 changed the authority"
echo "C1_GRANT_WAITS_FOR_FREEZE_THEN_BUSY_PASS"
# C2: the grant holds the lifecycle locks: a freeze (account FOR UPDATE) waits until the grant commits.
psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" \
  -c "begin; set local role service_role; $grant_sql; select pg_sleep(4); commit;" >/dev/null 2>&1 &
writer=$!
sleep 1
start=$(date +%s)
own "$db" -c "begin; update public.common_accounts set status = 'locked' where user_id = '$A'; commit;" >/dev/null
elapsed=$(( $(date +%s) - start ))
wait $writer || fail "C2 grant failed"
[[ $elapsed -ge 2 ]] || fail "C2 freeze did not wait for the grant (${elapsed}s)"
[[ "$(val "$db" -c "select state from public.x_account_publish_authority where social_account_id = '$ACC'")" == enabled ]] || fail "C2 grant missing"
if svc "$grant_sql" >"$tmp/c2" 2>&1; then fail "C2 grant after freeze passed"; fi
grep -q VAULT_PUBLISH_SERVICE_NOT_ACTIVE "$tmp/c2" || fail "C2 wrong refusal: $(cat "$tmp/c2")"
own "$db" -c "update public.common_accounts set status = 'active' where user_id = '$A'" >/dev/null
echo "C2_FREEZE_WAITS_FOR_GRANT_PASS"
# C3: lock order. A lifecycle step that holds the owner's lifecycle rows and THEN touches the X account row (as a
# service-end saga does) runs while a grant starts: with G5's order the grant waits without holding the account
# row, so there is no deadlock (with the account row first, PostgreSQL would detect one).
own "$db" -c "update public.x_account_publish_authority set state = 'off', reason_code = 'RACE_SETUP', starts_at = null, expires_at = null where social_account_id = '$ACC'" >/dev/null
deadlocks() { sleep 1.5; "${S[@]}" -A -t -d "$db" -c "select pg_stat_clear_snapshot(); select deadlocks from pg_stat_database where datname = current_database()" | tail -1; }
dl_before="$(deadlocks)"
own "$db" -c "begin; select private.account_lifecycle_lock('$A', false); select pg_sleep(1.5); update public.social_accounts set publish_enabled = publish_enabled where id = '$ACC'; select pg_sleep(0.5); commit;" >"$tmp/c3a" 2>&1 &
saga=$!
sleep 0.5
svc "$grant_sql" >"$tmp/c3b" 2>&1 || true
wait $saga || true
if grep -qi "deadlock" "$tmp/c3a" "$tmp/c3b"; then fail "C3 deadlock: $(cat "$tmp/c3a" "$tmp/c3b")"; fi
grep -q "ERROR" "$tmp/c3a" && fail "C3 lifecycle step failed: $(cat "$tmp/c3a")"
dl_after="$(deadlocks)"
[[ "$dl_before" == "$dl_after" ]] || fail "C3 PostgreSQL detected a deadlock (deadlocks $dl_before -> $dl_after)"
grep -Eq "^enabled$|VAULT_PUBLISH_SERVICE_BUSY" "$tmp/c3b" || fail "C3 grant outcome unexpected: $(cat "$tmp/c3b")"
echo "C3_LOCK_ORDER_NO_DEADLOCK_PASS"
# C4: two stop calls at once for the same person: both succeed, the end state is the same.
svc "select public.postona_x_stop_publishing_for_user('$A', 'POSTONA_SERVICE_ENDED') ->> 'status'" >"$tmp/c4a" 2>&1 &
p1=$!
svc "select public.postona_x_stop_publishing_for_user('$A', 'POSTONA_SERVICE_ENDED') ->> 'status'" >"$tmp/c4b" 2>&1 &
p2=$!
wait $p1 || fail "C4 first stop: $(cat "$tmp/c4a")"
wait $p2 || fail "C4 second stop: $(cat "$tmp/c4b")"
[[ "$(val "$db" -c "select state from public.x_account_publish_authority where social_account_id = '$ACC'")" == revoked ]] || fail "C4 end state"
echo "C4_CONCURRENT_STOP_IDEMPOTENT_PASS"

# RB: rollback restores the Stage 3B bodies exactly; the candidate can be applied again.
own "$db" -f "$rollback" >/dev/null
[[ "$(val "$db" -c "select md5(prosrc) from pg_proc where oid = 'public.check_x_account_publish_authority(uuid,text,text)'::regprocedure")" \
   == "$(val "$nog5" -c "select md5(prosrc) from pg_proc where oid = 'public.check_x_account_publish_authority(uuid,text,text)'::regprocedure")" ]] || fail "RB predicate not restored"
[[ "$(val "$db" -c "select md5(prosrc) from pg_proc where oid = 'public.set_x_account_publish_authority(text,text,text,timestamptz,timestamptz)'::regprocedure")" \
   == "$(val "$nog5" -c "select md5(prosrc) from pg_proc where oid = 'public.set_x_account_publish_authority(text,text,text,timestamptz,timestamptz)'::regprocedure")" ]] || fail "RB setter not restored"
[[ "$(val "$db" -c "select to_regprocedure('public.postona_x_stop_account_publishing(text,text)') is null")" == t ]] || fail "RB stop left behind"
own "$db" -f "$candidate" >/dev/null
echo "RB_ROLLBACK_EXACT_REAPPLY_PASS"
echo "X_PUBLISH_ENTITLEMENT_ALL_PASS"
