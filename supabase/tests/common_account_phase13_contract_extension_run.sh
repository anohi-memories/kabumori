#!/usr/bin/env bash
# F5 Phase 13: proves the baseline contract v2 (public.ensure_my_profile() shape, public.social_accounts.platform, auth.uid())
# on a THROW-AWAY LOCAL PostgreSQL 17 with fake data. FAIL-before / PASS-after, measured on the REAL code:
#   * the Phase 12 contract = the code of the commit this change is based on (git archive of P13_BASE_COMMIT, run unchanged);
#   * contract v2 = the working tree.
# For each of the cases a baseline copy is mutated (one object removed, retyped, reshaped, moved, or granted to), the read-only
# inventory query is run on it, and the chain P1..P10 is applied to it for the REAL answer (does a chain file refuse?).
# contract_extension_proof.ts then reads the inventories with both contracts and checks the table in its header.
# No production schema, no managed project, no credential, no network. Usage:
#   CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> bash supabase/tests/common_account_phase13_contract_extension_run.sh
# Optional: P13_BASE_COMMIT (default: the Phase 13 architecture-plan head this change is stacked on),
#           P13_REPO_ROOT (a tree with supabase/preflight, supabase/tests, supabase/migrations: the mutation script points it at a mutant copy),
#           P13_GIT_ROOT (the real checkout, for `git archive` of the base commit; defaults to the checkout this script is in).
set -euo pipefail
export LC_ALL=C PGTZ=UTC
host="${CAL_PGHOST:?CAL_PGHOST required}"; port="${CAL_PGPORT:?CAL_PGPORT required}"; super="${CAL_PGSUPER:?CAL_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: CAL_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"; git_root="${P13_GIT_ROOT:-$(git -C "$here" rev-parse --show-toplevel)}"
repo="${P13_REPO_ROOT:-$git_root}"
base_commit="${P13_BASE_COMMIT:-2a626cd49f55611258c7695f0b84cb2a917d4595}"
m="$repo/supabase/migrations"; t="$repo/supabase/tests"; d="$repo/supabase/preflight/managed_disposable"
n="$$"; owner="kb_p13c_owner_$n"; prefix="kabumori_p13c_$n"; base="${prefix}_base"
work="$(mktemp -d "${TMPDIR:-/tmp}/p13c.XXXXXX")"
S=(psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${S[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
  done
  "${S[@]}" -d postgres -c "drop role if exists $owner" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# ---- the Phase 12 code, exactly as it was (the base commit), in a scratch directory
git -C "$git_root" cat-file -e "${base_commit}^{commit}" 2>/dev/null || { echo "Refusing: base commit $base_commit is not in this repository." >&2; exit 2; }
mkdir -p "$work/old"
git -C "$git_root" archive "$base_commit" supabase/preflight/managed_disposable | tar -x -C "$work/old"
if grep -q "CONTRACT_VERSION" "$work/old/supabase/preflight/managed_disposable/baseline_requirements.ts"; then
  echo "Refusing: the base commit already carries contract v2; it is not the Phase 12 code." >&2; exit 2
fi

# ---- the model baseline (the recipe of the Phase 13 prerequisite oracle): fixtures + the three real prerequisite migrations
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
create database $base owner $owner;
SQL
own() { local db="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
own "$base" -f "$t/social_mobile_account_deletion_fixture.sql" >/dev/null
own "$base" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1 || true
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do own "$base" -f "$m/$f" >/dev/null; done
own "$base" -f "$t/common_account_lifecycle_fixture.sql" >/dev/null
own "$base" -f "$t/common_account_phase9_auth_fixture.sql" >/dev/null
own "$base" -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" >/dev/null

CHAIN_IDS=(P1 P2 P3a P3b P4 P5 P6 P8 P9 P10)
CHAIN_FILES=(20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent
  20261009120000_common_account_deletion_completion 20261010051938_common_account_service_write_guard
  20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state
  20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts
  20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record)
apply_chain() { # database -> "OK" | "FAIL <id> <first refusal>"
  local db="$1" i out
  for i in "${!CHAIN_FILES[@]}"; do
    out="$(own "$db" -f "$m/${CHAIN_FILES[$i]}.sql" 2>&1 >/dev/null)" || {
      echo "FAIL ${CHAIN_IDS[$i]} $(printf '%s\n' "$out" | grep -m1 'ERROR' | sed 's/^.*ERROR:  *//' | cut -c1-150)"; return 0; }
  done
  echo OK
}

# ---- the cases: id <TAB> description <TAB> mutation (SQL run as the owner on a copy of the baseline)
: > "$work/cases.tsv"
run_case() { # id description mutation-sql
  local id="$1" description="$2" sql="$3" db inventory chain mutation
  db="${prefix}_$(printf '%s' "$1" | tr 'A-Z' 'a-z')" # an unquoted CREATE DATABASE folds the name to lower case
  "${S[@]}" -d postgres -c "create database $db template $base owner $owner" >/dev/null
  if [[ -n "$sql" ]]; then
    if ! mutation="$(own "$db" -c "$sql" 2>&1 >/dev/null)"; then echo "case $id: the mutation itself failed: $(printf '%s' "$mutation" | head -1)" >&2; exit 3; fi
  fi
  inventory="$work/inventory_$id.ndjson"
  psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$d/inventory/schema_inventory.sql" > "$inventory"
  chain="$(apply_chain "$db")"
  printf '%s\t%s\t%s\t%s\n' "$id" "$description" "$inventory" "$chain" >> "$work/cases.tsv"
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
}
run_case C00 "control: the unmodified model baseline" ""
run_case C01 "public.ensure_my_profile() dropped" "drop function public.ensure_my_profile()"
run_case C02 "ensure_my_profile() returns bigint" "drop function public.ensure_my_profile(); create function public.ensure_my_profile() returns bigint language sql as \$\$ select 1::bigint \$\$"
run_case C03 "ensure_my_profile() is a security definer" "alter function public.ensure_my_profile() security definer"
run_case C04 "only an overload ensure_my_profile(uuid) exists" "alter function public.ensure_my_profile() rename to ensure_my_profile_old; create function public.ensure_my_profile(p uuid) returns uuid language sql as \$\$ select p \$\$"
run_case C05 "ensure_my_profile() moved to schema private" "alter function public.ensure_my_profile() set schema private"
run_case C06 "social_accounts.platform dropped" "alter table public.social_accounts drop column platform"
run_case C07 "social_accounts.platform is varchar(16)" "alter table public.social_accounts alter column platform type varchar(16)"
run_case C08 "auth.uid() dropped" "drop function auth.uid() cascade"
run_case C09 "auth.uid() returns text" "drop function auth.uid() cascade; create function auth.uid() returns text language sql stable as \$\$ select null::text \$\$"
run_case C10 "unexpected grant: ensure_my_profile() executable by anon" "grant execute on function public.ensure_my_profile() to anon"
run_case C11 "ensure_my_profile() body replaced (same shape, language, volatility, search_path): P4 overwrites the body, so it is not fingerprinted" "create or replace function public.ensure_my_profile() returns uuid language plpgsql volatile security invoker set search_path = '' as \$function\$ declare v_user uuid := (select auth.uid()); begin return v_user; end \$function\$"
run_case C12 "unexpected grant: social_accounts readable by authenticator" "grant select on public.social_accounts to authenticator"
run_case C13 "social_accounts.platform loses NOT NULL" "alter table public.social_accounts alter column platform drop not null"
run_case C14 "a key-shaped function name is planted" "create function public.s_sb""_secret_P13Planted0123456789() returns int language sql as \$\$ select 1 \$\$"
run_case C15 "Phase 1 helper social_mobile_account_deletion_subject dropped" "drop function public.social_mobile_account_deletion_subject(uuid)"
run_case C18 "ensure_my_profile() language changed to sql (a stable attribute)" "create or replace function public.ensure_my_profile() returns uuid language sql volatile security invoker set search_path = '' as \$\$ select auth.uid() \$\$"
run_case C19 "ensure_my_profile() body mentions a URL (flag only; the body itself is never read)" "create or replace function public.ensure_my_profile() returns uuid language plpgsql volatile security invoker set search_path = '' as \$function\$ declare v_user uuid := (select auth.uid()); begin perform 'https://hooks.example.test/x'; return v_user; end \$function\$"

# ---- the baseline read-back is re-run before EVERY chain file (one file per invocation): after each prefix of the chain it must still pass
run_prefix_cases() {
  local db="${prefix}_kprefix" i id inventory out
  "${S[@]}" -d postgres -c "create database $db template $base owner $owner" >/dev/null
  for i in "${!CHAIN_FILES[@]}"; do
    out="$(own "$db" -f "$m/${CHAIN_FILES[$i]}.sql" 2>&1 >/dev/null)" || { echo "prefix case: ${CHAIN_IDS[$i]} refused on the unmodified baseline: $(printf '%s' "$out" | grep -m1 ERROR)" >&2; exit 3; }
    id="$(printf 'K%02d' $((i + 1)))"
    inventory="$work/inventory_$id.ndjson"
    psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$d/inventory/schema_inventory.sql" > "$inventory"
    printf '%s\t%s\t%s\t%s\n' "$id" "the chain is applied through ${CHAIN_IDS[$i]} (the read-back before the next file)" "$inventory" "OK" >> "$work/cases.tsv"
  done
  "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null
}
run_prefix_cases

( cd "$repo" && P13_CASES="$work/cases.tsv" P13_OLD_DIR="$work/old/supabase/preflight/managed_disposable" P13_OWNER="$owner" P13_REPO_ROOT="$repo" \
    deno run --no-config --no-check --allow-read --allow-env "$d/contract_extension_proof.ts" )
