#!/usr/bin/env bash
# F5 Phase 13 (D-3): what a CONNECT-only login can and cannot do for the baseline export (PG2a / PG2b), on a THROW-AWAY LOCAL
# PostgreSQL 17 with FAKE data. It exists because the Phase 13 plan said "pg_dump --schema-only by a login that can CONNECT and nothing else":
# pg_dump takes an ACCESS SHARE lock on every table it dumps, and that lock needs SELECT. Findings asserted here:
#   (a) the CONNECT-only login reads catalog definitions (what the pinned inventory query needs), and cannot read a row;
#   (b) pg_dump --schema-only by that login FAILS with "permission denied for table";
#   (c) a login that holds SELECT on the table can run pg_dump --schema-only, and the dump carries the definition and no row;
#   (d) a catalog-only DDL query (pg_get_constraintdef / pg_get_indexdef / pg_attribute) works for the CONNECT-only login.
# No production schema, no managed project, no credential, no network. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_phase13_d3_dump_privilege.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
n="$$"; db="kabumori_p13d3_dump_$n"; connect_only="kb_p13d3_connect_$n"; reader="kb_p13d3_reader_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
fails=0
say() { echo "D3_DUMP_PRIVILEGE|$1|$2${3:+|$3}"; if [ "$2" != PASS ]; then fails=$((fails + 1)); fi; }
cleanup() {
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $connect_only" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $reader" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${S[@]}" -d postgres -c "create role $connect_only login" -c "create role $reader login" -c "create database $db" >/dev/null
"${S[@]}" -d "$db" >/dev/null <<SQL
create table public.d3_fake(id int primary key, note text not null default 'fake-row-value');
create index d3_fake_note_idx on public.d3_fake (note);
insert into public.d3_fake values (1, 'fake-row-value-1');
revoke all on schema public from public;
grant usage on schema public to $connect_only, $reader;
revoke all on all tables in schema public from public;
grant connect on database $db to $connect_only, $reader;
grant select on public.d3_fake to $reader;
SQL

as_login() { local login="$1"; shift; psql -X -q -A -t -h "$host" -p "$port" -U "$login" -d "$db" "$@"; }

# (a) catalog definitions are readable, rows are not
defs="$(as_login "$connect_only" -c "select pg_get_indexdef('public.d3_fake_note_idx'::regclass)" -c "select count(*) from pg_attribute where attrelid = 'public.d3_fake'::regclass and attnum > 0" 2>&1 || true)"
case "$defs" in *"CREATE INDEX d3_fake_note_idx"*) say a_catalog_definition_readable PASS ;; *) say a_catalog_definition_readable FAIL ;; esac
row="$(as_login "$connect_only" -c "select count(*) from public.d3_fake" 2>&1 || true)"
case "$row" in *"permission denied"*) say a_row_not_readable PASS ;; *) say a_row_not_readable FAIL ;; esac

# (b) pg_dump --schema-only by the CONNECT-only login fails at the table lock
dump_err="$(pg_dump -h "$host" -p "$port" -U "$connect_only" -d "$db" --schema-only 2>&1 >/dev/null || true)"
case "$dump_err" in
  *"permission denied for table d3_fake"*"LOCK TABLE public.d3_fake IN ACCESS SHARE MODE"*|*"LOCK TABLE public.d3_fake IN ACCESS SHARE MODE"*"permission denied"*) say b_pg_dump_needs_select PASS "permission denied for table / ACCESS SHARE" ;;
  *) say b_pg_dump_needs_select FAIL ;;
esac

# (c) with SELECT on the table the schema-only dump works and carries no row
dump="$(pg_dump -h "$host" -p "$port" -U "$reader" -d "$db" --schema-only 2>&1 || true)"
if printf '%s' "$dump" | grep -q "CREATE TABLE public.d3_fake" && ! printf '%s' "$dump" | grep -q "fake-row-value-1" && ! printf '%s' "$dump" | grep -q "^COPY "; then
  say c_schema_only_dump_has_no_row PASS
else
  say c_schema_only_dump_has_no_row FAIL
fi

# (d) a catalog-only DDL query is enough for the CONNECT-only login
ddl="$(as_login "$connect_only" -c "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.d3_fake'::regclass and contype = 'p'" 2>&1 || true)"
case "$ddl" in "PRIMARY KEY (id)") say d_catalog_only_ddl_works PASS ;; *) say d_catalog_only_ddl_works FAIL ;; esac

if [ "$fails" -eq 0 ]; then echo "D3_DUMP_PRIVILEGE|ALL|PASS"; else echo "D3_DUMP_PRIVILEGE|ALL|FAIL"; exit 1; fi
