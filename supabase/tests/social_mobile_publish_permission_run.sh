#!/usr/bin/env bash
# Disposable-only proof runner for the publish-permission boundary
# (20261003090000). Creates a throwaway database on a LOCAL Unix-socket
# PostgreSQL cluster, applies the production-shaped fixture, the REAL
# unmodified migrations it builds on (X OAuth onboarding/reconnect, refresh
# core, refresh rollout, account deletion) and then the candidate, all as a
# non-superuser owner; runs the behavior proof and the concurrency proofs;
# drops the database. Fake data only; never production.
# With PUB_E2E=1 it also runs the end-to-end proofs: the partial-rollout state
# "guarded runtime, migration not applied" BEFORE applying the candidate, and
# the post-migration scenarios after the race proofs.
# The adverse role-graph proof is a separate runner that must run alone on the
# cluster: social_mobile_publish_permission_acl.sh.
# Usage: PUB_PGHOST=/private/tmp/<socket-dir> PUB_PGPORT=<port> \
#        PUB_PGSUPER=<local superuser> supabase/tests/social_mobile_publish_permission_run.sh
# PUB_CANDIDATE=<file> runs the same proof against another copy of the
# candidate (used only by social_mobile_publish_permission_mutations.sh).
# The server must answer in English (lc_messages=C): the proofs match on
# PostgreSQL's own "lock timeout" / "deadlock" wording.
set -euo pipefail
export LC_ALL=C

host="${PUB_PGHOST:?PUB_PGHOST (local socket dir) required}"
port="${PUB_PGPORT:?PUB_PGPORT required}"
super="${PUB_PGSUPER:?PUB_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: PUB_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac

db="kabumori_publish_permission_$$"
owner="kb_publish_permission_owner"
here="$(cd "$(dirname "$0")" && pwd)"
migrations="$here/../migrations"
candidate="${PUB_CANDIDATE:-$migrations/20261003090000_social_mobile_publish_permission_boundary.sql}"
psql_bin="${PSQL:-psql}"
as_super=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
as_owner=("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")
# -A -t: unaligned, tuples only. Used for every concurrent session.
session=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db")

tmp="$(mktemp -d /private/tmp/kabumori-publish-permission.XXXXXX)"
cleanup() {
  "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true
}
trap 'rm -rf "$tmp"; cleanup' EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

"${as_super[@]}" -d postgres 2>/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then
    create role $owner login nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
grant anon, authenticated, service_role to $owner;
create database $db owner $owner;
SQL

"${as_owner[@]}" -f "$here/social_mobile_publish_permission_fixture.sql"
for real in \
  20260919120000_social_mobile_x_oauth_onboarding.sql \
  20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql \
  20260925140000_x_account_credential_refresh_core.sql \
  20260926032054_x_account_refresh_rollout_authority.sql \
  20260928160000_social_mobile_account_deletion_candidate.sql; do
  "${as_owner[@]}" -f "$migrations/$real" >/dev/null
done

uid() { printf '00000000-0000-4000-8000-0000000002%02d' "$1"; }
mk() { "${as_owner[@]}" -A -t -c "select public.fixture_brand('$1', '$2')"; }
sql() { "${as_owner[@]}" -A -t -c "$1"; }

# ---- End to end, before the candidate (optional: PUB_E2E=1, needs deno) ---------------
# The first partial rollout state of the approved order: the guarded runtime is live, the
# permission migration is not applied yet. The shim stays up for the end-to-end proof below.
e2e_count() { # file, expected passes
  grep -Eq "(^|[^0-9])$2 passed \| 0 failed" "$1" || fail "e2e did not pass exactly $2 scenarios: $(cat "$1")"
  if grep -q 'ignored' "$1" && ! grep -q '0 ignored' "$1"; then fail "e2e scenarios were skipped: $(cat "$1")"; fi
}
if [[ "${PUB_E2E:-0}" == 1 ]]; then
  command -v deno >/dev/null || fail "PUB_E2E=1 needs deno"
  shim_port="${PUB_E2E_PORT:-$((54400 + $$ % 500))}"
  # Started from a subshell so that the race proofs' bare `wait` does not wait for it.
  (
    PUB_PGHOST="$host" PUB_PGPORT="$port" PUB_DB="$db" PUB_OWNER="$owner" SHIM_PORT="$shim_port" \
      SHIM_ANON_KEY="local-anon-$$" SHIM_SERVICE_KEY="local-service-$$" DENO_NO_PACKAGE_JSON=1 \
      deno run --no-config --allow-net=127.0.0.1 --allow-env --allow-run=psql \
      "$here/social_mobile_publish_permission_postgrest_shim.ts" > "$tmp/shim" 2>&1 &
    echo $! > "$tmp/shim.pid"
  )
  shim_pid="$(cat "$tmp/shim.pid")"
  trap 'kill "$shim_pid" 2>/dev/null || true; rm -rf "$tmp"; cleanup' EXIT
  for _ in $(seq 1 100); do grep -q SHIM_READY "$tmp/shim" 2>/dev/null && break; sleep 0.1; done
  grep -q SHIM_READY "$tmp/shim" || fail "e2e shim did not start: $(cat "$tmp/shim")"
  e2e_env=(PUB_E2E_URL="http://127.0.0.1:$shim_port" PUB_E2E_ANON_KEY="local-anon-$$" PUB_E2E_SERVICE_KEY="local-service-$$" DENO_NO_PACKAGE_JSON=1 NO_COLOR=1)
  pre_owner="$(uid 40)"
  sql "select public.fixture_brand('$pre_owner', 'e2e_pre', 'brand_e2e_pre')" >/dev/null
  sql "update public.social_accounts set publish_enabled = true where id = 'sa_e2e_pre'" >/dev/null
  pre_post="$(sql "select public.fixture_running_post('brand_e2e_pre')")"
  env "${e2e_env[@]}" \
    PUB_E2E_FIXTURE="{\"owner\":\"$pre_owner\",\"workspace\":{\"brand\":\"brand_e2e_pre\",\"account\":\"sa_e2e_pre\",\"post\":\"$pre_post\"}}" \
    deno test --no-config --allow-net=127.0.0.1 --allow-env --allow-read \
    "$here/social_mobile_publish_permission_rollout_e2e_test.ts" > "$tmp/e2e_rollout" 2>&1 || fail "rollout e2e: $(cat "$tmp/e2e_rollout")"
  e2e_count "$tmp/e2e_rollout" 2
  echo "PUBLISH_PERMISSION_ROLLOUT_E2E_PASS"
fi

"${as_owner[@]}" -f "$candidate"
if "${as_owner[@]}" -f "$candidate" > /dev/null 2>&1; then fail "re-apply was not refused"; fi
echo "PUBLISH_PERMISSION_APPLY_PASS"

out="$("${as_owner[@]}" -A -t -f "$here/social_mobile_publish_permission_behavior.sql" 2>&1)" || { echo "$out" >&2; exit 1; }
grep -q PUBLISH_PERMISSION_BEHAVIOR_PASS <<<"$out" || fail "behavior: $out"
if grep -q 'fake_' <<<"$out"; then fail "token material in output"; fi
echo "PUBLISH_PERMISSION_BEHAVIOR_PASS"

# ---- Concurrency proofs ----------------------------------------------------------
# Every race uses its own user/workspace/account. "held" sessions keep their
# transaction open with pg_sleep so the other session provably runs in between.
toggle() { echo "select public.fixture_toggle('$1', '$2', $3, $4)"; }
enabled() { sql "select publish_enabled from public.social_accounts where id = '$1'"; }
permission() { sql "select public.fixture_permission('$1', '$2', '$3')"; }
hold() { "${session[@]}" -c "begin; $1; select pg_sleep($2); commit;" > "$3" 2>&1 & }
expect() { grep -qF -- "$2" "$1" || fail "$3: $(cat "$1")"; }

# R1 (a). The caller's membership is being removed when the request arrives
# and is gone before the write: the switch waits for it and then refuses.
# (The reviewed PR #76 head a59a89e9 enabled the account in this schedule.)
u="$(uid 1)"; w="$(mk "$u" r1a)"
hold "delete from public.brand_memberships where brand_id = '$w' and user_id = '$u'" 2 "$tmp/r1a_writer"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_r1a true false)" > "$tmp/r1a" 2>&1
wait
expect "$tmp/r1a" '{"status": "not_found"}' "R1a membership removed before the write"
[[ "$(enabled sa_r1a)" == f ]] || fail "R1a: the account was enabled without a current membership"

# R1 (b). Demoted to viewer before the write. Same for OFF.
u="$(uid 2)"; w="$(mk "$u" r1b)"
hold "update public.brand_memberships set role = 'viewer' where brand_id = '$w' and user_id = '$u'" 2 "$tmp/r1b_writer"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_r1b true false)" > "$tmp/r1b" 2>&1
wait
expect "$tmp/r1b" '{"status": "forbidden"}' "R1b demoted before the write"
[[ "$(enabled sa_r1b)" == f ]] || fail "R1b: the account was enabled by a viewer"
sql "update public.brand_memberships set role = 'owner' where brand_id = '$w' and user_id = '$u'; update public.social_accounts set publish_enabled = true where id = 'sa_r1b'" >/dev/null
hold "delete from public.brand_memberships where brand_id = '$w' and user_id = '$u'" 2 "$tmp/r1b_writer"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_r1b false true)" > "$tmp/r1b_off" 2>&1
wait
expect "$tmp/r1b_off" '{"status": "not_found"}' "R1b OFF after the membership was removed"
[[ "$(enabled sa_r1b)" == t ]] || fail "R1b: OFF was written without a current membership"

# A caller who is not a member of the account's brand never waits on (and so
# never takes) a lock on that tenant's rows: the answer is immediate even
# while the brand and account rows are locked by someone else.
u="$(uid 13)"; w="$(mk "$u" nolock)"; stranger="$(uid 14)"
sql "insert into auth.users values ('$stranger')" >/dev/null
hold "select 1 from public.brands where id = '$w' for update; select 1 from public.social_accounts where id = 'sa_nolock' for update" 2 "$tmp/nolock_holder"
sleep 0.5
"${session[@]}" > "$tmp/nolock" 2>&1 <<SQL
select clock_timestamp() as t0 \gset
select public.fixture_toggle('$stranger', 'sa_nolock', true, false);
select 'waited_ms=' || (extract(epoch from clock_timestamp() - :'t0'::timestamptz) * 1000)::int;
SQL
wait
expect "$tmp/nolock" '{"status": "not_found"}' "foreign caller"
waited="$(sed -n 's/^waited_ms=//p' "$tmp/nolock")"
[[ -n "$waited" && "$waited" -lt 1000 ]] || fail "foreign caller waited on another tenant's locks (${waited}ms)"

# R1 (c) + R2 (b). The switch decided first: until it commits, nobody can
# remove the membership, change the role, disable the brand or move the
# account it relied on.
u="$(uid 3)"; w="$(mk "$u" r1c)"
hold "$(toggle "$u" sa_r1c true false)" 3 "$tmp/r1c"
sleep 0.5
for writer in \
  "delete from public.brand_memberships where brand_id = '$w' and user_id = '$u'" \
  "update public.brand_memberships set role = 'viewer' where brand_id = '$w' and user_id = '$u'" \
  "update public.brands set is_active = false where id = '$w'" \
  "update public.brands set publish_mode = 'disabled' where id = '$w'" \
  "update public.social_accounts set brand_id = 'brand_b' where id = 'sa_r1c'"; do
  if "${session[@]}" -c "set lock_timeout = '300ms'; $writer" > "$tmp/r1c_writer" 2>&1; then
    fail "R1c: a permission-changing writer was not blocked by the switch: $writer"
  fi
  expect "$tmp/r1c_writer" 'lock timeout' "R1c writer blocked for another reason ($writer)"
done
wait
expect "$tmp/r1c" '{"status": "updated", "publish_enabled": true}' "R1c the switch itself"
[[ "$(enabled sa_r1c)" == t ]] || fail "R1c: not enabled"
[[ "$(sql "select m.role || '/' || b.is_active::text || '/' || b.publish_mode from public.brand_memberships m join public.brands b on b.id = m.brand_id where m.brand_id = '$w' and m.user_id = '$u'")" == "owner/true/live" ]] \
  || fail "R1c: the authority the switch relied on changed underneath it"

# R2 (a). The brand is being disabled when ON arrives: ON waits and is refused.
u="$(uid 4)"; w="$(mk "$u" r2a)"
hold "update public.brands set is_active = false where id = '$w'" 2 "$tmp/r2a_writer"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_r2a true false)" > "$tmp/r2a" 2>&1
wait
expect "$tmp/r2a" '"reason": "BRAND_INACTIVE"' "R2a brand disabled before ON"
[[ "$(enabled sa_r2a)" == f ]] || fail "R2a: ON was written for a disabled brand"

# R2 (H1 schedule). (1) brand live, account OFF. (2) ON is decided and stays
# uncommitted. (3) The dispatcher reads the brand: live. (4) The brand is
# disabled: it must wait for (2). (5) ON commits while the brand is still
# live. (6) The dispatcher reads the account: ON, and its cached brand says
# live. The pre-send permission check must refuse: brand disabled.
u="$(uid 5)"; w="$(mk "$u" r2h)"
post="$(sql "select public.fixture_running_post('$w')")"
hold "$(toggle "$u" sa_r2h true false)" 2 "$tmp/r2h_toggle"
sleep 0.5
cached_brand="$(sql "select is_active::text || '/' || publish_mode from public.brands where id = '$w'")"
"${session[@]}" -c "update public.brands set is_active = false where id = '$w' returning 'disabled_after_ms=' || (extract(epoch from clock_timestamp() - statement_timestamp()) * 1000)::int" > "$tmp/r2h_disable" 2>&1 &
wait
expect "$tmp/r2h_toggle" '"status": "updated"' "R2h ON"
waited="$(sed -n 's/^disabled_after_ms=//p' "$tmp/r2h_disable")"
[[ -n "$waited" && "$waited" -ge 1000 ]] || fail "R2h: the brand disable did not wait for the uncommitted ON ($(cat "$tmp/r2h_disable"))"
cached_account="$(enabled sa_r2h)"
[[ "$cached_brand" == "true/live" && "$cached_account" == t ]] || fail "R2h: the stale dispatcher context is not the one under test ($cached_brand, $cached_account)"
[[ "$(permission "$post" sa_r2h "$w")" == BRAND_DISABLED ]] || fail "R2h: a stale brand context could still authorize a send"

# R3. The account is moved to a foreign brand (and is ON there) while the
# request waits: no mutation, and no state of the foreign brand is returned.
u="$(uid 6)"; w="$(mk "$u" r3)"
sql "insert into public.brands (id) values ('brand_r3_dest'), ('brand_r3_own'); select public.fixture_member('brand_r3_own', '$u', 'owner')" >/dev/null
hold "update public.social_accounts set brand_id = 'brand_r3_dest', publish_enabled = true where id = 'sa_r3'" 2 "$tmp/r3_writer"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_r3 true false)" > "$tmp/r3" 2>&1
wait
expect "$tmp/r3" '{"status": "not_found"}' "R3 account moved to a foreign brand"
if grep -q 'publish_enabled' "$tmp/r3"; then fail "R3: foreign state leaked: $(cat "$tmp/r3")"; fi
"${session[@]}" -c "$(toggle "$u" sa_r3 false true)" > "$tmp/r3_off" 2>&1
expect "$tmp/r3_off" '{"status": "not_found"}' "R3 the moved account stays out of reach"
[[ "$(enabled sa_r3)" == t ]] || fail "R3: the foreign account was changed"
# Moved to ANOTHER brand of the same caller: the membership that was proven is
# for the old brand, so nothing is written on it.
u2="$(uid 16)"; w2="$(mk "$u2" r3b)"
sql "insert into public.brands (id) values ('brand_r3b_own'); select public.fixture_member('brand_r3b_own', '$u2', 'owner')" >/dev/null
hold "update public.social_accounts set brand_id = 'brand_r3b_own' where id = 'sa_r3b'" 2 "$tmp/r3b_writer"
sleep 0.5
"${session[@]}" -c "$(toggle "$u2" sa_r3b true false)" > "$tmp/r3b" 2>&1
wait
expect "$tmp/r3b" '{"status": "not_found"}' "R3 account moved between two brands of the caller"
[[ "$(enabled sa_r3b)" == f ]] || fail "R3: written on authority proven for another brand"

# The account row itself is deleted while the request waits.
u="$(uid 17)"; w="$(mk "$u" r3d)"
hold "delete from public.social_accounts where id = 'sa_r3d'" 2 "$tmp/r3d_writer"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_r3d true false)" > "$tmp/r3d" 2>&1
wait
expect "$tmp/r3d" '{"status": "not_found"}' "R3 account deleted before the write"

# Compare-and-set under concurrency. Two identical ON requests: one change,
# one stale. Then ON racing OFF: both apply in order, deterministically.
u="$(uid 7)"; w="$(mk "$u" cas)"
hold "$(toggle "$u" sa_cas true false)" 1.5 "$tmp/cas_first"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_cas true false)" > "$tmp/cas_second" 2>&1
wait
expect "$tmp/cas_first" '{"status": "updated", "publish_enabled": true}' "CAS first ON"
expect "$tmp/cas_second" '{"status": "stale", "publish_enabled": true}' "CAS duplicate ON"
sql "update public.social_accounts set publish_enabled = false where id = 'sa_cas'" >/dev/null
hold "$(toggle "$u" sa_cas true false)" 1.5 "$tmp/cas_on"
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_cas false true)" > "$tmp/cas_off" 2>&1
wait
expect "$tmp/cas_on" '"status": "updated"' "CAS ON then OFF: ON"
expect "$tmp/cas_off" '{"status": "updated", "publish_enabled": false}' "CAS ON then OFF: OFF applies after the ON it expected"
[[ "$(enabled sa_cas)" == f ]] || fail "CAS: final state is not OFF"

# OFF and in-flight sends. A send whose permission check ran before OFF was
# committed is in flight (the check passed on the committed state); once OFF
# is committed no new send is authorized.
u="$(uid 8)"; w="$(mk "$u" off)"
post="$(sql "select public.fixture_running_post('$w')")"
sql "$(toggle "$u" sa_off true false)" >/dev/null
hold "$(toggle "$u" sa_off false true)" 1.5 "$tmp/off"
sleep 0.5
[[ "$(permission "$post" sa_off "$w")" == authorized ]] || fail "OFF: an uncommitted OFF already refused a send"
wait
[[ "$(permission "$post" sa_off "$w")" == X_ACCOUNT_PUBLISH_DISABLED ]] || fail "OFF: a send was authorized after OFF committed"

# Account deletion. Deletion first: the switch waits for it and answers busy.
u="$(uid 9)"; w="$(mk "$u" del)"
"${session[@]}" -c "begin; set local role service_role; select public.social_mobile_account_deletion_acquire('$u', 'social_and_login', false); reset role; select pg_sleep(2); commit;" > "$tmp/del_acquire" 2>&1 &
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_del true false)" > "$tmp/del" 2>&1
wait
expect "$tmp/del_acquire" '"status": "acquired"' "deletion start"
expect "$tmp/del" '{"status": "busy"}' "ON racing an account deletion"
[[ "$(enabled sa_del)" == f ]] || fail "deletion: the account was enabled under a tombstone"
# The switch first: the deletion waits and then starts normally.
u="$(uid 10)"; w="$(mk "$u" del2)"
hold "$(toggle "$u" sa_del2 true false)" 1.5 "$tmp/del2"
sleep 0.5
"${session[@]}" -c "set role service_role; select public.social_mobile_account_deletion_acquire('$u', 'social_and_login', false);" > "$tmp/del2_acquire" 2>&1
wait
expect "$tmp/del2" '"status": "updated"' "switch before deletion"
expect "$tmp/del2_acquire" '"status": "acquired"' "deletion after the switch"

# Lock order against the refresh commit. The commit functions take SHARE ROW
# EXCLUSIVE on social_accounts and then the account row (core migration,
# commit_x_account_refresh_legacy_post). The switch takes its table lock
# before any row lock, so it queues behind the commit instead of deadlocking
# with it; neither side is cancelled.
u="$(uid 11)"; w="$(mk "$u" lock)"
"${session[@]}" -c "begin; lock table public.social_accounts in share row exclusive mode; select pg_sleep(1.5); select 'row_locked' from public.social_accounts where id = 'sa_lock' for update; update public.social_accounts set last_connection_error_code = null where id = 'sa_lock'; commit;" > "$tmp/lock_commit" 2>&1 &
sleep 0.5
"${session[@]}" -c "$(toggle "$u" sa_lock true false)" > "$tmp/lock" 2>&1 || true
wait
expect "$tmp/lock_commit" 'row_locked' "lock order: the refresh-commit-shaped transaction"
if grep -qi 'deadlock\|error' "$tmp/lock_commit" "$tmp/lock"; then fail "lock order: $(cat "$tmp/lock_commit" "$tmp/lock")"; fi
expect "$tmp/lock" '{"status": "updated", "publish_enabled": true}' "lock order: the switch queues behind the commit-shaped transaction"

# Bounded waiting: a lock the switch cannot get in time is answered busy.
u="$(uid 12)"; w="$(mk "$u" wait)"
"${session[@]}" -c "begin; lock table public.social_accounts in share row exclusive mode; select pg_sleep(5); commit;" > "$tmp/wait_holder" 2>&1 &
sleep 0.5
start=$SECONDS
"${session[@]}" -c "$(toggle "$u" sa_wait true false)" > "$tmp/wait" 2>&1
elapsed=$((SECONDS - start))
expect "$tmp/wait" '{"status": "busy"}' "bounded wait"
[[ "$elapsed" -le 4 ]] || fail "bounded wait: the switch waited ${elapsed}s"
wait
[[ "$(enabled sa_wait)" == f ]] || fail "bounded wait: busy still changed the account"
echo "PUBLISH_PERMISSION_RACE_PASS"

# ---- End to end (optional: PUB_E2E=1, needs deno) -----------------------------------
# The real Edge handler, the real brand-context loader / cached guard, the real
# Vault send adapter and the real refresh SQL, over HTTP, against the SQL above,
# through the shim started before the candidate. Only X is fake.
if [[ "${PUB_E2E:-0}" == 1 ]]; then
  e2e_owner="$(uid 31)"; e2e_viewer="$(uid 32)"; e2e_stranger="$(uid 33)"
  sql "insert into auth.users values ('$e2e_stranger')" >/dev/null
  workspaces=""
  for name in basic blocked send r2 off f1v f1e retry retryoff; do
    brand="brand_e2e_$name"
    sql "select public.fixture_brand('$e2e_owner', 'e2e_$name', '$brand')" >/dev/null
    e2e_post="$(sql "select public.fixture_running_post('$brand')")"
    workspaces+="${workspaces:+,}\"$name\":{\"brand\":\"$brand\",\"account\":\"sa_e2e_$name\",\"post\":\"$e2e_post\"}"
  done
  sql "select public.fixture_member('brand_e2e_basic', '$e2e_viewer', 'viewer')" >/dev/null
  env "${e2e_env[@]}" \
    PUB_E2E_FIXTURE="{\"owner\":\"$e2e_owner\",\"viewer\":\"$e2e_viewer\",\"stranger\":\"$e2e_stranger\",\"workspaces\":{$workspaces}}" \
    deno test --no-config --allow-net=127.0.0.1 --allow-env --allow-read \
    "$here/social_mobile_publish_permission_e2e_test.ts" > "$tmp/e2e" 2>&1 || fail "e2e: $(cat "$tmp/e2e")"
  kill "$shim_pid" 2>/dev/null || true
  e2e_count "$tmp/e2e" 9
  echo "PUBLISH_PERMISSION_E2E_PASS"
fi

if grep -rq 'fake_' "$tmp"; then fail "token material in race output"; fi
cleanup
left="$("${as_super[@]}" -A -t -d postgres -c "select count(*) from pg_database where datname = '$db'")"
[[ "$left" == 0 ]] || fail "cleanup left database $db"
echo "PUBLISH_PERMISSION_CLEANUP_PASS"
