#!/usr/bin/env bash
# Disposable-only adverse ACL matrix for the three Stage 3B migrations (PR41 R1/R2 corrective):
#   R1  reader 20261006160100 refuses any effective service_role privilege on the settings table or any
#       of its columns (direct, inherited, via PUBLIC; SELECT and DML), atomically.
#   R2  completion 20261006160000 and publish authority 20261006160200 refuse unknown default/inherited
#       EXECUTE (and unknown table grants), grant options to unknown roles, overload/procedure collisions,
#       unsafe owners/creators and application roles inheriting the owner or service_role, atomically.
# Every refusal must leave the catalog exactly as it was (no partial table/function/ACL change) and must
# not "repair" the drift it found. The clean graph must still give exactly the intended permissions:
# authenticated cannot call the setter or the completion; service_role can.
# Builds one template database (production-shaped fixture + PR81 store + refresh core/rollout) and clones
# a fresh database per case. Role memberships are cluster-wide: run this suite alone.
# Usage: PILOT_PGHOST=/private/tmp/<socket-dir> PILOT_PGPORT=<port> PILOT_PGSUPER=<local superuser> \
#        supabase/tests/x_account_stage3b_acl_adverse_run.sh
set -euo pipefail

host="${PILOT_PGHOST:?PILOT_PGHOST (local socket dir) required}"
port="${PILOT_PGPORT:?PILOT_PGPORT required}"
super="${PILOT_PGSUPER:?PILOT_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PILOT_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

owner="kb_refresh_pilot_owner"
prefix="kb_s3b_acl_$$"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
completion="$migrations/20261006160000_vault_account_brand_post_completion.sql"
reader="$migrations/20261006160100_social_mobile_publish_settings_reader.sql"
authority="$migrations/20261006160200_x_account_publish_authority.sql"
psql_bin="${PSQL:-psql}"
base=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port")
as_super=("${base[@]}" -U "$super")
tpl="${prefix}_tpl"

q() { local user="$1" db="$2"; shift 2; "${base[@]}" -A -t -U "$user" -d "$db" "$@"; }
cleanup() {
  local name
  for name in $("${as_super[@]}" -A -t -d postgres -c "select datname from pg_database where datname like '${prefix}\_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $name with (force)" >/dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "revoke service_role from authenticated" >/dev/null 2>&1 || true
  for name in $("${as_super[@]}" -A -t -d postgres -c "select rolname from pg_roles where rolname like '${prefix}\_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop role if exists $name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

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
create database $tpl owner $owner;
SQL
# A clean application role graph is a precondition of this suite (memberships are cluster-wide).
[[ "$(q "$super" postgres -c "select pg_has_role('authenticated', 'service_role', 'usage') or pg_has_role('anon', 'service_role', 'usage')")" == f ]] \
  || fail "cluster role graph not clean before the suite"

q "$owner" "$tpl" -f "$here/x_account_refresh_core_fixture.sql" >/dev/null
q "$owner" "$tpl" -f "$here/x_account_stage3b_base_fixture.sql" >/dev/null
q "$owner" "$tpl" -1 -f "$migrations/20260922045046_social_mobile_content_settings_candidate.sql" \
  -f "$migrations/20261003120000_social_mobile_content_settings_hardening.sql" >/dev/null
q "$owner" "$tpl" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql" >/dev/null
q "$owner" "$tpl" -f "$migrations/20260926032054_x_account_refresh_rollout_authority.sql" >/dev/null

# new_db <case> <stage>: a fresh clone. stage: base (before completion) | reader (completion applied) |
# authority (completion + reader applied).
new_db() {
  local db="${prefix}_$1"
  "${as_super[@]}" -d postgres -c "create database $db template $tpl owner $owner" >/dev/null
  case "$2" in
    base) ;;
    reader) q "$owner" "$db" -f "$completion" >/dev/null ;;
    authority) q "$owner" "$db" -f "$completion" >/dev/null; q "$owner" "$db" -f "$reader" >/dev/null ;;
    *) fail "unknown stage $2" ;;
  esac
  echo "$db"
}
new_role() { local role="${prefix}_$1"; "${as_super[@]}" -d postgres -c "create role $role nologin" >/dev/null; echo "$role"; }

# Catalog fingerprint of everything a refused migration could have touched: default ACLs, every public
# routine/relation with its ACL, column ACLs, and the application-role graph.
snapshot() {
  q "$super" "$1" -c "select md5(concat_ws('#',
    (select string_agg(concat_ws(':', defaclrole::regrole, defaclnamespace, defaclobjtype, defaclacl), '|' order by 1) from pg_default_acl),
    (select string_agg(concat_ws(':', p.oid::regprocedure, p.prokind, p.proowner::regrole, p.proacl), '|' order by 1)
       from pg_proc p where p.pronamespace = 'public'::regnamespace),
    (select string_agg(concat_ws(':', c.relname, c.relkind, c.relowner::regrole, c.relacl), '|' order by 1)
       from pg_class c where c.relnamespace = 'public'::regnamespace),
    (select string_agg(concat_ws(':', a.attrelid::regclass, a.attname, a.attacl), '|' order by 1)
       from pg_attribute a join pg_class c on c.oid = a.attrelid
       where c.relnamespace = 'public'::regnamespace and a.attacl is not null),
    (select string_agg(concat_ws(':', m.roleid::regrole, m.member::regrole), '|' order by 1) from pg_auth_members m
       where m.member in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole))))"
}
STAGE3B_NAMES="'complete_vault_account_brand_post', 'read_social_mobile_publish_settings', 'check_x_account_publish_authority', 'set_x_account_publish_authority'"
objects_present() {
  q "$super" "$1" -c "select string_agg(proname, ',' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ($STAGE3B_NAMES)"
}

# refuse <case> <db> <apply-as> <file> <expected code> <expected objects after>: apply must fail with the
# code, leave the catalog fingerprint unchanged and leave exactly the expected Stage 3B routines.
refuse() {
  local name="$1" db="$2" user="$3" file="$4" code="$5" expected="$6" before after out
  before="$(snapshot "$db")"
  if out="$(q "$user" "$db" -f "$file" 2>&1)"; then fail "$name: migration applied despite the drift"; fi
  grep -q -- "$code" <<<"$out" || fail "$name: wrong refusal (want $code): $out"
  after="$(snapshot "$db")"
  [[ "$before" == "$after" ]] || fail "$name: refused migration changed the catalog"
  [[ "$(objects_present "$db")" == "$expected" ]] || fail "$name: unexpected Stage 3B routines after refusal: $(objects_present "$db")"
  [[ "$(q "$super" "$db" -c "select to_regclass('public.x_account_publish_authority') is null")" == t ]] || fail "$name: authority table left behind"
  echo "ACL_ADVERSE_REFUSED $name ($code)"
}

READER_AFTER_COMPLETION="complete_vault_account_brand_post"
AUTHORITY_BEFORE="complete_vault_account_brand_post,read_social_mobile_publish_settings"

# ---------------------------------------------------------------------------------------------------
# R1: effective column privileges on the settings table for service_role (reader migration)
# ---------------------------------------------------------------------------------------------------
db="$(new_db r1_direct_select reader)"
q "$owner" "$db" -c "grant select (settings) on public.social_mobile_content_settings to service_role" >/dev/null
refuse r1_direct_column_select "$db" "$owner" "$reader" PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS "$READER_AFTER_COMPLETION"
# The drift is reported, not repaired: the grant is still there.
[[ "$(q "$super" "$db" -c "select has_column_privilege('service_role', 'public.social_mobile_content_settings', 'settings', 'SELECT')")" == t ]] \
  || fail "r1_direct_column_select: drift was silently normalized"

role="$(new_role r1_col)"
db="$(new_db r1_inherited_select reader)"
q "$owner" "$db" -c "grant select (persona_profile) on public.social_mobile_content_settings to $role" >/dev/null
"${as_super[@]}" -d postgres -c "grant $role to service_role" >/dev/null
refuse r1_inherited_column_select "$db" "$owner" "$reader" PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS "$READER_AFTER_COMPLETION"
"${as_super[@]}" -d postgres -c "revoke $role from service_role" >/dev/null

db="$(new_db r1_public_select reader)"
q "$owner" "$db" -c "grant select (brand_id) on public.social_mobile_content_settings to public" >/dev/null
refuse r1_public_column_select "$db" "$owner" "$reader" PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS "$READER_AFTER_COMPLETION"

db="$(new_db r1_column_update reader)"
q "$owner" "$db" -c "grant update (persona_confirmed) on public.social_mobile_content_settings to service_role" >/dev/null
refuse r1_column_update "$db" "$owner" "$reader" PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS "$READER_AFTER_COMPLETION"

db="$(new_db r1_column_insert reader)"
q "$owner" "$db" -c "grant insert (brand_id, settings) on public.social_mobile_content_settings to service_role" >/dev/null
refuse r1_column_insert "$db" "$owner" "$reader" PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS "$READER_AFTER_COMPLETION"

db="$(new_db r1_column_references reader)"
q "$owner" "$db" -c "grant references (brand_id) on public.social_mobile_content_settings to service_role" >/dev/null
refuse r1_column_references "$db" "$owner" "$reader" PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS "$READER_AFTER_COMPLETION"

db="$(new_db r1_table_delete reader)"
q "$owner" "$db" -c "grant delete on public.social_mobile_content_settings to service_role" >/dev/null
refuse r1_table_delete "$db" "$owner" "$reader" PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS "$READER_AFTER_COMPLETION"

# Clean graph: applies, and authenticated's PR81 client privileges are exactly as before.
db="$(new_db r1_clean reader)"
auth_before="$(q "$super" "$db" -c "select string_agg(a.attname || ':' || has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT') || has_column_privilege('authenticated', a.attrelid, a.attnum, 'INSERT') || has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE'), ',' order by a.attnum) || '|' || (select relacl::text from pg_class where oid = 'public.social_mobile_content_settings'::regclass) from pg_attribute a where a.attrelid = 'public.social_mobile_content_settings'::regclass and a.attnum > 0 and not a.attisdropped")"
q "$owner" "$db" -f "$reader" >/dev/null || fail "r1_clean: clean reader refused"
auth_after="$(q "$super" "$db" -c "select string_agg(a.attname || ':' || has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT') || has_column_privilege('authenticated', a.attrelid, a.attnum, 'INSERT') || has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE'), ',' order by a.attnum) || '|' || (select relacl::text from pg_class where oid = 'public.social_mobile_content_settings'::regclass) from pg_attribute a where a.attrelid = 'public.social_mobile_content_settings'::regclass and a.attnum > 0 and not a.attisdropped")"
[[ "$auth_before" == "$auth_after" ]] || fail "r1_clean: authenticated client privileges changed"
[[ "$auth_after" == *"settings:truetruetrue"* ]] || fail "r1_clean: authenticated lost its PR81 privileges: $auth_after"
echo "ACL_ADVERSE_CLEAN r1_reader (authenticated PR81 privileges unchanged)"

# ---------------------------------------------------------------------------------------------------
# R2: privileged routines of the completion and publish-authority migrations
# ---------------------------------------------------------------------------------------------------
# r2_cases <target> <file> <stage> <objects-before> <overload-sql> <procedure-sql> <direct-acl-code> <owner-code> <graph-code>
r2_cases() {
  local t="$1" file="$2" stage="$3" objs="$4" overload="$5" procedure="$6" acl="$7" ocode="$8" gcode="$9" db role creator

  role="$(new_role "${t}_unk")"
  db="$(new_db "${t}_unknown_default" "$stage")"
  q "$owner" "$db" -c "alter default privileges in schema public grant execute on functions to $role" >/dev/null
  refuse "${t}_unknown_default_execute" "$db" "$owner" "$file" "$acl" "$objs"

  role="$(new_role "${t}_unk_auth")"
  db="$(new_db "${t}_auth_inherits_unknown" "$stage")"
  q "$owner" "$db" -c "alter default privileges in schema public grant execute on functions to $role" >/dev/null
  "${as_super[@]}" -d postgres -c "grant $role to authenticated" >/dev/null
  refuse "${t}_authenticated_inherits_unknown" "$db" "$owner" "$file" "$acl" "$objs"
  "${as_super[@]}" -d postgres -c "revoke $role from authenticated" >/dev/null

  role="$(new_role "${t}_unk_anon")"
  db="$(new_db "${t}_anon_inherits_unknown" "$stage")"
  q "$owner" "$db" -c "alter default privileges in schema public grant execute on functions to $role" >/dev/null
  "${as_super[@]}" -d postgres -c "grant $role to anon" >/dev/null
  refuse "${t}_anon_inherits_unknown" "$db" "$owner" "$file" "$acl" "$objs"
  "${as_super[@]}" -d postgres -c "revoke $role from anon" >/dev/null

  role="$(new_role "${t}_unk_opt")"
  db="$(new_db "${t}_grant_option_unknown" "$stage")"
  q "$owner" "$db" -c "alter default privileges in schema public grant execute on functions to $role with grant option" >/dev/null
  refuse "${t}_grant_option_unknown" "$db" "$owner" "$file" "$acl" "$objs"

  db="$(new_db "${t}_overload" "$stage")"
  q "$owner" "$db" -c "$overload" >/dev/null
  refuse "${t}_overload_collision" "$db" "$owner" "$file" _PRECONDITION_ALREADY_APPLIED "$(objects_present "$db")"

  db="$(new_db "${t}_procedure" "$stage")"
  q "$owner" "$db" -c "$procedure" >/dev/null
  refuse "${t}_procedure_collision" "$db" "$owner" "$file" _PRECONDITION_ALREADY_APPLIED "$(objects_present "$db")"

  db="$(new_db "${t}_superuser" "$stage")"
  refuse "${t}_superuser_creator" "$db" "$super" "$file" "$ocode" "$objs"

  creator="${prefix}_${t}_creator"
  "${as_super[@]}" -d postgres -c "create role $creator login nosuperuser" >/dev/null
  db="$(new_db "${t}_non_owner" "$stage")"
  "${as_super[@]}" -d "$db" -c "grant usage, create on schema public to $creator" >/dev/null
  refuse "${t}_non_owner_creator" "$db" "$creator" "$file" "$ocode" "$objs"
  "${as_super[@]}" -d "$db" -c "revoke usage, create on schema public from $creator" >/dev/null

  db="$(new_db "${t}_auth_inherits_service" "$stage")"
  "${as_super[@]}" -d postgres -c "grant service_role to authenticated" >/dev/null
  refuse "${t}_authenticated_inherits_service_role" "$db" "$owner" "$file" "$gcode" "$objs"
  "${as_super[@]}" -d postgres -c "revoke service_role from authenticated" >/dev/null

  # (authenticated inheriting the owner cannot be built here: the fixture owner is already a member of
  # authenticated and PostgreSQL refuses circular membership; the migrations still check it.)
}

r2_cases completion "$completion" base "" \
  "create function public.complete_vault_account_brand_post(p uuid) returns integer language sql as 'select 1'" \
  "create procedure public.complete_vault_account_brand_post() language sql as 'select 1'" \
  STAGE3B_COMPLETION_EFFECTIVE_ACL:DIRECT_ACL STAGE3B_PRECONDITION_OWNER STAGE3B_PRECONDITION_ROLE_GRAPH

r2_cases authority "$authority" authority "$AUTHORITY_BEFORE" \
  "create function public.set_x_account_publish_authority(p text) returns text language sql as 'select p'" \
  "create procedure public.check_x_account_publish_authority() language sql as 'select 1'" \
  STAGE3B_PUBLISH_EFFECTIVE_ACL:ROUTINE_DIRECT_ACL STAGE3B_PUBLISH_PRECONDITION_OWNER STAGE3B_PUBLISH_PRECONDITION_ROLE_GRAPH

# The reader's own routine gets the same matrix (its R1 column checks are above).
r2_cases reader "$reader" reader "$READER_AFTER_COMPLETION" \
  "create function public.read_social_mobile_publish_settings(p uuid) returns integer language sql as 'select 1'" \
  "create procedure public.read_social_mobile_publish_settings() language sql as 'select 1'" \
  PUBLISH_SETTINGS_READER_POSTCONDITION_FAILED PUBLISH_SETTINGS_READER_PRECONDITION_OWNER PUBLISH_SETTINGS_READER_PRECONDITION_ROLE_GRAPH

# The authority table: an unknown default table grant (inherited by authenticated) refuses too.
role="$(new_role authority_tbl_unk)"
db="$(new_db authority_table_default authority)"
q "$owner" "$db" -c "alter default privileges in schema public grant insert, update on tables to $role" >/dev/null
"${as_super[@]}" -d postgres -c "grant $role to authenticated" >/dev/null
refuse authority_table_unknown_default_dml "$db" "$owner" "$authority" STAGE3B_PUBLISH_EFFECTIVE_ACL:TABLE_DIRECT_ACL "$AUTHORITY_BEFORE"
"${as_super[@]}" -d postgres -c "revoke $role from authenticated" >/dev/null

# Grant option to a known role is normalized by the explicit revoke/grant: the result is plain EXECUTE.
db="$(new_db completion_service_grant_option base)"
q "$owner" "$db" -c "alter default privileges in schema public grant execute on functions to service_role with grant option" >/dev/null
q "$owner" "$db" -f "$completion" >/dev/null || fail "completion_service_grant_option: refused"
[[ "$(q "$super" "$db" -c "select bool_or(a.is_grantable) from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.complete_vault_account_brand_post(uuid,text,text,text)'::regprocedure and a.grantee = 'service_role'::regrole")" == f ]] \
  || fail "completion_service_grant_option: grant option survived"
echo "ACL_ADVERSE_NORMALIZED completion_service_role_grant_option (plain EXECUTE only)"

# ---------------------------------------------------------------------------------------------------
# Clean graph: intended permissions only; authenticated refused, service_role works.
# ---------------------------------------------------------------------------------------------------
db="$(new_db clean_graph authority)"
q "$owner" "$db" -f "$authority" >/dev/null || fail "clean_graph: authority refused"
q "$owner" "$db" <<'SQL' >/dev/null || fail "clean_graph: fixture"
update public.brands set is_active = true, publish_mode = 'live' where id = 'u_pilot';
insert into public.brand_settings (brand_id, enabled_post_types) values ('u_pilot', '["brand_post"]');
update public.social_accounts set connection_status = 'identity_verified', publish_enabled = true where id = 'sa_pilot';
SQL
post="$(q "$owner" "$db" -c "insert into public.scheduled_posts (brand_id, post_type, status, attempt_count, started_at) values ('u_pilot', 'brand_post', 'running', 1, now()) returning id" | head -1)"
[[ "$post" =~ ^[0-9a-f-]{36}$ ]] || fail "clean_graph: no running post"
expect_denied() {
  local out
  if out="$(q "$owner" "$db" -c "set role $1; $2" 2>&1)"; then fail "clean_graph: $1 was allowed: $2"; fi
  grep -q "permission denied" <<<"$out" || fail "clean_graph: $1 refused for another reason: $out"
}
for app in authenticated anon; do
  expect_denied "$app" "select public.set_x_account_publish_authority('sa_pilot', 'enabled', 'ADVERSE_AUTH', now(), now() + interval '1 day')"
  expect_denied "$app" "select * from public.complete_vault_account_brand_post('$post', 'sa_pilot', '123456', repeat('a', 64))"
  expect_denied "$app" "select public.check_x_account_publish_authority('$post', 'sa_pilot', 'u_pilot')"
  expect_denied "$app" "select * from public.read_social_mobile_publish_settings('$post', 'u_pilot')"
  expect_denied "$app" "insert into public.x_account_publish_authority (social_account_id, state, reason_code) values ('sa_pilot', 'off', 'X')"
done
[[ "$(q "$super" "$db" -c "select count(*) from public.x_account_publish_authority")" == 0 ]] || fail "clean_graph: app role wrote authority"
[[ "$(q "$super" "$db" -c "select status from public.scheduled_posts where id = '$post'")" == running ]] || fail "clean_graph: app role completed a post"
[[ "$(q "$owner" "$db" -c "set role service_role; select public.set_x_account_publish_authority('sa_pilot', 'enabled', 'ACL_CLEAN', now() - interval '1 minute', now() + interval '1 day')")" == enabled ]] \
  || fail "clean_graph: service_role setter"
expect_denied service_role "update public.x_account_publish_authority set state = 'off'"
[[ "$(q "$owner" "$db" -c "set role service_role; select fingerprint_persisted from public.complete_vault_account_brand_post('$post', 'sa_pilot', '123456', repeat('a', 64))")" == t ]] \
  || fail "clean_graph: service_role completion"
echo "ACL_ADVERSE_CLEAN graph (app roles refused on setter/completion/check/reader/table; service_role works)"

cleanup
[[ "$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname like '${prefix}\_%'")" == 0 ]] || fail "cleanup left databases"
[[ "$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_roles where rolname like '${prefix}\_%'")" == 0 ]] || fail "cleanup left roles"
[[ "$("${as_super[@]}" -A -t -d postgres -c "select pg_has_role('authenticated', 'service_role', 'usage') or pg_has_role('anon', 'service_role', 'usage')")" == f ]] \
  || fail "cleanup left an application role graph change"
echo "STAGE3B_ACL_ADVERSE_PASS"
