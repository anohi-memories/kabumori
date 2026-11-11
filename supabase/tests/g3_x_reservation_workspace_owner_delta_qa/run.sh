#!/usr/bin/env bash
# G3 TASK 28/50 (Issue #318): the X reservation candidates against the personal-workspace / owner contracts of G4-35 (PR #484) and G5-26
# (PR #485), for the cases G3-25 (43 gaps) and G3-26 (8 gaps) did not cover: a shared workspace, a person owning another brand, a legacy
# workspace id, an owner A -> B -> A churn, a workspace kind change. THROW-AWAY LOCAL PostgreSQL 17, fake people / sessions / claims; the
# X candidates 001-006 READ at PR #392's head with `git show` (unchanged); the baseline is built as in PR #466 / #471. No product file, no
# managed or production database, no real token, no post.
#
#   CURRENT         every cell equals the pinned answer (a change in today's behaviour is a failure to look at)
#   BASELINE        the ordinary person (own u_<md5>, sole owner) can create, is claimed and can begin a single post -- asserted
#   PENDING_POLICY  shared / multi-owner, owning another brand, legacy workspace ids: undecided by the user (#299). Recorded, never
#                   compared with an expected value
#   PROPOSED        differences from a proposal only (owner-epoch binding as Threads 007 does; a workspace-state check as the single-post
#                   fence does): listed by name, not a PASS / FAIL of the contract
#
#   WD_PGHOST=/private/tmp/<socket> WD_PGPORT=<port> WD_PGSUPER=<local superuser> WD_G5_SOURCE_DIR=<git archive of G5 #371> bash run.sh
# Optional: WD_X_REV (default PR #392's head). Roles are cluster-wide: run alone.
set -euo pipefail
export LC_ALL=C PGTZ=UTC PGOPTIONS='-c client_min_messages=warning'
host="${WD_PGHOST:?WD_PGHOST required}"; port="${WD_PGPORT:?WD_PGPORT required}"; super="${WD_PGSUPER:?WD_PGSUPER required}"
case "$host" in /private/tmp/*|/tmp/*) ;; *) echo "Refusing: WD_PGHOST must be a local /tmp socket directory." >&2; exit 2 ;; esac
g5="${WD_G5_SOURCE_DIR:-}"
[[ -n "$g5" && -f "$g5/supabase/migrations/20261012230000_common_account_service_brand_state.sql" ]] || { echo "RUN_NOT_AVAILABLE: WD_G5_SOURCE_DIR" >&2; exit 3; }
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(git -C "$here" rev-parse --show-toplevel)"
rev="${WD_X_REV:-f34aab9714f5d4f11388609262d5f64cdcce5ed9}"
m="$g5/supabase/migrations"; tests="$g5/supabase/tests"
owner="kb_g3wd_owner"; apilogin="kb_g3wd_api"; db="kabumori_g3wd_$$"
S=(psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$super")
tmp="$(mktemp -d /private/tmp/g3wd.XXXXXX)"
drop_roles() { "${S[@]}" -d postgres -c "drop role if exists $apilogin" -c "drop role if exists postona_resv_api" -c "drop role if exists postona_resv_worker" >/dev/null 2>&1 || true; }
cleanup() { rm -rf "$tmp"; "${S[@]}" -d postgres -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true; drop_roles; }
trap cleanup EXIT
fail() { echo "FAIL $*" >&2; exit 1; }

# the X candidates and helpers exactly as PR #392's head has them (read-only)
c="supabase/candidates"
for f in postona_x_reservations/001_postona_x_reservations.sql postona_x_reservations/002_postona_x_resv_api_role.sql \
         postona_x_reservations/003_postona_x_resv_g5_binding.sql postona_x_reservations/004_postona_x_resv_dispatch.sql \
         postona_x_reservations/005_postona_x_single_post.sql postona_x_reservations/006_postona_x_single_post_live_fence.sql \
         postona_x_publish_entitlement/test_stand_ins.sql postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql \
         postona_x_oauth_t13_guard/g4_predicate_test_double.sql postona_x_oauth_t13_guard/helpers.sql; do
  mkdir -p "$tmp/x/$(dirname "$f")"; git -C "$repo" show "$rev:$c/$f" >"$tmp/x/$f" || fail "git show $rev:$c/$f"
done
x="$tmp/x"

drop_roles
"${S[@]}" -d postgres >/dev/null <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = '$owner') then create role $owner login nosuperuser nocreatedb createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_svc_child') then create role kb_cal_svc_child nologin inherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'kb_cal_auth_child') then create role kb_cal_auth_child nologin inherit; end if;
end \$\$;
grant service_role to kb_cal_svc_child;
grant authenticated to kb_cal_auth_child;
grant anon, authenticated, service_role, kb_cal_svc_child, kb_cal_auth_child to $owner;
create database $db owner $owner;
SQL
own() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$db" "$@"; }
# the same production-shaped baseline as PR #392's single_post_live_fence_run.sh (G5 chain, F5 brand state, guarded onboarding + G4
# test double), then the X candidates 001-006
own -f "$tests/social_mobile_account_deletion_fixture.sql" >/dev/null
own -f "$m/20260919120000_social_mobile_x_oauth_onboarding.sql" >/dev/null 2>&1
for f in 20260922003101_social_mobile_x_oauth_reconnect_preserve_verified 20260928160000_social_mobile_account_deletion_candidate; do own -f "$m/$f.sql" >/dev/null; done
own -f "$tests/common_account_lifecycle_fixture.sql" >/dev/null
for f in 20261001150000_common_account_lifecycle_foundation 20261006230000_common_account_service_start_intent 20261009120000_common_account_deletion_completion; do own -f "$m/$f.sql" >/dev/null; done
own -f "$tests/common_account_write_guard_fixture.sql" >/dev/null
"${S[@]}" -d "$db" -c "alter function public.fixture_foreign_owner_service_write(text) owner to kb_cal_svc_child" >/dev/null
for f in 20261010051938_common_account_service_write_guard 20261012130000_common_account_core_service_fence 20261012230000_common_account_service_brand_state; do own -f "$m/$f.sql" >/dev/null; done
own -f "$x/postona_x_publish_entitlement/test_stand_ins.sql" >/dev/null
own -f "$repo/supabase/migrations/20261006160200_x_account_publish_authority.sql" >/dev/null
own -f "$x/postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql" >/dev/null
own -f "$x/postona_x_reservations/001_postona_x_reservations.sql" >/dev/null
own -f "$x/postona_x_reservations/002_postona_x_resv_api_role.sql" >/dev/null
own -f "$x/postona_x_reservations/003_postona_x_resv_g5_binding.sql" >/dev/null
own -f "$x/postona_x_oauth_t13_guard/g4_predicate_test_double.sql" >/dev/null
own -f "$x/postona_x_reservations/004_postona_x_resv_dispatch.sql" >/dev/null
"${S[@]}" -d postgres -c "create role $apilogin login noinherit" -c "grant postona_resv_api to $apilogin" \
  -c "grant postona_resv_api to $owner with inherit false, set true" -c "grant postona_resv_worker to $owner with inherit false, set true" >/dev/null
own -f "$x/postona_x_reservations/005_postona_x_single_post.sql" >/dev/null
own -f "$x/postona_x_reservations/006_postona_x_single_post_live_fence.sql" >/dev/null
echo "BASELINE_X_001_006_READY"

cat "$x/postona_x_oauth_t13_guard/helpers.sql" "$here/delta_matrix.sql" >"$tmp/matrix.sql"
own -f "$tmp/matrix.sql" >"$tmp/matrix.out" 2>&1 || { cat "$tmp/matrix.out"; fail "matrix"; }
grep -q X_WORKSPACE_OWNER_DELTA_MATRIX_DONE "$tmp/matrix.out" || { cat "$tmp/matrix.out"; fail "matrix not done"; }
sed -n 's/^ *RESULT|//p' "$tmp/matrix.out" | sort >"$tmp/actual"
sed 's/^/ACTUAL /' "$tmp/actual"

sort >"$tmp/current" <<'CUR'
W0_ordinary|create_batch|ok
W0_ordinary|post_now_begin|ok:claimed
W0_ordinary|worker_claim|claimed
W0_ordinary|workspace_id|u_md5
W1_shared_workspace|create_batch_after_share|ok
W1_shared_workspace|post_now_begin|ERR:POSTONA_RESV_SERVICE_NOT_ACTIVE
W1_shared_workspace|worker_claim|claimed
W2_owns_another_brand|create_batch|ok
W2_owns_another_brand|post_now_begin|ok:claimed
W2_owns_another_brand|worker_claim|claimed
W3_legacy_workspace|create_batch|ok
W3_legacy_workspace|post_now_begin|ok:claimed
W3_legacy_workspace|workspace_id|other:wd_legacy_304
W4_owner_churn_ABA|row_after|claimed/-
W4_owner_churn_ABA|worker_claim_after_A_again|claimed
W4_owner_churn_ABA|worker_claim_while_B_owns|not_claimed
W5_kind_changed|create_batch_after|ERR:POSTONA_RESV_BRAND_NOT_ELIGIBLE
W5_kind_changed|post_now_begin|ERR:POSTONA_RESV_BRAND_NOT_ELIGIBLE
W5_kind_changed|worker_claim|not_claimed
CUR
if ! diff "$tmp/current" "$tmp/actual" >"$tmp/cur.diff"; then cat "$tmp/cur.diff"; fail "today's behaviour differs from the pinned current answers"; fi
echo "CURRENT_PINNED_PASS ($(wc -l <"$tmp/actual" | tr -d ' ') cells)"

cell() { awk -F'|' -v s="$1" -v k="$2" '$1 == s && $2 == k { print $3 }' "$tmp/actual"; }
[[ "$(cell W0_ordinary workspace_id)" == u_md5 && "$(cell W0_ordinary create_batch)" == ok && "$(cell W0_ordinary worker_claim)" == claimed \
   && "$(cell W0_ordinary post_now_begin)" == ok:claimed ]] || fail "BASELINE the ordinary person's paths"
echo "BASELINE_PASS (own u_<md5>, sole owner: create / claim / single post)"

echo "PENDING_POLICY (recorded, not judged):"
grep -E '^(W1_shared_workspace|W2_owns_another_brand|W3_legacy_workspace)\|' "$tmp/actual" | sed 's/^/  PENDING /'
sort >"$tmp/proposed" <<'PROP'
W4_owner_churn_ABA|worker_claim_after_A_again
PROP
awk -F'|' '($1 == "W4_owner_churn_ABA" && $2 == "worker_claim_after_A_again" && $3 == "claimed") || ($1 == "W5_kind_changed" && $2 == "worker_claim" && $3 == "claimed") { print $1 "|" $2 }' "$tmp/actual" | sort >"$tmp/proposed_now"
if ! diff "$tmp/proposed" "$tmp/proposed_now" >"$tmp/prop.diff"; then cat "$tmp/prop.diff"; fail "the PROPOSED differences changed"; fi
echo "PROPOSED_DIFFERENCES $(wc -l <"$tmp/proposed_now" | tr -d ' ') (by name; a decision + a G3 TASK would remove them)"
sed 's/^/  PROPOSED /' "$tmp/proposed_now"
echo "G3_X_WORKSPACE_OWNER_DELTA_QA_PASS"
