#!/usr/bin/env bash
# Disposable-PostgreSQL proof of 20261010050613_ai_provider_budget_ledger.sql. Never touches Supabase.
#
#   AIL_PGHOST=/private/tmp/<socket dir> AIL_PGPORT=54891 AIL_PGSUPER=<superuser> bash supabase/tests/ai_provider_budget_ledger_run.sh
#
# Optional: AIL_MIGRATION=<file> runs everything against another copy (the mutation runner uses this);
#           AIL_PARTS="behaviour concurrency ..." runs only those parts.
#
# Parts:
#   behaviour    clean apply, one-shot (re-apply fails), fixture + behaviour file (ledger, caps, idempotency, timeout /
#                recovery, roles, append-only, summaries, no secrets)
#   supabase     Supabase-like default privileges (ALL on new tables / functions / sequences, USAGE on new schemas, for
#                anon / authenticated / service_role): the migration neutralises them and the behaviour still holds
#   concurrency  real parallel sessions: call cap, cost cap, per-brand caps, duplicate attempts, duplicate settlements
#   adverse      unsafe role graphs make the migration refuse atomically, leaving the catalog exactly as it was
#   rollback     the catalog outside the ledger is unchanged by the migration, and the rollback script restores it
#   e2e          executeAiRequest + SupabaseLedgerBudgetGuard -> a PostgREST shim -> this migration (fake AI provider);
#                needs deno, curl and AIL_SHIM_PORT (default 54398) free on 127.0.0.1
#
# The host must be a local socket directory under /tmp (anything else is refused), so a mistyped host can never
# point this at a real project. Scratch databases and roles are created and dropped.
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
MIGRATION="${AIL_MIGRATION:-$HERE/../migrations/20261010050613_ai_provider_budget_ledger.sql}"
PARTS="${AIL_PARTS:-behaviour supabase nonsuper concurrency adverse rollback e2e}"
PREFIX="ail_proof_$$"
DBS=()
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ail_proof.XXXXXX")"
SHIM_PID_FILE="$WORK/shim.pid"

psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
want() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

# Role memberships and attributes are CLUSTER-wide: adverse cases change them, so they are undone after every case,
# at exit and before the first case.
reset_cluster_roles() {
  psql_super -d postgres >/dev/null 2>&1 <<SQL || true
do \$\$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke %I from %I', '$SUPER', r);
      execute format('revoke pg_read_all_data from %I', r);
      execute format('revoke pg_write_all_data from %I', r);
      execute format('alter role %I nosuperuser', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke service_role from %I', r); end if;
    end loop;
  end if;
  -- extra roles of the SET ROLE path cases (their scratch databases are dropped before this runs)
  foreach r in array array['ail_hop1', 'ail_hop2', 'ail_reader', 'ail_owner'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('drop role %I', r); end if;
  end loop;
end
\$\$;
SQL
}
drop_db() { psql_super -d postgres -c "drop database if exists $1" >/dev/null; }
cleanup() {
  if [ -f "$SHIM_PID_FILE" ]; then kill "$(cat "$SHIM_PID_FILE")" 2>/dev/null || true; fi
  for db in ${DBS[@]+"${DBS[@]}"}; do psql_super -d postgres -c "drop database if exists $db" >/dev/null 2>&1 || true; done
  reset_cluster_roles
  find "$WORK" -type f -delete 2>/dev/null || true
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
for leftover in $(psql_super -d postgres -Atc "select datname from pg_database where datname like 'ail\\_proof\\_%'"); do
  psql_super -d postgres -c "drop database if exists $leftover" >/dev/null 2>&1 || true
done
reset_cluster_roles

# fresh_db <name> [supabase]: a database with the three roles Supabase provides.
fresh_db() {
  local db="${PREFIX}_$1"
  DBS+=("$db")
  psql_super -d postgres -c "create database $db" >/dev/null
  psql_super -d "$db" >/dev/null <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$$;
grant usage on schema public to anon, authenticated, service_role;
SQL
  if [ "${2:-}" = "supabase" ]; then
    psql_super -d "$db" >/dev/null <<'SQL'
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges grant all on tables to anon, authenticated, service_role;
alter default privileges grant all on functions to anon, authenticated, service_role;
alter default privileges grant all on sequences to anon, authenticated, service_role;
alter default privileges grant usage, create on schemas to anon, authenticated, service_role;
SQL
  fi
  echo "$db"
}
apply() { psql_super -d "$1" -f "$MIGRATION" >/dev/null; }
digest() { psql_super -d "$1" -Atf "$HERE/ai_provider_budget_ledger_digest.sql"; }
ledger_objects() {
  psql_super -d "$1" -Atc "select (select count(*) from pg_namespace where nspname = 'ai_ledger') + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ai\_ledger\_%')"
}
has_part() { case " $PARTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- behaviour -------------------------------------------------------------------------------------------------
if has_part behaviour; then
  DB="$(fresh_db clean)"
  apply "$DB"
  if psql_super -d "$DB" -f "$MIGRATION" >/dev/null 2>&1; then fail "migration applied twice"; fi
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_behavior.sql"
  echo "PASS behaviour"
fi

# ---- supabase-like default privileges ----------------------------------------------------------------------------
if has_part supabase; then
  DB="$(fresh_db supabase supabase)"
  apply "$DB"
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_behavior.sql" >/dev/null
  echo "PASS supabase-like default privileges neutralised; behaviour holds"
fi

# ---- concurrency (real parallel sessions) ------------------------------------------------------------------------
# run_parallel <db> <count> <sql-template with {i}> <out-prefix>: <count> concurrent sessions as service_role.
run_parallel() {
  local db="$1" count="$2" template="$3" prefix="$4" i pids=()
  for i in $(seq 1 "$count"); do
    ( psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "$db" -Atq -v ON_ERROR_STOP=1 \
        -c "set role service_role" -c "${template//\{i\}/$i}" >"$WORK/$prefix.$i" 2>&1 || echo "ERROR" >>"$WORK/$prefix.$i" ) &
    pids+=("$!")
  done
  wait "${pids[@]}"
}
count_lines() { cat "$WORK/$1".* | grep -c "^$2\$" || true; }
query() { psql_super -d "$1" -Atc "$2"; }

if has_part concurrency; then

  # 1. call cap: 150 concurrent reservations against max_calls 50
  DB="$(fresh_db conc_calls)"; apply "$DB"
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, period, max_calls) values ('conc.calls', 'month', 50)" >/dev/null
  run_parallel "$DB" 150 "select public.ai_ledger_reserve(jsonb_build_object('request_id', 'c-{i}', 'attempt', 1, 'provider', 'anthropic', 'model', 'claude-opus-5-5', 'application', 'kabumori', 'feature', 'market_report', 'logical_role', 'k.mr', 'subject_kind', 'system', 'amount_usd', 0.01)) ->> 'allowed'" calls
  want "$(count_lines calls true)" 50 "call cap: allowed sessions"
  want "$(count_lines calls false)" 100 "call cap: denied sessions"
  want "$(count_lines calls ERROR)" 0 "call cap: errors"
  want "$(query "$DB" "select calls || '/' || held_usd from ai_ledger.budget_buckets")" "50/0.50000000" "call cap: bucket"
  want "$(query "$DB" "select count(*) from ai_ledger.reservations")" 50 "call cap: reservations"
  echo "PASS concurrency: 150 sessions vs call cap 50 -> exactly 50"

  # 2. cost cap: 150 concurrent reservations of 0.02 against 0.5 USD
  DB="$(fresh_db conc_cost)"; apply "$DB"
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, period, max_estimated_usd) values ('conc.cost', 'month', 0.5)" >/dev/null
  run_parallel "$DB" 150 "select public.ai_ledger_reserve(jsonb_build_object('request_id', 'u-{i}', 'attempt', 1, 'provider', 'openai', 'model', 'gpt-6-luna', 'application', 'kabumori', 'feature', 'news', 'logical_role', 'k.n', 'subject_kind', 'system', 'amount_usd', 0.02)) ->> 'allowed'" cost
  want "$(count_lines cost true)" 25 "cost cap: allowed sessions"
  want "$(query "$DB" "select held_usd from ai_ledger.budget_buckets")" "0.50000000" "cost cap: held"
  echo "PASS concurrency: 150 sessions vs 0.5 USD cap -> exactly 25 x 0.02"

  # 3. several caps at once: 3 brands x 50 sessions, 10 calls per brand, 25 calls overall
  DB="$(fresh_db conc_brand)"; apply "$DB"
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, scope_subject_kind, per_brand, period, max_calls) values ('conc.brand', 'user', true, 'month', 10); insert into ai_ledger.budget_policies (policy_key, period, max_calls) values ('conc.all', 'month', 25)" >/dev/null
  run_parallel "$DB" 150 "select (select brand || ':' || (public.ai_ledger_reserve(jsonb_build_object('request_id', 'b-{i}', 'attempt', 1, 'provider', 'openai', 'model', 'gpt-6-luna', 'application', 'postona', 'feature', 'post', 'logical_role', 'p.p', 'subject_kind', 'user', 'user_id', gen_random_uuid(), 'brand_id', brand, 'amount_usd', 0.001)) ->> 'allowed') from (select ('00000000-0000-4000-8000-0000000000b' || ({i} % 3))::uuid as brand) s)" brand
  want "$(count_lines brand '.*:true')" 25 "multi-cap: allowed overall"
  want "$(query "$DB" "select max(calls) <= 10 and sum(calls) = 25 from ai_ledger.budget_buckets b join ai_ledger.budget_policies p on p.id = b.policy_id where p.policy_key = 'conc.brand'")" t "multi-cap: no brand above 10"
  want "$(query "$DB" "select calls from ai_ledger.budget_buckets b join ai_ledger.budget_policies p on p.id = b.policy_id where p.policy_key = 'conc.all'")" 25 "multi-cap: overall bucket"
  echo "PASS concurrency: brand caps and the overall cap hold together"

  # 4. the same attempt from 60 sessions: one reservation, one call
  DB="$(fresh_db conc_dup)"; apply "$DB"
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, period, max_calls) values ('conc.dup', 'month', 1000)" >/dev/null
  run_parallel "$DB" 60 "select public.ai_ledger_reserve('{\"request_id\": \"same\", \"attempt\": 1, \"provider\": \"openai\", \"model\": \"gpt-6-luna\", \"application\": \"kabumori\", \"feature\": \"news\", \"logical_role\": \"k.n\", \"subject_kind\": \"system\", \"amount_usd\": 0.01}'::jsonb) ->> 'reservation_id'" dup
  want "$(cat "$WORK"/dup.* | sort -u | wc -l | tr -d ' ')" 1 "duplicate attempt: one reservation id in every answer"
  want "$(query "$DB" "select count(*) || '/' || (select calls from ai_ledger.budget_buckets) from ai_ledger.reservations")" "1/1" "duplicate attempt: counted once"
  echo "PASS concurrency: 60 identical reservations -> one"

  # 5. the same settlement from 60 sessions: one event, charged once
  RID="$(query "$DB" "select id from ai_ledger.reservations")"
  query "$DB" "set role service_role; select public.ai_ledger_mark_sent('{\"reservation_id\": \"$RID\"}')" >/dev/null
  run_parallel "$DB" 60 "select public.ai_ledger_settle('{\"reservation_id\": \"$RID\", \"outcome\": \"succeeded\", \"cost_basis\": \"measured\", \"estimated_cost_usd\": 0.003, \"input_tokens\": 10, \"output_tokens\": 5, \"price_catalog_version\": \"v1\"}'::jsonb) ->> 'duplicate'" settle
  want "$(count_lines settle false)" 1 "duplicate settlement: one first settlement"
  want "$(count_lines settle true)" 59 "duplicate settlement: the rest are duplicates"
  want "$(query "$DB" "select (select count(*) from ai_ledger.usage_events) || '/' || settled_usd || '/' || held_usd from ai_ledger.budget_buckets")" "1/0.00300000/0.00000000" "duplicate settlement: charged once"
  echo "PASS concurrency: 60 identical settlements -> one event"

  # R1. one reservation marked sent by 60 sessions: exactly ONE send permit (the reserved -> sent transition)
  DB="$(fresh_db conc_mark)"; apply "$DB"
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, period, max_calls) values ('conc.mark', 'month', 1000)" >/dev/null
  reserve_one() {
    query "$1" "set role service_role; select public.ai_ledger_reserve(jsonb_build_object('request_id', '$2', 'attempt', 1, 'provider', 'openai', 'model', 'gpt-6-luna', 'application', 'kabumori', 'feature', 'news', 'logical_role', 'k.n', 'subject_kind', 'system', 'amount_usd', 0.01)) ->> 'reservation_id'"
  }
  RID="$(reserve_one "$DB" mark)"
  run_parallel "$DB" 60 "select public.ai_ledger_mark_sent('{\"reservation_id\": \"$RID\"}'::jsonb) ->> 'may_send'" mark
  want "$(count_lines mark true)" 1 "R1: send permits for one reservation"
  want "$(count_lines mark false)" 59 "R1: refused duplicate permits"
  want "$(query "$DB" "select status from ai_ledger.reservations where id = '$RID'")" sent "R1: reservation sent once"
  echo "PASS concurrency R1: 60 concurrent mark_sent on one reservation -> exactly one send permit"

  # R1. mark_sent racing release on an unsent reservation: at most one permit, and the final state agrees with it
  run_mixed() {
    local db="$1" count="$2" a="$3" b="$4" prefix="$5" i pids=()
    for i in $(seq 1 "$count"); do
      ( psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "$db" -Atq -v ON_ERROR_STOP=1 -c "set role service_role" -c "$a" \
          >"$WORK/${prefix}_a.$i" 2>&1 || echo "ERROR" >>"$WORK/${prefix}_a.$i" ) &
      pids+=("$!")
      ( psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "$db" -Atq -v ON_ERROR_STOP=1 -c "set role service_role" -c "$b" \
          >"$WORK/${prefix}_b.$i" 2>&1 || echo "ERROR" >>"$WORK/${prefix}_b.$i" ) &
      pids+=("$!")
    done
    wait "${pids[@]}"
  }
  RID="$(reserve_one "$DB" race-release)"
  run_mixed "$DB" 30 "select public.ai_ledger_mark_sent('{\"reservation_id\": \"$RID\"}'::jsonb) ->> 'may_send'" \
    "select public.ai_ledger_release('{\"reservation_id\": \"$RID\"}'::jsonb) ->> 'status'" relrace
  PERMITS="$(count_lines relrace_a true)"
  STATUS="$(query "$DB" "select status from ai_ledger.reservations where id = '$RID'")"
  want "$(count_lines relrace_a ERROR)$(count_lines relrace_b ERROR)" 00 "R1 release race: errors"
  case "$PERMITS/$STATUS" in 1/sent|0/released) ;; *) fail "R1 release race: $PERMITS permits with final status $STATUS" ;; esac
  echo "PASS concurrency R1: mark_sent vs release -> $PERMITS permit(s), final status $STATUS (consistent)"

  # R1. mark_sent racing recovery on an EXPIRED unsent reservation: no permit, released exactly once
  RID="$(reserve_one "$DB" race-recover)"
  CALLS_BEFORE="$(query "$DB" "select calls from ai_ledger.budget_buckets")"
  query "$DB" "set session_replication_role = replica; update ai_ledger.reservations set expires_at = now() - interval '1 minute' where id = '$RID'" >/dev/null
  run_mixed "$DB" 30 "select public.ai_ledger_mark_sent('{\"reservation_id\": \"$RID\"}'::jsonb) ->> 'may_send'" \
    "select public.ai_ledger_recover_stale('{}'::jsonb) ->> 'released'" recrace
  want "$(count_lines recrace_a true)" 0 "R1 recovery race: no permit for an expired hold"
  want "$(query "$DB" "select status from ai_ledger.reservations where id = '$RID'")" released "R1 recovery race: released"
  want "$(query "$DB" "select calls from ai_ledger.budget_buckets")" "$((CALLS_BEFORE - 1))" "R1 recovery race: call returned once"
  echo "PASS concurrency R1: mark_sent vs recover_stale on an expired hold -> no permit, released once"
fi

# ---- adverse role graphs: the migration refuses, atomically --------------------------------------------------------
# A non-superuser migration owner, like the production `postgres` role (created per case, dropped by the reset).
make_owner() {
  psql_super -d "$1" >/dev/null <<SQL
do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'ail_owner') then create role ail_owner nologin; end if; end \$\$;
grant create on database $1 to ail_owner;
grant create on schema public to ail_owner;
SQL
}
apply_as_owner() { psql_super -d "$1" -c "set role ail_owner" -f "$MIGRATION" >/dev/null; }

# refuse <name> <expected message fragment> <setup sql> [owner]: the migration must refuse, atomically, with the
# whole catalog (objects, ACLs, default ACLs, roles, memberships) exactly as before. owner=nonsuper applies it as
# the non-superuser owner.
refuse() {
  local name="$1" expect="$2" setup="$3" owner="${4:-super}" db before after out
  db="$(fresh_db "$name")"
  [ "$owner" = nonsuper ] && make_owner "$db"
  psql_super -d "$db" -c "$setup" >/dev/null
  before="$(digest "$db")"
  local applied=no
  if [ "$owner" = nonsuper ]; then
    if out="$(psql_super -d "$db" -c "set role ail_owner" -f "$MIGRATION" 2>&1)"; then applied=yes; fi
  else
    if out="$(psql_super -d "$db" -f "$MIGRATION" 2>&1)"; then applied=yes; fi
  fi
  if [ "$applied" = yes ]; then
    # AIL_REPORT_ONLY=1 (used to show a pre-fix migration's gaps): report and continue instead of failing.
    if [ "${AIL_REPORT_ONLY:-}" = 1 ]; then echo "NOT REFUSED: $name"; drop_db "$db"; reset_cluster_roles; return 0; fi
    fail "$name: migration applied on an unsafe role graph"
  fi
  case "$out" in *"$expect"*) ;; *) fail "$name: wrong refusal: $out" ;; esac
  want "$(ledger_objects "$db")" 0 "$name: nothing left behind"
  after="$(digest "$db")"
  want "$after" "$before" "$name: catalog unchanged"
  drop_db "$db"
  reset_cluster_roles
  echo "PASS adverse: $name refused ($expect)"
}
if has_part adverse; then
  refuse member_of_owner AI_LEDGER_ACL_UNSAFE_MEMBERSHIP "grant $SUPER to authenticated"
  refuse read_all_data AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE "grant pg_read_all_data to service_role"
  refuse write_all_data AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE "grant pg_write_all_data to anon"
  refuse superuser_role AI_LEDGER_ACL_UNSAFE_MEMBERSHIP "alter role anon superuser"
  # R2: SET ROLE paths (NOINHERIT memberships that still allow SET ROLE), direct and transitive.
  refuse r2_set_direct_authenticated AI_LEDGER_ACL_UNSAFE_ROLE_PATH "grant service_role to authenticated with inherit false, set true"
  refuse r2_set_direct_anon AI_LEDGER_ACL_UNSAFE_ROLE_PATH "grant service_role to anon with inherit false, set true"
  refuse r2_set_transitive AI_LEDGER_ACL_UNSAFE_ROLE_PATH "create role ail_hop1 nologin; create role ail_hop2 nologin; grant ail_hop1 to authenticated with inherit false, set true; grant ail_hop2 to ail_hop1 with inherit false, set true; grant service_role to ail_hop2 with inherit false, set true"
  refuse r2_set_mixed_hops AI_LEDGER_ACL_UNSAFE_ROLE_PATH "create role ail_hop1 nologin; grant ail_hop1 to anon with inherit false, set true; grant service_role to ail_hop1 with inherit true, set false"
  refuse r2_inherit_direct AI_LEDGER_ACL_EFFECTIVE_PRIVILEGE "grant service_role to authenticated"
  refuse r2_set_into_read_all_data AI_LEDGER_ACL_UNSAFE_ROLE_PATH "grant pg_read_all_data to anon with inherit false, set true"
  refuse r2_set_existing_acl_anomaly AI_LEDGER_ACL_UNEXPECTED_RELATION_GRANT "create role ail_reader nologin; alter default privileges grant select on tables to ail_reader; grant ail_reader to authenticated with inherit false, set true"
  refuse r2_set_direct_nonsuper_owner AI_LEDGER_ACL_UNSAFE_ROLE_PATH "grant service_role to authenticated with inherit false, set true" nonsuper

  # R2 safe controls: memberships that confer neither privileges nor SET ROLE must NOT be refused.
  for setup in \
    "grant service_role to authenticated with inherit false, set false" \
    "create role ail_hop1 nologin; grant ail_hop1 to anon with inherit true, set false; grant service_role to ail_hop1 with inherit false, set true"; do
    DB="$(fresh_db r2_control)"
    psql_super -d "$DB" -c "$setup" >/dev/null
    apply "$DB" || fail "R2 control refused: $setup"
    for app in anon authenticated; do
      if psql_super -d "$DB" -c "set session authorization $app" -c "set role service_role" >/dev/null 2>&1; then
        fail "R2 control: $app could SET ROLE service_role ($setup)"
      fi
    done
    drop_db "$DB"
    reset_cluster_roles
    echo "PASS adverse R2 control accepted: $setup"
  done
fi

# ---- non-superuser owner (as the production migration role): apply and behave ----------------------------------------
if has_part nonsuper; then
  DB="$(fresh_db nonsuper supabase)"
  make_owner "$DB"
  apply_as_owner "$DB"
  want "$(query "$DB" "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'ai_ledger'")" ail_owner "nonsuper: owner"
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_behavior.sql" >/dev/null
  drop_db "$DB"
  reset_cluster_roles
  echo "PASS nonsuper: applied by a non-superuser owner; behaviour holds"
fi

# ---- rollback and impact on existing structure ---------------------------------------------------------------------
if has_part rollback; then
  DB="$(fresh_db rollback supabase)"
  psql_super -d "$DB" >/dev/null <<'SQL'
-- Stand-ins for what already exists in the project: an AI usage table, an RPC and a policy-protected table.
create table public.ai_usage_events (id bigint generated always as identity primary key, feature text not null, cost_usd numeric(12, 8) not null);
alter table public.ai_usage_events enable row level security;
revoke all on public.ai_usage_events from anon, authenticated;
create function public.existing_rpc(p jsonb) returns jsonb language sql security definer set search_path = '' as $$ select p $$;
revoke all on function public.existing_rpc(jsonb) from public, anon, authenticated;
grant execute on function public.existing_rpc(jsonb) to service_role;
create table public.profiles (id uuid primary key, name text);
alter table public.profiles enable row level security;
create policy own_profile on public.profiles for select to authenticated using (true);
SQL
  BEFORE="$(digest "$DB")"
  apply "$DB"
  want "$(digest "$DB")" "$BEFORE" "existing structure untouched by the migration"
  want "$(ledger_objects "$DB")" 8 "ledger objects present (schema + 7 RPCs)"
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_rollback.sql" >/dev/null
  want "$(digest "$DB")" "$BEFORE" "rollback restores the catalog"
  want "$(ledger_objects "$DB")" 0 "rollback leaves no ledger object"
  echo "PASS rollback: existing structure untouched; rollback script restores the exact catalog"
fi

# ---- end to end: TypeScript provider + ledger guard -> PostgREST shim -> this migration ---------------------------
if has_part e2e; then
  DB="$(fresh_db e2e supabase)"; apply "$DB"
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, period, max_estimated_usd, max_calls) values ('e2e.global', 'month', 5, 1000); insert into ai_ledger.budget_policies (policy_key, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls) values ('e2e.consult.per_user', 'postona', 'consult', 'user', true, 'day', 2); insert into ai_ledger.budget_policies (policy_key, scope_application, scope_feature, period, max_calls) values ('e2e.r1.r1_cap1', 'kabumori', 'r1_cap1', 'month', 1), ('e2e.r1.r1_cap10', 'kabumori', 'r1_cap10', 'month', 10), ('e2e.r1.r1_timeout', 'kabumori', 'r1_timeout', 'month', 5)" >/dev/null
  SHIM_PORT="${AIL_SHIM_PORT:-54398}"
  SHIM_KEY="local-shim-key-$$-not-a-secret"
  ( AIL_PGHOST="$HOST" AIL_PGPORT="$PORT" AIL_PGSUPER="$SUPER" AIL_DB="$DB" SHIM_PORT="$SHIM_PORT" SHIM_KEY="$SHIM_KEY" \
      deno run --no-config --allow-net=127.0.0.1 --allow-env --allow-run=psql "$HERE/ai_provider_budget_ledger_postgrest_shim.ts" \
      >"$WORK/shim.log" 2>&1 & echo $! >"$SHIM_PID_FILE" )
  for _ in $(seq 1 100); do
    if curl -s -o /dev/null -X POST "http://127.0.0.1:$SHIM_PORT/rest/v1/rpc/ai_ledger_budget_status" -H "apikey: x"; then break; fi
    sleep 0.1
  done
  AIL_E2E_URL="http://127.0.0.1:$SHIM_PORT" AIL_E2E_KEY="$SHIM_KEY" \
    deno test --no-config --allow-net=127.0.0.1 --allow-env --allow-read "$HERE/ai_provider_budget_ledger_e2e_test.ts" >"$WORK/e2e.log" 2>&1 \
    || { cat "$WORK/e2e.log" >&2; fail "e2e"; }
  if grep -q "[1-9][0-9]* ignored" "$WORK/e2e.log"; then cat "$WORK/e2e.log" >&2; fail "e2e tests were ignored (environment not passed)"; fi
  kill "$(cat "$SHIM_PID_FILE")" 2>/dev/null || true
  rm -f "$SHIM_PID_FILE"
  echo "PASS e2e: $(grep -Eo '[0-9]+ passed \| [0-9]+ failed' "$WORK/e2e.log" | tail -1) (TypeScript -> PostgREST shim -> PostgreSQL)"
fi

echo "ALL REQUESTED PARTS PASSED: $PARTS"
