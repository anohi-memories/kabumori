#!/usr/bin/env bash
# G4-31 (Issue #319): ISOLATED SOURCE CANDIDATE (4) -- the connect fingerprint (003_rotation_lease_connect_fingerprint.sql)
# -- on top of A (001, G4-27) and C (002, G4-29), on the composed world of G4-24 / G4-25, on a disposable LOCAL PostgreSQL
# 17. Never production, never a managed Supabase, never real Vault, OAuth, tokens, Meta or Threads (fake values only).
# Sections 1-3 and the helpers are those of postona_threads_lease_binding_run.sh (G4-29), copied so that this proof stands
# alone; nothing here changes an existing file.
#   4. (4): apply order / preconditions / re-apply
#   5. A+C+(4): postona_threads_connect_fingerprint_behavior.sql (P1-P9, F1 now refused, F2 still EXPECTED_FAIL) with A on
#      and OFF; G4-29's B1-B8 (its F1 block cut: F1 is what (4) closes); R1-R7b; N1-N5
#   6. (4) as the only layer (A off, C's check removed): entry reconnect and the same-now() collision
#   7. F1 races: bare complete vs rotate / claim, three orders, no deadlock
#   8. rollback: (4) -> C -> A; A first; C first (wrong: fails closed, (4)'s rollback refuses); rollback mutant
#   9. negative controls: mutants of (4), caught by behavior with the postcondition stripped
# Usage: TQ_PGHOST=/private/tmp/<socket-dir> TQ_PGPORT=<port> TQ_PGSUPER=<superuser> supabase/tests/postona_threads_connect_fingerprint_run.sh
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

tree="$(mktemp -d /private/tmp/kabumori-fp.XXXXXX)"
n="$$"
owner="kb_fp_owner_$n"
delegate="kb_fp_delegate_$n"
prefix="kabumori_fp_${n}"
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
echo "base $head (this branch) + local changes: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ') paths" > "$tree/FP_MANIFEST.txt"
overlay() {
  local sha="$1"; shift
  local path
  for path in "$@"; do [[ -e "$tree/$path" ]] && fail "ownership overlap: $path already exists in the G4 base"; done
  git -C "$repo" archive "$sha" -- "$@" | tar -x -C "$tree"
  for path in "$@"; do echo "$sha $(shasum -a 256 "$tree/$path" | cut -c1-16) $path" >> "$tree/FP_MANIFEST.txt"; done
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
echo "$PR374 $(shasum -a 256 "$tree/g3_007.sql" | cut -c1-16) 007 (generation function only)" >> "$tree/FP_MANIFEST.txt"
t="$tree/supabase/tests"; m="$tree/supabase/migrations"; c="$tree/supabase/candidates"
b001="$c/postona_threads_binding_epoch/001_threads_binding_epoch.sql"; b001rb="$c/postona_threads_binding_epoch/001_threads_binding_epoch_rollback.sql"
b002="$c/postona_threads_binding_epoch/002_custody_connect_proof.sql"; b002rb="$c/postona_threads_binding_epoch/002_custody_connect_proof_rollback.sql"
cred="${TQ_CREDENTIAL:-$c/postona_threads_credential_atomic/001_threads_credential_atomic.sql}"; credrb="$c/postona_threads_credential_atomic/001_threads_credential_atomic_rollback.sql"
behavior="$t/postona_threads_credential_composition_behavior.sql"
rotation_behavior="$t/postona_threads_rotation_cas_behavior.sql"
rotation="$c/postona_threads_publish/threads_credential_rotation_candidate.sql"
sed 's/^/  /' "$tree/FP_MANIFEST.txt"

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

# ===================================== G4-31: (4) the connect fingerprint on A + C =====================================
cand4="$c/postona_threads_rotation_lease_invalidation/003_rotation_lease_connect_fingerprint.sql"
cand4rb="$c/postona_threads_rotation_lease_invalidation/003_rotation_lease_connect_fingerprint_rollback.sql"
fp_behavior="$t/postona_threads_connect_fingerprint_behavior.sql"
{ prelude; helpers; cat "$fp_behavior"; } > "$tree/fp_behavior_full.sql"
# G4-29's A+C behavior without its F1 block: F1 is what (4) closes (P2/P3 assert the new outcome); B1-B8 and F2 stay.
python3 -I - "$ac_behavior" "$tree/ac_nof1.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("-- F1. EXPECTED_FAIL"); j = s.index("-- F2. EXPECTED_FAIL")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
{ prelude; helpers; cat "$tree/ac_nof1.sql"; } > "$tree/ac_nof1_full.sql"
worldAC="$(copy worldac "$worldA")"; need "$worldAC" "$candC"
echo "PASS world + rotation + A + C (002_rotation_lease_binding.sql)"
run_fp() { as_owner "$1" -A -t -v a_mode="$2" -f "$tree/fp_behavior_full.sql" 2>&1; }

# Everything a (4) file must show on an A+C world; prints PASS or the first reason.
prove_4() {
  local file="$1" tag="$2" db out mode
  for mode in on off; do
    db="$(copy "f${mode}_$tag" "$worldAC")"
    out="$(apply "$db" "$file")"; [[ "$out" == applied ]] || { echo "APPLY $out"; return 0; }
    out="$(run_fp "$db" "$mode")" || { echo "P_$mode $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
    grep -q POSTONA_THREADS_CONNECT_FINGERPRINT_BEHAVIOR_DONE <<<"$out" || { echo "P_$mode marker"; return 0; }
    [[ "$tag" != real ]] || grep -E '^P2 ' <<<"$out" | sed "s/^/  observed (A $mode): /" | cut -c1-420 >&2
    db="$(copy "b${mode}_$tag" "$worldAC")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY2"; return 0; }
    out="$(as_owner "$db" -A -t -v a_mode="$mode" -f "$tree/ac_nof1_full.sql" 2>&1)" || { echo "B_$mode $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
    grep -q POSTONA_THREADS_LEASE_BINDING_BEHAVIOR_DONE <<<"$out" || { echo "B_$mode marker"; return 0; }
  done
  db="$(copy "r_$tag" "$worldAC")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY3"; return 0; }
  out="$(run_behavior "$db" ac4)" || { echo "R1-R7 $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q R7_FIX_PROTOTYPE_HOLDS <<<"$out" || { echo "R7 not refused"; return 0; }
  db="$(copy "n_$tag" "$worldAC")"; [[ "$(apply "$db" "$file")" == applied ]] || { echo "APPLY4"; return 0; }
  out="$(as_owner "$db" -A -t -f "$tree/li_behavior_full.sql" 2>&1)" || { echo "N1-N5 $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"; return 0; }
  grep -q POSTONA_THREADS_LEASE_INVALIDATION_BEHAVIOR_DONE <<<"$out" || { echo "N1-N5 marker"; return 0; }
  echo PASS
}

# ---- 4. (4): apply order, preconditions, re-apply -------------------------------------------------------------------
got="$(apply "$(copy f_no_c "$worldA")" "$cand4")"
[[ "$got" == THREADS_LEASE_FINGERPRINT_PRECONDITION_C ]] || fail "(4) without C: $got"
fdrift="$(copy f_drift "$worldAC")"
q "$fdrift" -c "do \$\$ begin execute replace(pg_get_functiondef('public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)'::regprocedure), 'AS \$function\$', 'AS \$function\$-- drifted'); end \$\$" > /dev/null
got="$(apply "$fdrift" "$cand4")"
[[ "$got" == THREADS_LEASE_FINGERPRINT_PRECONDITION_ROTATION ]] || fail "(4) on a drifted rotate: $got"
got="$("$psql_bin" -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$delegate" -d "$(copy f_owner "$worldAC")" -f "$cand4" 2>&1 | sed -n 's/^.*ERROR: *//p' | head -1 || true)"
[[ "$got" == THREADS_LEASE_FINGERPRINT_PRECONDITION_OWNER || "$got" == permission\ denied* ]] || fail "(4) by a non-owner: $got"
f_owner_refusal="$got"
fagain="$(copy f_again "$worldAC")"; need "$fagain" "$cand4"
got="$(apply "$fagain" "$cand4")"
[[ "$got" == THREADS_LEASE_FINGERPRINT_ALREADY_APPLIED ]] || fail "(4) re-apply: $got"
echo "PASS (4) apply: without C -> PRECONDITION_C; drifted rotate -> PRECONDITION_ROTATION; non-owner -> refused ($f_owner_refusal); re-apply -> ALREADY_APPLIED"

# ---- 5. A+C+(4): P1-P9 and F2 with A on and OFF; G4-29's B1-B8 (minus its F1); R1-R7b; N1-N5 ---------------------------
result="$(prove_4 "$cand4" real)"
[[ "$result" == PASS ]] || fail "A+C+(4): $result"
echo "PASS A+C+(4): P1 normal claim/rotate, single use; P2 F1 same now() -> CONNECTION_CHANGED, the bare complete's token stays, the stale lineage is never handed out (A on and OFF); P3 F1 separate transactions -> CONNECTION_CHANGED; P4 a refused complete consumes nothing; P5 an open state does not count; P6 entry reconnect refused; P7 second owner refused, nothing written; P8 consumed state removed -> CONNECTION_CHANGED; P8b same count other set -> CONNECTION_CHANGED; P9 no API access; B1-B8; R1-R7b; N1-N5"
echo "EXPECTED_FAIL F2 (A+C+(4) cannot see it): in-place Vault write under a held lease -> rotated"

# ---- 6. (4) alone: C's binding check removed, A off -> the entry reconnect and the same-now() collision still refused ----
python3 -I - "$cand4" "$tree/cand4_no_c_check.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
old = """  if v_binding_state is null or v_binding_state is distinct from v_lease.binding_oauth_state_id then
    return public.threads_credential_rotation_refused('BINDING_CHANGED');
  end if;
"""
assert s.count(old) == 1
s = s.replace(old, "")
i = s.index("-- Postcondition:"); j = s.rindex("commit;")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
alone="$(copy alone "$worldAC")"; need "$alone" "$tree/cand4_no_c_check.sql"; disable_a "$alone"; prep "$alone"
aacc="$(lease_account "$alone" 421)"
aclaim="$(q "$alone" -c "select l.lease_id from public.threads_credential_refresh_leases l where l.social_account_id = '$aacc'")"
[[ "$(q "$alone" -c "select cr.t_begin(cr.uid(421), 'al_b') = '$aacc' and cr.t_complete(cr.uid(421), 'al_b', '17841400000000421', now() + interval '40 days') = 'OK'")" == t ]] || fail "(4) alone: reconnect"
got="$(q "$alone" -c "select public.rotate_threads_credential_custody('$aacc', '$aclaim'::uuid, a.vault_access_token_secret_id, c.recorded_at, now() + interval '50 days') ->> 'code' from public.social_accounts a join public.threads_account_credential_custody c on c.social_account_id = a.id where a.id = '$aacc'")"
[[ "$got" == CONNECTION_CHANGED ]] || fail "(4) alone, entry reconnect: $got"
node_bin="${NODE:-node}"
coll="$(copy coll_alone "$worldAC")"; need "$coll" "$tree/cand4_no_c_check.sql"; disable_a "$coll"
{ prelude; helpers; cat <<'SQL'
select cr.enroll(181) as cu \gset
select cr.check(cr.t_begin(:'cu', 's1') like 'sa_%', 'collision begin s1');
select cr.check(cr.t_begin(:'cu', 's2') like 'sa_%', 'collision begin s2');
SQL
} > "$tree/coll_setup.sql"
as_owner "$coll" -A -t -f "$tree/coll_setup.sql" > /dev/null
"$node_bin" "$t/postona_threads_rotation_cas_collision.mjs" "$psql_bin" "$host" "$port" "$owner" "$coll" fix > "$tree/coll_alone.out" 2>&1 || fail "collision, (4) alone: $(cat "$tree/coll_alone.out")"
code="$(grep -o '"rotation":{[^}]*}' "$tree/coll_alone.out" | grep -o '"code":"[A-Z_]*"' | cut -d'"' -f4)"
[[ "$code" == CONNECTION_CHANGED ]] || fail "collision, (4) alone: $code"
echo "PASS (4) as the only layer (A off, C's check removed): entry reconnect -> CONNECTION_CHANGED; two transactions with the same now() -> CONNECTION_CHANGED, the reconnect's token stays"

# ---- 7. F1 races (A off): bare complete vs rotate / claim, three orders, no deadlock --------------------------------
races="$(copy f1races "$worldAC")"; need "$races" "$cand4"; disable_a "$races"
{ prelude; helpers
  for n in 431 432 433; do echo "select cr.connected($n, 'x$n') as a \\gset"; echo "select cr.check(cr.t_begin(cr.uid($n), 'x${n}b') like 'sa_%', 'begin $n');"; done
} > "$tree/f1races_setup.sql"
as_owner "$races" -A -t -f "$tree/f1races_setup.sql" > /dev/null
acct_of() { q "$races" -c "select id from public.social_accounts where platform_user_id = '178414000000$(printf %05d "$1")'"; }
x1="$(acct_of 431)"; x2="$(acct_of 432)"; x3="$(acct_of 433)"
rot_of() { q "$races" -c "select cr.rotate('$1', '$2'::jsonb, ('$2'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> '$3'"; }
# X1: the bare complete holds the workspace / account; the rotate (of an earlier claim) waits, then sees the consumed state.
claim1="$(q "$races" -c "select cr.claim('$x1')::text")"
( as_owner "$races" -A -t -c "begin" -c "select cr.legacy_complete(cr.uid(431), 'x431b', '17841400000000431', false)" -c "select pg_sleep(1.5)" -c "commit" > "$tree/x1.out" 2>&1 ) &
holder=$!; sleep 0.4
got1="$(rot_of "$x1" "$claim1" code 2>&1)"
wait "$holder" || fail "X1 holder: $(cat "$tree/x1.out")"
grep -qx OK "$tree/x1.out" && [[ "$got1" == CONNECTION_CHANGED ]] || fail "X1: $got1 $(cat "$tree/x1.out")"
[[ "$(q "$races" -c "select s.secret = cr.token('x431b') from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = '$x1'")" == t ]] || fail "X1 token"
# X2: the rotate (+ H5's Vault write) holds; the bare complete waits and writes LAST.
claim2="$(q "$races" -c "select cr.claim('$x2')::text")"
( as_owner "$races" -A -t -c "begin" -c "select cr.rotate('$x2', '$claim2'::jsonb, ('$claim2'::jsonb ->> 'custody_recorded_at')::timestamptz, now() + interval '55 days') ->> 'status'" \
    -c "select cr.h5_write('$x2', 'fakeTHREADSrefreshX2_0123456789')" -c "select pg_sleep(1.5)" -c "commit" > "$tree/x2.out" 2>&1 ) &
holder=$!; sleep 0.4
got2="$(q "$races" -c "select cr.legacy_complete(cr.uid(432), 'x432b', '17841400000000432', false)" 2>&1)"
wait "$holder" || fail "X2 holder: $(cat "$tree/x2.out")"
grep -qx rotated "$tree/x2.out" && [[ "$got2" == OK ]] || fail "X2: $got2 $(cat "$tree/x2.out")"
[[ "$(q "$races" -c "select s.secret = cr.token('x432b') from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id where a.id = '$x2'")" == t ]] || fail "X2 token"
x2rows="$(q "$races" -c "select cr.rows('$x2')")"
# X3: a claim holds; the bare complete waits; the claim's rotate is refused afterwards.
( as_owner "$races" -A -t -c "begin" -c "select cr.claim('$x3')::text" -c "select pg_sleep(1.5)" -c "commit" > "$tree/x3.out" 2>&1 ) &
holder=$!; sleep 0.4
got3="$(q "$races" -c "select cr.legacy_complete(cr.uid(433), 'x433b', '17841400000000433', false)" 2>&1)"
wait "$holder" || fail "X3 holder: $(cat "$tree/x3.out")"
claim3="$(grep '{' "$tree/x3.out")"
[[ "$got3" == OK && "$(jq -r .status <<<"$claim3")" == claimed && "$(rot_of "$x3" "$claim3" code)" == CONNECTION_CHANGED ]] || fail "X3: $got3 $claim3"
! grep -qi deadlock "$tree/x1.out" "$tree/x2.out" "$tree/x3.out" || fail "deadlock"
echo "PASS F1 races (A off): X1 bare complete first -> the waiting rotate answers CONNECTION_CHANGED, the bare complete's token stays; X2 rotate first -> the waiting bare complete writes last (its token stays; credential_row rows=$x2rows: verified_at is later than the rotate's record); X3 claim first -> the waiting bare complete makes that claim's rotate CONNECTION_CHANGED; no deadlock"

# ---- 8. Rollback: (4) -> C -> A; A first; C first (wrong order); a rollback that forgets rotate --------------------------
rb="$(copy rb "$worldAC")"; need "$rb" "$cand4"; need "$rb" "$cand4rb"
[[ "$(q "$rb" -c "select md5(prosrc) from pg_proc where oid in ('public.claim_threads_credential_refresh(text)'::regprocedure, 'public.rotate_threads_credential_custody(text,uuid,uuid,timestamptz,timestamptz)'::regprocedure) order by proname" | tr '\n' ' ')" == "3f0c22c67d004ac0d8b5f0324729c5d3 ba39c98ffa9f8585ec73136405fff212 " ]] || fail "(4) rollback: bodies not back to C's"
out="$(run_ac "$rb" on)" || fail "after (4)'s rollback: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q EXPECTED_FAIL_F1 <<<"$out" || fail "after (4)'s rollback F1 should pass again"
rb2="$(copy rb2 "$worldAC")"; for f in "$cand4" "$cand4rb" "$candCrb" "$candrb"; do need "$rb2" "$f"; done
out="$(run_behavior "$rb2" none)" || fail "after (4), C and A rollback: $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q R7_FINDING_REPRODUCED <<<"$out" || fail "after the full rollback R7 should reproduce again"
afirst="$(copy f_afirst "$worldAC")"; need "$afirst" "$cand4"; need "$afirst" "$candrb"
out="$(run_fp "$afirst" on)" || fail "A rolled back first, C+(4): $(grep -m1 -E 'FAIL|ERROR' <<<"$out")"
grep -q POSTONA_THREADS_CONNECT_FINGERPRINT_BEHAVIOR_DONE <<<"$out" || fail "A first: marker"
cfirst="$(copy f_cfirst "$worldAC")"; need "$cfirst" "$cand4"; prep "$cfirst"
cacc="$(q "$cfirst" -c "select cr.connected(441, 'cf')")"
need "$cfirst" "$candCrb"
got="$(q "$cfirst" -c "select cr.claim('$cacc')::text" 2>&1 || true)"
[[ "$got" == *connect_fingerprint* && "$(q "$cfirst" -c "select count(*) from public.threads_credential_refresh_leases")" == 0 ]] || fail "C rolled back first: claim $got"
got="$(apply "$cfirst" "$cand4rb")"
[[ "$got" == THREADS_LEASE_FINGERPRINT_ROLLBACK_ORDER ]] || fail "(4) rollback after C's: $got"
q "$cfirst" -c "alter table public.threads_credential_refresh_leases drop column connect_fingerprint" > /dev/null   # the documented manual recovery
[[ "$(q "$cfirst" -c "select cr.claim('$cacc') ->> 'status'")" == claimed ]] || fail "C first: claim after the manual recovery"
python3 -I - "$cand4rb" "$tree/rb4_mut.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
i = s.index("create or replace function public.rotate_threads_credential_custody(")
j = s.index("alter table public.threads_credential_refresh_leases drop column connect_fingerprint;")
open(sys.argv[2], "w", encoding="utf-8").write(s[:i] + s[j:])
PY
rbm="$(copy rb4mut "$worldAC")"; need "$rbm" "$cand4"; got="$(apply "$rbm" "$tree/rb4_mut.sql")"
[[ "$got" == THREADS_LEASE_FINGERPRINT_ROLLBACK_INCOMPLETE ]] || fail "rollback that forgets rotate: $got"
echo "PASS rollback: (4) -> bodies back to C's and F1 passes again, then C and A -> R7 reproduces again; A first -> C+(4) still hold (P1-P9); C first (wrong) -> claim errors on the NOT NULL fingerprint (fail closed, no lease), (4)'s rollback then refuses (ROLLBACK_ORDER), manual recovery = drop the column; a rollback that forgets rotate -> ROLLBACK_INCOMPLETE"

# ---- 9. Negative controls: mutants of (4) (postcondition stripped, so behavior must catch) ------------------------------
caught=0; total=0
mutate_4() {
  local name="$1" old="$2" new="$3" mode="${4:-one}" full stripped got_full got
  total=$((total + 1)); full="$tree/mut4_$name.sql"; stripped="$tree/mut4_${name}_nopost.sql"
  python3 -I -c '
import sys
src, dst, old, new, mode = sys.argv[1:6]
s = open(src, encoding="utf-8").read()
n = s.count(old)
if (mode == "one" and n != 1) or n == 0: sys.exit(1)
open(dst, "w", encoding="utf-8").write(s.replace(old, new))
' "$cand4" "$full" "$old" "$new" "$mode" || fail "mutation $name: pattern count"
  strip_post "$full" "$stripped"
  got_full="$(apply "$(copy "m4f_$name" "$worldAC")" "$full")"
  got="$(prove_4 "$stripped" "m_$name")"
  if [[ "$got" != PASS ]]; then caught=$((caught + 1)); echo "  CAUGHT $name: apply=${got_full:0:50}; behavior: ${got:0:150}"
  else echo "  MISSED $name (apply=${got_full:0:50})"; fi
}
mutate_4 rotate_no_fingerprint_check "  if v_fingerprint is distinct from v_lease.connect_fingerprint then
    return public.threads_credential_rotation_refused('CONNECTION_CHANGED');
  end if;
" ""
mutate_4 counts_unconsumed_states "where s.social_account_id = p_social_account_id and s.consumed_at is not null" "where s.social_account_id = p_social_account_id" all
mutate_4 count_not_set "coalesce(pg_catalog.string_agg(s.id::text, ',' order by s.id), '')" "pg_catalog.count(*)::text" all
mutate_4 claim_records_another "v_binding_state, v_fingerprint)" "v_binding_state, pg_catalog.md5('a') || pg_catalog.md5('b'))"
mutate_4 other_accounts_states "where s.social_account_id = p_social_account_id and s.consumed_at is not null" "where s.social_account_id <> p_social_account_id and s.consumed_at is not null" all
echo "negative controls caught $caught/$total"
[[ "$caught" == "$total" ]] || fail "a negative control was not caught"
echo "POSTONA_THREADS_CONNECT_FINGERPRINT_RUN_PASS (isolated source candidates A+C+(4); F1 refused; EXPECTED_FAIL F2 in-place Vault write reported)"
