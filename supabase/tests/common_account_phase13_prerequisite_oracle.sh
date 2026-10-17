#!/usr/bin/env bash
# F5 Phase 13: which objects of the MODEL baseline does the ten-file chain need at APPLY time? (an empirical oracle)
#
# The Phase 11/12 baseline contract was extracted from the Phase 1 preflight only (17 relations, 26 columns, 14 foreign keys,
# 2 functions). A later chain file can need more. This script asks the question directly, on a THROW-AWAY LOCAL database
# with fake data: take the Phase 11 model baseline (fixtures + the three real prerequisite migrations, NO chain file), remove
# ONE object (a function, a table that is not one of the 17, a trigger, a non-required column of a required table) in a
# fresh copy, apply P1..P10 in release order, and record the first refusal. An object whose removal makes a chain file
# refuse is a prerequisite the contract must cover; one whose removal changes nothing is not needed AT APPLY TIME.
#
# What it can NOT see (stated, not hidden): runtime dependencies of plpgsql bodies (late bound), the TYPE / nullability /
# default of an object that is present, objects that cannot be dropped alone (they have dependents: listed, "not tested"),
# and anything about the real production catalog (never read). Output: one TSV line per candidate on stdout:
#   kind <TAB> object <TAB> dropped|blocked:<why> <TAB> OK | FAIL <chain id> <first refusal> | (not tested)
# Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase13_prerequisite_oracle.sh > oracle.tsv
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"; provenance="$repo/supabase/preflight/managed_disposable/baseline_provenance.json"
n="$$"; owner="kb_p13_owner_$n"; prefix="kabumori_p13_$n"; base="${prefix}_base"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
}
trap cleanup EXIT
CHAIN_IDS=(P1 P2 P3a P3b P4 P5 P6 P8 P9 P10)
CHAIN_FILES=(20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent
  20261009120000_common_account_deletion_completion 20261010051938_common_account_service_write_guard
  20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state
  20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts
  20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record)

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
create database $base owner $owner;
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
own "$base" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$base" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own "$base" -f "$m/$f" >/dev/null; done
own "$base" -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
own "$base" -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
# GoTrue's own auth.sessions (a managed project has it before any chain file)
own "$base" -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null

apply_chain() { # database -> "OK" | "FAIL <id> <first refusal>"
  local db="$1" i out
  for i in "${!CHAIN_FILES[@]}"; do
    out="$(own "$db" -f "$m/${CHAIN_FILES[$i]}.sql" 2>&1 >/dev/null)" || {
      echo "FAIL ${CHAIN_IDS[$i]} $(printf '%s\n' "$out" | grep -m1 'ERROR' | sed 's/^.*ERROR:  *//' | cut -c1-150)"; return 0; }
  done
  echo OK
}
case_n=0
run_case() { # kind object dropsql
  case_n=$((case_n + 1)); local db="${prefix}_c${case_n}" dropped res why
  "${S[@]}" -d postgres -c "create database $db template $base owner $owner" >/dev/null
  if why="$(own "$db" -c "$3" 2>&1 >/dev/null)"; then dropped=dropped; res="$(apply_chain "$db")"
  else dropped="blocked:$(printf '%s\n' "$why" | head -1 | sed 's/^.*ERROR:  *//' | cut -c1-70)"; res="(not tested)"; fi
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$dropped" "$res"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
}

# control: the unmodified baseline must accept the whole chain
control_db="${prefix}_control"
"${S[@]}" -d postgres -c "create database $control_db template $base owner $owner" >/dev/null
printf 'control\t(none)\tunchanged\t%s\n' "$(apply_chain "$control_db")"

Q() { "${S[@]}" -F '|' -d "$base" -c "$1"; }
while IFS= read -r sig; do run_case function "$sig" "drop function $sig"; done < <(Q "select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f' order by 1")
required_tables="$(python3 -c "import json;print('|'.join(r for r in json.load(open('$provenance'))['requirements']['relations'] if r.startswith('public.')))")"
while IFS= read -r rel; do
  case "|$required_tables|" in *"|$rel|"*) ;; *) run_case table "$rel" "drop table $rel" ;; esac
done < <(Q "select n.nspname||'.'||c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname='public' order by 1")
while IFS='|' read -r rel trg; do run_case trigger "$rel.$trg" "drop trigger $trg on $rel"; done < <(Q "select n.nspname||'.'||c.relname, t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','private') order by 1,2")
# non-required columns of the required public tables (the contract's own columns and foreign-key columns are not candidates)
in_list() { case "|$2|" in *"|$1|"*) return 0 ;; *) return 1 ;; esac; }
needed_file="$(mktemp "${TMPDIR:-/tmp}/p13_needed.XXXXXX")"
python3 - "$provenance" > "$needed_file" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))['requirements']
need = {(c['relation'], c['column']) for c in d['columns']}
for fk in d['foreignKeys']:
    need |= {(fk['relation'], c) for c in fk['columns']} | {(fk['references'], c) for c in fk['referencedColumns']}
for rel, col in sorted(need): print(f'{rel}|{col}')
PY
while IFS='|' read -r rel col; do
  in_list "$rel" "$required_tables" || continue
  grep -qx "$rel|$col" "$needed_file" && continue
  run_case column "$rel.$col" "alter table $rel drop column $col"
done < <(Q "select n.nspname||'.'||c.relname, a.attname from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where a.attnum>0 and not a.attisdropped and n.nspname='public' and c.relkind='r' order by 1,2")
rm -f "$needed_file"
