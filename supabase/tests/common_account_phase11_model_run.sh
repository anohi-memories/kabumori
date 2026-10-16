#!/usr/bin/env bash
# F5 Phase 11: the managed-disposable plan (supabase/preflight/managed_disposable) executed OFFLINE against a MODEL of
# the managed services -- the Phase 9 fake GoTrue / PostgREST seams in front of a local PostgreSQL 17 holding the
# production-shaped baseline (fixtures + the three real prerequisite migrations). The harness itself applies the ten
# chain files, runs the probe and the M-checks through its real runner and plan; only the transports are the model's.
# What this proves: the plan's steps, assertions, ordering, identity checks, refusals and teardown behave as designed,
# and the assertions can FAIL (a world without the Phase 9 fence is caught). What it cannot prove: any real managed
# behaviour (that is what the later, separately approved disposable project is for).
#
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_phase11_model_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
fail() { echo "FAIL $*" >&2; exit 1; }

n="$$"
owner="kb_p11_owner_$n"
prefix="kabumori_p11_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_p11\_%'"); do
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
mk() { "${S[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" >/dev/null; }

# ---- the production-shaped baseline (NO chain file, NO write-guard stand-ins: the harness applies those) -------------
base="${prefix}_base"
mk "$base"
own "$base" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$base" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  own "$base" -f "$m/$f" >/dev/null
done
own "$base" -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
own "$base" -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
own "$base" -c "create table public.kabumori_disposable_marker (project_ref text primary key, created_at timestamptz not null default now())" >/dev/null
echo "PASS model baseline: the production-shaped baseline without any chain file"

# the world the harness applies the chain to, a copy whose marker names ANOTHER project, a copy for the tamper case,
# and a world that already holds Phase 1-8 and 10 but NOT the Phase 9 fence (the fail-before evidence of M5)
ref="mmmmmmmmmmmmmmmmmmmm"
production_like="cccccccccccccccccccc"
harness="${prefix}_harness"; wrong="${prefix}_wrongmarker"; tamper="${prefix}_tamper"; nofence="${prefix}_nofence"
for d in "$harness" "$tamper" "$nofence"; do mk "$d" "$base"; own "$d" -c "insert into public.kabumori_disposable_marker (project_ref) values ('$ref')" >/dev/null; done
mk "$wrong" "$base"; own "$wrong" -c "insert into public.kabumori_disposable_marker (project_ref) values ('$production_like')" >/dev/null
# the lock wait a hosted project gives its API sessions (a model: lock waits end quickly), per database
for d in "$harness" "$nofence"; do
  "${S[@]}" -d postgres -c "alter role $owner in database $d set lock_timeout = '2s'" >/dev/null
done

own "$nofence" -f "$m/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
for f in 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do own "$nofence" -f "$m/$f" >/dev/null; done
own "$nofence" -f "$t/common_account_write_guard_fixture.sql" >/dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql \
         20261012230000_common_account_service_brand_state.sql 20261013120000_common_account_service_deletion_ownership.sql \
         20261013140000_common_account_service_reconciliation_facts.sql 20261015120000_common_account_x_unconfirmed_snapshot_record.sql; do
  own "$nofence" -f "$m/$f" >/dev/null
done
echo "PASS model worlds: harness / wrong-marker / tamper / no-fence"

log="$(mktemp /private/tmp/kabumori-p11-model.XXXXXX)"
( cd "$repo" && CAL_E2E=1 PGHOST="$host" PGPORT="$port" PGUSER="$owner" PGDATABASE="$harness" PGDATABASE_WRONG_MARKER="$wrong" \
    PGDATABASE_TAMPER="$tamper" PGDATABASE_NOFENCE="$nofence" P11_REF="$ref" P11_PRODUCTION_LIKE="$production_like" \
    deno test --no-config --no-check --allow-run=psql --allow-net=127.0.0.1 --allow-env --allow-read \
    supabase/tests/common_account_phase11_plan_model_test.ts ) > "$log" 2>&1 \
  || { sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -v '^$' | head -80 >&2; rm -f "$log"; fail "the plan's model run"; }
sed 's/\x1b\[[0-9;]*m//g' "$log" | sed -n '/^model observed:/,/^summary:/p' | cut -c1-220
sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E "passed|failed" | tail -2
rm -f "$log"
echo "PHASE11_MODEL_ALL_PASS"
