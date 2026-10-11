#!/usr/bin/env bash
# Local proof of ai_provider_budget_ledger_rollout.sh: every success and STOP path, against a disposable PostgreSQL
# through a FAKE `supabase` command (first on PATH) that runs the SQL with psql as a non-superuser owner, like the
# Management API runs it as postgres. Never touches Supabase.
#
#   AIL_PGHOST=/private/tmp/<socket dir> AIL_PGPORT=54891 AIL_PGSUPER=<superuser> bash supabase/tests/ai_provider_budget_ledger_rollout_proof.sh
set -euo pipefail
export LC_ALL=C

HOST="${AIL_PGHOST:?AIL_PGHOST (local socket dir under /tmp or /private/tmp) is required}"
PORT="${AIL_PGPORT:-5432}"
SUPER="${AIL_PGSUPER:-postgres}"
case "$HOST" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/ai_provider_budget_ledger_rollout.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ail_rollout_proof.XXXXXX")"
PREFIX="ail_rollout_$$"
REF="abcdefghijklmnopqrst"
OWNER="ail_rollout_owner"
DBS=()

psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() {
  for db in ${DBS[@]+"${DBS[@]}"}; do psql_super -d postgres -c "drop database if exists $db" >/dev/null 2>&1 || true; done
  psql_super -d postgres -c "revoke pg_read_all_data from authenticated" >/dev/null 2>&1 || true
  psql_super -d postgres -c "drop role if exists $OWNER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- the fake `supabase db query --linked --project-ref REF --output-format json -f FILE` --------------------------
mkdir -p "$WORK/bin" "$WORK/out"
cat >"$WORK/bin/supabase" <<FAKE
#!/usr/bin/env bash
set -uo pipefail
file=""; ref=""
while [ \$# -gt 0 ]; do
  case "\$1" in -f|--file) file="\$2"; shift 2 ;; --project-ref) ref="\$2"; shift 2 ;; *) shift ;; esac
done
[ "\$ref" = "$REF" ] || { echo "fake supabase: unexpected project ref" >&2; exit 64; }
[ -n "\$file" ] || { echo "fake supabase: -f required" >&2; exit 64; }
db="\${FAKE_DB:?FAKE_DB}"
run() { PGOPTIONS="-c role=$OWNER" psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "\$db" -v ON_ERROR_STOP=1 -q -t -A "\$@"; }
is_migration=0
case "\$file" in *20261010050613_ai_provider_budget_ledger.sql) is_migration=1 ;; esac
if [ "\$is_migration" = 1 ] && [ "\${FAKE_FAIL_BEFORE_MIGRATION:-}" = 1 ]; then echo "fake: connection reset before the statement" >&2; exit 1; fi
out="\$(run -f "\$file")" || exit 1
if [ "\$is_migration" = 1 ]; then
  if [ -n "\${FAKE_AFTER_MIGRATION_SQL:-}" ]; then psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "\$db" -q -c "\$FAKE_AFTER_MIGRATION_SQL" >/dev/null; fi
  if [ "\${FAKE_FAIL_AFTER_MIGRATION:-}" = 1 ]; then echo "fake: response lost after commit" >&2; exit 1; fi
fi
last="\$(printf '%s\n' "\$out" | sed '/^\$/d' | tail -n 1)"
if [ -z "\$last" ]; then rows='[]'; else rows="[{\"result\": \$last}]"; fi
if [ "\${FAKE_AGENT_SHAPE:-}" = 1 ]; then printf '{"boundary":"x","rows":%s,"warning":"w"}\n' "\$rows"; else printf '%s\n' "\$rows"; fi
FAKE
chmod +x "$WORK/bin/supabase"

# ---- databases ----------------------------------------------------------------------------------------------------
psql_super -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = '$OWNER') then create role $OWNER nologin; end if;
end \$\$;
grant anon, authenticated, service_role to authenticator;
SQL

fresh() {
  local db="${PREFIX}_$1"
  DBS+=("$db")
  psql_super -d postgres -c "create database $db" >/dev/null
  psql_super -d "$db" >/dev/null <<SQL
grant create on database $db to $OWNER;
grant all on schema public to $OWNER;
grant usage on schema public to anon, authenticated, service_role;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261001150000', 'common_account_lifecycle_foundation');
grant usage on schema supabase_migrations to $OWNER;
grant select, insert, delete on supabase_migrations.schema_migrations to $OWNER;
create function public.existing_business_function() returns integer language sql as 'select 1';
create table public.existing_business_table (id integer primary key);
alter default privileges for role $OWNER in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role $OWNER in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role $OWNER grant all on tables to anon, authenticated, service_role;
alter default privileges for role $OWNER grant usage, create on schemas to anon, authenticated, service_role;
SQL
  echo "$db"
}

# runner <expected exit> <label> [env assignments...] -- <runner args...>
runner() {
  local want="$1" label="$2"; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  local got=0
  env PATH="$WORK/bin:$PATH" AIL_ROLLOUT_REF="$REF" AIL_ROLLOUT_OUT="$WORK/out" ${envs[@]+"${envs[@]}"} \
    bash "$RUNNER" "$@" >"$WORK/last.log" 2>&1 || got=$?
  if [ "$got" != "$want" ]; then cat "$WORK/last.log" >&2; fail "$label: exit $got, expected $want"; fi
  echo "PASS $label (exit $got): $(grep -E '^(DONE|STOP|REFUSED|ledger absent|VERDICT)' "$WORK/last.log" | tail -1)"
}
count() { psql_super -d "$1" -Atc "$2"; }

APPLY_ACK="apply 20261010050613_ai_provider_budget_ledger to $REF"
POLICY_ACK="insert phase1d test policies into $REF"
STOP_ACK="disable all ai_ledger policies in $REF"
ROLLBACK_ACK="drop the empty ai_ledger in $REF"

# ---- main sequence ------------------------------------------------------------------------------------------------
DB="$(fresh main)"
runner 0 "check on a clean target" FAKE_DB="$DB" -- check
runner 0 "check with the agent output shape" FAKE_DB="$DB" FAKE_AGENT_SHAPE=1 -- check
runner 0 "status before apply" FAKE_DB="$DB" -- status
runner 2 "apply without the phrase" FAKE_DB="$DB" -- apply
runner 2 "apply with a phrase for another project" FAKE_DB="$DB" AIL_ROLLOUT_ACK="apply 20261010050613_ai_provider_budget_ledger to zzzzzzzzzzzzzzzzzzzz" -- apply
runner 2 "policies before apply without the phrase" FAKE_DB="$DB" -- policies
runner 10 "policies before apply" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$POLICY_ACK" -- policies
runner 11 "Stage A fails before the statement" FAKE_DB="$DB" FAKE_FAIL_BEFORE_MIGRATION=1 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
[ "$(count "$DB" "select count(*) from pg_namespace where nspname = 'ai_ledger'")" = 0 ] || fail "Stage A failure left a schema"
runner 0 "apply" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
[ "$(count "$DB" "select count(*) from supabase_migrations.schema_migrations where version = '20261010050613'")" = 1 ] || fail "history row"
runner 10 "apply again" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 0 "status after apply" FAKE_DB="$DB" -- status
runner 0 "policies" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$POLICY_ACK" -- policies
[ "$(count "$DB" "select count(*) from ai_ledger.budget_policies where enabled")" = 2 ] || fail "policies"
runner 10 "policies again" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$POLICY_ACK" -- policies
runner 0 "status with policies" FAKE_DB="$DB" -- status
runner 2 "stop without the phrase" FAKE_DB="$DB" -- stop
runner 0 "stop switch" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$STOP_ACK" -- stop
[ "$(count "$DB" "select count(*) from ai_ledger.budget_policies where enabled")" = 0 ] || fail "stop switch"
runner 0 "status while stopped" FAKE_DB="$DB" -- status
count "$DB" "set role service_role; select public.ai_ledger_reserve('{\"request_id\":\"proof-1\",\"attempt\":1,\"provider\":\"anthropic\",\"model\":\"claude-opus-5-5\",\"application\":\"kabumori\",\"feature\":\"market_report\",\"logical_role\":\"proof\",\"subject_kind\":\"system\",\"amount_usd\":0.1}') ->> 'reason'" \
  | grep -q NO_MATCHING_POLICY || fail "stopped ledger must refuse"
psql_super -d "$DB" -c "update ai_ledger.budget_policies set enabled = true" >/dev/null
count "$DB" "set role service_role; select public.ai_ledger_reserve('{\"request_id\":\"proof-2\",\"attempt\":1,\"provider\":\"anthropic\",\"model\":\"claude-opus-5-5\",\"application\":\"kabumori\",\"feature\":\"market_report\",\"logical_role\":\"proof\",\"subject_kind\":\"system\",\"amount_usd\":0.1}') ->> 'allowed'" \
  | grep -q true || fail "re-enabled ledger must reserve"
runner 2 "rollback without the phrase" FAKE_DB="$DB" -- rollback
runner 10 "rollback refused while the ledger holds a reservation" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$ROLLBACK_ACK" -- rollback
[ "$(count "$DB" "select count(*) from pg_namespace where nspname = 'ai_ledger'")" = 1 ] || fail "refused rollback removed the ledger"

# ---- rollback of an empty ledger ----------------------------------------------------------------------------------
DB="$(fresh rollback)"
runner 0 "apply (rollback target)" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 0 "rollback of the empty ledger" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$ROLLBACK_ACK" -- rollback
[ "$(count "$DB" "select count(*) from pg_namespace where nspname = 'ai_ledger'")" = 0 ] || fail "rollback left the schema"
[ "$(count "$DB" "select count(*) from supabase_migrations.schema_migrations where version = '20261010050613'")" = 0 ] || fail "rollback left history"
runner 0 "apply again after rollback" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply

# ---- response lost after the commit: STOP 12, then --resume-history -----------------------------------------------
DB="$(fresh lost)"
runner 12 "Stage A commits but the response is lost" FAKE_DB="$DB" FAKE_FAIL_AFTER_MIGRATION=1 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
[ "$(count "$DB" "select count(*) from supabase_migrations.schema_migrations where version = '20261010050613'")" = 0 ] || fail "history written after an unknown outcome"
runner 10 "plain apply refused once the ledger exists" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 0 "apply --resume-history" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply --resume-history
runner 10 "resume-history needs a verified schema (not on a clean target)" FAKE_DB="$(fresh resume_clean)" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply --resume-history

# ---- something else changed existing objects during the apply: STOP 15 ---------------------------------------------
DB="$(fresh drift)"
runner 15 "existing object changed during the apply" FAKE_DB="$DB" \
  FAKE_AFTER_MIGRATION_SQL="create or replace function public.existing_business_function() returns integer language sql as 'select 2'" \
  AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply

# ---- predicted refusal: nothing is applied -----------------------------------------------------------------------
DB="$(fresh refuse)"
psql_super -d postgres -c "grant pg_read_all_data to authenticated with inherit false, set true" >/dev/null
runner 10 "preflight predicts the postcondition refusal" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
psql_super -d postgres -c "revoke pg_read_all_data from authenticated" >/dev/null
[ "$(count "$DB" "select count(*) from pg_namespace where nspname = 'ai_ledger'")" = 0 ] || fail "refused apply left a schema"

# ---- tampered migration bytes ------------------------------------------------------------------------------------
mkdir -p "$WORK/copy/supabase/tests" "$WORK/copy/supabase/migrations"
cp "$HERE"/ai_provider_budget_ledger_*.sql "$HERE"/ai_provider_budget_ledger_gate.py "$RUNNER" "$WORK/copy/supabase/tests/"
sed 's/AI provider budget ledger/AI provider budget ledger (edited)/' "$HERE/../migrations/20261010050613_ai_provider_budget_ledger.sql" \
  >"$WORK/copy/supabase/migrations/20261010050613_ai_provider_budget_ledger.sql"
RUNNER="$WORK/copy/supabase/tests/ai_provider_budget_ledger_rollout.sh"
runner 2 "migration bytes differ from the merged source" FAKE_DB="$(fresh tampered)" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply

echo "ALL ROLLOUT PATHS PASS"
