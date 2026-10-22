#!/usr/bin/env bash
# G5-21: the owner-epoch candidate against a trigger left on its history (H3 proxy review R1 on PR #446, Issue #330 comment 6332954454), on a
# THROW-AWAY LOCAL PostgreSQL 17 with fake data. Two databases from the REAL membership migration (20260918120000) and the same world as
# common_account_owner_epoch_acl_pg_run.sh: "after" runs this branch's candidate; "before" runs the candidate of PR #446's head 32b258ba (read with
# `git show`, never copied) to show H3's Q0-Q4 FAILING there. When the pinned commit is not available (a mutation copy has no .git) "before" is
# skipped. The TEST-WORLD revoke of TRIGGER / TRUNCATE / REFERENCES stands in for G3's dependency (L-1). No network, no credential, no managed
# project; nothing is applied anywhere else; no G3 / G4 / G6 file is read or changed. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_owner_epoch_history_trigger_pg_run.sh
# Optional: HT_REPO_ROOT (a tree with supabase/migrations, supabase/tests and supabase/candidates; the mutation script points it at a mutant copy).
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="${HT_REPO_ROOT:-$(cd "$here/../.." && pwd)}"
cand="$repo/supabase/candidates/common_account_brand_owner_epoch"
pinned=32b258ba8b0c2c87068203baf71539a61f139e3d
n="$$"; owner="kb_ht_owner_$n"; mid="kb_ht_mid_$n"; prefix="kabumori_ht_$n"
work="$(mktemp -d "${TMPDIR:-/tmp}/g521ht.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d r
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  for r in "$mid" "$owner"; do "${S[@]}" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done
  rm -rf "$work"
}
trap cleanup EXIT

worlds="after"
if git -C "$repo" cat-file -e "$pinned^{commit}" 2>/dev/null; then
  git -C "$repo" show "$pinned:supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" > "$work/before_001.sql"
  git -C "$repo" show "$pinned:supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch_rollback.sql" > "$work/before_rollback.sql"
  worlds="after before"
fi

"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb;
grant anon, authenticated, service_role to $owner;
create role $mid nologin;
SQL
for w in $worlds; do
  "${S[@]}" -d postgres -c "create database ${prefix}_$w owner $owner" >/dev/null
  own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$w" "$@"; }
  own -f "$here/social_mobile_account_deletion_fixture.sql" >/dev/null
  own -c "create schema if not exists private; grant usage on schema private to anon, authenticated, service_role" >/dev/null
  own -c "alter default privileges in schema private grant all on tables to anon, authenticated, service_role" >/dev/null
  own -c "drop table public.brand_memberships" >/dev/null
  own -f "$repo/supabase/migrations/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
  own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
  # att: the reached role's own schema; everyone may use it, so its trigger functions can run inside another role's write
  "${S[@]}" -d "${prefix}_$w" -c "grant usage on schema private to $mid; create schema att authorization $mid; grant usage on schema att to public" >/dev/null
  if [ "$w" = before ]; then own -f "$work/before_001.sql" >/dev/null; else own -f "$cand/001_brand_owner_epoch.sql" >/dev/null; fi
done
db_before=""; case "$worlds" in *before*) db_before="${prefix}_before" ;; esac
( cd "$repo" && CAL_E2E=1 HT_CANDIDATE="$cand/001_brand_owner_epoch.sql" HT_ROLLBACK="$cand/001_brand_owner_epoch_rollback.sql" \
    HT_BEFORE_CANDIDATE="$work/before_001.sql" HT_BEFORE_ROLLBACK="$work/before_rollback.sql" PGSUPER="$super" \
    HT_OWNER="$owner" HT_MID="$mid" HT_DB_AFTER="${prefix}_after" HT_DB_BEFORE="$db_before" \
    PGHOST="$host" PGPORT="$port" PGUSER="$owner" \
    deno test --no-config --no-check --allow-read --allow-env --allow-run=psql "$here/common_account_owner_epoch_history_trigger_pg_test.ts" )
