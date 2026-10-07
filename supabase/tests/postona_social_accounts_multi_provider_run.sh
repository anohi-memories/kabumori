#!/usr/bin/env bash
# Disposable-only proof runner for the POSTONA multi-provider account schema candidate
# (20261007150000_postona_social_accounts_multi_provider.sql). On a LOCAL Unix-socket PostgreSQL
# cluster, as a per-run non-superuser owner, it builds production-shaped databases from the existing
# fixtures and the REAL unmodified migrations, gives social_accounts production-like access
# (postona_social_accounts_multi_provider_fixture.sql) and then:
#   1. applies the candidate over seeded X accounts, refuses a second apply, and runs the behavior
#      proof (postona_social_accounts_multi_provider_behavior.sql);
#   2. re-runs the existing X proofs with the candidate applied: publish permission, account deletion,
#      and the Stage 3B pilot / publish authority / settings reader;
#   3. starts the candidate from adverse states (platform CHECK missing, widened, duplicated, spanning
#      two columns, NOT VALID over a non-X row; UNIQUE (brand_id, platform) missing, partial or wider;
#      column type / nullability; inheritance; app-role write grants direct, column-level, via PUBLIC or inherited; RLS off
#      or forced; another creator, a superuser, a superuser-owned table; app roles inheriting the owner
#      or service_role; a lock held by another session) and requires each to be refused with its fixed
#      code (or the lock timeout) with nothing changed, and a renamed but exact CHECK to be applied;
#   4. injects failures and drift into copies of the candidate to show that a failure after the DROP
#      leaves nothing changed and that the postcondition refuses a changed grant, row, default, policy
#      or constraint.
# Fake data only; every database is dropped. Never production.
#
# MUST RUN ALONE on its disposable cluster: the role-graph cases change memberships of the
# cluster-wide anon / authenticated / service_role roles (each case undoes its change; the exit trap
# undoes all of them).
# Usage: POSTONA_PGHOST=/private/tmp/<socket-dir> POSTONA_PGPORT=<port> \
#        POSTONA_PGSUPER=<local superuser> supabase/tests/postona_social_accounts_multi_provider_run.sh
# POSTONA_CANDIDATE=<file> runs the same proof against another copy of the candidate (used only by
# postona_social_accounts_multi_provider_mutations.sh).
# The server must answer in English (lc_messages=C): the lock case matches PostgreSQL's own wording.
set -euo pipefail
export LC_ALL=C

host="${POSTONA_PGHOST:?POSTONA_PGHOST (local socket dir) required}"
port="${POSTONA_PGPORT:?POSTONA_PGPORT required}"
super="${POSTONA_PGSUPER:?POSTONA_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: POSTONA_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${POSTONA_CANDIDATE:-$migrations/20261007150000_postona_social_accounts_multi_provider.sql}"
psql_bin="${PSQL:-psql}"
n="$$"
owner="kb_postona_owner_$n"    # this run's table owner and migration creator
other="kb_postona_other_$n"    # a creator that does not own the table
writer="kb_postona_writer_$n"  # a role holding a write grant that app roles may inherit
base="kabumori_postona_${n}_base"
template="kabumori_postona_${n}_tpl"

as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/kabumori-postona.XXXXXX)"
fail() { echo "FAIL $*" >&2; exit 1; }

restore_roles() {
  "${as_super[@]}" -d postgres > /dev/null 2>&1 <<SQL || true
revoke $owner from authenticated, anon;
revoke service_role from authenticated, anon;
revoke $writer from authenticated, anon;
grant anon, authenticated, service_role to $owner;
SQL
}
cleanup() {
  restore_roles
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like 'kabumori_postona_${n}_%' order by datname" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  for role in "$writer" "$other" "$owner"; do
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
create role $other login nosuperuser nocreatedb nocreaterole;
create role $writer nologin;
-- The fixtures' helpers act as the app roles (set role authenticated / service_role).
grant anon, authenticated, service_role to $owner;
SQL
# Pre-existing drift a case depends on: refuse to run on it.
[[ "$("${as_super[@]}" -d postgres -c "select pg_has_role('anon', 'service_role', 'usage') or pg_has_role('authenticated', 'service_role', 'usage') or pg_has_role('anon', 'authenticated', 'usage')")" == f ]] \
  || fail "the cluster's app roles already inherit each other"

as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { "${as_super[@]}" -d "$1" -c "$2"; }
create_db() {
  [[ "$("${as_super[@]}" -d postgres -c "select count(*) from pg_database where datname = '$1'")" == 0 ]] || fail "database $1 already exists"
  "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null
}
copy() { local db="kabumori_postona_${n}_$1"; create_db "$db" "${2:-$template}"; echo "$db"; }
# Applies a candidate file as a role; prints "applied" or the first ERROR text.
apply() {
  local db="$1" role="$2" file="$3" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$role" -d "$db" -f "$file" 2>&1)"; then
    echo applied
  else
    sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1
  fi
}
fingerprint() { q "$1" "select postona_proof.catalog()::text"; }
new_constraints() {
  q "$1" "select count(*) from pg_constraint where conrelid = 'public.social_accounts'::regclass
          and conname in ('social_accounts_platform_supported', 'social_accounts_provider_credential_profile', 'social_accounts_meta_publish_disabled')"
}
x_only_checks() {
  q "$1" "select count(*) from pg_constraint where conrelid = 'public.social_accounts'::regclass and pg_get_constraintdef(oid) = 'CHECK ((platform = ''x''::text))'"
}
expect_applied() {
  local label="$1" db="$2" role="${3:-$owner}" file="${4:-$candidate}" got
  got="$(apply "$db" "$role" "$file")"
  [[ "$got" == applied ]] || fail "$label: refused ($got)"
  [[ "$(new_constraints "$db")" == 3 && "$(x_only_checks "$db")" == 0 ]] || fail "$label: constraints not exactly replaced"
}
# Expects a refusal with exactly this message and nothing changed (catalog, grants, RLS, constraints, rows).
expect_refused() {
  local label="$1" db="$2" code="$3" role="${4:-$owner}" file="${5:-$candidate}" before got
  before="$(fingerprint "$db")"
  got="$(apply "$db" "$role" "$file")"
  [[ "$got" == "$code" ]] || fail "$label: expected $code, got ${got:-applied}"
  [[ "$(fingerprint "$db")" == "$before" ]] || fail "$label: the refused apply changed something"
  [[ "$(new_constraints "$db")" == 0 ]] || fail "$label: a new constraint survived the refused apply"
}
# A copy of the candidate with one statement placed right before the first line starting with $2.
inject() {
  local into="$tmp/$1.sql"
  awk -v stmt="$3" -v marker="$2" 'index($0, marker) == 1 && !done { print stmt; done = 1 } { print }' "$candidate" > "$into"
  if cmp -s "$candidate" "$into"; then fail "inject $1: marker not found"; fi
  echo "$into"
}

# ---- Databases ------------------------------------------------------------------------------
# Publish-permission world: the fixture and real chain of social_mobile_publish_permission_run.sh,
# plus 20261003090000 itself (applied in production on 2026-10-06), then production-like access.
create_db "$base"
as_owner "$base" -f "$here/social_mobile_publish_permission_fixture.sql" > /dev/null
for real in \
  20260919120000_social_mobile_x_oauth_onboarding.sql \
  20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql \
  20260925140000_x_account_credential_refresh_core.sql \
  20260926032054_x_account_refresh_rollout_authority.sql \
  20260928160000_social_mobile_account_deletion_candidate.sql \
  20261003090000_social_mobile_publish_permission_boundary.sql; do
  as_owner "$base" -f "$migrations/$real" > /dev/null
done
as_owner "$base" -f "$here/postona_social_accounts_multi_provider_fixture.sql" > /dev/null

# Seeded X accounts in every state the proofs need, and the snapshot taken right before the candidate.
create_db "$template" "$base"
as_owner "$template" > /dev/null <<'SQL'
select public.fixture_brand('00000000-0000-4000-8000-000000000301', 'x_off');
select public.fixture_brand('00000000-0000-4000-8000-000000000302', 'x_on');
update public.social_accounts set publish_enabled = true where id = 'sa_x_on';
select public.fixture_brand('00000000-0000-4000-8000-000000000303', 'x_norefresh');
update public.social_accounts set publish_enabled = true, vault_refresh_token_secret_id = null where id = 'sa_x_norefresh';
select public.fixture_brand('00000000-0000-4000-8000-000000000304', 'x_norefresh_off');
update public.social_accounts set vault_refresh_token_secret_id = null where id = 'sa_x_norefresh_off';
select public.fixture_brand('00000000-0000-4000-8000-000000000305', 'x_pending');
update public.social_accounts
   set connection_status = 'unconnected', verified_at = null, platform_user_id = null, handle = 'pending',
       vault_access_token_secret_id = null, vault_refresh_token_secret_id = null
 where id = 'sa_x_pending';
select public.fixture_brand('00000000-0000-4000-8000-000000000306', 'x_del');
insert into public.brands (id) values ('postona_meta_only');
create table postona_proof.accounts_before as select * from public.social_accounts;
create table postona_proof.catalog_before as select postona_proof.catalog() as v;
create table postona_proof.constraints_before as
  select c.conname, c.conname || '=' || pg_get_constraintdef(c.oid) || ':' || c.convalidated as def
  from pg_constraint c where c.conrelid = 'public.social_accounts'::regclass;
SQL

# ---- 1. Apply, re-apply, behavior ----------------------------------------------------------------
db="$(copy apply)"
expect_applied "apply" "$db"
before="$(fingerprint "$db")"
got="$(apply "$db" "$owner" "$candidate")"
[[ "$got" == POSTONA_ACCOUNTS_PRECONDITION_ALREADY_APPLIED ]] || fail "re-apply: expected ALREADY_APPLIED, got ${got:-applied}"
[[ "$(fingerprint "$db")" == "$before" ]] || fail "re-apply changed something"
echo "POSTONA_ACCOUNTS_APPLY_PASS"
out="$(as_owner "$db" -A -t -f "$here/postona_social_accounts_multi_provider_behavior.sql" 2>&1)" || fail "behavior: $out"
grep -q POSTONA_ACCOUNTS_BEHAVIOR_PASS <<<"$out" || fail "behavior: $out"
if grep -q 'fake_' <<<"$out"; then fail "token material in behavior output"; fi
echo "POSTONA_ACCOUNTS_BEHAVIOR_PASS"

# ---- 2. Existing X proofs with the candidate applied ------------------------------------------------
db="$(copy publish_permission "$base")"
expect_applied "publish permission world" "$db"
out="$(as_owner "$db" -A -t -f "$here/social_mobile_publish_permission_behavior.sql" 2>&1)" || fail "publish permission behavior: $out"
grep -q PUBLISH_PERMISSION_BEHAVIOR_PASS <<<"$out" || fail "publish permission behavior: $out"
echo "POSTONA_EXISTING_PUBLISH_PERMISSION_PASS"

db="kabumori_postona_${n}_deletion"
create_db "$db"
as_owner "$db" -f "$here/social_mobile_account_deletion_fixture.sql" > /dev/null
for real in \
  20260919120000_social_mobile_x_oauth_onboarding.sql \
  20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql \
  20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$db" -f "$migrations/$real" > /dev/null
done
as_owner "$db" -f "$here/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
expect_applied "deletion world" "$db"
# This fixture's publish_enabled default is true (the publish-permission fixture's is false; production's
# is not yet read). A Meta row that relies on the default is refused, never enabled.
[[ "$(q "$db" "select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
               where d.adrelid = 'public.social_accounts'::regclass and a.attname = 'publish_enabled'")" == true ]] \
  || fail "deletion world: expected a publish_enabled default of true"
if out="$(as_owner "$db" -c "begin; insert into public.brands (id) values ('postona_default_probe');
           insert into public.social_accounts (id, brand_id, platform) values ('sa_default_probe', 'postona_default_probe', 'threads'); rollback;" 2>&1)"; then
  fail "deletion world: a Threads row was created under a publish_enabled default of true"
fi
grep -qF 'violates check constraint "social_accounts_meta_publish_disabled"' <<<"$out" || fail "deletion world default probe: $out"
out="$(as_owner "$db" -A -t -f "$here/social_mobile_account_deletion_behavior.sql" 2>&1)" || fail "deletion behavior: $out"
grep -q SOCIAL_MOBILE_DELETION_BEHAVIOR_PASS <<<"$out" || fail "deletion behavior: $out"
if grep -q 'fake_' <<<"$out"; then fail "token material in deletion output"; fi
echo "POSTONA_EXISTING_ACCOUNT_DELETION_PASS"

# The Stage 3B chain of x_account_refresh_pilot_run.sh (PR #41 completion, settings reader, publish authority).
db="kabumori_postona_${n}_pilot"
create_db "$db"
as_owner "$db" -f "$here/x_account_refresh_core_fixture.sql" > /dev/null
as_owner "$db" -f "$here/x_account_stage3b_base_fixture.sql" > /dev/null
as_owner "$db" -1 -f "$migrations/20260922045046_social_mobile_content_settings_candidate.sql" \
  -f "$migrations/20261003120000_social_mobile_content_settings_hardening.sql" > /dev/null
as_owner "$db" -f "$migrations/20260925140000_x_account_credential_refresh_core.sql" > /dev/null
as_owner "$db" -c "insert into public.x_account_refresh_state_v2 (social_account_id, status, generation, last_refreshed_at) values ('ai_salaryman_lab_x', 'idle', 1, now() - interval '1 hour')" > /dev/null
for real in \
  20260926032054_x_account_refresh_rollout_authority.sql \
  20261006160000_vault_account_brand_post_completion.sql \
  20261006160100_social_mobile_publish_settings_reader.sql \
  20261006160200_x_account_publish_authority.sql; do
  as_owner "$db" -f "$migrations/$real" > /dev/null
done
as_owner "$db" -f "$here/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
expect_applied "Stage 3B world" "$db"
for proof in x_account_refresh_pilot_behavior:PILOT_BEHAVIOR_PASS \
             x_account_publish_authority_behavior:PUBLISH_AUTHORITY_BEHAVIOR_PASS \
             social_mobile_publish_settings_reader_behavior:PUBLISH_SETTINGS_READER_BEHAVIOR_PASS; do
  out="$(as_owner "$db" -A -t -f "$here/${proof%%:*}.sql" 2>&1)" || fail "${proof%%:*}: $out"
  grep -q "${proof##*:}" <<<"$out" || fail "${proof%%:*}: $out"
done
echo "POSTONA_EXISTING_STAGE3B_PASS"

# ---- 3. Adverse starting states -------------------------------------------------------------------
refuse_after() { # label, code, setup SQL (run as superuser on a fresh copy)
  local db
  db="$(copy "$1")"
  q "$db" "$3" > /dev/null
  expect_refused "$1" "$db" "$2"
}
refuse_after check_missing POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK \
  "alter table public.social_accounts drop constraint social_accounts_platform_check"
refuse_after check_widened POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK \
  "alter table public.social_accounts drop constraint social_accounts_platform_check;
   alter table public.social_accounts add constraint social_accounts_platform_check check (platform in ('x', 'threads'))"
refuse_after check_duplicated POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK \
  "alter table public.social_accounts add constraint social_accounts_platform_nonblank check (platform <> '')"
refuse_after check_two_columns POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK \
  "alter table public.social_accounts drop constraint social_accounts_platform_check;
   alter table public.social_accounts add constraint social_accounts_platform_check check (platform = 'x' and brand_id <> '')"
refuse_after check_not_valid POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK \
  "alter table public.social_accounts drop constraint social_accounts_platform_check;
   insert into public.social_accounts (id, brand_id, platform) values ('sa_drift_threads', 'postona_meta_only', 'threads');
   alter table public.social_accounts add constraint social_accounts_platform_check check (platform = 'x') not valid"
refuse_after check_not_valid_clean POSTONA_ACCOUNTS_PRECONDITION_PLATFORM_CHECK \
  "alter table public.social_accounts drop constraint social_accounts_platform_check;
   alter table public.social_accounts add constraint social_accounts_platform_check check (platform = 'x') not valid"
refuse_after unique_missing POSTONA_ACCOUNTS_PRECONDITION_UNIQUE \
  "alter table public.social_accounts drop constraint social_accounts_brand_id_platform_key"
refuse_after unique_partial POSTONA_ACCOUNTS_PRECONDITION_UNIQUE \
  "alter table public.social_accounts drop constraint social_accounts_brand_id_platform_key;
   create unique index social_accounts_brand_platform_live on public.social_accounts (brand_id, platform) where publish_enabled"
refuse_after unique_wider POSTONA_ACCOUNTS_PRECONDITION_UNIQUE \
  "alter table public.social_accounts drop constraint social_accounts_brand_id_platform_key;
   alter table public.social_accounts add constraint social_accounts_brand_platform_handle_key unique (brand_id, platform, handle)"
refuse_after publish_nullable POSTONA_ACCOUNTS_PRECONDITION_SHAPE \
  "alter table public.social_accounts alter column publish_enabled drop not null"
refuse_after platform_nullable POSTONA_ACCOUNTS_PRECONDITION_SHAPE \
  "alter table public.social_accounts alter column platform drop not null"
refuse_after refresh_ref_text POSTONA_ACCOUNTS_PRECONDITION_SHAPE \
  "alter table public.social_accounts alter column vault_refresh_token_secret_id type text"
refuse_after inherited POSTONA_ACCOUNTS_PRECONDITION_SHAPE \
  "create table public.social_accounts_drift_child () inherits (public.social_accounts); alter table public.social_accounts_drift_child owner to $owner"
refuse_after auth_update POSTONA_ACCOUNTS_PRECONDITION_ACL "grant update on public.social_accounts to authenticated"
refuse_after auth_column_insert POSTONA_ACCOUNTS_PRECONDITION_ACL "grant insert (handle) on public.social_accounts to authenticated"
refuse_after anon_column_update POSTONA_ACCOUNTS_PRECONDITION_ACL "grant update (platform) on public.social_accounts to anon"
refuse_after public_insert POSTONA_ACCOUNTS_PRECONDITION_ACL "grant insert on public.social_accounts to public"
refuse_after anon_delete POSTONA_ACCOUNTS_PRECONDITION_ACL "grant delete on public.social_accounts to anon"
refuse_after auth_truncate POSTONA_ACCOUNTS_PRECONDITION_ACL "grant truncate on public.social_accounts to authenticated"
refuse_after rls_off POSTONA_ACCOUNTS_PRECONDITION_ACL "alter table public.social_accounts disable row level security"
refuse_after rls_forced POSTONA_ACCOUNTS_PRECONDITION_ACL "alter table public.social_accounts force row level security"

db="$(copy inherited_write)"
q "$db" "grant insert on public.social_accounts to $writer" > /dev/null
q postgres "grant $writer to authenticated" > /dev/null
expect_refused "authenticated inherits a writer" "$db" POSTONA_ACCOUNTS_PRECONDITION_ACL
restore_roles

db="$(copy auth_inherits_owner)"
# The owner is a member of authenticated for the fixture helpers; the reverse needs that removed first.
q postgres "revoke authenticated from $owner; grant $owner to authenticated" > /dev/null
expect_refused "authenticated inherits the owner" "$db" POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH
restore_roles
db="$(copy anon_inherits_service)"
q postgres "grant service_role to anon" > /dev/null
expect_refused "anon inherits service_role" "$db" POSTONA_ACCOUNTS_PRECONDITION_ROLE_GRAPH
restore_roles

db="$(copy other_creator)"
expect_refused "creator is not the owner" "$db" POSTONA_ACCOUNTS_PRECONDITION_OWNER "$other"
db="$(copy super_creator)"
expect_refused "superuser creator" "$db" POSTONA_ACCOUNTS_PRECONDITION_OWNER "$super"
db="$(copy super_owner)"
q "$db" "alter table public.social_accounts owner to $super" > /dev/null
expect_refused "table owned by a superuser, applied by it" "$db" POSTONA_ACCOUNTS_PRECONDITION_OWNER "$super"

# The X-only CHECK is found by its definition, not its name.
db="$(copy check_renamed)"
q "$db" "alter table public.social_accounts rename constraint social_accounts_platform_check to legacy_platform_rule" > /dev/null
expect_applied "X-only CHECK under another name" "$db"

# Another session holds the table: the candidate gives up after lock_timeout and changes nothing.
db="$(copy lock_held)"
"$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" \
  -c "begin; select count(*) from public.social_accounts; select pg_sleep(8); commit;" > "$tmp/holder" 2>&1 &
holder=$!
sleep 0.5
before="$(fingerprint "$db")"
start=$SECONDS
got="$(apply "$db" "$owner" "$candidate")"
elapsed=$((SECONDS - start))
wait "$holder"
[[ "$got" == "canceling statement due to lock timeout" ]] || fail "lock held: expected the lock timeout, got ${got:-applied}"
[[ "$elapsed" -le 7 ]] || fail "lock held: the candidate waited ${elapsed}s"
[[ "$(fingerprint "$db")" == "$before" && "$(new_constraints "$db")" == 0 ]] || fail "lock held: something changed"

# The candidate holds the table from its precondition on: a writer arriving while it runs waits (here:
# gives up), so the checks, the snapshot and the change see one state. The copy pauses inside the
# precondition block, after its checks and before its snapshot and DROP.
db="$(copy lock_taken)"
paused="$(inject lock_taken "  -- Snapshot of everything" "  perform pg_catalog.pg_sleep(2);")"
"$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$paused" > "$tmp/paused" 2>&1 &
paused_pid=$!
sleep 0.7
if "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" \
     -c "set lock_timeout = '500ms'; update public.social_accounts set handle = handle where id = 'sa_x_off'" > "$tmp/writer" 2>&1; then
  fail "lock taken: a writer got in while the candidate was between its precondition and its change"
fi
grep -qF 'lock timeout' "$tmp/writer" || fail "lock taken: writer failed for another reason: $(cat "$tmp/writer")"
wait "$paused_pid" || fail "lock taken: the paused candidate failed: $(cat "$tmp/paused")"
[[ "$(new_constraints "$db")" == 3 ]] || fail "lock taken: the paused candidate did not apply"
echo "POSTONA_ACCOUNTS_ADVERSE_PASS"

# ---- 4. Atomicity and postcondition ---------------------------------------------------------------
db="$(copy fail_after_drop)"
expect_refused "failure between DROP and ADD" "$db" POSTONA_INJECTED_FAILURE "$owner" \
  "$(inject fail_after_drop "alter table public.social_accounts" "do \$\$ begin raise exception 'POSTONA_INJECTED_FAILURE'; end \$\$;")"
[[ "$(x_only_checks "$db")" == 1 ]] || fail "failure between DROP and ADD: the X-only CHECK is gone"
db="$(copy fail_before_commit)"
expect_refused "failure before COMMIT" "$db" POSTONA_INJECTED_FAILURE "$owner" \
  "$(inject fail_before_commit "commit;" "do \$\$ begin raise exception 'POSTONA_INJECTED_FAILURE'; end \$\$;")"
post_refuses() { # label, code, statement placed before the postcondition
  local db
  db="$(copy "post_$1")"
  expect_refused "postcondition: $1" "$db" "$2" "$owner" "$(inject "post_$1" "-- Postcondition:" "$3")"
}
post_refuses grant_select_anon POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "grant select on public.social_accounts to anon;"
post_refuses revoke_select_auth POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "revoke select on public.social_accounts from authenticated;"
post_refuses row_changed POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "update public.social_accounts set publish_enabled = not publish_enabled where id = 'sa_x_off';"
post_refuses default_changed POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "alter table public.social_accounts alter column platform set default 'threads';"
post_refuses policy_added POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "create policy postona_drift on public.social_accounts for insert to authenticated with check (true);"
post_refuses rls_forced POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "alter table public.social_accounts force row level security;"
post_refuses trigger_disabled POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "alter table public.social_accounts disable trigger social_mobile_deletion_guard;"
post_refuses index_added POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "create index postona_drift on public.social_accounts (handle);"
post_refuses column_added POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "alter table public.social_accounts add column access_token text;"
post_refuses unique_dropped POSTONA_ACCOUNTS_POSTCONDITION_UNCHANGED "alter table public.social_accounts drop constraint social_accounts_brand_id_platform_key;"
post_refuses extra_check POSTONA_ACCOUNTS_POSTCONDITION_CONSTRAINTS "alter table public.social_accounts add constraint postona_drift check (platform <> 'instagram');"
post_refuses new_check_dropped POSTONA_ACCOUNTS_POSTCONDITION_CONSTRAINTS "alter table public.social_accounts drop constraint social_accounts_meta_publish_disabled;"
echo "POSTONA_ACCOUNTS_ATOMICITY_PASS"

if grep -rq 'fake_' "$tmp"; then fail "token material in run output"; fi
cleanup
trap - EXIT
left="$("$psql_bin" -X -q -A -t -h "$host" -p "$port" -U "$super" -d postgres -c "select count(*) from pg_database where datname like 'kabumori_postona_${n}_%'")"
[[ "$left" == 0 ]] || fail "cleanup left databases"
roles_left="$("$psql_bin" -X -q -A -t -h "$host" -p "$port" -U "$super" -d postgres -c "select count(*) from pg_roles where rolname like 'kb_postona_%_$n'")"
[[ "$roles_left" == 0 ]] || fail "cleanup left roles"
echo "POSTONA_ACCOUNTS_CLEANUP_PASS"
