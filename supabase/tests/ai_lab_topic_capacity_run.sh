#!/usr/bin/env bash
# Disposable-only proof for the AI Lab topic-pool capacity fix (20261007173000 on top of 20261004090000).
# On a LOCAL Unix-socket PostgreSQL cluster, as a non-superuser owner with Supabase-style default privileges:
#   - the capacity migration refuses to run before 20261004090000, applies cleanly after it, and re-applies;
#   - its postcondition leaves the five entry points and the table exactly as 20261004090000 did (service_role
#     EXECUTE only; anon/authenticated nothing, by any path);
#   - with NO diary topics, 10 posts/day for 14 days through the REAL claim_ai_lab_topic (time advanced by shifting
#     every recorded timestamp back 2.4h before each slot) never returns "no claim", never reuses a seed within
#     72h, and never publishes two theme-sharing seeds within 48h;
#   - the old 7-seed pool runs dry inside the first day under the same function and policy.
# Candidate lists are built by the production TS builder (buildAiLabTopicCandidates) via `deno eval`.
# Fake data only; never production.
# Usage: AILAB_PGHOST=/private/tmp/<socket-dir> AILAB_PGPORT=<port> AILAB_PGSUPER=<local superuser> \
#        supabase/tests/ai_lab_topic_capacity_run.sh
set -euo pipefail

host="${AILAB_PGHOST:?AILAB_PGHOST (local socket dir) required}"
port="${AILAB_PGPORT:?AILAB_PGPORT required}"
super="${AILAB_PGSUPER:?AILAB_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: AILAB_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
base_migration="$here/../migrations/20261004090000_ai_lab_topic_claims.sql"
capacity_migration="$here/../migrations/20261007173000_ai_lab_topic_evergreen_capacity.sql"
builder="$here/../functions/_shared/brand/ai_lab_dev_diary_context.ts"
owner="kb_ai_lab_claims_owner"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-ailab-capacity.XXXXXX)"
dbs=()
cleanup() {
  local name
  for name in "${dbs[@]}"; do
    "${as_super[@]}" -d postgres -c "drop database if exists $name with (force)" >/dev/null 2>&1 || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }

"${as_super[@]}" -d postgres <<SQL >/dev/null
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
SQL

fresh_db() {
  db="kabumori_ailab_capacity_$1_$$"
  dbs+=("$db")
  "${as_super[@]}" -d postgres -c "create database $db owner $owner" >/dev/null
  "${as_super[@]}" -d "$db" -c "grant usage on schema public to anon, authenticated, service_role; grant create on schema public to $owner;" >/dev/null
  "${as_super[@]}" -d "$db" -c "alter default privileges for role $owner in schema public grant all on tables to anon, authenticated, service_role; alter default privileges for role $owner in schema public grant all on functions to anon, authenticated, service_role;" >/dev/null
}
owner_psql() { "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -c "$1"; }

# Candidate lists exactly as production builds them with no diary: one JSON array per slot (rotationIndex = slot),
# plus the same lists restricted to the original seven seeds.
DENO_NO_PACKAGE_JSON=1 deno eval --no-config "
import { buildAiLabTopicCandidates } from '$builder';
const wire = (c) => ({ kind: c.kind, event_key: c.eventKey, unit_key: c.unitKey, theme_tags: [...c.themeTags] });
const now = new Date('2026-10-08T00:00:00Z');
const all = [], old = [];
for (let slot = 0; slot < 140; slot += 1) {
  const { candidates } = buildAiLabTopicCandidates({ markdown: '', now, rotationIndex: slot });
  all.push(JSON.stringify(candidates.map(wire)));
  old.push(JSON.stringify(candidates.filter((c) => Number(c.eventKey.split('-')[1]) < 7).map(wire)));
}
await Deno.writeTextFile('$tmp/all.jsonl', all.join('\n') + '\n');
await Deno.writeTextFile('$tmp/old.jsonl', old.join('\n') + '\n');
"
[[ "$(wc -l < "$tmp/all.jsonl" | tr -d ' ')" == 140 ]] || fail "candidate lists"

# ------------------------------------------------------------------------- apply order / reapply / ACL
fresh_db order
if out="$(owner_psql -f "$capacity_migration" 2>&1)"; then fail "capacity migration applied without 20261004090000"; fi
grep -qF "requires 20261004090000" <<<"$out" || fail "missing-base refusal message :: $out"
[[ "$(q "select to_regprocedure('public.claim_ai_lab_topic(uuid,jsonb,integer)') is null")" == t ]] || fail "refused apply created the function"
pass "capacity migration refuses to run before 20261004090000 and creates nothing"

fresh_db capacity
owner_psql -f "$base_migration" >/dev/null
owner_psql -f "$capacity_migration" >/dev/null || fail "capacity migration apply"
owner_psql -f "$capacity_migration" >/dev/null || fail "capacity migration reapply"
pass "capacity migration applies after 20261004090000 and re-applies"
acl="$(q "select string_agg(r || ':' || has_function_privilege(r, 'public.claim_ai_lab_topic(uuid,jsonb,integer)', 'EXECUTE')
          || ':' || has_table_privilege(r, 'public.ai_lab_topic_claims', 'SELECT'), ',' order by r)
          from unnest(array['anon', 'authenticated', 'service_role']) r")"
[[ "$acl" == "anon:false:false,authenticated:false:false,service_role:true:false" ]] || fail "effective ACL :: $acl"
[[ "$(q "select prosecdef and proconfig = array['search_path=\"\"'] from pg_proc where oid = 'public.claim_ai_lab_topic(uuid,jsonb,integer)'::regprocedure")" == t ]] \
  || fail "definer/search_path"
pass "effective ACL unchanged: service_role EXECUTE only, nobody reads the table; SECURITY DEFINER, search_path=''"

# The function now accepts the full pool in one call, still refuses more than 128 candidates and unknown seeds.
big="[$(seq 0 128 | sed 's/.*/{"kind":"evergreen","event_key":"evergreen-0","unit_key":"evergreen-0","theme_tags":["unglamorous_work"]}/' | paste -sd, -)]"
if out="$(q "select public.claim_ai_lab_topic('00000000-0000-0000-0000-00000000aaaa', '$big'::jsonb, 900)" 2>&1)"; then fail "129 candidates accepted"; fi
grep -qF "AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT" <<<"$out" || fail "129 candidates message :: $out"
if out="$(q "select public.claim_ai_lab_topic('00000000-0000-0000-0000-00000000aaab', '[{\"kind\":\"evergreen\",\"event_key\":\"evergreen-74\",\"unit_key\":\"evergreen-74\",\"theme_tags\":[]}]'::jsonb, 900)" 2>&1)"; then fail "evergreen-74 accepted"; fi
pass "more than 128 candidates and seeds outside the 74-seed map are still refused"

# ------------------------------------------------------------------------- 14-day simulation on the real function
simulate() {  # $1 = jsonl file, $2 = slots -> prints "<claimed>/<exhausted>"
  owner_psql <<SQL >/dev/null
truncate public.ai_lab_topic_claims;
create table if not exists public.capacity_slots (slot int primary key, candidates jsonb not null);
truncate public.capacity_slots;
create table if not exists public.capacity_results (slot int primary key, event_key text);
truncate public.capacity_results;
SQL
  awk '{ printf "%d\t%s\n", NR - 1, $0 }' "$1" | owner_psql -c "\\copy public.capacity_slots (slot, candidates) from stdin"
  owner_psql <<SQL >/dev/null
do \$\$
declare
  r record;
  v jsonb;
  v_post uuid;
begin
  for r in select slot, candidates from public.capacity_slots where slot < $2 order by slot loop
    -- Time moves forward 2.4h: shift every recorded timestamp back by the same amount (relations preserved).
    update public.ai_lab_topic_claims
       set claimed_at = claimed_at - interval '144 minutes',
           lease_until = lease_until - interval '144 minutes',
           provider_started_at = provider_started_at - interval '144 minutes',
           settled_at = settled_at - interval '144 minutes',
           published_at = published_at - interval '144 minutes';
    v_post := ('00000000-0000-4000-8000-' || lpad(r.slot::text, 12, '0'))::uuid;
    v := public.claim_ai_lab_topic(v_post, r.candidates, 900);
    if v -> 'claim' = 'null'::jsonb then
      insert into public.capacity_results values (r.slot, null);
      continue;
    end if;
    if not public.start_ai_lab_topic_provider((v -> 'claim' ->> 'claim_id')::uuid, v_post, v -> 'claim' ->> 'event_key') then
      raise exception 'start failed at slot %', r.slot;
    end if;
    perform public.settle_ai_lab_topic_claim_published((v -> 'claim' ->> 'claim_id')::uuid, v_post,
      v -> 'claim' ->> 'event_key', v -> 'claim' ->> 'unit_key', (9000000 + r.slot)::text);
    insert into public.capacity_results values (r.slot, v -> 'claim' ->> 'event_key');
  end loop;
end
\$\$;
SQL
  q "select count(event_key) || '/' || count(*) filter (where event_key is null) from public.capacity_results"
}

result="$(simulate "$tmp/all.jsonl" 140)"
[[ "$result" == "140/0" ]] || fail "14-day simulation (claimed/exhausted) = $result"
pass "real claim function, no diary, 10 posts/day x 14 days: 140/140 claimed, 0 AI_LAB_TOPIC_POOL_EXHAUSTED"
[[ "$(q "select count(*) from (select event_key, published_at - lag(published_at) over (partition by event_key order by published_at) as gap
                                from public.ai_lab_topic_claims where state = 'published') g where gap < interval '72 hours'")" == 0 ]] \
  || fail "a seed was reused within 72h"
[[ "$(q "select count(*) from public.ai_lab_topic_claims a join public.ai_lab_topic_claims b
          on a.claim_id <> b.claim_id and a.theme_tags && b.theme_tags and cardinality(a.theme_tags) > 0
         and b.published_at > a.published_at and b.published_at - a.published_at < interval '48 hours'
         where a.state = 'published' and b.state = 'published'")" == 0 ]] || fail "two theme-sharing seeds within 48h"
distinct="$(q "select count(distinct event_key) from public.ai_lab_topic_claims where state = 'published'")"
(( distinct >= 30 )) || fail "only $distinct distinct seeds"
pass "cooldowns held in SQL: no seed within 72h, no shared theme within 48h; $distinct distinct seeds used"

result="$(simulate "$tmp/old.jsonl" 10)"
[[ "$result" != "10/0" ]] || fail "old 7-seed pool unexpectedly survived a day"
pass "old 7-seed pool under the same function runs dry within the first day ($result claimed/exhausted)"

echo "ALL AI LAB TOPIC CAPACITY CHECKS PASSED"
