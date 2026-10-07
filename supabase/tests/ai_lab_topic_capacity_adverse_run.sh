#!/usr/bin/env bash
# Disposable-only adverse matrix for the AI Lab capacity migration (20261007173000), PR #109 B1/B2/B3:
#   B1  API-role membership paths that reach service_role / the owner (INHERIT FALSE + SET TRUE, via a bridge,
#       ordinary INHERIT) are refused.
#   B2  drift of the prerequisite ai_lab_topic_claims shape (PK, diary unique index, RLS, a vacuous event_key
#       CHECK, a wrong index predicate, an invalid index, table / column ACL) is refused.
#   B3  a companion function with the same contract but a different body (start_ai_lab_topic_provider ->
#       RETURN true) and an unknown claim body are refused.
# Every refusal must happen before claim_ai_lab_topic is replaced, roll back completely (catalog fingerprint
# unchanged, claim body still the pre-capacity body) and never repair the drift. A healthy graph applies and
# re-applies. One template database (20261004090000 applied) is cloned per case. Role memberships are
# cluster-wide: run this suite alone; every membership change is undone (also in the exit trap).
# Usage: AILAB_PGHOST=/private/tmp/<socket-dir> AILAB_PGPORT=<port> AILAB_PGSUPER=<local superuser> \
#        supabase/tests/ai_lab_topic_capacity_adverse_run.sh
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
capacity="$here/../migrations/20261007173000_ai_lab_topic_evergreen_capacity.sql"
owner="kb_ai_lab_claims_owner"
prefix="kb_ailab_cap_adv_$$"
bridge="${prefix}_bridge"
psql_bin="${PSQL:-psql}"
base=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port")
as_super=("${base[@]}" -U "$super")
tpl="${prefix}_tpl"
OLD_CLAIM_MD5="a3cbe66723878b209a84bbd32b2bdc21"
NEW_CLAIM_MD5="9aefd06d1ab537fbc6bde527997dace7"

q() { local user="$1" db="$2"; shift 2; "${base[@]}" -A -t -U "$user" -d "$db" "$@"; }
undo_roles() {
  "${as_super[@]}" -d postgres -c "revoke service_role from anon; revoke service_role from authenticated" >/dev/null 2>&1 || true
}
cleanup() {
  local name
  undo_roles
  for name in $("${as_super[@]}" -A -t -d postgres -c "select datname from pg_database where datname like '${prefix}\_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $name with (force)" >/dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $bridge" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

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
create database $tpl owner $owner;
SQL
[[ "$(q "$super" postgres -c "select pg_has_role('anon', 'service_role', 'MEMBER') or pg_has_role('authenticated', 'service_role', 'MEMBER')")" == f ]] \
  || fail "cluster role graph not clean before the suite"
"${as_super[@]}" -d "$tpl" -c "grant usage on schema public to anon, authenticated, service_role; grant create on schema public to $owner;" >/dev/null
"${as_super[@]}" -d "$tpl" -c "alter default privileges for role $owner in schema public grant all on tables to anon, authenticated, service_role; alter default privileges for role $owner in schema public grant all on functions to anon, authenticated, service_role;" >/dev/null
q "$owner" "$tpl" -f "$base_migration" >/dev/null

new_db() { local db="${prefix}_$1"; "${as_super[@]}" -d postgres -c "create database $db template $tpl owner $owner" >/dev/null; echo "$db"; }
claim_md5() { q "$super" "$1" -c "select md5(prosrc) from pg_proc where oid = 'public.claim_ai_lab_topic(uuid,jsonb,integer)'::regprocedure"; }
# Everything a refused apply could have touched: public routines (body + ACL), the table (ACL, RLS), its
# columns' ACLs, constraints and indexes.
snapshot() {
  q "$super" "$1" -c "select md5(concat_ws('#',
    (select string_agg(concat_ws(':', p.oid::regprocedure, md5(p.prosrc), p.proowner::regrole, p.proacl, p.proconfig), '|' order by 1)
       from pg_proc p where p.pronamespace = 'public'::regnamespace),
    (select concat_ws(':', c.relowner::regrole, c.relacl, c.relrowsecurity, c.relforcerowsecurity) from pg_class c where c.oid = 'public.ai_lab_topic_claims'::regclass),
    (select string_agg(concat_ws(':', a.attname, a.attacl), '|' order by a.attnum) from pg_attribute a
      where a.attrelid = 'public.ai_lab_topic_claims'::regclass and a.attnum > 0 and a.attacl is not null),
    (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.ai_lab_topic_claims'::regclass),
    (select string_agg(pg_get_indexdef(x.indexrelid) || x.indisvalid || x.indisready, '|' order by 1) from pg_index x where x.indrelid = 'public.ai_lab_topic_claims'::regclass)))"
}

# refuse <case> <db> <expected message fragment>: the capacity migration must fail with the message, leave the
# catalog fingerprint unchanged and keep the pre-capacity claim body.
refuse() {
  local name="$1" db="$2" code="$3" before after out
  before="$(snapshot "$db")"
  if out="$(q "$owner" "$db" -f "$capacity" 2>&1)"; then fail "$name: capacity migration applied despite the drift"; fi
  grep -qF -- "$code" <<<"$out" || fail "$name: wrong refusal (want $code): $out"
  after="$(snapshot "$db")"
  [[ "$before" == "$after" ]] || fail "$name: refused apply changed the catalog"
  [[ "$(claim_md5 "$db")" != "$NEW_CLAIM_MD5" ]] || fail "$name: claim body was replaced"
  echo "REFUSED $name ($code)"
}

# ------------------------------------------------------------------------------------------------ B1
"${as_super[@]}" -d postgres -c "create role $bridge nologin" >/dev/null

db="$(new_db b1_anon_set_only)"
"${as_super[@]}" -d postgres -c "grant service_role to anon with inherit false, set true" >/dev/null
[[ "$(q "$super" "$db" -c "select has_function_privilege('anon', 'public.claim_ai_lab_topic(uuid,jsonb,integer)', 'EXECUTE')")" == f ]] \
  || fail "b1_anon_set_only: fixture is not SET-only"
refuse b1_anon_to_service_role_inherit_false_set_true "$db" "can reach a privileged role through role membership"
undo_roles

db="$(new_db b1_bridge)"
"${as_super[@]}" -d postgres -c "grant service_role to $bridge with inherit false, set true; grant $bridge to authenticated with inherit false, set true" >/dev/null
refuse b1_authenticated_bridge_service_role_set_path "$db" "can reach a privileged role through role membership"
"${as_super[@]}" -d postgres -c "revoke $bridge from authenticated; revoke service_role from $bridge" >/dev/null

db="$(new_db b1_inherit)"
"${as_super[@]}" -d postgres -c "grant service_role to authenticated" >/dev/null
refuse b1_authenticated_inherits_service_role "$db" "AI_LAB_TOPIC_CLAIMS_PREFLIGHT"
undo_roles
[[ "$(q "$super" postgres -c "select pg_has_role('anon', 'service_role', 'MEMBER') or pg_has_role('authenticated', 'service_role', 'MEMBER')")" == f ]] \
  || fail "B1 role-graph changes were not undone"

# ------------------------------------------------------------------------------------------------ B2
db="$(new_db b2_pk)"
q "$owner" "$db" -c "alter table public.ai_lab_topic_claims drop constraint ai_lab_topic_claims_pkey" >/dev/null
refuse b2_missing_primary_key "$db" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"

db="$(new_db b2_diary_index)"
q "$owner" "$db" -c "drop index public.ai_lab_topic_claims_diary_event_active_uidx" >/dev/null
refuse b2_missing_diary_active_unique_index "$db" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"

db="$(new_db b2_rls)"
q "$owner" "$db" -c "alter table public.ai_lab_topic_claims disable row level security" >/dev/null
refuse b2_rls_disabled "$db" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"

db="$(new_db b2_vacuous_check)"
q "$owner" "$db" -c "alter table public.ai_lab_topic_claims drop constraint ai_lab_topic_claims_event_key_check,
  add constraint ai_lab_topic_claims_event_key_check check ((topic_kind = 'evergreen' and event_key ~ '^evergreen-[0-9]{1,2}\$') or true)" >/dev/null
refuse b2_vacuous_event_key_check "$db" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"

db="$(new_db b2_predicate)"
q "$owner" "$db" -c "drop index public.ai_lab_topic_claims_schedule_active_uidx;
  create unique index ai_lab_topic_claims_schedule_active_uidx on public.ai_lab_topic_claims (scheduled_post_id) where state = 'claimed'" >/dev/null
refuse b2_wrong_index_predicate "$db" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"

db="$(new_db b2_invalid_index)"
"${as_super[@]}" -d "$db" -c "update pg_index set indisvalid = false where indexrelid = 'public.ai_lab_topic_claims_diary_event_active_uidx'::regclass" >/dev/null
refuse b2_invalid_diary_index "$db" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"

db="$(new_db b2_table_acl)"
q "$owner" "$db" -c "grant select on public.ai_lab_topic_claims to authenticated" >/dev/null
refuse b2_table_acl_drift "$db" "AI_LAB_TOPIC_CLAIMS_PREFLIGHT"

db="$(new_db b2_column_acl)"
q "$owner" "$db" -c "grant select (event_key) on public.ai_lab_topic_claims to anon" >/dev/null
refuse b2_column_acl_drift "$db" "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT"

# ------------------------------------------------------------------------------------------------ B3
db="$(new_db b3_start_body)"
q "$owner" "$db" <<'SQL' >/dev/null
create or replace function public.start_ai_lab_topic_provider(
  p_claim_id uuid,
  p_scheduled_post_id uuid,
  p_event_key text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return true;
end;
$$;
SQL
[[ "$(q "$super" "$db" -c "select has_function_privilege('service_role', 'public.start_ai_lab_topic_provider(uuid,uuid,text)', 'EXECUTE') and prosecdef
       and proconfig = array['search_path=\"\"'] from pg_proc where oid = 'public.start_ai_lab_topic_provider(uuid,uuid,text)'::regprocedure")" == t ]] \
  || fail "b3: drifted companion does not keep the same contract/ACL"
refuse b3_start_provider_body_return_true "$db" "start_ai_lab_topic_provider definition differs"

db="$(new_db b3_claim_body)"
q "$super" "$db" -c "update pg_proc set prosrc = prosrc || ' ' where oid = 'public.claim_ai_lab_topic(uuid,jsonb,integer)'::regprocedure" >/dev/null
refuse b3_unknown_claim_body "$db" "claim_ai_lab_topic definition differs"

# ------------------------------------------------------------------------------------------------ healthy control
db="$(new_db healthy)"
[[ "$(claim_md5 "$db")" == "$OLD_CLAIM_MD5" ]] || fail "healthy: base claim body is not the approved pre-capacity body"
q "$owner" "$db" -f "$capacity" >/dev/null || fail "healthy: capacity migration refused"
[[ "$(claim_md5 "$db")" == "$NEW_CLAIM_MD5" ]] || fail "healthy: claim body after apply"
q "$owner" "$db" -f "$capacity" >/dev/null || fail "healthy: reapply refused"
for name in start_ai_lab_topic_provider release_ai_lab_topic_claim mark_ai_lab_topic_claim_ambiguous settle_ai_lab_topic_claim_published; do
  [[ "$(q "$super" "$db" -c "select md5(prosrc) from pg_proc where proname = '$name'")" == "$(q "$super" "$tpl" -c "select md5(prosrc) from pg_proc where proname = '$name'")" ]] \
    || fail "healthy: $name was rewritten"
done
echo "HEALTHY apply + reapply accepted; the four companion functions are untouched"

cleanup
[[ "$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname like '${prefix}\_%'")" == 0 ]] || fail "cleanup left databases"
[[ "$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_roles where rolname like '${prefix}\_%'")" == 0 ]] || fail "cleanup left roles"
[[ "$("${as_super[@]}" -A -t -d postgres -c "select pg_has_role('anon', 'service_role', 'MEMBER') or pg_has_role('authenticated', 'service_role', 'MEMBER')")" == f ]] \
  || fail "cleanup left a role-graph change"
echo "ALL AI LAB CAPACITY ADVERSE CHECKS PASSED"
