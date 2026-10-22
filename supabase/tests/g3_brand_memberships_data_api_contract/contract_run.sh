#!/usr/bin/env bash
# G3 TASK 23/50 (Issue #318): offline regression CONTRACT for public.brand_memberships under the Supabase Data API default-grant change
# of 2026-10-30, on a THROW-AWAY LOCAL PostgreSQL 17 with fake roles and fake rows. Nothing here is a migration or a source candidate;
# no product file is changed; nothing connects to a managed or production database.
#
# Three models of the table owner's default privileges in schema public (the owner stands for the project's `postgres`):
#   pre    defaults grant ALL on new tables to anon / authenticated / service_role (today's platform model)
#   postA  defaults grant nothing (the changelog's documented change)
#   postB  defaults keep only TRUNCATE / REFERENCES / TRIGGER / MAINTAIN (a commenter's unconfirmed report; G3-20 section 1)
# In each world the table is rebuilt from its migration's DDL (20260918120000, lines 41-66, read from the repository), then:
#   R  records what that DDL alone gives (current behaviour; NOT the contract)
#   C  applies contract_delta.sql (test-only model of the proposed minimum: revoke all, grant SELECT to authenticated) and checks
#      the contract; the paths that must keep working without any service_role table privilege; the negatives; PR #370's 001
# Catalog queries, safe normal paths and denial probes only (expected SQLSTATE); no privilege is used to read another person's data.
#
#   G3C_PGHOST=/private/tmp/<socket> G3C_PGPORT=<port> G3C_PGSUPER=<local superuser> bash contract_run.sh
# Optional: G3C_CONTRACT (another contract file: the mutation check), G3C_PR370_REV (default 547d9f920b124c9af286408eca696b10c67efe79).
# Roles are cluster-wide (anon / authenticated / service_role / authenticator are created when missing): run alone.
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${G3C_PGHOST:?G3C_PGHOST required}"; port="${G3C_PGPORT:?G3C_PGPORT required}"; super="${G3C_PGSUPER:?G3C_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: G3C_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
contract="${G3C_CONTRACT:-$here/contract_delta.sql}"
rev="${G3C_PR370_REV:-547d9f920b124c9af286408eca696b10c67efe79}"
n="$$"; owner="g3c_owner_$n"; nobody="g3c_nobody_$n"; authadm="g3c_authadm_$n"; prefix="g3c_$n"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/g3c.XXXXXX)"
cleanup() {
  local d
  rm -rf "$tmp"
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" -c "drop role if exists $nobody" -c "drop role if exists $authadm" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }
expect() { [ "$2" = "$3" ] || fail "$1: expected [$3] got [$2]"; }

# the table's DDL exactly as its migration states it (no edit): create table, index, RLS, grants, the self-select policy
mig="$repo/supabase/migrations/20260918120000_social_mobile_brand_memberships.sql"
sed -n '41,66p' "$mig" >"$tmp/ddl.sql"
head -1 "$tmp/ddl.sql" | grep -q '^create table if not exists public.brand_memberships (' || fail "the migration's DDL moved (line 41)"
grep -q 'using ((select auth.uid()) = user_id);' "$tmp/ddl.sql" || fail "the migration's DDL moved (policy end, line 66)"
git -C "$repo" show "$rev:supabase/candidates/postona_brand_memberships_privileges/001_brand_memberships_api_privilege_revoke.sql" >"$tmp/001.sql"

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb;
grant anon, authenticated, service_role to $owner;   -- only so the owner's test session can SET ROLE to each API role
create role $nobody login nosuperuser;               -- holds nothing: stands for PUBLIC
create role $authadm login nosuperuser;              -- stands for the Auth admin: may delete auth.users rows, nothing else
SQL
own() { local d="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
val() { local d="$1"; shift; psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" "$@"; }
# run one statement as an API role; print "ok" or the SQLSTATE
as_role() { local d="$1" role="$2" sql="$3" sub="${4:-}"
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$d" -v VERBOSITY=sqlstate -c "begin" -c "set local role $role" \
    -c "select set_config('request.jwt.claim.sub', '$sub', true)" -c "$sql" -c "commit" >"$tmp/as.out" 2>&1 \
    && echo ok || { grep -o -E 'ERROR: +[0-9A-Z]{5}' "$tmp/as.out" | head -1 | awk '{print $2}'; }; }
P="array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']"
priv() { val "$1" -c "select string_agg(r || '=' || coalesce((select string_agg(p, ',' order by p) from unnest($P) p
  where has_table_privilege(r, 'public.brand_memberships', p)), '-'), ' ' order by r) from unnest(array['anon','authenticated','service_role']) r"; }
acl() { val "$1" -c "select coalesce(array_to_string(relacl, ','), 'NULL') from pg_class where oid = 'public.brand_memberships'::regclass"; }
public_items() { val "$1" -c "select count(*) from pg_class c, aclexplode(c.relacl) e where c.oid = 'public.brand_memberships'::regclass and e.grantee = 0"; }
colacl() { val "$1" -c "select count(*) from pg_attribute where attrelid = 'public.brand_memberships'::regclass and attacl is not null"; }

u1=00000000-0000-4000-8000-0000000000a1; u2=00000000-0000-4000-8000-0000000000b2; u3=00000000-0000-4000-8000-0000000000c3
# world: base objects that exist before the rebuild (created under the pre defaults: existing tables keep their grants), then the
# world's defaults, then the table's DDL; "contract" applies the contract on top
# (each call makes its own database; errexit does not reach into $(...), so every step checks its own status -- mk() fails the run)
build() { local w="$1" with_contract="$2" d; d="${prefix}_$(printf '%s' "$1" | tr 'A-Z' 'a-z')_${2}_$RANDOM"   # unquoted names fold to lower case
  "${S[@]}" -d postgres -c "create database $d owner $owner" >/dev/null || return 1
  own "$d" >/dev/null <<SQL || return 1
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema auth to $authadm;
grant select, delete on auth.users to $authadm;
create table public.brands (id text primary key);
SQL
  case "$w" in
    pre)   ;;
    postA) own "$d" -c "alter default privileges in schema public revoke all on tables from anon, authenticated, service_role" >/dev/null || return 1 ;;
    postB) own "$d" -c "alter default privileges in schema public revoke all on tables from anon, authenticated, service_role" \
                   -c "alter default privileges in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role" >/dev/null || return 1 ;;
  esac
  own "$d" -f "$tmp/ddl.sql" >/dev/null || return 1
  if [ "$with_contract" = contract ]; then own "$d" -f "$contract" >/dev/null || return 1; fi
  echo "$d"; }
mk() { local d; d="$(build "$1" "$2")" || fail "build $1 $2 failed"; [ -n "$d" ] || fail "build $1 $2: no database"; echo "$d"; }
# the ACL as a sorted set of items (aclitem order carries no meaning; PR #370's rollback also compares with aclexplode)
aclset() { val "$1" -c "select coalesce(string_agg(x, ',' order by x), 'NULL') from (select unnest(relacl)::text as x from pg_class where oid = 'public.brand_memberships'::regclass) s"; }

# ---- R: what the migration's DDL alone gives in each world (recorded, NOT the contract) ----
R_pre="anon=- authenticated=MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE service_role=DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"
R_postA="anon=- authenticated=SELECT service_role=-"
R_postB="anon=- authenticated=MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE service_role=MAINTAIN,REFERENCES,TRIGGER,TRUNCATE"
for w in pre postA postB; do
  d="$(mk "$w" ddl)"; want="R_$w"
  expect "R $w privileges of the DDL alone" "$(priv "$d")" "${!want}"
  echo "R $w PUBLIC items: $(public_items "$d")"
done
pass "R the migration's DDL alone depends on the defaults: pre gives service_role all 8 and authenticated TRIGGER/TRUNCATE/REFERENCES; postA leaves service_role nothing; postB leaves TRIGGER/TRUNCATE/REFERENCES/MAINTAIN"

# ---- C: the contract in each world ----
CONTRACT="anon=- authenticated=SELECT service_role=-"
acls=()
for w in pre postA postB; do
  d="$(mk "$w" contract)"
  # C1 the ACL: same in every world, nothing for anon / PUBLIC / service_role, SELECT only for authenticated, no column ACL
  expect "C1 $w privileges" "$(priv "$d")" "$CONTRACT"
  expect "C1 $w PUBLIC items" "$(public_items "$d")" "0"
  expect "C1 $w column ACLs" "$(colacl "$d")" "0"
  acls+=("$(acl "$d" | sed "s/$owner/OWNER/g")")
  # rows (written by the owner, as the definer RPCs and the deletion saga do)
  own "$d" >/dev/null <<SQL
insert into auth.users values ('$u1'), ('$u2'), ('$u3');
insert into public.brands values ('b1'), ('b2'), ('blocked_b3');
insert into public.brand_memberships (brand_id, user_id, role) values ('b1', '$u1', 'owner'), ('b2', '$u2', 'owner');
-- test-local models of the table-owner write paths (NOT the product functions): a SECURITY DEFINER writer with EXECUTE for
-- service_role only, its INVOKER twin (the negative), and a DEFINER guard trigger like the deletion guard
create function public.g3c_join(p_brand text, p_user uuid) returns void language sql security definer set search_path = ''
  as \$\$ insert into public.brand_memberships (brand_id, user_id, role) values (p_brand, p_user, 'member') \$\$;
create function public.g3c_join_invoker(p_brand text, p_user uuid) returns void language sql security invoker set search_path = ''
  as \$\$ insert into public.brand_memberships (brand_id, user_id, role) values (p_brand, p_user, 'member') \$\$;
revoke all on function public.g3c_join(text, uuid), public.g3c_join_invoker(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.g3c_join(text, uuid), public.g3c_join_invoker(text, uuid) to service_role;
create function public.g3c_guard() returns trigger language plpgsql security definer set search_path = '' as \$\$
begin
  if new.brand_id like 'blocked%' then raise exception 'G3C_GUARD_BLOCKED'; end if;
  return new;
end \$\$;
revoke all on function public.g3c_guard() from public, anon, authenticated, service_role;
create trigger g3c_guard before insert or update on public.brand_memberships for each row execute function public.g3c_guard();
SQL
  # C2 authenticated reads only its own row (RLS); an unknown caller reads nothing
  expect "C2 $w authenticated u1" "$(val "$d" -c "begin" -c "set local role authenticated" -c "select set_config('request.jwt.claim.sub', '$u1', true)" \
    -c "select coalesce(string_agg(brand_id, ',' order by brand_id), '-') from public.brand_memberships" -c "commit" | grep -v '^$' | tail -1)" "b1"
  expect "C2 $w authenticated without a sub" "$(val "$d" -c "begin" -c "set local role authenticated" \
    -c "select count(*) from public.brand_memberships" -c "commit" | grep -v '^$' | tail -1)" "0"
  # C3 anon and PUBLIC are refused (42501)
  expect "C3 $w anon select" "$(as_role "$d" anon "select count(*) from public.brand_memberships")" "42501"
  expect "C3 $w PUBLIC (a role with nothing) select" "$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$nobody" -d "$d" -v VERBOSITY=sqlstate \
    -c "select count(*) from public.brand_memberships" 2>&1 | grep -o -E 'ERROR: +[0-9A-Z]{5}' | head -1 | awk '{print $2}')" "42501"
  expect "C3 $w authenticated insert" "$(as_role "$d" authenticated "insert into public.brand_memberships (brand_id, user_id) values ('b1', '$u1')" "$u1")" "42501"
  # C4 service_role has NO direct table privilege (the contract's assumption, G3-21): select / insert / update / delete / truncate refused
  for s in "select count(*) from public.brand_memberships" "insert into public.brand_memberships (brand_id, user_id) values ('b1', '$u3')" \
           "update public.brand_memberships set role = 'admin' where brand_id = 'b1'" "delete from public.brand_memberships where brand_id = 'b1'" \
           "truncate public.brand_memberships"; do
    expect "C4 $w service_role [$s]" "$(as_role "$d" service_role "$s")" "42501"
  done
  # C5 the table-owner paths still work with no table privilege: the DEFINER writer called by service_role (EXECUTE only)
  expect "C5 $w service_role -> DEFINER writer" "$(as_role "$d" service_role "select public.g3c_join('b1', '$u3')")" "ok"
  expect "C5 $w row written" "$(val "$d" -c "select count(*) from public.brand_memberships where brand_id = 'b1' and user_id = '$u3'")" "1"
  # C5n the negative: the same body as INVOKER is refused for service_role (42501) -- such a function would need a table grant
  expect "C5n $w service_role -> INVOKER twin" "$(as_role "$d" service_role "select public.g3c_join_invoker('b2', '$u3')")" "42501"
  # C6 the DEFINER guard trigger runs (and blocks) under the DEFINER writer
  expect "C6 $w the guard trigger raises (P0001)" "$(as_role "$d" service_role "select public.g3c_join('blocked_b3', '$u3')")" "P0001"
  psql -X -q -A -t -h "$host" -p "$port" -U "$owner" -d "$d" -c "begin" -c "set local role service_role" \
    -c "select public.g3c_join('blocked_b3', '$u3')" -c "rollback" >"$tmp/c6.out" 2>&1 || true
  grep -q G3C_GUARD_BLOCKED "$tmp/c6.out" || fail "C6 $w the guard trigger did not run: $(cat "$tmp/c6.out")"
  # C7 FK cascades run as the child table's owner: service_role deletes a brand (it may: brands is an existing table), the Auth admin
  # deletes a user (privilege on auth.users only); the membership rows go although neither holds anything on brand_memberships
  expect "C7 $w service_role deletes brand b2" "$(as_role "$d" service_role "delete from public.brands where id = 'b2'")" "ok"
  expect "C7 $w Auth admin deletes u1" "$(psql -X -q -A -t -h "$host" -p "$port" -U "$authadm" -d "$d" -v ON_ERROR_STOP=1 -c "delete from auth.users where id = '$u1'" >"$tmp/c7.out" 2>&1 && echo ok || cat "$tmp/c7.out")" "ok"
  expect "C7 $w rows left" "$(val "$d" -c "select coalesce(string_agg(brand_id || ':' || right(user_id::text, 2), ',' order by 1), '-') from public.brand_memberships")" "b1:c3"
  # C8 PR #370's 001 (read at its pinned head) on the contract table: refused with SERVICE_ROLE_DML_LOST, nothing changed (the T-2 dependency)
  before="$(acl "$d")"
  if own "$d" -f "$tmp/001.sql" >"$tmp/001.out" 2>&1; then fail "C8 $w PR #370's 001 applied on the contract table"; fi
  grep -q BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST "$tmp/001.out" || fail "C8 $w wrong refusal: $(grep ERROR "$tmp/001.out" | head -1)"
  expect "C8 $w unchanged" "$(acl "$d")" "$before"
  pass "C $w: ACL = contract; own-row SELECT only; anon / PUBLIC / authenticated-write / every service_role table operation refused (42501); DEFINER writer + guard trigger + FK cascades work without a table grant; INVOKER twin refused; PR #370 001 refuses (SERVICE_ROLE_DML_LOST)"
done
expect "C1 the contract ACL is identical in all three worlds" "$(printf '%s\n' "${acls[@]}" | sort -u | wc -l | tr -d ' ')" "1"
pass "C1 identical ACL in pre / postA / postB: ${acls[0]}"

# ---- E: an EXISTING table (built in the pre world) at 10/30 and the contract's rollback model ----
d="$(mk pre ddl)"; pre_acl="$(acl "$d")"; pre_set="$(aclset "$d")"
own "$d" -c "alter default privileges in schema public revoke all on tables from anon, authenticated, service_role" >/dev/null
expect "E1 a defaults change does not touch an existing table" "$(acl "$d")" "$pre_acl"
pass "E1 existing table: its ACL is kept when the defaults change (the changelog: existing tables keep their grants)"
# E2 contract on the existing table, then a prestate-line rollback model: restore exactly the captured ACL; refuse when the current ACL
# is not what the contract left (another change in between). The real rollback belongs to T-1 (PR #370's prestate pattern); this
# only fixes the expectation.
own "$d" -f "$contract" >/dev/null; contract_acl="$(acl "$d")"
rollback_model() { own "$d" -v pre="$pre_acl" -v expected="$contract_acl" >"$tmp/rb.out" 2>&1 <<'SQL'
begin;
select set_config('g3c.pre', :'pre', true) is not null as pre_set, set_config('g3c.expected', :'expected', true) is not null as expected_set;
do $$
declare v_item record; v_owner oid := (select relowner from pg_catalog.pg_class where oid = 'public.brand_memberships'::regclass);
begin
  if (select coalesce(pg_catalog.array_to_string(relacl, ','), 'NULL') from pg_catalog.pg_class where oid = 'public.brand_memberships'::regclass)
     is distinct from pg_catalog.current_setting('g3c.expected') then
    raise exception 'G3C_ROLLBACK_MISMATCH';
  end if;
  for v_item in select a.privilege_type, (select r.rolname from pg_catalog.pg_roles r where r.oid = a.grantee) as rolname
                  from pg_catalog.aclexplode(('{' || pg_catalog.current_setting('g3c.pre') || '}')::aclitem[]) a
                 where a.grantor = v_owner and a.grantee <> v_owner and not a.is_grantable loop
    execute pg_catalog.format('grant %s on table public.brand_memberships to %I', v_item.privilege_type, v_item.rolname);
  end loop;
end $$;
commit;
SQL
}
own "$d" -c "grant select on table public.brand_memberships to anon" >/dev/null
if rollback_model; then fail "E2 the rollback model ran over a drifted ACL"; fi
grep -q G3C_ROLLBACK_MISMATCH "$tmp/rb.out" || fail "E2 wrong refusal: $(grep ERROR "$tmp/rb.out" | head -1)"
own "$d" -c "revoke select on table public.brand_memberships from anon" >/dev/null
rollback_model || fail "E2 rollback model: $(cat "$tmp/rb.out")"
expect "E2 rollback = the prestate ACL (as a set of items)" "$(aclset "$d")" "$pre_set"
pass "E2 existing table: contract then rollback model restores the prestate items exactly (item order aside); a drifted ACL is refused (G3C_ROLLBACK_MISMATCH)"

# ---- V: the contract's two statements fire DDL event triggers (a managed project has its own, e.g. PostgREST's schema reload) ----
d="$(mk postA ddl)"
"${S[@]}" -d "$d" >/dev/null <<SQL
create table public.g3c_evt (tag text);
grant insert on public.g3c_evt to public;
create function public.g3c_evt_fn() returns event_trigger language plpgsql as \$\$
declare r record; begin for r in select * from pg_event_trigger_ddl_commands() loop insert into public.g3c_evt values (r.command_tag); end loop; end \$\$;
create event trigger g3c_evt on ddl_command_end execute function public.g3c_evt_fn();
SQL
own "$d" -f "$contract" >/dev/null
expect "V event trigger tags" "$("${S[@]}" -d "$d" -c "select string_agg(tag, ',' order by tag) from public.g3c_evt")" "GRANT,REVOKE"
pass "V the contract fires ddl_command_end once per statement (REVOKE, GRANT): a managed project's own event triggers run on it too (not modelled)"

echo "G3_BRAND_MEMBERSHIPS_DATA_API_CONTRACT_ALL_PASS"
