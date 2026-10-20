#!/usr/bin/env bash
# G3 TASK 15/50: review evidence for the PR #370 candidate (001_brand_memberships_api_privilege_revoke.sql, UNCHANGED) on a THROW-AWAY
# LOCAL PostgreSQL 17 with fake data, for the limited Codex Sol (high) review. It adds only what brand_memberships_privileges_run.sh
# (PR #370) does not print:
#   E1  the full effective-privilege matrix BEFORE and AFTER, per role (API roles, a role that inherits authenticated / service_role,
#       authenticator, PUBLIC, the owner) x privilege (SELECT .. MAINTAIN), plus role attributes (LOGIN, INHERIT, BYPASSRLS, SUPERUSER),
#       the membership edges with their INHERIT / SET / ADMIN options, RLS enabled / forced, and the owner's default ACL
#   E2  DENIAL probes AFTER the candidate only, with the expected SQLSTATE: the statement must be refused (42501) for the role; no probe
#       is run BEFORE the candidate and no probe can succeed into a change (each runs in a transaction that is rolled back; the trigger
#       probe names a function that does not exist). REFERENCES stays catalog-only (see E2)
#   E3  what stays (catalog only, never exercised): MAINTAIN for authenticated, TRUNCATE / REFERENCES / MAINTAIN for service_role, the
#       owner's RLS bypass (RLS not forced), the default ACL that a re-created table would get again
# Read-only towards G5: no G5 file is used here (the apply order with G5 is PR #370's O1-O4).
#   BM_PGHOST=/private/tmp/<socket> BM_PGPORT=<port> BM_PGSUPER=<local superuser> bash brand_memberships_acl_evidence_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${BM_PGHOST:?BM_PGHOST required}"; port="${BM_PGPORT:?BM_PGPORT required}"; super="${BM_PGSUPER:?BM_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: BM_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"
cand="${BM_CANDIDATE:-$here/001_brand_memberships_api_privilege_revoke.sql}"
n="$$"; owner="kb_bmacl_owner_$n"; db="kabumori_bmacl_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

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
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
val() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }

# The same model baseline as PR #370's runner (fake fixture with the platform-like default table privileges [A], the X onboarding RPC,
# the deletion candidate, the REAL membership migration 20260918120000).
own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
own -f "$m/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
own -f "$m/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null

ROLES="array['anon','authenticated','kb_cal_auth_child','service_role','kb_cal_svc_child','authenticator','public','$owner']"
PRIVS="array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']"
matrix() { val -c "select string_agg(case when r = '$owner' then 'OWNER' else r end || ' ' || (select string_agg(case when has_table_privilege(r, 'public.brand_memberships', p) then substr(p, 1, 3) else '---' end, ' ' order by o)
  from unnest($PRIVS) with ordinality x(p, o)), E'\n' order by ro) from unnest($ROLES) with ordinality y(r, ro)"; }
attrs() { val -c "select string_agg(case when rolname = '$owner' then 'OWNER' else rolname end || ' login=' || rolcanlogin || ' inherit=' || rolinherit || ' bypassrls=' || rolbypassrls || ' super=' || rolsuper, E'\n' order by rolname)
  from pg_roles where rolname = any($ROLES)"; }
edges() { val -c "select coalesce(string_agg(case when m.rolname = '$owner' then 'OWNER' else m.rolname end || ' member-of ' || r.rolname || ' inherit=' || a.inherit_option || ' set=' || a.set_option || ' admin=' || a.admin_option, E'\n' order by 1), '(none)')
  from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
  where r.rolname = any($ROLES) and m.rolname = any($ROLES)"; }
rls() { val -c "select 'rls_enabled=' || relrowsecurity || ' rls_forced=' || relforcerowsecurity || ' policies=' || (select count(*) from pg_policy where polrelid = c.oid) from pg_class c where c.oid = 'public.brand_memberships'::regclass"; }
defacl() { val -c "select coalesce(string_agg(coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text || ' ' || array_to_string(d.defaclacl, ','), E'\n'), '(none)') from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  where d.defaclrole = (select oid from pg_roles where rolname = '$owner')" | sed "s/$owner/OWNER/g"; }
section() { echo; echo "=== $1"; }

section "E1 BEFORE (catalog only): effective privileges (SEL INS UPD DEL TRU REF TRI MAI)"; BEFORE="$(matrix)"; echo "$BEFORE"
section "E1 role attributes"; attrs
section "E1 membership edges between these roles (PG16+ options; other test owners in the shared cluster are members OF the API roles, which gives the API roles nothing)"; edges
section "E1 RLS"; rls
section "E1 owner's default ACL (what a re-created table would get)"; defacl

own -f "$cand" >/dev/null

section "E1 AFTER the PR #370 candidate: effective privileges"; AFTER="$(matrix)"; echo "$AFTER"
section "E1 RLS after"; rls
expect_after="anon --- --- --- --- --- --- --- ---
authenticated SEL --- --- --- --- --- --- MAI
kb_cal_auth_child SEL --- --- --- --- --- --- MAI
service_role SEL INS UPD DEL TRU REF --- MAI
kb_cal_svc_child SEL INS UPD DEL TRU REF --- MAI
authenticator --- --- --- --- --- --- --- ---
public --- --- --- --- --- --- --- ---
OWNER SEL INS UPD DEL TRU REF TRI MAI"
[[ "$AFTER" == "$expect_after" ]] || fail "E1 the AFTER matrix differs:
$AFTER"
expect_before="anon --- --- --- --- --- --- --- ---
authenticated SEL --- --- --- TRU REF TRI MAI
kb_cal_auth_child SEL --- --- --- TRU REF TRI MAI
service_role SEL INS UPD DEL TRU REF TRI MAI
kb_cal_svc_child SEL INS UPD DEL TRU REF TRI MAI
authenticator --- --- --- --- --- --- --- ---
public --- --- --- --- --- --- --- ---
OWNER SEL INS UPD DEL TRU REF TRI MAI"
[[ "$BEFORE" == "$expect_before" ]] || fail "E1 the BEFORE matrix differs:
$BEFORE"
echo "PASS E1 matrix: TRIGGER gone for every API role and inheritor; TRUNCATE / REFERENCES gone for anon / authenticated and inheritors; PUBLIC and authenticator hold nothing; residuals listed in E3"

# E2 denial probes, AFTER only. Each: BEGIN; SET LOCAL ROLE <role>; <statement>; ROLLBACK -- the statement must fail with the SQLSTATE.
probe() {
  local role="$1" stmt="$2" want="$3" as="${4:-$owner}" out got
  out="$(psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -h "$host" -p "$port" -U "$as" -d "$db" -c "begin" -c "set local role $role" -c "$stmt" -c "rollback" 2>&1 || true)"
  got="$(sed -n 's/^.*ERROR: *\([0-9A-Z]\{5\}\):.*$/\1/p' <<<"$out" | head -1)"
  [[ "$got" == "$want" ]] || fail "E2 $role: [$stmt] expected $want, got [${got:-ALLOWED}]"
  printf '  %-18s %-6s %s\n' "$role" "$got" "$stmt"
  if [[ "$want" == 42501 ]]; then DENIES=$((DENIES + 1)); else CONTROLS=$((CONTROLS + 1)); fi
}
DENIES=0; CONTROLS=0
TRIG="create trigger g3_acl_probe before insert on public.brand_memberships for each row execute function pg_catalog.g3_acl_probe_no_such_function()"
# REFERENCES is checked in the catalog only (E1): a temp table may not reference a permanent one (42P16), and a permanent probe table would
# need CREATE on a schema, i.e. a privilege this evidence must not add.
section "E2 DENIAL probes after the candidate (role, SQLSTATE, statement)"
for role in authenticated kb_cal_auth_child; do
  probe "$role" "insert into public.brand_memberships (brand_id, user_id, role) values ('x', gen_random_uuid(), 'owner')" 42501
  probe "$role" "update public.brand_memberships set role = 'owner'" 42501
  probe "$role" "delete from public.brand_memberships" 42501
  probe "$role" "truncate public.brand_memberships" 42501
  probe "$role" "$TRIG" 42501
done
for role in anon; do
  probe "$role" "select 1 from public.brand_memberships limit 1" 42501
  probe "$role" "truncate public.brand_memberships" 42501
  probe "$role" "$TRIG" 42501
done
for role in service_role kb_cal_svc_child; do
  probe "$role" "$TRIG" 42501
done
probe authenticator "select 1 from public.brand_memberships limit 1" 42501 "$super"
probe authenticator "$TRIG" 42501 "$super"
# The control: the owner holds TRIGGER, so the same probe passes the privilege check and stops at the missing function (42883)
probe "$owner" "$TRIG" 42883
[[ "$(matrix)" == "$AFTER" ]] || fail "E2 the probes changed the catalog"
[[ "$(val -c "select count(*) from pg_trigger where tgrelid = 'public.brand_memberships'::regclass and tgname = 'g3_acl_probe'")" == "0" ]] || fail "E2 a probe left a trigger"
[[ "$DENIES" == 17 && "$CONTROLS" == 1 ]] || fail "E2 probe count: $DENIES denials + $CONTROLS controls (expected 17 + 1)"
echo "PASS E2 $((DENIES + CONTROLS)) probes = $DENIES denials (42501) after the candidate + $CONTROLS owner control (42883: privilege passed, no such function); nothing changed"

section "E3 what stays after the candidate (catalog only, never exercised)"
echo "  authenticated / kb_cal_auth_child: SELECT (RLS self-select) + MAINTAIN (PG17: VACUUM / ANALYZE / LOCK / REINDEX / CLUSTER)"
echo "  service_role / kb_cal_svc_child: SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES MAINTAIN, BYPASSRLS=$(val -c "select rolbypassrls from pg_roles where rolname = 'service_role'")"
echo "  owner: everything; RLS forced=$(val -c "select relforcerowsecurity from pg_class where oid = 'public.brand_memberships'::regclass") (the owner and definer functions it owns bypass RLS)"
echo "  default ACL of the owner (a re-created table gets it again):"; defacl | sed 's/^/    /'
[[ "$(val -c "select has_table_privilege('authenticated', 'public.brand_memberships', 'MAINTAIN')")" == "t" ]] || fail "E3 MAINTAIN residual not as recorded"
echo "PASS E3 residuals recorded"

echo "BRAND_MEMBERSHIPS_ACL_EVIDENCE_ALL_PASS"
