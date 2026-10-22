#!/usr/bin/env bash
# G5-19: G3's six questions on public.brand_memberships column / system-column ACLs (Issue #320 task 19), on a THROW-AWAY LOCAL PostgreSQL 17.
# Two worlds are built from the REAL membership migration (20260918120000): "pre" with the model's old default grants (Supabase before 2026-10-30) and
# "post" without them (after). In each, G3's PR #370 forward candidate (read at runtime from the pinned commit 547d9f92 with `git show`, never copied
# into this branch) and G5's PR #303 owner-epoch candidate are run as the table owner; the suite then measures what the L-1 exposure check sees and
# misses, what column and system-column grants allow, and the side effects of G3's option A1. No network, no credential, no managed project; no G3 /
# G4 / G6 file is changed; nothing is applied anywhere else. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_bm_column_acl_pg_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${BM_REPO_ROOT:-$(git -C "$here" rev-parse --show-toplevel)}"
g3_sha=547d9f920b124c9af286408eca696b10c67efe79
g3_path=supabase/candidates/postona_brand_memberships_privileges/001_brand_memberships_api_privilege_revoke.sql
n="$$"; owner="kb_bm_owner_$n"; att="kb_bm_att_$n"; prefix="kabumori_bm_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g519bm.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $att" >/dev/null 2>&1 || true
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# G3's file at the pinned commit (the object must be present: `git fetch origin` first)
git -C "$repo" cat-file -e "$g3_sha^{commit}" || { echo "G3 commit $g3_sha is not in this repository; run git fetch origin." >&2; exit 2; }
git -C "$repo" show "$g3_sha:$g3_path" > "$work/g3_001.sql"

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb;
grant anon, authenticated, service_role to $owner;
-- a non-API role that is a MEMBER of authenticated (as a custom login role would be); it owns nothing of the model
create role $att nologin nosuperuser;
grant authenticated to $att;
create database ${prefix}_pre owner $owner;
create database ${prefix}_post owner $owner;
SQL
for w in pre post; do
  own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$w" "$@"; }
  own -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
  if [ "$w" = post ]; then
    # 2026-10-30: the default privileges stop granting new public tables to the API roles (the fixture re-adds the old ones, so this comes after it)
    own -c "alter default privileges in schema public revoke all on tables from anon, authenticated, service_role" >/dev/null
  fi
  own -c "create schema if not exists private" >/dev/null
  # the fixture's stand-in table is replaced by the one the REAL migration creates, so its ACL comes from that world's default privileges
  own -c "drop table public.brand_memberships" >/dev/null
  own -f "$repo/supabase/migrations/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
  "${S[@]}" -d "${prefix}_$w" -c "grant usage on schema public to $att; create schema att authorization $att" >/dev/null
done
( cd "$repo" && CAL_E2E=1 BM_REPO="$repo" BM_G3_001="$work/g3_001.sql" BM_OWNER="$owner" BM_ATT="$att" PGSUPER="$super" \
    BM_DB_PRE="${prefix}_pre" BM_DB_POST="${prefix}_post" PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/common_account_bm_column_acl_pg_test.ts" )
