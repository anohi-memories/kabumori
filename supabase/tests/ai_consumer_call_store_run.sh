#!/usr/bin/env bash
# Disposable-PostgreSQL proof of 20261017120000_ai_consumer_call_store.sql (on top of the AI ledger migration).
# Never touches Supabase.
#
#   ACS_PGHOST=/private/tmp/<socket dir> ACS_PGPORT=54911 ACS_PGSUPER=<superuser> bash supabase/tests/ai_consumer_call_store_run.sh
#
# Optional: ACS_MIGRATION=<file> runs everything against another copy (the mutation runner uses this);
#           ACS_PARTS="behaviour concurrency ..." runs only those parts.
#
# Parts:
#   isolation    the target is a local socket-only server (no TCP listener), recorded before anything runs
#   behaviour    clean apply after the ledger, one-shot (a re-apply fails and changes nothing), preconditions
#                (no ledger / ledger not readable -> refused, nothing created), fixture + behaviour file
#   persistence  a claim, its duplicate, its completion and its replay from separate connections
#   supabase     Supabase-like default privileges are neutralised; behaviour holds
#   nonsuper     applied by a non-superuser owner (like the production migration role); behaviour holds
#   concurrency  real parallel sessions: one claim winner, drift under contention, owner fencing, complete vs
#                abandon, forget_user vs claims of the same user
#   adverse      unsafe role graphs make the migration refuse atomically, leaving the catalog exactly as it was
#   rollback     the ledger and everything else are unchanged by the migration; the rollback script restores it
#   legacy       the ledger's own fixture + behaviour suite still pass with the call store applied
#
# The host must be a local socket directory under /tmp (anything else is refused), so a mistyped host can never
# point this at a real project. Scratch databases and roles are created and dropped.
set -euo pipefail
export LC_ALL=C

HOST="${ACS_PGHOST:?ACS_PGHOST (local socket dir under /tmp or /private/tmp) is required}"
PORT="${ACS_PGPORT:-5432}"
SUPER="${ACS_PGSUPER:-postgres}"
case "$HOST" in
  /tmp/*|/private/tmp/*) ;;
  *) echo "refusing host '$HOST': only a local socket directory under /tmp is allowed" >&2; exit 2 ;;
esac
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE

HERE="$(cd "$(dirname "$0")" && pwd)"
LEDGER="$HERE/../migrations/20261010050613_ai_provider_budget_ledger.sql"
MIGRATION="${ACS_MIGRATION:-$HERE/../migrations/20261017120000_ai_consumer_call_store.sql}"
PARTS="${ACS_PARTS:-isolation behaviour persistence supabase nonsuper concurrency adverse rollback legacy bridge}"
PREFIX="acs_proof_$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/acs_proof.XXXXXX")"

psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
want() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }
query() { psql_super -d "$1" -Atc "$2"; }

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
  foreach r in array array['acs_hop1', 'acs_reader', 'acs_owner', 'acs_other'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      begin
        execute format('drop owned by %I cascade', r);
        execute format('drop role %I', r);
      exception when others then
        raise warning 'could not drop role %: %', r, sqlerrm;
      end;
    end if;
  end loop;
end
\$\$;
SQL
}
drop_db() { psql_super -d postgres -c "drop database if exists $1" >/dev/null; }
cleanup() {
  for db in $(psql_super -d postgres -Atc "select datname from pg_database where datname like '${PREFIX}\\_%'" 2>/dev/null); do
    psql_super -d postgres -c "drop database if exists $db" >/dev/null 2>&1 || true
  done
  reset_cluster_roles
  find "$WORK" -type f -delete 2>/dev/null || true
  rmdir "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
for leftover in $(psql_super -d postgres -Atc "select datname from pg_database where datname like 'acs\\_proof\\_%'"); do
  psql_super -d postgres -c "drop database if exists $leftover" >/dev/null 2>&1 || true
done
reset_cluster_roles

# fresh_db <name> [supabase]: a database with the three roles Supabase provides.
fresh_db() {
  local db="${PREFIX}_$1"
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
apply_ledger() { psql_super -d "$1" -f "$LEDGER" >/dev/null; }
apply() { psql_super -d "$1" -f "$MIGRATION" >/dev/null; }
fixtures() {
  psql_super -d "$1" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$1" -f "$HERE/ai_consumer_call_store_fixture.sql" >/dev/null
}
digest() { psql_super -d "$1" -Atf "$HERE/ai_consumer_call_store_digest.sql"; }
store_objects() {
  query "$1" "select (select count(*) from pg_namespace where nspname = 'ai_calls') + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ai\_calls\_%')"
}
# (pg_dump 17.6+ wraps the dump in \restrict / \unrestrict with a random key per run: dropped before comparing.)
schema_dump() { pg_dump -h "$HOST" -p "$PORT" -U "$SUPER" --schema-only --no-owner "$1" | awk '!/^\\(un)?restrict /'; }
has_part() { case " $PARTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- isolation ---------------------------------------------------------------------------------------------------
if has_part isolation; then
  ISO="$(query postgres "select current_setting('listen_addresses') || '|' || coalesce(inet_server_addr()::text, 'unix-socket') || '|' || current_setting('unix_socket_directories') || '|' || (select system_identifier from pg_control_system())")"
  case "$ISO" in "|unix-socket|"*) ;; *) fail "isolation: the server listens on TCP or was reached over TCP ($ISO)" ;; esac
  echo "PASS isolation: listen_addresses='' (no TCP listener), reached over a unix socket, cluster ${ISO##*|}"
fi

# ---- behaviour -------------------------------------------------------------------------------------------------
if has_part behaviour; then
  # preconditions: no ledger -> refused, nothing created
  DB="$(fresh_db noledger)"
  BEFORE="$(digest "$DB")"
  if out="$(psql_super -d "$DB" -f "$MIGRATION" 2>&1)"; then fail "applied without the ledger"; fi
  case "$out" in *AI_CALLS_REQUIRES_LEDGER*) ;; *) fail "no ledger: wrong refusal: $out" ;; esac
  want "$(store_objects "$DB")" 0 "no ledger: nothing left behind"
  want "$(digest "$DB")" "$BEFORE" "no ledger: catalog unchanged"
  drop_db "$DB"
  echo "PASS behaviour precondition: refused without the ledger (AI_CALLS_REQUIRES_LEDGER), nothing created"

  # preconditions: the migrating role cannot read the ledger -> refused
  DB="$(fresh_db unreadable)"
  apply_ledger "$DB"
  psql_super -d "$DB" >/dev/null <<SQL
create role acs_other nologin;
grant create on database $DB to acs_other;
SQL
  BEFORE="$(digest "$DB")"
  if out="$(psql_super -d "$DB" -c "set role acs_other" -f "$MIGRATION" 2>&1)"; then fail "applied by a role that cannot read the ledger"; fi
  case "$out" in *AI_CALLS_LEDGER_NOT_READABLE*) ;; *) fail "unreadable ledger: wrong refusal: $out" ;; esac
  want "$(store_objects "$DB")" 0 "unreadable ledger: nothing left behind"
  want "$(digest "$DB")" "$BEFORE" "unreadable ledger: catalog unchanged"
  drop_db "$DB"
  reset_cluster_roles
  echo "PASS behaviour precondition: refused when the migrating role cannot read the ledger (AI_CALLS_LEDGER_NOT_READABLE)"

  DB="$(fresh_db clean)"
  apply_ledger "$DB"
  apply "$DB"
  schema_dump "$DB" >"$WORK/dump_before"
  if out="$(psql_super -d "$DB" -f "$MIGRATION" 2>&1)"; then fail "migration applied twice"; fi
  schema_dump "$DB" >"$WORK/dump_after"
  cmp -s "$WORK/dump_before" "$WORK/dump_after" || fail "a failed re-apply changed the schema"
  echo "PASS behaviour one-shot: a second apply fails ($(printf '%s\n' "$out" | sed -n 's/.*ERROR: *//p' | head -1 | cut -c1-90)) and changes nothing"
  fixtures "$DB"
  psql_super -d "$DB" -f "$HERE/ai_consumer_call_store_behavior.sql"
  echo "PASS behaviour"
fi

# ---- persistence across connections ------------------------------------------------------------------------------
if has_part persistence; then
  DB="$(fresh_db persist)"
  apply_ledger "$DB"; apply "$DB"; fixtures "$DB"
  C="acs_test.claim_p('op-persist', 'tenant-p', 'content-p')"
  OWNER="$(query "$DB" "select acs_test.claim($C) ->> 'owner'")"
  want "$(query "$DB" "select acs_test.claim($C) ->> 'kind'")" busy "persistence: a later connection sees the claim"
  query "$DB" "select acs_test.rpc('ai_calls_complete', acs_test.complete_p($C, '$OWNER', acs_test.ok_result($C, '{\"reply\": \"kept\"}')))" >/dev/null
  want "$(query "$DB" "select acs_test.claim($C) -> 'result' -> 'data' ->> 'reply'")" kept "persistence: replay from another connection"
  want "$(query "$DB" "select (acs_test.claim($C) -> 'result' -> 'audit' ->> 'callId') = ($C ->> 'call_key')")" t "persistence: the callId is the stored key"
  drop_db "$DB"
  echo "PASS persistence: claim, duplicate, completion and replay each from a separate connection"
fi

# ---- supabase-like default privileges ----------------------------------------------------------------------------
if has_part supabase; then
  DB="$(fresh_db supabase supabase)"
  apply_ledger "$DB"
  apply "$DB"
  fixtures "$DB"
  psql_super -d "$DB" -f "$HERE/ai_consumer_call_store_behavior.sql" >/dev/null
  drop_db "$DB"
  echo "PASS supabase-like default privileges neutralised; behaviour holds"
fi

# ---- non-superuser owner -----------------------------------------------------------------------------------------
make_owner() {
  psql_super -d "$1" >/dev/null <<SQL
do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'acs_owner') then create role acs_owner nologin; end if; end \$\$;
grant create on database $1 to acs_owner;
grant create on schema public to acs_owner;
SQL
}
if has_part nonsuper; then
  DB="$(fresh_db nonsuper supabase)"
  make_owner "$DB"
  psql_super -d "$DB" -c "set role acs_owner" -f "$LEDGER" >/dev/null
  psql_super -d "$DB" -c "set role acs_owner" -f "$MIGRATION" >/dev/null
  want "$(query "$DB" "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'ai_calls'")" acs_owner "nonsuper: owner"
  fixtures "$DB"
  psql_super -d "$DB" -f "$HERE/ai_consumer_call_store_behavior.sql" >/dev/null
  drop_db "$DB"
  reset_cluster_roles
  echo "PASS nonsuper: applied by a non-superuser owner; behaviour holds"
fi

# ---- concurrency (real parallel sessions) ------------------------------------------------------------------------
# run_parallel <db> <count> <sql-template with {i}> <out-prefix>: <count> concurrent sessions (superuser session;
# acs_test.try calls the RPC as service_role).
run_parallel() {
  local db="$1" count="$2" template="$3" prefix="$4" i pids=()
  for i in $(seq 1 "$count"); do
    ( psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "$db" -Atq -v ON_ERROR_STOP=1 \
        -c "${template//\{i\}/$i}" >"$WORK/$prefix.$i" 2>&1 || echo "ERROR" >>"$WORK/$prefix.$i" ) &
    pids+=("$!")
  done
  wait "${pids[@]}"
}
count_matching() { cat "$WORK/$1".* | grep -c -- "$2" || true; }

# slow <db> <insert|update|off> <seconds>: a test-only BEFORE trigger that sleeps inside the RPC's transaction, so
# the first writer still holds its locks (or its uncommitted row) while the other sessions arrive. Without it the
# sessions barely overlap and a missing lock could go unnoticed.
slow() {
  query "$1" "set client_min_messages = warning; drop trigger if exists acs_slow on ai_calls.consumer_calls" >/dev/null
  if [ "$2" != off ]; then
    query "$1" "update acs_test.knobs set delay_seconds = $3; create trigger acs_slow before $2 on ai_calls.consumer_calls for each row execute function acs_test.slow()" >/dev/null
  fi
}

if has_part concurrency; then
  DB="$(fresh_db conc)"; apply_ledger "$DB"; apply "$DB"; fixtures "$DB"

  # C1. 60 sessions claim one key while the first insert is held open: exactly one owner, everyone else busy
  slow "$DB" insert 0.5
  C="acs_test.claim_p('op-c1', 'tenant-c', 'content-c1')"
  run_parallel "$DB" 60 "select acs_test.try('ai_calls_claim', $C)" c1
  want "$(count_matching c1 '"kind": "acquired"')" 1 "C1: owners"
  want "$(count_matching c1 '"kind": "busy"')" 59 "C1: busy"
  want "$(count_matching c1 'ERR')$(count_matching c1 '^ERROR')" 00 "C1: errors"
  want "$(query "$DB" "select count(*) from ai_calls.consumer_calls where call_key = $C ->> 'call_key'")" 1 "C1: rows"
  echo "PASS concurrency C1: 60 concurrent claims of one call (first insert held 0.5 s) -> exactly one owner, 59 busy"

  # C2. the same with two different contents: one owner; the same content busy, the other conflict
  C="acs_test.claim_p('op-c2', 'tenant-c', case when {i} % 2 = 0 then 'even' else 'odd' end)"
  run_parallel "$DB" 60 "select acs_test.try('ai_calls_claim', $C)" c2
  want "$(count_matching c2 '"kind": "acquired"')" 1 "C2: owners"
  want "$(count_matching c2 '"kind": "conflict"')" 30 "C2: conflicts (the other content)"
  want "$(count_matching c2 '"kind": "busy"')" 29 "C2: busy (the same content)"
  want "$(count_matching c2 'ERR')$(count_matching c2 '^ERROR')" 00 "C2: errors"
  echo "PASS concurrency C2: content drift under contention -> one owner, 30 conflict, 29 busy"
  slow "$DB" off

  # C3. the owner's completion x20 races 20 forged owners while the first write is held open: one write, 19
  #     duplicates, 20 fenced
  C="acs_test.claim_p('op-c3', 'tenant-c', 'content-c3')"
  OWNER="$(query "$DB" "select acs_test.claim($C) ->> 'owner'")"
  RES="acs_test.ok_result($C, '{\"reply\": \"winner\"}')"
  slow "$DB" update 0.5
  run_parallel "$DB" 40 "select acs_test.try('ai_calls_complete', acs_test.complete_p($C, case when {i} <= 20 then '$OWNER' else gen_random_uuid()::text end, $RES))" c3
  want "$(count_matching c3 '"duplicate": false')" 1 "C3: first completion"
  want "$(count_matching c3 '"duplicate": true')" 19 "C3: duplicates of the owner"
  want "$(count_matching c3 'ERR:AI_CALLS_FENCED')" 20 "C3: forged owners fenced"
  want "$(query "$DB" "select result = $RES from ai_calls.consumer_calls where call_key = $C ->> 'call_key'")" t "C3: the owner's result stored"
  echo "PASS concurrency C3: owner completion x20 vs forged owners x20 (first write held 0.5 s) -> one write, 19 duplicates, 20 fenced"

  # C4. completion races abandonment of an old claim: exactly one of them wins, and the other side agrees
  C="acs_test.claim_p('op-c4', 'tenant-c', 'content-c4')"
  slow "$DB" off
  OWNER="$(query "$DB" "select acs_test.claim($C) ->> 'owner'")"
  query "$DB" "select acs_test.backdate($C, interval '1 hour')" >/dev/null
  slow "$DB" update 0.5
  run_parallel "$DB" 60 "select case when {i} % 2 = 0 then acs_test.try('ai_calls_complete', acs_test.complete_p($C, '$OWNER', acs_test.ok_result($C, '{\"reply\": \"late\"}'))) else acs_test.try('ai_calls_abandon', acs_test.abandon_p($C, acs_test.audit($C, 0, 0, 'no_request'))) end" c4
  slow "$DB" off
  FINAL="$(query "$DB" "select state from ai_calls.consumer_calls where call_key = $C ->> 'call_key'")"
  WRITES="$(count_matching c4 '"duplicate": false')"
  DUPS="$(count_matching c4 '"duplicate": true')"
  ABANDONS="$(count_matching c4 '"abandoned": true')"
  NOT_ACQ="$(count_matching c4 '"reason": "NOT_ACQUIRED"')"
  FENCED="$(count_matching c4 'ERR:AI_CALLS_FENCED')"
  want "$(count_matching c4 '^ERROR')$(count_matching c4 'ERR:AI_CALLS_TRANSITION')" 00 "C4: session errors"
  case "$FINAL/$WRITES/$ABANDONS" in
    complete/1/0) want "$DUPS/$NOT_ACQ/$FENCED" "29/30/0" "C4: completion won" ;;
    abandoned/0/1) want "$NOT_ACQ/$FENCED" "29/30" "C4: abandonment won, every completion fenced" ;;
    *) fail "C4: inconsistent race: final $FINAL, $WRITES writes, $ABANDONS abandons" ;;
  esac
  echo "PASS concurrency C4: completion vs abandonment -> final $FINAL, consistent on both sides"

  # C5. forget_user while 15 claims of the same user are in flight (their inserts held 1 s), then 15 more claims:
  #     the forget waits for the in-flight claims and refuses; no row is lost
  U="00000000-0000-4000-8000-0000000000e5"
  for k in 1 2 3 4 5; do
    CK="acs_test.claim_p('op-c5-done-$k', 'tenant-e', 'done', 'user', '$U')"
    O="$(query "$DB" "select acs_test.claim($CK) ->> 'owner'")"
    query "$DB" "select acs_test.rpc('ai_calls_complete', acs_test.complete_p($CK, '$O', acs_test.fail_result($CK, 'PROVIDER_FAILED')))" >/dev/null
  done
  slow "$DB" insert 1
  CLAIM="select acs_test.try('ai_calls_claim', acs_test.claim_p('op-c5-new-{i}', 'tenant-e', 'new', 'user', '$U'))"
  ( run_parallel "$DB" 15 "$CLAIM" c5a ) &
  FIRST=$!
  sleep 0.3
  ( psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "$DB" -Atq -c "select acs_test.try('ai_calls_forget_user', jsonb_build_object('user_id', '$U'))" >"$WORK/c5f.1" 2>&1 ) &
  FORGET=$!
  run_parallel "$DB" 15 "${CLAIM//op-c5-new-/op-c5-late-}" c5b
  wait "$FIRST" "$FORGET"
  slow "$DB" off
  want "$(cat "$WORK"/c5a.* "$WORK"/c5b.* | grep -c '"kind": "acquired"')" 30 "C5: every new claim acquired"
  grep -q '"reason": "CALLS_IN_FLIGHT"' "$WORK/c5f.1" || fail "C5: forget did not wait for the in-flight claims: $(cat "$WORK/c5f.1")"
  want "$(query "$DB" "select count(*) || '/' || count(*) filter (where state = 'acquired') from ai_calls.consumer_calls where user_id = '$U'")" "35/30" "C5: every row kept"
  echo "PASS concurrency C5: forget_user during 15 in-flight claims of the user -> waited and refused ($(cat "$WORK/c5f.1")); nothing lost"
  drop_db "$DB"
fi

# ---- adverse role graphs: the migration refuses, atomically --------------------------------------------------------
refuse() {
  local name="$1" expect="$2" setup="$3" db before after out
  db="$(fresh_db "$name")"
  apply_ledger "$db"
  psql_super -d "$db" -c "$setup" >/dev/null
  before="$(digest "$db")"
  if out="$(psql_super -d "$db" -f "$MIGRATION" 2>&1)"; then fail "$name: migration applied on an unsafe role graph"; fi
  case "$out" in *"$expect"*) ;; *) fail "$name: wrong refusal: $out" ;; esac
  want "$(store_objects "$db")" 0 "$name: nothing left behind"
  after="$(digest "$db")"
  want "$after" "$before" "$name: catalog unchanged"
  drop_db "$db"
  reset_cluster_roles
  echo "PASS adverse: $name refused ($expect)"
}
if has_part adverse; then
  refuse member_of_owner AI_CALLS_ACL_UNSAFE_MEMBERSHIP "grant $SUPER to authenticated"
  refuse superuser_role AI_CALLS_ACL_UNSAFE_MEMBERSHIP "alter role anon superuser"
  refuse read_all_data AI_CALLS_ACL_EFFECTIVE_PRIVILEGE "grant pg_read_all_data to service_role"
  refuse write_all_data AI_CALLS_ACL_EFFECTIVE_PRIVILEGE "grant pg_write_all_data to anon"
  refuse inherit_service_role AI_CALLS_ACL_EFFECTIVE_PRIVILEGE "grant service_role to authenticated"
  refuse set_direct_service_role AI_CALLS_ACL_UNSAFE_ROLE_PATH "grant service_role to authenticated with inherit false, set true"
  refuse set_transitive AI_CALLS_ACL_UNSAFE_ROLE_PATH "create role acs_hop1 nologin; grant acs_hop1 to anon with inherit false, set true; grant service_role to acs_hop1 with inherit false, set true"
  refuse set_into_default_grant AI_CALLS_ACL_UNEXPECTED_RELATION_GRANT "create role acs_reader nologin; alter default privileges grant select on tables to acs_reader; grant acs_reader to authenticated with inherit false, set true"
fi

# ---- rollback and impact on existing structure ---------------------------------------------------------------------
if has_part rollback; then
  DB="$(fresh_db rollback supabase)"
  apply_ledger "$DB"
  psql_super -d "$DB" >/dev/null <<'SQL'
-- Stand-ins for what already exists in the project, plus live ledger rows.
create table public.profiles (id uuid primary key, name text);
alter table public.profiles enable row level security;
create policy own_profile on public.profiles for select to authenticated using (true);
create function public.existing_rpc(p jsonb) returns jsonb language sql security definer set search_path = '' as $$ select p $$;
revoke all on function public.existing_rpc(jsonb) from public, anon, authenticated;
grant execute on function public.existing_rpc(jsonb) to service_role;
insert into ai_ledger.budget_policies (policy_key, period, max_calls) values ('rollback.any', 'month', 10);
SQL
  query "$DB" "set role service_role; select public.ai_ledger_reserve('{\"request_id\": \"r-1\", \"attempt\": 1, \"provider\": \"anthropic\", \"model\": \"claude-haiku-5-5\", \"application\": \"postona\", \"feature\": \"consult\", \"logical_role\": \"p.c\", \"subject_kind\": \"system\", \"amount_usd\": 0.01}'::jsonb)" >/dev/null
  LEDGER_ROWS="select (select string_agg(x::text, '|' order by x.id) from ai_ledger.reservations x) || (select string_agg(x::text, '|' order by x.id) from ai_ledger.budget_buckets x)"
  ROWS_BEFORE="$(query "$DB" "$LEDGER_ROWS")"
  BEFORE="$(digest "$DB")"
  apply "$DB"
  want "$(digest "$DB")" "$BEFORE" "the ledger and every existing object untouched by the migration"
  want "$(query "$DB" "$LEDGER_ROWS")" "$ROWS_BEFORE" "ledger rows untouched by the migration"
  want "$(store_objects "$DB")" 6 "call-store objects present (schema + 5 RPCs)"
  psql_super -d "$DB" -f "$HERE/ai_consumer_call_store_rollback.sql" >/dev/null
  want "$(digest "$DB")" "$BEFORE" "rollback restores the catalog"
  want "$(store_objects "$DB")" 0 "rollback leaves no call-store object"
  want "$(query "$DB" "$LEDGER_ROWS")" "$ROWS_BEFORE" "ledger rows untouched by the rollback"
  drop_db "$DB"
  echo "PASS rollback: ledger and existing structure untouched; rollback script restores the exact catalog"
fi

# ---- legacy: the ledger's own suite with the call store present ----------------------------------------------------
if has_part legacy; then
  DB="$(fresh_db legacy)"
  apply_ledger "$DB"
  apply "$DB"
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_behavior.sql" >"$WORK/legacy.log"
  grep -q '^behaviour: all checks passed$' "$WORK/legacy.log" || { cat "$WORK/legacy.log" >&2; fail "legacy ledger behaviour"; }
  drop_db "$DB"
  echo "PASS legacy: the ledger's behaviour suite ($(grep -c '^\[' "$WORK/legacy.log") sections) passes unchanged with the call store applied"
fi

# ---- bridge: the real H5 bridge + ledger guard against both migrations (fake provider, psql adapters) ---------------
if has_part bridge; then
  DB="$(fresh_db bridge supabase)"
  apply_ledger "$DB"
  apply "$DB"
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_WEBHOOK_SIGNING_KEY \
      -u ANTHROPIC_CUSTOM_HEADERS -u OPENAI_API_KEY \
      ACS_PGHOST="$HOST" ACS_PGPORT="$PORT" ACS_PGSUPER="$SUPER" ACS_DB="$DB" \
    deno test --cached-only --frozen --config "$HERE/../functions/_shared/ai_consumer_bridge/deno.json" \
      --deny-net --deny-write --allow-run=psql \
      --allow-env=ACS_PGHOST,ACS_PGPORT,ACS_PGSUPER,ACS_DB,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_CUSTOM_HEADERS \
      "$HERE/ai_consumer_call_store_bridge_e2e_test.ts" >"$WORK/bridge.log" 2>&1 \
    || { cat "$WORK/bridge.log" >&2; fail "bridge e2e"; }
  if grep -q "[1-9][0-9]* ignored" "$WORK/bridge.log"; then cat "$WORK/bridge.log" >&2; fail "bridge e2e tests were ignored (environment not passed)"; fi
  grep -Eq '[1-9][0-9]* passed' "$WORK/bridge.log" || { cat "$WORK/bridge.log" >&2; fail "bridge e2e ran no test"; }
  drop_db "$DB"
  echo "PASS bridge: $(sed 's/\x1b\[[0-9;]*m//g' "$WORK/bridge.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1) (real H5 bridge + ledger guard -> SQL store and ledger)"
fi

echo "ALL REQUESTED PARTS PASSED: $PARTS"
