#!/usr/bin/env bash
# Mutation proof for the AI provider budget ledger: each mutant removes one safety mechanism from a COPY of the
# migration; the proof runner must then fail. A mutant that survives means the tests do not cover that mechanism.
#
#   AIL_PGHOST=/private/tmp/<socket dir> AIL_PGPORT=54891 AIL_PGSUPER=<superuser> bash supabase/tests/ai_provider_budget_ledger_mutations.sh
#
# Runs serially (role memberships are cluster-wide). Never touches Supabase.
set -euo pipefail
export LC_ALL=C
: "${AIL_PGHOST:?AIL_PGHOST is required}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/../migrations/20261010050613_ai_provider_budget_ledger.sql"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ail_mut.XXXXXX")"
cleanup() { find "$WORK" -type f -delete 2>/dev/null || true; rmdir "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

killed=0
# mutant <name> <parts that must fail> <perl substitution>
mutant() {
  local name="$1" parts="$2" perl_expr="$3" file="$WORK/$1.sql"
  perl -0pe "$perl_expr" "$SOURCE" >"$file"
  if cmp -s "$SOURCE" "$file"; then echo "FAIL: mutant $name did not change the migration" >&2; exit 1; fi
  if AIL_MIGRATION="$file" AIL_PARTS="$parts" bash "$HERE/ai_provider_budget_ledger_run.sh" >"$WORK/$name.log" 2>&1; then
    echo "FAIL: mutant $name SURVIVED (parts: $parts)" >&2
    tail -5 "$WORK/$name.log" >&2
    exit 1
  fi
  killed=$((killed + 1))
  echo "killed: $name ($(grep -m1 -E 'FAIL|ERROR|AIL_TEST_FAIL' "$WORK/$name.log" | cut -c1-140))"
}

# Concurrency: without the advisory lock AND the bucket row locks (and with a wider window), parallel sessions overbook.
mutant no_locks concurrency 's/  perform pg_advisory_xact_lock\(hashtextextended\(.ai_ledger:reserve., 0\)\);\n//; s/     order by b\.id\n     for update of b\n  loop/     order by b.id\n  loop\n    perform pg_sleep(0.02);/'
# Idempotent reserve: without the same-attempt lookup a repeat is a new booking (or a unique violation).
mutant no_reserve_idempotency behaviour 's/  select r\.\* into v_existing\n.*?\n  end if;\n\n  v_month/  v_month/s'
# Idempotent settlement: without the existing-event check a repeat fails or double-charges.
mutant no_settle_idempotency behaviour 's/  select e\.\* into v_event from ai_ledger\.usage_events e where e\.reservation_id = v_id;\n  if found then\n.*?\n  end if;\n/\n/s'
# Unknown outcomes must never be cheaper than the hold.
mutant no_upper_bound_floor behaviour 's/    v_cost := greatest\(v_cost, v_res\.reserved_usd\);\n//'
# An expired, never-sent hold must not become sendable.
mutant mark_sent_ignores_expiry behaviour 's/    if v_res\.expires_at <= now\(\) then\n.*?\n    end if;\n//s'
# Recovery must never release a sent attempt.
mutant recovery_releases_sent behaviour 's/perform ai_ledger\.finalize_locked\(v_res, .unknown., .upper_bound., v_res\.reserved_usd,[^;]*;/perform ai_ledger.release_locked(v_res);/s'
# Off-by-one in the call cap.
mutant call_cap_off_by_one "behaviour concurrency" 's/v_row\.calls \+ 1 > v_row\.max_calls/v_row.calls > v_row.max_calls/'
# Subject validation: a user call without a user id.
mutant no_subject_check behaviour 's/\n     or \(v_subject = .user. and v_user is null\)//'
# ACL: without the RPC revoke, default / PUBLIC EXECUTE survives and the migration must refuse.
mutant no_rpc_revoke "behaviour supabase" 's/revoke all on function\n  public\.ai_ledger_reserve\(jsonb\).*?from public, anon, authenticated, service_role;\n//s'
# ACL: a direct grant to an application role must make the migration refuse.
mutant extra_grant behaviour 's/\n-- -{20,}\n-- Access verification\./\ngrant select on ai_ledger.usage_events to service_role;\n-- ------------------------------------------\n-- Access verification./'
# RLS must be on for every ledger table.
mutant no_rls behaviour 's/alter table ai_ledger\.usage_events enable row level security;\n//'
# Append-only: without the trigger the owner can rewrite history.
mutant no_append_only behaviour 's/create trigger usage_events_append_only before update or delete on ai_ledger\.usage_events\n  for each row execute function ai_ledger\.reject_change\(\);\n//'

# R1: mark_sent must give the send permit only on the reserved -> sent transition, never again for a sent row.
mutant mark_sent_reissues_permit "behaviour concurrency" "s/return jsonb_build_object\('status', v_res\.status, 'may_send', false\);/return jsonb_build_object('status', v_res.status, 'may_send', v_res.status = 'sent');/"
# R1: reserve must not hand a sent attempt back as allowed.
mutant reserve_reuses_sent_attempt behaviour "s/    if v_existing\.status = 'reserved' then\n      return jsonb_build_object\('allowed', true/    if v_existing.status in ('reserved', 'sent') then\n      return jsonb_build_object('allowed', true/"
# R2: without the reachable-role (SET ROLE) check, NOINHERIT SET-enabled paths are accepted.
mutant no_role_path_check adverse 's/  -- 5b\. Roles an application role can REACH.*?\n  -- 6\. Row level security/  -- 6. Row level security/s'
# R2: following inheritance only (not SET ROLE) misses NOINHERIT paths.
mutant role_path_inherit_only adverse 's/ or pg_has_role\(v_role, r\.oid, v_set_check\)\)/)/'

echo "ALL $killed MUTANTS KILLED"
