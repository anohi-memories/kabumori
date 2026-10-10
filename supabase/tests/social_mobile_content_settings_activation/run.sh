#!/usr/bin/env bash
# POSTONA AI consultation V1 activation runner (G3, 2026-10-10).
#
#   s0        read-only production preflight (catalog, Edge function list, secret names)
#   activate  S0 again -> S1 both migrations + 2 history rows in ONE transaction -> S2 catalog read-back
#             -> S3 deploy social-mobile-consult -> S4 deploy social-mobile-brand-dry-run
#             -> byte-compare both deployed bundles with this checkout -> function list read-back.
#             Every stage gates the next; the first STOP ends the run. Nothing is retried or repaired.
#   s5        smoke with ONE test account (smoke.py) between two read-only snapshots; no posts
#   proof     disposable LOCAL PostgreSQL rehearsal of S0/S1/S2 (and of the failure paths); with
#             --write-expected it (re)generates expected_readback.json from the reviewed migrations.
#
# Production connection: session pooler, role postgres (the role that owns public.brands). The DB password
# is asked once per run, kept in a non-exported shell variable and handed only to psql's environment. No
# password, token, key or secret value is written to disk, printed or passed as an argument.
# Outputs (catalog JSON, function lists, logs) go to $ACT_OUT, which must be set.
#
# Exit codes: 0 PASS, 2 refused, 10 STOP at S0, 11 STOP S1 failed and rolled back (verified absent),
# 12 STOP S1 outcome unknown, 13 STOP S2 mismatch (schema committed; nothing deployed),
# 14 STOP Edge deploy failed, 15 STOP deployed bundle / function read-back mismatch, 16 STOP S5 smoke.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
REF="wsmznyzcvmuitkglfeuj"
CANDIDATE="$REPO/supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql"
HARDENING="$REPO/supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql"
CANDIDATE_SHA256="b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb"
HARDENING_SHA256="83d44ccfd51bcd8fcd78d31236fa52d1d8f90c6642f12c5bb1586f9d1497467e"
FUNCTIONS="social-mobile-consult social-mobile-brand-dry-run"

say() { printf '%s\n' "$*"; }
stop() { say "STOP[$1] $2"; exit "$1"; }
refuse() { say "REFUSED $1" >&2; exit 2; }

[[ -n "${ACT_OUT:-}" ]] || refuse "set ACT_OUT to an output directory"
mkdir -p "$ACT_OUT"
TARGET="${ACT_TARGET:-production}"

sha() { shasum -a 256 "$1" | awk '{print $1}'; }
[[ "$(sha "$CANDIDATE")" == "$CANDIDATE_SHA256" ]] || refuse "candidate migration bytes differ from the reviewed source"
[[ "$(sha "$HARDENING")" == "$HARDENING_SHA256" ]] || refuse "hardening migration bytes differ from the reviewed source"

# ------------------------------------------------------------------------------------------ target
PW=""
if [[ "$TARGET" == production ]]; then
  [[ -z "${ACT_TEST_FAIL_S1:-}" && -z "${ACT_LOCAL_REHEARSAL:-}" ]] || refuse "test hooks are local-only"
  export PGHOST="${ACT_PGHOST:-aws-0-ap-northeast-1.pooler.supabase.com}" PGPORT=5432 \
         PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
  APPLIER=postgres
elif [[ "$TARGET" == local ]]; then
  case "${PGHOST:-}" in /private/tmp/*|/tmp/*) ;; *) refuse "local target needs a /tmp socket PGHOST";; esac
  [[ -n "${PGUSER:-}" && -n "${PGDATABASE:-}" ]] || refuse "local target needs PGUSER and PGDATABASE"
  APPLIER="$PGUSER"
else
  refuse "ACT_TARGET must be production or local"
fi

ask_password() {
  [[ "$TARGET" == production ]] || return 0
  read -r -s -p "Supabase DB password (input hidden): " PW </dev/tty
  printf '\n'
  [[ -n "$PW" ]] || refuse "empty password"
}

pq() { PGPASSWORD="$PW" psql -X -q -v ON_ERROR_STOP=1 "$@"; }
readonly_json() { pq -A -t -c "begin transaction read only" -f "$1" -c "rollback"; }

# ------------------------------------------------------------------------------------------- stages
stage_s0() {
  say "== S0 read-only preflight ($TARGET)"
  readonly_json "$HERE/preflight.sql" > "$ACT_OUT/s0_preflight.json" || stop 10 "preflight query failed"
  python3 "$HERE/check.py" s0 "$ACT_OUT/s0_preflight.json" "$APPLIER" || stop 10 "preflight gate"
  if [[ "$TARGET" == production || -n "${ACT_LOCAL_REHEARSAL:-}" ]]; then
    supabase functions list --project-ref "$REF" --output-format json > "$ACT_OUT/s0_functions.json" 2> "$ACT_OUT/s0_functions.err" \
      || stop 10 "function list failed (see s0_functions.err)"
    python3 "$HERE/check.py" functions-pre "$ACT_OUT/s0_functions.json" || stop 10 "function gate"
    # Secret names only: the JSON (with digests) is piped straight into the checker and never stored.
    supabase secrets list --project-ref "$REF" --output-format json 2> "$ACT_OUT/s0_secrets.err" \
      | python3 "$HERE/check.py" secret-names || stop 10 "secret gate"
  fi
}

target_absent() {
  local state
  state="$(pq -A -t -c "begin transaction read only" \
    -c "select (to_regclass('public.social_mobile_content_settings') is null)::text || ',' ||
               (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                  and proname like 'social\_mobile\_content\_settings\_%')::text || ',' ||
               (select count(*) from supabase_migrations.schema_migrations
                  where version in ('20260922045046', '20261003120000'))::text" -c "rollback")" || return 2
  [[ "$state" == "true,0,0" ]]
}

stage_s1() {
  say "== S1 apply both migrations + 2 history rows in one transaction ($TARGET)"
  local hook=()
  if [[ -n "${ACT_TEST_FAIL_S1:-}" ]]; then hook=(-c "select 1/0"); fi
  set +e
  pq --single-transaction \
    -c "set local lock_timeout = '5s'" \
    -c "set local statement_timeout = '120s'" \
    -f "$HERE/apply_guard_pre.sql" \
    -f "$CANDIDATE" \
    ${hook[@]+"${hook[@]}"} \
    -f "$HARDENING" \
    -c "insert into supabase_migrations.schema_migrations (version, name) values
          ('20260922045046', 'social_mobile_content_settings_candidate'),
          ('20261003120000', 'social_mobile_content_settings_hardening')" \
    -f "$HERE/apply_guard_post.sql" > "$ACT_OUT/s1_apply.log" 2>&1
  local rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    tail -n 5 "$ACT_OUT/s1_apply.log"
    if target_absent; then stop 11 "S1 failed and rolled back: table, functions and history rows are absent"; fi
    stop 12 "S1 failed and the target state could not be confirmed absent; do not retry"
  fi
  say "S1 committed"
}

stage_s2() {
  say "== S2 catalog read-back ($TARGET)"
  readonly_json "$HERE/readback.sql" > "$ACT_OUT/s2_readback.json" || stop 13 "read-back query failed"
  python3 "$HERE/check.py" s2 "$ACT_OUT/s2_readback.json" "$HERE/expected_readback.json" || stop 13 "read-back gate (schema is committed; nothing deployed)"
}

stage_edge() {
  say "== S3/S4 deploy Edge Functions from $REPO"
  # The CLI resolves its project root from the working directory; deploy from this checkout with its own
  # (untracked) config that keeps JWT verification on for both functions.
  if [[ ! -f "$REPO/supabase/config.toml" ]]; then
    printf '%s\n' "project_id = \"$REF\"" "" "[functions.social-mobile-consult]" "verify_jwt = true" "" \
      "[functions.social-mobile-brand-dry-run]" "verify_jwt = true" > "$REPO/supabase/config.toml"
  fi
  grep -q "^project_id = \"$REF\"" "$REPO/supabase/config.toml" || stop 14 "supabase/config.toml points at another project"
  local fn
  for fn in $FUNCTIONS; do
    say "-- deploy $fn"
    (cd "$REPO" && supabase functions deploy "$fn" --project-ref "$REF" --use-api) > "$ACT_OUT/deploy_$fn.log" 2>&1 \
      || { tail -n 5 "$ACT_OUT/deploy_$fn.log"; stop 14 "deploy of $fn failed"; }
  done
  say "== read back deployed bundles"
  for fn in $FUNCTIONS; do
    rm -rf "$ACT_OUT/dl-$fn"; mkdir -p "$ACT_OUT/dl-$fn/supabase"
    printf 'project_id = "%s"\n' "$REF" > "$ACT_OUT/dl-$fn/supabase/config.toml"
    supabase functions download "$fn" --project-ref "$REF" --use-api --workdir "$ACT_OUT/dl-$fn" > "$ACT_OUT/download_$fn.log" 2>&1 \
      || stop 15 "download of $fn failed"
    python3 "$HERE/check.py" bundle "$ACT_OUT/dl-$fn" "$REPO" "$fn" || stop 15 "deployed $fn differs from this checkout"
  done
  supabase functions list --project-ref "$REF" --output-format json > "$ACT_OUT/s4_functions.json" 2> "$ACT_OUT/s4_functions.err" \
    || stop 15 "function list failed"
  python3 "$HERE/check.py" functions-post "$ACT_OUT/s0_functions.json" "$ACT_OUT/s4_functions.json" || stop 15 "function read-back gate"
}

stage_s5() {
  say "== S5 smoke with one test account (no posts)"
  [[ -f "$ACT_OUT/s4_functions.json" ]] || refuse "run activate first (s4_functions.json missing in ACT_OUT)"
  readonly_json "$HERE/snapshot.sql" > "$ACT_OUT/s5_before.json" || stop 16 "snapshot before failed"
  set +e
  python3 "$HERE/smoke.py" "$ACT_OUT"
  local rc=$?
  set -e
  readonly_json "$HERE/snapshot.sql" > "$ACT_OUT/s5_after.json" || stop 16 "snapshot after failed"
  supabase functions list --project-ref "$REF" --output-format json > "$ACT_OUT/s5_functions.json" 2> "$ACT_OUT/s5_functions.err" \
    || stop 16 "function list failed"
  python3 "$HERE/check.py" s5 "$ACT_OUT/s5_before.json" "$ACT_OUT/s5_after.json" "$ACT_OUT/s4_functions.json" "$ACT_OUT/s5_functions.json" \
    || stop 16 "no-side-effect gate"
  [[ $rc -eq 0 ]] || stop 16 "smoke step failed (see s5_smoke.json)"
}

# -------------------------------------------------------------------------------------------- proof
proof() {
  [[ "$TARGET" == local ]] || refuse "proof runs only against ACT_TARGET=local"
  [[ -n "${ACT_PGSUPER:-}" ]] || refuse "proof needs ACT_PGSUPER (local superuser)"
  local owner="$PGUSER" base="$PGDATABASE" db
  sup() { psql -X -q -v ON_ERROR_STOP=1 -U "$ACT_PGSUPER" "$@"; }
  sup -d postgres -c "do \$\$ begin
      if not exists (select 1 from pg_roles where rolname = '$owner') then execute 'create role $owner login'; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end \$\$" >/dev/null
  new_db() {
    db="${base}_$1"
    sup -d postgres -c "drop database if exists $db with (force)" -c "create database $db owner $owner" >/dev/null
    # Production has an event trigger that enables RLS on every new public table.
    sup -d "$db" -c "create function public.rls_auto_enable() returns event_trigger language plpgsql as \$\$
        declare r record; begin
          for r in select * from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' and schema_name = 'public' loop
            execute format('alter table %s enable row level security', r.object_identity);
          end loop; end \$\$" \
      -c "create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable()" >/dev/null
    PGDATABASE="$db" pq -f "$REPO/supabase/tests/social_mobile_content_settings_fixture.sql" \
      -c "create schema supabase_migrations" \
      -c "create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text,
            created_by text, idempotency_key text, rollback text[])" \
      -c "insert into supabase_migrations.schema_migrations (version, name) values ('20261003090000', 'publish_permission_boundary')" >/dev/null
  }

  new_db ok
  PGDATABASE="$db" stage_s0
  PGDATABASE="$db" stage_s1
  if [[ "${1:-}" == "--write-expected" ]]; then
    PGDATABASE="$db" readonly_json "$HERE/readback.sql" > "$HERE/expected_readback.json"
    python3 -c "import json,sys; v=json.load(open(sys.argv[1])); v=v.get('readback',v); v.pop('history',None); json.dump(v, open(sys.argv[1],'w'), ensure_ascii=False, indent=1, sort_keys=True)" "$HERE/expected_readback.json"
    say "wrote expected_readback.json"
  fi
  PGDATABASE="$db" stage_s2
  say "PROOF_HEALTHY_PASS"
  # A second S0 on the applied database must refuse.
  if (PGDATABASE="$db" stage_s0) > "$ACT_OUT/proof_s0_again.log" 2>&1; then stop 1 "S0 did not refuse an applied database"; fi
  grep -q "already exists" "$ACT_OUT/proof_s0_again.log" || stop 1 "S0 refused for an unexpected reason"
  say "PROOF_S0_REFUSES_APPLIED_PASS"
  # A failure between the two files rolls everything back (no weak candidate, no history row).
  new_db fail
  set +e; (PGDATABASE="$db" ACT_TEST_FAIL_S1=1 stage_s1) > "$ACT_OUT/proof_fail.log" 2>&1; local rc=$?; set -e
  [[ $rc -eq 11 ]] || { cat "$ACT_OUT/proof_fail.log"; stop 1 "failure path exit $rc (expected 11)"; }
  say "PROOF_ATOMIC_ROLLBACK_PASS"
  sup -d postgres -c "drop database if exists ${base}_ok with (force)" -c "drop database if exists ${base}_fail with (force)" >/dev/null
  say "PROOF_ALL_PASS"
}

# --------------------------------------------------------------------------------------------- main
case "${1:-}" in
  s0)
    ask_password
    stage_s0
    say "S0_PASS (read-only; nothing was changed)"
    ;;
  activate)
    # Locally only as a rehearsal with a fake `supabase` CLI on PATH (ACT_LOCAL_REHEARSAL=1).
    [[ "$TARGET" == production || -n "${ACT_LOCAL_REHEARSAL:-}" ]] || refuse "activate is production-only; use proof locally"
    ask_password
    if [[ "$TARGET" == production ]]; then
      read -r -p "Type APPLY to run S0 -> S1 -> S2 -> S3 -> S4 on production: " confirm </dev/tty
      [[ "$confirm" == APPLY ]] || refuse "not confirmed"
    fi
    stage_s0
    stage_s1
    stage_s2
    stage_edge
    say "ACTIVATION_S0_S4_PASS"
    ;;
  s5)
    [[ "$TARGET" == production ]] || refuse "s5 is production-only"
    ask_password
    stage_s5
    say "S5_PASS"
    ;;
  proof)
    shift
    proof "${1:-}"
    ;;
  *)
    refuse "usage: run.sh s0 | activate | s5 | proof [--write-expected]"
    ;;
esac
