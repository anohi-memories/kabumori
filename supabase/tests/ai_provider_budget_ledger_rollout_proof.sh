#!/usr/bin/env bash
# Local proof of ai_provider_budget_ledger_rollout.sh: every success and STOP path, against a disposable PostgreSQL
# through a FAKE `supabase` command (first on PATH) that behaves like Supabase CLI 2.116's `db query --linked`: it
# insists on the exact flags the runner must pass, runs the SQL with psql as a non-superuser owner (as the Management
# API runs it as postgres), prints a plain JSON array of rows (--agent no), and on errors prints the CLI's JSON error
# object and exits 1. Hooks make it reach another project, misbehave in its output, or skip a write.
# Then the REAL installed CLI (--db-url to the same local database) renders the read-only queries, and the gate must
# accept its JSON. Never touches Supabase.
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
REAL_SUPABASE="$(command -v supabase || true)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ail_rollout_proof.XXXXXX")"
PREFIX="ail_rollout_$$"
REF="abcdefghijklmnopqrst"
OTHER_REF="zyxwvutsrqponmlkjihg"
OWNER="ail_rollout_owner"

psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# Every database of this run, found by prefix (fresh() runs in a command substitution, so an array would stay empty).
drop_prefixed() {
  local db
  for db in $(psql_super -d postgres -Atc "select datname from pg_database where datname like '$1%'"); do
    psql_super -d postgres -c "drop database if exists $db" >/dev/null 2>&1 || true
  done
}
cleanup() {
  drop_prefixed "${PREFIX}_"
  psql_super -d postgres -c "revoke pg_read_all_data from authenticated" >/dev/null 2>&1 || true
  psql_super -d postgres -c "drop role if exists $OWNER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
drop_prefixed "ail\\_rollout\\_"

# ---- the fake Supabase CLI 2.116 -------------------------------------------------------------------------------------
mkdir -p "$WORK/bin" "$WORK/out"
cat >"$WORK/bin/supabase" <<FAKE
#!/usr/bin/env bash
set -uo pipefail
err() { printf '{"_tag":"Error","error":{"code":"%s","message":"%s"}}\n' "\$1" "\$2"; exit 1; }
if [ "\${1:-}" = "--version" ]; then echo "\${FAKE_VERSION:-2.116.0}"; exit 0; fi
if [ "\$*" = "db query --help" ]; then
  for f in --db-url --linked --local --project-ref --file --output-format --agent --workdir; do
    [ "\$f" = "\${FAKE_HELP_DROP:-}" ] || echo "  \$f"
  done
  exit 0
fi
[ "\${1:-} \${2:-}" = "db query" ] || err Usage "fake supabase: only db query is implemented"
shift 2
file=""; ref=""; linked=0; agent=""; format=""; workdir=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -f|--file) file="\$2"; shift 2 ;;
    --project-ref) ref="\$2"; shift 2 ;;
    --linked) linked=1; shift ;;
    --agent) agent="\$2"; shift 2 ;;
    --output-format) format="\$2"; shift 2 ;;
    --workdir) workdir="\$2"; shift 2 ;;
    *) err Usage "fake supabase: unexpected argument \$1" ;;
  esac
done
[ "\$linked" = 1 ] || err Usage "fake: --linked missing"
[ "\$ref" = "$REF" ] || err Usage "fake: --project-ref is not the proof project"
[ "\$agent" = no ] || err Usage "fake: --agent no missing"
[ "\$format" = json ] || err Usage "fake: --output-format json missing"
[ -n "\$workdir" ] && [ -d "\$workdir" ] && [ ! -e "\$workdir/supabase/.temp/project-ref" ] || err Usage "fake: --workdir must be an existing directory without a linked ref"
[ -n "\$file" ] || err Usage "fake: -f missing"
db="\${FAKE_DB:?FAKE_DB}"
base="\$(basename "\$file" .sql)"
is_migration=0
case "\$base" in 20261010050613_ai_provider_budget_ledger) is_migration=1 ;; esac
if [ "\$is_migration" = 1 ] && [ "\${FAKE_FAIL_BEFORE_MIGRATION:-}" = 1 ]; then err LegacyDbQueryExecError "fake: connection reset before the statement"; fi
if [ "\$is_migration" = 1 ] && [ "\${FAKE_SKIP_MIGRATION:-}" = 1 ]; then echo '[]'; exit 0; fi
if [ "\$base" = history ] && [ "\${FAKE_SKIP_HISTORY:-}" = 1 ]; then echo '[]'; exit 0; fi
out="\$(PGOPTIONS="-c role=$OWNER" psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "\$db" -v ON_ERROR_STOP=1 -q -t -A -f "\$file" 2>&1)" \
  || err LegacyDbQueryExecError "failed to execute query"
if [ "\$is_migration" = 1 ]; then
  if [ -n "\${FAKE_AFTER_MIGRATION_SQL:-}" ]; then psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "\$db" -q -c "\$FAKE_AFTER_MIGRATION_SQL" >/dev/null; fi
  if [ "\${FAKE_FAIL_AFTER_MIGRATION:-}" = 1 ]; then err LegacyDbQueryExecError "fake: response lost after commit"; fi
fi
last="\$(printf '%s\n' "\$out" | sed '/^\$/d' | tail -n 1)"
if [ -z "\$last" ]; then rows='[]'; else rows="[{\"result\": \$last}]"; fi
mode=""
case ",\${FAKE_OUTPUT_FOR:-}," in *",\$base,"*) mode="\${FAKE_OUTPUT:-}" ;; esac
case "\$mode" in
  "") printf '%s\n' "\$rows" ;;
  empty) ;;
  garbage) echo "Connecting to remote database..." ;;
  envelope) printf '{"boundary":"0123456789abcdef0123456789abcdef","rows":%s,"warning":"w"}\n' "\$rows" ;;
  error0) printf '{"_tag":"Error","error":{"code":"X","message":"y"}}\n' ;;
  extra_column) printf '[{"result": %s, "extra": 1}]\n' "\$last" ;;
  two_rows) printf '[{"result": %s}, {"result": %s}]\n' "\$last" "\$last" ;;
  wrong_kind) printf '[{"result": {"ok": true}}]\n' ;;
  command_tag) echo "INSERT 0 1" ;;
  *) err Usage "fake: unknown FAKE_OUTPUT" ;;
esac
exit 0
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

# fresh <name> <shape>: kabumori = this product with cron jobs calling \$REF; photo = another project's database;
# two_refs = this product whose cron jobs call two projects; no_cron_ref = this product with no project URL in cron.
fresh() {
  local db="${PREFIX}_$1" shape="${2:-kabumori}"
  psql_super -d postgres -c "create database $db" >/dev/null
  psql_super -d "$db" >/dev/null <<SQL
grant create on database $db to $OWNER;
grant all on schema public to $OWNER;
grant usage on schema public to anon, authenticated, service_role;
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
grant usage on schema supabase_migrations to $OWNER;
grant select, insert, delete on supabase_migrations.schema_migrations to $OWNER;
create schema cron;
create table cron.job (jobid bigserial primary key, command text not null);
grant usage on schema cron to $OWNER;
grant select on cron.job to $OWNER;
create function public.existing_business_function() returns integer language sql as 'select 1';
create table public.existing_business_table (id integer primary key);
alter default privileges for role $OWNER in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role $OWNER in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role $OWNER grant all on tables to anon, authenticated, service_role;
alter default privileges for role $OWNER grant usage, create on schemas to anon, authenticated, service_role;
SQL
  if [ "$shape" != photo ]; then
    psql_super -d "$db" >/dev/null <<SQL
create schema private;
create table public.profiles (id uuid primary key);
create table public.brands (id text primary key);
create table public.social_accounts (id uuid primary key);
create table public.common_accounts (user_id uuid primary key);
create table public.service_entitlements (user_id uuid, service_key text);
create table private.account_lifecycle_operations (id uuid primary key);
insert into supabase_migrations.schema_migrations (version, name) values
  ('20261001150000', 'common_account_lifecycle_foundation'), ('20261006230000', 'common_account_service_start_intent');
SQL
  fi
  case "$shape" in
    kabumori) psql_super -d "$db" -c "insert into cron.job (command) values ('select net.http_post(url := ''https://$REF.supabase.co/functions/v1/important-news-monitor'')'), ('select net.http_post(url := ''https://$REF.supabase.co/functions/v1/market-intelligence-ingest'')')" >/dev/null ;;
    photo) psql_super -d "$db" -c "insert into cron.job (command) values ('select net.http_post(url := ''https://$OTHER_REF.supabase.co/functions/v1/cleanup'')')" >/dev/null ;;
    two_refs) psql_super -d "$db" -c "insert into cron.job (command) values ('select net.http_post(url := ''https://$REF.supabase.co/functions/v1/a'')'), ('select net.http_post(url := ''https://$OTHER_REF.supabase.co/functions/v1/b'')')" >/dev/null ;;
    no_cron_ref) psql_super -d "$db" -c "insert into cron.job (command) values ('select 1')" >/dev/null ;;
  esac
  echo "$db"
}

PASSES=0
# runner <expected exit> <label> [env assignments...] -- <runner args...>
runner() {
  local want="$1" label="$2"; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  local got=0
  env -u SUPABASE_PROJECT_ID PATH="$WORK/bin:$PATH" AIL_ROLLOUT_REF="$REF" AIL_ROLLOUT_OUT="$WORK/out" ${envs[@]+"${envs[@]}"} \
    bash "$RUNNER" "$@" >"$WORK/last.log" 2>&1 || got=$?
  if [ "$got" != "$want" ]; then cat "$WORK/last.log" >&2; fail "$label: exit $got, expected $want"; fi
  PASSES=$((PASSES + 1))
  echo "PASS $label (exit $got): $(grep -E '^(DONE|STOP|REFUSED|ledger absent|VERDICT)' "$WORK/last.log" | tail -1)"
}
count() { psql_super -d "$1" -Atc "$2"; }
ledger_absent() { [ "$(count "$1" "select count(*) from pg_namespace where nspname = 'ai_ledger'")" = 0 ] || fail "$2: a ledger schema exists"; }

APPLY_ACK="apply 20261010050613_ai_provider_budget_ledger to $REF"
POLICY_ACK="insert phase1d test policies into $REF"
STOP_ACK="disable all ai_ledger policies in $REF"
ROLLBACK_ACK="drop the empty ai_ledger in $REF"

# ---- main sequence ------------------------------------------------------------------------------------------------
DB="$(fresh main)"
runner 0 "check on a clean target" FAKE_DB="$DB" -- check
runner 0 "status before apply" FAKE_DB="$DB" -- status
runner 2 "apply without the phrase" FAKE_DB="$DB" -- apply
runner 2 "apply with a phrase for another project" FAKE_DB="$DB" AIL_ROLLOUT_ACK="apply 20261010050613_ai_provider_budget_ledger to zzzzzzzzzzzzzzzzzzzz" -- apply
runner 2 "policies before apply without the phrase" FAKE_DB="$DB" -- policies
runner 10 "policies before apply" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$POLICY_ACK" -- policies
runner 11 "Stage A fails before the statement" FAKE_DB="$DB" FAKE_FAIL_BEFORE_MIGRATION=1 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
ledger_absent "$DB" "Stage A failure"
runner 12 "Stage A reports success but nothing was applied" FAKE_DB="$DB" FAKE_SKIP_MIGRATION=1 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
ledger_absent "$DB" "skipped migration"
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
MAIN_DB="$DB"

# ---- rollback of an empty ledger ----------------------------------------------------------------------------------
DB="$(fresh rollback)"
runner 0 "apply (rollback target)" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 0 "rollback of the empty ledger" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$ROLLBACK_ACK" -- rollback
ledger_absent "$DB" "rollback"
[ "$(count "$DB" "select count(*) from supabase_migrations.schema_migrations where version = '20261010050613'")" = 0 ] || fail "rollback left history"
runner 0 "apply again after rollback" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply

# ---- response lost after the commit: STOP 12, then --resume-history -----------------------------------------------
DB="$(fresh lost)"
runner 12 "Stage A commits but the response is lost" FAKE_DB="$DB" FAKE_FAIL_AFTER_MIGRATION=1 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
[ "$(count "$DB" "select count(*) from supabase_migrations.schema_migrations where version = '20261010050613'")" = 0 ] || fail "history written after an unknown outcome"
runner 10 "plain apply refused once the ledger exists" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 0 "apply --resume-history" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply --resume-history
runner 10 "resume-history needs a verified schema (not on a clean target)" FAKE_DB="$(fresh resume_clean)" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply --resume-history

# ---- a write that reports success but did nothing is caught by the read-back ----------------------------------------
DB="$(fresh skip_history)"
runner 15 "history step reports success but wrote nothing" FAKE_DB="$DB" FAKE_SKIP_HISTORY=1 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply

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
ledger_absent "$DB" "refused apply"

# ---- wrong target: nothing is read further and nothing is written ------------------------------------------------
for shape in photo two_refs no_cron_ref; do
  DB="$(fresh "target_$shape" "$shape")"
  runner 10 "check on the wrong target ($shape)" FAKE_DB="$DB" -- check
  runner 10 "apply on the wrong target ($shape)" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
  runner 10 "stop on the wrong target ($shape)" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$STOP_ACK" -- stop
  ledger_absent "$DB" "wrong target $shape"
done
DB="$(fresh target_missing_cron kabumori)"
psql_super -d "$DB" -c "drop schema cron cascade" >/dev/null
runner 10 "target without pg_cron jobs cannot be verified" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
ledger_absent "$DB" "missing cron"
runner 2 "SUPABASE_PROJECT_ID names another project" FAKE_DB="$(fresh env_ref)" SUPABASE_PROJECT_ID="$OTHER_REF" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 2 "AIL_ROLLOUT_REF is not a project ref" FAKE_DB="$DB" AIL_ROLLOUT_REF="not-a-ref" -- check

# ---- CLI compatibility --------------------------------------------------------------------------------------------
DB="$(fresh cli)"
runner 2 "CLI older than 2.116" FAKE_DB="$DB" FAKE_VERSION=2.115.9 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 2 "CLI 3.x" FAKE_DB="$DB" FAKE_VERSION=3.0.0 AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
runner 2 "CLI version unreadable" FAKE_DB="$DB" FAKE_VERSION="v2.116" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
for flag in --project-ref --agent --linked --workdir; do
  runner 2 "CLI without $flag" FAKE_DB="$DB" FAKE_HELP_DROP="$flag" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
done
runner 0 "CLI 2.120 accepted (check)" FAKE_DB="$DB" FAKE_VERSION=2.120.0 -- check
ledger_absent "$DB" "CLI compatibility"

# ---- unreadable or unexpected output is never success -------------------------------------------------------------
DB="$(fresh output)"
for mode in empty garbage envelope error0 extra_column two_rows wrong_kind command_tag; do
  runner 16 "identity output $mode" FAKE_DB="$DB" FAKE_OUTPUT="$mode" FAKE_OUTPUT_FOR=ai_provider_budget_ledger_target_identity AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
done
for mode in empty garbage wrong_kind; do
  runner 16 "preflight output $mode" FAKE_DB="$DB" FAKE_OUTPUT="$mode" FAKE_OUTPUT_FOR=ai_provider_budget_ledger_preflight AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
  runner 16 "fingerprint output $mode" FAKE_DB="$DB" FAKE_OUTPUT="$mode" FAKE_OUTPUT_FOR=ai_provider_budget_ledger_existing_fingerprint AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
done
ledger_absent "$DB" "unreadable output before Stage A"
runner 0 "apply (read-back output target)" FAKE_DB="$DB" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
for mode in empty envelope extra_column command_tag; do
  runner 16 "read-back output $mode" FAKE_DB="$DB" FAKE_OUTPUT="$mode" FAKE_OUTPUT_FOR=ai_provider_budget_ledger_readback AIL_ROLLOUT_ACK="$POLICY_ACK" -- policies
done
[ "$(count "$DB" "select count(*) from ai_ledger.budget_policies")" = 0 ] || fail "policies written after an unreadable read-back"

# ---- tampered migration bytes ------------------------------------------------------------------------------------
mkdir -p "$WORK/copy/supabase/tests" "$WORK/copy/supabase/migrations"
cp "$HERE"/ai_provider_budget_ledger_*.sql "$HERE"/ai_provider_budget_ledger_gate.py "$RUNNER" "$WORK/copy/supabase/tests/"
sed 's/AI provider budget ledger/AI provider budget ledger (edited)/' "$HERE/../migrations/20261010050613_ai_provider_budget_ledger.sql" \
  >"$WORK/copy/supabase/migrations/20261010050613_ai_provider_budget_ledger.sql"
TAMPERED="$WORK/copy/supabase/tests/ai_provider_budget_ledger_rollout.sh"
RUNNER_SAVED="$RUNNER"; RUNNER="$TAMPERED"
runner 2 "migration bytes differ from the merged source" FAKE_DB="$(fresh tampered)" AIL_ROLLOUT_ACK="$APPLY_ACK" -- apply
RUNNER="$RUNNER_SAVED"

# ---- the REAL installed CLI renders the read-only queries; the gate accepts them ------------------------------------
if [ -n "$REAL_SUPABASE" ]; then
  URL="postgresql://$SUPER@127.0.0.1:$PORT/$MAIN_DB?sslmode=disable"
  for pair in target_identity:"identity $REF" preflight:preflight readback:"readback test" existing_fingerprint:"field fingerprint r.get('ai_ledger_rpcs')==7"; do
    name="${pair%%:*}"; args="${pair#*:}"
    "$REAL_SUPABASE" db query --db-url "$URL" --output-format json --agent no -f "$HERE/ai_provider_budget_ledger_$name.sql" >"$WORK/real_$name.json" 2>"$WORK/real_$name.err" \
      || { cat "$WORK/real_$name.err" >&2; fail "real CLI could not run $name"; }
    status=0
    # shellcheck disable=SC2086
    python3 -I "$HERE/ai_provider_budget_ledger_gate.py" --require-array $args <"$WORK/real_$name.json" >"$WORK/real_$name.verdict" || status=$?
    [ "$status" -ne 2 ] || { cat "$WORK/real_$name.verdict" >&2; fail "gate could not read the real CLI output for $name"; }
    PASSES=$((PASSES + 1))
    echo "PASS real CLI $("$REAL_SUPABASE" --version 2>/dev/null | head -1) renders $name; gate reads it ($(tail -1 "$WORK/real_$name.verdict"))"
  done
  status=0
  "$REAL_SUPABASE" db query --db-url "$URL" --output-format json --agent yes -f "$HERE/ai_provider_budget_ledger_target_identity.sql" >"$WORK/real_envelope.json" 2>/dev/null || true
  python3 -I "$HERE/ai_provider_budget_ledger_gate.py" --require-array identity "$REF" <"$WORK/real_envelope.json" >/dev/null || status=$?
  [ "$status" -eq 2 ] || fail "the runner's gate must refuse the agent envelope"
  python3 -I "$HERE/ai_provider_budget_ledger_gate.py" identity "$REF" <"$WORK/real_envelope.json" >/dev/null || fail "the manual gate must read the real agent envelope"
  PASSES=$((PASSES + 1))
  echo "PASS real CLI agent envelope: refused by the runner's gate, read by the manual gate"
else
  echo "SKIP real CLI rendering: no supabase on PATH"
fi

echo "ALL ROLLOUT PATHS PASS ($PASSES)"
