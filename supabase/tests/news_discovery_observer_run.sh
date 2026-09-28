#!/usr/bin/env bash
# Disposable-only proof for the news discovery observer migration. Creates a throwaway database on
# a LOCAL Unix-socket PostgreSQL cluster, applies a stand-in fixture of existing tables, then:
#   1. clean apply as a NON-superuser owner (with anon/authenticated/service_role emulated)
#   2. existing tables unchanged (catalog + ACL fingerprint before/after)
#   3. behavior proof (privileges, insert, retry, dedupe rules, transaction failure, constraints,
#      search budget, finish_run) — supabase/tests/news_discovery_observer_behavior.sql
#   4. concurrent reserve_search cannot exceed the hard cap (advisory lock)
#   5. rollback removes only news_discovery_* objects, existing tables unchanged, re-apply is clean
# Fake data only; never production.
# Usage: ND_PGHOST=/private/tmp/<socket-dir> ND_PGPORT=<port> ND_PGSUPER=<local superuser> \
#        supabase/tests/news_discovery_observer_run.sh
set -euo pipefail

host="${ND_PGHOST:?ND_PGHOST (local socket dir) required}"
port="${ND_PGPORT:?ND_PGPORT required}"
super="${ND_PGSUPER:?ND_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: ND_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_news_discovery_$$"
owner="kb_news_discovery_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migration="$here/../migrations/20260928120000_news_discovery_observer.sql"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
as_owner_t=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

cleanup() {
  if [ "${KEEP_DB:-0}" != "1" ]; then
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"${as_super[@]}" -d postgres <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
"${as_super[@]}" -d "$db" -c "grant usage on schema public to anon, authenticated, service_role; alter schema public owner to $owner;"

"${as_owner[@]}" -f "$here/news_discovery_observer_fixture.sql"

# Fingerprint of everything that is NOT a news_discovery_* object: relations, columns, constraints,
# ACLs, RLS flags and functions. Must be identical before/after apply and after rollback.
fingerprint() {
  "${as_owner_t[@]}" <<'SQL'
select md5(string_agg(line, E'\n' order by line)) from (
  select format('rel %s %s %s %s %s', c.relname, c.relkind, coalesce(c.relacl::text, ''), c.relrowsecurity,
    (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' order by a.attnum)
       from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)) as line
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname not like 'news_discovery%'
  union all
  select format('con %s %s', conrelid::regclass, pg_get_constraintdef(oid)) from pg_constraint
  where connamespace = 'public'::regnamespace and conrelid::regclass::text not like 'news_discovery%'
  union all
  select format('fn %s %s', p.oid::regprocedure, coalesce(p.proacl::text, '')) from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname not like 'news_discovery%'
  union all
  select format('row %s', count(*)) from public.important_news_candidates
) x;
SQL
}

before="$(fingerprint)"
echo "1. clean apply (non-superuser owner)"
"${as_owner[@]}" -f "$migration"
after="$(fingerprint)"
[ "$before" = "$after" ] || { echo "FAIL: existing objects changed by migration" >&2; exit 1; }
echo "2. existing tables unchanged: $before"
objects="$("${as_owner_t[@]}" -c "select (select count(*) from pg_class where relname like 'news_discovery%' and relkind = 'r') || ' tables, ' || (select count(*) from pg_proc where proname like 'news_discovery%') || ' functions'")"
echo "   created: $objects"

echo "3. behavior proof"
"${as_owner[@]}" -f "$here/news_discovery_observer_behavior.sql"

echo "4. concurrent reserve_search vs hard cap"
"${as_owner[@]}" <<'SQL'
update public.news_discovery_search_config set daily_soft_budget = 0, daily_hard_limit =
  (select count(*) + 1 from public.news_discovery_searches where search_day = (now() at time zone 'Asia/Tokyo')::date and status <> 'denied');
SQL
reserve_sql() {
  cat <<SQL
set role service_role;
begin;
select public.news_discovery_reserve_search('{"lane":"WORLD","reason":"trigger_discovery_signal","search_key":"race:$1","query":"q","provider":"mock","model":"m"}') ->> 'allowed';
select pg_sleep($2);
commit;
SQL
}
reserve_sql a 2 | "${as_owner_t[@]}" > /tmp/claude-501-nd-race-a.txt &
pid_a=$!
sleep 0.5
reserve_sql b 0 | "${as_owner_t[@]}" > /tmp/claude-501-nd-race-b.txt &
pid_b=$!
wait "$pid_a" "$pid_b"
allowed="$(cat /tmp/claude-501-nd-race-a.txt /tmp/claude-501-nd-race-b.txt | grep -c '^true$' || true)"
rm -f /tmp/claude-501-nd-race-a.txt /tmp/claude-501-nd-race-b.txt
[ "$allowed" = "1" ] || { echo "FAIL: $allowed concurrent reservations allowed at the hard cap" >&2; exit 1; }
echo "   exactly one of two concurrent reservations allowed at the cap"

echo "5. rollback"
"${as_owner[@]}" -f "$here/news_discovery_observer_rollback.sql"
remaining="$("${as_owner_t[@]}" -c "select count(*) from pg_class where relname like 'news_discovery%'") $("${as_owner_t[@]}" -c "select count(*) from pg_proc where proname like 'news_discovery%'")"
[ "$remaining" = "0 0" ] || { echo "FAIL: objects left after rollback: $remaining" >&2; exit 1; }
rolled="$(fingerprint)"
[ "$before" = "$rolled" ] || { echo "FAIL: existing objects changed after rollback" >&2; exit 1; }
"${as_owner[@]}" -f "$migration"
echo "   rollback clean; re-apply clean"
echo "NEWS_DISCOVERY_MIGRATION_PROOF_PASSED"
if [ "${KEEP_DB:-0}" = "1" ]; then echo "KEPT_DB=$db"; fi
