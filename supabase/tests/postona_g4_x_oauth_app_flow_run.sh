#!/usr/bin/env bash
# G4-48 (Issue #319): the X connect PRODUCT FLOW end to end on a disposable LOCAL PostgreSQL 17 -- the REAL app hook
# (apps/social-mobile/src/features/x-connect/use-x-connect.ts), the REAL @supabase/supabase-js client, the REAL Edge handler
# (supabase/functions/x-oauth-connect-user/index.ts) and the REAL SQL (main + G5's migration candidate + G4 X 001-005), with only
# the outside faked: X (token / users/me), GoTrue (/auth/v1/user) and PostgREST (a psql bridge: the request's JWT claims,
# role authenticated / anon, SQLSTATE -> HTTP as PostgREST documents: 42501 -> 403 / 401, 42883 -> 404, else 400).
# Never production / managed / real Vault / OAuth / X; no network.
# The world, the lifecycle owner and the people (L13-L107 below) are postona_g4_x_oauth_t13_run.sh's (G4-46), copied.
#   1. mode=main : main's X begin / consume / complete only (what users get today)
#   2. mode=g4   : + G4 X 001-005 (the candidate stack, PR #511 -> #547) with the disconnect gate opened by the owner
# The scenarios run in apps/social-mobile/tests/x-connect-product-flow.e2e.mjs (needs `npm ci --ignore-scripts` there first).
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_g4_x_oauth_app_flow_run.sh
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${TQ_PGHOST:?TQ_PGHOST required}"; port="${TQ_PGPORT:?TQ_PGPORT required}"; super="${TQ_PGSUPER:?TQ_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: TQ_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
cand="$repo/supabase/candidates/postona_g4_x_oauth_personal_epoch"
fail() { echo "FAIL $*" >&2; exit 1; }
P21=21a5cad4b71de63265db8517da93c6efc60cdde8
G5=b2e5aaa48af0b4d149c133bf52f923ff683b0ee0
for sha in "$P21" "$G5"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch G5 PR #543 / its base)"
done
n="$$"; owner="kb_g4t13_owner_$n"; prefix="kabumori_g4t13_$n"
work="$(mktemp -d /private/tmp/kabumori-g4t13.XXXXXX)"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local d
  for d in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
tree="$work/pinned"; mkdir -p "$tree"
git -C "$repo" archive "$P21" supabase/migrations supabase/tests supabase/candidates/common_account_brand_owner_epoch | tar -x -C "$tree"
[ "$(git hash-object "$tree/supabase/migrations/20261010051938_common_account_service_write_guard.sql")" = "da587631cfe8872e3ccf6fd521b919a5439c6574" ] \
  || fail "the world's T13 is not the reviewed blob"
install="$work/g5_install.sql"
git -C "$repo" show "$G5:supabase/candidates/postona_personal_auth_migration/20261028090000_postona_personal_auth_install.sql" > "$install"
echo "G5 install blob: $(git -C "$repo" rev-parse "$G5:supabase/candidates/postona_personal_auth_migration/20261028090000_postona_personal_auth_install.sql")"
m="$tree/supabase/migrations"; t="$tree/supabase/tests"
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb createrole;
grant anon, authenticated, service_role to $owner;
SQL

# world <name>: G5-44's world (copied, see the header), then G5's install, as the lifecycle owner
world() {
  local w="$1" f  # (local f: callers keep their own $f)
  "${S[@]}" -d postgres -c "create database ${prefix}_$w owner $owner" >/dev/null
  own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$w" "$@"; }
  own -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
  own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
  for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own -f "$m/$f" >/dev/null; done
  own -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
  own -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
  own -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null
  own -f "$m/20260918120000_social_mobile_brand_memberships.sql" >/dev/null
  for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
           20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state \
           20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
           20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
    own -f "$m/$f.sql" >/dev/null
  done
  own -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" >/dev/null
  own -f "$tree/supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql" >/dev/null
  own -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" >/dev/null
  own -f "$install" >/dev/null
}
own_db() { psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$1" "${@:2}"; }
apply() { # <db> <file> [user]: 'applied' or the first ERROR text
  local out
  if out="$(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "${3:-$owner}" -d "${prefix}_$1" -f "$2" 2>&1)"; then echo applied
  elif grep -q 'ERROR:' <<<"$out"; then sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1
  else echo "PSQL_FAILED $(tail -1 <<<"$out")"; fi
}
A=00000000-0000-4000-8000-000000004401; B=00000000-0000-4000-8000-000000004402; C=00000000-0000-4000-8000-000000004403
SA=00000000-0000-4000-8000-000000004451; SC=00000000-0000-4000-8000-000000004453
claims() { printf '{"sub":"%s","role":"authenticated","session_id":"%s","is_anonymous":%s}' "$1" "$2" "${3:-false}"; }
claims_without_anonymous() { printf '{"sub":"%s","role":"authenticated","session_id":"%s"}' "$1" "$2"; }
# as <db> <claims json> <statement> [before] [commit]: one request as `authenticated`; 'OK <last line>' or 'ERROR <text>'
as() {
  local out
  if out="$(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "${prefix}_$1" \
      -c "begin; ${4:-}" -c "select set_config('request.jwt.claims', '$2', true); set local role authenticated;" -c "$3" -c "${5:-rollback};" 2>&1)"; then
    echo "OK $(tail -1 <<<"$out")"
  else
    echo "ERROR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"
  fi
}
people() {
  own_db "$1" -c "select public.fixture_user_with_workspace('$A'::uuid, 'g4ta'), public.fixture_user_with_workspace('$B'::uuid, 'g4tb'),
    public.fixture_user_with_workspace('$C'::uuid, 'g4tc'); select public.fixture_login(u) from unnest(array['$A', '$B', '$C']::uuid[]) u;
    insert into auth.sessions (id, user_id, not_after) values ('$SA', '$A', null), ('$SC', '$C', null)" >/dev/null
  [ "$(as "$1" "$(claims "$A" "$SA")" "select public.start_x_autopost_service() ->> 'status'" "" "commit;")" = "OK active" ] || fail "people: A not active"
  own_db "$1" -c "update public.brands set code_profile_key = 'social_mobile_user_v1' where id in ('u_' || substr(md5('$A'), 1, 24), 'u_' || substr(md5('$C'), 1, 24))" >/dev/null
}
x4() { local xf; for xf in 001_x_oauth_personal_epoch.sql 002_x_oauth_product_wiring.sql 003_x_disconnect_user_rpc.sql 004_x_consume_preexchange_recheck.sql; do
  [ "$(apply "$1" "$cand/$xf")" = applied ] || fail "$xf on $1: $(apply "$1" "$cand/$xf")"; done; }

# ---- G4-48: the product flow -------------------------------------------------------------------------------------------
app="$repo/apps/social-mobile"
[ -d "$app/node_modules/@supabase/supabase-js" ] && [ -d "$app/node_modules/typescript" ] \
  || fail "run 'npm ci --ignore-scripts' in apps/social-mobile first (the real SDK and TypeScript are needed)"
SB=00000000-0000-4000-8000-000000004452
flow() { # <db> <mode>
  local db="$1" mode="$2" out
  own_db "$db" -c "insert into auth.sessions (id, user_id, not_after) values ('$SB', '$B', null)" >/dev/null
  if out="$(cd "$app" && env FLOW_DEBUG="${FLOW_DEBUG:-}" FLOW_MODE="$mode" FLOW_PGHOST="$host" FLOW_PGPORT="$port" FLOW_PGUSER="$owner" FLOW_PGDATABASE="${prefix}_$db" \
      FLOW_A="$A" FLOW_B="$B" FLOW_C="$C" FLOW_SA="$SA" FLOW_SB="$SB" FLOW_SC="$SC" \
      FLOW_EDGE="${FLOW_EDGE_OVERRIDE:-$repo/supabase/functions/x-oauth-connect-user/index.ts}" \
      node --test --test-reporter=tap tests/x-connect-product-flow.e2e.mjs 2>&1)"; then
    grep -E '^# (tests|pass|fail)|^ok |^not ok ' <<<"$out" | sed "s/^/[$mode] /"
  else
    grep -E "^not ok |^# (tests|pass|fail)|AssertionError|expected|actual|\[flow\]" <<<"$out" | head -40 >&2
    fail "flow $mode"
  fi
}
echo "== 1. mode=main (main's X SQL only)"
world fm; people fm; flow fm main
echo "== 2. mode=g4 (G4 X 001-005, disconnect gate open)"
world fg; x4 fg
[ "$(apply fg "$cand/005_x_connect_lifecycle_t13.sql")" = applied ] || fail "005: $(apply fg "$cand/005_x_connect_lifecycle_t13.sql")"
own_db fg -c "select postona_g4_x_oauth.set_x_disconnect_enabled(true)" >/dev/null
people fg; flow fg g4
echo "G4X_APP_FLOW_ALL_PASS"
