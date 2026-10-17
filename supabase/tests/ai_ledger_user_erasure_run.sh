#!/usr/bin/env bash
# Disposable-PostgreSQL proof of 20261017150000_ai_ledger_user_erasure.sql (on top of the AI ledger and the call
# store). Never touches Supabase.
#
#   ACS_PGHOST=/private/tmp/<socket dir> ACS_PGPORT=54912 ACS_PGSUPER=<superuser> bash supabase/tests/ai_ledger_user_erasure_run.sh
#
# Optional: AUE_MIGRATION=<file> runs everything against another copy (the mutation runner uses this);
#           AUE_PARTS="behaviour concurrency ..." runs only those parts.
#
# Parts:
#   isolation    the target is a local socket-only server (no TCP listener)
#   behaviour    preconditions (no call store / not the owner -> refused, nothing created), one-shot, behaviour file
#   supabase     Supabase-like default privileges are neutralised; behaviour holds
#   nonsuper     all three migrations applied by a non-superuser owner; behaviour holds
#   legacy       with the erasure applied: the ledger's own behaviour suite, the call store's behaviour suite and the
#                real H5 bridge end to end (PR249) still pass
#   concurrency  real parallel sessions: one user erased by 20 sessions, 20 users at once, a reservation and a claim
#                arriving during an erasure (held open by a test trigger)
#   adverse      unsafe role graphs / grants make the migration refuse atomically, catalog unchanged
#   rollback     the migration changes exactly two existing ledger facts; data untouched; the rollback restores the
#                exact catalog; an erasure done before the rollback stays done
#   preflight    the call-store rollback preflight refuses while protection is still needed (P3)
#   maintenance  the non-production maintenance mock (recover / abandon / purge), twice
#
# The host must be a local socket directory under /tmp. Scratch databases and roles are created and dropped.
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
STORE="$HERE/../migrations/20261017120000_ai_consumer_call_store.sql"
MIGRATION="${AUE_MIGRATION:-$HERE/../migrations/20261017150000_ai_ledger_user_erasure.sql}"
PARTS="${AUE_PARTS:-isolation behaviour supabase nonsuper legacy concurrency adverse rollback preflight maintenance}"
PREFIX="aue_proof_$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/aue_proof.XXXXXX")"

psql_super() { psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -v ON_ERROR_STOP=1 -q "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
want() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }
query() { psql_super -d "$1" -Atc "$2"; }

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
  foreach r in array array['aue_hop1', 'aue_owner', 'aue_other'] loop
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
for leftover in $(psql_super -d postgres -Atc "select datname from pg_database where datname like 'aue\\_proof\\_%'"); do
  psql_super -d postgres -c "drop database if exists $leftover" >/dev/null 2>&1 || true
done
reset_cluster_roles

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
base() { psql_super -d "$1" -f "$LEDGER" >/dev/null; psql_super -d "$1" -f "$STORE" >/dev/null; }
apply() { psql_super -d "$1" -f "$MIGRATION" >/dev/null; }
fixtures() {
  psql_super -d "$1" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$1" -f "$HERE/ai_consumer_call_store_fixture.sql" >/dev/null
  psql_super -d "$1" -f "$HERE/ai_ledger_user_erasure_fixture.sql" >/dev/null
}
facts() { psql_super -d "$1" -Atf "$HERE/ai_ledger_user_erasure_facts.sql"; }
new_objects() {
  query "$1" "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'public' and p.proname in ('ai_ledger_erase_user', 'ai_ledger_user_footprint', 'ai_calls_forget_system_brand', 'ai_calls_recovery_candidates')) or (n.nspname = 'ai_ledger' and p.proname in ('is_erased_subject', 'new_erased_subject', 'erasure_allows', 'usage_events_guard'))"
}
ledger_data() {
  query "$1" "select md5(coalesce((select string_agg(x::text, '|' order by x.id) from ai_ledger.reservations x), '') || coalesce((select string_agg(x::text, '|' order by x.id) from ai_ledger.usage_events x), '') || coalesce((select string_agg(x::text, '|' order by x.id) from ai_ledger.budget_buckets x), '') || coalesce((select string_agg(x::text, '|' order by x.id) from ai_ledger.budget_policies x), '') || coalesce((select string_agg(x::text, '|' order by x.call_key) from ai_calls.consumer_calls x), ''))"
}
has_part() { case " $PARTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---- isolation ---------------------------------------------------------------------------------------------------
if has_part isolation; then
  ISO="$(query postgres "select current_setting('listen_addresses') || '|' || coalesce(inet_server_addr()::text, 'unix-socket') || '|' || (select system_identifier from pg_control_system())")"
  case "$ISO" in "|unix-socket|"*) ;; *) fail "isolation: TCP listener or TCP connection ($ISO)" ;; esac
  echo "PASS isolation: listen_addresses='' (no TCP listener), reached over a unix socket, cluster ${ISO##*|}"
fi

# ---- behaviour -------------------------------------------------------------------------------------------------
if has_part behaviour; then
  DB="$(fresh_db nostore)"
  psql_super -d "$DB" -f "$LEDGER" >/dev/null
  BEFORE="$(facts "$DB")"
  if out="$(psql_super -d "$DB" -f "$MIGRATION" 2>&1)"; then fail "applied without the call store"; fi
  case "$out" in *AI_LEDGER_ERASURE_REQUIRES_LEDGER_AND_CALL_STORE*) ;; *) fail "no call store: wrong refusal: $out" ;; esac
  want "$(facts "$DB")" "$BEFORE" "no call store: catalog unchanged"
  drop_db "$DB"
  echo "PASS behaviour precondition: refused without the call store, nothing created"

  DB="$(fresh_db notowner)"
  base "$DB"
  psql_super -d "$DB" -c "create role aue_other nologin; grant create on database $DB to aue_other; grant create on schema public to aue_other" >/dev/null
  BEFORE="$(facts "$DB")"
  if out="$(psql_super -d "$DB" -c "set role aue_other" -f "$MIGRATION" 2>&1)"; then fail "applied by a role that does not own the ledger"; fi
  case "$out" in *AI_LEDGER_ERASURE_NOT_OWNER*) ;; *) fail "not owner: wrong refusal: $out" ;; esac
  want "$(facts "$DB")" "$BEFORE" "not owner: catalog unchanged"
  drop_db "$DB"
  reset_cluster_roles
  echo "PASS behaviour precondition: refused when the migrating role does not own ai_ledger / ai_calls"

  DB="$(fresh_db clean)"
  base "$DB"
  apply "$DB"
  BEFORE="$(facts "$DB")"
  if out="$(psql_super -d "$DB" -f "$MIGRATION" 2>&1)"; then fail "migration applied twice"; fi
  want "$(facts "$DB")" "$BEFORE" "a failed re-apply changed the catalog"
  echo "PASS behaviour one-shot: a second apply fails ($(printf '%s\n' "$out" | sed -n 's/.*ERROR: *//p' | head -1 | cut -c1-90)) and changes nothing"
  fixtures "$DB"
  psql_super -d "$DB" -f "$HERE/ai_ledger_user_erasure_behavior.sql"
  drop_db "$DB"
  echo "PASS behaviour"
fi

# ---- supabase-like default privileges ----------------------------------------------------------------------------
if has_part supabase; then
  DB="$(fresh_db supabase supabase)"
  base "$DB"; apply "$DB"; fixtures "$DB"
  psql_super -d "$DB" -f "$HERE/ai_ledger_user_erasure_behavior.sql" >/dev/null
  drop_db "$DB"
  echo "PASS supabase-like default privileges neutralised; behaviour holds"
fi

# ---- non-superuser owner -----------------------------------------------------------------------------------------
if has_part nonsuper; then
  DB="$(fresh_db nonsuper supabase)"
  psql_super -d "$DB" -c "create role aue_owner nologin; grant create on database $DB to aue_owner; grant create on schema public to aue_owner" >/dev/null
  for f in "$LEDGER" "$STORE" "$MIGRATION"; do psql_super -d "$DB" -c "set role aue_owner" -f "$f" >/dev/null; done
  want "$(query "$DB" "select pg_get_userbyid(proowner) from pg_proc where proname = 'ai_ledger_erase_user'")" aue_owner "nonsuper: owner"
  fixtures "$DB"
  psql_super -d "$DB" -f "$HERE/ai_ledger_user_erasure_behavior.sql" >/dev/null
  drop_db "$DB"
  reset_cluster_roles
  echo "PASS nonsuper: applied by a non-superuser owner; behaviour holds"
fi

# ---- legacy: the earlier suites with the erasure applied ---------------------------------------------------------
if has_part legacy; then
  DB="$(fresh_db legacy_ledger)"
  base "$DB"; apply "$DB"
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_behavior.sql" >"$WORK/legacy_ledger.log"
  grep -q '^behaviour: all checks passed$' "$WORK/legacy_ledger.log" || { cat "$WORK/legacy_ledger.log" >&2; fail "legacy ledger behaviour"; }
  drop_db "$DB"
  DB="$(fresh_db legacy_store)"
  base "$DB"; apply "$DB"
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_consumer_call_store_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_consumer_call_store_behavior.sql" >"$WORK/legacy_store.log"
  grep -q '^call store behaviour: all checks passed$' "$WORK/legacy_store.log" || { cat "$WORK/legacy_store.log" >&2; fail "legacy call-store behaviour"; }
  drop_db "$DB"
  DB="$(fresh_db legacy_bridge supabase)"
  base "$DB"; apply "$DB"
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u ANTHROPIC_WEBHOOK_SIGNING_KEY \
      -u ANTHROPIC_CUSTOM_HEADERS -u OPENAI_API_KEY \
      ACS_PGHOST="$HOST" ACS_PGPORT="$PORT" ACS_PGSUPER="$SUPER" ACS_DB="$DB" \
    deno test --cached-only --frozen --config "$HERE/../functions/_shared/ai_consumer_bridge/deno.json" \
      --deny-net --deny-write --allow-run=psql \
      --allow-env=ACS_PGHOST,ACS_PGPORT,ACS_PGSUPER,ACS_DB,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_CUSTOM_HEADERS \
      "$HERE/ai_consumer_call_store_bridge_e2e_test.ts" >"$WORK/legacy_bridge.log" 2>&1 \
    || { cat "$WORK/legacy_bridge.log" >&2; fail "legacy bridge e2e"; }
  if grep -q "[1-9][0-9]* ignored" "$WORK/legacy_bridge.log"; then cat "$WORK/legacy_bridge.log" >&2; fail "bridge e2e ignored"; fi
  drop_db "$DB"
  echo "PASS legacy: ledger behaviour ($(grep -c '^\[' "$WORK/legacy_ledger.log") sections), call-store behaviour ($(grep -c '^\[' "$WORK/legacy_store.log") sections), bridge e2e ($(sed 's/\x1b\[[0-9;]*m//g' "$WORK/legacy_bridge.log" | grep -Eo '[0-9]+ passed \| [0-9]+ failed' | tail -1)) with the erasure applied"
fi

# ---- concurrency -------------------------------------------------------------------------------------------------
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
slow() {
  query "$1" "set client_min_messages = warning; drop trigger if exists aue_slow on ai_ledger.usage_events" >/dev/null
  if [ "$2" != off ]; then
    query "$1" "update aue_test.knobs set delay_seconds = $2; create trigger aue_slow before update on ai_ledger.usage_events for each row execute function aue_test.slow()" >/dev/null
  fi
}
user_n() { printf '00000000-0000-4000-8000-%012d' "$1"; }

if has_part concurrency; then
  DB="$(fresh_db conc)"; base "$DB"; apply "$DB"; fixtures "$DB"
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls) values ('conc.consult.user', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 1000)" >/dev/null

  # E1. one user erased by 20 sessions at once: one does the work, the others find nothing; one erased subject
  U="$(user_n 1)"
  query "$DB" "select aue_test.seed_user('$U', 'conc-1')" >/dev/null
  TOTALS="$(query "$DB" "select aue_test.totals()")"
  run_parallel "$DB" 20 "select aue_test.try('ai_ledger_erase_user', jsonb_build_object('user_id', '$U'))" e1
  want "$(count_matching e1 '"reservations": 4')" 1 "E1: one session erased the 4 reservations"
  want "$(count_matching e1 '"reservations": 0')" 19 "E1: the others found nothing"
  want "$(count_matching e1 'ERR')$(count_matching e1 '^ERROR')" 00 "E1: errors"
  want "$(query "$DB" "select count(distinct user_id) from ai_ledger.reservations where request_id like 'h5m2_%' and user_id is not null and ai_ledger.is_erased_subject(user_id)")" 1 "E1: one erased subject"
  want "$(query "$DB" "select aue_test.totals()")" "$TOTALS" "E1: totals unchanged"
  echo "PASS concurrency E1: 20 concurrent erasures of one user -> one does it, 19 find nothing, one erased subject"

  # E2. 20 users erased at once: each only its own rows, 20 distinct erased subjects, totals unchanged
  for n in $(seq 11 30); do query "$DB" "select aue_test.seed_user('$(user_n "$n")', 'conc-$n')" >/dev/null; done
  TOTALS="$(query "$DB" "select aue_test.totals()")"
  run_parallel "$DB" 20 "select aue_test.try('ai_ledger_erase_user', jsonb_build_object('user_id', '00000000-0000-4000-8000-' || lpad(({i} + 10)::text, 12, '0')))" e2
  want "$(count_matching e2 '"reservations": 4')" 20 "E2: every user erased with its own 4 reservations"
  want "$(query "$DB" "select count(*) from ai_ledger.reservations where user_id::text like '00000000-0000-4000-8000-0000000000%' and right(user_id::text, 2)::int between 11 and 30")" 0 "E2: no real id left"
  want "$(query "$DB" "select count(distinct user_id) from ai_ledger.reservations where ai_ledger.is_erased_subject(user_id)")" 21 "E2: 20 new erased subjects (+1 from E1)"
  want "$(query "$DB" "select aue_test.totals()")" "$TOTALS" "E2: totals unchanged"
  echo "PASS concurrency E2: 20 users erased at once -> each only its own rows, 20 distinct erased subjects, totals unchanged"

  # E3. a reservation for the user arrives while the erasure is held open: it waits, the erasure completes, the
  #     late reservation is the only row left (the deletion read-back sees it; a second sweep finishes after it ends)
  U="$(user_n 41)"
  query "$DB" "select aue_test.seed_user('$U', 'conc-41')" >/dev/null
  slow "$DB" 0.5
  ( psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "$DB" -Atq -c "select aue_test.try('ai_ledger_erase_user', jsonb_build_object('user_id', '$U'))" >"$WORK/e3erase.1" 2>&1 ) &
  ERASE=$!
  sleep 0.3
  query "$DB" "select ail_test.reserve(aue_test.request('conc-41-late'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', '$U', null, 0.0044) ->> 'allowed'" >"$WORK/e3reserve.1"
  wait "$ERASE"
  slow "$DB" off
  grep -q '"erased": true' "$WORK/e3erase.1" || fail "E3: the erasure did not complete: $(cat "$WORK/e3erase.1")"
  want "$(cat "$WORK/e3reserve.1")" true "E3: the late reservation went through after the erasure"
  want "$(query "$DB" "select aue_test.footprint('$U') ->> 'reservations'")" 1 "E3: the read-back sees exactly the late reservation"
  query "$DB" "select ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', (select id from ai_ledger.reservations where request_id = aue_test.request('conc-41-late'))))" >/dev/null
  want "$(query "$DB" "select aue_test.erase('$U') ->> 'reservations'")" 1 "E3: the second sweep erases it"
  echo "PASS concurrency E3: a reservation during the erasure waits for it; read-back + second sweep clear it"

  # E4. a claim of the user arrives while the erasure is held open: it waits for the user lock, then lands; the
  #     read-back sees it and the erasure refuses until the call store forgets it
  U="$(user_n 42)"
  query "$DB" "select aue_test.seed_user('$U', 'conc-42')" >/dev/null
  slow "$DB" 0.5
  ( psql -X -h "$HOST" -p "$PORT" -U "$SUPER" -d "$DB" -Atq -c "select aue_test.try('ai_ledger_erase_user', jsonb_build_object('user_id', '$U'))" >"$WORK/e4erase.1" 2>&1 ) &
  ERASE=$!
  sleep 0.3
  query "$DB" "select acs_test.claim(acs_test.claim_p('op-conc-42', 'tenant-42', 'x', 'user', '$U')) ->> 'kind'" >"$WORK/e4claim.1"
  wait "$ERASE"
  slow "$DB" off
  grep -q '"erased": true' "$WORK/e4erase.1" || fail "E4: the erasure did not complete: $(cat "$WORK/e4erase.1")"
  want "$(cat "$WORK/e4claim.1")" acquired "E4: the claim landed after the erasure"
  want "$(query "$DB" "select aue_test.footprint('$U') ->> 'call_rows'")" 1 "E4: the read-back sees the claim"
  want "$(query "$DB" "select aue_test.erase('$U') ->> 'reason'")" CALL_STORE_NOT_FORGOTTEN "E4: the next sweep waits for the call store"
  echo "PASS concurrency E4: a claim during the erasure waits for the user lock; read-back sees it; the sweep refuses until forgotten"
  drop_db "$DB"
fi

# ---- adverse -----------------------------------------------------------------------------------------------------
refuse() {
  local name="$1" expect="$2" setup="$3" db before out
  db="$(fresh_db "$name")"
  base "$db"
  psql_super -d "$db" -c "$setup" >/dev/null
  before="$(facts "$db")"
  if out="$(psql_super -d "$db" -f "$MIGRATION" 2>&1)"; then fail "$name: migration applied on an unsafe graph"; fi
  case "$out" in *"$expect"*) ;; *) fail "$name: wrong refusal: $out" ;; esac
  want "$(new_objects "$db")" 0 "$name: nothing left behind"
  want "$(facts "$db")" "$before" "$name: catalog unchanged"
  drop_db "$db"
  reset_cluster_roles
  echo "PASS adverse: $name refused ($expect)"
}
if has_part adverse; then
  refuse member_of_owner AI_LEDGER_ERASURE_ACL_UNSAFE_MEMBERSHIP "grant $SUPER to authenticated"
  refuse read_all_data AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE "grant pg_read_all_data to service_role"
  refuse inherit_service_role AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE "grant service_role to authenticated"
  refuse set_direct_service_role AI_LEDGER_ERASURE_ACL_UNSAFE_ROLE_PATH "grant service_role to anon with inherit false, set true"
  refuse set_transitive AI_LEDGER_ERASURE_ACL_UNSAFE_ROLE_PATH "create role aue_hop1 nologin; grant aue_hop1 to authenticated with inherit false, set true; grant service_role to aue_hop1 with inherit false, set true"
  refuse helper_grant AI_LEDGER_ERASURE_ACL_UNEXPECTED_HELPER_GRANT "grant execute on function ai_ledger.reject_change() to anon"
  refuse call_store_grant AI_LEDGER_ERASURE_ACL_UNEXPECTED_RELATION_GRANT "grant select on ai_calls.consumer_calls to service_role"
fi

# ---- rollback ----------------------------------------------------------------------------------------------------
if has_part rollback; then
  DB="$(fresh_db rollback supabase)"
  base "$DB"
  psql_super -d "$DB" -f "$HERE/ai_provider_budget_ledger_fixture.sql" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_consumer_call_store_fixture.sql" >/dev/null
  query "$DB" "insert into ai_ledger.budget_policies (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls) values ('rb.consult.user', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 1000)" >/dev/null
  query "$DB" "do \$\$ declare r jsonb; begin r := ail_test.reserve('h5m2_' || acs_test.hex('rb-1'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', '$(user_n 51)', null, 0.0044); perform ail_test.mark_sent(r); perform ail_test.settle_measured(r, 0.001, 10, 5); end \$\$" >/dev/null
  facts "$DB" >"$WORK/facts_before"
  DATA_BEFORE="$(ledger_data "$DB")"
  apply "$DB"
  facts "$DB" >"$WORK/facts_after"
  CHANGED="$(comm -3 "$WORK/facts_before" "$WORK/facts_after" | sed 's/^[[:space:]]*//' | cut -d'|' -f1,2 | sort | uniq -c | awk '{print $1 " " $2}' | sort | tr '\n' ';')"
  want "$CHANGED" "2 fn|ai_ledger.reservation_transition();2 trg|ai_ledger.usage_events.usage_events_append_only;" "the migration changes exactly the two ledger facts of the exception"
  want "$(ledger_data "$DB")" "$DATA_BEFORE" "data untouched by the migration"
  want "$(new_objects "$DB")" 8 "four RPCs + four helpers present"
  psql_super -d "$DB" -f "$HERE/ai_ledger_user_erasure_fixture.sql" >/dev/null
  want "$(query "$DB" "select aue_test.erase('$(user_n 51)') ->> 'reservations'")" 1 "erase before the rollback"
  DATA_ERASED="$(ledger_data "$DB")"
  psql_super -d "$DB" -c "set client_min_messages = warning" -c "drop schema aue_test cascade" >/dev/null
  psql_super -d "$DB" -f "$HERE/ai_ledger_user_erasure_rollback.sql" >/dev/null
  facts "$DB" >"$WORK/facts_rolled_back"
  cmp -s "$WORK/facts_before" "$WORK/facts_rolled_back" || { comm -3 "$WORK/facts_before" "$WORK/facts_rolled_back" >&2; fail "rollback does not restore the exact catalog"; }
  want "$(new_objects "$DB")" 0 "rollback leaves no new object"
  want "$(ledger_data "$DB")" "$DATA_ERASED" "the erasure stays done after the rollback"
  if out="$(query "$DB" "select set_config('ai_ledger.erasure', 'x', true); update ai_ledger.reservations set user_id = '$(user_n 52)'" 2>&1)"; then fail "rollback: the exception survived"; fi
  case "$out" in *AI_LEDGER_RESERVATION_IMMUTABLE*) ;; *) fail "rollback: wrong error: $out" ;; esac
  drop_db "$DB"
  echo "PASS rollback: exactly 2 existing ledger facts change (reservation trigger function, usage-events trigger); data untouched; rollback restores the exact catalog; an erasure done before it stays done"
fi

# ---- preflight (P3): the call-store rollback preflight ---------------------------------------------------------------
if has_part preflight; then
  DB="$(fresh_db preflight)"; base "$DB"; apply "$DB"; fixtures "$DB"
  run_preflight() { psql_super -d "$DB" -v min_age_hours="$1" -f "$HERE/ai_consumer_call_store_rollback_preflight.sql" 2>&1; }
  want "$(run_preflight 24 | grep -c ACS_ROLLBACK_PREFLIGHT_OK)" 1 "preflight: empty store is OK"
  C="acs_test.claim_p('op-pf', 'tenant-pf', 'x')"
  OWNER="$(query "$DB" "select acs_test.claim($C) ->> 'owner'")"
  if out="$(run_preflight 24)"; then fail "preflight: passed with an acquired claim"; fi
  case "$out" in *"ACS_ROLLBACK_BLOCKED: 1 acquired"*) ;; *) fail "preflight acquired: $out" ;; esac
  query "$DB" "select acs_test.rpc('ai_calls_complete', acs_test.complete_p($C, '$OWNER', acs_test.fail_result($C, 'PROVIDER_FAILED')))" >/dev/null
  if out="$(run_preflight 24)"; then fail "preflight: passed with a recent row"; fi
  case "$out" in *"0 acquired, 1 younger than 24 h"*) ;; *) fail "preflight recent: $out" ;; esac
  query "$DB" "select acs_test.backdate($C, interval '25 hours')" >/dev/null
  want "$(run_preflight 24 | grep -c 'ACS_ROLLBACK_PREFLIGHT_OK: 1 rows')" 1 "preflight: old rows only -> OK"
  if out="$(run_preflight 0)"; then fail "preflight: a zero window was accepted"; fi
  want "$(query "$DB" "select count(*) from ai_calls.consumer_calls")" 1 "preflight changes nothing"
  drop_db "$DB"
  echo "PASS preflight: the call-store rollback is refused while a claim is in flight or a row is younger than the window"
fi

# ---- maintenance mock --------------------------------------------------------------------------------------------
if has_part maintenance; then
  DB="$(fresh_db maint supabase)"; base "$DB"; apply "$DB"; fixtures "$DB"
  ACS_PGHOST="$HOST" ACS_PGPORT="$PORT" ACS_PGSUPER="$SUPER" ACS_DB="$DB" \
    deno test --no-config --deny-net --deny-write --allow-run=psql --allow-env=ACS_PGHOST,ACS_PGPORT,ACS_PGSUPER,ACS_DB \
      "$HERE/ai_call_store_maintenance_mock_test.ts" >"$WORK/maint.log" 2>&1 \
    || { cat "$WORK/maint.log" >&2; fail "maintenance mock"; }
  if grep -q "[1-9][0-9]* ignored" "$WORK/maint.log"; then cat "$WORK/maint.log" >&2; fail "maintenance mock ignored"; fi
  grep -Eq '1 passed' "$WORK/maint.log" || { cat "$WORK/maint.log" >&2; fail "maintenance mock ran no test"; }
  drop_db "$DB"
  echo "PASS maintenance: recover -> abandon (ledger-consistent audits) -> purge; unregistered and in-grace claims left; second tick changes nothing"
fi

echo "ALL REQUESTED PARTS PASSED: $PARTS"
