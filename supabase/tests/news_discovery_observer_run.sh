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
migration="$here/../migrations/20260929090000_news_discovery_observer.sql"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
as_owner_t=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
proof_tmp="$(mktemp -d "$host/nd-proof.XXXXXX")"

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
  48;
set role service_role;
do $$ declare i integer := 0; begin
  while (select count(*) from public.news_discovery_searches where search_day = (now() at time zone 'Asia/Tokyo')::date and status <> 'denied') < 47 loop
    i := i + 1;
    perform public.news_discovery_reserve_search(jsonb_build_object('lane', 'WORLD', 'reason', 'manual',
      'search_key', 'proof-fill:' || i, 'query', 'q', 'provider', 'mock', 'model', 'm'));
  end loop;
end $$;
SQL
reserve_sql() {
  cat <<SQL
set role service_role;
begin isolation level ${3:-read committed};
select count(*) from public.news_discovery_searches;
select public.news_discovery_reserve_search('{"lane":"WORLD","reason":"trigger_discovery_signal","search_key":"race:$1","query":"q","provider":"mock","model":"m"}') ->> 'allowed';
select pg_sleep($2);
commit;
SQL
}
reserve_sql a 2 | "${as_owner_t[@]}" > "$proof_tmp/race-a.txt" &
pid_a=$!
sleep 0.5
reserve_sql b 0 | "${as_owner_t[@]}" > "$proof_tmp/race-b.txt" &
pid_b=$!
wait "$pid_a" "$pid_b"
allowed="$(cat "$proof_tmp/race-a.txt" "$proof_tmp/race-b.txt" | grep -c '^true$' || true)"
[ "$allowed" = "1" ] || { echo "FAIL: $allowed concurrent reservations allowed at the hard cap" >&2; exit 1; }
echo "   exactly one of two concurrent reservations allowed at 47/48"

echo "4b. REPEATABLE READ stale snapshot fails closed (serialization failure)"
"${as_owner[@]}" -c "delete from public.news_discovery_searches where search_key in ('race:a', 'race:b');"
reserve_sql rr-a 2 'repeatable read' | "${as_owner_t[@]}" > "$proof_tmp/rr-a.txt" 2>&1 &
rr_a=$!
sleep 0.5
reserve_sql rr-b 0 'repeatable read' | "${as_owner_t[@]}" > "$proof_tmp/rr-b.txt" 2>&1 &
rr_b=$!
wait "$rr_a"
if wait "$rr_b"; then echo "FAIL: stale RR reservation did not abort" >&2; exit 1; fi
grep -q 'could not serialize access due to concurrent update' "$proof_tmp/rr-b.txt" || {
  echo "FAIL: unexpected RR failure" >&2; exit 1;
}
within_cap="$("${as_owner_t[@]}" -c "select (select count(*) from public.news_discovery_searches where search_day = (now() at time zone 'Asia/Tokyo')::date and status <> 'denied') <= daily_hard_limit from public.news_discovery_search_config where id;")"
[ "$within_cap" = "t" ] || { echo "FAIL: RR exceeded the cap" >&2; exit 1; }
echo "   stale RR transaction aborted; hard cap preserved"

echo "4c. concurrent signal inserts (READ COMMITTED, PostgREST default)"
run_a="$(printf '%s\n' "set role service_role;" "select public.news_discovery_begin_run('{\"trigger_type\":\"local_validation\"}') ->> 'run_id';" | "${as_owner_t[@]}" | tail -1)"
run_b="$(printf '%s\n' "set role service_role;" "select public.news_discovery_begin_run('{\"trigger_type\":\"local_validation\"}') ->> 'run_id';" | "${as_owner_t[@]}" | tail -1)"
# insert_sql <run> <2-hex id suffix, unique to this section> <source> <title> <url> <sleep-after-insert>
insert_sql() {
  local key
  key="$(printf '%s' "$5" | sed -E 's#^https?://(www\.)?##')"
  cat <<SQL
set role service_role;
begin isolation level read committed;
select public.news_discovery_insert_signals(jsonb_build_object('run_id', '$1', 'signals', jsonb_build_array(jsonb_build_object(
  'id', repeat('0', 62) || '$2', 'source_id', '$3', 'source_type', 'rss', 'policy', 'DIRECT_SOURCE', 'discovery_only', false,
  'discovered_via', 'feed:$3', 'source_url', '$5', 'canonical_url', '$5', 'url_key', '$key', 'external_id', null,
  'title', '$4', 'title_fingerprint', left(md5('$4') || md5('$4'), 32), 'title_display_allowed', true,
  'published_at', null, 'published_at_precision', null, 'fetched_at', '2026-09-28T06:00:00Z',
  'language', 'ja', 'country', 'JP', 'publisher', 'fixture', 'topics', '[]'::jsonb, 'needs_verification', '[]'::jsonb,
  'raw_reference', '{"feed_url":"https://example.gov/feed.xml","item_index":0}'::jsonb))))::text;
select pg_sleep($6);
commit;
SQL
}
concurrent_pair() { # <label> then two insert_sql arg lists via globals A_ARGS/B_ARGS
  insert_sql "${A_ARGS[@]}" | "${as_owner_t[@]}" > "$proof_tmp/$1-a.txt" 2>&1 &
  local pa=$!
  sleep 0.5
  insert_sql "${B_ARGS[@]}" | "${as_owner_t[@]}" > "$proof_tmp/$1-b.txt" 2>&1 &
  local pb=$!
  wait "$pa" || { echo "FAIL: $1 session a errored: $(cat "$proof_tmp/$1-a.txt")" >&2; exit 1; }
  wait "$pb" || { echo "FAIL: $1 session b errored: $(cat "$proof_tmp/$1-b.txt")" >&2; exit 1; }
}
# A: two runs, different sources, SAME canonical URL, at the same time -> 1 stored, the other a duplicate.
A_ARGS=("$run_a" c1 us_federal_register "Same document from two routes" "https://www.example.gov/doc/1" 2)
B_ARGS=("$run_b" c2 web_search "Same document found by search" "https://www.example.gov/doc/1" 0)
concurrent_pair race-url
stored="$("${as_owner_t[@]}" -c "select count(*) from public.news_discovery_signals where canonical_url = 'https://www.example.gov/doc/1'")"
grep -q '"duplicates": \[{"id": "0*c2"' "$proof_tmp/race-url-b.txt" || { echo "FAIL: A second insert not reported as duplicate: $(cat "$proof_tmp/race-url-b.txt")" >&2; exit 1; }
[ "$stored" = "1" ] || { echo "FAIL: A stored $stored rows for one canonical URL" >&2; exit 1; }
echo "   A: same canonical URL from two concurrent runs -> 1 stored, other reported as duplicate, no run failure"
# B: same source, same (reused) title, different URL / id -> both kept (官邸 missile instruction case).
A_ARGS=("$run_a" c3 jp_kantei_news "弾道ミサイル発射に関する総理指示" "https://www.kantei.go.jp/jp/105/discourse/a.html" 2)
B_ARGS=("$run_b" c4 jp_kantei_news "弾道ミサイル発射に関する総理指示" "https://www.kantei.go.jp/jp/105/discourse/b.html" 0)
concurrent_pair race-title
kept="$("${as_owner_t[@]}" -c "select count(*) from public.news_discovery_signals where title = '弾道ミサイル発射に関する総理指示'")"
[ "$kept" = "2" ] || { echo "FAIL: B reused-title documents kept=$kept" >&2; exit 1; }
echo "   B: same source + same title + different URL/id, concurrent -> both kept"
# C: different sources, same title, different URLs -> the DB does not drop either (title rule is app-level).
A_ARGS=("$run_a" c5 us_fed_press "Joint statement on market functioning" "https://www.federalreserve.gov/x.htm" 2)
B_ARGS=("$run_b" c6 eu_ecb_press "Joint statement on market functioning" "https://www.ecb.europa.eu/x.html" 0)
concurrent_pair race-cross
kept="$("${as_owner_t[@]}" -c "select count(*) from public.news_discovery_signals where title = 'Joint statement on market functioning'")"
[ "$kept" = "2" ] || { echo "FAIL: C cross-source same title kept=$kept" >&2; exit 1; }
echo "   C: different sources + same title + different URLs -> both kept by the DB"

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
