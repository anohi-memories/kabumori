#!/usr/bin/env bash
# G4-29 (Issue #319): ISOLATED SOURCE CANDIDATES A + C on the composed world of G4-24 / G4-25, on a disposable LOCAL
# PostgreSQL 17. Never production, never a managed Supabase, never real Vault, OAuth, tokens, Meta or Threads (fake
# values only). A = supabase/candidates/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation.sql
# (G4-27, PR #460); C = 002_rotation_lease_binding.sql (this task: the lease names bindings.oauth_state_id; claim refuses
# CONNECTION_NOT_BOUND, rotate refuses BINDING_CHANGED). Sections 1-3 and the helpers are those of
# postona_threads_lease_invalidation_run.sh (G4-27), copied so that this proof stands alone; nothing here changes an
# existing file.
#   4. C: apply order / preconditions / re-apply
#   5. A+C: postona_threads_lease_binding_behavior.sql (B1-B8, EXPECTED_FAIL F1/F2) with A on and with A's trigger OFF;
#      R1-R7b (PR #453); N1-N5 (G4-27)
#   6. two transactions with the same now() (A off / on); replica mode with A's trigger only ORIGIN
#   7. locks with A off: three two-session orders + the same lease twice, no deadlock
#   8. rollback: C -> A (R7 back), A first (C alone), binding layer first (fails closed), a rollback that forgets claim
#   9. negative controls: mutants of C, caught by behavior with the postcondition stripped
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_threads_lease_binding_run.sh
set -euo pipefail
export LC_ALL=C
export PGOPTIONS="-c client_min_messages=warning"

host="${TQ_PGHOST:?TQ_PGHOST (local socket dir) required}"
port="${TQ_PGPORT:?TQ_PGPORT required}"
super="${TQ_PGSUPER:?TQ_PGSUPER required}"
case "$host" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "Refusing: TQ_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
head="$(git -C "$repo" rev-parse HEAD)"
psql_bin="${PSQL:-psql}"
fail() { echo "FAIL $*" >&2; exit 1; }
G5=e363c708bcb331abccc0eb51d8b2229936c87ef6
PR412=b83a7a92524a8862fe0a291d54a364fe15d8048d
PR374=e3dfbd3cce3fffccdb638159f3aa6c3313d5098c
for sha in "$G5" "$PR412" "$PR374"; do
  git -C "$repo" cat-file -e "${sha}^{commit}" 2>/dev/null || fail "missing git objects for $sha (fetch its branch first)"
done

tree="$(mktemp -d /private/tmp/kabumori-ac.XXXXXX)"
n="$$"
owner="kb_ac_owner_$n"
delegate="kb_ac_delegate_$n"
prefix="kabumori_ac_${n}"
as_super=("$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
cleanup() {
  local db
  for db in $("${as_super[@]}" -d postgres -c "select datname from pg_database where datname like '${prefix}_%'" 2>/dev/null); do
    "${as_super[@]}" -d postgres -c "drop database if exists $db with (force)" > /dev/null 2>&1 || true
  done
  "${as_super[@]}" -d postgres -c "drop role if exists $delegate" -c "drop role if exists $owner" > /dev/null 2>&1 || true
  if [[ "${KEEP:-0}" != 1 ]]; then rm -rf "$tree"; else echo "kept $tree"; fi
}
trap cleanup EXIT

# ---- 1. Combined tree ----------------------------------------------------------------------------------------------
(cd "$repo" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$tree"
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/AC_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/AC_MANIFEST.txt"; done
}
overlay "$G5" supabase/tests/common_account_phase9_auth_fixture.sql \
  supabase/migrations/20261010051938_common_account_service_write_guard.sql \
  supabase/migrations/20261012130000_common_account_core_service_fence.sql \
  supabase/migrations/20261012230000_common_account_service_brand_state.sql \
  supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql \
  supabase/migrations/20261013140000_common_account_service_reconciliation_facts.sql \
  supabase/migrations/20261015090000_common_account_enrollment_session_fence.sql \
  supabase/migrations/20261015120000_common_account_x_unconfirmed_snapshot_record.sql \
  supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql \
  supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql \
  supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql
overlay "$PR412" supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic.sql \
  supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql \
  supabase/tests/postona_threads_credential_atomic_behavior.sql
git -C "$repo" show "$PR374:supabase/candidates/postona_threads_reservations/007_postona_threads_reservations.sql" > "$tree/g3_007.sql"
echo "$PR374 $(shasum -a 256 "$tree/g3_007.sql" | cut -c1-16) 007 (generation function only)" >> "$tree/AC_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
b001="$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql"; b001rb="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
b002="$c/postona_threads_binding_epoch/002_custody_connect_proof.sql"; b002rb="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
cred="${TQ_CREDENTIAL:-$c/postona_threads_credential_atomic/001_threads_credential_atomic.sql}"; credrb="$c/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql"
behavior="$t/postona_threads_credential_composition_behavior.sql"
rotation_behavior="$t/postona_threads_rotation_cas_behavior.sql"
rotation="$c/postona_threads_publish/threads_credential_rotation_candidate.sql"
sed 's/^/  /' "$tree/AC_MANIFEST.txt"

# ---- 2. The world ---------------------------------------------------------------------------------------------------
"${as_super[@]}" -d postgres > /dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin noinherit; end if;
end \$\$;
create role $owner login nosuperuser nocreatedb createrole;
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
need() { local got; got="$(apply "$1" "$2")"; [[ "$got" == applied ]] || fail "$(basename "$2") did not apply: $got"; }
pre="${prefix}_pre"
create_db "$pre"
as_owner "$pre" -f "$t/social_mobile_account_deletion_fixture.sql" > /dev/null
as_owner "$pre" -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" > /dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql 20260928160000_social_mobile_account_deletion_candidate.sql; do
  as_owner "$pre" -f "$m/$f" > /dev/null
done
as_owner "$pre" -f "$t/common_account_lifecycle_fixture.sql" > /dev/null
as_owner "$pre" -f "$t/common_account_phase9_auth_fixture.sql" > /dev/null
q "$pre" -c "create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users (id) on delete cascade, created_at timestamptz not null default now(), not_after timestamptz)" > /dev/null
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion \
         20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state; do
  need "$pre" "$m/$f.sql"
done
as_owner "$pre" -f "$t/postona_social_accounts_multi_provider_fixture.sql" > /dev/null
q "$pre" -c "alter table public.social_accounts alter column publish_enabled set default false, alter column connection_status set default 'unconnected'; alter table public.x_account_refresh_state_v2 add column last_error_code text check(last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{1,99}\$');" > /dev/null
awk 'index($0,"create function public.x_account_refresh_reset_on_reconnect()") == 1 {on=1} on {print} on && $0=="$$;" {exit}' "$m/20260925140000_x_account_credential_refresh_core.sql" | q "$pre" > /dev/null
q "$pre" -c "revoke all on function public.x_account_refresh_reset_on_reconnect() from public,anon,authenticated,service_role; create trigger social_accounts_x_refresh_reset_on_reconnect after update of verified_at on public.social_accounts for each row when(new.connection_status='identity_verified' and new.verified_at is distinct from old.verified_at) execute function public.x_account_refresh_reset_on_reconnect();" > /dev/null
need "$pre" "$m/20261007150000_postona_social_accounts_multi_provider.sql"
for f in 20261013120000_common_account_service_deletion_ownership 20261013140000_common_account_service_reconciliation_facts \
         20261015090000_common_account_enrollment_session_fence 20261015120000_common_account_x_unconfirmed_snapshot_record; do
  need "$pre" "$m/$f.sql"
done
"${as_super[@]}" -d "$pre" -c 'create schema extensions; grant usage on schema extensions to public; create extension pgcrypto with schema extensions;' > /dev/null
as_owner "$pre" -f "$t/postona_threads_oauth_test_fixture.sql" > /dev/null
as_owner "$pre" -f "$m/20260918120000_social_mobile_brand_memberships.sql" > /dev/null
# TEST-WORLD revoke (as F5's / G5's runners): PR #303 refuses API TRIGGER / TRUNCATE / REFERENCES on brand_memberships.
q "$pre" -c "revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated" > /dev/null
need "$pre" "$c/common_account_brand_owner_epoch/001_brand_owner_epoch.sql"
# TEST-WORLD auth.uid() (as G5's runner [A]): the per-claim setting, else request.jwt.claims ->> 'sub'. Managed: NOT_VERIFIED.
q "$pre" -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$" > /dev/null
need "$pre" "$c/common_account_authorization_verdict/001_authorization_verdict.sql"
need "$pre" "$c/postona_threads_oauth_workspace_candidate.sql"
need "$pre" "$c/postona_threads_publish/threads_credential_custody_candidate.sql"
q "$pre" -c "create schema postona_threads_resv; revoke all on schema postona_threads_resv from public" > /dev/null
awk 'index($0,"create function postona_threads_resv.threads_credential_generation(") == 1 {on=1} on {print} on && $0=="end $$;" {exit}' "$tree/g3_007.sql" > "$tree/g3_generation.sql"
[[ -s "$tree/g3_generation.sql" ]] || fail "G3's generation function not found in 007"
need "$pre" "$tree/g3_generation.sql"
q "$pre" -c "revoke all on function postona_threads_resv.threads_credential_generation(text) from public, anon, authenticated, service_role" > /dev/null
echo "PASS world: G5 chain P1..P10 + R1/W1 (PR #399) + F5 owner epoch + 2a-2 + PR #124 + G4 custody + G3 generation (PR #374, verbatim)"

# ---- 3. Install the composed world + G4's publish stack + the rotation candidate ------------------------------------------
world="$(copy world "$pre")"
need "$world" "$b001"; need "$world" "$b002"; need "$world" "$cred"
for f in threads_manual_publish_candidate.sql threads_publish_release_candidate.sql; do need "$world" "$c/postona_threads_publish/$f"; done
base="$(copy base "$world")"
need "$world" "$rotation"
echo "PASS world + rotation candidate installed"
prelude() { sed -n '1,/^-- K1\. ACL/p' "$behavior" | sed '$d'; }
{ prelude; cat "$rotation_behavior"; } > "$tree/rotation_behavior_full.sql"
run_behavior() { # db fix -> output
  as_owner "$1" -A -t -v fix="$2" -f "$tree/rotation_behavior_full.sql" 2>&1
}

cand="$c/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation.sql"
candrb="$c/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation_rollback.sql"
li_behavior="$t/postona_threads_lease_invalidation_behavior.sql"
helpers() { sed -n '/^create function cr.claim/,/^-- R1\./p' "$rotation_behavior" | sed '$d'; }
{ prelude; helpers; cat "$li_behavior"; } > "$tree/li_behavior_full.sql"
"${as_super[@]}" -d postgres -c "create role $delegate login nosuperuser nocreatedb nocreaterole" > /dev/null
as_delegate() { local db="$1"; shift; "$psql_bin" -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$delegate" -d "$db" "$@"; }
# A copy of a candidate without its postcondition block: a mutant must then be caught by BEHAVIOR, not only at apply.
strip_post() { python3 -I - "$1" "$2" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("-- Postcondition:"); j = s.rindex("commit;")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
}
{ prelude; helpers; } > "$tree/helpers.sql"
prep() { as_owner "$1" -A -t -f "$tree/helpers.sql" > /dev/null; }
# One connected account with a live lease, made by the owner in db $1 (after prep). Prints the account.
lease_account() {
  local acct
  acct="$(q "$1" -c "select cr.connected($2, 'p$2')")"
  [[ "$(q "$1" -c "select cr.claim('$acct') ->> 'status'")" == claimed ]] || fail "lease setup $2"
  echo "$acct"
}
leases_of() { q "$1" -c "select count(*) from public.threads_credential_refresh_leases where social_account_id = '$2'"; }

# ===================================== G4-29: option C on top of option A =====================================
candC="$c/postona_threads_rotation_lease_invalidation/002_rotation_lease_binding.sql"
candCrb="$c/postona_threads_rotation_lease_invalidation/002_rotation_lease_binding_rollback.sql"
ac_behavior="$t/postona_threads_lease_binding_behavior.sql"
{ prelude; helpers; cat "$ac_behavior"; } > "$tree/ac_behavior_full.sql"
worldA="$(copy worlda "$world")"; need "$worldA" "$cand"
echo "PASS world + rotation + candidate A (001_rotation_lease_invalidation.sql)"
run_ac() { as_owner "$1" -A -t -v a_mode="$2" -f "$tree/ac_behavior_full.sql" 2>&1; }
disable_a() { q "$1" -c "alter table public.threads_account_credential_custody disable trigger threads_credential_refresh_lease_invalidate_row" > /dev/null; }

# Everything a C file must show on an A world; prints PASS or the first reason.
prove_c() {
  local file="$1" tag="$2" db out mode
  for mode in on off; do
    db="$(copy "c${mode}_$tag" "$worldA")"
    out="$(apply "$db" "$file")"; [[ "$out" == applied ]] || { echo "APPLY $out"; return 0; }
    out="$(run_ac "$db" "$mode")" || { echo "AC_$mode $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
    grep -q POSTONA_THREADS_LEASE_BINDING_BEHAVIOR_DONE <<<"$out" || { echo "AC_$mode marker"; return 0; }
    [[ "$tag" != real ]] || grep -E '^(B2|F1) ' <<<"$out" | sed "s/^/  observed (A $mode): /" | cut -c1-400 >&2
  done
  db="$(copy "r_$tag" "$worldA")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY2"; return 0; }
  out="$(run_behavior "$db" ac)" || { echo "R1-R7 $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q R7_FIX_PROTOTYPE_HOLDS <<<"$out" || { echo "R7 not refused"; return 0; }
  db="$(copy "n_$tag" "$worldA")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY3"; return 0; }
  out="$(as_owner "$db" -A -t -f "$tree/li_behavior_full.sql" 2>&1)" || { echo "N1-N5 $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q POSTONA_THREADS_LEASE_INVALIDATION_BEHAVIOR_DONE <<<"$out" || { echo "N1-N5 marker"; return 0; }
  echo PASS
}

# ---- 4. C: apply order, preconditions, re-apply ------------------------------------------------------------------
got="$(apply "$(copy c_no_a "$world")" "$candC")"
[[ "$got" == THREADS_LEASE_BINDING_PRECONDITION_A ]] || fail "C without A: $got"
nob="$(copy c_no_binding "$worldA")"; q "$nob" -c "alter table postona_threads_binding.bindings rename to bindings_gone_g4_29" > /dev/null
got="$(apply "$nob" "$candC")"
[[ "$got" == THREADS_LEASE_BINDING_PRECONDITION_TABLES ]] || fail "C without the binding table: $got"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$delegate" -d "$(copy c_owner "$worldA")" -f "$candC" 2>&1 | sed -n 's/^.*ERROR: *//p' | head -1 || true)"
[[ "$got" == THREADS_LEASE_BINDING_PRECONDITION_OWNER || "$got" == "permission denied for schema postona_threads_binding" ]] || fail "C by a non-owner: $got"
c_owner_refusal="$got"
cdrift="$(copy c_drift "$worldA")"
q "$cdrift" -c "do \$\$ begin execute replace(pg_get_functiondef('public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)'::regprocedure), 'AS \$function\$', 'AS \$function\$-- drifted'); end \$\$" > /dev/null
got="$(apply "$cdrift" "$candC")"
[[ "$got" == THREADS_LEASE_BINDING_PRECONDITION_ROTATION ]] || fail "C on a drifted rotate: $got"
cagain="$(copy c_again "$worldA")"; need "$cagain" "$candC"
got="$(apply "$cagain" "$candC")"
[[ "$got" == THREADS_LEASE_BINDING_ALREADY_APPLIED ]] || fail "C re-apply: $got"
echo "PASS C apply: without A -> PRECONDITION_A; without the binding table -> PRECONDITION_TABLES; non-owner -> refused ($c_owner_refusal); drifted rotate -> PRECONDITION_ROTATION; re-apply -> ALREADY_APPLIED"

# ---- 5. A+C: B1-B8 + F1/F2 with A on and with A's trigger OFF; R1-R7b; N1-N5 ----------------------------------------
result="$(prove_c "$candC" real)"
[[ "$result" == PASS ]] || fail "A+C: $result"
echo "PASS A+C: B1 lease names the binding / single use; B2 same now() refused (A on: LEASE_NOT_HELD, A OFF: BINDING_CHANGED), reconnect token stays; B3 no binding -> CONNECTION_NOT_BOUND; B4 binding of another Threads user / workspace -> CONNECTION_NOT_BOUND; B5 binding changed without custody -> BINDING_CHANGED; B6 older state completed later -> refused; B7 deleted account -> refused; B8 no API access; R1-R7b; N1-N5"
echo "EXPECTED_FAIL F1 (A+C cannot see it): PR #124 complete on its own at the same now() -> rotated over its token, and credential_row hands the stale lineage out (asserted in F1)"
echo "EXPECTED_FAIL F2 (A+C cannot see it): in-place Vault write under a held lease -> rotated"

# ---- 6. With A's trigger OFF: two transactions with the same now(); replica mode with A not ALWAYS --------------------
node_bin="${NODE:-node}"
for mode in off on; do
  coll="$(copy "coll_$mode" "$worldA")"; need "$coll" "$candC"
  [[ "$mode" == on ]] || disable_a "$coll"
  { prelude; helpers; cat <<'SQL'
select cr.enroll(181) as cu \gset
select cr.check(cr.t_begin(:'cu', 's1') like 'sa_%', 'collision begin s1');
select cr.check(cr.t_begin(:'cu', 's2') like 'sa_%', 'collision begin s2');
SQL
  } > "$tree/coll_setup.sql"
  as_owner "$coll" -A -t -f "$tree/coll_setup.sql" > /dev/null
  "$node_bin" "$t/postona_threads_rotation_cas_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$coll" fix > "$tree/coll_$mode.out" 2>&1 || fail "collision (A $mode): $(cat "$tree/coll_$mode.out")"
  code="$(grep -o '"rotation":{[^}]*}' "$tree/coll_$mode.out" | grep -o '"code":"[A-Z_]*"' | cut -d'"' -f4)"
  echo "PASS two transactions with the same now(), A trigger $mode: refused ($code), the reconnect's token stays"
done
rep="$(copy replica "$worldA")"; need "$rep" "$candC"; prep "$rep"
q "$rep" -c "alter table public.threads_account_credential_custody enable trigger threads_credential_refresh_lease_invalidate_row" > /dev/null   # ORIGIN, not ALWAYS
racc="$(lease_account "$rep" 321)"
[[ "$(q "$rep" -c "select cr.t_begin(cr.uid(321), 'rep_b')")" == "$racc" ]] || fail "replica: begin"
before_state="$(q "$rep" -c "select oauth_state_id from postona_threads_binding.bindings where social_account_id = '$racc'")"
got="$("${as_super[@]}" -d "$rep" -c "set session_replication_role = replica" -c "select cr.t_complete(cr.uid(321), 'rep_b', '17841400000000321', now() + interval '40 days')")"
# Measured: the entry itself refuses in replica mode (its owner-epoch input is trigger-maintained), so a reconnect
# cannot slip past A's skipped trigger this way; nothing is written, the lease and the binding stay.
[[ "$got" == ERR:* && "$(leases_of "$rep" "$racc")" == 1 \
   && "$(q "$rep" -c "select oauth_state_id from postona_threads_binding.bindings where social_account_id = '$racc'")" == "$before_state" ]] || fail "replica reconnect: $got"
echo "PASS replica mode (A's trigger only ORIGIN): the entry refuses the reconnect itself (${got#ERR:}), nothing written; the A-skipped case is the A OFF runs above"

# ---- 7. Locks with A's trigger OFF (C alone): three two-session orders, no deadlock; same lease twice --------------------
locks="$(copy locks "$worldA")"; need "$locks" "$candC"; disable_a "$locks"
{ prelude; helpers
  echo "select cr.connected(331, 'e1') as a \\gset"; echo "select cr.check(cr.t_begin(cr.uid(331), 'e1b') like 'sa_%', 'e1 begin');"
  echo "select cr.connected(332, 'e2') as a \\gset"; echo "select cr.check(cr.t_begin(cr.uid(332), 'e2b') like 'sa_%', 'e2 begin');"
  echo "select cr.connected(333, 'e3') as a \\gset"; echo "select cr.check(cr.t_begin(cr.uid(333), 'e3b') like 'sa_%', 'e3 begin');"
  echo "select cr.connected(334, 'e4') as a \\gset"
} > "$tree/locks_setup.sql"
as_owner "$locks" -A -t -f "$tree/locks_setup.sql" > /dev/null
acct_of() { q "$locks" -c "select id from public.social_accounts where platform_user_id = '178414000000$(printf %05d "$1")'"; }
e1="$(acct_of 331)"; e2="$(acct_of 332)"; e3="$(acct_of 333)"; e4="$(acct_of 334)"
( as_owner "$locks" -A -t -c "begin" -c "select cr.t_complete(cr.uid(331), 'e1b', '17841400000000331', now() + interval '40 days')" -c "select pg_sleep(1.5)" -c "commit" > "$tree/e1.out" 2>&1 ) &
holder=$!; sleep 0.4
claim1="$(q "$locks" -c "select cr.claim('$e1')::text" 2>&1)"
wait "$holder" || fail "E1 holder: $(cat "$tree/e1.out")"
[[ "$(q "$locks" -c "select l.binding_oauth_state_id = cr_b.oauth_state_id from public.threads_credential_refresh_leases l, postona_threads_binding.bindings cr_b where l.lease_id = ('$claim1'::jsonb ->> 'lease')::uuid and cr_b.social_account_id = '$e1'")" == t ]] || fail "E1 claim: $claim1"
[[ "$(q "$locks" -c "select cr.rotate('$e1', '$claim1'::jsonb, ('$claim1'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status'")" == rotated ]] || fail "E1 rotate"
( as_owner "$locks" -A -t -c "begin" -c "select cr.claim('$e2')::text" -c "select pg_sleep(1.5)" -c "commit" > "$tree/e2.out" 2>&1 ) &
holder=$!; sleep 0.4
rec2="$(q "$locks" -c "select cr.t_complete(cr.uid(332), 'e2b', '17841400000000332', now() + interval '40 days')" 2>&1)"
wait "$holder" || fail "E2 holder: $(cat "$tree/e2.out")"
claim2="$(grep '{' "$tree/e2.out")"
[[ "$rec2" == OK && "$(jq -r .status <<<"$claim2")" == claimed ]] || fail "E2: $rec2 $claim2"
got="$(q "$locks" -c "select cr.rotate('$e2', '$claim2'::jsonb, ('$claim2'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'code'")"
[[ "$got" == BINDING_CHANGED ]] || fail "E2 rotate: $got"
[[ "$(q "$locks" -c "select cr.token_of('$e2') = cr.token('e2b')")" == t ]] || fail "E2 token"
e2code="$got"
claim3="$(q "$locks" -c "select cr.claim('$e3')::text")"
( as_owner "$locks" -A -t -c "begin" -c "select cr.rotate('$e3', '$claim3'::jsonb, ('$claim3'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status'" \
    -c "select cr.h5_write('$e3', 'fakeTHREADSrefreshE3_0123456789')" -c "select pg_sleep(1.5)" -c "commit" > "$tree/e3.out" 2>&1 ) &
holder=$!; sleep 0.4
rec3="$(q "$locks" -c "select cr.t_complete(cr.uid(333), 'e3b', '17841400000000333', now() + interval '40 days')" 2>&1)"
wait "$holder" || fail "E3 holder: $(cat "$tree/e3.out")"
grep -qx rotated "$tree/e3.out" && [[ "$rec3" == OK ]] || fail "E3: $rec3 $(cat "$tree/e3.out")"
[[ "$(q "$locks" -c "select cr.token_of('$e3') = cr.token('e3b')")" == t ]] || fail "E3 token"
claim4="$(q "$locks" -c "select cr.claim('$e4')::text")"
one="select (cr.rotate('$e4', '$claim4'::jsonb, ('$claim4'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '50 days'))::text"
( as_owner "$locks" -A -t -c "begin" -c "$one" -c "select pg_sleep(1.5)" -c "commit" > "$tree/e4.out" 2>&1 ) &
holder=$!; sleep 0.4
second="$(q "$locks" -c "$one" 2>&1 || true)"
wait "$holder" || fail "E4 holder: $(cat "$tree/e4.out")"
[[ "$(jq -r .status <<<"$(grep '{' "$tree/e4.out")")" == rotated && "$(jq -r .status <<<"$second")" == refused ]] || fail "E4 same lease: $second"
! grep -qi deadlock "$tree/e1.out" "$tree/e2.out" "$tree/e3.out" "$tree/e4.out" || fail "deadlock"
echo "PASS locks with A OFF: E1 reconnect first -> the waiting claim names the new binding and rotates; E2 claim first -> the waiting reconnect makes the claim's rotate $e2code; E3 rotate first -> the reconnect writes last; E4 same lease twice -> one rotated, the other $(jq -r .code <<<"$second"); no deadlock"

# ---- 8. Rollback: right order, A first (C alone), binding layer first, rollback mutant -----------------------------------
rb="$(copy rb "$worldA")"; need "$rb" "$candC"; need "$rb" "$candCrb"
[[ "$(q "$rb" -c "select md5(prosrc) from pg_proc where oid in ('public.claim_threads_credential_refresh(text)'::regprocedure, 'public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)'::regprocedure) order by proname" | tr '\n' ' ')" == "2d5fdec6a3f9a1f7bab30e4f32b992ec 4de6764d8681c333c698a43fa0b8d01c " ]] || fail "C rollback: bodies not back to A's pins"
need "$rb" "$candrb"
out="$(run_behavior "$rb" none)" || fail "after C and A rollback: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q R7_FINDING_REPRODUCED <<<"$out" || fail "after C and A rollback R7 should reproduce again"
afirst="$(copy afirst "$worldA")"; need "$afirst" "$candC"; need "$afirst" "$candrb"
out="$(run_ac "$afirst" absent)" || fail "A rolled back first, C alone: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_LEASE_BINDING_BEHAVIOR_DONE <<<"$out" || fail "A rolled back first: marker"
need "$afirst" "$candCrb"
bfirst="$(copy bfirst "$worldA")"; need "$bfirst" "$candC"; prep "$bfirst"
bacc="$(q "$bfirst" -c "select cr.connected(341, 'bf')")"
for f in "$credrb" "$b002rb" "$b001rb"; do need "$bfirst" "$f"; done
got="$(q "$bfirst" -c "select cr.claim('$bacc')::text" 2>&1 || true)"
[[ "$got" == *postona_threads_binding* && "$(q "$bfirst" -c "select count(*) from public.threads_credential_refresh_leases")" == 0 ]] || fail "binding layer rolled back first: $got"
need "$bfirst" "$candCrb"
[[ "$(q "$bfirst" -c "select cr.claim('$bacc') ->> 'status'")" == claimed ]] || fail "binding layer first: claim after C's rollback"
python3 -I - "$candCrb" "$tree/rb_mut.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("create or replace function public.claim_threads_credential_refresh(")
j = s.index("create or replace function public.rotate_threads_credential_custody(")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
rbm="$(copy rbmut "$worldA")"; need "$rbm" "$candC"; got="$(apply "$rbm" "$tree/rb_mut.sql")"
[[ "$got" == THREADS_LEASE_BINDING_ROLLBACK_INCOMPLETE ]] || fail "rollback that forgets claim: $got"
echo "PASS rollback: C then A -> bodies back to A's pins, then R7 reproduces again; A first -> C alone still refuses (B1-B8 with A absent); binding layer first -> claim errors (relation missing), no lease, then C's rollback restores claim; a rollback that forgets claim -> ROLLBACK_INCOMPLETE"
echo "NOT_RUN F4's rotation suite with C: its world has no PR #418 001 (no bindings), so every claim would be CONNECTION_NOT_BOUND (G4-28 section 4); C is proven on the composed world above"

# ---- 9. Negative controls: mutants of C (postcondition stripped, so behavior must catch) ------------------------------
caught=0; total=0
mutate_c() {
  local name="$1" old="$2" new="$3" full stripped got_full got
  total=$((total + 1)); full="$tree/mutc_$name.sql"; stripped="$tree/mutc_${name}_nopost.sql"
  python3 -I -c '
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(old) != 1: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$candC" "$full" "$old" "$new" || fail "mutation $name: pattern not unique"
  strip_post "$full" "$stripped"
  got_full="$(apply "$(copy "mcf_$name" "$worldA")" "$full")"
  got="$(prove_c "$stripped" "m_$name")"
  if [[ "$got" != PASS ]]; then caught=$((caught + 1)); echo "  CAUGHT $name: apply=${got_full:0:50}; behavior: ${got:0:150}"
  else echo "  MISSED $name (apply=${got_full:0:50})"; fi
}
mutate_c rotate_no_binding_check "  if v_binding_state is null or v_binding_state is distinct from v_lease.binding_oauth_state_id then
    return public.threads_credential_rotation_refused('BINDING_CHANGED');
  end if;
" ""
mutate_c claim_records_another "          v_now, v_now + interval '60 seconds', v_binding_state)" "          v_now, v_now + interval '60 seconds', gen_random_uuid())"
mutate_c claim_lookup_no_user "     and b.threads_user_id = v_account.platform_user_id;
  if v_binding_state is null then return" "     and true;
  if v_binding_state is null then return"
mutate_c claim_lookup_no_brand "   where b.social_account_id = p_social_account_id and b.brand_id = v_account.brand_id
     and b.threads_user_id = v_account.platform_user_id;
  if v_binding_state is null then return" "   where b.social_account_id = p_social_account_id
     and b.threads_user_id = v_account.platform_user_id;
  if v_binding_state is null then return"
mutate_c claim_no_not_bound "  if v_binding_state is null then return public.threads_credential_rotation_refused('CONNECTION_NOT_BOUND'); end if;
" ""
mutate_c rotate_reads_lease_not_binding "  if v_binding_state is null or v_binding_state is distinct from v_lease.binding_oauth_state_id then" "  if v_lease.binding_oauth_state_id is null then"
echo "negative controls caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a negative control was not caught"
echo "POSTONA_THREADS_LEASE_BINDING_RUN_PASS (isolated source candidates A+C; EXPECTED_FAIL F1 bare complete and F2 in-place Vault write reported)"
