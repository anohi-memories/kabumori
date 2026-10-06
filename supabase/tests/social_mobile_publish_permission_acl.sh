#!/usr/bin/env bash
# Adverse role-graph proof for the privilege section of the publish-permission
# migration (20261003090000, H2 finding F2). Every case starts from a fresh
# copy of a disposable database (production-shaped fixture + the real
# prerequisite migrations), sets up one adverse or clean role situation,
# applies the candidate and checks the outcome:
#   - clean graph: applied; exact direct ACL; exact effective matrix; a second
#     apply is refused and changes nothing;
#   - unexpected default EXECUTE grantees (schema-scoped with grant option,
#     database-wide) and app roles inheriting such a grantee: applied, and the
#     grantee keeps nothing on the two functions;
#   - an unrelated direct grantee or a grantable grant (injected into a copy
#     right before the postcondition), an app role inheriting another app
#     role or the owner, a creator that is not the helper's owner, a
#     superuser creator: refused with a fixed code, neither function exists
#     afterwards, and no default ACL, function ACL or membership changed.
#
# MUST RUN ALONE on its disposable cluster: several cases change the role
# memberships of the cluster-wide anon / authenticated / service_role roles
# (each case undoes its own change; the exit trap undoes all of them). Never
# run it concurrently with the other runners on the same cluster.
# Usage: PUB_PGHOST=/private/tmp/<socket-dir> PUB_PGPORT=<port> \
#        PUB_PGSUPER=<local superuser> supabase/tests/social_mobile_publish_permission_acl.sh
# PUB_CANDIDATE=<file> checks another copy (social_mobile_publish_permission_mutations.sh).
set -euo pipefail
export LC_ALL=C

host="${PUB_PGHOST:?PUB_PGHOST (local socket dir) required}"
port="${PUB_PGPORT:?PUB_PGPORT required}"
super="${PUB_PGSUPER:?PUB_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PUB_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${PUB_CANDIDATE:-$migrations/20261003090000_social_mobile_publish_permission_boundary.sql}"
psql_bin="${PSQL:-psql}"
n="$$"
owner="kb_publish_acl_owner_$n"      # this run's migration owner (not a member of any app role)
extra="kb_publish_acl_extra_$n"      # an unexpected default EXECUTE grantee
direct="kb_publish_acl_direct_$n"    # an unrelated direct grantee
creator="kb_publish_acl_creator_$n"  # a creating role that does not own the exact-account helper
svc="kb_publish_acl_svc_$n"          # a role that inherits service_role (acts as service_role)
template="kabumori_publish_acl_tpl_$n"
switch="public.set_social_account_publish_enabled(text,boolean,boolean)"
check="public.assert_x_publish_permission_for_legacy_post(uuid,text,text)"

as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-publish-acl.XXXXXX)"
fail() { echo "FAIL $*" >&2; exit 1; }

# Every membership change a case can make, undone (a missing membership is only a warning).
restore_roles() {
  "${as_super[@]}" -d postgres > /dev/null 2>&1 <<SQL || true
revoke $extra from authenticated, anon;
revoke service_role from authenticated;
revoke authenticated from anon;
revoke $owner from service_role;
SQL
}
cleanup() {
  restore_roles
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_publish_acl_${n}_%'" 2>/dev/null) "$template"; do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  for role in "$extra" "$direct" "$creator" "$svc" "$owner"; do
    "${as_super[@]}" -d postgres -c "drop role if exists $role" > /dev/null 2>&1 || true
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb nocreaterole;
create role $extra nologin;
create role $direct nologin;
create role $creator login nosuperuser;
create role $svc nologin;
grant service_role to $svc;
create database $template owner $owner;
SQL
# Pre-existing drift a case would depend on: refuse to run on it.
[[ "$("${as_super[@]}" -d postgres -c "select pg_has_role('authenticated', 'service_role', 'usage') or pg_has_role('anon', 'authenticated', 'usage') or pg_has_role('service_role', 'authenticated', 'usage')")" == f ]] \
  || fail "the cluster's app roles already inherit each other"

as_owner_tpl=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$template")
"${as_owner_tpl[@]}" -f "$here/social_mobile_publish_permission_fixture.sql" > /dev/null
# The same real prerequisite chain as social_mobile_publish_permission_run.sh.
for real in \
  20260919120000_social_mobile_x_oauth_onboarding.sql \
  20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql \
  20260925140000_x_account_credential_refresh_core.sql \
  20260926032054_x_account_refresh_rollout_authority.sql \
  20260928160000_social_mobile_account_deletion_candidate.sql; do
  "${as_owner_tpl[@]}" -f "$migrations/$real" > /dev/null
done

fresh() {
  local db="kabumori_publish_acl_${n}_$1"
  "${as_super[@]}" -d postgres -c "create database $db template $template owner $owner" > /dev/null
  echo "$db"
}
q() { "${as_super[@]}" -d "$1" -c "$2"; }
# Applies a candidate file as a role; prints the outcome: "applied" or the first ERROR text.
apply() {
  local db="$1" role="$2" file="$3" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$role" -d "$db" -f "$file" 2>&1)"; then
    echo applied
  else
    sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1
  fi
}
# Who can execute what, inherited privileges included: S = the switch, C = the check, - = nothing.
matrix() {
  q "$1" "select string_agg(r || ':' || case when has_function_privilege(r, '$switch', 'execute') then 'S' else '-' end
                                  || case when has_function_privilege(r, '$check', 'execute') then 'C' else '-' end, ' ' order by o)
          from unnest(array['anon', 'authenticated', 'service_role', '$extra', '$direct', '$svc', '$creator']) with ordinality u(r, o)"
}
# Non-owner direct ACL entries of the two functions.
direct_acl() {
  q "$1" "select string_agg(p.proname || '=' || pg_get_userbyid(a.grantee) || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end, ' ' order by p.proname, 2)
          from pg_proc p, aclexplode(p.proacl) a
          where p.oid in ('$switch'::regprocedure, '$check'::regprocedure) and a.grantee <> p.proowner"
}
# Default ACLs, every public function's ACL and every membership: a refused apply must change none.
fingerprint() {
  q "$1" "select md5(concat_ws('|',
            (select string_agg(d.defaclrole::regrole::text || ':' || d.defaclnamespace::text || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, ',' order by d.defaclrole, d.defaclnamespace, d.defaclobjtype) from pg_default_acl d),
            (select string_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text) from pg_proc p where p.pronamespace = 'public'::regnamespace),
            (select string_agg(m.roleid::regrole::text || '>' || m.member::regrole::text, ',' order by 1) from pg_auth_members m)))"
}
absent() {
  [[ "$(q "$1" "select to_regprocedure('$switch') is null and to_regprocedure('$check') is null")" == t ]]
}
clean_matrix="anon:-- authenticated:S- service_role:-C $extra:-- $direct:-- $svc:-C $creator:--"
clean_acl="assert_x_publish_permission_for_legacy_post=service_role:EXECUTE set_social_account_publish_enabled=authenticated:EXECUTE"

# Expects the candidate to apply and the exact clean result.
expect_applied() {
  local label="$1" db="$2" role="${3:-$owner}" file="${4:-$candidate}" got
  got="$(apply "$db" "$role" "$file")"
  [[ "$got" == applied ]] || fail "ACL $label: refused ($got)"
  [[ "$(direct_acl "$db")" == "$clean_acl" ]] || fail "ACL $label: direct ACL is $(direct_acl "$db")"
  [[ "$(matrix "$db")" == "$clean_matrix" ]] || fail "ACL $label: effective EXECUTE is $(matrix "$db")"
}
# Expects a refusal with exactly this code, nothing created and nothing else changed.
expect_refused() {
  local label="$1" db="$2" code="$3" role="${4:-$owner}" file="${5:-$candidate}" before got
  before="$(fingerprint "$db")"
  got="$(apply "$db" "$role" "$file")"
  [[ "$got" == "$code" ]] || fail "ACL $label: expected $code, got ${got:-applied}"
  absent "$db" || fail "ACL $label: a function survived the refused apply"
  [[ "$(fingerprint "$db")" == "$before" ]] || fail "ACL $label: the refused apply changed privileges"
}
# A copy of the candidate with one statement placed right before its postcondition.
inject() {
  local into="$tmp/$1.sql"
  python3 - "$candidate" "$into" "$2" <<'PY'
import sys
source, target, statement = sys.argv[1:4]
text = open(source, encoding="utf-8").read()
marker = "-- Postcondition: exact and effective EXECUTE."
if text.count(marker) != 1:
    sys.exit("postcondition marker not found exactly once")
open(target, "w", encoding="utf-8").write(text.replace(marker, statement + "\n" + marker))
PY
  echo "$into"
}

# 1. Clean role graph. Then a second apply: refused, and the privileges are unchanged.
db="$(fresh clean)"
expect_applied "clean graph" "$db"
before="$(fingerprint "$db")"
[[ "$(apply "$db" "$owner" "$candidate")" == PUBLISH_PERMISSION_PRECONDITION_ALREADY_APPLIED ]] || fail "ACL re-apply was not refused"
[[ "$(fingerprint "$db")" == "$before" ]] || fail "ACL re-apply changed privileges"

# 2. The creating role's schema default privileges grant EXECUTE (with grant option) to another role.
db="$(fresh default_schema)"
q "$db" "set role $owner; alter default privileges in schema public grant execute on functions to $extra with grant option" > /dev/null
expect_applied "default grantee (schema)" "$db"

# 3. The same through database-wide default privileges.
db="$(fresh default_global)"
q "$db" "set role $owner; alter default privileges grant execute on functions to $extra" > /dev/null
expect_applied "default grantee (database-wide)" "$db"

# 4. authenticated and anon inherit that default grantee: they gain nothing through it.
db="$(fresh default_inherited)"
q "$db" "set role $owner; alter default privileges in schema public grant execute on functions to $extra" > /dev/null
q postgres "grant $extra to authenticated, anon" > /dev/null
expect_applied "inherited default grantee" "$db"
restore_roles

# 5. A direct grant to an unrelated role, and a grantable grant to the intended role, made after the
#    clean-up step: the postcondition must refuse both.
db="$(fresh direct)"
expect_refused "unrelated direct grantee" "$db" PUBLISH_PERMISSION_EFFECTIVE_ACL "$owner" \
  "$(inject direct "grant execute on function $check to $direct;")"
db="$(fresh grantable)"
expect_refused "grantable grant" "$db" PUBLISH_PERMISSION_EFFECTIVE_ACL "$owner" \
  "$(inject grantable "grant execute on function $switch to authenticated with grant option;")"

# 6. Role graphs the file cannot repair without changing memberships: refused.
db="$(fresh auth_inherits_service)"
q postgres "grant service_role to authenticated" > /dev/null
expect_refused "authenticated inherits service_role" "$db" PUBLISH_PERMISSION_EFFECTIVE_ACL
restore_roles
db="$(fresh anon_inherits_auth)"
q postgres "grant authenticated to anon" > /dev/null
expect_refused "anon inherits authenticated" "$db" PUBLISH_PERMISSION_EFFECTIVE_ACL
restore_roles
db="$(fresh service_inherits_owner)"
q postgres "grant $owner to service_role" > /dev/null
expect_refused "service_role inherits the owner" "$db" PUBLISH_PERMISSION_EFFECTIVE_ACL
restore_roles

# 7. Creator / owner assumptions.
db="$(fresh other_creator)"
# Enough to pass every earlier precondition, so the owner check is what refuses.
q "$db" "grant create on schema public to $creator; grant usage on schema auth to $creator;
          grant select on public.social_accounts, public.brands, public.brand_memberships to $creator" > /dev/null
expect_refused "creator is not the helper's owner" "$db" PUBLISH_PERMISSION_PRECONDITION_OWNER "$creator"
db="$(fresh super_creator)"
expect_refused "superuser creator" "$db" PUBLISH_PERMISSION_PRECONDITION_OWNER "$super"
db="$(fresh super_owner)"
q "$db" "alter function public.x_legacy_post_account(uuid,text,text,boolean) owner to $super" > /dev/null
expect_refused "helper owned by a superuser, applied by it" "$db" PUBLISH_PERMISSION_PRECONDITION_OWNER "$super"

echo "PUBLISH_PERMISSION_ACL_PASS"
