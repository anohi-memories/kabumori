#!/usr/bin/env bash
# Offline proof (Phase 3e, H2 E11 review R1 / R5) that the extended and per-target read-backs are read-only,
# deterministic, report ABSENT / UNKNOWN_DENIED instead of 0, and measure what the E11 matrix needs -- on a LOCAL
# Unix-socket PostgreSQL with the lifecycle suites' fixtures plus local stand-ins for GoTrue tables. This is a
# SIMULATION of the read-back METHOD on a fake schema, not evidence of managed Supabase behaviour.
#
# TEST STAND-INS (fake data, local scratch database only): "delete from auth.users" is the E11 SQL path being
# measured; auth.sessions / refresh_tokens / audit_log_entries are minimal local tables shaped after GoTrue's.
# Usage: CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
#        bash supabase/tests/common_account_disposable_e2e/readback_local_run.sh
set -euo pipefail
export LC_ALL=C

host="${CAL_PGHOST:?CAL_PGHOST (local socket dir) required}"
port="${CAL_PGPORT:?CAL_PGPORT required}"
super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
tests="$here/.."
migrations="$here/../../migrations"
owner="kb_cal_readback_owner"
reader="kb_cal_readback_reader"
db="kabumori_cal_readback_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
O=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
Q=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
tmp="$(mktemp -d /private/tmp/kabumori-cal-readback.XXXXXX)"
cleanup() {
  rm -rf "$tmp"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = '$reader') then create role $reader login nosuperuser nocreatedb nocreaterole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL
"${O[@]}" -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
"${O[@]}" -f "$migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql" >/dev/null
"${O[@]}" -f "$migrations/20260928160000_social_mobile_account_deletion_candidate.sql" >/dev/null
"${O[@]}" -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
"${O[@]}" -f "$migrations/20261001150000_common_account_lifecycle_foundation.sql" >/dev/null
"${O[@]}" -f "$migrations/20261006230000_common_account_service_start_intent.sql" >/dev/null
"${O[@]}" -f "$migrations/20261009120000_common_account_deletion_completion.sql" >/dev/null
# Local stand-ins shaped after GoTrue (sessions cascade from the login; refresh tokens cascade from their session;
# a legacy refresh token has no session; audit rows have no foreign key) and a RESTRICT probe table.
"${O[@]}" >/dev/null <<'SQL'
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, not_after timestamptz);
create table auth.refresh_tokens (id bigserial primary key, token text, user_id varchar(255), session_id uuid references auth.sessions (id) on delete cascade, revoked boolean not null default false);
create table auth.audit_log_entries (id uuid primary key default gen_random_uuid(), payload json, created_at timestamptz not null default now());
create table public.p3e_restrict_probe (user_id uuid primary key references auth.users (id) on delete restrict);
insert into storage.buckets (id) values ('p3e-fake');
SQL
"${S[@]}" -d "$db" >/dev/null <<SQL
grant usage on schema auth, storage, public to $reader;
grant select on auth.users to $reader;
revoke all on auth.audit_log_entries, auth.identities, auth.sessions, auth.refresh_tokens, storage.objects from $reader;
SQL

uid() { printf '00000000-0000-4000-8000-%012d' "$1"; }
person() {  # uid -> fake user with two identities, two sessions, three refresh tokens (one legacy), one audit row, one object
  local u="$1"
  "${Q[@]}" >/dev/null <<SQL
select public.fixture_login('$u'::uuid);
insert into auth.identities (user_id, provider) values ('$u', 'google');
begin; set local request.jwt.claim.sub = '$u'; set local role authenticated; select public.start_kabumori_service(); commit;
insert into auth.sessions (user_id) values ('$u'), ('$u');
insert into auth.refresh_tokens (token, user_id, session_id) select 'fake', '$u', id from auth.sessions where user_id = '$u';
insert into auth.refresh_tokens (token, user_id, session_id) values ('fake-legacy', '$u', null);
insert into auth.audit_log_entries (payload) values (json_build_object('action', 'identity_linked', 'actor_id', '$u'));
insert into storage.objects (bucket_id, name, owner_id) values ('p3e-fake', '$u/photo.jpg', '$u');
SQL
}
ids() {  # uid table column -> '{...}' of the target ids captured BEFORE any delete
  "${Q[@]}" -c "select '{' || coalesce(string_agg(id::text, ',' order by id::text), '') || '}' from $2 where $3 = '$1'"
}
readback() {  # uid identities sessions refresh objects [role] -> target read-back lines (read-only transaction)
  local as="${6:-$owner}"
  { echo 'begin transaction read only;'; cat "$here/target_readback.sql"; echo 'rollback;'; } \
    | psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$as" -d "$db" \
        -v target_user="$1" -v target_identities="$2" -v target_sessions="$3" -v target_refresh_tokens="$4" -v target_objects="$5"
}
expect() {  # file expected-line
  grep -qxF "$2" "$1" || { echo "FAIL expected '$2' in $(basename "$1"):" >&2; cat "$1" >&2; exit 1; }
}

# 1. The extended read-back: a READ ONLY transaction, deterministic, catalog unchanged, ABSENT/UNKNOWN never 0.
u1="$(uid 901)"; person "$u1"
extended() { { echo 'begin transaction read only;'; cat "$here/catalog_extended_readback.sql"; echo 'rollback;'; } | "${Q[@]}"; }
catalog_md5() { "${Q[@]}" -c "select md5(string_agg(oid::text || relname || relkind::text, ',' order by oid)) from pg_class"; }
before="$(catalog_md5)"
extended > "$tmp/x1"; extended > "$tmp/x2"
cmp -s "$tmp/x1" "$tmp/x2" || { echo "FAIL extended read-back not deterministic" >&2; exit 1; }
[[ "$(catalog_md5)" == "$before" ]] || { echo "FAIL extended read-back changed the catalog" >&2; exit 1; }
expect "$tmp/x1" 'rls|public.common_accounts|enabled=t|forced=f'
expect "$tmp/x1" 'storage_count|objects|1'
expect "$tmp/x1" 'storage_count|buckets|1'
for want in '^trigger_fn\|public\.common_accounts\|account_lifecycle_guard_account_delete\|.*\|definer=t\|config=search_path=""\|body_md5=[0-9a-f]{32}$' \
            '^effective\|anon\|auth\.users\|select=f\|' '^effective\|service_role\|public\.common_accounts\|' \
            '^table_acl\|public\.profiles\|authenticated\|INSERT\|' '^column_acl\|public\.common_accounts\.' '^schema_acl\|private\|' \
            '^default_acl\|kb_cal_readback_owner\|private\|' '^managed_fn\|auth\.uid\(\)\|'; do
  grep -Eq "$want" "$tmp/x1" || { echo "FAIL extended read-back misses: $want" >&2; exit 1; }
done
if "${Q[@]}" -c "begin transaction read only; delete from public.p3e_restrict_probe; rollback;" >/dev/null 2>&1; then
  echo "FAIL a read-only transaction accepted a write" >&2; exit 1
fi
echo "COMMON_ACCOUNT_DISPOSABLE_EXTENDED_READBACK_PASS"

# 2. Denied access is UNKNOWN_DENIED, not 0 (a reader that may see users only).
i1="$(ids "$u1" auth.identities user_id)"; s1="$(ids "$u1" auth.sessions user_id)"; r1="$(ids "$u1" auth.refresh_tokens user_id)"; o1="$(ids "$u1" storage.objects owner_id)"
readback "$u1" "$i1" "$s1" "$r1" "$o1" "$reader" > "$tmp/denied"
expect "$tmp/denied" 'target|users|1'
for line in 'target|identities_by_id|UNKNOWN_DENIED' 'target|sessions_by_id|UNKNOWN_DENIED' 'target|refresh_tokens_by_id|UNKNOWN_DENIED' \
            'target|audit_identity_linked_for_actor|UNKNOWN_DENIED' 'target|storage_objects_by_id|UNKNOWN_DENIED' 'target|common_accounts|UNKNOWN_DENIED'; do
  expect "$tmp/denied" "$line"
done
echo "COMMON_ACCOUNT_DISPOSABLE_READBACK_DENIED_IS_UNKNOWN_PASS"

# 3. Denominators captured BEFORE the delete are non-zero.
readback "$u1" "$i1" "$s1" "$r1" "$o1" > "$tmp/before"
for line in 'target|users|1' 'target|identities_by_id|2' 'target|sessions_by_id|2' 'target|refresh_tokens_by_id|3' \
            'target|audit_identity_linked_for_actor|1' 'target|audit_user_deleted_for_target|0' 'target|storage_objects_by_id|1' \
            'target|storage_objects_owned_by_target|1' 'target|common_accounts|1' 'target|service_entitlements|1'; do
  expect "$tmp/before" "$line"
done
echo "COMMON_ACCOUNT_DISPOSABLE_READBACK_DENOMINATORS_PASS"

# 4. Failure branches on another fake user leave every captured row unchanged (read-back equals before).
u2="$(uid 902)"; person "$u2"
i2="$(ids "$u2" auth.identities user_id)"; s2="$(ids "$u2" auth.sessions user_id)"; r2="$(ids "$u2" auth.refresh_tokens user_id)"; o2="$(ids "$u2" storage.objects owner_id)"
readback "$u2" "$i2" "$s2" "$r2" "$o2" > "$tmp/b2"
unchanged() {
  readback "$u2" "$i2" "$s2" "$r2" "$o2" > "$tmp/a2"
  cmp -s "$tmp/b2" "$tmp/a2" || { echo "FAIL failure branch $1 changed state" >&2; diff "$tmp/b2" "$tmp/a2" >&2 || true; exit 1; }
}
"${Q[@]}" -c "insert into public.p3e_restrict_probe values ('$u2')" >/dev/null
if "${Q[@]}" -c "delete from auth.users where id = '$u2'" >/dev/null 2>&1; then echo "FAIL the RESTRICT branch deleted" >&2; exit 1; fi
unchanged fk_restrict_denied
"${Q[@]}" -c "delete from public.p3e_restrict_probe where user_id = '$u2'" >/dev/null
( "${Q[@]}" -c "begin; select 1 from auth.users where id = '$u2' for update; select pg_sleep(1.5); commit;" >/dev/null ) &
holder=$!
sleep 0.4
if "${Q[@]}" -c "begin; set local lock_timeout = '300ms'; delete from auth.users where id = '$u2'; commit;" >/dev/null 2>&1; then echo "FAIL the lock_timeout branch deleted" >&2; exit 1; fi
wait "$holder"
unchanged lock_timeout
"${Q[@]}" -c "begin; delete from auth.users where id = '$u2'; rollback;" >/dev/null
unchanged explicit_rollback_before_commit
if psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$reader" -d "$db" -c "delete from auth.users where id = '$u2'" >/dev/null 2>&1; then
  echo "FAIL the role without DELETE deleted" >&2; exit 1
fi
unchanged role_acl_denied
echo "COMMON_ACCOUNT_DISPOSABLE_READBACK_FAILURE_BRANCHES_UNCHANGED_PASS"

# 5. The SQL path on the target: exactly one row, then read-back BY THE CAPTURED IDS. Rows without a cascade from the
#    login (a legacy refresh token, the audit row, the Storage object) remain and are found; no user_deleted audit
#    row appears for the SQL path. A JOIN from the deleted user reports a vacuous 0 for the same refresh token.
[[ "$("${Q[@]}" -c "with d as (delete from auth.users where id = '$u1' returning 1) select count(*) from d")" == 1 ]] \
  || { echo "FAIL the single-row delete did not remove exactly one row" >&2; exit 1; }
readback "$u1" "$i1" "$s1" "$r1" "$o1" > "$tmp/after"
for line in 'target|users|0' 'target|identities_by_id|0' 'target|sessions_by_id|0' 'target|refresh_tokens_by_id|1' \
            'target|audit_identity_linked_for_actor|1' 'target|audit_user_deleted_for_target|0' 'target|storage_objects_by_id|1' \
            'target|storage_objects_owned_by_target|1' 'target|common_accounts|0' 'target|service_entitlements|0'; do
  expect "$tmp/after" "$line"
done
[[ "$("${Q[@]}" -c "select count(*) from auth.refresh_tokens r join auth.users u on u.id::text = r.user_id where u.id = '$u1'")" == 0 ]] \
  || { echo "FAIL the vacuous-join reproduction" >&2; exit 1; }
echo "COMMON_ACCOUNT_DISPOSABLE_READBACK_BY_CAPTURED_IDS_PASS (residue found: 1 legacy refresh token, 1 Storage object; a join from the user would have said 0)"
echo "COMMON_ACCOUNT_DISPOSABLE_READBACK_LOCAL_SIMULATION_ALL_PASS"
