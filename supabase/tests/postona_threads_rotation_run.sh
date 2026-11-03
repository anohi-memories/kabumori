#!/usr/bin/env bash
# F4 POSTONA Threads credential rotation CAS (threads_credential_rotation_candidate.sql) against the REAL G5 lifecycle
# (T13 writer guard, Phase 4, F5 workspace service state, Phase 6). Disposable and local only; never production,
# never a managed Supabase, never Vault or Meta.
#
# 1. Builds a throwaway tree under /private/tmp from this checkout's working tree plus BOUNDED, READ-ONLY copies of
#    F5 PR #178 83334a091ded5571cf595fd99d7a035627564735 (the Phase 3b guard fixture, the Phase 3b guard (T13),
#    Phase 4, the F5 workspace service state and Phase 6). Nothing is merged, checked out or pushed; an overlay
#    path that already exists stops the run. PR #124's candidate and fixture are already in this tree (PR #251);
#    they must be byte-identical to PR #124 c30f246409a77080cbc03aef6c4cb72b5481e125.
# 2. On a LOCAL Unix-socket PostgreSQL 17 cluster, as a per-run non-superuser owner, the world of
#    postona_threads_t13_run.sh: G5's lifecycle fixtures and REAL migrations, X + Phase 2a-2, PR #124, the G4
#    publish stack (custody -> manual publish -> release), the Threads cleanup and disconnect candidates,
#    postona_threads_t13_fixture.sql and the F4 writer guards. Then:
#      a. preconditions of the rotation candidate (owner, drifted custody reader / table, F5's state decision
#         missing or reachable by an API role, publish stack missing); re-apply refused;
#      b. postona_threads_rotation_behavior.sql (ACL, end to end with the publish release, posts in flight, replay,
#         cross account / workspace, owner change, every F5 state, reconnect, disconnect, expiry, lease, Vault
#         failure rollback, server only, deletion cleanup with a lease held, the secret changed under the lease);
#      c. two-session races: disconnect, reconnect, a publish release, an owner freeze, the same rotate twice, two
#         claims, a lifecycle row held past the lock timeout, the lock order (lifecycle before workspace) for rotate
#         and claim, a stray lease that must not queue on the owner's lifecycle rows, and the checked-owner binding
#         (J2 V2 R1): the owner changes to an ended person while a claim's lifecycle decision waits; the owner changes
#         back (ABA) while a rotate's decision waits on another person; a lease's owner is rewritten under a rotate;
#      d. fail-before: the behavior file fails on the same world WITHOUT the candidate, and the three owner-binding
#         races fail on PR #258's candidate 713955b5371cf4f1de4681ecec1737e1ccc7d4cd (before the J2 R1 fix);
#      e. mutations of the candidate must FAIL the proof.
# Requires the git objects of both SHAs. Usage:
#   THREADS_PGHOST=/private/tmp/<socket-dir> THREADS_PGPORT=<port> THREADS_PGSUPER=<superuser> \
#     supabase/tests/postona_threads_rotation_run.sh
set -euo pipefail
export LC_ALL=C

host="${THREADS_PGHOST:?THREADS_PGHOST (local socket dir) required}"
port="${THREADS_PGPORT:?THREADS_PGPORT required}"
super="${THREADS_PGSUPER:?THREADS_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: THREADS_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
PR124=c30f246409a77080cbc03aef6c4cb72b5481e125
PR178=83334a091ded5571cf595fd99d7a035627564735
PR258=713955b5371cf4f1de4681ecec1737e1ccc7d4cd
for sha in "$PR124" "$PR178" "$PR258"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-threads-rotation.XXXXXX)"
n="$$"
owner="kb_threads_rot_owner_$n"
prefix="kabumori_threads_rot_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree --------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/ROT_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the F4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/ROT_MANIFEST.txt"; done
}
for path in supabase/candidates/postona_threads_oauth_workspace_candidate.sql supabase/tests/postona_threads_oauth_test_fixture.sql; do
  git -C "$repo" show "$PR124:$path" | cmp -s - "$tree/$path" || fail "$path in this tree is not PR #124's"
  echo "$PR124 $(shasum -a 256 "$tree/$path" | cut -c1-16) $path (in tree, identical)" >> "$tree/ROT_MANIFEST.txt"
done
overlay "$PR178" supabase/tests/common_account_write_guard_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
candidate="${THREADS_ROTATION_CANDIDATE:-$c/postona_threads_publish/threads_credential_rotation_candidate.sql}"

# ---- 2. The real G5 world (as postona_threads_t13_run.sh builds it) ---------------------------------------------
"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb nocreaterole;
grant anon, authenticated, service_role to $owner;
SQL
as_owner() { local db="$1"; shift; "$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
q() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
create_db() { "${as_super[@]}" -d postgres -c "create database $1 owner $owner${2:+ template $2}" > /dev/null; }
copy() { local db="${prefix}_$1"; create_db "$db" "$2"; echo "$db"; }
apply() {
  local db="$1" file="$2" out
  if out="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" -f "$file" 2>&1)"; then echo applied
  else sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1; fi
}

world="${prefix}_world"
create_db "$world"
as_owner "$world" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$world" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$world" -f "$m/$f" > /dev/null
done
as_owner "$world" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation.sql 20261006230000_common_account_service_start_intent.sql 20261009120000_common_account_deletion_completion.sql; do
  as_owner "$world" -f "$m/$f" > /dev/null
done
as_owner "$world" -f "$t/common_account_write_guard_fixture.sql" > /dev/null
for f in 20261010051938_common_account_service_write_guard.sql 20261012130000_common_account_core_service_fence.sql 20261012230000_common_account_service_brand_state.sql; do
  [[ "$(apply "$world" "$m/$f")" == applied ]] || fail "G5 $f did not apply"
done
as_owner "$world" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
q "$world" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$world" > /dev/null
q "$world" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
[[ "$(apply "$world" "$m/20261007150000_postona_social_accounts_multi_provider.sql")" == applied ]] || fail "Phase 2a-2 did not apply"
[[ "$(apply "$world" "$m/20261013120000_common_account_service_deletion_ownership.sql")" == applied ]] || fail "G5/F5 Phase 6 did not apply"
"${as_super[@]}" -d "$world" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
as_owner "$world" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
for f in "$c/postona_threads_oauth_workspace_candidate.sql" "$c/postona_threads_publish/threads_credential_custody_candidate.sql" \
  "$c/postona_threads_publish/threads_manual_publish_candidate.sql" "$c/postona_threads_publish/threads_publish_release_candidate.sql" \
  "$c/postona_threads_cleanup/threads_provider_cleanup_candidate.sql" "$c/postona_threads_disconnect/threads_disconnect_candidate.sql"; do
  [[ "$(apply "$world" "$f")" == applied ]] || fail "$(basename "$f") did not apply on the real G5 world: $(apply "$(copy "why_$RANDOM" "$world")" "$f")"
done
as_owner "$world" -f "$t/postona_threads_t13_fixture.sql" > /dev/null
[[ "$(apply "$world" "$c/postona_threads_lifecycle_guards/threads_writer_lifecycle_guards_candidate.sql")" == applied ]] || fail "F4 guards did not apply"
echo "PASS world: real G5 (T13 + Phase 4 + F5 + Phase 6) + X + 2a-2 + #124 + publish stack + cleanup + disconnect + F4 guards"

# ---- 2a. Preconditions -------------------------------------------------------------------------------------------
expect_refused() { local label="$1" db="$2" code="$3" got; got="$(apply "$db" "$candidate")"; [[ "$got" == "$code" ]] || fail "$label: $got"; }
db="$(copy f5_missing "$world")"
q "$db" -c "drop function private.account_lifecycle_service_state_refusal(uuid, text)" > /dev/null
expect_refused "without F5's state decision" "$db" THREADS_ROTATION_PRECONDITION_F5
db="$(copy f5_reachable "$world")"
"${as_super[@]}" -d "$db" -c "grant execute on function private.account_lifecycle_service_state_refusal(uuid, text) to service_role" > /dev/null
expect_refused "F5's state decision reachable by service_role" "$db" THREADS_ROTATION_PRECONDITION_F5
db="$(copy f5_member "$world")"
"${as_super[@]}" -d "$db" -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if; end \$\$; grant $owner to authenticator" > /dev/null
expect_refused "an API role is a member of the owner" "$db" THREADS_ROTATION_PRECONDITION_F5
"${as_super[@]}" -d "$db" -c "revoke $owner from authenticator" > /dev/null
db="$(copy reader_drift "$world")"
q "$db" -c "create or replace function public.threads_account_credential_expires_at(p_social_account_id text) returns timestamptz language sql stable security definer set search_path = '' as \$\$ select c.expires_at from public.threads_account_credential_custody c where c.social_account_id = p_social_account_id \$\$;" > /dev/null
expect_refused "a drifted custody reader" "$db" THREADS_ROTATION_PRECONDITION_CUSTODY
db="$(copy custody_shape "$world")"
q "$db" -c "alter table public.threads_account_credential_custody add column note text" > /dev/null
expect_refused "a changed custody table" "$db" THREADS_ROTATION_PRECONDITION_CUSTODY
db="$(copy no_attempts "$world")"
q "$db" -c "alter table public.threads_manual_publish_attempts rename column grant_expires_at to grant_ends_at" > /dev/null
expect_refused "publish attempts without the grant expiry" "$db" THREADS_ROTATION_PRECONDITION_PUBLISH_STACK
db="$(copy as_super "$world")"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super" -d "$db" -f "$candidate" 2>&1 || true)"
got="$(sed -n 's/^.*ERROR: *//p' <<<"$got" | head -1)"
[[ "$got" == THREADS_ROTATION_PRECONDITION_OWNER ]] || fail "applied by a superuser: $got"
echo "PASS preconditions (F5 decision missing / reachable / owner membership, reader drift, custody shape, attempts shape, owner)"

# ---- 2b/2c. The proof: apply, re-apply refused, behavior, races -------------------------------------------------
P='00000000-0000-4000-8000-0000000002a1'
acct_sql="(select v from rot.ids where k = 'acct')"
# One race on $1 (rot.setup already stored a person's account and claim): $2 is the holder's SQL (its own session,
# holding its locks for a while), $3 the code the stored rotate must answer after waiting for it.
race() {
  local db="$1" hold="$2" want="$3" tag="$4" out holder
  q "$db" -c "$hold" > "$tree/hold_$tag.log" 2>&1 &
  holder=$!; sleep 0.3
  out="$(q "$db" -c "select 'ANSWER ' || coalesce(rot.stored_rotate() ->> 'code', 'rotated')" 2>&1)" || true
  wait "$holder" || { echo "R_${tag}_HOLDER $(tr '\n' ' ' < "$tree/hold_$tag.log")"; return 0; }
  grep -qi deadlock "$tree/hold_$tag.log" && { echo "R_${tag}_DEADLOCK"; return 0; }
  [[ "$out" == "ANSWER $want" ]] || { echo "R_${tag} ${out//$'\n'/ }"; return 0; }
  echo PASS
}
Q='00000000-0000-4000-8000-0000000002b1'   # another person, the next owner
race_all() {
  local base="$1" tag="$2" r out db holder races
  shift 2; races="${*:-disconnect reconnect release freeze replay claims busy lock_order claim_lock_order stray owner_transfer owner_aba lease_owner_rewritten}"
  for r in $races; do
    db="$(copy "r_${r}_$tag" "$base")"
    q "$db" -c "select rot.setup('$P', 'race$r')" > /dev/null
    case "$r" in
      disconnect)
        # The person disconnects while the rotate waits: the account, its custody and the lease are gone.
        q "$db" -c "create or replace function public.threads_disconnect_gate_open() returns boolean language sql immutable set search_path = '' as \$\$ select true \$\$" > /dev/null
        out="$(race "$db" "begin; select t13.as_user('$P', 'disconnect', $acct_sql, 'racedisconnect'); select pg_sleep(1.5); commit;" ACCOUNT_NOT_FOUND "d$tag")"
        [[ "$out" != PASS ]] || [[ "$(q "$db" -c "select count(*) from public.threads_account_credential_custody")" == 0 ]] || out="R_DISCONNECT_CUSTODY_LEFT" ;;
      reconnect)
        # A reconnect (secret updated in place, new verification + custody) commits while the rotate waits.
        out="$(race "$db" "begin; select t13.complete_oauth('$P', t13.begin_oauth('$P', 'race_re'), 'racereconnect', 'fake_threads_race_RECONNECTED_0123456789'); select pg_sleep(1.5); commit;" STALE_CREDENTIAL "c$tag")"
        [[ "$out" != PASS ]] || [[ "$(q "$db" -c "select s.secret from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = $acct_sql")" == fake_threads_race_RECONNECTED_0123456789 ]] \
          || out="R_RECONNECT_TOKEN_OVERWRITTEN" ;;
      release)
        # A publish release hands the token out while the rotate waits (claimed before the post started).
        q "$db" -c "insert into rot.ids values ('att', t13.as_user('$P', 'begin', $acct_sql, 'cccccccc-0000-4000-8000-0000000002a1', 'race') -> 'attempt' ->> 'attempt_id')" > /dev/null
        out="$(race "$db" "begin; select t13.release('$P', (select v::uuid from rot.ids where k = 'att'), 'create_container'); select pg_sleep(1.5); commit;" PUBLISH_IN_FLIGHT "p$tag")" ;;
      freeze)
        out="$(race "$db" "begin; update public.common_accounts set status = 'locked' where user_id = '$P'; select pg_sleep(1.5); commit;" ACCOUNT_LIFECYCLE_BLOCKED "f$tag")" ;;
      replay)
        # The same rotate twice at once: exactly one rotation.
        out="$(race "$db" "begin; select rot.stored_rotate(); select pg_sleep(1.5); commit;" LEASE_NOT_HELD "r$tag")"
        [[ "$out" != PASS ]] || [[ "$(q "$db" -c "select count(*) from public.threads_account_credential_custody c where c.social_account_id = $acct_sql and c.recorded_at > (select (v::jsonb ->> 'custody_recorded_at')::timestamptz from rot.ids where k = 'claim')")" == 1 ]] \
          || out="R_REPLAY_NOT_ROTATED_ONCE" ;;
      claims)
        # Two claims at once (the stored lease released first): one lease.
        q "$db" -c "select public.release_threads_credential_refresh($acct_sql, (select (v::jsonb ->> 'lease')::uuid from rot.ids where k = 'claim'))" > /dev/null
        q "$db" -c "begin; select rot.claim($acct_sql); select pg_sleep(1.5); commit;" > "$tree/hold_claims$tag.log" 2>&1 &
        holder=$!; sleep 0.3
        out="$(q "$db" -c "select 'ANSWER ' || coalesce(rot.claim($acct_sql) ->> 'code', 'claimed')" 2>&1)" || true
        wait "$holder" || true
        if [[ "$out" == "ANSWER LEASE_HELD" && "$(q "$db" -c "select count(*) from public.threads_credential_refresh_leases")" == 1 ]]; then out=PASS
        else out="R_CLAIMS ${out//$'\n'/ }"; fi ;;
      busy)
        # The owner's lifecycle row is held past the lock timeout: BUSY (retryable), nothing decided.
        out="$(race "$db" "begin; update public.common_accounts set status = status where user_id = '$P'; select pg_sleep(4); commit;" BUSY "b$tag")" ;;
      lock_order)
        # A freeze holds the owner's entitlement, then locks the workspace row: the rotate must wait for the
        # lifecycle BEFORE taking any workspace lock (no deadlock), then be refused.
        out="$(race "$db" "begin; update public.service_entitlements set status = 'suspended' where user_id = '$P' and service_key = 'x_autopost'; select pg_sleep(0.7); select 1 from public.brands where id = public.social_mobile_account_deletion_workspace('$P') for update; select pg_sleep(0.3); commit;" SERVICE_NOT_ACTIVE "o$tag")" ;;
      claim_lock_order)
        # The same freeze against a CLAIM (the stored lease released first): lifecycle first, no deadlock.
        q "$db" -c "select public.release_threads_credential_refresh($acct_sql, (select (v::jsonb ->> 'lease')::uuid from rot.ids where k = 'claim'))" > /dev/null
        q "$db" -c "begin; update public.service_entitlements set status = 'suspended' where user_id = '$P' and service_key = 'x_autopost'; select pg_sleep(0.7); select 1 from public.brands where id = public.social_mobile_account_deletion_workspace('$P') for update; select pg_sleep(0.3); commit;" > "$tree/hold_cl$tag.log" 2>&1 &
        holder=$!; sleep 0.3
        out="$(q "$db" -c "select 'ANSWER ' || coalesce(rot.claim($acct_sql) ->> 'code', 'claimed')" 2>&1)" || true
        if ! wait "$holder" || grep -qi deadlock "$tree/hold_cl$tag.log"; then out="R_CLAIM_LOCK_ORDER_HOLDER $(tr '\n' ' ' < "$tree/hold_cl$tag.log")"
        elif [[ "$out" == "ANSWER SERVICE_NOT_ACTIVE" ]]; then out=PASS
        else out="R_CLAIM_LOCK_ORDER ${out//$'\n'/ }"; fi ;;
      stray)
        # A rotate naming no lease of this account (stray, forged or already consumed) is refused at once, without
        # queueing on the workspace owner's lifecycle rows that another transaction holds.
        q "$db" -c "begin; update public.common_accounts set status = status where user_id = '$P'; select pg_sleep(2); commit;" > "$tree/hold_stray$tag.log" 2>&1 &
        holder=$!; sleep 0.3
        out="$(q "$db" -c "select 'ANSWER ' || rot.stray_rotate()" 2>&1)" || true
        wait "$holder" || true
        if [[ "$out" == "ANSWER LEASE_NOT_HELD true" ]]; then out=PASS; else out="R_STRAY_QUEUED ${out//$'\n'/ }"; fi ;;
      owner_transfer)
        # J2 V2 R1, as reproduced: the owner P (active) becomes Q (POSTONA ended) while a claim's lifecycle decision
        # waits on P's row (the holder keeps the documented lifecycle -> workspace order). The claim must be refused
        # after the wait, no lease may exist, and a later stable claim for Q is refused by F5 (control).
        q "$db" -c "select public.release_threads_credential_refresh($acct_sql, (select (v::jsonb ->> 'lease')::uuid from rot.ids where k = 'claim')); select t13.login('$Q'); select t13.register('$Q'); select t13.state('$Q', 'ended');" > /dev/null
        q "$db" -c "begin; update public.common_accounts set status = status where user_id = '$P'; select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace('$P')); select pg_sleep(1.2); update public.brand_memberships set user_id = '$Q' where brand_id = public.social_mobile_account_deletion_workspace('$P') and user_id = '$P' and role = 'owner'; commit;" > "$tree/hold_ot$tag.log" 2>&1 &
        holder=$!; sleep 0.3
        out="$(q "$db" -c "select 'ANSWER ' || rot.timed(format('select rot.claim(%L)', $acct_sql))" 2>&1)" || true
        if ! wait "$holder" || grep -qi deadlock "$tree/hold_ot$tag.log"; then out="R_OWNER_TRANSFER_HOLDER $(tr '\n' ' ' < "$tree/hold_ot$tag.log")"
        elif [[ "$out" != "ANSWER OWNER_CHANGED waited" ]]; then out="R_OWNER_TRANSFER ${out//$'\n'/ }"
        elif [[ "$(q "$db" -c "select count(*) from public.threads_credential_refresh_leases")" != 0 ]]; then out="R_OWNER_TRANSFER_LEASE_LEFT"
        elif [[ "$(q "$db" -c "select coalesce(rot.claim($acct_sql) ->> 'code', 'claimed')")" != SERVICE_NOT_ACTIVE ]]; then out="R_OWNER_TRANSFER_CONTROL"
        else out=PASS; fi ;;
      owner_aba)
        # The lease was claimed for P; P's POSTONA then ended and the workspace moved to Q (active). While a rotate's
        # decision would wait on Q's row, the workspace moves back to P. The rotate must decide on P (the lease's
        # person), never on the owner of the moment: refused, nothing rotated.
        q "$db" -c "select t13.login('$Q'); select t13.register('$Q'); select t13.state('$P', 'ended'); update public.brand_memberships set user_id = '$Q' where brand_id = public.social_mobile_account_deletion_workspace('$P') and user_id = '$P' and role = 'owner';" > /dev/null
        out="$(race "$db" "begin; update public.common_accounts set status = status where user_id = '$Q'; select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace('$P')); select pg_sleep(1.2); update public.brand_memberships set user_id = '$P' where brand_id = public.social_mobile_account_deletion_workspace('$P') and user_id = '$Q' and role = 'owner'; commit;" SERVICE_NOT_ACTIVE "a$tag")"
        [[ "$out" != PASS ]] || [[ "$(q "$db" -c "select count(*) from public.threads_account_credential_custody c where c.social_account_id = $acct_sql and c.recorded_at > (select (v::jsonb ->> 'custody_recorded_at')::timestamptz from rot.ids where k = 'claim')")" == 0 ]] \
          || out="R_OWNER_ABA_ROTATED" ;;
      lease_owner_rewritten)
        # A direct write moves the lease's person and the workspace to Q (active) while the rotate's decision waits on
        # P's row: the person decided on (P) is no longer the owner, so the rotate is refused even though the lease
        # row and the membership now agree with each other.
        q "$db" -c "select t13.login('$Q'); select t13.register('$Q');" > /dev/null
        out="$(race "$db" "begin; update public.common_accounts set status = status where user_id = '$P'; select public.social_mobile_account_deletion_workspace_lock(public.social_mobile_account_deletion_workspace('$P')); select pg_sleep(1.2); update public.threads_credential_refresh_leases set owner_user_id = '$Q'; update public.brand_memberships set user_id = '$Q' where brand_id = public.social_mobile_account_deletion_workspace('$P') and user_id = '$P' and role = 'owner'; commit;" OWNER_CHANGED "w$tag")" ;;
    esac
    [[ "$out" == PASS ]] || { echo "$out"; return 0; }
  done
  echo PASS
}
prove() {
  local file="$1" tag="$2" db out fixture
  db="$(copy "m_$tag" "$world")"
  [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY $(apply "$(copy "a_$tag" "$world")" "$file")"; return 0; }
  [[ "$(apply "$db" "$file")" == THREADS_ROTATION_PRECONDITION_ALREADY_APPLIED ]] || { echo "REAPPLY"; return 0; }
  [[ "$(apply "$db" "$t/postona_threads_rotation_fixture.sql")" == applied ]] || { echo "FIXTURE"; return 0; }
  fixture="$(copy "f_$tag" "$db")"
  if ! out="$(as_owner "$db" -A -t -f "$t/postona_threads_rotation_behavior.sql" 2>&1)"; then
    echo "BEHAVIOR $(sed -n 's/^.*ERROR: *//p' <<<"$out" | head -1)"; return 0
  fi
  grep -q ROTATION_BEHAVIOR_OK <<<"$out" || { echo "BEHAVIOR_INCOMPLETE"; return 0; }
  race_all "$fixture" "$tag"
}
result="$(prove "$candidate" real)"
[[ "$result" == PASS ]] || fail "rotation candidate: $result"
echo "PASS rotation candidate: apply, re-apply refused, behavior (14 sections), races (disconnect, reconnect, publish release, owner freeze, replay, two claims, busy, lock order for rotate and claim, stray lease, owner transfer during a claim, owner ABA during a rotate, lease owner rewritten)"

# ---- 2d. Fail-before: the same proof on the same world without the candidate -------------------------------------
db="$(copy before "$world")"
before="$(apply "$db" "$t/postona_threads_rotation_fixture.sql")"
[[ "$before" != applied ]] || fail "fail-before: the fixture applied without the candidate"
echo "PASS fail-before: without the candidate the proof cannot run (${before:0:110})"
# J2 V2 R1 fail-before: PR #258's candidate (before the checked-owner binding) on the same world fails each new race.
mkdir -p "$tree/pr258" && git -C "$repo" show "$PR258:supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql" > "$tree/pr258/candidate.sql"
echo "$PR258 $(shasum -a 256 "$tree/pr258/candidate.sql" | cut -c1-16) threads_credential_rotation_candidate.sql (fail-before copy)" >> "$tree/ROT_MANIFEST.txt"
db="$(copy b258 "$world")"
[[ "$(apply "$db" "$tree/pr258/candidate.sql")" == applied && "$(apply "$db" "$t/postona_threads_rotation_fixture.sql")" == applied ]] || fail "PR #258's candidate did not apply"
for r in owner_transfer owner_aba lease_owner_rewritten; do
  got="$(race_all "$db" "b258_$r" "$r")"
  [[ "$got" != PASS ]] || fail "fail-before: PR #258's candidate passed the $r race (the defect is not reproduced)"
  echo "PASS fail-before $r on PR #258: ${got:0:150}"
done

# ---- 2e. Mutations ------------------------------------------------------------------------------------------------
mutate() {
  local name="$1" from="$2" to="$3" all="${4:-}" out="$tree/mut_$1.sql" got count
  # A pattern that occurs more than once would mutate the first copy only (claim and rotate share lines).
  count="$(FROM="$from" perl -0ne 'my $n = () = /\Q$ENV{FROM}\E/g; print $n' "$candidate")"
  [[ "$all" == all || "$count" == 1 ]] || fail "mutation $name: pattern occurs $count times"
  if [[ "$all" == all ]]; then FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/g' "$candidate" > "$out"
  else FROM="$from" TO="$to" perl -0pe 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$candidate" > "$out"; fi
  cmp -s "$candidate" "$out" && fail "mutation $name: pattern not found"
  got="$(prove "$out" "$name")"
  [[ "$got" != PASS ]] || fail "mutation $name was NOT caught"
  echo "PASS mutation $name caught (${got:0:140})"
}
mutate no_lease_precheck "  select l.owner_user_id into v_checked from public.threads_credential_refresh_leases l
   where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  if v_checked is null then return public.threads_credential_rotation_refused('LEASE_NOT_HELD'); end if;" "  select l.owner_user_id into v_checked from public.threads_credential_refresh_leases l
   where l.social_account_id = p_social_account_id;"
mutate no_lease_id_after_locks "  if v_lease.lease_id is distinct from p_lease or v_lease.lease_expires_at <= v_now then" "  if v_lease.lease_expires_at <= v_now then"
mutate no_lease_expiry "  if v_lease.lease_id is distinct from p_lease or v_lease.lease_expires_at <= v_now then" "  if v_lease.lease_id is distinct from p_lease then"
mutate lease_not_consumed "  delete from public.threads_credential_refresh_leases l where l.social_account_id = p_social_account_id and l.lease_id = p_lease;
  return pg_catalog.jsonb_build_object(
    'status', 'rotated'" "  return pg_catalog.jsonb_build_object(
    'status', 'rotated'"
mutate no_recorded_at_cas "     or v_custody.recorded_at is distinct from p_expected_recorded_at
     or v_lease.vault_secret_id is distinct from p_expected_secret_id
     or v_lease.custody_recorded_at is distinct from p_expected_recorded_at" "     or v_lease.vault_secret_id is distinct from p_expected_secret_id"
mutate no_account_secret_cas "     or v_account.vault_access_token_secret_id is distinct from p_expected_secret_id
" ""
mutate no_custody_secret_cas "     or v_custody.vault_secret_id is distinct from p_expected_secret_id
" ""
mutate no_verification_check "     or v_lease.custody_recorded_at is distinct from p_expected_recorded_at
     or v_custody.recorded_at < v_account.verified_at then" "     or v_lease.custody_recorded_at is distinct from p_expected_recorded_at then"
mutate no_owner_check "  if v_lease.owner_user_id is distinct from v_owner or v_checked is distinct from v_owner then" "  if false then"
mutate rotate_no_checked_binding "  if v_lease.owner_user_id is distinct from v_owner or v_checked is distinct from v_owner then" "  if v_lease.owner_user_id is distinct from v_owner then"
mutate rotate_no_owner_fence "  -- F5 for THAT person, explicitly (never the owner of the moment, which may have changed and changed back).
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;" ""
mutate rotate_fences_current_owner "  -- F5 for THAT person, explicitly (never the owner of the moment, which may have changed and changed back).
  v_code := public.threads_credential_refresh_lifecycle(v_checked);" "  v_code := public.threads_credential_refresh_lifecycle(private.account_lifecycle_brand_owner(v_brand_id));"
mutate rotate_fence_after_row_locks "  -- F5 for THAT person, explicitly (never the owner of the moment, which may have changed and changed back).
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;
  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;" "  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;"
mutate claim_fence_after_row_locks "  v_checked := private.account_lifecycle_brand_owner(v_brand_id);
  if v_checked is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;
  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;" "  perform public.social_mobile_account_deletion_workspace_lock(v_brand_id);
  perform 1 from public.brands b where b.id = v_brand_id and b.code_profile_key = 'social_mobile_user_v1' for share;
  if not found then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_checked := private.account_lifecycle_brand_owner(v_brand_id);
  if v_checked is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;"
mutate claim_no_owner_binding "  if v_owner is distinct from v_checked then return public.threads_credential_rotation_refused('OWNER_CHANGED'); end if;
" ""
mutate rotate_no_in_flight "  if p_new_expires_at <= v_custody.expires_at then return public.threads_credential_rotation_refused('EXPIRY_NOT_EXTENDED'); end if;
  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;" "  if p_new_expires_at <= v_custody.expires_at then return public.threads_credential_rotation_refused('EXPIRY_NOT_EXTENDED'); end if;"
mutate in_flight_ignores_grants "           or (t.grant_state is not null and t.grant_expires_at > pg_catalog.clock_timestamp())))" "))"
mutate no_expiry_upper_bound "v_now + interval '61 days'" "v_now + interval '610 days'" all
mutate no_not_extended "  if p_new_expires_at <= v_custody.expires_at then return public.threads_credential_rotation_refused('EXPIRY_NOT_EXTENDED'); end if;
" ""
mutate rotate_no_expired_check "  if v_custody.expires_at <= v_now then return public.threads_credential_rotation_refused('CREDENTIAL_EXPIRED'); end if;
  if p_new_expires_at <= v_now" "  if p_new_expires_at <= v_now"
mutate rotate_not_server_only "returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '3s' as \$\$
declare
  v_brand_id text;
  v_code text;
  v_checked uuid;
  v_owner uuid;
  v_account public.social_accounts%rowtype;
  v_custody public.threads_account_credential_custody%rowtype;
  v_lease public.threads_credential_refresh_leases%rowtype;
  v_now timestamptz;
begin
  if auth.uid() is not null then return public.threads_credential_rotation_refused('SERVER_ONLY'); end if;
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}\$' or p_lease is null" "returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '3s' as \$\$
declare
  v_brand_id text;
  v_code text;
  v_checked uuid;
  v_owner uuid;
  v_account public.social_accounts%rowtype;
  v_custody public.threads_account_credential_custody%rowtype;
  v_lease public.threads_credential_refresh_leases%rowtype;
  v_now timestamptz;
begin
  if p_social_account_id is null or p_social_account_id !~ '^[a-z][a-z0-9_]{1,80}\$' or p_lease is null"
mutate claim_ignores_live_lease "    if v_lease.lease_expires_at > v_now then return public.threads_credential_rotation_refused('LEASE_HELD'); end if;
" ""
mutate claim_no_in_flight "  if public.threads_credential_publish_in_flight(p_social_account_id) then
    return public.threads_credential_rotation_refused('PUBLISH_IN_FLIGHT');
  end if;
  select l.* into v_lease" "  select l.* into v_lease"
mutate claim_no_owner_fence "  if v_checked is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;
  v_code := public.threads_credential_refresh_lifecycle(v_checked);
  if v_code is not null then return public.threads_credential_rotation_refused(v_code); end if;" "  if v_checked is null then return public.threads_credential_rotation_refused('WORKSPACE_INACTIVE'); end if;"
mutate api_grant "-- Postcondition: the lease table" "grant execute on function public.rotate_threads_credential_custody(text, uuid, uuid, timestamptz, timestamptz) to service_role;
-- Postcondition: the lease table"
mutate lease_table_readable "-- Postcondition: the lease table" "grant select on table public.threads_credential_refresh_leases to authenticated;
-- Postcondition: the lease table"
cat "$tree/ROT_MANIFEST.txt"
echo "ALL PASS (RUN: local disposable PG17 with the REAL G5 T13 / Phase 4 / F5 / Phase 6 migrations. NOT_RUN: managed Supabase Auth / PostgREST / Vault, H5 owner transport, Meta, production)"
